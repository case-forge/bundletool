import { state } from './state.js';
import { makeFileRow, ensureEmptyPlaceholder } from './fileRows.js';
import { createSectionTbody, createSection0000HeaderRow } from './sections.js';
import { setCoversheetSelected } from './coversheet.js';
import { getDefaultSection0000 } from './helpers.js';
import { reconcileWatermark, pageNumberColourToHex, currentDateStyle } from './utils.js';
import { sanitiseConfig } from './configSanitise.js';
import { setCurrentSnapshot } from './tabSession.js';
import { rememberBlobKey } from '../bundletoolAutosave.js';
import { COVER_FOLLOW, getCoverOverride, setCoverOverride } from './coverOverrides.js';
import { refreshAdvancedState } from './advancedState.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { stopAllReading } from './ocrReading.js';
import { resumeUnfinishedReading } from './ocrAuto.js';

/**
 * Every form field a snapshot or a session draft carries, read from the page.
 * No files: those are the snapshot's own business.
 */
export function collectFormConfig() {
  return {
    claimNumber:         document.getElementById('config-claimNumber')?.value         || '',
    bundleTitle:         document.getElementById('config-bundleTitle')?.value          || '',
    projectName:         document.getElementById('config-projectName')?.value          || '',
    author:              document.getElementById('config-author')?.value               || '',
    footerFont:          document.getElementById('config-footerFont')?.value           || '',
    alignment:           document.getElementById('config-alignment')?.value            || '',
    numberingStyle:      document.getElementById('config-numberingStyle')?.value       || '',
    footerPrefix:        document.getElementById('config-footerPrefix')?.value         || '',
    pageNumberColour:    document.getElementById('config-pageNumberColour')?.value     || '#000000',
    plateColour:         document.getElementById('config-plateColour')?.value          || '#f4f4f4',
    plateOpacity:        Number(document.getElementById('config-plateOpacity')?.value  ?? 100),
    footerLink:          document.getElementById('config-footerLink')?.value           || 'index',
    frontMatterNumbering: document.getElementById('config-frontMatterNumbering')?.value || 'continuous',
    footerOffset:        Number(document.getElementById('config-footerOffset')?.value)  || 0,
    headingText:         document.getElementById('config-headingText')?.value           || '',
    indexBookmarkLabel:  document.getElementById('config-indexBookmarkLabel')?.value   || '',
    fontFace:            document.getElementById('config-fontFace')?.value             || '',
    dateStyle:           document.getElementById('config-dateStyle')?.value            || '',
    dateInputOrder:      document.getElementById('config-dateInputOrder')?.value       || 'UK',
    outlineItemStyle:    document.getElementById('config-outlineItemStyle')?.value     || '',
    pageSize:            document.getElementById('config-pageSize')?.value            || 'a4',
    printableBundle:     document.getElementById('config-printableBundle')?.checked    ?? false,
    ocrAutoDetect:       document.getElementById('config-ocrAutoDetect')?.checked      ?? true,
    ocrTurnUpright:      document.getElementById('config-ocrTurnUpright')?.checked     ?? false,
    ocrStraighten:       document.getElementById('config-ocrStraighten')?.checked      ?? false,
    smallerPhotos:       document.getElementById('config-smallerPhotos')?.checked      ?? true,
    // No separate `watermark` flag: the text field IS the toggle, so its
    // text is the only thing worth persisting.
    watermarkText:       document.getElementById('config-watermarkText')?.value        || '',
    watermarkColour:     document.getElementById('config-watermarkColour')?.value      || '#999999',
    watermarkOpacity:    Number(document.getElementById('config-watermarkOpacity')?.value ?? 28),
    indexFontSize:       document.getElementById('config-indexFontSize')?.value        || '',
    footerFontSize:      document.getElementById('config-footerFontSize')?.value       || '',
    showTableBorders:    document.getElementById('config-showTableBorders')?.checked   ?? false,
    sectionPrefix:       document.getElementById('config-sectionPrefix')?.value        || '',
    pageNumberPerSection: document.getElementById('config-pageNumberPerSection')?.checked ?? false,
    // Cover page: whether a design was confirmed in the maker, and the case
    // details it is drawn from.
    generateCover:       document.getElementById('config-generateCover')?.checked      ?? false,
    courtName:           document.getElementById('config-courtName')?.value            || '',
    matterOf:            document.getElementById('config-matterOf')?.value             || '',
    applicantName:       document.getElementById('config-applicantName')?.value        || '',
    respondentName:      document.getElementById('config-respondentName')?.value       || '',
    partyLabel1:         document.getElementById('config-partyLabel1')?.value          || '',
    partyLabel2:         document.getElementById('config-partyLabel2')?.value          || '',
    coverExtraText:      document.getElementById('config-coverExtraText')?.value       || '',
    // The cover's own Case Reference / Bundle Title / Prepared By: null follows Basic Information.
    coverClaimNumber:    getCoverOverride('config-coverClaimNumber'),
    coverBundleTitle:    getCoverOverride('config-coverBundleTitle'),
    coverAuthor:         getCoverOverride('config-coverAuthor'),
  };
}

