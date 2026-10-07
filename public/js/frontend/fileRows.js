import { state } from './state.js';
import { markDirty, deleteThisTabsSnapshots } from '../bundletoolAutosave.js';
import { markTableCleared } from './autoRestore.js';
import { IndexData } from '../bundletoolIndexData.js';
import { handleDragStart, handleFileDragOver, handleFileDrop, handleDragEnd } from './dragdrop.js';
import { getAllSectionTbodys } from './helpers.js';
import { prettifyTitle, stripDoubleChars } from './utils.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { lazyImport } from '/js/shared/lazy-load.js';

import { icon } from './icons.js';
import { ocrBadgeTitle } from './ocrReorient.js';
import { readingEntry, readingBadgeText, readingBadgeTitle, onReadingChange, skipReading, stopReading, stopAllReading } from './ocrReading.js';

// ─── Empty-section placeholders ──────────────────────────────────────────────

export function ensureEmptyPlaceholder(tbody) {
  if (!tbody) return;
  if (tbody.querySelector('tr.file-row')) return;
  if (tbody.querySelector('.empty-section-placeholder')) return;
  const tr = document.createElement('tr');
  tr.className = 'empty-section-placeholder';
  tr.innerHTML = `<td colspan="5" class="px-4 py-4 text-center text-sm text-gray-400 italic select-none">[empty: drag documents here]</td>`;
  tr.addEventListener('dragover', (e) => { if (state.draggedRow) { e.preventDefault(); e.stopPropagation(); } });
  tr.addEventListener('drop', (e) => {
    if (!state.draggedRow) return;
    e.preventDefault(); e.stopPropagation();
    removeEmptyPlaceholder(tbody);
    tbody.appendChild(state.draggedRow);
    state.draggedRow = null;
    markDirty({ immediate: true });
  });
  tbody.appendChild(tr);
}

export function removeEmptyPlaceholder(tbody) {
  tbody?.querySelector('.empty-section-placeholder')?.remove();
}

// ─── Build a file-row <tr> ────────────────────────────────────────────────────

/**
 * The four actions on a document row, in order: Remove, Move up, Move down, and the eye that opens the document
 * window (rotate.js), where the document is paged through, turned and read again with Force OCR. `name` is what each
 * button says about the document it belongs to (see labelRowActions).
 */
export const ROW_ACTIONS = Object.freeze([
  { cls: 'delete-row-btn', icon: 'close', title: 'Remove from bundle', name: (f) => `Remove ${f} from bundle`,
    tone: 'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300' },
  { cls: 'move-up-btn', icon: 'keyboard_arrow_up', title: 'Move up', name: (f) => `Move ${f} up` },
  { cls: 'move-down-btn', icon: 'keyboard_arrow_down', title: 'Move down', name: (f) => `Move ${f} down` },
  { cls: 'preview-row-btn', icon: 'visibility', title: 'Preview', name: (f) => `Preview ${f}`, titleNames: true },
]);

const QUIET_TONE = 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200';

/** The actions cell's buttons. No file name goes into this markup: labelRowActions sets those through the DOM. */
export function rowActionsMarkup() {
  return ROW_ACTIONS.map((a) => `<button type="button" class="${a.cls} ${a.tone ?? QUIET_TONE} transition" data-filename="" title="${a.title}" aria-label="${a.title}">${icon(a.icon, 'w-4 h-4 pointer-events-none')}</button>`).join('\n      ');
}

/**
 * Names the document in each action's aria-label, and in the eye's title as well ("Preview <name>"). Without this a
 * screen reader hears the same "Move up" on every row and cannot tell which one it is on.
 */
export function labelRowActions(row, filename) {
  for (const a of ROW_ACTIONS) {
    const button = row.querySelector(`.${a.cls}`);
    if (!button) continue;
    button.setAttribute('aria-label', a.name(filename));
    if (a.titleNames) button.setAttribute('title', a.name(filename));
  }
}

