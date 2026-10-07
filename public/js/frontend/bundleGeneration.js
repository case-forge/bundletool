import { state } from './state.js';
import { lazyImport } from '/js/shared/lazy-load.js';
import { stripUnsuitableChars, stripMultiline, uniqueFilename, isWatermarkText, reconcileWatermark, pageNumberColourToHex, currentDateStyle } from './utils.js';
import { buildIndexData, makeFileRow } from './fileRows.js';
import { ensureEmptyPlaceholder, removeEmptyPlaceholder } from './fileRows.js';
import { showProcessingOverlay, hideProcessingOverlay, showBundleReadyState, showIndexReadyState, openBundlePreview } from './bundleUI.js';
import { showErrorModal, showUploadWarningModal, confirmMissingInfo, confirmStructureWarning, confirmUnnamedSections, confirmLargeBundle, isMemoryError, isLoadingError } from './modals.js';
import { createSectionTbody, createSection0000HeaderRow } from './sections.js';
import { setCoversheetSelected } from './coversheet.js';
import { saveNow, saveFinishedBundle, markDirty } from '../bundletoolAutosave.js';
import { setCurrentSnapshot } from './tabSession.js';
import { getDefaultSection0000, getAllFileRows, pulseStep2 } from './helpers.js';
import { markBuildStarted, markBuildFinished, estimatePeakMemoryMB } from './crashGuard.js';
import { coverSourceOf } from '../bundletoolRestore.js';
import { sanitiseNestedConfig } from './configSanitise.js';
import { isLargeBundle, sectionLimitProblem } from './limits.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { COVER_FOLLOW, getCoverOverride, setCoverOverride } from './coverOverrides.js';
import { stopAllReading } from './ocrReading.js';
import { settleReadingBeforeBuild } from './ocrWait.js';
import { filesForBundle } from './smallerPhotos.js';

/**
 * A document's page count and any unapplied redaction markers, read once. A reopened bundle's documents
 * do not go through the add path's validation, so this is where a marker that came along with a source
 * document is noticed. Falls back to a plain page count if the closer look fails.
 */
async function inspectRestoredFile(file) {
  try {
    const { inspectPdf } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url));
    return await inspectPdf(file);
  } catch {
    return { pageCount: await state.countPdfPages(file), redactedPages: [] };
  }
}

/** One notice naming the reopened documents that still carry unapplied redaction markers. */
function warnAboutRestoredRedactions(names) {
  if (!names.length) return;
  showUploadWarningModal({
    code: 'BT-OPEN-08',
    title: 'Redaction not applied',
    message: (names.length === 1 ? `"${names[0]}" has` : `${names.length} documents have`)
      + ' redaction markers that have not been applied, so the text underneath can still be read'
      + (names.length === 1 ? '.' : ` (${names.slice(0, 4).map((n) => `"${n}"`).join(', ')}${names.length > 4 ? ' and others' : ''}).`)
      + ' They are marked in the Review Table. Apply the redactions in your PDF editor and add the file again, or remove it.',
  });
}