export async function getAutosaveState() {
  if (state.filesMap.size === 0) return null;

  // Everything that describes the table is copied FIRST, synchronously, then the documents are read
  // (which takes time on a big bundle). Reading them first would let the table change or be cleared in
  // between, so a save could hold a document that no row describes.
  const allEntries = [...state.filesMap];
  const allInputData = { ...state.frontendInputData };
  const tableOrder = [];
  document.querySelectorAll('.section-tbody').forEach(tbody => {
    const sectionID = tbody.dataset.sectionId;
    const headerRow = tbody.querySelector('.section-header-row');
    const labelEl   = headerRow?.querySelector('.section-label-input');
    const label     = labelEl?.value.trim() || labelEl?.placeholder || '';
    const name      = headerRow?.querySelector('.section-name-input')?.value.trim() ?? '';
    const filenames = Array.from(tbody.querySelectorAll('tr.file-row')).map(r => r.dataset.filename).filter(Boolean);
    tableOrder.push({ type: 'section', sectionID, label, name, filenames });
  });

  // Only documents a row lists are saved. While the row batcher holds rows back, a validated file is
  // already in filesMap with no row yet; saving it would restore as an invisible document that is
  // built into the bundle and refused as "Already added".
  const listed = new Set(tableOrder.flatMap(item => item.filenames));
  const entries = allEntries.filter(([filename]) => listed.has(filename));
  const inputData = Object.fromEntries(Object.entries(allInputData).filter(([filename]) => listed.has(filename)));
  if (entries.length === 0) return null;

  const config = collectFormConfig();
  const isSectioned = state.isSectioned;
  const coversheetFile = state.coversheetFile;
  const coversheetConverted = state.coversheetConverted;

  // The File objects themselves, not their bytes: the autosave reads the bytes of only the documents it
  // has not stored yet (bundletoolAutosave.js), so a save after a small change does not re-read them all.
  const files = entries.map(([filename, file]) => ({ filename, file }));

  const coversheet = coversheetFile
    ? { filename: coversheetFile.name, file: coversheetFile, ...(coversheetConverted ? { converted: true } : {}) }
    : null;

  return { files, inputData, tableOrder, config, coversheet, isSectioned };
}

/**
 * Writes a config object (a snapshot's, or a session draft's) back into the
 * form. Keys that are absent leave their field alone.
 */
