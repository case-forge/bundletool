/**
 * What is being read, and how long it will take (frontend/ocrReading.js): the entries the automatic check and Force
 * OCR report into, the rolling average of the seconds a page took on this device, the estimate and its rounding, the
 * totals line's words, Skip, and the counting of a run of documents. No page: the module touches none.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../public/js/frontend/state.js';
import {
  PAGE_SAMPLES, setReadingClock, resetReadingTimes, recordPageSeconds, secondsPerPage, secondsLeft, formatTimeLeft,
  trackReading, readingQueued, readingBegun, readingStarted, pageRead, finishReading, stopReading, stopAllReading,
  skipReading, whenFinished, readingTotalsText, readingBadgeText, readingBadgeTitle, readingQuestionText,
  readingWaitText, documentToAskAbout, isReading, onReadingChange, nextReadingChange,
} from '../public/js/frontend/ocrReading.js';

let now = 0;
setReadingClock(() => now);

beforeEach(() => {
  stopAllReading();
  resetReadingTimes();
  now = 0;
  for (const k of Object.keys(state.frontendInputData)) delete state.frontendInputData[k];
});

/** A document checked with `pages` to read and waiting its turn. */
function waiting(name, pages, source = 'auto') {
  trackReading(name, { status: 'checking', source, controller: new AbortController() });
  readingQueued(name, pages);
}

test('time left in words: under 10 s, tens of seconds, minutes, hours', () => {
  assert.equal(formatTimeLeft(null), null, 'no estimate, no words');
  assert.equal(formatTimeLeft(0), 'less than 10 s');
  assert.equal(formatTimeLeft(9.9), 'less than 10 s');
  assert.equal(formatTimeLeft(10), 'about 10 s');
  assert.equal(formatTimeLeft(14), 'about 10 s');
  assert.equal(formatTimeLeft(15), 'about 20 s');
  assert.equal(formatTimeLeft(41), 'about 40 s');
  assert.equal(formatTimeLeft(54), 'about 50 s');
  assert.equal(formatTimeLeft(55), 'about 1 min');
  assert.equal(formatTimeLeft(89), 'about 1 min');
  assert.equal(formatTimeLeft(90), 'about 2 min');
  assert.equal(formatTimeLeft(185), 'about 3 min');
  assert.equal(formatTimeLeft(59 * 60), 'about 59 min');
  assert.equal(formatTimeLeft(3599), 'about 1 h');
  assert.equal(formatTimeLeft(80 * 60), 'about 1 h 20 min');
  assert.equal(formatTimeLeft(-1), null);
  assert.equal(formatTimeLeft(Infinity), null);
});

test('the average is of the last PAGE_SAMPLES pages measured, and there is none before the first', () => {
  assert.equal(secondsPerPage(), null);
  recordPageSeconds(4);
  assert.equal(secondsPerPage(), 4);
  recordPageSeconds(6);
  assert.equal(secondsPerPage(), 5);
  for (let i = 0; i < PAGE_SAMPLES; i++) recordPageSeconds(2);
  assert.equal(secondsPerPage(), 2, 'the older, slower pages have rolled out');
  recordPageSeconds(0);
  recordPageSeconds(NaN);
  recordPageSeconds(-3);
  assert.equal(secondsPerPage(), 2, 'nonsense times are not counted');
});

test('pages are timed from the engine being ready, page by page, and the estimate is pages left times the average', () => {
  waiting('scan.pdf', 5);
  readingBegun('scan.pdf');
  assert.equal(secondsLeft(), null, 'no page has been timed: no estimate, never a guess');
  now = 1000;
  readingStarted('scan.pdf', 5);       // the engine took a second to load: that is not a page
  now = 5000;
  pageRead('scan.pdf', 1, 5);          // 4 s
  assert.equal(secondsPerPage(), 4);
  assert.equal(secondsLeft(), 16, '4 pages left at 4 s');
  now = 7000;                          // 2 s into page 2
  assert.equal(secondsLeft(), 14, 'the page being read has had 2 s already');
  now = 20000;                         // page 2 is slower than the average: never counted below a page's worth
  assert.equal(secondsLeft(), 12);
  pageRead('scan.pdf', 2, 5);          // 15 s
  assert.equal(secondsPerPage(), 9.5);
  assert.equal(secondsLeft(), 28.5);
});

test('a page read while another document is also being read is not timed', () => {
  waiting('a.pdf', 3);
  readingBegun('a.pdf');
  readingStarted('a.pdf', 3);
  trackReading('b.pdf', { status: 'reading', source: 'force', pagesToRead: 2, controller: new AbortController() });
  readingStarted('b.pdf', 2);
  now = 3000;
  pageRead('a.pdf', 1, 3);
  assert.equal(secondsPerPage(), null, 'two at once slow each other: not a fair sample');
  finishReading('b.pdf');
  now = 6000;
  pageRead('a.pdf', 2, 3);
  assert.equal(secondsPerPage(), 3, 'alone again: timed');
});

