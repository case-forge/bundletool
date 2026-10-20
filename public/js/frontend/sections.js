import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { attachSectionDragHandlers } from './dragdrop.js';
import { ensureEmptyPlaceholder, removeEmptyPlaceholder } from './fileRows.js';
import { getDefaultSection0000 } from './helpers.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { stopReading } from './ocrReading.js';

import { icon } from './icons.js';
import { cleanSectionId, cleanSectionLabel } from './sectionId.js';
import { MAX_SECTIONS, MAX_SECTION_LABEL_CHARS } from './limits.js';
import { openWsCoverModal } from './wsCover.js';
import { lazyImport } from '/js/shared/lazy-load.js';

/** What Add Section, and the picker's "Create new section", say once the bundle holds MAX_SECTIONS sections. */
export const SECTION_LIMIT_TITLE = `A bundle holds up to ${MAX_SECTIONS} sections.`;

/** The sections the Review Table shows: every section with its header row (an unsectioned table has none). */
export function sectionCount() {
  return document.querySelectorAll('.section-tbody .section-header-row').length;
}

export function atSectionLimit() {
  return sectionCount() >= MAX_SECTIONS;
}

/** Add Section is off once the bundle holds MAX_SECTIONS sections, with a title saying why, and on again below it. */
export function refreshAddSection() {
  const full = atSectionLimit();
  document.querySelectorAll('.add-section-btn').forEach((btn) => {
    btn.disabled = full;
    if (full) btn.setAttribute('title', SECTION_LIMIT_TITLE);
    else btn.removeAttribute('title');
  });
}

export function nextSectionLabel() {
  const total = document.querySelectorAll('.section-tbody').length;
  const idx   = state.isSectioned ? total : 0;
  return String.fromCharCode(65 + (idx % 26));
}

/**
 * Build the inner HTML for a section-0000 header row.
 *
 * The label and name are NOT interpolated here: they can come from imported text,
 * which is data. The caller assigns them through .value.
 */
function section0000HeaderHTML() {
  return `
    <td class="px-2 py-2">
      <input type="text" class="section-label-input" placeholder="A" title="Section label, such as A, B or 1" maxlength="${MAX_SECTION_LABEL_CHARS}" />
    </td>
    <td colspan="3" class="px-2 py-2">
      <input type="text" class="section-name-input" placeholder="Type section name" maxlength="500" />
    </td>
    <td class="px-4 py-3 flex gap-2 actions-cell">
      <button type="button" class="section-delete-btn text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition" data-section-id="0000" title="Delete this section" aria-label="Delete this section">${icon('close', 'w-4 h-4 pointer-events-none')}</button>
      <button type="button" class="move-up-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Move section up" aria-label="Move section up">${icon('keyboard_arrow_up', 'w-4 h-4 pointer-events-none')}</button>
      <button type="button" class="move-down-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Move section down" aria-label="Move section down">${icon('keyboard_arrow_down', 'w-4 h-4 pointer-events-none')}</button>
      <button type="button" class="section-add-ws-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Add a witness statement cover page" aria-label="Add a witness statement cover page">${icon('title', 'w-4 h-4 pointer-events-none')}</button>
    </td>`;
}

/** Create and attach the editable header row to section 0000. */
export function createSection0000HeaderRow(section0000, label = 'A', name = '') {
  if (!section0000 || section0000.querySelector('.section-header-row')) return;
  const headerTr = document.createElement('tr');
  headerTr.className = 'section-header-row';
  headerTr.dataset.sectionId = '0000';
  headerTr.innerHTML = section0000HeaderHTML();
  // Setting .value is not held to maxlength, so a label from a layout, a bundle or a saved copy is cut here.
  headerTr.querySelector('.section-label-input').value = cleanSectionLabel(label);
  headerTr.querySelector('.section-name-input').value  = name ?? '';

  headerTr.querySelector('.section-delete-btn')?.addEventListener('click', () => deleteSection(section0000));
  headerTr.querySelector('.section-add-ws-btn')?.addEventListener('click', () => openWsCoverModal(section0000));

  section0000.draggable = true; // always draggable, like file rows
  attachSectionDragHandlers(section0000);
  section0000.insertBefore(headerTr, section0000.firstChild);
}

