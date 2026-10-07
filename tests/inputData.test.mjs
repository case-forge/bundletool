/**
 * The per-file data map is keyed by file name, and a name can come from a manifest or from the
 * metadata of a reopened bundle, so it must treat __proto__ and constructor as ordinary keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from '../public/js/frontend/state.js';

const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '__proto__.pdf', 'constructor.pdf'];

test('the map has no prototype, so no name reads as a method or the prototype', () => {
  assert.equal(Object.getPrototypeOf(state.frontendInputData), null);
  for (const n of NAMES) assert.equal(state.frontendInputData[n], undefined, `${n} must not exist before it is added`);
});

test('files called __proto__ or constructor are ordinary entries through add, edit, save and restore', () => {
  const map = state.frontendInputData;
  for (const n of Object.keys(map)) delete map[n];
  for (const n of NAMES) map[n] = { title: `Title of ${n}`, date: '2024-01-15', pageCount: 3 };
  assert.deepEqual(Object.keys(map).sort(), [...NAMES].sort());
  // edit (what the title and date inputs do)
  for (const n of NAMES) { if (map[n]) map[n].title = `Edited ${n}`; }
  assert.equal(map['__proto__'].title, 'Edited __proto__');
  assert.equal(map['constructor'].title, 'Edited constructor');
  assert.equal(Object.getPrototypeOf(map), null, 'adding __proto__ must not have replaced the prototype');

  // save (autosave copies the map, IndexedDB structured-clones it) and restore (Object.assign back)
  const saved = structuredClone({ ...map });
  for (const n of Object.keys(map)) delete map[n];
  Object.assign(map, saved);
  assert.deepEqual(Object.keys(map).sort(), [...NAMES].sort());
  assert.equal(map['__proto__'].title, 'Edited __proto__');
  assert.equal(Object.getPrototypeOf(map), null);
  assert.equal(Object.values(map).reduce((s, d) => s + d.pageCount, 0), 3 * NAMES.length);

  // delete (what removing a row does)
  delete map['__proto__']; delete map['constructor'];
  assert.equal(map['__proto__'], undefined);
  assert.equal(map['constructor'], undefined);
  for (const n of Object.keys(map)) delete map[n];
});

test('the state module creates the per-file map without a prototype, and nothing replaces it with a plain object', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'public', 'js', 'frontend', 'state.js'), 'utf8');
  assert.match(src, /frontendInputData:\s*Object\.create\(null\)/);
  const others = ['autosave.js', 'manifestIO.js', 'bundleGeneration.js', 'fileProcessing.js', 'fileRows.js', 'sections.js']
    .map((f) => fs.readFileSync(path.join(here, '..', 'public', 'js', 'frontend', f), 'utf8'))
    .join('\n');
  assert.doesNotMatch(others, /frontendInputData\s*=\s*\{/, 'nothing may reassign the map to a plain object');
});
