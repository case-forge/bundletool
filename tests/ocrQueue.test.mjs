/**
 * The automatic OCR check (frontend/ocrAuto.js) as a queue: every added document is checked straight away, documents
 * with pages to read are read one at a time in the order they were added, and each reports page by page into
 * frontend/ocrReading.js. Skip stops one document and the queue moves on; a document needing nothing shows nothing; a
 * document changed while it was read is read again; a saved session brought back before its reading finished reads
 * it again unless it was skipped. The check and the reader are stand-ins driven page by page by the test, the rows
 * are the fake DOM's, and the row badge is the real fileRows.js one.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, FakeElement } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
const autoDetect = doc.body.appendChild(new FakeElement(doc, 'input', 'config-ocrAutoDetect'));
autoDetect.checked = true;

const { state } = await import('../public/js/frontend/state.js');
const { scheduleAutoOcr, resumeUnfinishedReading, autoReader, whenAutoReadingIdle } = await import('../public/js/frontend/ocrAuto.js');
const { OcrStopped } = await import('../public/js/frontend/bundletoolOcrDocument.js');
const { stopAllReading, stopReading, setReadingClock } = await import('../public/js/frontend/ocrReading.js');
await import('../public/js/frontend/fileRows.js');

setReadingClock(() => 0);
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail(`timed out waiting for ${what}`);
}

/** A stand-in document: its "bytes" say which pages need reading. */
function add(name, pages) {
  state.filesMap.set(name, new File([enc({ name, pages })], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: name, pageCount: Math.max(1, ...pages, 1) };
  const tr = doc.body.appendChild(new FakeElement(doc, 'tr'));
  tr.className = 'file-row';
  tr.dataset.filename = name;
  const cell = tr.appendChild(new FakeElement(doc, 'td'));
  cell.className = 'filename-cell';
  return cell;
}

/** Readings in progress, in the order they started; each turns its pages one at a time with next(). */
let readings = [];
beforeEach(() => {
  stopAllReading();
  state.filesMap.clear();
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
  for (const row of doc.querySelectorAll('tr')) row.remove();
  readings = [];
  autoReader.pagesToRead = async (bytes) => dec(bytes).pages;
  autoReader.ocrDocument = (bytes, opts) => new Promise((resolve, reject) => {
    const r = { name: dec(bytes).name, opts, done: 0, stopped: false };
    readings.push(r);
    opts.signal?.addEventListener('abort', () => { r.stopped = true; reject(new OcrStopped()); });
    opts.onStart?.(opts.targets.length);
    r.next = () => {
      r.done++;
      opts.onPage?.(r.done, opts.targets.length);
      if (r.done === opts.targets.length) resolve({ bytes: enc({ name: r.name, read: true }), ocredPages: r.done, skippedPages: [] });
    };
  });
});

const badge = (cell) => cell.querySelector('.bt-badge-reading .bt-badge-reading-label')?.textContent ?? null;
const ocrBadge = (cell) => cell.querySelectorAll('.bt-badge-ocr').length;

test('documents are read one at a time, in the order added; a document needing nothing shows nothing', async () => {
  const a = add('a.pdf', [1, 2]);
  const text = add('text.pdf', []);
  const b = add('b.pdf', [1]);
  for (const name of ['a.pdf', 'text.pdf', 'b.pdf']) scheduleAutoOcr(name);
  await until(() => readings.length === 1 && state.ocrReading.get('b.pdf')?.status === 'waiting', 'the first reading');
  assert.equal(readings[0].name, 'a.pdf');
  assert.deepEqual(readings[0].opts.targets, [1, 2], 'the pages the check found are passed on, not checked twice');
  assert.equal(badge(a), 'Reading text…');
  assert.equal(badge(b), 'Waiting to read');
  assert.equal(badge(text), null, 'nothing to read: no badge');
  assert.equal(state.ocrReading.has('text.pdf'), false);
  assert.equal(state.frontendInputData['text.pdf'].ocrPending, undefined, 'and nothing left pending');
  assert.equal(state.ocrReading.get('a.pdf').pagesToRead, 2);

  readings[0].next();
  assert.equal(state.ocrReading.get('a.pdf').pagesDone, 1);
  await tick();
  assert.equal(readings.length, 1, 'b waits until a is done');
  readings[0].next();
  await until(() => readings.length === 2, 'the second reading');
  assert.equal(readings[1].name, 'b.pdf');
  assert.equal(badge(a), null, 'the reading badge is gone...');
  assert.equal(ocrBadge(a), 1, '...and the OCR badge has taken its place');
  assert.equal(state.frontendInputData['a.pdf'].ocrApplied, true);
  assert.equal(state.frontendInputData['a.pdf'].ocrPending, undefined);
  assert.equal(dec(await state.filesMap.get('a.pdf').arrayBuffer()).read, true, 'the text layer is in the held file');
  assert.equal(badge(b), 'Reading text…');
  readings[1].next();
  await whenAutoReadingIdle();
  assert.equal(state.ocrReading.size, 0);
  assert.equal(ocrBadge(b), 1);
});

test('Skip on the row being read stops it at once, leaves its file as it was, and the queue moves on', async () => {
  const a = add('a.pdf', [1, 2, 3]);
  const b = add('b.pdf', [1]);
  const before = state.filesMap.get('a.pdf');
  scheduleAutoOcr('a.pdf');
  scheduleAutoOcr('b.pdf');
  await until(() => readings.length === 1 && state.ocrReading.get('b.pdf')?.status === 'waiting', 'a being read');
  readings[0].next();
  a.querySelector('.bt-badge-skip').click();
  assert.equal(readings[0].stopped, true, 'the reading itself is stopped, not left to run');
  await until(() => readings.length === 2, 'b being read');
  assert.equal(readings[1].name, 'b.pdf');
  assert.equal(state.filesMap.get('a.pdf'), before, 'the held file is exactly as it was');
  assert.equal(badge(a), null);
  assert.equal(ocrBadge(a), 0, 'a skipped document never gets the OCR badge');
  assert.equal(state.frontendInputData['a.pdf'].ocrSkipped, true);
  readings[1].next();
  await whenAutoReadingIdle();
  assert.equal(ocrBadge(b), 1);
});

test('Skip on a row still waiting takes it out of the queue before it starts', async () => {
  add('a.pdf', [1]);
  const b = add('b.pdf', [1]);
  add('c.pdf', [1]);
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) scheduleAutoOcr(name);
  await until(() => state.ocrReading.get('c.pdf')?.status === 'waiting', 'all checked');
  b.querySelector('.bt-badge-skip').click();
  readings[0].next();
  await until(() => readings.length === 2, 'the next reading');
  assert.deepEqual(readings.map((r) => r.name), ['a.pdf', 'c.pdf'], 'b was never read');
  readings[1].next();
  await whenAutoReadingIdle();
});

