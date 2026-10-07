/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * coverEditor.js
 * The coversheet maker: the one place a cover is designed.
 *
 * Opens prefilled from the hidden cover state (which carries the per-firm
 * defaults: court, case subheading, party labels) and, for Case Reference, Bundle
 * Title and Prepared By, from Basic Information (unless the cover already has its
 * own value for one; see coverOverrides.js). The preview pane is not an
 * approximation: it is the actual PDF, rebuilt as the fields change and rendered
 * onto a <canvas> with pdf.js rather than shown in a browser-native PDF <iframe>.
 * The native viewer varies by browser and can silently show nothing at all, even
 * for a correct PDF; pdf.js renders identically everywhere, and the result is
 * pixels this page fully controls.
 *
 * "Use this coversheet" writes the fields BACK to the hidden inputs and sets
 * config-generateCover, so the build draws this exact page from config at build
 * time. That keeps a cover field that follows Basic Information in step with it
 * if it changes after the design was confirmed, and lets a reopened bundle come
 * back editable rather than as frozen bytes. Case Reference, Bundle Title and
 * Prepared By written here stay on the coversheet: Basic Information is never
 * changed from this dialog. Any uploaded coversheet is discarded on confirm: one
 * cover slot, never two covers. Cancel and Escape write nothing back.
 */
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { refreshCoverStatus } from './coversheet.js';
import { showErrorModal } from './modals.js';
import { stripUnsuitableChars, stripMultiline } from './utils.js';
import { saveDraft as saveCoverDraft, loadDraft as loadCoverDraft, applyDraftFields, clearDraft as clearCoverDraft } from './coverDraft.js';
import { createRenderScheduler, copyFrame } from '/js/shared/renderScheduler.js';
import { COVER_FOLLOW, getCoverOverride, setCoverOverride } from './coverOverrides.js';
import { lazyImport } from '/js/shared/lazy-load.js';

// pdf.js (305 KB) is only needed once the cover editor actually draws a preview, which most
// page visits never do: the same reason bundletoolCover.js below is a dynamic import too.
// Loaded once and cached, the same pattern as _makeCoverPdf.
let _pdfjsLib = null;
async function loadPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await lazyImport('/vendor/pdfjs.mjs');
    _pdfjsLib.GlobalWorkerOptions.workerSrc = '/bundletool/js/pdfjs.worker.mjs';
  }
  return _pdfjsLib;
}

/** [editor field id, main-form or hidden-state field id, flat config key] */
const FIELDS = [
  ['ce-courtName',      'config-courtName',      'cover.courtName'],
  ['ce-matterOf',       'config-matterOf',       'cover.matterOf'],
  ['ce-applicantName',  'config-applicantName',  'cover.applicantName'],
  ['ce-respondentName', 'config-respondentName', 'cover.respondentName'],
  ['ce-extraText',      'config-coverExtraText', 'cover.extraText'],
];

let _makeCoverPdf = null;
let _epoch        = 0;      // bumped on close: a render still in flight then drops its frame
let _hasFrame     = false;  // a good frame has been shown at least once
let _pdfRenderTask = null;

// Fields with one item per line: In the Matter Of (a children matter needs
// the Act on one line, the child on the next) and Applicant/Respondent
// (several parties, up to 4 each, a limit enforced in bundletoolCover.js's
// layout, not here). Line breaks are the structure of these blocks, so
// clean-up runs per line rather than over the whole value, as for
// cover.extraText.
const MULTILINE_FIELDS = new Set(['cover.extraText', 'cover.matterOf', 'cover.applicantName', 'cover.respondentName']);

