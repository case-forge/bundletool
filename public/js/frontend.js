/**
 * BunTool
 * Copyrght (c) 2025-2026 Tris Sheriker (tris@sherliker.net) with significant frontend code additions by Claude Code
 * Copyright (c) 2026 CaseForge
 * A tool for the creation  of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * frontend.js: entry point. Wires together the frontend/ submodules.
 */

import Config from './bundletoolConfig.js';
import { init as initAutosave, markDirty, listSnapshots, loadSnapshot,
         listFinishedBundles, loadFinishedBundle, deleteFinishedBundle, deleteSnapshot,
         deleteAllSavedCopies } from './bundletoolAutosave.js';

import { state } from './frontend/state.js';
import { getAllSectionTbodys, getAllFileRows } from './frontend/helpers.js';
import { sortRowsBy, sortSection } from './frontend/sort.js';
import { getAutosaveState, applySnapshot } from './frontend/autosave.js';
import { setupFormDraft, restoreFormDraft } from './frontend/formDraft.js';
import { clearCoverOverrides } from './frontend/coverOverrides.js';
import { runAutoRestore } from './frontend/autoRestore.js';
import { setup as setupFileRows } from './frontend/fileRows.js';
import { setup as setupSections } from './frontend/sections.js';
import { setup as setupCoversheet } from './frontend/coversheet.js';
import { setup as setupCoverEditor } from './frontend/coverEditor.js';
import { setup as setupAdvancedState } from './frontend/advancedState.js';
import { setup as setupFileProcessing, hasPendingRowBatches } from './frontend/fileProcessing.js';
import { setup as setupBundleGeneration, runPreviewIndex } from './frontend/bundleGeneration.js';
import { setup as setupEmailSplit } from './frontend/emailSplit.js';
import { setupModals, showPageNotice } from './frontend/modals.js';
import { setupWsCoverModal } from './frontend/wsCover.js';
import { setupReviewTableHeader } from './frontend/reviewTableHeader.js';
import { triggerDownload } from './frontend/bundleUI.js';

import { icon } from './frontend/icons.js';
import { lazyImport } from '/js/shared/lazy-load.js';
const form = document.getElementById('upload-form');

