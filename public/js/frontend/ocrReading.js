/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * ocrReading.js
 * What is being read, and how long it will take. Both ways text is read, the automatic check on add (ocrAuto.js) and
 * Force OCR (ocrForce.js), report here document by document and page by page; the Review Table's row badge
 * (fileRows.js), the totals line (bundleTotals.js) and the question Create Bundle asks while reading is unfinished
 * (ocrWait.js) read it and listen for its changes. Nothing here touches the page, so it is unit tested.
 *
 * An entry (state.ocrReading) goes through three states:
 *   checking  the document is being checked for pages without text of their own; nothing is shown yet, because most
 *             documents need nothing read and must show nothing
 *   waiting   it has pages to read and waits its turn: documents are read one at a time, in the order they were added
 *   reading   its pages are being read now
 * and leaves when it is read, skipped, stopped or removed.
 *
 * THE ESTIMATE. The seconds each page actually took on this device, in this visit, the last PAGE_SAMPLES of them
 * averaged, times the pages left. Nothing is guessed from the hardware: until a page has been read there is no
 * estimate at all. A page is timed only while it is the only one being read, since two at once slow each other down.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';

/** How many of the most recent page times the average is taken over. */
export const PAGE_SAMPLES = 8;

const samples = [];
const listeners = new Set();
const waiters = new Map();
let clock = () => performance.now();
let ticker = null;

/** For tests: a clock in milliseconds instead of performance.now(). */
export function setReadingClock(fn) { clock = fn ?? (() => performance.now()); }

/** For tests: forgets the page times, as a new visit would. */
export function resetReadingTimes() { samples.length = 0; }

/**
 * Calls `fn(filename)` after every change, with the document's name, or null for a change to all of them (or the once
 * a second refresh of the estimate while a page is being read). Returns a function that stops it.
 */
export function onReadingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves at the next change, whatever it is. */
export function nextReadingChange() {
  return new Promise((resolve) => {
    const stop = onReadingChange(() => { stop(); resolve(); });
  });
}

function changed(filename) {
  for (const fn of [...listeners]) {
    try {
      fn(filename);
    } catch (error) {
      console.warn('[ocr] could not show reading progress:', error);
    }
  }
  keepTicking();
}

// While a page is being read, the estimate counts down between pages too: the listeners hear null once a second.
function keepTicking() {
  const busy = [...state.ocrReading.values()].some((e) => e.status === 'reading');
  if (busy && !ticker) {
    ticker = setInterval(() => changed(null), 1000);
    ticker.unref?.();
  } else if (!busy && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** The document's entry, or null when nothing is being read for it. */
export function readingEntry(filename) {
  return state.ocrReading.get(filename) ?? null;
}

/** True while a document is waiting to be read or being read (not while it is only being checked). */
export function isReading(filename) {
  const entry = state.ocrReading.get(filename);
  return Boolean(entry && entry.status !== 'checking');
}

/** The entries a person sees, in the order the documents were added. */
export function visibleEntries() {
  return [...state.ocrReading.entries()].filter(([, e]) => e.status !== 'checking');
}

/** True while any document is still being checked, waiting or being read. */
export function readingUnfinished() {
  return state.ocrReading.size > 0;
}

/**
 * Starts following a document.
 * @param {string} filename
 * @param {{status?: 'checking'|'waiting'|'reading', source?: 'auto'|'force', pagesToRead?: number|null,
 *   controller?: AbortController|null}} [opts]
 * @returns {object} the entry, which its reader keeps to tell later whether it is still the one being followed
 */
export function trackReading(filename, { status = 'checking', source = 'auto', pagesToRead = null, controller = null } = {}) {
  const entry = { status, source, pagesToRead, pagesDone: 0, controller, pageStartedAt: null, targets: null };
  state.ocrReading.set(filename, entry);
  changed(filename);
  return entry;
}

/** A checked document has `pagesToRead` pages to read and waits its turn. */
export function readingQueued(filename, pagesToRead) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return;
  entry.status = 'waiting';
  entry.pagesToRead = pagesToRead;
  changed(filename);
}

/** Its turn has come: it is being read now. The clock for its first page starts at readingStarted(). */
export function readingBegun(filename) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return;
  entry.status = 'reading';
  entry.pageStartedAt = null;
  changed(filename);
}

