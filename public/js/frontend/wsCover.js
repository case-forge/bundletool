/**
 * "Add a witness statement cover page": a small prompt on a section's own header row that draws
 * one cover-style page, verbatim to the real bundle cover (same court, case number, parties,
 * joiner, prepared by, everything currently set), with only the title text replaced by what was
 * typed. The result becomes an ordinary file in that section, exactly as if it had been dropped
 * in: draggable, deletable, rotatable, counted in the index. Positioning it in front of the
 * witness statement it belongs to is then the same drag the review table already offers for any
 * row, not something this feature has to build.
 *
 * The typed title becomes the generated file's name too, so the row's Title cell starts out
 * showing it without any extra wiring: the existing title-from-filename fallback (fileRows.js,
 * frontend/utils.js's prettifyTitle) already does that for a document with no title of its own,
 * the same fallback the CLI and the browser share.
 */
import { state } from './state.js';
import { processFiles } from './fileProcessing.js';
import { uniqueFilename } from './utils.js';
import { showErrorModal } from './modals.js';
import { lazyImport } from '/js/shared/lazy-load.js';

let _collectCv = null;
let _makeCoverPdf = null;

/** A plain file name from a typed title: letters, digits and spaces survive, everything else becomes a space. */
export function filenameFromTitle(title) {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${cleaned || 'Witness statement'}.pdf`;
}

function elements() {
  return {
    modal: document.getElementById('ws-cover-modal'),
    input: document.getElementById('ws-cover-title-input'),
    errEl: document.getElementById('ws-cover-error'),
    addBtn: document.getElementById('ws-cover-add'),
    cancelBtn: document.getElementById('ws-cover-cancel'),
  };
}

let _targetTbody = null;

/** Opens the prompt for one section. tbody is the section's own tbody element, the same one a drop onto it would target. */
export function openWsCoverModal(tbody) {
  const { modal, input, errEl, addBtn } = elements();
  if (!modal || !input || !addBtn) return;
  _targetTbody = tbody;
  input.value = '';
  errEl?.classList.add('hidden');
  addBtn.disabled = true;
  modal.classList.remove('hidden');
  input.focus();
}

function closeWsCoverModal() {
  const { modal, input } = elements();
  modal?.classList.add('hidden');
  if (input) input.value = '';
  _targetTbody = null;
}

async function confirmWsCover() {
  const { input, errEl, addBtn } = elements();
  const title = (input?.value || '').trim();
  if (!title) {
    if (errEl) { errEl.textContent = 'Type a title first.'; errEl.classList.remove('hidden'); }
    input?.focus();
    return;
  }
  const tbody = _targetTbody;
  if (!tbody) { closeWsCoverModal(); return; }

  addBtn.disabled = true;
  const label = addBtn.textContent;
  addBtn.textContent = 'Adding…';
  try {
    if (!_collectCv) ({ collectCv: _collectCv } = await lazyImport(new URL('./coverEditor.js', import.meta.url)));
    if (!_makeCoverPdf) ({ makeCoverPdf: _makeCoverPdf } = await lazyImport(new URL('../bundletoolCover.js', import.meta.url)));
    const cv = _collectCv();
    // Only the title changes. cover.bundleTitle already means "override the heading for the
    // cover specifically", the same field the cover maker's own Bundle Title box writes to, so
    // this draws with everything else exactly as currently set and touches no saved setting.
    cv['cover.bundleTitle'] = title;
    const bytes = await _makeCoverPdf(cv);
    const name = uniqueFilename(filenameFromTitle(title), state.filesMap);
    const file = new File([bytes], name, { type: 'application/pdf' });
    closeWsCoverModal();
    await processFiles([file], tbody);
  } catch (error) {
    closeWsCoverModal();
    showErrorModal({ code: 'BT-COVER-07', title: 'Could not add the cover page', message: 'Something went wrong while drawing the witness statement cover.', error });
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = label;
  }
}

export function setupWsCoverModal() {
  const { input, addBtn, cancelBtn, modal } = elements();
  if (!modal) return;
  input?.addEventListener('input', () => { if (addBtn) addBtn.disabled = !input.value.trim(); });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!addBtn?.disabled) confirmWsCover(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWsCoverModal(); }
  });
  addBtn?.addEventListener('click', confirmWsCover);
  cancelBtn?.addEventListener('click', closeWsCoverModal);
}