export function gatherConfigOptions() {
  const watermarkText = stripUnsuitableChars(document.getElementById('config-watermarkText')?.value || '');
  return {
    heading: {
      claimNumber:  stripUnsuitableChars(document.getElementById('config-claimNumber').value),
      bundleTitle:  stripUnsuitableChars(document.getElementById('config-bundleTitle').value),
      projectName:  stripUnsuitableChars(document.getElementById('config-projectName').value),
      author:       stripUnsuitableChars(document.getElementById('config-author')?.value || ''),
      // One Index Text Size setting drives the heading block and the table.
      fontSize:     document.getElementById('config-indexFontSize').value,
    },
    pageNumbering: {
      footerFont:          document.getElementById('config-footerFont').value,
      footerFontSize:      document.getElementById('config-footerFontSize').value,
      alignment:           document.getElementById('config-alignment').value,
      numberingStyle:      document.getElementById('config-numberingStyle').value,
      footerPrefix:        stripUnsuitableChars(document.getElementById('config-footerPrefix').value),
      pageNumberColour:    document.getElementById('config-pageNumberColour').value,
      pageNumberPerSection: document.getElementById('config-pageNumberPerSection').checked,
      plateColour:         document.getElementById('config-plateColour')?.value || '#f4f4f4',
      plateOpacity:        Number(document.getElementById('config-plateOpacity')?.value ?? 100),
      footerLink:          document.getElementById('config-footerLink')?.value || 'index',
      frontMatterNumbering: document.getElementById('config-frontMatterNumbering')?.value || 'continuous',
      footerOffset:        Number(document.getElementById('config-footerOffset')?.value) || 0,
    },
    index: {
      fontFace:         document.getElementById('config-fontFace').value,
      dateStyle:        document.getElementById('config-dateStyle').value,
      dateInputOrder:   document.getElementById('config-dateInputOrder').value,
      outlineItemStyle: document.getElementById('config-outlineItemStyle').value,
      fontSize:         document.getElementById('config-indexFontSize').value,
      showTableBorders: document.getElementById('config-showTableBorders').checked,
      sectionPrefix:    document.getElementById('config-sectionPrefix').value,
      indexBookmarkLabel: stripUnsuitableChars(document.getElementById('config-indexBookmarkLabel')?.value || ''),
      headingText:      stripUnsuitableChars(document.getElementById('config-headingText')?.value || ''),
    },
    pageOptions: {
      pageSize:        document.getElementById('config-pageSize')?.value || 'a4',
      printableBundle: document.getElementById('config-printableBundle').checked,
      // Provisional. processTheBundle() resolves the cover once it knows
      // whether a file was actually supplied, and writes both of these back:
      // a generated cover also makes `coversheet` true.
      coversheet:      state.coversheetFile !== null,
      // Explicitly true only: the checkbox is set by the coversheet maker's
      // confirm, and covers are opt-in.
      generateCover:   document.getElementById('config-generateCover')?.checked === true,
      // No separate checkbox: any non-empty text IS the watermark. Computed
      // once so the stored flag and text can never disagree.
      watermarkText:   watermarkText,
      watermark:       isWatermarkText(watermarkText),
      watermarkColour: document.getElementById('config-watermarkColour')?.value || '#999999',
      watermarkOpacity: Number(document.getElementById('config-watermarkOpacity')?.value ?? 28),
      // On unless switched off: a missing control (?? true) is the default, as for ocr.autoDetect below.
      smallerPhotos:   document.getElementById('config-smallerPhotos')?.checked ?? true,
    },
    cover: {
      courtName:      stripUnsuitableChars(document.getElementById('config-courtName')?.value || ''),
      // Per-line clean-up on these three: the newlines are the structure of
      // the block (a children matter's Act then child, or up to 4 parties a
      // side; the 4-name cap is enforced where these are drawn, in
      // bundletoolCover.js, not here).
      matterOf:       stripMultiline(document.getElementById('config-matterOf')?.value),
      applicantName:  stripMultiline(document.getElementById('config-applicantName')?.value),
      respondentName: stripMultiline(document.getElementById('config-respondentName')?.value),
      partyLabel1:    stripUnsuitableChars(document.getElementById('config-partyLabel1')?.value || ''),
      partyLabel2:    stripUnsuitableChars(document.getElementById('config-partyLabel2')?.value || ''),
      extraText:      stripMultiline(document.getElementById('config-coverExtraText')?.value),
      // null follows Basic Information; see coverOverrides.js
      claimNumber:    cleanOverride(getCoverOverride('config-coverClaimNumber')),
      bundleTitle:    cleanOverride(getCoverOverride('config-coverBundleTitle')),
      author:         cleanOverride(getCoverOverride('config-coverAuthor')),
      layout:         document.getElementById('config-coverLayout')?.value || 'classic',
      caseNumberLine: document.getElementById('config-coverCaseLine')?.value || 'court',
      partyLabelPlacement: document.getElementById('config-coverLabelPlacement')?.value || 'inline',
      partyAlign:     document.getElementById('config-coverPartyAlign')?.value || 'centre',
      caseNumberAlign: document.getElementById('config-coverCaseAlign')?.value || 'right',
      headingAlign:   document.getElementById('config-coverHeadingAlign')?.value || 'left',
      titleLines:     document.getElementById('config-coverTitleLines')?.value || 'single',
      // Blank is a real, different value (no prefix) from the default "CASE NO:", so a missing
      // element (?? not ||) falls back to the default and a genuinely blank box stays blank.
      caseNumberLabel: stripUnsuitableChars(document.getElementById('config-caseNumberLabel')?.value ?? 'CASE NO:'),
      // Blank is a real, different value (no label) from the default "Prepared by:", so a
      // missing element (?? not ||) falls back to the default and a genuinely blank box stays blank.
      preparedByLabel: stripUnsuitableChars(document.getElementById('config-preparedByLabel')?.value ?? 'Prepared by:'),
      // Blank is a real, different value (no joining word, just the gap) from the default
      // "-and-", so a missing element (?? not ||) falls back to the default and a genuinely
      // blank box stays blank.
      partyJoiner: stripUnsuitableChars(document.getElementById('config-partyJoiner')?.value ?? '-and-'),
    },
    ocr: {
      autoDetect: document.getElementById('config-ocrAutoDetect')?.checked ?? true,
      turnUpright: document.getElementById('config-ocrTurnUpright')?.checked === true,
      straighten: document.getElementById('config-ocrStraighten')?.checked === true,
    },
  };
}

/**
 * Builds the bundle.
 *
 * `opts.preview` sends the finished PDF to the preview modal instead of the
 * ready overlay. Nothing in the UI passes it: the ready overlay already offers
 * the same preview, so a separate Preview Bundle button would be a second
 * route to one place at the cost of a whole build. The parameter stays because
 * this is the only path that reaches the preview modal with freshly built
 * bytes.
 */
