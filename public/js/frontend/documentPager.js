/**
 * documentPager.js
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
 * A window that names zoomIn and zoomOut buttons can also zoom: the buttons step through ZOOM_STEPS, which are multiples
 * of the fitted size ("Fit" is 100%, MAX_ZOOM the most), the stage scrolls once the page is larger than it, + / - / 0
 * work while focus is inside the window, and two fingers (or Ctrl and the wheel, which is how a trackpad pinch arrives)
 * zoom to any size in between, around the point between them (wirePinch). A window without the buttons is always fitted.
 * Both windows that use this (the document window and the preview's pictures) name them.
 *
 * Loaded on first use with whichever window needs it, so the page carries neither this nor pdf.js until then.
 */
import * as pdfjsLib from '/vendor/pdfjs.mjs';
import { raceTimeout } from '../bundletoolTimeout.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/bundletool/js/pdfjs.worker.mjs';

/** A preview that has not appeared after this long is given up on: a page can take minutes to draw. */
export const PREVIEW_TIMEOUT_MS = 15000;

/** The sizes the zoom buttons step through, as multiples of the size that fits the stage: 100% is "Fit", 500% the most (as in browser PDF viewers). */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 5];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * The most pixels one canvas is given. Safari on iPhone and iPad refuses (and draws nothing on) a canvas past 16,777,216
 * pixels, and a zoomed page on a 3x screen would pass that, so past this the picture is drawn at a lower resolution at
 * the same size on screen.
 */
export const MAX_CANVAS_PIXELS = 16 * 1000 * 1000;

/** Rejects with a `timeout` error when the promise has not settled in time. */
function withTimeout(promise, ms) {
  return raceTimeout(promise, ms, () => Object.assign(new Error('preview timeout'), { timeout: true }));
}

const $ = (id) => document.getElementById(id);

/**
 * One document in one window.
 *
 * `ids` names the window's elements: canvas, stage (the box the page is fitted inside), noPreview (shown when a page
 * cannot be drawn), prev, next, input (the page number box) and count; and, for a window that zooms, zoomIn and zoomOut.
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
 *   onZoom(percent)  after the zoom changed, with the new size as a percentage of the fitted one
 */
