/**
 * public/js/manifestSchema.js: the manifest format shared by
 * scripts/build-cli.mjs and public/js/frontend/manifestIO.js. Pure, no DOM
 * and no filesystem, so this is the one place either side's manifest
 * validation is exercised directly rather than through its consumer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  flattenManifestConfig, nestManifestConfig, validateManifestShape,
} from '../public/js/manifestSchema.js';

test('flatten -> nest round-trips a nested config unchanged', async (t) => {
  const nested = {
    heading: { claimNumber: 'ABC123456', bundleTitle: 'Trial Bundle' },
    cover: { courtName: 'IN THE FAMILY COURT AT [TOWN]' },
  };
  const flat = flattenManifestConfig(nested);
  assert.deepEqual(flat, {
    'heading.claimNumber': 'ABC123456',
    'heading.bundleTitle': 'Trial Bundle',
    'cover.courtName': 'IN THE FAMILY COURT AT [TOWN]',
  });
  assert.deepEqual(nestManifestConfig(flat), nested);
});

test('nestManifestConfig ignores a leading-underscore key like _comment', async (t) => {
  const nested = nestManifestConfig({ _comment: 'not config', 'heading.author': 'A. Solicitor' });
  assert.deepEqual(nested, { heading: { author: 'A. Solicitor' } });
});

test('nestManifestConfig ignores a malformed key with no dot', async (t) => {
  const nested = nestManifestConfig({ noDotHere: 'value', 'heading.author': 'A. Solicitor' });
  assert.deepEqual(nested, { heading: { author: 'A. Solicitor' } });
});

test('validateManifestShape accepts the shipped family-law example manifest', async (t) => {
  const manifest = JSON.parse(await readFile(new URL('../examples/family-c100-fl401-manifest.json', import.meta.url)));
  assert.doesNotThrow(() => validateManifestShape(manifest));
});

test('validateManifestShape rejects a non-object', async (t) => {
  assert.throws(() => validateManifestShape('not an object'), /not a BundleTool manifest/);
  assert.throws(() => validateManifestShape(null), /not a BundleTool manifest/);
  assert.throws(() => validateManifestShape([1, 2, 3]), /not a BundleTool manifest/);
});

test('validateManifestShape rejects missing or empty sections', async (t) => {
  assert.throws(() => validateManifestShape({}), /no sections/);
  assert.throws(() => validateManifestShape({ sections: [] }), /no sections/);
  assert.throws(() => validateManifestShape({ sections: 'not an array' }), /no sections/);
});

test('validateManifestShape holds sections to the bundle limit: 100 is accepted, 101 refused', async (t) => {
  const sections = (n) => Array.from({ length: n }, (_, i) => ({ sectionID: String(i).padStart(4, '0'), files: [] }));
  assert.doesNotThrow(() => validateManifestShape({ sections: sections(100) }));
  assert.throws(() => validateManifestShape({ sections: sections(101) }), /names 101 sections; a bundle holds up to 100/);
});

test('validateManifestShape rejects more files than the cap', async (t) => {
  const files = Array.from({ length: 2001 }, (_, i) => ({ filename: `f${i}.pdf` }));
  assert.throws(() => validateManifestShape({ sections: [{ sectionID: '0001', files }] }), /more than 2000 files/);
});

test('validateManifestShape rejects a file entry with no filename', async (t) => {
  assert.throws(
    () => validateManifestShape({ sections: [{ sectionID: '0001', files: [{ title: 'No filename' }] }] }),
    /no filename/,
  );
});

test('validateManifestShape rejects an implausibly long filename, title, or section name', async (t) => {
  const long = 'x'.repeat(501);
  assert.throws(
    () => validateManifestShape({ sections: [{ sectionID: '0001', sectionName: long, files: [] }] }),
    /section name.*implausibly long/,
  );
  assert.throws(
    () => validateManifestShape({ sections: [{ sectionID: '0001', files: [{ filename: long }] }] }),
    /implausibly long/,
  );
  assert.throws(
    () => validateManifestShape({ sections: [{ sectionID: '0001', files: [{ filename: 'a.pdf', title: long }] }] }),
    /implausibly long/,
  );
});

test('validateManifestShape accepts a minimal well-formed manifest', async (t) => {
  assert.doesNotThrow(() => validateManifestShape({
    sections: [{ sectionID: '0001', sectionLabel: '', sectionName: '', files: [
      { filename: 'a.pdf', title: 'A', date: '2026-01-01' },
    ] }],
  }));
});
