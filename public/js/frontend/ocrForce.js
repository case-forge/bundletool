/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * ocrForce.js
 * "Force OCR" for one document in the Review Table: the override for when the
 * automatic per-page check skips a page that genuinely needs OCR, or for
 * someone who simply wants to be sure. Every page is OCR'd, not just the ones
 * needsOcr() would flag, which is the whole point of a manual override.
 *
 * Run from the document window (rotate.js), which shows the progress this
 * reports. Loaded on first use, and writes back to the stored file only.
 *
 * It reports to ocrReading.js as the automatic check does, so while it runs the
 * row says "Reading text…" with its Skip button, the totals line counts it, and
 * Create Bundle asks before building without it. It starts at once rather than
 * waiting its turn in the automatic queue (it was asked for), and an automatic
 * reading of the same document stops first: this reads every page anyway.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { showErrorModal } from './modals.js';
import { ocrDocument, OcrStopped } from './bundletoolOcrDocument.js';
import { setOcrBadge } from './fileRows.js';
import { noticeSkippedOcrPages } from './ocrNotice.js';
import { reorientChoice, noteReoriented } from './ocrReorient.js';
import { stopReading, trackReading, readingStarted, pageRead, finishReading } from './ocrReading.js';

/**
 * @param {string} filename
 * @param {HTMLElement} opener - the button that asked for it, refocused on completion or error
 * @param {{onProgress?: (text: string) => void, ocr?: typeof ocrDocument}} [opts]
 *   onProgress: told what is happening, page by page, for the caller to show.
 *   ocr: the OCR run itself, ocrDocument unless a test passes its own.
 * @returns {Promise<boolean>} whether a text layer was written to the stored file
 */
export async function forceOcr(filename, opener, { onProgress = () => {}, ocr = ocrDocument } = {}) {
  const file = state.filesMap.get(filename);
  if (!file) return false;
  let written = false;
  stopReading(filename);
  const controller = new AbortController();
  const entry = trackReading(filename, {
    status: 'reading', source: 'force', controller,
    pagesToRead: state.frontendInputData[filename]?.pageCount ?? null,
  });
  onProgress('Reading text…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ocr(bytes, {
      force: true,
      signal: controller.signal,
      reorient: reorientChoice(filename),
      onStart: (total) => readingStarted(filename, total),
      onPage: (done, total) => { pageRead(filename, done, total); onProgress(`Reading text… page ${done} of ${total}`); },
    });
    if (state.ocrReading.get(filename) !== entry) return false; // skipped from its row while it ran
    if (!state.filesMap.has(filename)) return false; // removed while OCR was running
    if (result?.bytes) {
      state.filesMap.set(filename, new File([result.bytes], filename, { type: 'application/pdf' }));
      if (state.frontendInputData[filename]) state.frontendInputData[filename].ocrApplied = true;
      const info = state.frontendInputData[filename];
      if (info) { delete info.ocrSkipped; delete info.ocrPending; }
      noteReoriented(filename, result.reoriented);
      finishReading(filename);
      setOcrBadge(filename);
      markDirty({ immediate: true });
      written = true;
    }
    noticeSkippedOcrPages(filename, result?.skippedPages);
  } catch (error) {
    if (!(error instanceof OcrStopped)) {
      showErrorModal({
        code: 'BT-OCR-02',
        title: 'Could not read the text in this document',
        message: `"${filename}" was left exactly as it was.`,
        error,
      });
    }
  } finally {
    if (state.ocrReading.get(filename) === entry) finishReading(filename);
    opener?.focus?.({ preventScroll: true });
  }
  return written;
}