export function makeFileRow(filename, data) {
  const row = document.createElement('tr');
  row.draggable = true;   // drag works from anywhere in the row, with no
  // separate handle; the up/down buttons are the pointer and keyboard alternative
  row.dataset.filename = filename;
  // Hover colour comes from BundleTool's stylesheet (with its dark
  // counterpart), not a Tailwind utility here: hover:bg-gray-50 has no dark
  // variant and would flash a light background into a dark table.
  row.classList.add('file-row', 'transition');
  row.innerHTML = `
    <td class="px-4 py-3 text-sm filename-cell" data-label="File"></td>
    <td class="px-4 py-3 title-cell" data-label="Title">
      <textarea aria-label="Document title" class="title-input w-full px-2 py-1 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 border border-gray-300 dark:border-slate-600 rounded text-sm bt-focus-ring" data-filename="" rows="1" maxlength="500"></textarea>
    </td>
    <td class="px-4 py-3 date-cell" data-label="Date">
      <input type="date" aria-label="Document date" class="date-input w-full px-2 py-1 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 border border-gray-300 dark:border-slate-600 rounded text-sm bt-focus-ring" data-filename="" />
    </td>
    <td class="px-2 py-3 text-sm text-center pages-cell" data-label="Pages"></td>
    <td class="px-4 py-3 flex gap-2 actions-cell" data-label="">
      ${rowActionsMarkup()}
    </td>`;
  row.querySelector('.filename-cell').textContent = filename;
  // Name the DOCUMENT in each label. Without this a screen reader reads
  // "Document title, edit text" identically on all 200 rows, which locates
  // nothing; with it, the row announces which file it is editing.
  row.querySelector('.title-input')?.setAttribute('aria-label', `Title for ${filename}`);
  labelRowActions(row, filename);
  row.querySelector('.date-input')?.setAttribute('aria-label', `Date for ${filename}`);
  // A recovered document is visibly marked in the file table as well as in the
  // bundle index, so it stays flagged while the bundle is being assembled and
  // not only after it is built.
  if (data.recovered) {
    row.classList.add('recovered-row');
    const badge = document.createElement('span');
    badge.className = 'ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 align-middle';
    badge.title = data.recoveryNote || 'Recovered from a damaged file. Check it against the original';
    badge.textContent = 'recovered';
    row.querySelector('.filename-cell').appendChild(badge);
  }
  // Converted in the browser from a .docx (mammoth, then jsPDF), not a
  // like-for-like copy of the Word layout: fonts and sizes are flattened to
  // one fixed typeface, and headers, footers and manual page breaks are
  // dropped. Tables, lists, images and bold and italic runs carry over.
  if (data.convertedFromDocx) {
    const badge = document.createElement('span');
    badge.className = 'bt-badge-converted';
    badge.title = 'Converted from a Word document. Fonts, headers, footers and manual page breaks are not carried over. Check the converted pages against the original before relying on them in the bundle.';
    badge.textContent = 'converted';
    row.querySelector('.filename-cell').appendChild(badge);
  }
  // OCR has already been applied (automatically on add, or by Force OCR): the document's text is
  // selectable and searchable now. Its pages still look exactly as they did, unless Turn sideways scanned pages
  // upright or Straighten tilted scanned pages changed some, which the tooltip then names (ocrBadgeTitle).
  if (data.ocrApplied) {
    const badge = document.createElement('span');
    badge.className = 'bt-badge-ocr';
    badge.title = ocrBadgeTitle(data);
    badge.textContent = 'OCR';
    row.querySelector('.filename-cell').appendChild(badge);
  }
  // Redaction markers that were never applied: the text under them can still be read.
  if (data.redactedPages?.length) {
    const badge = document.createElement('span');
    badge.className = 'bt-badge-redaction';
    badge.title = 'This document has redaction markers that have not been applied, so the text underneath can still be read. Apply the redactions in your PDF editor and add the file again.';
    badge.textContent = 'redaction not applied';
    row.querySelector('.filename-cell').appendChild(badge);
  }
  // A document whose text is being read, or waits to be, when its row is made (a restored or reordered table).
  renderReadingBadge(row.querySelector('.filename-cell'), filename);
  row.querySelector('.title-input').value  = data.title    || '';
  row.querySelector('.date-input').value   = data.date     || '';
  row.querySelector('.pages-cell').textContent = data.pageCount ?? '';
  row.querySelectorAll('[data-filename]').forEach(el => el.dataset.filename = filename);
  row.addEventListener('dragstart', handleDragStart);
  row.addEventListener('dragover',  handleFileDragOver);
  row.addEventListener('drop',      handleFileDrop);
  row.addEventListener('dragend',   handleDragEnd);
  return row;
}

