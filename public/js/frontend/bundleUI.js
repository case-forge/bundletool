import { state } from './state.js';
import { lazyImport } from '/js/shared/lazy-load.js';
import { BUNDLE_STEPS } from './constants.js';

import { icon } from './icons.js';

export function triggerDownload(pdfBytes, filename, type = 'application/pdf') {
  const blob = new Blob([pdfBytes], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

export function buildTrack() {
  const track = document.getElementById('processing-track');
  if (!track) return;
  track.innerHTML = BUNDLE_STEPS.map((step, i) => {
    const isLast = i === BUNDLE_STEPS.length - 1;
    return `<div class="flex gap-3 items-stretch">
      <div class="flex flex-col items-center w-5 flex-shrink-0">
        <div id="station-dot-${i}" class="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-slate-500 bg-white dark:bg-slate-800 flex-shrink-0"></div>
        ${!isLast ? `<div id="station-line-${i}" class="w-px flex-1 bg-gray-200 dark:bg-slate-600 mt-1"></div>` : ''}
      </div>
      <div class="${!isLast ? 'pb-3' : ''}">
        <span id="station-label-${i}" class="text-xs text-gray-400 dark:text-slate-500">${step}</span>
      </div>
    </div>`;
  }).join('');
  track.classList.remove('hidden');
  state._trackInitialized = true;
}

export function updateTrack(activeIndex) {
  BUNDLE_STEPS.forEach((_, i) => {
    const dot   = document.getElementById(`station-dot-${i}`);
    const line  = document.getElementById(`station-line-${i}`);
    const label = document.getElementById(`station-label-${i}`);
    if (!dot) return;
    if (i < activeIndex) {
      dot.className = 'w-4 h-4 rounded-full bg-green-500 flex-shrink-0 flex items-center justify-center';
      dot.innerHTML = `${icon('check', 'w-2.5 h-2.5 text-white')}`;
      if (line)  line.className  = 'w-px flex-1 bg-green-400 mt-1';
      if (label) label.className = 'text-xs text-green-600 dark:text-green-400 font-medium';
    } else if (i === activeIndex) {
      dot.className = 'w-4 h-4 rounded-full bg-green-500 flex-shrink-0 animate-pulse';
      dot.innerHTML = '';
      if (line)  line.className  = 'w-px flex-1 bg-gray-200 dark:bg-slate-600 mt-1';
      if (label) label.className = 'text-xs text-gray-800 dark:text-slate-100 font-semibold';
    } else {
      dot.className = 'w-4 h-4 rounded-full border-2 border-gray-300 dark:border-slate-500 bg-white dark:bg-slate-800 flex-shrink-0';
      dot.innerHTML = '';
      if (line)  line.className  = 'w-px flex-1 bg-gray-200 dark:bg-slate-600 mt-1';
      if (label) label.className = 'text-xs text-gray-400 dark:text-slate-500';
    }
  });
}

export function showProcessingOverlay(msg) {
  const overlay = document.getElementById('processing-overlay');
  if (!overlay) return;

  const inner = overlay.querySelector(':scope > div');
  if (inner && !state._overlayOriginalHTML) state._overlayOriginalHTML = inner.innerHTML;

  const el = document.getElementById('processing-overlay-msg');
  if (el) el.textContent = msg || 'Processing…';
  overlay.classList.remove('hidden');

  const stepIndex = BUNDLE_STEPS.indexOf(msg);
  if (msg === 'Building bundle…' || msg === 'Building index preview…') {
    buildTrack();
    updateTrack(-1);
  } else if (stepIndex !== -1) {
    if (!state._trackInitialized) buildTrack();
    document.getElementById('processing-track')?.classList.remove('hidden');
    updateTrack(stepIndex);
  } else if (!state._trackInitialized) {
    document.getElementById('processing-track')?.classList.add('hidden');
  }
}

export function hideProcessingOverlay() {
  const overlay = document.getElementById('processing-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  const inner = overlay.querySelector(':scope > div');
  if (inner && state._overlayOriginalHTML) inner.innerHTML = state._overlayOriginalHTML;
  state._trackInitialized = false;
}

/** Counts opens of the preview window, so pictures that finish loading after the window moved on are not shown. */
let previewOpenId = 0;
/** previewPages.js once it has loaded: only ever on a browser with no PDF viewer. */
let previewPages = null;
const loadPreviewPages = () => lazyImport(new URL('./previewPages.js', import.meta.url)).then((m) => (previewPages = m));

/**
 * Shows a finished bundle in the browser's own PDF viewer, or, on a browser
 * with none (most phones), as pictures of its pages, one at a time.
 *
 * The bytes are ALREADY BUILT when this runs: preview is a display decision,
 * not a cheaper render (the viewer paints in its own process, with next to no
 * main-thread heap even on a 29.7 MB bundle). Reached from the Preview Bundle
 * button (which runs the full pipeline first) and from the bundle-ready
 * overlay's Preview button (where the build has just happened anyway).
 *
 * The pictures are previewPages.js, loaded only when they are needed, and
 * drawn and paged as the document window does it. They are read-only: Save,
 * Split for email and the close cross stay this window's own.
 *
 * Handlers are assigned with onclick, not addEventListener: the modal is
 * static markup reused across opens, and onclick's single slot means a
 * second open replaces the first open's handlers instead of stacking them.
 *
 * @param {Uint8Array} pdfBytes
 * @param {string} filename
 * @param {Object} [opts]
 * @param {string} [opts.title] - modal heading; falls back to `filename`
 * @param {string} [opts.saveLabel] - Save button text
 * @param {string} [opts.noViewerMessage] - shown on a phone with no embedded
 *   PDF viewer when its pages cannot be shown as pictures either
 * @param {boolean} [opts.allowSplit=true] - Split for email is a bundle
 *   concept (splitting a large bundle into parts small enough to email);
 *   an index preview has no such use, so openIndexPreview() below passes
 *   false and the button is hidden entirely rather than shown disabled.
 * @param {boolean} [opts.indexOnly=false] - the PDF is the index alone, so
 *   it holds none of the documents
 */
export function openBundlePreview(pdfBytes, filename, opts = {}) {
  const modal    = document.getElementById('bundle-preview-modal');
  const frame    = document.getElementById('bundle-preview-frame');
  const noViewer = document.getElementById('bundle-preview-no-viewer');
  if (!modal || !frame) return;

  const titleEl = document.getElementById('bundle-preview-title');
  if (titleEl) titleEl.textContent = opts.title || filename || 'Bundle preview';

  // The template's own wording is the bundle's; an index preview brings its own, and the next bundle preview puts it back.
  const noViewerText = noViewer?.querySelector('p');
  if (noViewerText) {
    noViewerText.dataset.bundleText ??= noViewerText.textContent;
    noViewerText.textContent = opts.noViewerMessage || noViewerText.dataset.bundleText;
  }

  const saveBtn  = document.getElementById('bundle-preview-save');
  if (saveBtn) saveBtn.textContent = opts.saveLabel || 'Save bundle';

  const splitBtn = document.getElementById('bundle-preview-split');
  splitBtn?.classList.toggle('hidden', opts.allowSplit === false);

  const openId = ++previewOpenId;
  previewPages?.hidePages();

  // Same feature-detect as the coversheet editor: phones ship no embedded
  // viewer, and a blank grey box reads as breakage.
  const canPreview = navigator.pdfViewerEnabled !== false;
  // A bundle holding a document that unpacks to gigabytes is not drawn, as
  // the document window does not draw that document: the note says to save it.
  const switchedOff = opts.indexOnly !== true
    && Object.values(state.frontendInputData).some((d) => d?.expanding);
  let url = null;

  /** The pages as pictures, from `where` when coming back to a page; the note when they cannot be shown. */
  function showPictures(where = null) {
    if (switchedOff) { noViewer?.classList.remove('hidden'); return; }
    loadPreviewPages().then((pages) => {
      if (openId !== previewOpenId || modal.classList.contains('hidden')) return;
      pages.showPages(pdfBytes, where);
    }).catch(() => {
      if (openId === previewOpenId) noViewer?.classList.remove('hidden');
    });
  }

  if (canPreview) {
    url = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
    frame.src = url;
    frame.classList.remove('hidden');
    noViewer?.classList.add('hidden');
  } else {
    frame.classList.add('hidden');
    noViewer?.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  if (!canPreview) showPictures();

  function close() {
    modal.classList.add('hidden');
    frame.src = 'about:blank';
    if (url) { URL.revokeObjectURL(url); url = null; }
    // The pictures free what pdf.js holds for them.
    previewPages?.hidePages();
  }

  const closeBtn = document.getElementById('bundle-preview-close');
  if (closeBtn) closeBtn.onclick = close;
  if (saveBtn) saveBtn.onclick = () => {
    triggerDownload(pdfBytes, filename);
    close();
  };
  if (splitBtn) {
    splitBtn.onclick = opts.allowSplit === false ? null : async () => {
      // Hide, don't close(): close() revokes the object URL and blanks the
      // iframe, so cancelling the split modal would have nothing left to
      // come back to. Just hiding this modal underneath and un-hiding it on
      // cancel keeps the exact same live preview. The pictures free what
      // pdf.js holds while the split runs, and come back on the same page.
      modal.classList.add('hidden');
      const where = previewPages?.hidePages() ?? null;
      const { openEmailSplit } = await lazyImport(new URL('./emailSplit.js', import.meta.url));
      openEmailSplit(pdfBytes, filename, {
        onCancel: () => {
          modal.classList.remove('hidden');
          // Back on the page that was shown, or on page 1 if Split was pressed before the pictures had loaded.
          if (!canPreview) showPictures(where);
        },
      });
    };
  }
}

/**
 * Preview and Save for an index-only build, so the index can be looked at
 * before it is saved. Reuses the same modal as openBundlePreview() rather
 * than a second one (one viewer, one Save/Close pattern), just without Split
 * for email, which is a whole-bundle concept an index-only PDF has no use for.
 *
 * @param {Uint8Array} pdfBytes
 * @param {string} filename
 */
export function openIndexPreview(pdfBytes, filename) {
  openBundlePreview(pdfBytes, filename, {
    title: 'Index preview',
    saveLabel: 'Save index',
    noViewerMessage: 'This browser cannot display PDF previews (most phones cannot). Your index was still built exactly as configured. Use Save index below to download and open it.',
    allowSplit: false,
    indexOnly: true,
  });
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {string} filename
 * @param {object} [opts]
 * @param {string} [opts.readyMessage] - overlay heading once the build finishes.
 * @param {string} [opts.saveLabel] - Save button text.
 * @param {string} [opts.previewLabel] - Preview button text.
 * @param {boolean} [opts.allowSplit] - false drops the Split for email button
 *   entirely (an index-only PDF has no use for it, as with
 *   openIndexPreview's own allowSplit:false).
 * @param {(pdfBytes: Uint8Array, filename: string) => void} [opts.previewFn] -
 *   what the Preview button opens. Defaults to the full bundle viewer;
 *   showIndexReadyState below passes openIndexPreview instead.
 */
export function showBundleReadyState(pdfBytes, filename, opts = {}) {
  const {
    readyMessage = 'Bundle ready!',
    saveLabel = 'Save bundle',
    previewLabel = 'Preview bundle',
    allowSplit = true,
    previewFn = openBundlePreview,
  } = opts;
  state._cancelReject = null;
  document.getElementById('processing-cancel-btn')?.classList.add('hidden');
  updateTrack(BUNDLE_STEPS.length);

  // 180ms: the pause exists so the progress track's last tick is seen rather
  // than skipped, and 180ms is enough for that. A longer pause shows on a
  // small bundle: 800ms would be about a fifth of the whole wait for a
  // single-document bundle, spent watching a finished build.
  setTimeout(() => {
    const overlay = document.getElementById('processing-overlay');
    if (!overlay) return;

    const spinnerRow = overlay.querySelector('.flex.items-center.gap-3.mb-4');
    if (spinnerRow) {
      spinnerRow.outerHTML = `
        <div class="flex items-center gap-3 mb-4">
          <div class="w-6 h-6 rounded-full bg-green-500 flex-shrink-0 flex items-center justify-center">
            ${icon('check', 'w-3.5 h-3.5 text-white')}
          </div>
          <p class="text-sm font-semibold text-gray-800 dark:text-slate-100 flex-1">${readyMessage}</p>
          <button id="overlay-close-x" class="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition" aria-label="Close">
            ${icon('close', 'w-4 h-4')}
          </button>
        </div>`;
    }

    const track = document.getElementById('processing-track');
    if (track) {
      const btns = document.createElement('div');
      btns.className = 'flex flex-col gap-2 mt-4';
      // No "Close and edit" button: the cross top right already closes the
      // overlay, and without it the buttons carry the same visual weight
      // instead of Save towering over its neighbours.
      btns.innerHTML = `
        <button id="overlay-save-btn" class="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-2">
          ${icon('download', 'w-4 h-4')}
          ${saveLabel}
        </button>
        <button id="overlay-preview-btn" class="w-full px-4 py-2.5 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-300 text-sm font-medium rounded-lg transition">
          ${previewLabel}
        </button>
        ${allowSplit ? `<button id="overlay-split-btn" class="w-full px-4 py-2.5 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-300 text-sm font-medium rounded-lg transition">
          Split for email…
        </button>` : ''}`;
      track.after(btns);
      // No "save these settings as your default?" prompt: settings persist
      // automatically as they change, so by the time a bundle is built they
      // are already saved.
    }

    document.getElementById('overlay-save-btn')?.addEventListener('click', () => {
      triggerDownload(pdfBytes, filename);
      hideProcessingOverlay();
    });
    document.getElementById('overlay-close-x')?.addEventListener('click', () => hideProcessingOverlay());
    document.getElementById('overlay-preview-btn')?.addEventListener('click', () => {
      hideProcessingOverlay();
      previewFn(pdfBytes, filename);
    });
    if (allowSplit) {
      document.getElementById('overlay-split-btn')?.addEventListener('click', async () => {
        // Hide the overlay element directly rather than hideProcessingOverlay():
        // that function also resets the overlay's innerHTML back to its
        // pre-"Bundle ready" spinner markup, which would wipe out the Save/
        // Preview/Split buttons just built above. Cancelling the split modal
        // needs the exact same "Bundle ready!" screen back, not a rebuild.
        const overlay = document.getElementById('processing-overlay');
        overlay?.classList.add('hidden');
        const { openEmailSplit } = await lazyImport(new URL('./emailSplit.js', import.meta.url));
        openEmailSplit(pdfBytes, filename, { onCancel: () => overlay?.classList.remove('hidden') });
      });
    }
  }, 180);
}

/**
 * Same "ready" overlay as showBundleReadyState, for an index-only build:
 * Save and Preview only, no Split (an index-only PDF has no email-size use for
 * it), and previewFn is openIndexPreview so "Preview index" opens the
 * index-scoped viewer instead of the full bundle one.
 *
 * @param {Uint8Array} pdfBytes
 * @param {string} filename
 */
export function showIndexReadyState(pdfBytes, filename) {
  showBundleReadyState(pdfBytes, filename, {
    readyMessage: 'Index ready!',
    saveLabel: 'Save index',
    previewLabel: 'Preview index',
    allowSplit: false,
    previewFn: openIndexPreview,
  });
}