export async function handleFormSubmit(e, form, opts = {}) {
  e?.preventDefault();
  const preview = opts.preview === true;

  if (getAllFileRows().length === 0) { pulseStep2(); return; }
  // As early as possible once this is a real submission: frontend.js's idle warm-up checks this so it
  // never fires its own vendor-library fetches to compete with a build that is already fetching them.
  state.buildStarted = true;

  saveNow();

  // The warning gates, in sequence within this one submission: missing case
  // details, then missing structure (sections or coversheet: warns and
  // continues, never blocks), then the size warning. Each is awaited, so
  // answering one cannot re-open another.
  if (!await confirmMissingInfo()) return;
  if (!await confirmStructureWarning()) return;
  // A section name is optional: ask rather than block. A blank name still
  // renders (bundletoolMeta.js falls back to the section's letter/number).
  // Asked here with the other gates, before the build is marked as started, so
  // answering "Name them" cannot leave a build-in-progress flag behind.
  if (!await confirmUnnamedSections()) return;
  {
    const totalPages  = Object.values(state.frontendInputData).reduce((sum, d) => sum + (d.pageCount || 0), 0);
    const totalSizeMB = Array.from(state.filesMap.values()).reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    if (isLargeBundle(totalPages, totalSizeMB)) {
      fillLargeBundleWarning(totalPages, totalSizeMB);
      if (!await confirmLargeBundle()) return;
    }
  }
  // Text still being read: asked last, so the answer is acted on straight away (ocrWait.js). Wait builds once every
  // document is read, Skip this document builds without that one's text, Cancel builds nothing.
  if (!await settleReadingBeforeBuild()) return;

  if (!state.processTheBundle) {
    ({ processTheBundle: state.processTheBundle } = await lazyImport(new URL('../bundletoolMain.js', import.meta.url)));
  }

  // Not logged: the config carries the case name, the parties and the claim
  // number, and the console of a shared machine is the wrong place for them.
  const configOptions = gatherConfigOptions();
  state.config.updateOptions(configOptions);

  const bundleIndexData = buildIndexData();
  if (bundleIndexData.totalFileCount === 0) {
    showErrorModal({ code: 'BT-BUILD-01', title: 'No documents added', message: 'Please add at least one document before creating a bundle.' });
    return;
  }
  try { bundleIndexData.validateIndexStructure(); }
  catch (err) { showErrorModal({ code: 'BT-BUILD-02', title: 'Index data error', message: err.message }); return; }

  const inputSizeMb = Array.from(state.filesMap.values()).reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);

  // Mark the build as started. Everything a bundle is made of lives in this
  // tab and nowhere else, so if the tab dies mid-build there is no server-side
  // trace that it ever happened. saveNow() above has already written the source
  // documents to IndexedDB; this flag is what lets the next page load say so
  // instead of presenting an empty table as though nothing had been lost.
  markBuildStarted({
    pages: Object.values(state.frontendInputData).reduce((sum, d) => sum + (d.pageCount || 0), 0),
    files: state.filesMap.size,
    title: document.getElementById('config-bundleTitle')?.value || '',
  });
  // Set only once every check that can send the user back has passed: an
  // earlier return would leave the flag behind, and the next page load would
  // announce a crashed build that never happened.

  const BUNDLE_TIMEOUT_MS = 240_000;
  let cancelled = false;
  showProcessingOverlay('Building bundle…');
  document.getElementById('processing-cancel-btn')?.classList.remove('hidden');

  try {
    const onProgress = (label) => { if (!cancelled) showProcessingOverlay(label); };
    let pdfBytes = await Promise.race([
      // Documents made from pictures go in with smaller pictures when Smaller photos is on (smallerPhotos.js); the
      // documents held in the table keep theirs.
      filesForBundle(state.filesMap, { on: configOptions.pageOptions.smallerPhotos, onProgress })
        .then((files) => state.processTheBundle(files, bundleIndexData, state.config, onProgress, state.coversheetFile)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), BUNDLE_TIMEOUT_MS)),
      new Promise((_, reject) => { state._cancelReject = reject; }),
    ]);

    if (!pdfBytes || !(pdfBytes instanceof Uint8Array) || pdfBytes.length === 0) {
      throw new Error('Bundle processing returned invalid or empty PDF data');
    }

    // Password protection, applied last so it wraps the finished bundle. Read
    // straight from the field, never through the config: config is serialised
    // into the bundle's own metadata, and a password stored inside the
    // document it protects is not a password.
    const bundlePassword = (document.getElementById('config-bundlePassword')?.value ?? '').trim();
    if (bundlePassword) {
      showProcessingOverlay('Protecting bundle…');
      const { encryptPdf } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url));
      pdfBytes = await encryptPdf(pdfBytes, bundlePassword);
    }

    const sanitize = (str) => str.replace(/[<>:"/\\|?*.]/g, '-');
    const truncate  = (str, maxLen) => str.length > maxLen ? str.slice(0, maxLen) : str;
    const today     = new Date().toISOString().slice(0, 10);
    const parts     = [
      configOptions.heading.bundleTitle?.trim(),
      configOptions.heading.claimNumber?.trim(),
      configOptions.heading.projectName?.trim(),
      today,
    ].filter(p => p);
    let bundleFilename = sanitize(parts.join('-')) + '.pdf';
    if (bundleFilename.length > 251) bundleFilename = truncate(sanitize(parts.join('-')), 247) + '.pdf';

    // Fire-and-forget: the user's PDF is already in hand via the download
    // button showBundleReadyState renders, so a slow or failed local save
    // must never hold up or break "your bundle is ready".
    saveFinishedBundle(pdfBytes, bundleFilename);
    if (preview) {
      state._cancelReject = null;
      document.getElementById('processing-cancel-btn')?.classList.add('hidden');
      hideProcessingOverlay();
      openBundlePreview(pdfBytes, bundleFilename);
    } else {
      showBundleReadyState(pdfBytes, bundleFilename);
    }
    markBuildFinished();
    return;
  } catch (error) {
    markBuildFinished();
    state._cancelReject = null;
    document.getElementById('processing-cancel-btn')?.classList.add('hidden');
    if (error.message === '__cancelled__') {
      cancelled = true;
      hideProcessingOverlay();
      return;
    }
    console.error('[FRONTEND ERROR] Bundle generation failed:', error);
    const errorType = error.message === '__timeout__' ? 'timeout' : isMemoryError(error) ? 'oom' : isLoadingError(error) ? 'loadErr' : 'other';
    if (error.message === '__timeout__') {
      showErrorModal({ code: 'BT-BUILD-03', title: 'Bundle generation timed out', message: 'Your bundle took too long to generate (more than 4 minutes). The browser may be running low on memory, or you may have a very large bundle. Try closing other tabs, or split your documents into smaller batches.' });
    } else if (errorType === 'oom') {
      showErrorModal({ code: 'BT-BUILD-04', title: 'Not enough memory', message: 'Your browser ran out of memory processing this bundle. This isn\'t an error in BundleTool, but to do with the memory available in your computer. It usually happens when a bundle is very large, or you have many tabs or apps open. Try splitting your documents into smaller batches, or close other tabs or apps to free up memory.' });
    } else if (errorType === 'loadErr') {
      showErrorModal({ code: 'BT-BUILD-05', title: 'Connection error', message: 'Loading error. Please check your internet connection and try again.' });
    } else {
      showErrorModal({ code: 'BT-BUILD-06', title: 'Bundle generation failed', message: 'Something went wrong while creating your bundle. If this keeps happening, please send a bug report with the details below.', error });
    }
    hideProcessingOverlay();
  }
}