export function createSectionTbody(rawSectionID, label, name) {
  // The id can come out of a bundle PDF's metadata, a snapshot or a manifest, so it is
  // only ever used once it has passed cleanSectionId (four digits, not already taken).
  const taken = new Set(Array.from(document.querySelectorAll('.section-tbody')).map(el => el.dataset.sectionId));
  const sectionID = cleanSectionId(rawSectionID, taken, state.nextSectionNum);
  const tbody = document.createElement('tbody');
  tbody.className = 'section-tbody bg-white dark:bg-slate-700 divide-y divide-gray-200 dark:divide-slate-700';
  tbody.id = `tbody-section-${sectionID}`;
  tbody.dataset.sectionId = sectionID;
  tbody.draggable = true; // always draggable, like file rows

  // Nothing from outside is interpolated into this markup: the id is checked above, the label
  // and name are assigned through .value below, and the placeholder letter is set as a property.
  tbody.innerHTML = `
    <tr class="section-header-row">
      <td class="px-2 py-2">
        <input type="text" class="section-label-input" title="Section label, such as A, B or 1" maxlength="${MAX_SECTION_LABEL_CHARS}" />
      </td>
      <td colspan="3" class="px-2 py-2">
        <input type="text" class="section-name-input" placeholder="Type section name" maxlength="500" />
      </td>
      <td class="px-4 py-3 flex gap-2 actions-cell">
        <button type="button" class="section-delete-btn text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition" title="Delete this section" aria-label="Delete this section">${icon('close', 'w-4 h-4 pointer-events-none')}</button>
        <button type="button" class="move-up-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Move section up" aria-label="Move section up">${icon('keyboard_arrow_up', 'w-4 h-4 pointer-events-none')}</button>
        <button type="button" class="move-down-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Move section down" aria-label="Move section down">${icon('keyboard_arrow_down', 'w-4 h-4 pointer-events-none')}</button>
        <button type="button" class="section-add-ws-btn text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition" title="Add a witness statement cover page" aria-label="Add a witness statement cover page">${icon('title', 'w-4 h-4 pointer-events-none')}</button>
      </td>
    </tr>`;
  const headerRow = tbody.querySelector('.section-header-row');
  headerRow.dataset.sectionId = sectionID;
  tbody.querySelector('.section-delete-btn').dataset.sectionId = sectionID;
  tbody.querySelector('.section-label-input').placeholder = nextSectionLabel();

  // Setting .value is not held to maxlength, so a label from a layout, a bundle or a saved copy is cut here.
  tbody.querySelector('.section-label-input').value = cleanSectionLabel(label);
  tbody.querySelector('.section-name-input').value  = name ?? '';

  attachSectionDragHandlers(tbody);

  tbody.querySelector('.section-name-input')?.addEventListener('input', (e) => {
    if (e.target.value.trim()) e.target.style.outline = '';
  });

  tbody.querySelector('.section-delete-btn')?.addEventListener('click', () => deleteSection(tbody));
  tbody.querySelector('.section-add-ws-btn')?.addEventListener('click', () => openWsCoverModal(tbody));

  tbody.draggable = true; // always draggable, like file rows

  markDirty({ immediate: true });
  return tbody;
}

