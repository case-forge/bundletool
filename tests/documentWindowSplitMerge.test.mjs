/**
 * "Split" and "Merge" in the document window (frontend/rotate.js, splitMerge.js): Split is done at once and Merge asks
 * first (Keep it and the close cross leave everything as it was); Split cuts the document after the page shown into two documents with
 * the second's row straight under the first; Merge adds the document straight below onto the end and its row goes;
 * Split then Merge gives back what you started with; the OCR record follows the pages both ways.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { FakeElement } from './fakeDom.mjs';
import { doc, modal, state, $, tick, until, open, html } from './documentWindowHarness.mjs';

const { init: initAutosave } = await import('../public/js/bundletoolAutosave.js');
initAutosave(async () => null);
const { makeFileRow } = await import('../public/js/frontend/fileRows.js');

// The rows a split makes are built from markup, which this document only parses when asked.
doc.parseHtml = true;
if (!doc.getElementById('bundle-totals')) doc.body.appendChild(new FakeElement(doc, 'p', 'bundle-totals'));

/** A PDF whose page n is (100 + n) points wide, so a page can be told from another by its width alone. */
async function widthsPdf(count) {
  const pdf = await PDFDocument.create();
  for (let i = 1; i <= count; i++) pdf.addPage([100 + i, 200]);
  return pdf.save();
}
const widthsOf = async (name) => (await PDFDocument.load(await state.filesMap.get(name).arrayBuffer())).getPages().map((p) => Math.round(p.getWidth()) - 100);
const namesInOrder = (tbody) => tbody.children.filter((r) => r.classList.contains('file-row')).map((r) => r.dataset.filename);

let n = 0;
/** A section holding `name` (opened in the window) and, when `below` is given, a second document under it. */
async function setup(pages, below = null) {
  const id = ++n;
  const name = `bundle-${id}.pdf`;
  const tbody = doc.body.appendChild(new FakeElement(doc, 'tbody'));
  const opened = await open(name, await widthsPdf(pages));
  const addRow = (filename) => tbody.appendChild(makeFileRow(filename, { title: state.frontendInputData[filename].title, date: '', pageCount: state.frontendInputData[filename].pageCount }));
  addRow(name);
  let belowName = null;
  if (below) {
    belowName = `after-${id}.pdf`;
    state.filesMap.set(belowName, new File([await widthsPdf(below)], belowName, { type: 'application/pdf' }));
    state.frontendInputData[belowName] = { title: 'Below', date: '', pageCount: below };
    addRow(belowName);
  }
  // The window opened before the rows were there, so what Merge depends on is worked out again by paging.
  $('rotate-next').click();
  $('rotate-prev').click();
  // Let the page being drawn finish: a window closed in the middle of a drawing stops pdf.js's worker with it.
  await new Promise((r) => setTimeout(r, 60));
  return { name, belowName, tbody, ...opened };
}

const closed = () => modal.classList.contains('hidden');
const asking = () => !$('rotate-remove-confirm').classList.contains('hidden');

test('the four buttons are there, in order', async () => {
  await setup(3);
  const at = ['rotate-ocr', 'rotate-remove', 'rotate-split', 'rotate-merge'].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), 'OCR, Remove, Split, Merge in that order in one row');
  assert.match(html.slice(at[1], html.indexOf('</button>', at[1])), /<span>Remove<\/span>/);
  assert.match(html.slice(at[1], html.indexOf('>', at[1])), /title="Remove page:/);
  $('rotate-close').click();
});

test('Split is off on the last page and on a one-page document; Merge is off with nothing below', async () => {
  await setup(3);
  assert.equal($('rotate-split').disabled, false, 'page 1 of 3 can be cut after');
  assert.equal($('rotate-merge').disabled, true, 'nothing is below');
  $('rotate-next').click();
  $('rotate-next').click();
  assert.equal($('rotate-split').disabled, true, 'the last page has nothing after it');
  $('rotate-close').click();
  await setup(1);
  assert.equal($('rotate-split').disabled, true);
  $('rotate-close').click();
});

test('Split is done at once, with no question; Merge asks first and Keep it and the close cross leave everything as it was', async () => {
  const { name, tbody } = await setup(4);
  $('rotate-next').click();
  $('rotate-split').click();
  assert.equal(asking(), false, 'Split asks nothing');
  await until(() => namesInOrder(tbody).length === 2 && !$('rotate-merge').disabled, 'the split to finish');
  $('rotate-close').click();

  for (const way of ['rotate-remove-keep', 'rotate-close']) {
    const merged = await setup(2, 2);
    $('rotate-merge').click();
    assert.equal(asking(), true);
    $(way).click();
    await tick();
    assert.equal(state.filesMap.get(merged.name), merged.file, `${way} keeps the very same file`);
    assert.deepEqual(namesInOrder(merged.tbody), [merged.name, merged.belowName]);
    if (way === 'rotate-remove-keep') $('rotate-close').click();
  }
  assert.ok(name);
});