/** The engine is ready and `total` pages will be read; the first page starts now. */
export function readingStarted(filename, total) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return;
  entry.status = 'reading';
  entry.pagesToRead = total;
  entry.pagesDone = 0;
  entry.pageStartedAt = clock();
  changed(filename);
}

/** Page `done` of `total` is read: its time joins the average when nothing else was being read with it. */
export function pageRead(filename, done, total) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return;
  const now = clock();
  const alone = [...state.ocrReading.values()].filter((e) => e.status === 'reading').length === 1;
  if (entry.pageStartedAt !== null && alone) recordPageSeconds((now - entry.pageStartedAt) / 1000);
  entry.pagesDone = done;
  entry.pagesToRead = total;
  entry.pageStartedAt = now;
  changed(filename);
}

/** One page's time, in seconds, into the rolling average. */
export function recordPageSeconds(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return;
  samples.push(seconds);
  if (samples.length > PAGE_SAMPLES) samples.shift();
}

/** The average seconds a page took on this device in this visit, or null before any page has been read. */
export function secondsPerPage() {
  return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
}

/**
 * The document is done with: read, skipped, stopped or removed. `counted` (true unless the document left the table)
 * counts it among the documents finished in this run, for "2 of 5"; one only checked was never shown, so it is not.
 */
export function finishReading(filename, { counted = true } = {}) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return;
  state.ocrReading.delete(filename);
  if (counted && entry.status !== 'checking') state.ocrReadingFinished++;
  if (visibleEntries().length === 0) state.ocrReadingFinished = 0;
  for (const resolve of waiters.get(filename) ?? []) resolve();
  waiters.delete(filename);
  changed(filename);
}

/** Stops the reading of one document, wherever it has got to, and forgets it. Nothing it read is written. */
export function stopReading(filename, { counted = false } = {}) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return false;
  entry.controller?.abort();
  finishReading(filename, { counted });
  return true;
}

/** Stops everything: the table was cleared or replaced. */
export function stopAllReading() {
  for (const filename of [...state.ocrReading.keys()]) stopReading(filename);
  state.ocrReadingFinished = 0;
}

/**
 * Skip: the person's choice to stop reading one document and move on. Its file stays exactly as it is, it gets no
 * OCR badge, and it is not read again by itself (a restored session, a turned page); Force OCR in its window still
 * reads it whenever asked.
 */
export function skipReading(filename) {
  if (!state.ocrReading.has(filename)) return false;
  const info = state.frontendInputData[filename];
  if (info) {
    info.ocrSkipped = true;
    delete info.ocrPending;
  }
  stopReading(filename, { counted: true });
  markDirty();
  return true;
}

/** Resolves once the document is no longer being checked, waiting or being read (at once if it is not). */
export function whenFinished(filename) {
  if (!state.ocrReading.has(filename)) return Promise.resolve();
  return new Promise((resolve) => {
    if (!waiters.has(filename)) waiters.set(filename, new Set());
    waiters.get(filename).add(resolve);
  });
}

// ── The estimate and the words ─────────────────────────────────────────────────────────────────────────────

/** Pages still to read for one entry (none known yet counts as none). */
function pagesLeftOf(entry) {
  if (!Number.isFinite(entry.pagesToRead)) return 0;
  return Math.max(0, entry.pagesToRead - entry.pagesDone);
}

/**
 * Seconds left for the given entries: their pages left times the average page time, less the time the page being
 * read has already had (never more than one page's worth). Null before any page has been timed.
 */
export function secondsLeft(entries = [...state.ocrReading.values()]) {
  const perPage = secondsPerPage();
  if (perPage === null) return null;
  const now = clock();
  let seconds = 0;
  for (const entry of entries) {
    if (entry.status === 'checking') continue;
    seconds += pagesLeftOf(entry) * perPage;
    if (entry.status === 'reading' && entry.pageStartedAt !== null && pagesLeftOf(entry) > 0) {
      seconds -= Math.min((now - entry.pageStartedAt) / 1000, perPage);
    }
  }
  return Math.max(0, seconds);
}

