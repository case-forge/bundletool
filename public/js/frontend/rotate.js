/**
 * rotate.js
 * The document window for one Review Table row, opened by the row's eye.
 *
 * It shows the document one page at a time with pdf.js (the same engine and worker the coversheet preview uses):
 * previous and next, a page number to type, and the Left and Right arrow keys while the window has focus. Only the
 * page shown is drawn, and a page's render is freed when another page takes its place. The drawing and paging are
 * pageView.js, shared with the preview's pictures on a browser with no PDF viewer. From here the document can be
 * turned left or right and the turn confirmed with "Turn document", and its text read again with Force OCR. Nothing is
 * written until one of those says so: Cancel, Escape and the close cross leave the file exactly as it was.
 *
 * A line under the picture says what is worth knowing about the page shown, such as "This page looks blank" or "This
 * page looks sideways". It is information only: nothing is removed or changed because of a note (PAGE_NOTE_CHECKS).
 * On a page Straighten tilted scanned pages turned level, the note says by how much and "Put back as scanned" undoes it
 * for that page alone, exactly (putBackAsScanned in bundletoolOcrReorient.js), and later readings leave it as scanned.
 *
 * A turn applies to the page shown or to the whole document ("This page" or "Whole document"). A confirmed turn is
 * baked into the stored file (rotatePdfBytes in bundletoolPages.js adds it to each turned page's own
 * rotation), so the build, the page numbers, the Download button and the autosave all see one ordinary file. Force OCR
 * is ocrForce.js, reporting its progress here. A turn still waiting to be confirmed is written first, so the text is
 * read from the pages as they will stand, in the same order as the command line, which turns a file before reading it.
 *
 * "Remove this page" takes the page shown out of the document once the person confirms it, never the last page a
 * document has (removePdfPages in bundletoolPages.js, which leaves nothing of the page in the file). The row's page
 * count, the bundle total and the autosave follow the stored bytes; Cancel, Escape and the close cross before the
 * confirmation leave the file untouched.
 *
 * Loaded on first use (fileRows.js imports it lazily), so the page carries neither this nor pdf.js until somebody
 * opens a document.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { showErrorModal } from './modals.js';
import { showProcessingOverlay, hideProcessingOverlay } from './bundleUI.js';
import { PageView, wirePager } from './pageView.js';
import { pageInk } from '../bundletoolDeskew.js';
import { refreshBundleTotals } from './bundleTotals.js';
import {
  sidewaysPageNote, turnedPageNote, straightenedPageNote, straightenedEntries, recordPutBack, forgetRemovedPage,
} from './ocrReorient.js';
import { lazyImport } from '/js/shared/lazy-load.js';

/**
 * The open window: { filename, opener, forceOcr, view, busy, turn, pageTurns, scope }. `view` is the pageView.js view
 * that draws and pages the document (the page shown is view.pageNum of view.pageCount). `turn` is the turn waiting to
 * be confirmed for every page, in degrees clockwise; `pageTurns` holds a turn for single pages on top of it (page
 * number to degrees), and `scope` is what the turn buttons turn: 'page' (the page shown) or 'document'.
 */
let session = null;

const $ = (id) => document.getElementById(id);

const pagesModule = () => lazyImport(new URL('../bundletoolPages.js', import.meta.url));

/** The Force OCR run, loaded on first use like this window itself. */
async function runOcrForceModule(...args) {
  const { forceOcr } = await lazyImport(new URL('./ocrForce.js', import.meta.url));
  return forceOcr(...args);
}

const norm = (degrees) => (((degrees % 360) + 360) % 360);

// ─── The turn waiting to be confirmed ───────────────────────────────────────────

/** The turn the preview shows for one page, on top of the page's own rotation. */
function pendingTurn(s, pageNum) {
  return norm(s.turn + (s.pageTurns.get(pageNum) || 0));
}

function hasPendingTurn(s) {
  return s.turn !== 0 || [...s.pageTurns.values()].some(Boolean);
}

function clearPendingTurn(s) {
  s.turn = 0;
  s.pageTurns.clear();
}

/**
 * The turn as steps for bakeTurn: the whole document's turn, then one step for each turn single pages take (with
 * those pages, counted from 0).
 */
function turnPlan(s) {
  const byTurn = new Map();
  for (const [pageNum, turn] of s.pageTurns) {
    if (turn) byTurn.set(turn, [...(byTurn.get(turn) || []), pageNum - 1]);
  }
  return [{ turn: s.turn }, ...[...byTurn].map(([turn, pages]) => ({ turn, pages }))];
}

