/**
 * splitMerge.js
 * "Split" and "Merge" in the document window (rotate.js): cut one Review Table document in two, and join one to the
 * document directly below it.
 *
 * Both are page-range work over whole documents, never page editing. A split keeps the pages up to the cut in the
 * document and puts the rest into a new document, which gets its own row straight under the first. A merge is the
 * opposite: the document below is added on after this one and its row goes. Split and then Merge gives back what you
 * started with.
 *
 * Neither document is copied from the other: each half of a split is made with removePdfPages (bundletoolPages.js),
 * the same call as Remove page, so nothing of the other half is left in either file; a merge copies pages in with
 * joinPdfs (bundletoolMerge.js), cleaned the way a bundle build cleans them. Everything else sees ordinary documents,
 * so the index, bookmarks, page numbers, autosave and restore need nothing of their own.
 *
 * Loaded on first use, like rotate.js, which is the only thing that calls it.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { lazyImport } from '/js/shared/lazy-load.js';
import { makeFileRow } from './fileRows.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { uniqueFilename } from './utils.js';
import { safeFileName } from './fileGate.js';
import { stopReading } from './ocrReading.js';
import { scheduleAutoOcr } from './ocrAuto.js';
import { splitOcrRecord, joinOcrRecords } from './ocrReorient.js';
import { MAX_DOCUMENTS } from './limits.js';

const pagesModule = () => lazyImport(new URL('../bundletoolPages.js', import.meta.url));
const mergeModule = () => lazyImport(new URL('../bundletoolMerge.js', import.meta.url));

const rowFor = (filename) => document.querySelector(`tr.file-row[data-filename="${CSS.escape(filename)}"]`);

/** The row directly below this document's, in the same section; null when there is none. */
function rowBelow(filename) {
  const next = rowFor(filename)?.nextElementSibling;
  return next?.classList?.contains('file-row') && state.filesMap.has(next.dataset.filename) ? next : null;
}

/** The document whose row is directly below this one's, in the same section; null when there is none. */
export function documentBelow(filename) {
  return rowBelow(filename)?.dataset.filename ?? null;
}

/**
 * The row's page count and its badges (recovered, converted, OCR, redaction), from what the document now holds. The
 * badges are drawn by makeFileRow, so a row made here and a row changed here read the same.
 */
function showRowFacts(filename, facts) {
  const row = rowFor(filename);
  const info = state.frontendInputData[filename];
  if (!row || !info) return;
  const cell = row.querySelector('.pages-cell');
  if (cell) cell.textContent = String(facts.pageCount);
  const names = row.querySelector('.filename-cell');
  const fresh = makeFileRow(filename, { ...info, pageCount: facts.pageCount, redactedPages: facts.redactedPages });
  for (const badge of [...names.querySelectorAll('span')]) badge.remove();
  for (const badge of [...fresh.querySelector('.filename-cell').querySelectorAll('span')]) names.appendChild(badge);
}

/** Puts new bytes in a stored file's place, marked as a document whose pages BundleTool changed. */
function store(filename, bytes, info) {
  state.filesMap.set(filename, new File([bytes], filename, { type: 'application/pdf' }));
  info.pagesChanged = true;
}

/** "name (pages 4-31).pdf": the cut-off part's file name, unique among the stored files. */
function partName(filename, first, last) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '.pdf';
  const pages = first === last ? `page ${first}` : `pages ${first}-${last}`;
  return uniqueFilename(safeFileName(`${stem} (${pages})${ext}`), state.filesMap);
}

/**
 * Cuts a document after a page. `filename` keeps pages 1 to `afterPage`; the rest become a new document straight
 * under it, with the same title and date to be changed as needed.
 *
 * @param {string} filename  the key in state.filesMap
 * @param {number} afterPage  1-based, the last page `filename` keeps; at least 1 and less than its page count
 * @returns {Promise<{newFilename: string, kept: number, moved: number}|null>} null when the document went meanwhile
 */
