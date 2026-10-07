/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * ocrAuto.js
 * The automatic half of OCR: checked per file the moment it is added, in the background, so by the time someone has
 * finished reviewing and reordering their documents, a scanned page already added is searchable with no button
 * pressed. On by default (config-ocrAutoDetect, ocr.autoDetect), with Force OCR (ocrForce.js) as the
 * always-available override for a bad automatic call in either direction.
 *
 * ONE DOCUMENT AT A TIME. Each added document is first checked for pages without text of their own (pagesToRead:
 * quick, no engine), one check at a time and straight away, so the page knows early how much there is to read. A
 * document with pages to read then waits its turn in a queue, and documents are read one at a time, in the order
 * they were added: one engine and one document's pages in memory at once, and page times that are not two readings
 * slowing each other down. Every step is reported to ocrReading.js, which the row badge, the totals line and the
 * question Create Bundle asks all read.
 *
 * SKIP. A row being read (or waiting) has a Skip button (ocrReading.js's skipReading): it stops that document's
 * reading at once, leaves its file as it was, and the queue moves on to the next. Removing a document, clearing the
 * table or opening another bundle stops its reading the same way.
 *
 * Quiet on failure: this is a background enhancement on a file that already validated and added successfully, so
 * an OCR failure here must never surface a modal over whatever the person is doing with an unrelated document.
 * hideProcessingOverlay is never called either, for the same reason: this never shows one.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { ocrDocument, pagesToRead, OcrStopped } from './bundletoolOcrDocument.js';
import { noticeSkippedOcrPages } from './ocrNotice.js';
import { setOcrBadge } from './fileRows.js';
import { reorientChoice, noteReoriented } from './ocrReorient.js';
import { trackReading, readingQueued, readingBegun, readingStarted, pageRead, finishReading } from './ocrReading.js';

function autoDetectEnabled() {
  return document.getElementById('config-ocrAutoDetect')?.checked ?? true;
}

/** The check and the reader: bundletoolOcrDocument.js's, unless a test puts its own in their place. */
export const autoReader = { pagesToRead, ocrDocument };

/** Filenames checked and waiting to be read, in the order they were added. */
const queue = [];
let reading = false;
let checks = Promise.resolve();

/** The document no longer needs reading on a later visit: read, found to need nothing, or failed. */
function notPending(filename) {
  const info = state.frontendInputData[filename];
  if (info) delete info.ocrPending;
}

/**
 * Starts the automatic check for a document just added (or brought back unread): does not block the caller (the
 * file-add loop), and never throws.
 * @param {string} filename
 */
export function scheduleAutoOcr(filename) {
  if (!autoDetectEnabled()) return;
  const file = state.filesMap.get(filename);
  if (!file) return;
  // Kept on the document's own entry, so a session saved before its reading finished reads it again when restored.
  const info = state.frontendInputData[filename];
  if (info) info.ocrPending = true;
  const entry = trackReading(filename, { status: 'checking', source: 'auto', controller: new AbortController() });
  checks = checks.then(() => check(filename, file, entry));
}

/** The quick check: which pages need reading. None means the document is done with and nothing was ever shown. */
async function check(filename, file, entry) {
  if (state.ocrReading.get(filename) !== entry) return;
  try {
    const targets = await autoReader.pagesToRead(new Uint8Array(await file.arrayBuffer()));
    if (state.ocrReading.get(filename) !== entry) return;
    if (state.filesMap.get(filename) !== file) { again(filename, entry); return; }
    if (targets.length === 0) {
      notPending(filename);
      finishReading(filename);
      markDirty();
      return;
    }
    entry.targets = targets;
    readingQueued(filename, targets.length);
    queue.push(filename);
    pump();
  } catch (error) {
    // No document name in a console message that outlives the page on a shared machine
    // (tests/policy.test.mjs enforces this repo-wide).
    console.warn('[ocr] automatic check failed for one document:', error);
    if (state.ocrReading.get(filename) === entry) {
      notPending(filename);
      finishReading(filename, { counted: false });
    }
  }
}

/** The file changed while it was checked or read (turned, a page removed): its reading starts again on the new bytes. */
function again(filename, entry) {
  if (state.ocrReading.get(filename) !== entry) return;
  finishReading(filename, { counted: false });
  if (state.filesMap.has(filename) && !state.frontendInputData[filename]?.ocrSkipped) scheduleAutoOcr(filename);
}

/** Reads the queue, one document at a time, until it is empty. */
async function pump() {
  if (reading) return;
  reading = true;
  try {
    while (queue.length) {
      const filename = queue.shift();
      const entry = state.ocrReading.get(filename);
      if (!entry || entry.status !== 'waiting' || entry.source !== 'auto') continue;
      await readOne(filename, entry);
    }
  } finally {
    reading = false;
  }
}

async function readOne(filename, entry) {
  const file = state.filesMap.get(filename);
  if (!file) { finishReading(filename, { counted: false }); return; }
  readingBegun(filename);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await autoReader.ocrDocument(bytes, { force: false, targets: entry.targets, signal: entry.controller.signal, reorient: reorientChoice(filename),
      onStart: (total) => readingStarted(filename, total),
      onPage: (done, total) => pageRead(filename, done, total),
    });
    // Skipped or removed while it ran: its entry is gone and nothing it read is written.
    if (state.ocrReading.get(filename) !== entry) return;
    // The file was replaced (rotated, a page removed) while this ran: read the new one instead.
    if (state.filesMap.get(filename) !== file) { again(filename, entry); return; }
    if (result) {
      noticeSkippedOcrPages(filename, result.skippedPages);
      if (result.bytes) {
        state.filesMap.set(filename, new File([result.bytes], filename, { type: 'application/pdf' }));
        if (state.frontendInputData[filename]) state.frontendInputData[filename].ocrApplied = true;
        noteReoriented(filename, result.reoriented);
        setOcrBadge(filename);
      }
    }
    notPending(filename);
    finishReading(filename);
    markDirty();
  } catch (error) {
    if (error instanceof OcrStopped) return;
    // No document name in a console message that outlives the page on a shared machine
    // (tests/policy.test.mjs enforces this repo-wide): the row itself, not the console, is
    // where a person finds out which file this was about.
    console.warn('[ocr] automatic check failed for one document:', error);
    if (state.ocrReading.get(filename) === entry) {
      notPending(filename);
      finishReading(filename);
      markDirty();
    }
  }
}

/**
 * After a saved session is brought back: the documents whose reading had not finished when it was saved (and that
 * nobody skipped) are checked and read again, as if just added.
 */
export function resumeUnfinishedReading() {
  for (const [filename, info] of Object.entries(state.frontendInputData)) {
    if (info?.ocrPending && !info.ocrSkipped && state.filesMap.has(filename) && !state.ocrReading.has(filename)) {
      scheduleAutoOcr(filename);
    }
  }
}

/** Resolves once every check started so far has run and the reading queue is empty. */
export async function whenAutoReadingIdle() {
  for (;;) {
    await checks;
    if (!reading && queue.length === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}