/**
 * Time left in words: "less than 10 s", "about 40 s", "about 3 min", "about 1 h 20 min". Null when there is no
 * estimate.
 */
export function formatTimeLeft(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 10) return 'less than 10 s';
  if (seconds < 55) return `about ${Math.round(seconds / 10) * 10} s`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `about ${minutes} min`;
  let hours = Math.floor(minutes / 60);
  let rest = Math.round((minutes % 60) / 10) * 10;
  if (rest === 60) { hours++; rest = 0; }
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

/** The totals line's words while anything is waiting or being read ("Reading text: 2 of 5 documents, about 40 s
 * left"), or '' when nothing is. */
export function readingTotalsText() {
  const visible = visibleEntries().map(([, e]) => e);
  if (visible.length === 0) return '';
  const total = state.ocrReadingFinished + visible.length;
  const reading = visible.filter((e) => e.status === 'reading').length;
  const position = Math.min(total, state.ocrReadingFinished + Math.max(1, reading));
  const documents = total === 1 ? '1 document' : `${position} of ${total} documents`;
  const left = formatTimeLeft(secondsLeft(visible));
  return `Reading text: ${documents}${left ? `, ${left} left` : ''}`;
}

/** The row badge's words, or null for a row that shows none. */
export function readingBadgeText(entry) {
  if (!entry || entry.status === 'checking') return null;
  return entry.status === 'reading' ? 'Reading text…' : 'Waiting to read';
}

/** The row badge's tooltip: which page, and the time left for this document when there is an estimate. */
export function readingBadgeTitle(entry) {
  if (!entry || entry.status === 'checking') return '';
  const left = formatTimeLeft(secondsLeft([entry]));
  const total = Number.isFinite(entry.pagesToRead) ? entry.pagesToRead : null;
  if (entry.status === 'waiting') {
    const pages = total ? `${total} page${total === 1 ? '' : 's'} to read` : 'Pages to read';
    return `${pages}, after the documents before it. Skip leaves this document as it is.`;
  }
  const page = total ? `Reading page ${Math.min(entry.pagesDone + 1, total)} of ${total}` : 'Reading its text';
  return `${page}${left ? `, ${left} left` : ''}. Skip leaves this document as it is.`;
}

/**
 * The document Create Bundle asks about: the one being read now (the automatic reading first), else the next one
 * waiting. Null when nothing is waiting or being read.
 */
export function documentToAskAbout() {
  const visible = visibleEntries();
  const reading = visible.filter(([, e]) => e.status === 'reading');
  const pick = reading.find(([, e]) => e.source === 'auto') ?? reading[0] ?? visible[0];
  return pick ? pick[0] : null;
}

/**
 * The question Create Bundle asks about one document: its name, the time left for it when there is an estimate, and
 * how many more wait after it.
 */
export function readingQuestionText(filename) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return '';
  const left = formatTimeLeft(secondsLeft([entry]));
  const verb = entry.status === 'reading' ? 'is still being read' : 'has not been read yet';
  const others = visibleEntries().length - 1;
  const after = others > 0 ? ` ${others} more document${others === 1 ? ' waits' : 's wait'} after it.` : '';
  return `The text of "${filename}" ${verb}${left ? ` (${left} left)` : ''}. Wait for it, or skip this document and build without its text?${after}`;
}

/** The waiting line shown while Create Bundle waits for one document. */
export function readingWaitText(filename) {
  const entry = state.ocrReading.get(filename);
  if (!entry) return 'Reading text…';
  const total = Number.isFinite(entry.pagesToRead) ? entry.pagesToRead : null;
  const page = entry.status === 'reading' && total ? `, page ${Math.min(entry.pagesDone + 1, total)} of ${total}` : '';
  const left = formatTimeLeft(secondsLeft([entry]));
  return `Reading the text of "${filename}"${page}${left ? `, ${left} left` : ''}…`;
}
