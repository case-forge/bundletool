/**
 * Where files dragged in from outside the page land in the Review Table.
 *
 * Dropped on a row, they go in at that row: before it when the pointer is in its upper half, after
 * it in its lower half. Dropped on a section's header they go to the start of that section, on its
 * empty-section line they replace it, and on any other part of a section they go to its end. Several
 * files keep the order they were dropped in, because each is inserted before the same row.
 */

/** 'before' when the pointer is in the upper half of the box, 'after' in the lower half. */
export function sideOfBox(top, height, clientY) {
  return clientY > top + height / 2 ? 'after' : 'before';
}

/**
 * @param {Element|null} target  what is under the pointer
 * @param {number} clientY
 * @returns {null | {tbody: HTMLElement, row: HTMLElement|null, side: 'before'|'after'|'start'|'end'|'replace', before: Element|null}}
 *   null when the pointer is not over a section at all. `before` is the row the new rows go in front
 *   of, or null to add them at the end.
 */
export function resolveDrop(target, clientY) {
  const tbody = target?.closest?.('.section-tbody') ?? null;
  if (!tbody) return null;
  const row = target.closest('tr');
  if (row && row.classList.contains('file-row') && row.parentNode === tbody) {
    const rect = row.getBoundingClientRect();
    const side = sideOfBox(rect.top, rect.height, clientY);
    return { tbody, row, side, before: side === 'before' ? row : row.nextElementSibling };
  }
  if (row && row.classList.contains('section-header-row') && row.parentNode === tbody) {
    return { tbody, row, side: 'start', before: tbody.querySelector('tr.file-row') };
  }
  if (row && row.classList.contains('empty-section-placeholder')) {
    return { tbody, row, side: 'replace', before: null };
  }
  return { tbody, row: null, side: 'end', before: null };
}

const LINE_ID = 'bt-drop-line';

function dropLine() {
  let line = document.getElementById(LINE_ID);
  if (!line) {
    line = document.createElement('div');
    line.id = LINE_ID;
    line.className = 'bt-drop-line';
    line.setAttribute('aria-hidden', 'true');
    document.body.appendChild(line);
  }
  return line;
}

/**
 * Draws the insertion indicator for a resolved drop, and clears the previous one. The line above or
 * below a row is one fixed-position element laid over the row's edge, so it never changes the layout
 * of the table (a border or a taller row would), whatever the row's cells are doing. A drop on a
 * section as a whole (its heading, its empty line, the gap after its rows) outlines the section.
 */
export function showDropIndicator(drop) {
  clearDropIndicator();
  if (!drop) return;
  if ((drop.side === 'before' || drop.side === 'after') && drop.row) {
    const rect = drop.row.getBoundingClientRect();
    const line = dropLine();
    line.style.left = `${rect.left}px`;
    line.style.width = `${rect.width}px`;
    line.style.top = `${(drop.side === 'before' ? rect.top : rect.bottom) - 1.5}px`;
    line.dataset.side = drop.side;
    line.hidden = false;
  } else {
    drop.tbody.classList.add('drag-over-section');
  }
}

export function clearDropIndicator() {
  const line = document.getElementById(LINE_ID);
  if (line) line.hidden = true;
  document.querySelectorAll('.section-tbody.drag-over-section').forEach((el) => el.classList.remove('drag-over-section'));
}