export function applyFormConfig(raw) {
  // Snapshots, drafts and saves can hold values the form does not offer; only ones the build
  // accepts are written (a blank select would fail every later build). Fields this does not know pass through.
  const c = sanitiseConfig(raw, { passThrough: true });
  const _set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val ?? ''; };
  const _chk = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.checked = !!val; };
  // Segmented controls (font sizes, alignment, colour) are a hidden input plus
  // a row of buttons. Setting only the input desyncs the two: the buttons keep
  // highlighting the old value while the next build uses the restored one.
  const _grp = (group, val) => {
    if (val === undefined || val === null || val === '') return;
    if (typeof window.setBtnGroup === 'function') window.setBtnGroup(group, val);
    else _set(`config-${group}`, val);
  };
  _set('config-claimNumber',        c.claimNumber);
  _set('config-bundleTitle',        c.bundleTitle);
  _set('config-projectName',        c.projectName);
  _set('config-author',             c.author);
  _set('config-footerFont',         c.footerFont);
  _grp('alignment',                 c.alignment);
  _set('config-numberingStyle',     c.numberingStyle);
  _set('config-footerPrefix',       c.footerPrefix);
  _set('config-pageNumberColour',   pageNumberColourToHex(c.pageNumberColour));
  _set('config-plateColour',        c.plateColour);
  if (c.plateOpacity !== undefined) {
    const el = document.getElementById('config-plateOpacity');
    if (el) { el.value = String(c.plateOpacity); el.dispatchEvent(new Event('input')); }
  }
  _set('config-footerLink',         c.footerLink);
  _set('config-frontMatterNumbering', c.frontMatterNumbering);
  _set('config-footerOffset',       c.footerOffset);
  _set('config-headingText',        c.headingText);
  // c.indexBookmarkLabel and c.headingFontSize, which some snapshots carry, are ignored: the form
  // has no Index Link Label setting, and the index text size is one setting (indexFontSize).
  _set('config-fontFace',           c.fontFace);
  _set('config-dateStyle',          currentDateStyle(c.dateStyle));
  _set('config-dateInputOrder',     c.dateInputOrder || 'UK');
  _set('config-outlineItemStyle',   c.outlineItemStyle);
  _set('config-pageSize',           c.pageSize);
  _chk('config-printableBundle',    c.printableBundle);
  _chk('config-ocrAutoDetect',      c.ocrAutoDetect);
  _chk('config-ocrTurnUpright',     c.ocrTurnUpright);
  _chk('config-ocrStraighten',      c.ocrStraighten);
  _chk('config-smallerPhotos',      c.smallerPhotos);
  _set('config-watermarkText',      reconcileWatermark(c.watermark, c.watermarkText));
  _set('config-watermarkColour',    c.watermarkColour || '#999999');
  if (c.watermarkOpacity !== undefined) {
    const el = document.getElementById('config-watermarkOpacity');
    if (el) { el.value = String(c.watermarkOpacity); el.dispatchEvent(new Event('input')); }
  }
  _grp('indexFontSize',             c.indexFontSize);
  _grp('footerFontSize',            c.footerFontSize);
  _chk('config-showTableBorders',   c.showTableBorders);
  _set('config-sectionPrefix',      c.sectionPrefix);
  _chk('config-pageNumberPerSection', c.pageNumberPerSection);
  // A snapshot without a key leaves that field at its reset state above;
  // covers are opt-in, so a snapshot with no generateCover restores with none.
  _chk('config-generateCover',      c.generateCover);
  _set('config-courtName',          c.courtName);
  _set('config-matterOf',           c.matterOf);
  _set('config-applicantName',      c.applicantName);
  _set('config-respondentName',     c.respondentName);
  _set('config-partyLabel1',        c.partyLabel1);
  _set('config-partyLabel2',        c.partyLabel2);
  _set('config-coverExtraText',     c.coverExtraText);
  // A snapshot without these leaves the cover following Basic Information.
  setCoverOverride('config-coverClaimNumber', c.coverClaimNumber ?? null);
  setCoverOverride('config-coverBundleTitle', c.coverBundleTitle ?? null);
  setCoverOverride('config-coverAuthor',      c.coverAuthor ?? null);
  // The party-pair select and the dimmed settings are views of what was just set.
  refreshAdvancedState();
}

/**
 * The part of a snapshot that can come back: documents that have row data AND that a row of its table
 * lists. Pure, so the rule is testable without a page.
 */
export function restorableParts(snapshot) {
  const listed = new Set(snapshot.tableOrder.flatMap(item => item.filenames || []));
  const inputData = Object.fromEntries(Object.entries(snapshot.inputData).filter(([filename]) => listed.has(filename)));
  const files = snapshot.files.filter(({ filename }) => Object.prototype.hasOwnProperty.call(inputData, filename));
  return { inputData, files };
}