/** For text interpolated into innerHTML. Titles and filenames are typed by
 *  the user or read from files; neither is trusted markup. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Config & state setup ────────────────────────────────────────────────────

state.config = new Config();
window.config = state.config;

// ─── DOMContentLoaded: lazy imports, autosave, event wiring ─────────────────

window.addEventListener('DOMContentLoaded', () => {
  lazyImport(new URL('./bundletoolPages.js', import.meta.url)).then(m => {
    state.countPdfPages         = m.countPdfPages;
    state.validateAndCountPages = m.validateAndCountPages;
    state.validateCoverPage     = m.validateCoverPage;
  });
  lazyImport(new URL('./bundletoolMain.js', import.meta.url)).then(m => {
    state.processTheBundle = m.default ?? m.processTheBundle;
  });
  lazyImport('/vendor/chrono-node.js').then(m => { state.chrono = m; });

  // Autosave
  initAutosave(getAutosaveState, { hasDocuments: () => state.filesMap.size > 0, hasPendingRows: hasPendingRowBatches });

  // The person's last work comes back by itself (documents and settings from the newest autosave;
  // if a build never finished, the save from just before it), with a notice. See autoRestore.js.
  // Saved defaults and a settings link are applied first (bundletool.html), so the restore and the
  // draft below are the latest word on the form, except for a link the person just opened, which is
  // applied once more after them.
  const restored = (window.btSettingsReady ?? Promise.resolve())
    .then(() => runAutoRestore({ listSnapshots, loadSnapshot, applySnapshot }));

  // Keep the form across a refresh of this tab. Applied on 'load', after the remembered
  // defaults and after the restore above, so this tab's own draft (the latest state) wins.
  setupFormDraft();
  const applyDraft = () => restored
    .then(restoreFormDraft, restoreFormDraft)
    .then(() => window.btReapplySettingsLink?.());
  if (document.readyState === 'complete') applyDraft();
  else window.addEventListener('load', applyDraft);

  form?.addEventListener('change', (e) => {
    if (e.target.type === 'file') return;
    markDirty();
  });

  // Autosave restore modal
  document.getElementById('autosave-restore-btn')?.addEventListener('click', async () => {
    const snapshots = await listSnapshots();
    const modal     = document.getElementById('autosave-modal');
    const list      = document.getElementById('autosave-snapshot-list');
    if (!list || !modal) return;

    if (!snapshots.length) {
      list.innerHTML = '<p class="text-xs text-gray-500 dark:text-slate-400 text-center py-2">No autosaves found.</p>';
    } else {
      list.innerHTML = snapshots.map(s => {
        const when  = new Date(s.timestamp);
        const label = when.toLocaleDateString([], { day: 'numeric', month: 'short' })
                    + ' at ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const size  = s.sizeBytes < 1024 ** 2
          ? `${(s.sizeBytes / 1024).toFixed(0)} KB`
          : `${(s.sizeBytes / 1024 ** 2).toFixed(1)} MB`;
        const trunc   = (str, n) => str && str.length > n ? str.slice(0, n) + '…' : str;
        const title   = trunc(s.bundleTitle, 20);
        const proj    = trunc(s.projectName, 20);
        const nameStr = [title, proj].filter(Boolean).join(' / ');
        return `<div class="autosave-entry flex items-center gap-1.5"><button type="button"
          class="autosave-restore-item flex-1 min-w-0 text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bt-hover-line bt-hover-tint transition text-xs"
          data-ts="${s.timestamp}">
          <span class="font-medium text-gray-800 dark:text-slate-200">${label}</span>${nameStr ? `<span class="text-gray-600 dark:text-slate-400 ml-2">${esc(nameStr)}</span>` : ''}
          <span class="text-gray-500 dark:text-slate-400 ml-2">${s.fileCount} doc${s.fileCount !== 1 ? 's' : ''} · ${size}</span>
        </button><button type="button" class="autosave-delete text-gray-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 transition shrink-0 p-1" data-ts="${s.timestamp}" aria-label="Delete this saved copy" title="Delete this saved copy">${icon('close', 'w-3.5 h-3.5')}</button></div>`;
      }).join('');
      list.querySelectorAll('.autosave-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          await deleteSnapshot(Number(btn.dataset.ts));
          btn.closest('.autosave-entry')?.remove();
          if (!list.querySelector('.autosave-entry')) list.innerHTML = '<p class="text-xs text-gray-500 dark:text-slate-400 text-center py-2">No autosaves found.</p>';
        });
      });
      list.querySelectorAll('.autosave-restore-item').forEach(btn => {
        btn.addEventListener('click', async () => {
          modal.classList.add('hidden');
          const snapshot = await loadSnapshot(Number(btn.dataset.ts));
          if (snapshot) {
            await applySnapshot(snapshot);
            // A copy brought back from Rewind may be another tab's. Save it as this tab's own so a
            // refresh returns to exactly this state, not to whatever this tab last saved before.
            markDirty({ immediate: true });
          }
        });
      });
    }
    modal.classList.remove('hidden');
  });

  document.getElementById('autosave-modal-close')?.addEventListener('click', () => {
    document.getElementById('autosave-modal')?.classList.add('hidden');
  });

  // Finished bundles: the generated PDF itself, saved locally when a bundle
  // completes (bundleGeneration.js). Same modal pattern as autosave restore,
  // adjacent purpose: that one recovers your working documents, this one
  // re-downloads something you already finished without rebuilding it.
  document.getElementById('finished-bundles-btn')?.addEventListener('click', async () => {
    const bundles = await listFinishedBundles();
    const modal   = document.getElementById('finished-bundles-modal');
    const list    = document.getElementById('finished-bundles-list');
    if (!list || !modal) return;

    if (!bundles.length) {
      list.innerHTML = '<p class="text-xs text-gray-500 dark:text-slate-400 text-center py-2">No finished bundles saved yet.</p>';
    } else {
      list.innerHTML = bundles.map(b => {
        const when  = new Date(b.timestamp);
        const label = when.toLocaleDateString([], { day: 'numeric', month: 'short' })
                    + ' at ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const size  = b.sizeBytes < 1024 ** 2
          ? `${(b.sizeBytes / 1024).toFixed(0)} KB`
          : `${(b.sizeBytes / 1024 ** 2).toFixed(1)} MB`;
        const trunc = (str, n) => str && str.length > n ? str.slice(0, n) + '…' : str;
        return `<div class="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 text-xs">
          <button type="button" class="finished-bundle-download flex-1 min-w-0 text-left" data-ts="${b.timestamp}">
            <span class="font-medium text-gray-800 dark:text-slate-200 block truncate">${esc(trunc(b.filename, 34))}</span>
            <span class="text-gray-500 dark:text-slate-400">${label} · ${size}</span>
          </button>
          <button type="button" class="finished-bundle-split text-gray-400 dark:text-slate-500 bt-hover-ink transition shrink-0 p-1" data-ts="${b.timestamp}" aria-label="Split for email" title="Split for email">
            ${icon('swap_horiz', 'w-3.5 h-3.5')}
          </button>
          <button type="button" class="finished-bundle-delete text-gray-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 transition shrink-0 p-1" data-ts="${b.timestamp}" aria-label="Delete">
            ${icon('close', 'w-3.5 h-3.5')}
          </button>
        </div>`;
      }).join('');
      list.querySelectorAll('.finished-bundle-download').forEach(btn => {
        btn.addEventListener('click', async () => {
          const bundle = await loadFinishedBundle(Number(btn.dataset.ts));
          if (bundle) triggerDownload(bundle.bytes, bundle.filename);
        });
      });
      list.querySelectorAll('.finished-bundle-split').forEach(btn => {
        btn.addEventListener('click', async () => {
          const bundle = await loadFinishedBundle(Number(btn.dataset.ts));
          if (!bundle) return;
          modal.classList.add('hidden');
          const { openEmailSplit } = await lazyImport(new URL('./frontend/emailSplit.js', import.meta.url));
          // Cancelling the split modal restores this list rather than
          // leaving nothing visible.
          openEmailSplit(bundle.bytes, bundle.filename, { onCancel: () => modal.classList.remove('hidden') });
        });
      });
      list.querySelectorAll('.finished-bundle-delete').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          await deleteFinishedBundle(Number(btn.dataset.ts));
          btn.closest('.flex.items-center.gap-1\\.5')?.remove();
        });
      });
    }
    modal.classList.remove('hidden');
  });

  document.getElementById('finished-bundles-modal-close')?.addEventListener('click', () => {
    document.getElementById('finished-bundles-modal')?.classList.add('hidden');
  });

  // Delete everything this browser has stored of the person's work (working copies and finished
  // bundles), from either list. Two clicks: the first turns the button into the question.
  for (const [btnId, noteId] of [['autosave-delete-all-btn', 'autosave-delete-all-note'], ['finished-delete-all-btn', 'finished-delete-all-note']]) {
    const btn = document.getElementById(btnId);
    const note = document.getElementById(noteId);
    if (!btn) continue;
    const idle = btn.textContent;
    let armed = null;
    const disarm = () => { clearTimeout(armed); armed = null; btn.textContent = idle; };
    btn.addEventListener('click', async () => {
      if (!armed) {
        btn.textContent = 'Click again to delete everything saved';
        armed = setTimeout(disarm, 6000);
        return;
      }
      disarm();
      try {
        await deleteAllSavedCopies();
        for (const id of ['autosave-snapshot-list', 'finished-bundles-list']) {
          const list = document.getElementById(id);
          if (list) list.innerHTML = '<p class="text-xs text-gray-500 dark:text-slate-400 text-center py-2">Nothing saved.</p>';
        }
        if (note) note.textContent = 'Everything this browser had saved has been deleted. What is on this page stays until you close it, and nothing is saved again until you change something.';
      } catch (err) {
        if (note) note.textContent = `Could not delete the saved copies: ${err?.message || 'the browser refused'}. Error code BT-SAVE-03`;
      }
    });
  }

  // Autosave could not write to this browser's storage (full, or private browsing). Said once, plainly:
  // the work is still on the page, but a refresh would lose it.
  document.addEventListener('bundletool:autosave-failed', (e) => {
    showPageNotice({
      code: e.detail?.quota ? 'BT-SAVE-01' : 'BT-SAVE-02',
      title: 'Your work could not be saved on this device',
      message: (e.detail?.quota ? 'This browser has no room left to keep a copy. ' : 'This browser refused to keep a copy. ')
        + 'Your documents are still on this page, but refreshing or closing the tab would lose them. Build and save your bundle first; BundleTool will keep trying.',
    });
  });

  // Section import/export lives under Add Section: the whole workflow
  // belongs where sections themselves are managed, not behind a separate
  // menu. Export writes the same manifest schema scripts/build-cli.mjs
  // reads (config, sections, titles and dates), never the PDFs. Import here
  // is deliberately the same REPLACE semantics as the
  // drag-and-drop path in fileProcessing.js (see manifestIO.js's
  // importManifest() doc): a manifest is a template to start a bundle
  // from, not a patch onto the current one. No PDFs are picked alongside a
  // button-triggered import (unlike the drag path), so every file the
  // manifest names is reported "missing" by design, which is expected for a
  // structure-only layout file, and still an
  // honest result for a full manifest imported this way instead of by drop.
  document.getElementById('section-template-export-btn')?.addEventListener('click', async () => {
    const { exportManifest } = await lazyImport(new URL('./frontend/manifestIO.js', import.meta.url));
    exportManifest();
  });

  async function loadManifestFile(file) {
    const { parseManifest, importManifest, ManifestLimitError } = await lazyImport(new URL('./frontend/manifestIO.js', import.meta.url));
    const { showUploadWarningModal, showErrorModal, showLimitNotice } = await lazyImport(new URL('./frontend/modals.js', import.meta.url));
    // A layout over a limit (more sections than a bundle holds) is refused whole, with the limit's own warning and code.
    const refusedForLimit = (err) => {
      if (!(err instanceof ManifestLimitError)) return false;
      showLimitNotice(err);
      return true;
    };
    let manifest;
    try {
      manifest = await parseManifest(file);
    } catch (err) {
      if (!refusedForLimit(err)) showErrorModal({ code: 'BT-MAN-01', title: 'Could not import section', message: err.message });
      return;
    }
    let added, missing;
    try {
      ({ added, missing } = await importManifest(manifest, []));
    } catch (err) {
      if (!refusedForLimit(err)) showErrorModal({ code: 'BT-MAN-02', title: 'Could not import section', message: 'That file could not be imported, so the current bundle was left as it was.', error: err });
      return;
    }
    if (missing.length > 0) {
      showUploadWarningModal({
        code: added > 0 ? 'BT-MAN-03' : null,
        title: added > 0 ? 'Sections imported, some documents missing' : 'Section structure imported',
        message: added > 0
          ? `${missing.length} file(s) named in the manifest were not found:`
          : 'This replaces the current bundle with the manifest\'s section structure. Drag your documents into each section to fill it in.',
        items: added > 0 ? missing : undefined,
        hint: 'A manifest only records structure, not the PDFs themselves. Drag it together with the original documents instead of using this button if you want them matched automatically.',
      });
    }
  }

  const sectionImportInput = document.getElementById('section-template-import-input');
  document.getElementById('section-template-import-btn')?.addEventListener('click', () => {
    sectionImportInput?.click();
  });
  sectionImportInput?.addEventListener('change', async () => {
    const file = sectionImportInput.files?.[0];
    sectionImportInput.value = '';
    if (file) await loadManifestFile(file);
  });
  // Leaving the tab is the moment a save matters most, and bundletoolAutosave.js saves what is pending
  // when the page is hidden, only when something changed. A forced save here would write a full new
  // copy on every tab switch, fill Rewind with identical entries, and put back what "Delete all saved
  // copies" had just removed.

  // Column header sort
  let sortCol = null;
  let sortDir = 'asc';
  // The headings are focusable: Enter or Space sorts, and Shift keeps its 'sort all' meaning.
  document.querySelector('#file-table thead')?.addEventListener('keydown', (e) => {
    const th = e.target.closest('[data-sort-col]');
    if (!th || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    th.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey }));
  });
  document.querySelector('#file-table thead')?.addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort-col]');
    if (!th) return;
    const col = th.dataset.sortCol;
    sortDir = (sortCol === col && sortDir === 'asc') ? 'desc' : 'asc';
    sortCol = col;
    document.querySelectorAll('#file-table thead [data-sort-col]').forEach(h => {
      h.querySelector('.sort-indicator').textContent = '';
      h.removeAttribute('aria-sort');
    });
    th.querySelector('.sort-indicator').textContent = sortDir === 'asc' ? '▲' : '▼';
    th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');

    if (e.shiftKey && state.isSectioned) {
      const hasSections = document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').length > 0;
      if (hasSections) {
        new Promise(resolve => {
          window._globalSortResolve = resolve;
          document.getElementById('global-sort-modal')?.classList.remove('hidden');
        }).then(confirmed => {
          if (!confirmed) return;
          const allRows     = getAllFileRows();
          sortRowsBy(allRows, col, sortDir);
          const section0000 = document.getElementById('tbody-section-0000');
          const headerRow   = section0000?.querySelector('.section-header-row');
          allRows.forEach(row => section0000.appendChild(row));
          document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').forEach(t => t.remove());
          state.isSectioned    = false;
          state.nextSectionNum = 1;
          document.getElementById('file-table')?.classList.remove('sectioned');
          if (headerRow) headerRow.remove();
        });
        return;
      }
      const allRows = getAllFileRows();
      sortRowsBy(allRows, col, sortDir);
      const section0000 = document.getElementById('tbody-section-0000');
      allRows.forEach(row => section0000.appendChild(row));
    } else {
      getAllSectionTbodys().forEach(tbody => sortSection(tbody, col, sortDir));
    }
  });

  // There is no drag/arrows mode to toggle: the reorder arrows are revealed by
  // hover, by focus, and always below 768px, so dragging and its single-pointer
  // alternative (WCAG 2.5.7) are both available at all times, a property of
  // the page rather than a setting.

  // Wire up submodules
  setupFileRows();
  setupSections();
  setupCoversheet();
  setupCoverEditor();
  setupAdvancedState();
  setupFileProcessing();
  setupBundleGeneration(form, runPreviewIndex);
  setupEmailSplit();
  setupModals();
  setupWsCoverModal();
});

// ── Warm the engine while the browser is idle ─────────────────────────────
//
// Loading bundletoolMain.js's module graph takes about 1.45s of a 4.18s build
// of a single 7-page document, all of it before any work begins, because the
// dynamic import that fetches it sits on the critical path of the first build.
// On a 200-page bundle it disappears into the noise; on a one-page one it IS
// the wait. So it is fetched during idle time after the page settles. By the
// time anyone has chosen a file and pressed the button, the import is already
// resolved and state.processTheBundle is set.
//
// jsPDF, jspdf-autotable and fontkit are not part of that static graph:
// bundletoolToc.js and bundletoolPdfLib.js fetch each one the first time a
// cover, watermark, footer or index page is actually drawn. For a visitor who
// never presses "Create Bundle" the page loads about 1.7s sooner on a slow
// connection. For one who does, the cost of fetching all three only moves (a
// build transfers the same bytes either way), so this warms them during the
// same idle window.
//
// jsPDF and jspdf-autotable are import()ed here, not just fetch()ed: these two
// run on the MAIN THREAD (bundletoolToc.js), so a real click reuses the
// getters' already-resolved promises outright. A fetch()-only prime is slower:
// the vendor files are served no-cache, so a later import() still has to
// revalidate before it can parse (two round trips, not zero). On Fast 3G that
// adds about 505ms to the first click and doubles the time to add a document
// 0.5s after load, because the idle fetch lands just when the add path wants
// its own modules.
//
// fontkit is a fetch()-only prime, not an import(): its only consumer is the
// build/footer worker (its own, separate module realm; see lazy-load.js),
// which pays a real network round trip for it regardless, so warming a copy
// in THIS realm would not help it. The fetch leaves the file in the HTTP cache
// for the worker's own later import() to revalidate against instead of
// fetching cold. It has low fetch priority and starts only once the jsPDF and
// autotable imports above have settled, so it yields rather than competing
// with a document someone adds right after load.
//
// Deliberately not a <link rel="modulepreload">: that would fetch on every
// page load whether or not a bundle is ever built, and this tool is opened
// to re-download an old bundle often enough to matter. requestIdleCallback
// yields to anything the user is actually doing; the setTimeout is the
// fallback for Safari, which has no requestIdleCallback.
(function warmEngine() {
  let started = false;
  const warm = () => {
    if (started) return;
    started = true;
    // A real build already has its own fetches of these same files in flight by now: firing this
    // too would only compete with them for bandwidth on a slow connection, for no benefit.
    if (state.buildStarted) return;
    // Silent: nobody is waiting on a warm-up, and the build path loads both again (and raises the
    // reload notice) if it needs them.
    lazyImport(new URL('./bundletoolMain.js', import.meta.url), { silent: true })
      .then((m) => { state.processTheBundle ||= m.processTheBundle; })
      .catch(() => { /* the build path imports it again; nothing is lost */ });
    lazyImport(new URL('./bundletoolToc.js', import.meta.url), { silent: true })
      .then((m) => Promise.allSettled([m.getJsPdfCtor(), m.getAutoTable()]))
      .catch(() => {})
      .then(() => {
        if (state.buildStarted) return;
        fetch(new URL('/vendor/pdf-lib-fontkit.js', import.meta.url), { priority: 'low' })
          .catch(() => { /* the build/footer worker's own getFontkit() fetches it again, as normal */ });
      });
  };
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
})();