export async function runPreviewIndex() {
  if (getAllFileRows().length === 0) { pulseStep2(); return; }
  state.buildStarted = true;

  if (!state.processTheBundle) {
    ({ processTheBundle: state.processTheBundle } = await lazyImport(new URL('../bundletoolMain.js', import.meta.url)));
  }

  const configOptions = { ...gatherConfigOptions(), index: { ...gatherConfigOptions().index, justTheIndex: true } };
  state.config.updateOptions(configOptions);

  const previewIndexData = buildIndexData();
  if (previewIndexData.totalFileCount === 0) {
    showErrorModal({ code: 'BT-INDEX-01', title: 'No documents added', message: 'Please add at least one document before generating an index preview.' });
    return;
  }

  const BUNDLE_TIMEOUT_MS = 240_000;
  let cancelled = false;
  let readyStateShown = false;
  showProcessingOverlay('Building index preview…');
  // Cancellable, like Create Bundle: it runs the same pipeline over the same
  // documents, so on a large bundle it takes the same minutes, and without a
  // cancel button the only way out would be to reload the page and lose the
  // whole table.
  document.getElementById('processing-cancel-btn')?.classList.remove('hidden');
  try {
    const pdfBytes = await Promise.race([
      state.processTheBundle(state.filesMap, previewIndexData, state.config, (label) => { if (!cancelled) showProcessingOverlay(label); }, state.coversheetFile),
      new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), BUNDLE_TIMEOUT_MS)),
      new Promise((_, reject) => { state._cancelReject = reject; }),
    ]);
    if (!pdfBytes || !(pdfBytes instanceof Uint8Array) || pdfBytes.length === 0) {
      throw new Error('Preview returned invalid or empty PDF data');
    }
    // "Index ready!" with Save and Preview, the same pattern Create Bundle
    // uses (showBundleReadyState), rather than opening the viewer unasked.
    // readyStateShown gates the finally
    // block below: showIndexReadyState populates the overlay 180ms from
    // now (see its own setTimeout), so hideProcessingOverlay() must not run
    // and wipe it back to the spinner markup in the meantime.
    const today = new Date().toISOString().slice(0, 10);
    readyStateShown = true;
    showIndexReadyState(pdfBytes, `index-preview-${today}.pdf`);
  } catch (error) {
    if (error.message === '__cancelled__') { cancelled = true; return; }
    console.error('[FRONTEND ERROR] Index preview failed:', error);
    if (error.message === '__timeout__') {
      showErrorModal({ code: 'BT-INDEX-02', title: 'Index preview timed out', message: 'The index preview took too long to generate. The browser may be running low on memory. Try closing other tabs.' });
    } else if (isLoadingError(error)) {
      showErrorModal({ code: 'BT-INDEX-03', title: 'Connection error', message: 'Loading error. Please check your internet connection and try again.' });
    } else {
      showErrorModal({ code: 'BT-INDEX-04', title: 'Index preview failed', message: 'Something went wrong while generating the index preview. If this keeps happening, please send a bug report with the details below.', error });
    }
  } finally {
    state._cancelReject = null;
    if (!readyStateShown) {
      document.getElementById('processing-cancel-btn')?.classList.add('hidden');
      hideProcessingOverlay();
    }
    state.config.updateOptions({ index: { justTheIndex: false } });
  }
}