/** Writes a turn plan into a copy of the document's bytes. */
async function bakeTurn(bytes, plan) {
  const { rotatePdfBytes } = await pagesModule();
  let out = bytes;
  for (const step of plan) {
    if (step.turn) out = await rotatePdfBytes(out, step.turn, step.pages);
  }
  return out;
}

/** What a screen reader hears after a turn: the preview itself is a picture. */
function turnStatus(s) {
  const t = pendingTurn(s, s.view.pageNum);
  const what = s.scope === 'page' ? 'This page turned' : 'Turned';
  return t === 0 ? 'Not turned' : `${what} ${t === 90 ? 'right' : t === 270 ? 'left' : 'upside down'}, ${t} degrees`;
}

function turnBy(delta) {
  const s = session;
  if (!s || s.busy) return;
  const pageNum = s.view.pageNum;
  if (s.scope === 'page') s.pageTurns.set(pageNum, norm((s.pageTurns.get(pageNum) || 0) + delta));
  else s.turn = norm(s.turn + delta);
  showTurn(s);
  s.view.draw();
}

/**
 * "This page" or "Whole document": the turn the page in view shows goes to that page alone, or to every page, and
 * the turn buttons turn the same from then on.
 */
function setScope(scope) {
  const s = session;
  if (!s || s.scope === scope) return;
  const shown = pendingTurn(s, s.view.pageNum);
  s.scope = scope;
  s.pageTurns.clear();
  s.turn = scope === 'document' ? shown : 0;
  if (scope === 'page' && shown) s.pageTurns.set(s.view.pageNum, shown);
  showTurn(s);
  s.view.draw();
}

/** "Turn document", or "Turn page" and "Turn pages" when only single pages are turned. */
function applyLabel(s) {
  const pages = [...s.pageTurns.values()].filter(Boolean).length;
  if (s.turn !== 0 || pages === 0) return 'Turn document';
  return pages === 1 ? 'Turn page' : 'Turn pages';
}

/** The confirm button, the note beside Force OCR and the spoken status follow the turn waiting to be confirmed. */
function showTurn(s) {
  const pending = hasPendingTurn(s);
  $('rotate-apply').disabled = s.busy || !pending;
  $('rotate-apply').textContent = applyLabel(s);
  $('rotate-ocr-note').classList.toggle('hidden', !pending);
  const status = $('rotate-status');
  if (status) status.textContent = turnStatus(s);
}

// ─── The page shown ─────────────────────────────────────────────────────────────

const VIEW_IDS = {
  canvas: 'rotate-preview', stage: 'rotate-stage', noPreview: 'rotate-no-preview',
  prev: 'rotate-prev', next: 'rotate-next', input: 'rotate-page-input', count: 'rotate-page-count',
};

/**
 * The view for one open of the window: pageView.js draws and pages the document; this window turns the page shown by
 * the turn waiting to be confirmed, and adds its notes and its own buttons.
 */
function makeView(s, bytes, pageCount) {
  return new PageView(VIEW_IDS, {
    bytes, pageCount, label: 'rotate',
    // A file that unpacks to gigabytes (see findExpandingStreams) would crash the tab when drawn.
    switchedOff: Boolean(state.frontendInputData[s.filename]?.expanding),
    turn: (pageNum) => pendingTurn(s, pageNum),
    onPager: () => { if (session === s) afterPager(s); },
    onClear: () => { if (session === s) setPageNote(''); },
    onDrawn: ({ token, canvas, rotation }) => showPageNotes(s, token, canvas, rotation),
  });
}

/** What follows "Page n of N" in this window: the remove question closes, and Remove and Put back follow the page. */
function afterPager(s) {
  hideRemoveQuestion();
  showRemove(s);
  showPutBack(s);
}

// ─── Notes on the page shown ────────────────────────────────────────────────────

/**
 * The checks run on each page once it is drawn, each giving a short note for the line under the picture, or nothing.
 * A check is given { filename, pageNum, page, rotation, canvas, pixels }: page is pdf.js's, rotation the clockwise
 * turn the page is drawn at (its own /Rotate and any turn waiting to be confirmed), and pixels() reads the drawn
 * picture once however many checks ask for it. The notes show in this order on the one line. Notes are information
 * only: nothing about the document changes because of one, and a check that fails says nothing. The sideways,
 * turned and straightened notes (ocrReorient.js) come from what OCR found and changed when it read the document.
 */