export class PageView {
  constructor(ids, { bytes, pageCount = 1, switchedOff = false, label = 'preview', turn, onPager, onClear, onDrawn, onZoom } = {}) {
    this.ids = ids;
    this.bytes = bytes;
    this.pageCount = Math.max(1, pageCount);
    this.pageNum = 1;
    this.switchedOff = switchedOff;
    this.label = label;
    this.hooks = { turn, onPager, onClear, onDrawn, onZoom };
    this.zoom = 1;
    this.keepCentre = null;
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
      const scale = Math.max(0.1, fit) * this.zoom;
      let pixelScale = scale * (window.devicePixelRatio || 1);
      const pixels = natural.width * pixelScale * natural.height * pixelScale;
      if (pixels > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = this.page.getViewport({ scale: pixelScale, rotation });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(natural.width * scale)}px`;
      canvas.style.height = `${Math.round(natural.height * scale)}px`;
      this.restoreScroll(stage);
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

  /** The zoom as a percentage of the fitted size. */
  zoomPercent() {
    return Math.round(this.zoom * 100);
  }

  /**
   * Steps the zoom to the next size in (+1) or out (-1), or back to Fit (0), keeping the middle of what is in view in
   * the middle. From a size between two steps (after a pinch) the next step is the one beyond it.
   */
  zoomBy(direction) {
    if (this.released || !this.ids.zoomIn) return;
    let next = 1;
    if (direction > 0) next = ZOOM_STEPS.find((z) => z > this.zoom + 0.001) ?? MAX_ZOOM;
    else if (direction < 0) next = [...ZOOM_STEPS].reverse().find((z) => z < this.zoom - 0.001) ?? 1;
    const stage = $(this.ids.stage);
    this.setZoom(next, {
      x: (stage.scrollLeft + stage.clientWidth / 2) / (stage.scrollWidth || 1),
      y: (stage.scrollTop + stage.clientHeight / 2) / (stage.scrollHeight || 1),
    });
  }

  /**
   * Zooms to `zoom` (held between Fit and MAX_ZOOM). `keep` says what stays put: { x, y } is the point of the scrolled
   * content (as fractions of it) that ends up in the middle of the stage; { fx, fy, sx, sy } is the point of the page
   * (as fractions of it) that ends up sx, sy from the stage's top left, which is where a pinch holds its fingers.
   */
  setZoom(zoom, keep) {
    if (this.released || !this.ids.zoomIn) return;
    const next = Math.min(Math.max(zoom, 1), MAX_ZOOM);
    if (Math.abs(next - this.zoom) < 0.005) return;
    this.keepCentre = keep;
    this.zoom = next;
    this.showZoom();
    this.hooks.onZoom?.(this.zoomPercent());
    this.draw();
  }

  /** The zoom buttons: out is off at Fit, in is off at the largest size. */
  showZoom() {
    if (!this.ids.zoomIn) return;
    $(this.ids.zoomOut).disabled = this.zoom <= 1.001;
    $(this.ids.zoomIn).disabled = this.zoom >= MAX_ZOOM - 0.001;
  }

  /** After the picture changed size: the same middle (or pinched point) stays in view, or, for a new page, its top. */
  restoreScroll(stage) {
    const keep = this.keepCentre;
    this.keepCentre = null;
    if (!keep) return;
    if ('fx' in keep) {
      const canvas = $(this.ids.canvas);
      stage.scrollLeft = canvas.offsetLeft + keep.fx * canvas.offsetWidth - keep.sx;
      stage.scrollTop = canvas.offsetTop + keep.fy * canvas.offsetHeight - keep.sy;
      return;
    }
    stage.scrollLeft = keep.x * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = keep.y * stage.scrollHeight - stage.clientHeight / 2;
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
    if (moved) {
      this.keepCentre = { x: 0.5, y: 0 };
      this.draw();
    }
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
 * Pinch to zoom, for a window with zoom buttons: two fingers on the stage, or Ctrl and the wheel (a trackpad's pinch).
 * While the fingers move the picture is only scaled by CSS around the point between them, which is cheap; the page is
 * drawn again once, at the size they settle on, when they lift (or the wheel stops). One finger is left to the browser,
 * which scrolls the stage (touch-action in the stylesheet keeps the browser's own page zoom out of it).
 */
function wirePinch(ids, current) {
  const stage = $(ids.stage);
  const canvas = $(ids.canvas);
  const pointers = new Map();
  let gesture = null;

  const start = (view, mx, my) => {
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    gesture = {
      view, startZoom: view.zoom, target: view.zoom,
      fx: c.width ? (mx - c.left) / c.width : 0.5, fy: c.height ? (my - c.top) / c.height : 0.5,
      sx: mx - s.left - stage.clientLeft, sy: my - s.top - stage.clientTop,
    };
    canvas.style.transformOrigin = `${gesture.fx * 100}% ${gesture.fy * 100}%`;
  };
  const move = (factor) => {
    gesture.target = Math.min(Math.max(gesture.startZoom * factor, 1), MAX_ZOOM);
    canvas.style.transform = `scale(${gesture.target / gesture.startZoom})`;
  };
  const finish = () => {
    if (!gesture) return;
    const { view, target, fx, fy, sx, sy } = gesture;
    gesture = null;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    view.setZoom(target, { fx, fy, sx, sy });
  };

  let startDistance = 1;
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const middle = () => { const [a, b] = [...pointers.values()]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const view = current();
    if (pointers.size === 2 && view && !gesture) {
      startDistance = distance();
      start(view, ...middle());
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && pointers.size === 2) move(distance() / startDistance);
  });
  const lift = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) finish();
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);

  // A trackpad pinch (and Ctrl with the wheel) arrives as wheel events with ctrlKey set.
  let wheelTimer = null;
  let wheelFactor = 1;
  stage.addEventListener('wheel', (e) => {
    const view = current();
    if (!e.ctrlKey || !view) return;
    e.preventDefault();
    if (!gesture) { wheelFactor = 1; start(view, e.clientX, e.clientY); }
    wheelFactor *= Math.exp(-e.deltaY * 0.01);
    move(wheelFactor);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(finish, 150);
  }, { passive: false });
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
  if (ids.zoomIn) {
    $(ids.zoomIn).addEventListener('click', () => current()?.zoomBy(1));
    $(ids.zoomOut).addEventListener('click', () => current()?.zoomBy(-1));
    wirePinch(ids, current);
  }
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
    if (ids.zoomIn && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); v.zoomBy(1); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); v.zoomBy(-1); return; }
      if (e.key === '0') { e.preventDefault(); v.zoomBy(0); return; }
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); v.goTo(v.pageNum - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); v.goTo(v.pageNum + 1); }
  });
  window.addEventListener('resize', () => showing()?.draw());
}
