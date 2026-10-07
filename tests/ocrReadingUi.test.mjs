/**
 * What the Review Table shows while text is read: the row badge ("Reading text…", or "Waiting to read") with its
 * Skip button, the same size and look as the OCR badge that replaces it (fileRows.js), and the words beside the
 * totals line, "Reading text: 2 of 5 documents, about 40 s left", only while anything is being read
 * (bundleTotals.js). Real modules, fake DOM, the real template and stylesheet.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, FakeElement } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
const totals = doc.body.appendChild(new FakeElement(doc, 'p', 'bundle-totals'));
const line = doc.body.appendChild(new FakeElement(doc, 'p', 'bundle-reading'));
line.hidden = true;

const { state } = await import('../public/js/frontend/state.js');
const R = await import('../public/js/frontend/ocrReading.js');
const { setReadingBadge, setOcrBadge } = await import('../public/js/frontend/fileRows.js');
const { refreshBundleTotals, refreshReadingTotals } = await import('../public/js/frontend/bundleTotals.js');

let now = 0;
R.setReadingClock(() => now);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

function row(name) {
  const tr = doc.body.appendChild(new FakeElement(doc, 'tr'));
  tr.className = 'file-row';
  tr.dataset.filename = name;
  const cell = tr.appendChild(new FakeElement(doc, 'td'));
  cell.className = 'filename-cell';
  return cell;
}

beforeEach(() => {
  R.stopAllReading();
  R.resetReadingTimes();
  now = 0;
  for (const r of doc.querySelectorAll('tr')) r.remove();
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
});

test('a row being read shows "Reading text…" and a Skip button that names its document; nothing before or after', () => {
  const cell = row('Exhibit_4.pdf');
  R.trackReading('Exhibit_4.pdf', { status: 'checking' });
  assert.equal(cell.querySelector('.bt-badge-reading'), null, 'being checked: nothing yet');
  R.readingQueued('Exhibit_4.pdf', 2);
  assert.equal(cell.querySelector('.bt-badge-reading-label').textContent, 'Waiting to read');
  assert.ok(cell.querySelector('.bt-badge-reading').classList.contains('bt-badge-reading--waiting'));
  R.readingBegun('Exhibit_4.pdf');
  R.readingStarted('Exhibit_4.pdf', 2);
  const badge = cell.querySelector('.bt-badge-reading');
  assert.equal(badge.querySelector('.bt-badge-reading-label').textContent, 'Reading text…');
  assert.ok(!badge.classList.contains('bt-badge-reading--waiting'));
  const skip = badge.querySelector('.bt-badge-skip');
  assert.equal(skip.textContent, 'Skip');
  assert.equal(skip.getAttribute('aria-label'), 'Skip reading the text of Exhibit_4.pdf');
  assert.equal(skip.type, 'button', 'never a submit button inside the form');
  assert.match(badge.title, /^Reading page 1 of 2\./);
  R.pageRead('Exhibit_4.pdf', 1, 2);
  assert.equal(cell.querySelectorAll('.bt-badge-reading').length, 1, 'one badge, kept up to date');
  assert.match(badge.title, /^Reading page 2 of 2\./);
  R.finishReading('Exhibit_4.pdf');
  setOcrBadge('Exhibit_4.pdf');
  assert.equal(cell.querySelector('.bt-badge-reading'), null, 'gone once read...');
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 1, '...and the OCR badge in its place');
});

test('Skip on the row stops that document and takes its badge away', () => {
  const cell = row('a.pdf');
  state.frontendInputData['a.pdf'] = { title: 'A' };
  R.trackReading('a.pdf', { status: 'reading', controller: new AbortController() });
  const controller = state.ocrReading.get('a.pdf').controller;
  cell.querySelector('.bt-badge-skip').click();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cell.querySelector('.bt-badge-reading'), null);
  assert.equal(state.frontendInputData['a.pdf'].ocrSkipped, true);
});

test('a row put in the table after its check finished gets its badge when the add path draws it', () => {
  R.trackReading('late.pdf', { status: 'checking' });
  R.readingQueued('late.pdf', 1);
  const cell = row('late.pdf');
  assert.equal(cell.querySelector('.bt-badge-reading'), null, 'the row was not there when the reading started');
  setReadingBadge('late.pdf');
  assert.equal(cell.querySelector('.bt-badge-reading-label').textContent, 'Waiting to read');
  const code = read('../public/js/frontend/fileProcessing.js');
  assert.match(code, /insertBefore\(fragment[\s\S]{0,300}for \(const r of rows\) setReadingBadge\(r\.dataset\.filename\);/);
  assert.match(read('../public/js/frontend/fileRows.js'), /renderReadingBadge\(row\.querySelector\('\.filename-cell'\), filename\);/, 'and makeFileRow draws it for a row made mid-read');
});

test('the totals line says what is being read, with the time left once a page has been timed, and nothing otherwise', () => {
  state.frontendInputData['a.pdf'] = { title: 'A', pageCount: 3 };
  state.frontendInputData['b.pdf'] = { title: 'B', pageCount: 2 };
  refreshBundleTotals();
  assert.equal(totals.textContent, '2 documents, 5 pages');
  assert.equal(refreshReadingTotals(), '');
  assert.equal(line.hidden, true);
  R.trackReading('a.pdf', { status: 'checking' });
  R.readingQueued('a.pdf', 3);
  R.trackReading('b.pdf', { status: 'checking' });
  R.readingQueued('b.pdf', 2);
  R.readingBegun('a.pdf');
  R.readingStarted('a.pdf', 3);
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, 'Reading text: 1 of 2 documents', 'no time before a page has been timed');
  now = 8000;
  R.pageRead('a.pdf', 1, 3);
  assert.equal(line.textContent, 'Reading text: 1 of 2 documents, about 30 s left');
  R.finishReading('a.pdf');
  R.finishReading('b.pdf');
  assert.equal(line.hidden, true);
  assert.equal(line.textContent, '');
  assert.equal(totals.textContent, '2 documents, 5 pages', 'the totals themselves are untouched');
});

test('the template puts the reading words beside the totals, and the stylesheet draws the badge exactly as the OCR badge', () => {
  const html = read('../layouts/partials/bundletool.html');
  assert.match(html, /<div class="bt-totals-line[^"]*">\s*<p id="bundle-totals"[^>]*hidden><\/p>\s*<p id="bundle-reading"[^>]*hidden><\/p>\s*<\/div>/);
  const css = read('../assets/css/bundletool.css');
  const rule = (sel) => {
    const m = css.match(new RegExp(`^\\${sel} \\{([^}]*)\\}`, 'm'));
    assert.ok(m, sel);
    return Object.fromEntries(m[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(':').map((s) => s.trim())));
  };
  const ocr = rule('.bt-badge-ocr');
  const reading = rule('.bt-badge-reading');
  for (const prop of ['font-size', 'font-weight', 'padding', 'border-radius', 'background', 'color', 'margin-left', 'vertical-align']) {
    assert.equal(reading[prop], ocr[prop], prop);
  }
  const skip = rule('.bt-badge-skip');
  assert.equal(skip.font, 'inherit', 'Skip is the badge\'s own size');
  assert.equal(skip.padding, '0', 'and adds nothing to its height');
});

test('Force OCR reports into the same state: the row says "Reading text…" while it runs, and Skip stops it quietly', async () => {
  const { forceOcr } = await import('../public/js/frontend/ocrForce.js');
  const { OcrStopped } = await import('../public/js/frontend/bundletoolOcrDocument.js');
  const errorModal = doc.body.appendChild(new FakeElement(doc, 'div', 'error-modal'));
  errorModal.classList.add('hidden');
  const cell = row('forced.pdf');
  state.filesMap.set('forced.pdf', new File([new Uint8Array([1])], 'forced.pdf'));
  state.frontendInputData['forced.pdf'] = { title: 'F', pageCount: 4 };
  // An automatic reading of the same document is under way: Force OCR stops it first, as it reads every page anyway.
  R.trackReading('forced.pdf', { status: 'reading', source: 'auto', controller: new AbortController() });
  const auto = state.ocrReading.get('forced.pdf').controller;
  let started;
  const running = forceOcr('forced.pdf', null, {
    ocr: (bytes, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new OcrStopped()));
      opts.onStart(4);
      started = opts;
    }),
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(auto.signal.aborted, true, 'the automatic reading was stopped');
  assert.equal(state.ocrReading.get('forced.pdf').source, 'force');
  assert.equal(cell.querySelector('.bt-badge-reading-label').textContent, 'Reading text…');
  started.onPage(1, 4);
  assert.equal(state.ocrReading.get('forced.pdf').pagesDone, 1);
  cell.querySelector('.bt-badge-skip').click();
  assert.equal(await running, false, 'nothing written');
  assert.equal(errorModal.classList.contains('hidden'), true, 'and no error shown for a Skip');
  assert.equal(cell.querySelector('.bt-badge-reading'), null);
  assert.equal(cell.querySelectorAll('.bt-badge-ocr').length, 0);
  state.filesMap.delete('forced.pdf');
});