const PAGE_NOTE_CHECKS = [blankPageNote, sidewaysPageNote, turnedPageNote, straightenedPageNote];

/** Adds a check to the line under the picture. */
export function addPageNoteCheck(check) {
  PAGE_NOTE_CHECKS.push(check);
}

/** "This page looks blank", from the share of ink in the picture just drawn (pageInk in bundletoolDeskew.js). */
function blankPageNote({ pixels }) {
  const { data, width, height } = pixels();
  return pageInk(data, width, height).blank ? 'This page looks blank.' : null;
}

function setPageNote(text) {
  const line = $('rotate-page-note');
  line.textContent = text;
  line.classList.toggle('hidden', !text);
}

async function showPageNotes(s, token, canvas, rotation) {
  let image = null;
  const drawn = {
    filename: s.filename,
    pageNum: s.view.pageNum,
    page: s.view.page,
    rotation,
    canvas,
    pixels: () => (image ??= canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)),
  };
  const notes = [];
  for (const check of PAGE_NOTE_CHECKS) {
    try {
      const note = await check(drawn);
      if (note) notes.push(note);
    } catch { /* information only: a check that cannot run gives no note */ }
  }
  if (session === s && s.view.current(token)) {
    setPageNote(notes.join(' '));
    showPutBack(s);
  }
}

// ─── Writing to the stored file ─────────────────────────────────────────────────

/** While Force OCR or another write runs, the buttons that would start another are off. */
function setBusy(s, busy) {
  s.busy = busy;
  for (const id of ['rotate-left', 'rotate-right', 'rotate-ocr']) $(id).disabled = busy;
  showRemove(s);
  showTurn(s);
  showPutBack(s);
}

/**
 * Puts new bytes in the stored file's place and saves. The document is marked as one whose pages BundleTool changed,
 * so the Download button's "Only documents BundleTool changed" finds it.
 */
function storeChangedFile(filename, bytes) {
  state.filesMap.set(filename, new File([bytes], filename, { type: 'application/pdf' }));
  if (state.frontendInputData[filename]) state.frontendInputData[filename].pagesChanged = true;
  markDirty({ immediate: true });
}

/** Writes the turn waiting to be confirmed into the stored file, for an action that has to start from it. */
async function writePendingTurn(s) {
  if (!hasPendingTurn(s)) return;
  const file = state.filesMap.get(s.filename);
  if (!file) return;
  const out = await bakeTurn(new Uint8Array(await file.arrayBuffer()), turnPlan(s));
  if (!state.filesMap.has(s.filename)) return;
  storeChangedFile(s.filename, out);
  clearPendingTurn(s);
  showTurn(s);
}

/** Shows the stored file again after a write changed it, on the same page where there still is one. */
async function reloadFromStore(s) {
  const file = state.filesMap.get(s.filename);
  if (!file || session !== s) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (session !== s) return;
  s.view.replace(bytes, state.frontendInputData[s.filename]?.pageCount || s.view.pageCount);
}

/** A plain line in the window saying what has happened, or what is happening. */
function say(s, text) {
  if (session === s) $('rotate-message').textContent = text;
}

async function runForceOcr() {
  const s = session;
  if (!s || s.busy) return;
  setBusy(s, true);
  try {
    if (hasPendingTurn(s)) {
      say(s, 'Turning the document first…');
      try {
        await writePendingTurn(s);
      } catch (error) {
        say(s, '');
        showErrorModal({ code: 'BT-VIEW-02', title: 'Could not rotate this document', message: `"${s.filename}" could not be turned, so its text was not read and it was left as it was.`, error });
        return;
      }
    }
    const written = await s.forceOcr(s.filename, $('rotate-ocr'), { onProgress: (text) => say(s, text) });
    say(s, written ? 'Text read: it can now be selected and searched.' : '');
    if (written) await reloadFromStore(s);
  } finally {
    if (session === s) setBusy(s, false);
  }
}

// ─── Putting a straightened page back as scanned ────────────────────────────────

/** "Put back as scanned" shows on a page the setting straightened, and is off while something is written. */
function showPutBack(s) {
  const button = $('rotate-putback');
  if (!button) return;
  $('rotate-putback-row').classList.toggle('hidden', straightenedEntries(s.filename, s.view.pageNum).length === 0);
  button.disabled = s.busy;
}