/**
 * Adds the OCR badge to a row after the fact: the automatic per-page check runs in the
 * background once a file is already in the table, so unlike `recovered`/`convertedFromDocx` this
 * cannot be known at makeFileRow() time. A no-op if the row is gone (the file was removed while
 * OCR was still running); a row that already carries the badge keeps it, with its tooltip brought
 * up to date with the latest reading.
 * @param {string} filename
 */
export function setOcrBadge(filename) {
  const row = document.querySelector(`tr.file-row[data-filename="${CSS.escape(filename)}"]`);
  const cell = row?.querySelector('.filename-cell');
  if (!cell) return;
  const title = ocrBadgeTitle(state.frontendInputData[filename]);
  const existing = cell.querySelector('.bt-badge-ocr');
  if (existing) { existing.title = title; return; }
  const badge = document.createElement('span');
  badge.className = 'bt-badge-ocr';
  badge.title = title;
  badge.textContent = 'OCR';
  cell.appendChild(badge);
}

/**
 * The "Reading text…" badge (or "Waiting to read", for a document whose turn has not come) with its Skip button, in
 * the same place and the same size and style as the OCR badge, which takes its place once the text is read. A row
 * whose document needs nothing read shows neither. Skip stops reading that one document (ocrReading.js skipReading).
 */
function renderReadingBadge(cell, filename) {
  if (!cell) return;
  const entry = readingEntry(filename);
  const text = readingBadgeText(entry);
  let badge = cell.querySelector('.bt-badge-reading');
  if (!text) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'bt-badge-reading';
    const label = document.createElement('span');
    label.className = 'bt-badge-reading-label';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'bt-badge-skip';
    skip.textContent = 'Skip';
    skip.setAttribute('aria-label', `Skip reading the text of ${filename}`);
    skip.title = 'Stop reading this document. It goes into the bundle as it is; Force OCR in its window reads it later.';
    // Drag starts from anywhere in the row; a press on Skip must stay a press.
    skip.draggable = false;
    skip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); skipReading(filename); });
    badge.appendChild(label);
    badge.appendChild(skip);
    cell.appendChild(badge);
  }
  badge.classList.toggle('bt-badge-reading--waiting', entry.status === 'waiting');
  badge.title = readingBadgeTitle(entry);
  const label = badge.querySelector('.bt-badge-reading-label');
  if (label && label.textContent !== text) label.textContent = text;
}

/**
 * Brings one row's reading badge up to date (or every row's, for null). A no-op for a row not in the table yet (the
 * row batcher may still hold it back): the add path calls this again once it is inserted, and makeFileRow() draws the
 * badge for a row made while its document is being read.
 * @param {string|null} filename
 */
export function setReadingBadge(filename) {
  if (typeof document === 'undefined') return;
  if (filename === null) {
    const names = new Set(state.ocrReading.keys());
    for (const badge of document.querySelectorAll('.bt-badge-reading')) {
      const name = badge.closest('tr.file-row')?.dataset.filename;
      if (name) names.add(name);
    }
    for (const name of names) setReadingBadge(name);
    return;
  }
  const row = document.querySelector(`tr.file-row[data-filename="${CSS.escape(filename)}"]`);
  renderReadingBadge(row?.querySelector('.filename-cell'), filename);
}