// Exported for wsCover.js: the witness statement cover button draws with exactly what this
// reads (the same live Advanced Settings and Basic Information values the real cover maker
// preview uses), overriding only the title afterwards, never a second copy of this logic.
export function collectCv() {
  const cv = {};
  for (const [ceId, , key] of FIELDS) {
    const raw = document.getElementById(ceId)?.value || '';
    // The single-line fields are pull-open boxes (textareas), so a pasted line
    // break becomes a space instead of reaching the cover or the form.
    cv[key] = MULTILINE_FIELDS.has(key) ? stripMultiline(raw) : stripUnsuitableChars(raw.replace(/\s*[\r\n]+\s*/g, ' '));
  }
  // Case Reference, Bundle Title and Prepared By: what the editor shows is what the cover
  // draws (they start as Basic Information's values, see openEditor).
  for (const f of COVER_FOLLOW) {
    const raw = document.getElementById(f.ce)?.value || '';
    cv[`cover.${f.key}`] = stripUnsuitableChars(raw.replace(/\s*[\r\n]+\s*/g, ' '));
  }
  cv['index.fontFace']       = document.getElementById('config-fontFace')?.value || 'serif';
  // Party labels are an Advanced Settings field, not mirrored into the
  // editor like the fields in FIELDS above: read straight from the one place
  // they live.
  cv['cover.partyLabel1'] = stripUnsuitableChars(document.getElementById('config-partyLabel1')?.value || '');
  cv['cover.partyLabel2'] = stripUnsuitableChars(document.getElementById('config-partyLabel2')?.value || '');
  // Layout is an Advanced Settings field too, for the same reason: no
  // editor-local copy, read straight from where it lives so the preview
  // matches what the build will actually draw.
  cv['cover.layout'] = document.getElementById('config-coverLayout')?.value || 'classic';
  cv['cover.caseNumberLine'] = document.getElementById('config-coverCaseLine')?.value || 'court';
  cv['cover.partyLabelPlacement'] = document.getElementById('config-coverLabelPlacement')?.value || 'inline';
  cv['cover.partyAlign'] = document.getElementById('config-coverPartyAlign')?.value || 'centre';
  cv['cover.caseNumberAlign'] = document.getElementById('config-coverCaseAlign')?.value || 'right';
  cv['cover.headingAlign'] = document.getElementById('config-coverHeadingAlign')?.value || 'left';
  cv['cover.titleLines'] = document.getElementById('config-coverTitleLines')?.value || 'single';
  // Blank means no prefix at all, a real and different value from the default "CASE NO:", so a
  // missing element (?? not ||) falls back to the default and a genuinely blank box stays blank.
  cv['cover.caseNumberLabel'] = stripUnsuitableChars(document.getElementById('config-caseNumberLabel')?.value ?? 'CASE NO:');
  // Blank means no label at all, a real and different value from the default "Prepared by:", so
  // a missing element (?? not ||) falls back to the default and a genuinely blank box stays blank.
  cv['cover.preparedByLabel'] = stripUnsuitableChars(document.getElementById('config-preparedByLabel')?.value ?? 'Prepared by:');
  // Blank means no joining word at all (just the gap), a real and different value from the
  // default "-and-", so a missing element (?? not ||) falls back to the default and a genuinely
  // blank box stays blank.
  cv['cover.partyJoiner'] = stripUnsuitableChars(document.getElementById('config-partyJoiner')?.value ?? '-and-');
  return cv;
}

async function buildPdf() {
  if (!_makeCoverPdf) ({ makeCoverPdf: _makeCoverPdf } = await lazyImport(new URL('../bundletoolCover.js', import.meta.url)));
  return _makeCoverPdf(collectCv());
}

/**
 * Draws the coversheet PDF onto the preview canvas without ever blanking it.
 *
 * Setting canvas.width and canvas.height on the VISIBLE canvas clears it, and pdf.js then paints
 * asynchronously, so rendering straight onto it would show an empty page for a moment on every update (two
 * blank frames, about 33 ms each). Instead each frame is drawn on an offscreen canvas and copied onto the
 * visible one in a single synchronous step (resize, if the box changed, and copy in the same task, so the
 * browser never paints the cleared state). The visible canvas keeps its last good frame while a render is in
 * flight, slow or failing. Renders run one at a time: edits made meanwhile are remembered and the next render
 * starts as soon as this one ends (the shared createRenderScheduler), so the preview follows the typing and
 * always ends on the latest text.
 */