/** Adds a section at the end of the Review Table; nothing once the bundle holds MAX_SECTIONS sections. */
export function addSection() {
  if (atSectionLimit()) { refreshAddSection(); return; }
  document.getElementById('file-table-empty')?.classList.add('hidden');
  document.getElementById('file-table-content')?.classList.remove('hidden');

  if (!state.isSectioned) {
    state.isSectioned = true;
    document.getElementById('file-table')?.classList.add('sectioned');
    const section0000 = getDefaultSection0000();
    createSection0000HeaderRow(section0000, 'A', '');
    ensureEmptyPlaceholder(section0000 ?? getDefaultSection0000());
    document.getElementById('file-table')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refreshAddSection();
    markDirty({ immediate: true });
    return;
  }

  const sectionID = String(state.nextSectionNum++).padStart(4, '0');
  const table     = document.querySelector('#file-table table');
  // The letter goes in as the label's value, as section A's does, rather than
  // sitting behind it as a grey placeholder, so A and B look like the same kind
  // of box. An empty label falls back to the same letter anyway.
  const tbody     = createSectionTbody(sectionID, nextSectionLabel(), '');
  table?.appendChild(tbody);
  ensureEmptyPlaceholder(tbody);
  refreshAddSection();
  markDirty({ immediate: true });
}

// ─── Delete section ───────────────────────────────────────────────────────────

function buildSectionPickerList(excludeTbody) {
  const list = document.getElementById('delete-section-picker-list');
  if (!list) return;
  list.innerHTML = '';
  document.querySelectorAll('.section-tbody').forEach(t => {
    if (t === excludeTbody) return;
    const labelEl = t.querySelector('.section-label-input');
    const label   = labelEl?.value.trim() || labelEl?.placeholder || '';
    const name    = t.querySelector('.section-name-input')?.value.trim() || '';
    const display = (label && name) ? `${label}: ${name}` : (name || label || '(unnamed)');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bt-hover-line bt-hover-tint transition text-sm text-gray-800 dark:text-slate-200';
    btn.textContent = display;
    btn.addEventListener('click', () => {
      document.getElementById('delete-section-modal')?.classList.add('hidden');
      document.getElementById('delete-section-step1')?.classList.remove('hidden');
      document.getElementById('delete-section-step2')?.classList.add('hidden');
      window._deleteSectionResolve?.({ action: 'move', targetTbody: t });
    });
    list.appendChild(btn);
  });
}

function showDeleteSectionModal(tbody) {
  buildSectionPickerList(tbody);
  // "Remove the section only" keeps documents where they sit, which for any
  // later section means joining the one above. Section 0000 with other
  // sections still present has no section above: its documents would become
  // unsectioned rows ahead of labelled sections, a shape the index cannot
  // describe. Offer it for 0000 only when it is the last section standing.
  const otherSections = document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').length > 0;
  document.getElementById('delete-section-keep-btn')
    ?.classList.toggle('hidden', tbody.id === 'tbody-section-0000' && otherSections);
  const fileCount = tbody.querySelectorAll('tr.file-row').length;
  const msg = document.getElementById('delete-section-msg');
  if (msg) msg.textContent = `This section contains ${fileCount} file${fileCount === 1 ? '' : 's'}. What would you like to do with them?`;
  document.getElementById('delete-section-step1')?.classList.remove('hidden');
  document.getElementById('delete-section-step2')?.classList.add('hidden');
  return new Promise(resolve => {
    window._deleteSectionResolve = resolve;
    document.getElementById('delete-section-modal')?.classList.remove('hidden');
  });
}

export async function deleteSection(tbody) {
  const fileRows = Array.from(tbody.querySelectorAll('tr.file-row'));
  if (fileRows.length > 0) {
    const result = await showDeleteSectionModal(tbody);
    if (result.action === 'cancel') return;
    if (result.action === 'headerOnly') {
      // The header goes, the documents stay where they sat. For any section
      // after the first that means joining the section above, whose rows end
      // exactly where this one's begin, so nothing moves on screen. Section
      // 0000 needs no move at all: only its header row is removed below.
      if (tbody.id !== 'tbody-section-0000') {
        const prev = tbody.previousElementSibling;
        if (prev?.classList.contains('section-tbody')) {
          removeEmptyPlaceholder(prev);
          fileRows.forEach(row => prev.appendChild(row));
        }
      }
    } else if (result.action === 'move') {
      const target = result.targetTbody;
      removeEmptyPlaceholder(target);
      fileRows.forEach(row => target.appendChild(row));
    } else {
      fileRows.forEach(row => {
        const fn = row.dataset.filename;
        if (fn) { stopReading(fn); state.filesMap.delete(fn); delete state.frontendInputData[fn]; }
        row.remove();
      });
    }
  }

  if (tbody.id === 'tbody-section-0000') {
    tbody.querySelector('.section-header-row')?.remove();
    removeEmptyPlaceholder(tbody);
  } else {
    tbody.remove();
  }

  const hasAnySection = document.querySelector('.section-tbody .section-header-row') !== null;
  if (!hasAnySection) {
    state.isSectioned = false;
    document.getElementById('file-table')?.classList.remove('sectioned');
  }
  // Harmless when the section's documents merged or moved rather than being deleted: the total is
  // unchanged either way, and this is the one place every path through deleteSection ends.
  refreshBundleTotals();
  refreshAddSection();
  markDirty({ immediate: true });
}