test('a document removed while it is read stops being read; one changed while read is read again from its new bytes', async () => {
  add('gone.pdf', [1, 2]);
  add('turned.pdf', [1]);
  scheduleAutoOcr('gone.pdf');
  scheduleAutoOcr('turned.pdf');
  await until(() => readings.length === 1 && state.ocrReading.get('turned.pdf')?.status === 'waiting', 'reading');
  stopReading('gone.pdf');
  state.filesMap.delete('gone.pdf');
  delete state.frontendInputData['gone.pdf'];
  await until(() => readings.length === 2, 'the next one');
  assert.equal(readings[0].stopped, true);
  // turned.pdf is replaced (the document window turned it) while it is read: the result is not written, and it is
  // checked and read again.
  state.filesMap.set('turned.pdf', new File([enc({ name: 'turned.pdf', pages: [1], turned: true })], 'turned.pdf'));
  readings[1].next();
  await until(() => readings.length === 3, 'read again');
  assert.equal(readings[2].name, 'turned.pdf');
  readings[2].next();
  await whenAutoReadingIdle();
  assert.equal(state.frontendInputData['turned.pdf'].ocrApplied, true);
});

test('with the automatic check switched off nothing is checked or read', async () => {
  add('a.pdf', [1]);
  autoDetect.checked = false;
  try {
    scheduleAutoOcr('a.pdf');
    await whenAutoReadingIdle();
    assert.equal(readings.length, 0);
    assert.equal(state.ocrReading.size, 0);
  } finally { autoDetect.checked = true; }
});

test('a restored session reads again the documents whose reading had not finished, but never a skipped one', async () => {
  add('pending.pdf', [1]);
  add('skipped.pdf', [1]);
  add('done.pdf', [1]);
  state.frontendInputData['pending.pdf'].ocrPending = true;
  Object.assign(state.frontendInputData['skipped.pdf'], { ocrPending: true, ocrSkipped: true });
  resumeUnfinishedReading();
  await until(() => readings.length === 1, 'the pending one');
  assert.equal(readings[0].name, 'pending.pdf');
  readings[0].next();
  await whenAutoReadingIdle();
  assert.equal(readings.length, 1);
});

test('the add path marks a document pending until it is read, so a save taken meanwhile brings it back', async () => {
  add('a.pdf', [1]);
  scheduleAutoOcr('a.pdf');
  assert.equal(state.frontendInputData['a.pdf'].ocrPending, true);
  await until(() => readings.length === 1, 'reading');
  readings[0].next();
  await whenAutoReadingIdle();
  assert.equal(state.frontendInputData['a.pdf'].ocrPending, undefined);
});