async function renderOnce() {
  const epoch = _epoch;
  const canvas = document.getElementById('cover-editor-preview');
  const noPreview = document.getElementById('cover-editor-no-preview');
  if (!canvas) return;
  let pdf = null;
  try {
    const [bytes, pdfjsLib] = await Promise.all([buildPdf(), loadPdfjs()]);
    if (epoch !== _epoch) return;
    pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, maxImageSize: 32 * 1024 * 1024 }).promise;
    const page = await pdf.getPage(1);
    if (epoch !== _epoch) return;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (box.width * dpr) / unscaled.width });
    const buffer = document.createElement('canvas');
    buffer.width = Math.round(viewport.width);
    buffer.height = Math.round(viewport.height);
    const task = page.render({ canvasContext: buffer.getContext('2d'), viewport, background: 'white' });
    _pdfRenderTask = task;
    await task.promise;
    if (epoch !== _epoch) return;
    copyFrame(buffer, canvas);
    _hasFrame = true;
    canvas.classList.remove('hidden');
    noPreview?.classList.add('hidden');
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('[coverEditor] preview failed:', err);
    // Keep the last good frame if there is one; only say so when there has never been one.
    if (!_hasFrame) {
      canvas.classList.add('hidden');
      noPreview?.classList.remove('hidden');
    }
  } finally {
    if (pdf) pdf.destroy().catch(() => {});
  }
}

const scheduler = createRenderScheduler(renderOnce);

function renderPreview() { scheduler.request(); }
function scheduleRender() { scheduler.request(); }

/** The name fields are titled by the party labels: type Claimant in
 *  Advanced Settings and the field below asks for the Claimant. Read
 *  straight from Advanced Settings: party labels have no editor-local copy
 *  (see FIELDS above). */
function refreshPartyNameLabels() {
  const l1 = document.getElementById('config-partyLabel1')?.value.trim();
  const l2 = document.getElementById('config-partyLabel2')?.value.trim();
  const label1 = document.getElementById('ce-party1-name-label');
  const label2 = document.getElementById('ce-party2-name-label');
  if (label1) label1.textContent = l1 || 'Applicant';
  if (label2) label2.textContent = l2 || 'Respondent';
}

/**
 * A one-time starting point for Applicant, from Basic Information's Parties field, when the
 * cover has never had an applicant or respondent set for this bundle (both fields blank on
 * open, so nothing typed is ever touched).
 *
 * Parties is one free-text field ("John Smith -V- Jane Smith", "A v B", "Smith and Jones", a
 * bare surname) with no fixed separator and no reliable party order, so it is never split. The
 * whole string goes into Applicant, ready to edit down to just the applicant's name; Respondent
 * is left blank rather than guessed. This runs on every open, not once, so it still helps if
 * Parties is filled in after the bundle was started.
 */
function prefillPartiesFromBasicInformation() {
  const applicant = document.getElementById('ce-applicantName');
  const respondent = document.getElementById('ce-respondentName');
  const hint = document.getElementById('ce-applicant-prefill-hint');
  if (hint) hint.hidden = true;
  if (!applicant || !respondent) return;
  if (applicant.value.trim() || respondent.value.trim()) return; // something is already there
  const parties = document.getElementById('config-projectName')?.value.trim();
  if (!parties) return;
  applicant.value = parties;
  applicant.select(); // the first keystroke replaces it, same as any other fill-in-the-blank
  if (hint) hint.hidden = false;
}

/** Fills the fields from a saved draft, and shows the notice offering to discard it. */
function applyDraftIfAny() {
  const draft = loadCoverDraft();
  const notice = document.getElementById('ce-draft-restored-notice');
  if (!draft) { if (notice) notice.hidden = true; return; }
  applyDraftFields(document.querySelector('.ce-fields'), draft.fields);
  // The draft's own applicant text, if it saved one, replaces whatever the Parties prefill just
  // put there: it is the draft, not a prefill to edit down, so the prefill hint goes.
  if ('ce-applicantName' in draft.fields) {
    const prefillHint = document.getElementById('ce-applicant-prefill-hint');
    if (prefillHint) prefillHint.hidden = true;
  }
  if (notice) notice.hidden = false;
}

function discardDraft() {
  clearCoverDraft();
  const notice = document.getElementById('ce-draft-restored-notice');
  if (notice) notice.hidden = true;
  // Same population openEditor() does without a draft: Basic Information, the cover's own
  // overrides, and the Parties starting point, none of it what was just discarded.
  populateFromBundle();
  renderPreview();
}