onReadingChange(setReadingBadge);

// ─── Build IndexData from current DOM ────────────────────────────────────────

export function buildIndexData() {
  const sections = [];
  getAllSectionTbodys().forEach(tbody => {
    const sectionID  = tbody.dataset.sectionId;
    const headerRow  = tbody.querySelector('.section-header-row');
    const labelEl    = headerRow?.querySelector('.section-label-input');
    const sectionLabel = labelEl?.value.trim() || labelEl?.placeholder || '';
    const sectionName  = headerRow?.querySelector('.section-name-input')?.value.trim() ?? '';
    const files = [];
    tbody.querySelectorAll('tr.file-row').forEach(row => {
      const fn = row.dataset.filename;
      if (fn && state.frontendInputData[fn]) {
        const info = state.frontendInputData[fn];
        files.push({
          filename:  fn,
          title:     info.title,
          date:      info.date || '',
          pageCount: info.pageCount,
          // Carried so the index can mark it and the bundle metadata can
          // record it; both drop the field entirely when it is not set.
          ...(info.recovered ? { recovered: true, recoveryNote: info.recoveryNote || '' } : {}),
          ...(info.convertedFromDocx ? { convertedFromDocx: true } : {}),
        });
      }
    });
    sections.push({ sectionID, sectionLabel, sectionName, files });
  });
  // In sectioned mode, redesignate 0000 → 0001 so downstream sectionID === '0000' guards
  // treat it as a real section (not the null placeholder).
  if (state.isSectioned) {
    sections.forEach((s, i) => { s.sectionID = String(i + 1).padStart(4, '0'); });
  }
  return new IndexData(sections);
}

// ─── File-table delegated event handlers ─────────────────────────────────────