/** A cover override is cleaned like Basic Information's fields, or stays null (follow Basic Information). */
function cleanOverride(value) {
  return value === null ? null : stripUnsuitableChars(value);
}

/** A title and date read back from a bundle's own metadata: cleaned, capped and shape-checked. */
function cleanRestoredEntry(entry) {
  return {
    title: stripUnsuitableChars(typeof entry?.title === 'string' ? entry.title : '').slice(0, 500),
    date: /^\d{4}-\d{2}-\d{2}$/.test(entry?.date || '') ? entry.date : '',
  };
}

/**
 * Writes a nested config object (the shape Config.options, a rendered
 * bundle's embedded config and a manifest's translated config all share) onto
 * the form. Shared by handleBundleRestore() and manifestIO.js's manifest
 * import, so a config coming from a rendered bundle and one coming from a
 * hand-authored JSON manifest are applied through exactly one code path.
 */
export function applyExtractedConfig(rawConfig) {
  // Whatever the config came from (a reopened bundle's own metadata, a hand-written manifest), only
  // values the build accepts reach the form; the rest fall back to the defaults below.
  const extractedConfig = sanitiseNestedConfig(rawConfig);
  document.getElementById('config-claimNumber').value  = extractedConfig.heading?.claimNumber || '';
  document.getElementById('config-bundleTitle').value  = extractedConfig.heading?.bundleTitle  || '';
  document.getElementById('config-projectName').value  = extractedConfig.heading?.projectName  || '';
  const authorEl = document.getElementById('config-author');
  if (authorEl) authorEl.value = extractedConfig.heading?.author || '';

  const pn = extractedConfig.pageNumbering || extractedConfig.page || {};
  document.getElementById('config-fontFace').value            = extractedConfig.index?.fontFace        || 'serif';
  document.getElementById('config-dateStyle').value           = currentDateStyle(extractedConfig.index?.dateStyle) || 'DD Mon. YYYY';
  document.getElementById('config-dateInputOrder').value      = extractedConfig.index?.dateInputOrder    || 'UK';
  document.getElementById('config-outlineItemStyle').value    = extractedConfig.index?.outlineItemStyle || 'plain';
  document.getElementById('config-footerFont').value          = pn.footerFont     || 'serif';
  // Segmented controls go through setBtnGroup so the highlighted button
  // matches the restored value; writing the hidden input alone leaves the
  // row showing the default while the build uses what was restored.
  const _setGroup = (group, val) => {
    if (typeof window.setBtnGroup === 'function') window.setBtnGroup(group, val);
    else { const el = document.getElementById(`config-${group}`); if (el) el.value = val; }
  };
  _setGroup('footerFontSize',   pn.footerFontSize   || 'medium');
  _setGroup('alignment',        pn.alignment        || 'centre');
  {
    const pageNumberColourEl = document.getElementById('config-pageNumberColour');
    if (pageNumberColourEl) pageNumberColourEl.value = pageNumberColourToHex(pn.pageNumberColour);
  }
  document.getElementById('config-numberingStyle').value      = pn.numberingStyle || 'PageX';
  document.getElementById('config-footerPrefix').value        = pn.footerPrefix   ?? '';
  if (pn.plateColour !== undefined) {
    const el = document.getElementById('config-plateColour');
    if (el) el.value = pn.plateColour;
  }
  if (pn.plateOpacity !== undefined) {
    const el = document.getElementById('config-plateOpacity');
    if (el) { el.value = String(pn.plateOpacity); el.dispatchEvent(new Event('input')); }
  }
  if (pn.footerLink !== undefined) {
    const el = document.getElementById('config-footerLink');
    if (el) el.value = pn.footerLink;
  }
  document.getElementById('config-printableBundle').checked   = extractedConfig.pageOptions?.printableBundle === true;
  // Default true, unlike the flags above: a bundle with no ocr.autoDetect at all must reopen as
  // "on" (the default), not "off".
  document.getElementById('config-ocrAutoDetect').checked = extractedConfig.ocr?.autoDetect !== false;
  // Off unless the bundle (or manifest) says true: a bundle made before these settings existed reopens with both off.
  for (const [field, id] of [['turnUpright', 'config-ocrTurnUpright'], ['straighten', 'config-ocrStraighten']]) {
    const el = document.getElementById(id);
    if (el) el.checked = extractedConfig.ocr?.[field] === true;
  }
  // No separate checkbox: a bundle that stores a separate watermark flag is
  // reconciled into the text alone.
  const watermarkTextEl = document.getElementById('config-watermarkText');
  if (watermarkTextEl) {
    watermarkTextEl.value = reconcileWatermark(
      extractedConfig.pageOptions?.watermark,
      extractedConfig.pageOptions?.watermarkText,
    );
  }
  const watermarkColourEl = document.getElementById('config-watermarkColour');
  if (watermarkColourEl) watermarkColourEl.value = extractedConfig.pageOptions?.watermarkColour || '#999999';
  if (extractedConfig.pageOptions?.watermarkOpacity !== undefined) {
    const el = document.getElementById('config-watermarkOpacity');
    if (el) { el.value = String(extractedConfig.pageOptions.watermarkOpacity); el.dispatchEvent(new Event('input')); }
  }
  if (extractedConfig.pageOptions?.pageSize) {
    const el = document.getElementById('config-pageSize');
    if (el) el.value = extractedConfig.pageOptions.pageSize;
  }
  // On unless the bundle (or manifest) says false: a bundle made before the setting existed reopens with it on, the
  // default.
  {
    const el = document.getElementById('config-smallerPhotos');
    if (el) el.checked = extractedConfig.pageOptions?.smallerPhotos !== false;
  }
  if (extractedConfig.index?.sectionPrefix !== undefined)
    document.getElementById('config-sectionPrefix').value = extractedConfig.index.sectionPrefix;
  document.getElementById('config-pageNumberPerSection').checked = extractedConfig.pageNumbering?.pageNumberPerSection === true;

  // Cover page. A generated cover is NOT brought back as a file: it is
  // redrawn from these fields on the next build, so a bundle reopened after
  // the bundle title changed does not carry the old title on its front page.
  // An uploaded coversheet is brought back as a file. A bundle that records
  // no cover, or no cover setting at all (one made by BunTool, for example),
  // reopens with none: covers are opt-in through the maker, and the
  // generate-time warning catches a bundle on its way back out without one.
  const coverSource = coverSourceOf(extractedConfig);
  const cover = extractedConfig.cover || {};
  const _setCover = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  _setCover('config-courtName',      cover.courtName);
  _setCover('config-matterOf',       cover.matterOf);
  _setCover('config-applicantName',  cover.applicantName);
  _setCover('config-respondentName', cover.respondentName);
  _setCover('config-partyLabel1',    cover.partyLabel1);
  _setCover('config-partyLabel2',    cover.partyLabel2);
  _setCover('config-coverExtraText', cover.extraText);
  for (const f of COVER_FOLLOW) setCoverOverride(f.own, cover[f.key] ?? null);
  // Segmented, not a plain field, as with footerFontSize and alignment
  // above: go through setBtnGroup so the highlighted button matches what was
  // actually restored, not the default. A bundle with no cover.layout falls
  // back to 'classic', the layout such a bundle was drawn with.
  _setGroup('coverLayout', cover.layout || 'classic');
  // A bundle without these settings gets the defaults.
  _setGroup('coverCaseLine', cover.caseNumberLine || 'court');
  _setGroup('coverLabelPlacement', cover.partyLabelPlacement || 'inline');
  _setGroup('coverPartyAlign', cover.partyAlign || 'centre');
  _setGroup('coverCaseAlign', cover.caseNumberAlign || 'right');
  _setGroup('coverHeadingAlign', cover.headingAlign || 'left');
  _setGroup('coverTitleLines', cover.titleLines || 'single');
  // A dedicated line, not _setCover: a bundle with no stored caseNumberLabel was drawn with
  // "CASE NO:", so the field falls back to that default, not to blank; a bundle that genuinely
  // stores an empty value keeps its blank on reopening.
  { const el = document.getElementById('config-caseNumberLabel'); if (el) el.value = cover.caseNumberLabel ?? 'CASE NO:'; }
  // Likewise: a bundle with no stored preparedByLabel was drawn with "Prepared by:".
  { const el = document.getElementById('config-preparedByLabel'); if (el) el.value = cover.preparedByLabel ?? 'Prepared by:'; }
  // Likewise: a bundle with no stored partyJoiner was drawn with "-and-".
  { const el = document.getElementById('config-partyJoiner'); if (el) el.value = cover.partyJoiner ?? '-and-'; }
  window.refreshAdvancedState?.();
  const generateCoverEl = document.getElementById('config-generateCover');
  if (generateCoverEl) generateCoverEl.checked = coverSource === 'generated';
}