/** Undoes the straightening of the page shown, and only that page: see putBackAsScanned in bundletoolOcrReorient.js. */
async function putBackShownPage() {
  const s = session;
  if (!s || s.busy) return;
  const pageNum = s.view.pageNum;
  const entries = straightenedEntries(s.filename, pageNum);
  if (!entries.length) return;
  setBusy(s, true);
  try {
    await writePendingTurn(s);
    const file = state.filesMap.get(s.filename);
    if (!file) return;
    const [{ putBackAsScanned }, { loadPdf }] = await Promise.all([
      lazyImport(new URL('../bundletoolOcrReorient.js', import.meta.url)),
      lazyImport(new URL('../bundletoolPdfLoad.js', import.meta.url)),
    ]);
    const { doc } = await loadPdf(new Uint8Array(await file.arrayBuffer()));
    if (!putBackAsScanned(doc.getPage(pageNum - 1))) throw new Error('no straightening found on the page');
    const out = await doc.save();
    if (!state.filesMap.has(s.filename)) return;
    storeChangedFile(s.filename, out);
    recordPutBack(s.filename, pageNum);
    if (session !== s) return;
    say(s, `Page ${pageNum} put back as scanned.`);
    await reloadFromStore(s);
  } catch (error) {
    showErrorModal({ code: 'BT-VIEW-05', title: 'Could not put the page back', message: `Page ${pageNum} of "${s.filename}" was left as it was.`, error });
  } finally {
    if (session === s) setBusy(s, false);
  }
}

// ─── Removing the page shown ────────────────────────────────────────────────────

/** Remove this page is off while something is written, and when the document has only one page. */
function showRemove(s) {
  $('rotate-remove').disabled = s.busy || s.view.pageCount <= 1;
}

/** Closes the question and gives the window its own buttons and paging back. */
function hideRemoveQuestion() {
  $('rotate-remove-confirm').classList.add('hidden');
  $('rotate-modal').classList.remove('bt-rotate-asking');
  $('rotate-page-input').disabled = false;
  const view = session?.view;
  if (view) {
    $('rotate-prev').disabled = view.pageNum <= 1;
    $('rotate-next').disabled = view.pageNum >= view.pageCount;
  }
}

/**
 * Asks first: nothing is removed until the person says so. While the question is up it is the only thing on offer:
 * the turn, OCR and remove buttons and the window's own Cancel and Turn document are hidden, and paging is off, so
 * the question cannot drift to another page.
 */
function askRemove() {
  const s = session;
  if (!s || s.busy || s.view.pageCount <= 1) return;
  const turnFirst = hasPendingTurn(s) ? ' The turn is written into the document first.' : '';
  $('rotate-remove-question').textContent = `Remove page ${s.view.pageNum} of ${s.view.pageCount} from this document?${turnFirst}`;
  $('rotate-remove-confirm').classList.remove('hidden');
  $('rotate-modal').classList.add('bt-rotate-asking');
  for (const id of ['rotate-prev', 'rotate-next', 'rotate-page-input']) $(id).disabled = true;
  $('rotate-remove-keep').focus({ preventScroll: true });
}

/** The row's page count and its redaction badge, from what the stored file now holds. */
function showRowPages(filename, facts) {
  const row = document.querySelector(`tr.file-row[data-filename="${CSS.escape(filename)}"]`);
  const cell = row?.querySelector('.pages-cell');
  if (cell) cell.textContent = String(facts.pageCount);
  if (!facts.redactedPages.length) row?.querySelector('.bt-badge-redaction')?.remove();
}

async function removeShownPage() {
  const s = session;
  if (!s || s.busy || s.view.pageCount <= 1) return;
  hideRemoveQuestion();
  const pageNum = s.view.pageNum;
  setBusy(s, true);
  try {
    await writePendingTurn(s);
    const file = state.filesMap.get(s.filename);
    if (!file) return;
    const { removePdfPages, inspectPdf } = await pagesModule();
    const out = await removePdfPages(new Uint8Array(await file.arrayBuffer()), [pageNum - 1]);
    if (!state.filesMap.has(s.filename)) return;
    storeChangedFile(s.filename, out);
    // What OCR recorded about the pages follows them: the removed page's entries go, the pages after it move up.
    forgetRemovedPage(s.filename, pageNum);
    // The page count is read back from the stored bytes, not worked out from the one before.
    const facts = await inspectPdf(state.filesMap.get(s.filename));
    const info = state.frontendInputData[s.filename];
    if (info) {
      info.pageCount = facts.pageCount;
      if (facts.redactedPages.length) info.redactedPages = facts.redactedPages;
      else delete info.redactedPages;
    }
    showRowPages(s.filename, facts);
    refreshBundleTotals();
    markDirty({ immediate: true });
    if (session !== s) return;
    say(s, `Page ${pageNum} removed.`);
    // The page that took its place, or the new last page.
    s.view.pageNum = Math.min(pageNum, facts.pageCount);
    await reloadFromStore(s);
  } catch (error) {
    showErrorModal({ code: 'BT-VIEW-03', title: 'Could not remove the page', message: `Page ${pageNum} of "${s.filename}" could not be removed.`, error });
  } finally {
    if (session === s) setBusy(s, false);
  }
}

