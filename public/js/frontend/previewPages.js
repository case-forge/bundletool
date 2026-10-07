/**
 * previewPages.js
 * Preview Bundle and Preview Index on a browser with no PDF viewer of its own (most phones): the finished PDF shown as
 * pictures in the preview window, one page at a time, drawn and paged by pageView.js exactly as the document window
 * does it (previous and next, a page number to type, the arrow keys, one page held at a time). Read-only: nothing here
 * changes the PDF. The window keeps its own Save, Split for email and close cross (openBundlePreview in bundleUI.js).
 *
 * Loaded on first use, and only where there is no viewer (bundleUI.js imports it lazily), so a desktop never loads
 * this or pdf.js for a preview.
 */
import { PageView, wirePager } from './pageView.js';

const IDS = {
  canvas: 'bundle-preview-canvas', stage: 'bundle-preview-stage', noPreview: 'bundle-preview-no-page',
  prev: 'bundle-preview-prev', next: 'bundle-preview-next', input: 'bundle-preview-page-input', count: 'bundle-preview-page-count',
};
const PAGER = 'bundle-preview-pager';

/** The pictures on show, or null. */
let view = null;
let wired = false;

const $ = (id) => document.getElementById(id);

/**
 * Shows `pdfBytes` as pictures in the open preview window, from page 1, or from `where` ({ pageNum, pageCount }, as
 * hidePages returned it) when the window comes back to a page. The bytes are left as they are: pdf.js reads a copy.
 */
export function showPages(pdfBytes, where = null) {
  if (!wired) {
    wired = true;
    wirePager(IDS, () => view, { modalId: 'bundle-preview-modal' });
  }
  view?.release();
  view = new PageView(IDS, { bytes: pdfBytes, pageCount: where?.pageCount ?? 1, label: 'bundle preview' });
  view.pageNum = Math.min(Math.max(1, where?.pageNum ?? 1), view.pageCount);
  $(IDS.canvas).classList.add('hidden');
  $(IDS.noPreview).classList.add('hidden');
  $(IDS.stage).classList.remove('hidden');
  $(PAGER).classList.remove('hidden');
  view.showPager();
  view.draw();
}

/**
 * Hides the pictures and frees everything pdf.js holds for them. Returns the page that was shown ({ pageNum,
 * pageCount }), so the window can come back to it, or null when nothing was shown.
 */
export function hidePages() {
  const where = view ? { pageNum: view.pageNum, pageCount: view.pageCount } : null;
  view?.release();
  view = null;
  $(IDS.stage)?.classList.add('hidden');
  $(PAGER)?.classList.add('hidden');
  return where;
}
