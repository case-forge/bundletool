/**
 * pageView.js
 * A PDF shown one page at a time on a canvas with pdf.js, with "Page n of N" paging: the drawing and paging the
 * document window (rotate.js) and the preview's pictures on a browser with no PDF viewer (previewPages.js) share.
 *
 * pdf.js reads the file with no script evaluation, no XFA forms and a ceiling on the size of any one picture. Only the
 * page shown is drawn: a page's render is freed when another page takes its place, and the document itself when the
 * view is released. A page that has not appeared after PREVIEW_TIMEOUT_MS is given up on.
 *
 * Paging is previous and next, a page number to type (Enter or leaving the box goes there), and the Left and Right
 * arrow keys while focus is inside the window (wirePager).
 *
 * Loaded on first use with whichever window needs it, so the page carries neither this nor pdf.js until then.
 */
import * as pdfjsLib from '/vendor/pdfjs.mjs';
import { raceTimeout } from '../bundletoolTimeout.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/bundletool/js/pdfjs.worker.mjs';

/** A preview that has not appeared after this long is given up on: a page can take minutes to draw. */
export const PREVIEW_TIMEOUT_MS = 15000;

/** Rejects with a `timeout` error when the promise has not settled in time. */
function withTimeout(promise, ms) {
  return raceTimeout(promise, ms, () => Object.assign(new Error('preview timeout'), { timeout: true }));
}

const $ = (id) => document.getElementById(id);

/**
 * One document in one window.
 *
 * `ids` names the window's elements: canvas, stage (the box the page is fitted inside), noPreview (shown when a page
 * cannot be drawn), prev, next, input (the page number box) and count.
 *
 * `opts`:
 *   bytes        the PDF; pdf.js is given a copy, so these stay usable (Save, Split) while the page is shown
 *   pageCount    the count to show until pdf.js has read the document (it is corrected then)
 *   switchedOff  true for a file that must never be drawn (one that unpacks to gigabytes would crash the tab)
 *   label        names the window in the console when a page cannot be drawn
 *   turn(n)      degrees clockwise to draw page n at, on top of its own rotation (none by default)
 *   onPager()    after "Page n of N" is shown
 *   onClear()    when the page shown is about to be replaced, or could not be drawn
 *   onDrawn({ token, canvas, rotation })  after a page is drawn
 */
export class PageView {
  constructor(ids, { bytes, pageCount = 1, switchedOff = false, label = 'preview', turn, onPager, onClear, onDrawn } = {}) {
    this.ids = ids;
    this.bytes = bytes;
    this.pageCount = Math.max(1, pageCount);
    this.pageNum = 1;
    this.switchedOff = switchedOff;
    this.label = label;
    this.hooks = { turn, onPager, onClear, onDrawn };
    this.loading = null;
    this.pdfPromise = null;
    this.page = null;
    this.task = null;
    this.token = 0;
    this.released = false;
  }

  /** True while a draw started with `token` is still the one that counts. */
  current(token) {
    return !this.released && token === this.token;
  }

  /** The clockwise turn the page shown is drawn at: its own rotation and any turn the window adds. */
  rotation() {
    return ((this.page?.rotate || 0) + (this.hooks.turn?.(this.pageNum) || 0)) % 360;
  }

  /** Loads the document into pdf.js once, with its safety settings, and learns its page count. */
  load() {
    if (!this.pdfPromise) {
      if (this.switchedOff) {
        this.pdfPromise = Promise.reject(Object.assign(new Error('preview switched off'), { switchedOff: true }));
      } else {
        // No script evaluation, no XFA forms, and a ceiling on the size of any one picture pdf.js will draw.
        this.loading = pdfjsLib.getDocument({ data: this.bytes.slice(), isEvalSupported: false, enableXfa: false, maxImageSize: 32 * 1024 * 1024 });
        this.pdfPromise = withTimeout(this.loading.promise, PREVIEW_TIMEOUT_MS).then((pdf) => {
          if (!this.released && pdf.numPages !== this.pageCount) {
            this.pageCount = pdf.numPages;
            this.pageNum = Math.min(this.pageNum, this.pageCount);
            this.showPager();
          }
          return pdf;
        });
      }
      this.pdfPromise.catch(() => { /* draw() reports it */ });
    }
    return this.pdfPromise;
  }

  /** Frees the page that was shown: the render in flight and what pdf.js holds for the page. */
  freePage() {
    try { this.task?.cancel(); } catch { /* already finished */ }
    try { this.page?.cleanup(); } catch { /* nothing to clean */ }
    this.task = null;
    this.page = null;
  }

  /**
   * Frees what pdf.js holds for the document: the page, then the loaded document itself (a copy of the file lives in
   * pdf.js's worker until the loading task is destroyed; without this every open of a window on a large PDF would
   * keep another copy for the life of the tab).
   */
  unload() {
    this.freePage();
    const loading = this.loading;
    this.loading = null;
    this.pdfPromise = null;
    loading?.destroy?.();
  }