// ── Password eye toggles ──────────────────────────────────────────────────
// One delegated handler for every [data-pw-toggle] on the page, so the bundle
// password and the unlock prompt behave identically and neither has its own
// copy to drift.
//
// It TOGGLES on click. Windows' native reveal is press-and-hold, which cannot
// be operated one-handed, cannot be operated by keyboard at all, and gives no
// way to check a long password against the field while typing the rest.
//
// tabindex="-1" on the button is deliberate: the eye sits between the field
// and the form's next control, and a keyboard user tabbing through a form
// should not be stopped by a display option. It stays clickable, and the
// field itself is where the keyboard belongs.
(function passwordEyes() {
  const sync = (input) => {
    const btn = document.querySelector(`[data-pw-toggle="${input.id}"]`);
    if (btn) btn.hidden = input.value.length === 0;
  };

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && document.querySelector(`[data-pw-toggle="${t.id}"]`)) sync(t);
  });

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-pw-toggle]') : null;
    if (!btn) return;
    e.preventDefault();
    const input = document.getElementById(btn.dataset.pwToggle);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    btn.title = showing ? 'Show password' : 'Hide password';
    btn.querySelector('.pw-eye-open')?.classList.toggle('hidden', !showing);
    btn.querySelector('.pw-eye-shut')?.classList.toggle('hidden', showing);
    // Focus returns to the field with the caret at the end, so revealing does
    // not cost you your place mid-password.
    const pos = input.value.length;
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch (_) {}
  });

  // ── Field clear buttons ─────────────────────────────────────────────────
  // One delegated handler for every [data-clear-target], same shape as the
  // password eyes above: shown only once there is something to clear, and a
  // click empties the field and fires a real 'input' event so autosave and
  // anything else already listening for typing reacts identically to the
  // field being cleared by hand.
  (function fieldClearButtons() {
    const sync = (input) => {
      const btn = document.querySelector(`[data-clear-target="${input.id}"]`);
      if (btn) btn.hidden = input.value.length === 0;
    };

    document.addEventListener('input', (e) => {
      const t = e.target;
      if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && document.querySelector(`[data-clear-target="${t.id}"]`)) sync(t);
    });

    document.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-clear-target]') : null;
      if (!btn) return;
      e.preventDefault();
      const input = document.getElementById(btn.dataset.clearTarget);
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  })();

  // The single-line boxes that can be pulled open (.ce-single: Case Reference,
  // Bundle Title, Parties, Prepared By, and the coversheet editor's four) are
  // textareas so they can grow. Enter must not add a line, and a pasted line break
  // becomes a space, so the value stays one line wherever it goes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof Element && e.target.classList.contains('ce-single')) e.preventDefault();
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLTextAreaElement && t.classList.contains('ce-single') && /[\r\n]/.test(t.value)) {
      t.value = t.value.replace(/\s*[\r\n]+\s*/g, ' ');
    }
  });

  // The unlock prompt is cleared and reused between files, so its eye has to
  // be re-hidden when the field is emptied by code rather than by typing.
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && document.querySelector(`[data-pw-toggle="${t.id}"]`)) sync(t);
  });
})();

