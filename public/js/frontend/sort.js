import { markDirty } from '../bundletoolAutosave.js';

export function sortRowsBy(rows, col, dir) {
  rows.sort((a, b) => {
    let aVal, bVal;
    if (col === 'filename') {
      aVal = a.dataset.filename || '';
      bVal = b.dataset.filename || '';
    } else if (col === 'title') {
      aVal = a.querySelector('.title-input')?.value || '';
      bVal = b.querySelector('.title-input')?.value || '';
    } else if (col === 'date') {
      aVal = a.querySelector('.date-input')?.value || '';
      bVal = b.querySelector('.date-input')?.value || '';
    } else if (col === 'pages') {
      return dir === 'asc'
        ? (parseInt(a.querySelector('.pages-cell')?.textContent || '0') - parseInt(b.querySelector('.pages-cell')?.textContent || '0'))
        : (parseInt(b.querySelector('.pages-cell')?.textContent || '0') - parseInt(a.querySelector('.pages-cell')?.textContent || '0'));
    }
    const cmp = (aVal || '').localeCompare(bVal || '', undefined, { sensitivity: 'base', numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

export function sortSection(tbody, col, dir) {
  const fileRows = Array.from(tbody.querySelectorAll('tr.file-row'));
  sortRowsBy(fileRows, col, dir);
  fileRows.forEach(row => tbody.appendChild(row));
  markDirty({ immediate: true });
}