export async function splitDocument(filename, afterPage) {
  const file = state.filesMap.get(filename);
  const info = state.frontendInputData[filename];
  const row = rowFor(filename);
  if (!file || !info || !row) return null;
  if (state.filesMap.size >= MAX_DOCUMENTS) {
    throw new Error(`A bundle holds up to ${MAX_DOCUMENTS.toLocaleString('en-GB')} documents and this one is full`);
  }
  const { removePdfPages, inspectPdf } = await pagesModule();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const count = (await inspectPdf(file)).pageCount;
  if (!Number.isInteger(afterPage) || afterPage < 1 || afterPage >= count) throw new Error('A split needs a page on each side of the cut');
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
  const first = await removePdfPages(bytes, range(afterPage, count));
  const second = await removePdfPages(bytes, range(0, afterPage));
  // A reading that is still running would write its result over the cut.
  stopReading(filename);
  if (state.filesMap.get(filename) !== file || rowFor(filename) !== row) return null;

  const newFilename = partName(filename, afterPage + 1, count);
  store(filename, first, info);
  const moved = { ...info };
  // What belongs to the document as a whole (its source file, the reading in progress) stays with the first part.
  for (const key of ['source', 'originalName', 'ocrPending', 'ocrPages', 'redactedPages']) delete moved[key];
  moved.title = info.title ? `${info.title} (${afterPage + 1}-${count})` : info.title;
  state.frontendInputData[newFilename] = moved;
  store(newFilename, second, moved);
  splitOcrRecord(filename, newFilename, afterPage);

  const [kept, rest] = await Promise.all([inspectPdf(state.filesMap.get(filename)), inspectPdf(state.filesMap.get(newFilename))]);
  info.pageCount = kept.pageCount;
  moved.pageCount = rest.pageCount;
  if (kept.redactedPages.length) info.redactedPages = kept.redactedPages; else delete info.redactedPages;
  if (rest.redactedPages.length) moved.redactedPages = rest.redactedPages;
  showRowFacts(filename, kept);

  const newRow = makeFileRow(newFilename, { ...moved, pageCount: rest.pageCount, redactedPages: rest.redactedPages });
  row.after(newRow);
  refreshBundleTotals();
  markDirty({ immediate: true });
  return { newFilename, kept: kept.pageCount, moved: rest.pageCount };
}

/**
 * Joins the document directly below onto the end of this one. This document keeps its file name, title and date; the
 * one below is gone from the bundle.
 *
 * @param {string} filename  the key in state.filesMap
 * @returns {Promise<{below: string, pageCount: number}|null>} null when either document went meanwhile
 */
export async function mergeWithBelow(filename) {
  const belowRow = rowBelow(filename);
  const below = belowRow?.dataset.filename ?? null;
  const file = state.filesMap.get(filename);
  const info = state.frontendInputData[filename];
  const belowFile = below && state.filesMap.get(below);
  const belowInfo = below && state.frontendInputData[below];
  if (!file || !info || !belowFile || !belowInfo) return null;
  const { joinPdfs } = await mergeModule();
  const { inspectPdf } = await pagesModule();
  const offset = (await inspectPdf(file)).pageCount;
  const out = await joinPdfs(new Uint8Array(await file.arrayBuffer()), new Uint8Array(await belowFile.arrayBuffer()));
  stopReading(filename);
  stopReading(below);
  if (state.filesMap.get(filename) !== file || state.filesMap.get(below) !== belowFile || rowBelow(filename) !== belowRow) return null;

  store(filename, out, info);
  joinOcrRecords(filename, below, offset);
  // Marked as read only when both were; the reading that follows skips the pages that already have text.
  const bothRead = info.ocrApplied && belowInfo.ocrApplied;
  if (!bothRead) delete info.ocrApplied;
  for (const key of ['convertedFromDocx', 'convertedFromImage']) if (belowInfo[key]) info[key] = belowInfo[key];
  if (belowInfo.recovered && !info.recovered) Object.assign(info, { recovered: true, recoveryNote: belowInfo.recoveryNote });
  state.filesMap.delete(below);
  delete state.frontendInputData[below];
  belowRow.remove();

  const facts = await inspectPdf(state.filesMap.get(filename));
  info.pageCount = facts.pageCount;
  if (facts.redactedPages.length) info.redactedPages = facts.redactedPages; else delete info.redactedPages;
  showRowFacts(filename, facts);
  refreshBundleTotals();
  markDirty({ immediate: true });
  if (!bothRead) scheduleAutoOcr(filename);
  return { below, pageCount: facts.pageCount };
}