export async function applySnapshot(snapshot) {
  stopAllReading();
  state.filesMap.clear();
  Object.keys(state.frontendInputData).forEach(k => delete state.frontendInputData[k]);
  document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').forEach(el => el.remove());
  const section0000 = getDefaultSection0000();
  if (section0000) section0000.innerHTML = '';
  state.coversheetFile    = null;
  state.coversheetConverted = false;
  // Both halves of the cover slot reset before the snapshot's own values are
  // applied, or the current session's designed cover would leak into a
  // snapshot that had none.
  {
    const generateCoverEl = document.getElementById('config-generateCover');
    if (generateCoverEl) generateCoverEl.checked = false;
  }
  setCoversheetSelected(null);
  state.isSectioned       = false;
  state.nextSectionNum    = 1;
  document.getElementById('file-table')?.classList.remove('sectioned');

  // A document with no row data, or that no row of the table lists, has no row: it is left over from a
  // save that raced a clear, or one taken while rows were still being added, and must not come back as
  // an invisible file that is built into the bundle. (A stored snapshot can still hold such files, so
  // the restore checks as well as getAutosaveState.)
  const restorable = restorableParts(snapshot);
  Object.assign(state.frontendInputData, restorable.inputData);
  for (const { filename, bytes, key } of restorable.files) {
    const file = new File([bytes], filename, { type: 'application/pdf' });
    rememberBlobKey(file, key);   // already stored: the next save does not write it again
    state.filesMap.set(filename, file);
  }

  const snapshotSectioned = snapshot.isSectioned ??
    snapshot.tableOrder.some(item =>
      item.type === 'section' &&
      (item.sectionID !== '0000' || item.label || item.name)
    );
  if (snapshotSectioned) {
    state.isSectioned = true;
    document.getElementById('file-table')?.classList.add('sectioned');
  }

  const table = document.querySelector('#file-table table');
  let saved0000Label = '', saved0000Name = '';
  for (const item of snapshot.tableOrder) {
    if (item.type !== 'section') continue;
    let tbody;
    if (item.sectionID === '0000') {
      tbody = getDefaultSection0000();
      saved0000Label = item.label || '';
      saved0000Name  = item.name  || '';
    } else {
      tbody = createSectionTbody(item.sectionID, item.label || '', item.name || '');
      table?.appendChild(tbody);
      const num = parseInt(tbody.dataset.sectionId, 10);
      if (!isNaN(num) && num >= state.nextSectionNum) state.nextSectionNum = num + 1;
    }
    for (const filename of (item.filenames || [])) {
      const data = state.frontendInputData[filename];
      if (!data) continue;
      const row = makeFileRow(filename, data);
      tbody.appendChild(row);
    }
    if (state.isSectioned) ensureEmptyPlaceholder(tbody);
  }

  if (state.isSectioned) {
    const s0 = getDefaultSection0000();
    createSection0000HeaderRow(s0, saved0000Label || 'A', saved0000Name);
  }

  // A snapshot whose tableOrder is a flat list of files, with no sections
  if (snapshot.tableOrder.length && snapshot.tableOrder[0].type === 'file') {
    for (const item of snapshot.tableOrder) {
      if (item.type !== 'file') continue;
      const data  = state.frontendInputData[item.filename];
      if (!data) continue;
      const tbody = getDefaultSection0000();
      tbody.appendChild(makeFileRow(item.filename, data));
    }
  }

  applyFormConfig(snapshot.config);

  if (snapshot.coversheet) {
    state.coversheetFile = new File([snapshot.coversheet.bytes], snapshot.coversheet.filename, { type: 'application/pdf' });
    rememberBlobKey(state.coversheetFile, snapshot.coversheet.key);
    state.coversheetConverted = snapshot.coversheet.converted === true;
    setCoversheetSelected(snapshot.coversheet.filename);
  } else {
    // Re-render the status line now the generateCover checkbox is settled.
    setCoversheetSelected(null);
  }
  // This tab's form now matches this snapshot; the form draft is only laid over a snapshot it was taken with.
  setCurrentSnapshot(snapshot.timestamp);
  refreshBundleTotals();
  // A document whose text was still being read when this was saved is read again, unless it was skipped.
  resumeUnfinishedReading();
}