  /**
   * Done with: everything pdf.js holds is freed, the drawn picture dropped and hidden, and a draw still running counts
   * for nothing.
   */
  release() {
    this.released = true;
    this.token++;
    this.unload();
    this.bytes = null;
    const canvas = $(this.ids.canvas);
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.classList.add('hidden'); }
  }

  /** Shows new bytes for the same document (after a write changed it), on the same page where there still is one. */
  replace(bytes, pageCount) {
    this.unload();
    this.bytes = bytes;
    this.pageCount = Math.max(1, pageCount);
    this.pageNum = Math.min(this.pageNum, this.pageCount);
    this.showPager();
    this.draw();
  }

  /** Draws the page shown, at the turn the window says, fitted inside the stage. */
  async draw() {
    if (this.released) return;
    const token = ++this.token;
    const canvas = $(this.ids.canvas);
    const stage = $(this.ids.stage);
    try {
      const pdf = await this.load();
      if (!this.current(token)) return;
      if (this.page?.pageNumber !== this.pageNum) {
        this.freePage();
        this.hooks.onClear?.();
        const page = await withTimeout(pdf.getPage(this.pageNum), PREVIEW_TIMEOUT_MS);
        if (!this.current(token)) { try { page.cleanup(); } catch { /* nothing to clean */ } return; }
        this.page = page;
      }
      const rotation = this.rotation();
      const natural = this.page.getViewport({ scale: 1, rotation });
      const room = stage.getBoundingClientRect();
      const fit = Math.min((room.width - 24) / natural.width, (room.height - 24) / natural.height);
      const scale = Math.max(0.1, fit);
      const dpr = window.devicePixelRatio || 1;
      const viewport = this.page.getViewport({ scale: scale * dpr, rotation });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
      if (this.task) this.task.cancel();
      this.task = this.page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' });
      await withTimeout(this.task.promise, PREVIEW_TIMEOUT_MS);
      if (!this.current(token)) return;
      canvas.classList.remove('hidden');
      $(this.ids.noPreview).classList.add('hidden');
      this.hooks.onDrawn?.({ token, canvas, rotation });
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      if (!this.current(token)) return;
      if (err?.timeout) { try { this.task?.cancel(); } catch { /* already finished */ } }
      if (!err?.switchedOff) console.error(`[${this.label}] preview failed:`, err?.timeout ? 'took too long' : err);
      canvas.classList.add('hidden');
      $(this.ids.noPreview).classList.remove('hidden');
      this.hooks.onClear?.();
    }
  }

  /** "Page n of N": the number box, the count, the buttons at either end and the picture's name. */
  showPager() {
    const input = $(this.ids.input);
    input.value = String(this.pageNum);
    input.max = String(this.pageCount);
    $(this.ids.count).textContent = String(this.pageCount);
    $(this.ids.prev).disabled = this.pageNum <= 1;
    $(this.ids.next).disabled = this.pageNum >= this.pageCount;
    $(this.ids.canvas).setAttribute('aria-label', `Page ${this.pageNum} of ${this.pageCount}`);
    this.hooks.onPager?.();
  }

  /** Shows page n, held to 1..N. */
  goTo(n) {
    if (this.released) return;
    const page = Math.min(Math.max(1, n), this.pageCount);
    const moved = page !== this.pageNum;
    this.pageNum = page;
    this.showPager();
    if (moved) this.draw();
  }

  /** A typed page number: a whole number goes to that page (held to 1..N); anything else puts the box back. */
  commitInput() {
    if (this.released) return;
    const raw = $(this.ids.input).value.trim();
    if (/^\d+$/.test(raw)) this.goTo(Number(raw));
    else this.showPager();
  }
}

/**
 * Wires a window's paging once: the buttons, the page number box, the arrow keys and a redraw when the window is
 * resized. `current()` gives the view the window shows now, or nothing when it is closed; `paused()` is true while the
 * window has asked something that paging must not move away from.
 */
export function wirePager(ids, current, { modalId, paused = () => false }) {
  $(ids.prev).addEventListener('click', () => { const v = current(); if (v) v.goTo(v.pageNum - 1); });
  $(ids.next).addEventListener('click', () => { const v = current(); if (v) v.goTo(v.pageNum + 1); });
  $(ids.input).addEventListener('change', () => current()?.commitInput());
  const showing = () => { const v = current(); return v && !$(modalId).classList.contains('hidden') ? v : null; };

  document.addEventListener('keydown', (e) => {
    const v = showing();
    if (!v) return;
    // Only while focus is inside the window, so the arrows never page the document from behind it.
    if (!e.target.closest?.(`#${modalId}`)) return;
    if (e.target.id === ids.input && e.key === 'Enter') { e.preventDefault(); v.commitInput(); return; }
    // In a box the arrows move the caret or the choice, as they always do.
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.target.closest?.('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (paused()) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); v.goTo(v.pageNum - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); v.goTo(v.pageNum + 1); }
  });
  window.addEventListener('resize', () => showing()?.draw());
}