export function setup() {
  document.getElementById('file-table')?.addEventListener('input', (e) => {
    const target = e.target;
    if (target.classList.contains('title-input')) {
      const filename = target.getAttribute('data-filename');
      if (state.frontendInputData[filename]) { state.frontendInputData[filename].title = target.value; markDirty(); }
    }
    if (target.classList.contains('date-input')) {
      const filename = target.getAttribute('data-filename');
      if (state.frontendInputData[filename]) { state.frontendInputData[filename].date = target.value; markDirty(); }
    }
  });

  // A blank title reaches generation as a hard failure ("title must be a
  // non-empty string") with no indication of which row or how to fix it.
  // Clearing mid-edit is fine; leaving the field empty is not, so it falls
  // back to the title derived from the filename, as for a freshly added file.
  document.getElementById('file-table')?.addEventListener('focusout', (e) => {
    const target = e.target;
    if (!target.classList.contains('title-input')) return;
    if (target.value.trim() !== '') return;
    const filename = target.getAttribute('data-filename');
    if (!state.frontendInputData[filename]) return;
    const fallback = stripDoubleChars(prettifyTitle(filename));
    target.value = fallback;
    state.frontendInputData[filename].title = fallback;
    markDirty();
  });

  document.getElementById('file-table')?.addEventListener('click', (e) => {
    // Buttons hold SVG icons, so the click target is often the icon, not the
    // button. Every branch resolves through closest() for that reason.
    // Move up
    if (e.target.closest('.move-up-btn')) {
      const row = e.target.closest('tr');
      if (!row) return;
      if (row.classList.contains('section-header-row')) {
        const tbody = row.closest('tbody');
        const prev  = tbody?.previousElementSibling;
        if (prev && prev.id !== 'tbody-section-0000' && prev.classList.contains('section-tbody')) {
          tbody.parentNode.insertBefore(tbody, prev);
          markDirty({ immediate: true });
        }
        return;
      }
      const prev = row.previousElementSibling;
      if (prev && !prev.classList.contains('section-header-row') && !prev.classList.contains('empty-section-placeholder')) {
        row.parentNode.insertBefore(row, prev);
      } else {
        const tbody     = row.closest('tbody');
        const prevTbody = tbody?.previousElementSibling;
        if (prevTbody?.classList.contains('section-tbody')) {
          removeEmptyPlaceholder(prevTbody);
          prevTbody.appendChild(row);
          ensureEmptyPlaceholder(tbody);
        }
      }
      markDirty({ immediate: true });
      return;
    }

    // Move down
    if (e.target.closest('.move-down-btn')) {
      const row = e.target.closest('tr');
      if (!row) return;
      if (row.classList.contains('section-header-row')) {
        const tbody = row.closest('tbody');
        const next  = tbody?.nextElementSibling;
        if (next?.classList.contains('section-tbody')) {
          tbody.parentNode.insertBefore(next, tbody);
          markDirty({ immediate: true });
        }
        return;
      }
      const next = row.nextElementSibling;
      if (next && !next.classList.contains('empty-section-placeholder')) {
        row.parentNode.insertBefore(next, row);
      } else {
        const tbody     = row.closest('tbody');
        const nextTbody = tbody?.nextElementSibling;
        if (nextTbody?.classList.contains('section-tbody')) {
          removeEmptyPlaceholder(nextTbody);
          const afterHeader = nextTbody.querySelector('.section-header-row')?.nextSibling || nextTbody.firstChild;
          nextTbody.insertBefore(row, afterHeader);
          ensureEmptyPlaceholder(tbody);
        }
      }
      markDirty({ immediate: true });
      return;
    }

    // The eye opens the document window (rotate.js). It is loaded on first use, so the page pays nothing for it,
    // or for pdf.js and the OCR engine behind it, until someone opens a document.
    const previewBtn = e.target.closest('.preview-row-btn');
    if (previewBtn) {
      const filename = previewBtn.getAttribute('data-filename');
      if (filename && state.filesMap.has(filename)) {
        lazyImport(new URL('./rotate.js', import.meta.url)).then(({ openDocumentWindow }) => openDocumentWindow(filename, previewBtn));
      }
      return;
    }

    // Delete file row
    const deleteBtn = e.target.closest('.delete-row-btn');
    if (deleteBtn) {
      const filename = deleteBtn.getAttribute('data-filename');
      stopReading(filename);
      state.filesMap.delete(filename);
      delete state.frontendInputData[filename];
      const row   = deleteBtn.closest('tr');
      const tbody = row?.closest('tbody');
      row.remove();
      if (tbody) ensureEmptyPlaceholder(tbody);
      refreshBundleTotals();
      markDirty({ immediate: true });
    }
  });

  // Clear all rows
  document.getElementById('clear-all-rows-btn')?.addEventListener('click', () => {
    new Promise(resolve => {
      window._clearAllResolve = resolve;
      document.getElementById('clear-all-modal')?.classList.remove('hidden');
    }).then(confirmed => {
      if (!confirmed) return;
      markTableCleared();   // so the last save is not restored on the next load
      // ...and this tab's saved working copies go too: they hold full copies of the documents, and
      // "clear" on a shared computer has to mean cleared. Other tabs' copies and finished bundles are
      // kept; "Delete all saved copies" (Rewind, Bundles) removes everything.
      deleteThisTabsSnapshots().catch((err) => console.warn('[clear all] could not delete the saved copies:', err?.message));
      stopAllReading();
      state.filesMap.clear();
      Object.keys(state.frontendInputData).forEach(key => delete state.frontendInputData[key]);
      document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').forEach(el => el.remove());
      const section0000 = document.getElementById('tbody-section-0000');
      if (section0000) section0000.innerHTML = '';
      state.isSectioned    = false;
      state.nextSectionNum = 1;
      document.getElementById('file-table')?.classList.remove('sectioned');
      refreshBundleTotals();
    });
  });
}