function close() {
  const s = session;
  session = null;
  // Frees what pdf.js holds and drops the drawn bitmap.
  s?.view.release();
  $('rotate-modal').classList.add('hidden');
  hideRemoveQuestion();
  // Focus goes back to the row's own button, not to the top of the page.
  s?.opener?.focus?.({ preventScroll: true });
}

/** "Turn document": the turn goes into the stored file and the window closes, as a confirmed choice does. */
async function apply() {
  const s = session;
  if (!s || s.busy || !hasPendingTurn(s)) return;
  const { filename } = s;
  const plan = turnPlan(s);
  close();
  showProcessingOverlay('Turning the document…');
  try {
    const file = state.filesMap.get(filename);
    if (!file) return;
    const out = await bakeTurn(new Uint8Array(await file.arrayBuffer()), plan);
    // The row may have been removed while the file was being turned.
    if (state.filesMap.has(filename)) storeChangedFile(filename, out);
  } catch (error) {
    showErrorModal({
      code: 'BT-VIEW-04',
      title: 'Could not rotate this document',
      message: `"${filename}" could not be turned, so it was left as it was.`,
      error,
    });
  } finally {
    hideProcessingOverlay();
  }
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // Paging (buttons, the page box, the arrow keys) and a redraw on resize; the arrows rest while the remove question is up.
  wirePager(VIEW_IDS, () => session?.view, {
    modalId: 'rotate-modal',
    paused: () => $('rotate-modal').classList.contains('bt-rotate-asking'),
  });
  $('rotate-left').addEventListener('click', () => turnBy(-90));
  $('rotate-right').addEventListener('click', () => turnBy(90));
  for (const id of ['rotate-scope-page', 'rotate-scope-document']) {
    $(id).addEventListener('change', (e) => { if (e.target.checked) setScope(e.target.value); });
  }

  $('rotate-apply').addEventListener('click', apply);
  $('rotate-cancel').addEventListener('click', close);
  $('rotate-close').addEventListener('click', close);
  $('rotate-ocr').addEventListener('click', runForceOcr);
  $('rotate-remove').addEventListener('click', askRemove);
  $('rotate-remove-keep').addEventListener('click', () => { hideRemoveQuestion(); $('rotate-remove').focus({ preventScroll: true }); });
  $('rotate-remove-yes').addEventListener('click', removeShownPage);
  $('rotate-putback')?.addEventListener('click', putBackShownPage);
}

/**
 * Opens the window for one document, on its first page.
 * @param {string} filename  the key in state.filesMap
 * @param {HTMLElement} opener  the row's eye, refocused on close
 * @param {{forceOcr?: Function}} [opts]  forceOcr: the Force OCR run, ocrForce.js's unless a test passes its own
 */
export async function openDocumentWindow(filename, opener, { forceOcr = runOcrForceModule } = {}) {
  const file = state.filesMap.get(filename);
  if (!file) return;
  wire();
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    showErrorModal({ code: 'BT-VIEW-01', title: 'Could not open this document', message: `"${filename}" could not be read.`, error });
    return;
  }
  if (session) close();
  const pageCount = Math.max(1, state.frontendInputData[filename]?.pageCount || 1);
  const s = {
    filename, opener, forceOcr, view: null, busy: false,
    turn: 0,
    pageTurns: new Map(), scope: 'document',
  };
  s.view = makeView(s, bytes, pageCount);
  session = s;
  $('rotate-file').textContent = filename;
  $('rotate-scope-document').checked = true;
  $('rotate-message').textContent = '';
  setBusy(s, false);
  s.view.showPager();
  $('rotate-preview').classList.add('hidden');
  $('rotate-no-preview').classList.add('hidden');
  $('rotate-modal').classList.remove('hidden');
  $('rotate-right').focus({ preventScroll: true });
  s.view.draw();
}