export async function handleBundleRestore(file) {
  if (!file) return;
  console.log('Processing bundle upload...');
  showProcessingOverlay('Reading bundle…');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const bundleBytes = new Uint8Array(arrayBuffer);

    const { openBundle, splitBundlePdf, normaliseBundleMetadata, coverSourceOf } =
      await lazyImport(new URL('../bundletoolRestore.js', import.meta.url));

    // One parse for metadata, config and the split: three separate full
    // parses of the same file would be three times the work and three times
    // the peak memory on a large bundle.
    console.log('Opening bundle...');
    const opened = await openBundle(bundleBytes);
    const metadata = opened.metadata;
    if (!metadata || metadata.length === 0) {
      hideProcessingOverlay();
      showErrorModal({ code: 'BT-OPEN-01', title: 'Not a BundleTool bundle', message: 'BundleTool couldn\'t find its data in this PDF. Please check that you have selected a bundle created with the latest version of BundleTool, not any other PDF.' });
      return;
    }
    if (opened.damaged) {
      console.warn('[restore] bundle itself is damaged:', opened.disclosure);
    }

    // A bundle with more sections than a bundle holds is not opened at all, before anything is split or replaced.
    const sections = normaliseBundleMetadata(metadata);
    const tooMany = sectionLimitProblem(sections.length, 'bundle');
    if (tooMany) {
      hideProcessingOverlay();
      showUploadWarningModal({ code: tooMany.code, title: tooMany.title, message: tooMany.message });
      return;
    }

    const extractedConfig = sanitiseNestedConfig(opened.config);
    const coverSource = coverSourceOf(extractedConfig);

    console.log('Splitting bundle into individual documents...');
    showProcessingOverlay('Extracting documents…');
    const extractedFiles   = await splitBundlePdf(opened.doc, metadata, coverSource === 'uploaded',
      (i, total) => showProcessingOverlay(`Extracting document ${i} of ${total}…`));

    // Splitting worked, so it is safe to replace the form. Replacing it first would leave the form
    // overwritten and the table unchanged for a bundle whose metadata is readable but whose
    // documents cannot be split.
    applyExtractedConfig(extractedConfig);

    // Clear existing state. The table is about to hold a different bundle, so this tab's form is no
    // longer in step with the snapshot it last saved or restored: a refresh must not lay this
    // bundle's typing over the old documents (and it is saved below).
    setCurrentSnapshot(null);
    document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').forEach(el => el.remove());
    const restoreSection0000 = getDefaultSection0000();
    if (restoreSection0000) restoreSection0000.innerHTML = '';
    stopAllReading();
    state.filesMap.clear();
    Object.keys(state.frontendInputData).forEach(key => delete state.frontendInputData[key]);
    state.isSectioned    = false;
    state.nextSectionNum = 1;
    document.getElementById('file-table')?.classList.remove('sectioned');

    if (!state.countPdfPages) {
      ({ countPdfPages: state.countPdfPages } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url)));
    }

    const table    = document.querySelector('#file-table table');

    const flaggedRedactions = [];
    let restoreLabel0000 = '', restoreName0000 = '';
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      let tbody;
      // The first section always maps to the DOM's default section-0000 element,
      // regardless of its stored sectionID (an unsectioned bundle stores '0000'; a
      // sectioned bundle stores '0001', because 0000 is redesignated at build time).
      if (si === 0) {
        tbody = getDefaultSection0000();
        restoreLabel0000 = section.sectionLabel || '';
        restoreName0000  = section.sectionName  || '';
      } else {
        tbody = createSectionTbody(section.sectionID, section.sectionLabel || '', section.sectionName || '');
        table?.appendChild(tbody);
        if (!state.isSectioned) {
          state.isSectioned = true;
          document.getElementById('file-table')?.classList.add('sectioned');
        }
        const num = parseInt(tbody.dataset.sectionId, 10);
        if (!isNaN(num) && num >= state.nextSectionNum) state.nextSectionNum = num + 1;
      }
      for (const entry of (section.files || [])) {
        const pdfBytes = extractedFiles.get(entry.filename);
        if (!pdfBytes) { console.warn('[restore] a document listed in the index was missing from the split output'); continue; }
        const key = uniqueFilename(entry.filename, state.filesMap);
        state.filesMap.set(key, new File([pdfBytes], entry.filename, { type: 'application/pdf' }));
        const { pageCount, redactedPages } = await inspectRestoredFile(state.filesMap.get(key));
        state.frontendInputData[key] = { ...cleanRestoredEntry(entry), pageCount, ...(redactedPages.length ? { redactedPages } : {}) };
        if (redactedPages.length) flaggedRedactions.push(entry.filename);
        tbody.appendChild(makeFileRow(key, state.frontendInputData[key]));
      }
      if (state.isSectioned) ensureEmptyPlaceholder(tbody);
    }

    if (state.isSectioned) {
      const section0000 = getDefaultSection0000();
      if (section0000?.querySelector('tr.file-row')) {
        createSection0000HeaderRow(section0000, restoreLabel0000, restoreName0000);
        ensureEmptyPlaceholder(section0000);
      }
    }

    const coversheetBytes = extractedFiles.get('coversheet.pdf');
    if (coversheetBytes) {
      const blob = new Blob([coversheetBytes], { type: 'application/pdf' });
      state.coversheetFile = new File([blob], 'coversheet.pdf', { type: 'application/pdf' });
      setCoversheetSelected('coversheet.pdf');
    } else {
      // No uploaded cover in this bundle: clear any coversheet left over from
      // before the restore, and let the status line reflect what was restored
      // (a maker design, or nothing).
      setCoversheetSelected(null);
    }

    console.log(`✓ Bundle unpacked: ${extractedFiles.size} documents extracted`);
    refreshBundleTotals();
    markDirty({ immediate: true });   // this tab now holds a new session: save it as its own
    hideProcessingOverlay();
    warnAboutRestoredRedactions(flaggedRedactions);
  } catch (error) {
    hideProcessingOverlay();
    console.error('Failed to process bundle:', error);
    if (error?.name === 'EncryptedPdfError') {
      showErrorModal({ code: 'BT-OPEN-02', title: 'This PDF is protected', message: error.userMessage ?? error.message });
    } else if (error?.name === 'UnreadablePdfError') {
      showErrorModal({ code: 'BT-OPEN-03', title: 'Could not read this PDF', message: error.userMessage ?? error.message });
    } else {
      showErrorModal({ code: 'BT-OPEN-04', title: 'Failed to open bundle', message: 'Something went wrong while opening the bundle. If this keeps happening, please send a bug report with the details below.', error });
    }
  }
}

