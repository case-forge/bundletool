import { state } from './state.js';
import { PD27A_PAGE_LIMIT, isOverPd27aLimit, pd27aNote } from './limits.js';
import { readingTotalsText, onReadingChange } from './ocrReading.js';

/**
 * The Review Table's own running total: "N documents, N pages", plus the Practice Direction 27A
 * note once the total goes over PD27A_PAGE_LIMIT. This is deliberately a plain read of
 * state.frontendInputData, the same source bundleGeneration.js sums for the 1,000-page warning, so
 * the two never disagree. Called after every place the table's documents change (add, remove,
 * clear, restore from a saved tab, reopen a bundle, import a manifest); rotating a document does not
 * change its page count, so rotate does not need to call this.
 *
 * Safe with no DOM (the elements are simply absent under Node, for example in a CLI or a test).
 */
export function refreshBundleTotals() {
  const documentCount = Object.keys(state.frontendInputData).length;
  const pageCount = Object.values(state.frontendInputData).reduce((sum, d) => sum + (d.pageCount || 0), 0);

  if (typeof document === 'undefined') return { documentCount, pageCount, overPd27aLimit: isOverPd27aLimit(pageCount), pd27aLimit: PD27A_PAGE_LIMIT };

  const totalsEl = document.getElementById('bundle-totals');
  if (totalsEl) {
    if (documentCount === 0) {
      totalsEl.hidden = true;
      totalsEl.textContent = '';
    } else {
      totalsEl.hidden = false;
      totalsEl.textContent = `${documentCount.toLocaleString('en-GB')} document${documentCount === 1 ? '' : 's'}, `
        + `${pageCount.toLocaleString('en-GB')} page${pageCount === 1 ? '' : 's'}`;
    }
  }

  const pd27aEl = document.getElementById('bundle-pd27a-note');
  if (pd27aEl) {
    const over = isOverPd27aLimit(pageCount);
    pd27aEl.hidden = !over;
    pd27aEl.textContent = over ? pd27aNote(pageCount) : '';
  }

  return { documentCount, pageCount, overPd27aLimit: isOverPd27aLimit(pageCount), pd27aLimit: PD27A_PAGE_LIMIT };
}

/**
 * The words beside the totals while text is being read ("Reading text: 2 of 5 documents, about 40 s left", or with
 * no estimate before the first page has been timed), and nothing otherwise. Follows every change ocrReading.js
 * reports, and its once a second refresh while a page is being read, so the estimate counts down. Returns the words.
 */
export function refreshReadingTotals() {
  const text = readingTotalsText();
  if (typeof document === 'undefined') return text;
  const el = document.getElementById('bundle-reading');
  if (el) {
    el.hidden = !text;
    if (el.textContent !== text) el.textContent = text;
  }
  return text;
}

onReadingChange(() => refreshReadingTotals());
