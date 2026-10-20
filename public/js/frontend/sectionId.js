/**
 * Section ids and labels. This code generates ids (a zero-padded counter), but ids and labels also come back out of a
 * bundle PDF's embedded metadata, an autosave snapshot and a manifest, all of which can be hostile. An id that is not
 * exactly four digits is never used: a fresh one is made instead, so it can never carry markup into an id, a selector
 * or an attribute. A label is cut to the length the label box allows (cleanSectionLabel).
 */
import { MAX_SECTION_LABEL_CHARS } from './limits.js';

const FOUR_DIGITS = /^\d{4}$/;

export function isSectionId(raw) {
  return typeof raw === 'string' && FOUR_DIGITS.test(raw);
}

/**
 * Returns `raw` when it is a valid, unused id, otherwise the next free counter
 * value. `taken` is the set of ids already on the page; `counter` is the next
 * number the caller would hand out.
 */
export function cleanSectionId(raw, taken, counter) {
  if (isSectionId(raw) && !taken.has(raw)) return raw;
  let n = Math.max(1, Number.isInteger(counter) ? counter : 1);
  let id = String(n).padStart(4, '0');
  while (taken.has(id)) { n += 1; id = String(n).padStart(4, '0'); }
  return id;
}

/**
 * A section label as the label box holds it: text only, without spaces at either end, and no longer than
 * MAX_SECTION_LABEL_CHARS, counted as the box's own maxlength counts (UTF-16 units), never ending on half a character.
 * A label from a layout, a manifest, a reopened bundle or a saved copy is cut to fit; anything that is not text is
 * empty.
 */
export function cleanSectionLabel(raw) {
  if (typeof raw !== 'string') return '';
  let label = raw.trim().slice(0, MAX_SECTION_LABEL_CHARS);
  if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
  return label.trimEnd();
}
