/**
 * The whole-add limits apply to every way of adding files: the file picker, a drop, and a manifest
 * dropped with its PDFs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wholeAddProblem, MAX_FILES_PER_ADD, MAX_DOCUMENTS, MAX_TOTAL_MB } from '../public/js/frontend/limits.js';

const MB = 1024 * 1024;

test('a normal add passes', () => {
  assert.equal(wholeAddProblem({ incomingCount: 20, incomingBytes: 30 * MB, existingCount: 5, existingBytes: 10 * MB }), null);
});

test('more files than one add allows is refused, and says how many', () => {
  const problem = wholeAddProblem({ incomingCount: MAX_FILES_PER_ADD + 20, incomingBytes: MB });
  assert.equal(problem.kind, 'warning');
  assert.equal(problem.title, 'Too many files at once');
  assert.match(problem.message, /320 files/);
  assert.match(problem.message, /300 at a time/);
});

test('exactly the limit is allowed', () => {
  assert.equal(wholeAddProblem({ incomingCount: MAX_FILES_PER_ADD, incomingBytes: MB }), null);
});

test('going past the documents a bundle holds is refused', () => {
  const problem = wholeAddProblem({ incomingCount: 200, incomingBytes: MB, existingCount: MAX_DOCUMENTS - 100, existingBytes: MB });
  assert.equal(problem.title, 'Too many documents');
});

test('going past the total size is refused as an error', () => {
  const problem = wholeAddProblem({ incomingCount: 3, incomingBytes: 100 * MB, existingCount: 4, existingBytes: MAX_TOTAL_MB * MB });
  assert.equal(problem.kind, 'error');
  assert.equal(problem.title, 'Total file size too large');
});

test('a manifest dropped with 320 PDFs is refused before anything is read or changed', async () => {
  // manifestIO pulls in modules that look the page up at load; a page with none of the elements is enough here.
  globalThis.document ??= { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const { importManifest, ManifestLimitError } = await import('../public/js/frontend/manifestIO.js');
  const names = Array.from({ length: 320 }, (_, i) => `doc-${i}.pdf`);
  const manifest = { sections: [{ sectionLabel: 'A', sectionName: 'All', files: names.map((filename) => ({ filename })) }] };
  const files = names.map((name) => new File([new Uint8Array(4)], name, { type: 'application/pdf' }));
  await assert.rejects(() => importManifest(manifest, files), (error) => {
    assert.ok(error instanceof ManifestLimitError);
    assert.equal(error.title, 'Too many files at once');
    assert.match(error.message, /320 files/);
    return true;
  });
});
