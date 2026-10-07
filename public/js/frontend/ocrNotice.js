import { showUploadWarningModal } from './modals.js';

/**
 * Tells the person that some pages of a document were left without searchable text because an image
 * on them is too large to read. Without this the page just stays unsearchable and nothing says why.
 * @param {string} filename
 * @param {number[]} skippedPages - 1-based
 */
export function noticeSkippedOcrPages(filename, skippedPages) {
  if (!skippedPages?.length) return;
  const shown = skippedPages.slice(0, 10).join(', ');
  const more = skippedPages.length > 10 ? ` and ${skippedPages.length - 10} more` : '';
  showUploadWarningModal({
    code: 'BT-OCR-01',
    title: 'Some pages could not be read',
    message: `"${filename}": an image on ${skippedPages.length === 1 ? 'page' : 'pages'} ${shown}${more} is too large to read, so ${skippedPages.length === 1 ? 'that page has' : 'those pages have'} no searchable text. The pages themselves are unchanged and still go into the bundle.`,
  });
}
