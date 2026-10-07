/** A manifest is a file from anywhere: wrong types, hostile keys, and shapes built to crash the import. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestManifestConfig, validateManifestShape } from '../public/js/manifestSchema.js';

const ok = { sections: [{ sectionLabel: 'A', sectionName: 'Pleadings', files: [{ filename: 'a.pdf', title: 'T', date: '2026-01-02' }] }] };
const without = (fn) => { const m = structuredClone(ok); fn(m); return m; };

test('a well-formed manifest passes', () => {
  validateManifestShape(ok);
  validateManifestShape({ ...ok, config: { 'heading.claimNumber': 'X', 'index.showTableBorders': true, 'pageNumbering.footerOffset': 5 } });
});

test('wrong-typed fields are refused with a message, before anything else happens', () => {
  const cases = {
    'numeric section label': without((m) => { m.sections[0].sectionLabel = 5; }),
    'object section name': without((m) => { m.sections[0].sectionName = { a: 1 }; }),
    'section that is a string': { sections: ['A'] },
    'null section': { sections: [null] },
    'files that is an object': without((m) => { m.sections[0].files = {}; }),
    'file entry that is a string': without((m) => { m.sections[0].files = ['a.pdf']; }),
    'null file entry': without((m) => { m.sections[0].files = [null]; }),
    'numeric title': without((m) => { m.sections[0].files[0].title = 7; }),
    'array date': without((m) => { m.sections[0].files[0].date = ['2026']; }),
    'long date': without((m) => { m.sections[0].files[0].date = 'x'.repeat(41); }),
    'long title': without((m) => { m.sections[0].files[0].title = 'x'.repeat(501); }),
    'config that is an array': { ...ok, config: [] },
    'config value that is an object': { ...ok, config: { 'heading.claimNumber': { a: 1 } } },
    'config value that is too long': { ...ok, config: { 'heading.claimNumber': 'x'.repeat(501) } },
    'too many config keys': { ...ok, config: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`heading.k${i}`, 1])) },
  };
  for (const [name, manifest] of Object.entries(cases)) {
    assert.throws(() => validateManifestShape(manifest), Error, name);
  }
});

test('null or missing optional fields are fine', () => {
  validateManifestShape(without((m) => { m.sections[0].sectionLabel = null; delete m.sections[0].sectionName; m.sections[0].files[0].title = null; delete m.sections[0].files[0].date; }));
});

test('config keys cannot write to built-in prototypes', () => {
  const before = Object.prototype.hasOwnProperty.call;
  const flat = JSON.parse('{"toString.call":"x","hasOwnProperty.call":1,"__proto__.polluted":true,"constructor.prototype.polluted":true,"index.__proto__":"x","index.constructor":"x","index.dateStyle":"YYYY-MM-DD"}');
  const nested = nestManifestConfig(flat);
  assert.equal(Object.prototype.hasOwnProperty.call, before);
  assert.equal(typeof Object.prototype.hasOwnProperty.call, 'function');
  assert.equal({}.polluted, undefined);
  assert.equal(typeof Function.prototype.call, 'function');
  assert.deepEqual(Object.keys(nested), ['index']);
  assert.deepEqual(nested.index, { dateStyle: 'YYYY-MM-DD' });
});

test('only the real config groups and plain field names are kept', () => {
  const nested = nestManifestConfig({ 'unknown.field': 1, 'heading.claimNumber': 'A', 'heading.': 'x', 'heading.a.b': 'x', 'heading.9lives': 'x', '_comment': 'x' });
  assert.deepEqual(nested, { heading: { claimNumber: 'A' } });
});

test('a non-object config gives an empty nesting', () => {
  for (const v of [null, undefined, 3, 'x', []]) assert.deepEqual(nestManifestConfig(v), {});
});
