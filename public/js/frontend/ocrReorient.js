/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * ocrReorient.js
 * The browser's side of the two optional OCR settings, Turn sideways scanned pages upright (config-ocrTurnUpright,
 * ocr.turnUpright) and Straighten tilted scanned pages (config-ocrStraighten, ocr.straighten): what they are set to
 * when a document is read, what reading changed, and what the page shows for it. Both the automatic check
 * (ocrAuto.js) and Force OCR (ocrForce.js) read the settings and keep the record here, the document window
 * (rotate.js) shows the sideways note, and the Review Table's OCR badge (fileRows.js) says what changed. The pages
 * themselves are changed in bundletoolOcrReorient.js, the same code the command line runs.
 */
import { state } from './state.js';

/**
 * The two settings as they stand in Advanced Settings now (both off when the controls are missing), and the pages of
 * this document the person put back as scanned, which are never straightened again.
 *
 * @param {string} [filename]
 */
export function reorientChoice(filename) {
  return {
    turnUpright: document.getElementById('config-ocrTurnUpright')?.checked === true,
    straighten: document.getElementById('config-ocrStraighten')?.checked === true,
    keepAsScanned: [...(state.frontendInputData[filename]?.ocrPages?.putBack ?? [])],
  };
}

/**
 * Keeps what reading changed on the document's own entry: `ocrPages` holds the record (pages turned, straightened,
 * left tilted for their annotations, found sideways with turning off, put back as scanned). A page turned or
 * straightened means the document's bytes now differ from the file as added, so `pagesChanged` is set, the flag the
 * document window sets when it turns or removes a page.
 *
 * A reading adds to what earlier readings changed rather than replacing it: a page straightened once stays
 * straightened, and can still be put back, when Force OCR reads the now-level page again. What a reading only found
 * (sideways pages, pages left tilted) is this reading's alone.
 *
 * @param {string} filename
 * @param {ReturnType<import('../bundletoolOcrReorient.js').reorientRecord>|undefined} reoriented
 */
export function noteReoriented(filename, reoriented) {
  const entry = state.frontendInputData[filename];
  if (!entry || !reoriented) return;
  const before = entry.ocrPages;
  const turnedNow = new Set(reoriented.turned.map(([page]) => page));
  entry.ocrPages = {
    ...reoriented,
    turned: [...(before?.turned ?? []).filter(([page]) => !turnedNow.has(page)), ...reoriented.turned],
    straightened: [...(before?.straightened ?? []), ...reoriented.straightened],
    putBack: [...(before?.putBack ?? [])],
  };
  if (reoriented.turned.length || reoriented.straightened.length) entry.pagesChanged = true;
}

const norm = (degrees) => (((degrees % 360) + 360) % 360);

/**
 * A check for the document window's note line (PAGE_NOTE_CHECKS in rotate.js): "This page looks sideways." (or
 * "upside down") on a page that reading found turned, while turning upright was off. The page is judged as it is shown,
 * its own /Rotate and any turn waiting to be confirmed included, so a page the person has turned the right way says
 * nothing. Information only.
 *
 * @param {{filename: string, pageNum: number, rotation: number}} shown - rotation: degrees clockwise, as drawn
 * @returns {string|null}
 */
export function sidewaysPageNote({ filename, pageNum, rotation }) {
  const entry = state.frontendInputData[filename]?.ocrPages?.sideways?.find(([page]) => page === pageNum);
  if (!entry || !Number.isFinite(rotation)) return null;
  const [, turn, rotateWhenRead = 0] = entry;
  // The page needed `turn` counter-clockwise beyond the /Rotate it was read at; every clockwise degree it is shown at
  // beyond that adds one to what is still needed.
  const left = norm(turn + rotation - rotateWhenRead);
  if (left === 0) return null;
  return left === 180 ? 'This page looks upside down.' : 'This page looks sideways.';
}

/** "Turned upright by the setting." on a page Turn sideways scanned pages upright turned (the window's own turn buttons
 * put it back). A check for PAGE_NOTE_CHECKS in rotate.js. */