// ─── Section picker (for main add-files button while sectioned) ───────────────

export function showSectionPicker(files) {
  const popover = document.getElementById('section-picker-popover');
  const list    = document.getElementById('section-picker-list');
  if (!popover || !list) return;
  list.innerHTML = '';

  document.querySelectorAll('.section-tbody').forEach(tbody => {
    const labelEl = tbody.querySelector('.section-label-input');
    const label   = labelEl?.value.trim() || labelEl?.placeholder || '';
    const name    = tbody.querySelector('.section-name-input')?.value.trim() || '';
    const display = (label && name) ? `${label}: ${name}` : (name || label || '(unnamed)');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bt-hover-line bt-hover-tint transition text-sm font-medium bt-ink';
    btn.textContent = display;
    btn.addEventListener('click', async () => {
      popover.classList.add('hidden');
      const { processFiles } = await lazyImport(new URL('./fileProcessing.js', import.meta.url));
      try { await processFiles(files, tbody); }
      catch (err) {
        const { showErrorModal } = await lazyImport(new URL('./modals.js', import.meta.url));
        showErrorModal({ code: 'BT-ADD-02', title: 'Error adding files', message: 'An unexpected error occurred while adding files.', error: err });
      }
    });
    list.appendChild(btn);
  });

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'w-full text-left px-3 py-2 rounded-lg border border-dashed bt-line-soft bt-hover-tint bt-ink text-sm transition';
  newBtn.textContent = '+ Create new section';
  // At the section limit the choice stays in the list, off, saying why, as Add Section does.
  if (atSectionLimit()) {
    newBtn.disabled = true;
    newBtn.setAttribute('title', SECTION_LIMIT_TITLE);
  }
  newBtn.addEventListener('click', async () => {
    if (atSectionLimit()) return;
    popover.classList.add('hidden');
    addSection();
    const newTbody = document.querySelector('.section-tbody:last-of-type');
    const { processFiles } = await lazyImport(new URL('./fileProcessing.js', import.meta.url));
    try { if (newTbody) await processFiles(files, newTbody); }
    catch (err) {
      const { showErrorModal } = await lazyImport(new URL('./modals.js', import.meta.url));
      showErrorModal({ code: 'BT-ADD-03', title: 'Error adding files', message: 'An unexpected error occurred while adding files.', error: err });
    }
  });
  list.appendChild(newBtn);
  popover.classList.remove('hidden');
}

export function setup() {
  document.querySelectorAll('.add-section-btn').forEach(btn => btn.addEventListener('click', addSection));
  document.getElementById('section-picker-cancel')?.addEventListener('click', () => {
    document.getElementById('section-picker-popover')?.classList.add('hidden');
  });
  // Adding and deleting a section refresh Add Section themselves; this catches every other way the sections change
  // (a layout or manifest imported, a bundle reopened, a saved copy restored, the table cleared).
  const table = document.querySelector('#file-table table');
  if (table && typeof MutationObserver === 'function') {
    new MutationObserver(refreshAddSection).observe(table, { childList: true, subtree: true });
  }
  refreshAddSection();
}
