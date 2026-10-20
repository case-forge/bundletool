/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * ocrWait.js
 * Create Bundle while text is still being read. A bundle built then would lack the text layer of every document not
 * yet read, with nothing to say so, so before building it asks, one document at a time, about the one being read
 * now: its name and, once a page has been timed, about how long it has left (#ocr-wait-modal).
 *
 *   Wait                waits for that document, showing its progress, with Cancel; once it is read, the next
 *                       document still to read is asked about, or the build starts when none is left
 *   Skip this document  stops reading that document (its file stays as it is, without searchable text) and asks
 *                       about the next one, if any is left
 *   Cancel              builds nothing (Escape is Cancel)
 *
 * A document that finishes while the question is open is answered for: the question moves to the next one, or
 * closes and the build starts. Documents still being checked (most need nothing read) are waited for quietly first,
 * with Cancel, so one with pages to read is never missed.
 */
import { state } from './state.js';
import { showProcessingOverlay, hideProcessingOverlay } from './bundleUI.js';
import {
  documentToAskAbout, readingQuestionText, readingWaitText, whenFinished, skipReading, onReadingChange, nextReadingChange,
} from './ocrReading.js';

/**
 * Asks about one document. Resolves 'wait', 'skip' or 'cancel', or 'gone' when it finished while the question was
 * open. With no dialog in the page (a test), it waits.
 * @param {string} filename
 * @returns {Promise<'wait'|'skip'|'cancel'|'gone'>}
 */
export function askAboutDocument(filename) {
  const modal = document.getElementById('ocr-wait-modal');
  const msg = document.getElementById('ocr-wait-msg');
  const waitBtn = document.getElementById('ocr-wait-wait');
  const skipBtn = document.getElementById('ocr-wait-skip');
  const cancelBtn = document.getElementById('ocr-wait-cancel');
  if (!modal || !waitBtn || !skipBtn || !cancelBtn) return Promise.resolve('wait');
  const show = () => { if (msg) { const text = readingQuestionText(filename); if (msg.textContent !== text) msg.textContent = text; } };
  show();
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    let stopListening = () => {};
    const finish = (answer) => {
      stopListening();
      modal.classList.add('hidden');
      waitBtn.removeEventListener('click', onWait);
      skipBtn.removeEventListener('click', onSkip);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(answer);
    };
    const onWait = () => finish('wait');
    const onSkip = () => finish('skip');
    const onCancel = () => finish('cancel');
    waitBtn.addEventListener('click', onWait);
    skipBtn.addEventListener('click', onSkip);
    cancelBtn.addEventListener('click', onCancel);
    // Kept up to date while it is open: the estimate counts down, and a document read meanwhile is answered for.
    stopListening = onReadingChange(() => {
      if (!state.ocrReading.has(filename)) finish('gone');
      else show();
    });
  });
}

/**
 * Waits until `ready()` resolves, with the processing overlay saying `text()` (kept up to date) and its Cancel
 * button. Resolves true when ready, false when cancelled.
 */
function waitWithProgress(ready, text) {
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = () => resolve(false); });
  const say = () => showProcessingOverlay(text());
  say();
  const cancelBtn = document.getElementById('processing-cancel-btn');
  cancelBtn?.classList.remove('hidden');
  // The overlay's Cancel calls state._cancelReject (bundleGeneration.js setup), as it does during a build.
  state._cancelReject = () => cancel();
  const stopListening = onReadingChange(say);
  return Promise.race([ready().then(() => true), cancelled]).finally(() => {
    stopListening();
    state._cancelReject = null;
    cancelBtn?.classList.add('hidden');
    hideProcessingOverlay();
  });
}

/** Waits for one document's reading, showing which page it is on and the time left. False when cancelled. */
export function waitForDocument(filename) {
  return waitWithProgress(() => whenFinished(filename), () => readingWaitText(filename));
}

/** Waits while documents are only being checked, until one turns out to need reading or none is left. False when
 * cancelled. */
function waitForChecks() {
  const ready = async () => {
    while (state.ocrReading.size > 0 && documentToAskAbout() === null) await nextReadingChange();
  };
  return waitWithProgress(ready, () => 'Checking the documents for pages to read…');
}

/**
 * Settles every document still being read before a build: asks, waits or skips, one document at a time.
 * @param {{ask?: typeof askAboutDocument, wait?: typeof waitForDocument, checks?: () => Promise<boolean>}} [opts]
 *   the three steps, for a test to replace
 * @returns {Promise<boolean>} true to build now (nothing is left to read), false when the person cancelled
 */
export async function settleReadingBeforeBuild({ ask = askAboutDocument, wait = waitForDocument, checks = waitForChecks } = {}) {
  for (;;) {
    const filename = documentToAskAbout();
    if (!filename) {
      if (state.ocrReading.size === 0) return true;
      if (!(await checks())) return false;
      continue;
    }
    const answer = await ask(filename);
    if (answer === 'cancel') return false;
    if (answer === 'skip') skipReading(filename);
    else if (answer === 'wait' && !(await wait(filename))) return false;
  }
}