export function turnedPageNote({ filename, pageNum }) {
  const turned = state.frontendInputData[filename]?.ocrPages?.turned ?? [];
  return turned.some(([page]) => page === pageNum) ? 'Turned upright by the setting.' : null;
}

/** The straightenings of one page still in place: [page number, degrees, centre x, centre y], in the order made. */
export function straightenedEntries(filename, pageNum) {
  return (state.frontendInputData[filename]?.ocrPages?.straightened ?? []).filter(([page]) => page === pageNum);
}

/** "Straightened by 2.4 degrees." on a page Straighten tilted scanned pages turned level, and "Put back as scanned."
 * on one the person put back. A check for PAGE_NOTE_CHECKS in rotate.js; the window shows the button beside it. */
export function straightenedPageNote({ filename, pageNum }) {
  const entries = straightenedEntries(filename, pageNum);
  if (entries.length) {
    const angle = Math.abs(entries.reduce((sum, [, tilt]) => sum + tilt, 0));
    return `Straightened by ${angle.toFixed(1)} degrees.`;
  }
  return state.frontendInputData[filename]?.ocrPages?.putBack?.includes(pageNum) ? 'Put back as scanned.' : null;
}

/**
 * Notes that a page was put back as scanned: its straightenings leave the record (the content is as scanned again)
 * and the page joins `putBack`, which later readings of the document leave unstraightened (reorientChoice). The
 * document stays marked as changed.
 */
export function recordPutBack(filename, pageNum) {
  const entry = state.frontendInputData[filename];
  if (!entry?.ocrPages) return;
  entry.ocrPages.straightened = (entry.ocrPages.straightened ?? []).filter(([page]) => page !== pageNum);
  entry.ocrPages.putBack = [...new Set([...(entry.ocrPages.putBack ?? []), pageNum])].sort((a, b) => a - b);
  entry.pagesChanged = true;
}

/**
 * Keeps the record in step when the document window removes a page: the page's own entries go, and the pages after
 * it move up one.
 *
 * @param {string} filename
 * @param {number} pageNum - 1-based, the page removed
 */
export function forgetRemovedPage(filename, pageNum) {
  const record = state.frontendInputData[filename]?.ocrPages;
  if (!record) return;
  const move = (n) => (n > pageNum ? n - 1 : n);
  for (const key of ['turned', 'straightened', 'sideways']) {
    record[key] = (record[key] ?? []).filter(([n]) => n !== pageNum).map(([n, ...rest]) => [move(n), ...rest]);
  }
  for (const key of ['notStraightened', 'putBack']) record[key] = (record[key] ?? []).filter((n) => n !== pageNum).map(move);
}

/** The OCR badge's tooltip when reading changed nothing about how the document looks. */
export const OCR_BADGE_TITLE = 'This document\'s text is selectable and searchable (OCR applied).';

/**
 * The OCR badge's tooltip: OCR_BADGE_TITLE, and, when reading also turned pages upright or straightened them, which
 * ones.
 *
 * @param {{ocrPages?: ReturnType<import('../bundletoolOcrReorient.js').reorientRecord>}|undefined} info
 */
export function ocrBadgeTitle(info) {
  const turned = info?.ocrPages?.turned ?? [];
  const straightened = [...new Map((info?.ocrPages?.straightened ?? []).map((e) => [e[0], e])).values()];
  const putBack = (info?.ocrPages?.putBack ?? []).map((page) => [page]);
  if (!turned.length && !straightened.length && !putBack.length) return OCR_BADGE_TITLE;
  const pages = (list) => {
    const n = list.map(([page]) => page);
    if (n.length === 1) return `page ${n[0]}`;
    if (n.length <= 5) return `pages ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
    return `${n.length} pages`;
  };
  const parts = [];
  if (turned.length) parts.push(`${pages(turned)} turned upright`);
  if (straightened.length) parts.push(`${pages(straightened)} straightened`);
  if (putBack.length) parts.push(`${pages(putBack)} put back as scanned`);
  return `${OCR_BADGE_TITLE} Reading it also changed how it looks: ${parts.join('; ')}.`;
}
