/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * reviewTableHeader.js
 * The Review Table's header buttons, Download and Clear All: hidden while the table holds no document and shown as
 * soon as it holds one. Rows come and go from several places (drag and drop, Add Documents, a section import, a
 * restore, Remove), so one MutationObserver on the table follows all of them rather than each place keeping the
 * buttons in step itself. Download opens its picker, loaded on first use (documentDownload.js).
 */
import { lazyImport } from '/js/shared/lazy-load.js';

/** The buttons that only mean something once there is a document. */
export const HEADER_BUTTONS = Object.freeze(['download-docs-btn', 'clear-all-rows-btn']);

/**
 * Shows the header buttons when the table holds at least one document and hides them when it holds none. The
 * tutorial's example rows are not documents (they carry tutorial-row, not file-row), so they show nothing; the
 * tutorial shows the Download button itself while its Review Table step is on screen (data-tutorial-demo).
 * @returns {boolean} whether there is a document
 */
export function syncReviewTableHeader(doc = document) {
  const any = doc.querySelectorAll('.section-tbody tr.file-row').length > 0;
  for (const id of HEADER_BUTTONS) {
    const button = doc.getElementById(id);
    if (button) button.hidden = !any && button.dataset.tutorialDemo !== 'true';
  }
  return any;
}

export function setupReviewTableHeader(doc = document) {
  const table = doc.querySelector('#file-table tbody')?.closest('table');
  if (!table) return;
  new MutationObserver(() => syncReviewTableHeader(doc)).observe(table, { childList: true, subtree: true });
  syncReviewTableHeader(doc);
  const download = doc.getElementById('download-docs-btn');
  download?.addEventListener('click', () => {
    lazyImport(new URL('./documentDownload.js', import.meta.url)).then(({ openDownloadPicker }) => openDownloadPicker(download));
  });
}