/**
 * Splits a bundle PDF and adds its documents to the current table, leaving the
 * rest of the session alone. This is the mid-assembly counterpart to
 * handleBundleRestore(): that one replaces the table and the settings, this
 * one only contributes documents, keeping their indexed titles and dates.
 *
 * @param {File} file - a PDF detectBundle() has already recognised
 * @param {HTMLElement|null} targetTbody - section to add into; default 0000
 * @returns {Promise<boolean>} whether anything was added
 */
export async function splitBundleInPlace(file, targetTbody = null) {
  showProcessingOverlay('Extracting documents…');
  try {
    const bundleBytes = new Uint8Array(await file.arrayBuffer());
    const { openBundle, splitBundlePdf, normaliseBundleMetadata, coverSourceOf } =
      await lazyImport(new URL('../bundletoolRestore.js', import.meta.url));

    const opened = await openBundle(bundleBytes);
    if (!opened.metadata || opened.metadata.length === 0) {
      hideProcessingOverlay();
      showErrorModal({ code: 'BT-OPEN-05', title: 'Not a BundleTool bundle', message: 'BundleTool couldn\'t find its data in this PDF after all, so nothing was added.' });
      return false;
    }

    const sections  = normaliseBundleMetadata(opened.metadata);
    const extracted = await splitBundlePdf(opened.doc, opened.metadata, coverSourceOf(opened.config) === 'uploaded',
      (i, total) => showProcessingOverlay(`Extracting document ${i} of ${total}…`));

    if (!state.countPdfPages) {
      ({ countPdfPages: state.countPdfPages } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url)));
    }

    const tbody = targetTbody || getDefaultSection0000();
    removeEmptyPlaceholder(tbody);
    let added = 0;
    const flaggedRedactions = [];
    for (const section of sections) {
      for (const entry of (section.files || [])) {
        const pdfBytes = extracted.get(entry.filename);
        if (!pdfBytes) continue;
        const asFile = new File([pdfBytes], entry.filename, { type: 'application/pdf' });
        // The same already-added rule the drop path applies: same name and
        // size is the same document, and adding it twice is never the intent.
        let duplicate = false;
        for (const existing of state.filesMap.values()) {
          if (existing.name === asFile.name && existing.size === asFile.size) { duplicate = true; break; }
        }
        if (duplicate) continue;
        const key = uniqueFilename(entry.filename, state.filesMap);
        state.filesMap.set(key, asFile);
        const { pageCount, redactedPages } = await inspectRestoredFile(asFile);
        state.frontendInputData[key] = { ...cleanRestoredEntry(entry), pageCount, ...(redactedPages.length ? { redactedPages } : {}) };
        if (redactedPages.length) flaggedRedactions.push(entry.filename);
        tbody.appendChild(makeFileRow(key, state.frontendInputData[key]));
        added++;
      }
    }
    if (added > 0) { refreshBundleTotals(); markDirty({ immediate: true }); }
    hideProcessingOverlay();
    warnAboutRestoredRedactions(flaggedRedactions);
    return added > 0;
  } catch (error) {
    hideProcessingOverlay();
    console.error('Failed to split bundle in place:', error);
    if (error?.name === 'EncryptedPdfError' || error?.name === 'UnreadablePdfError') {
      showErrorModal({ code: 'BT-OPEN-06', title: 'Could not read this bundle', message: error.userMessage ?? error.message });
    } else {
      showErrorModal({ code: 'BT-OPEN-07', title: 'Failed to split the bundle', message: 'Something went wrong while splitting the bundle into documents. You can still add it as a single document.', error });
    }
    return false;
  }
}