/** Case Reference, Bundle Title and Prepared By from the cover's own value or Basic
 *  Information; the rest from the cover's remembered value; Applicant/Respondent from Parties
 *  when both are still blank. What openEditor() shows before any draft is laid over it. */
function populateFromBundle() {
  for (const [ceId, formId] of FIELDS) {
    const el = document.getElementById(ceId);
    if (el) el.value = document.getElementById(formId)?.value || '';
  }
  // These three start as the cover's own value if it has one, else Basic Information's.
  for (const f of COVER_FOLLOW) {
    const el = document.getElementById(f.ce);
    if (!el) continue;
    const own = getCoverOverride(f.own);
    el.value = own !== null ? own : (document.getElementById(f.basic)?.value || '');
  }
  prefillPartiesFromBasicInformation();
  refreshPartyNameLabels();
}

function openEditor() {
  populateFromBundle();
  applyDraftIfAny(); // a draft, if there is one, is more recent than any of the above
  document.getElementById('cover-editor-modal')?.classList.remove('hidden');
  renderPreview();
}

function closeEditor() {
  document.getElementById('cover-editor-modal')?.classList.add('hidden');
  scheduler.cancel();
  ++_epoch; // a render still in flight drops its frame
  if (_pdfRenderTask) { _pdfRenderTask.cancel(); _pdfRenderTask = null; }
}

async function useCoversheet() {
  try {
    // Prove the design renders before committing to it: the same fields the
    // build will draw from, through the same renderer.
    await buildPdf();
    for (const [ceId, formId] of FIELDS) {
      const target = document.getElementById(formId);
      if (target) target.value = document.getElementById(ceId)?.value || '';
    }
    // Edits to Case Reference, Bundle Title and Prepared By stay on the coversheet: they
    // become the cover's own value only where they differ from Basic Information, and
    // Basic Information is never written. Where they match, the cover keeps following it.
    for (const f of COVER_FOLLOW) {
      const value = (document.getElementById(f.ce)?.value || '').replace(/\s*[\r\n]+\s*/g, ' ');
      const basic = document.getElementById(f.basic)?.value || '';
      setCoverOverride(f.own, value !== basic ? value : null);
    }
    const generateCoverEl = document.getElementById('config-generateCover');
    if (generateCoverEl) generateCoverEl.checked = true;
    state.coversheetFile = null; // confirming a design discards an upload
    refreshCoverStatus();
    // The hidden inputs fire no events, so persist the remembered fields
    // (court, statute line, party labels) and the autosave explicitly.
    window.scheduleDefaultsSave?.();
    markDirty({ immediate: true });
    clearCoverDraft(); // now the real cover: the draft that led here is no longer needed
    closeEditor();
  } catch (error) {
    showErrorModal({
      code: 'BT-COVER-06',
      title: 'Could not make the coversheet',
      message: 'Something went wrong while building the coversheet PDF.',
      error,
    });
  }
}

export function setup() {
  document.getElementById('cover-editor-open')?.addEventListener('click', openEditor);
  document.getElementById('cover-editor-close')?.addEventListener('click', closeEditor);
  document.getElementById('cover-editor-cancel')?.addEventListener('click', closeEditor);
  document.getElementById('cover-editor-use')?.addEventListener('click', useCoversheet);
  let draftSaveTimer = null;
  document.getElementById('cover-editor-modal')?.addEventListener('input', (e) => {
    if (e.target?.id === 'ce-applicantName') {
      const hint = document.getElementById('ce-applicant-prefill-hint');
      if (hint) hint.hidden = true;
    }
    // Debounced, not on every keystroke: sessionStorage writes are synchronous, and typing is not.
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveCoverDraft(document.querySelector('.ce-fields')), 400);
    scheduleRender();
  });
  document.getElementById('ce-draft-discard')?.addEventListener('click', discardDraft);

  // The canvas's pixel buffer is fixed at render time, so a viewport change
  // while the modal is open needs an actual re-render, not just a resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (document.getElementById('cover-editor-modal')?.classList.contains('hidden')) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPreview, 150);
  });
}