// ── Basic Information: header Clear All ────────────────────────────────────
// Hidden until any of the four fields has something typed in it.
// One click clears all four through the same per-field
// data-clear-target buttons frontend.js already wires up above, so autosave
// and the individual clear icons all react exactly as if cleared by hand.
(function basicInfoClearAll() {
  const fieldIds = ['config-claimNumber', 'config-bundleTitle', 'config-projectName', 'config-author'];
  const btn = document.getElementById('basic-info-clear-all-btn');
  if (!btn) return;
  const sync = () => {
    btn.hidden = !fieldIds.some((id) => (document.getElementById(id)?.value.length || 0) > 0);
  };
  document.addEventListener('input', (e) => {
    if (fieldIds.includes(e.target?.id)) sync();
  });
  // Confirms first, as Review Table's own Clear All does.
  btn.addEventListener('click', async () => {
    const modal = document.getElementById('basic-info-clear-modal');
    if (!modal) return;
    const confirmed = await new Promise((resolve) => {
      window._basicInfoClearResolve = resolve;
      modal.classList.remove('hidden');
    });
    if (!confirmed) return;
    fieldIds.forEach((id) => {
      const input = document.getElementById(id);
      if (input && input.value) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    // A new matter starts with a cover that follows Basic Information again: a
    // leftover title or "Prepared by" from the last matter must not reach the next.
    clearCoverOverrides();
  });
  sync();
  // Autosave restore sets .value directly without an 'input' event (see
  // frontend/autosave.js's _set): catch that case once the page settles.
  window.addEventListener('load', sync);
})();

// ── Review Table: header Download and Clear All ────────────────────────────
// Hidden until a document has been added (frontend/reviewTableHeader.js).
setupReviewTableHeader();
