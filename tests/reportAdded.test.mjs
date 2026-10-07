import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportAdded } from '../public/js/frontend/fileProcessing.js';

const skip = (name, reason, calls) => ({ name, reason, replay: () => calls.push(name) });

test('nothing rejected leaves the size and duplicate notes as they were', () => {
  const shown = [];
  assert.equal(reportAdded([], 10, 1, '', (m) => shown.push(m)), false);
  assert.equal(shown.length, 0);
  assert.equal(reportAdded([], 10, 1, 'x was already in the bundle.', (m) => shown.push(m)), true);
  assert.equal(shown[0].title, 'Already added');
});

test('one rejected file replays its own explanation', () => {
  const replayed = [], shown = [];
  reportAdded([skip('a.png', 'damaged or cut short', replayed)], 10, 1, '', (m) => shown.push(m));
  assert.deepEqual(replayed, ['a.png']);
  assert.equal(shown.length, 0);
});

test('several rejected files are listed in one message', () => {
  const shown = [];
  reportAdded([skip('a.png', 'damaged or cut short', []), skip('b.tif', 'too large', []), skip('c.docx', 'could not be read as a Word document', [])], 10, 1, '', (m) => shown.push(m));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '3 files were not added');
  assert.deepEqual(shown[0].items, ['"a.png": damaged or cut short', '"b.tif": too large', '"c.docx": could not be read as a Word document']);
});

test('a very large bundle keeps its own warning and names the rejected files in it', () => {
  const shown = [];
  reportAdded([skip('a.png', 'too large', []), skip('b.png', 'damaged or cut short', [])], 5000, 10, '', (m) => shown.push(m));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Very large bundle');
  assert.match(shown[0].message, /2 files were not added: "a\.png": too large; "b\.png": damaged or cut short/);
});

import { isAlreadyAdded } from '../public/js/frontend/fileProcessing.js';
import { state } from '../public/js/frontend/state.js';

test('a photo or turned PDF that is already in is recognised by the file as it was picked', () => {
  for (const k of [...state.filesMap.keys()]) state.filesMap.delete(k);
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
  // the photo IMG_1.jpg (5000 bytes) is stored as IMG_1.pdf (3000 bytes)
  state.filesMap.set('IMG_1.pdf', { name: 'IMG_1.pdf', size: 3000 });
  state.frontendInputData['IMG_1.pdf'] = { title: 'IMG 1', pageCount: 1, source: 'IMG_1.jpg|5000' };
  assert.equal(isAlreadyAdded({ name: 'IMG_1.jpg', size: 5000 }), true, 'the same photo again');
  assert.equal(isAlreadyAdded({ name: 'IMG_1.jpg', size: 5001 }), false, 'a revised photo is a new document');
  // a PDF turned in the dialog changes size but keeps its source
  state.filesMap.set('scan.pdf', { name: 'scan.pdf', size: 2100 });
  state.frontendInputData['scan.pdf'] = { title: 'Scan', pageCount: 2, source: 'scan.pdf|2000' };
  assert.equal(isAlreadyAdded({ name: 'scan.pdf', size: 2000 }), true, 'the original PDF again after it was turned');
  // removing the row removes the memory
  state.filesMap.delete('IMG_1.pdf'); delete state.frontendInputData['IMG_1.pdf'];
  assert.equal(isAlreadyAdded({ name: 'IMG_1.jpg', size: 5000 }), false, 'once removed it can be added again');
  for (const k of [...state.filesMap.keys()]) state.filesMap.delete(k);
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
});

import { partFilenames } from '../public/js/frontend/emailSplit.js';

test('split parts never share a download name', () => {
  const parts = [
    { partNumber: 1, partCount: 4, kind: 'front', bundleTitle: 'Hearing: bundle' },
    { partNumber: 2, partCount: 4, kind: 'section', sectionLabel: 'A', sectionName: 'Correspondence' },
    { partNumber: 3, partCount: 4, kind: 'section', sectionLabel: 'A', sectionName: 'Correspondence' },   // same label and name
    { partNumber: 4, partCount: 4 },
  ];
  const names = partFilenames('Bundle.pdf', parts);
  assert.deepEqual(names, ['Hearing bundle - Cover and index.pdf', 'Bundle - A Correspondence.pdf', 'Bundle - A Correspondence - part 3.pdf', 'Bundle-part-4-of-4.pdf']);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
});

test('a section cut by size names each piece "Part N of M", and a title cannot smuggle in a path', () => {
  const pieces = [1, 2].map((n) => ({ partNumber: n, partCount: 2, kind: 'section', sectionLabel: 'B', sectionName: 'Orders/../x', subPart: n, subPartCount: 2, bundleTitle: 'Re: A\\B?' }));
  assert.deepEqual(partFilenames('f.pdf', pieces), ['Re A B - B Orders .. x - Part 1 of 2.pdf', 'Re A B - B Orders .. x - Part 2 of 2.pdf']);
  for (const name of partFilenames('f.pdf', pieces)) assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

test('notes about files that were added are shown with a title that says so', () => {
  const shown = [];
  assert.equal(reportAdded([], 10, 1, '', (m) => shown.push(m), ['"a.jpg" is named .jpg but is really a PDF, so it was added as one.']), true);
  assert.equal(shown[0].title, 'Added, with a note');
  assert.match(shown[0].message, /really a PDF/);
  const two = [];
  reportAdded([], 10, 1, 'x was already in the bundle.', (m) => two.push(m), ['note one', 'note two']);
  assert.equal(two[0].title, 'Added, with notes');
  assert.match(two[0].message, /already in the bundle[\s\S]*note one[\s\S]*note two/);
  // a duplicate on its own keeps its own title
  const dup = [];
  reportAdded([], 10, 1, 'x was already in the bundle.', (m) => dup.push(m));
  assert.equal(dup[0].title, 'Already added');
});