export function setup(form, runPreviewIndexFn) {
  form.addEventListener('submit', (e) => handleFormSubmit(e, form));

  document.getElementById('processing-overlay')?.addEventListener('click', (e) => {
    if (e.target.closest('#processing-cancel-btn')) {
      state._cancelReject?.(new Error('__cancelled__'));
    }
  });

  // One Preview Index button: step 4 carries every build action.
  document.getElementById('preview-index-btn')?.addEventListener('click', async () => {
    if (getAllFileRows().length === 0) { pulseStep2(); return; }
    if (!await confirmMissingInfo()) return;
    runPreviewIndex();
  });
}

/**
 * Fills in the large-bundle warning's detail line; confirmLargeBundle() shows
 * the modal.
 *
 * Rather than only naming a fixed threshold, it says what this particular
 * bundle is likely to cost, because "over 1000 pages" does not tell anyone
 * whether their machine will cope and the estimate does. The figure is
 * labelled as an estimate in the text for the same reason it is labelled as
 * one in the code: it is extrapolated from measured runs, not measured for
 * this bundle.
 *
 * @param {number} totalPages
 * @param {number} totalSizeMB
 */
function fillLargeBundleWarning(totalPages, totalSizeMB) {
  const detail = document.getElementById('large-bundle-detail');
  if (detail) {
    const peak = estimatePeakMemoryMB(totalPages, totalSizeMB);
    const peakStr = peak >= 1024 ? `${(peak / 1024).toFixed(1)} GB` : `${peak} MB`;
    detail.textContent = `This bundle is ${totalPages} pages and ${totalSizeMB.toFixed(0)} MB, `
      + `which we estimate will need around ${peakStr} of memory while it builds. `
      + `Closing other tabs and other applications first makes it much more likely to finish.`;
  }
}