test('Split cuts after the page shown: two documents, the new row straight under the first', async () => {
  const { name, tbody } = await setup(5);
  state.frontendInputData[name].source = 'bundle.pdf|123';
  $('rotate-next').click();
  $('rotate-next').click();
  $('rotate-split').click();
  await until(() => namesInOrder(tbody).length === 2 && !$('rotate-merge').disabled, 'the split');
  const [, newName] = namesInOrder(tbody);
  assert.equal(newName, `${name.replace(/\.pdf$/, '')} (pages 4-5).pdf`);
  assert.deepEqual(namesInOrder(tbody), [name, newName], 'straight under the original');
  assert.deepEqual(await widthsOf(name), [1, 2, 3]);
  assert.deepEqual(await widthsOf(newName), [4, 5]);
  assert.equal(state.frontendInputData[name].pageCount, 3);
  assert.equal(state.frontendInputData[newName].pageCount, 2);
  assert.equal(state.frontendInputData[newName].source, undefined, 'only the first part stands for the file that was dropped');
  assert.equal(state.frontendInputData[name].pagesChanged, true);
  assert.equal(state.frontendInputData[newName].pagesChanged, true);
  assert.equal(String(tbody.children[0].querySelector('.pages-cell').textContent), '3');
  assert.equal(String(tbody.children[1].querySelector('.pages-cell').textContent), '2');
  assert.match($('rotate-message').textContent, /^Split after page 3\./);
  assert.equal($('rotate-merge').disabled, false, 'the new document is below now');
  assert.equal(closed(), false, 'the window stays open on the first part');
  $('rotate-close').click();
});

test('Merge asks first, then adds the document below onto the end and its row goes', async () => {
  const { name, belowName, tbody, file } = await setup(2, 3);
  assert.equal($('rotate-merge').disabled, false);
  $('rotate-merge').click();
  assert.equal($('rotate-remove-question').textContent, `Add "${belowName}" (3 pages) onto the end of this document? They become one document, and the one below leaves the bundle.`);
  assert.equal($('rotate-remove-yes').textContent, 'Merge');
  $('rotate-remove-keep').click();
  await tick();
  assert.equal(state.filesMap.get(name), file);
  assert.deepEqual(namesInOrder(tbody), [name, belowName]);

  $('rotate-merge').click();
  $('rotate-remove-yes').click();
  await until(() => !state.filesMap.has(belowName) && !$('rotate-merge').disabled === false, 'the merge');
  assert.deepEqual(await widthsOf(name), [1, 2, 1, 2, 3]);
  assert.deepEqual(namesInOrder(tbody), [name]);
  assert.equal(state.frontendInputData[belowName], undefined);
  assert.equal(state.frontendInputData[name].pageCount, 5);
  assert.equal(String(tbody.children[0].querySelector('.pages-cell').textContent), '5');
  assert.equal($('rotate-merge').disabled, true, 'nothing is below any more');
  $('rotate-close').click();
});

test('Split and then Merge gives the original document back', async () => {
  const { name, tbody } = await setup(6);
  for (let i = 0; i < 3; i++) $('rotate-next').click();
  $('rotate-split').click();
  await until(() => namesInOrder(tbody).length === 2 && !$('rotate-merge').disabled, 'the split');
  $('rotate-merge').click();
  $('rotate-remove-yes').click();
  await until(() => namesInOrder(tbody).length === 1 && !$('rotate-merge').disabled === false, 'the merge');
  assert.deepEqual(await widthsOf(name), [1, 2, 3, 4, 5, 6]);
  assert.equal(state.frontendInputData[name].pageCount, 6);
  $('rotate-close').click();
});

test('the OCR record follows the pages: a split hands the later pages to the new document and a merge takes them back', async () => {
  const { name, tbody } = await setup(4);
  state.frontendInputData[name].ocrApplied = true;
  state.frontendInputData[name].ocrPages = { turned: [[1, 90], [4, 180]], straightened: [[3, 1.5]], sideways: [], notStraightened: [2, 4], putBack: [3] };
  $('rotate-next').click();
  $('rotate-split').click();
  await until(() => namesInOrder(tbody).length === 2 && !$('rotate-merge').disabled, 'the split');
  const [, newName] = namesInOrder(tbody);
  assert.deepEqual(state.frontendInputData[name].ocrPages, { turned: [[1, 90]], straightened: [], sideways: [], notStraightened: [2], putBack: [] });
  assert.deepEqual(state.frontendInputData[newName].ocrPages, { turned: [[2, 180]], straightened: [[1, 1.5]], sideways: [], notStraightened: [2], putBack: [1] });
  assert.equal(state.frontendInputData[newName].ocrApplied, true, 'the new part is as read as the original was');
  $('rotate-merge').click();
  $('rotate-remove-yes').click();
  await until(() => namesInOrder(tbody).length === 1 && !$('rotate-merge').disabled === false, 'the merge');
  assert.deepEqual(state.frontendInputData[name].ocrPages.turned, [[1, 90], [4, 180]]);
  assert.deepEqual(state.frontendInputData[name].ocrPages.putBack, [3]);
  $('rotate-close').click();
});

test('a merge leaves the document marked as read only when both parts were', async () => {
  const { name, belowName } = await setup(2, 2);
  state.frontendInputData[name].ocrApplied = true;
  $('rotate-merge').click();
  $('rotate-remove-yes').click();
  await until(() => !state.filesMap.has(belowName) && !$('rotate-split').disabled, 'the merge');
  assert.equal(state.frontendInputData[name].ocrApplied, undefined);
  $('rotate-close').click();
});
