import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { lazyImport } from '/js/shared/lazy-load.js';

// ─── Section drag-and-drop ────────────────────────────────────────────────────

export function handleSectionDragStart(e) {
  if (!this.draggable) { e.preventDefault(); return; }
  state.draggedSection = this;
  state.draggedRow = null;
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
  this.style.opacity = '0.5';
}

export function handleSectionDragOver(e) {
  if (state.draggedSection && state.draggedSection !== this && this.id !== 'tbody-section-0000') {
    e.preventDefault();
    e.stopPropagation();
    this.classList.add('drag-over-section');
  } else if (state.draggedRow && !state.draggedSection) {
    e.preventDefault();
    e.stopPropagation();
  }
}

export function handleSectionDrop(e) {
  if (state.draggedSection && state.draggedSection !== this && this.id !== 'tbody-section-0000') {
    e.preventDefault();
    e.stopPropagation();
    this.classList.remove('drag-over-section');
    const table    = this.parentNode;
    const allTbodys = Array.from(table.querySelectorAll('.section-tbody'));
    const fromIdx  = allTbodys.indexOf(state.draggedSection);
    const toIdx    = allTbodys.indexOf(this);
    if (fromIdx < toIdx) table.insertBefore(state.draggedSection, this.nextSibling);
    else                 table.insertBefore(state.draggedSection, this);
    markDirty({ immediate: true });
  } else if (state.draggedRow && !state.draggedSection) {
    e.preventDefault();
    e.stopPropagation();
    this.classList.remove('drag-over-section');
    this.appendChild(state.draggedRow);
    markDirty({ immediate: true });
  }
}

export function handleSectionDragEnd() {
  this.draggable = false;
  this.style.opacity = '1';
  document.querySelectorAll('.section-tbody').forEach(t => t.classList.remove('drag-over-section'));
  state.draggedSection = null;
}

// ─── File-row drag-and-drop ───────────────────────────────────────────────────

export function handleDragStart(e) {
  state.draggedRow     = this;
  state.draggedSection = null;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
  e.stopPropagation();
  this.style.opacity = '0.4';
}

export function handleFileDragOver(e) {
  if (!state.draggedRow) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
}

export function handleFileDrop(e) {
  if (!state.draggedRow || state.draggedRow === this) return;
  e.preventDefault();
  e.stopPropagation();
  const sourceTbody = state.draggedRow.closest('tbody');

  // Capture before async: handleDragEnd fires synchronously after drop and nulls state.draggedRow
  const draggedRow = state.draggedRow;

  if (this.classList.contains('section-header-row')) {
    const targetTbody = this.closest('tbody');
    lazyImport(new URL('./fileRows.js', import.meta.url)).then(({ removeEmptyPlaceholder, ensureEmptyPlaceholder }) => {
      removeEmptyPlaceholder(targetTbody);
      targetTbody.appendChild(draggedRow);
      if (sourceTbody && sourceTbody !== targetTbody) ensureEmptyPlaceholder(sourceTbody);
      markDirty({ immediate: true });
    });
    return;
  }

  const myTbody = this.closest('tbody');
  if (myTbody === sourceTbody) {
    const allRows     = Array.from(myTbody.querySelectorAll('tr.file-row'));
    const draggedIndex = allRows.indexOf(draggedRow);
    const targetIndex  = allRows.indexOf(this);
    if (draggedIndex < targetIndex) myTbody.insertBefore(draggedRow, this.nextSibling);
    else                            myTbody.insertBefore(draggedRow, this);
  } else {
    lazyImport(new URL('./fileRows.js', import.meta.url)).then(({ removeEmptyPlaceholder, ensureEmptyPlaceholder }) => {
      removeEmptyPlaceholder(myTbody);
      const allRows     = Array.from(myTbody.querySelectorAll('tr.file-row'));
      const targetIndex = allRows.indexOf(this);
      if (targetIndex < 0) myTbody.appendChild(draggedRow);
      else                 myTbody.insertBefore(draggedRow, this);
      ensureEmptyPlaceholder(sourceTbody);
    });
  }
  markDirty({ immediate: true });
}

export function handleDragEnd() {
  this.style.opacity = '1';
  state.draggedRow = null;
}

/** Attach section-level drag handlers to a newly created section tbody. */
export function attachSectionDragHandlers(tbody) {
  tbody.addEventListener('dragstart', handleSectionDragStart);
  tbody.addEventListener('dragover',  handleSectionDragOver);
  tbody.addEventListener('drop',      handleSectionDrop);
  tbody.addEventListener('dragend',   handleSectionDragEnd);
}