test('the totals line: "Reading text: 2 of 5 documents, about 40 s left", without the estimate at first, and nothing when idle', () => {
  assert.equal(readingTotalsText(), '');
  trackReading('checking.pdf', { status: 'checking' });
  assert.equal(readingTotalsText(), '', 'a document only being checked shows nothing');
  for (const [name, pages] of [['a.pdf', 2], ['b.pdf', 2], ['c.pdf', 2], ['d.pdf', 2], ['e.pdf', 2]]) waiting(name, pages);
  finishReading('checking.pdf');
  readingBegun('a.pdf');
  assert.equal(readingTotalsText(), 'Reading text: 1 of 5 documents');
  readingStarted('a.pdf', 2);
  now = 4000;
  pageRead('a.pdf', 1, 2);
  now = 8000;
  pageRead('a.pdf', 2, 2);
  finishReading('a.pdf');
  readingBegun('b.pdf');
  readingStarted('b.pdf', 2);
  assert.equal(readingTotalsText(), 'Reading text: 2 of 5 documents, about 30 s left', '8 pages left at 4 s');
  now = 9000;
  assert.equal(readingTotalsText(), 'Reading text: 2 of 5 documents, about 30 s left');
  skipReading('b.pdf');
  readingBegun('c.pdf');
  assert.equal(readingTotalsText(), 'Reading text: 3 of 5 documents, about 20 s left', 'a skipped document still counts as done with');
  stopReading('e.pdf');
  assert.equal(readingTotalsText(), 'Reading text: 3 of 4 documents, about 20 s left', 'a document removed from the table is not counted');
  finishReading('c.pdf');
  finishReading('d.pdf');
  assert.equal(readingTotalsText(), '');
  waiting('f.pdf', 1);
  assert.equal(readingTotalsText(), 'Reading text: 1 document, less than 10 s left', 'a new run counts from one again');
});

test('the row badge: "Reading text…" while read, "Waiting to read" before, nothing while only checked', () => {
  trackReading('x.pdf', { status: 'checking' });
  assert.equal(readingBadgeText(state.ocrReading.get('x.pdf')), null);
  assert.equal(isReading('x.pdf'), false);
  readingQueued('x.pdf', 3);
  assert.equal(readingBadgeText(state.ocrReading.get('x.pdf')), 'Waiting to read');
  assert.match(readingBadgeTitle(state.ocrReading.get('x.pdf')), /^3 pages to read/);
  readingBegun('x.pdf');
  readingStarted('x.pdf', 3);
  assert.equal(readingBadgeText(state.ocrReading.get('x.pdf')), 'Reading text…');
  assert.match(readingBadgeTitle(state.ocrReading.get('x.pdf')), /^Reading page 1 of 3\. Skip/);
  now = 2000;
  pageRead('x.pdf', 1, 3);
  assert.match(readingBadgeTitle(state.ocrReading.get('x.pdf')), /^Reading page 2 of 3, less than 10 s left\./);
  assert.equal(readingBadgeText(null), null);
});

test('Skip stops that document only, marks it skipped and no longer pending, and wakes whoever waits for it', async () => {
  state.frontendInputData['a.pdf'] = { title: 'A', ocrPending: true };
  waiting('a.pdf', 4);
  waiting('b.pdf', 2);
  readingBegun('a.pdf');
  const controller = state.ocrReading.get('a.pdf').controller;
  let woke = false;
  const waited = whenFinished('a.pdf').then(() => { woke = true; });
  assert.equal(skipReading('a.pdf'), true);
  await waited;
  assert.equal(woke, true);
  assert.equal(controller.signal.aborted, true, 'the reading is stopped, not left running');
  assert.equal(state.ocrReading.has('a.pdf'), false);
  assert.equal(state.frontendInputData['a.pdf'].ocrSkipped, true);
  assert.equal(state.frontendInputData['a.pdf'].ocrPending, undefined);
  assert.equal(state.ocrReading.get('b.pdf').status, 'waiting', 'the next document is untouched');
  assert.equal(skipReading('nothing.pdf'), false);
  await whenFinished('nothing.pdf');   // resolves at once for a document not being read
});

test('Create Bundle asks about the document being read now, by name, with its own time left and how many wait after it', () => {
  assert.equal(documentToAskAbout(), null);
  waiting('first.pdf', 2);
  waiting('second.pdf', 3);
  assert.equal(documentToAskAbout(), 'first.pdf', 'nothing read yet: the first waiting');
  readingBegun('second.pdf');
  assert.equal(documentToAskAbout(), 'second.pdf', 'the one being read now');
  assert.equal(readingQuestionText('second.pdf'), 'The text of "second.pdf" is still being read. Wait for it, or skip this document and build without its text? 1 more document waits after it.');
  readingStarted('second.pdf', 3);
  now = 10000;
  pageRead('second.pdf', 1, 3);
  assert.equal(readingQuestionText('second.pdf'), 'The text of "second.pdf" is still being read (about 20 s left). Wait for it, or skip this document and build without its text? 1 more document waits after it.');
  assert.equal(readingQuestionText('first.pdf'), 'The text of "first.pdf" has not been read yet (about 20 s left). Wait for it, or skip this document and build without its text? 1 more document waits after it.');
  assert.equal(readingWaitText('second.pdf'), 'Reading the text of "second.pdf", page 2 of 3, about 20 s left…');
  trackReading('forced.pdf', { status: 'reading', source: 'force', pagesToRead: 1 });
  assert.equal(documentToAskAbout(), 'second.pdf', 'the automatic reading is named before a Force OCR');
});

test('listeners hear every change and can stop listening; nextReadingChange resolves at the next one', async () => {
  const heard = [];
  const stop = onReadingChange((name) => heard.push(name));
  waiting('a.pdf', 1);
  const next = nextReadingChange();
  finishReading('a.pdf');
  await next;
  stop();
  waiting('b.pdf', 1);
  assert.deepEqual(heard, ['a.pdf', 'a.pdf', 'a.pdf']);
});

test('clearing the table stops every reading and starts the count again', () => {
  waiting('a.pdf', 1);
  waiting('b.pdf', 1);
  const controllers = [...state.ocrReading.values()].map((e) => e.controller);
  finishReading('a.pdf');
  assert.equal(state.ocrReadingFinished, 1);
  stopAllReading();
  assert.equal(state.ocrReading.size, 0);
  assert.equal(state.ocrReadingFinished, 0);
  assert.equal(controllers[1].signal.aborted, true);
});
