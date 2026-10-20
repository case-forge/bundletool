import {
  isLargeBundle, LARGE_BUNDLE_PAGES, LARGE_BUNDLE_MB, wholeAddProblem,
  MAX_PDF_PAGES, MAX_TOTAL_PAGES, MAX_PAGE_POINTS,
} from './limits.js';
import { admitFile, safeFileName, correctedName } from './fileGate.js';
import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { createRowBatcher, measureFrameCost } from './rowBatch.js';
import { parseDateFromFilename, prettifyTitle, stripDoubleChars, uniqueFilename } from './utils.js';
import { makeFileRow, removeEmptyPlaceholder, setReadingBadge } from './fileRows.js';
import { scheduleAutoOcr } from './ocrAuto.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { showSectionPicker } from './sections.js';
import { showErrorModal, showUploadWarningModal, showLimitNotice, confirmDamagedFile, confirmRedactionMarkers, confirmBundleAction, unlockWithPrompt } from './modals.js';
import { describePages } from '../bundletoolPdfSafety.js';
import { getDefaultSection0000 } from './helpers.js';
import { looksLikeManifest } from '../manifestSchema.js';
import { isImageFile, imageFileToPdfFile, explainImageProblem, imageProblemReason } from './imageFiles.js';
import { resolveDrop, showDropIndicator, clearDropIndicator } from './dropPosition.js';
import { lazyImport } from '/js/shared/lazy-load.js';

// The row batcher (rowBatch.js) holds a validated file's row back for up to its own gap (up to
// DEFAULT_MAX_GAP_MS, 2s on a slow device) before inserting it and calling markDirty(). In that
// window the file is already in state.filesMap/frontendInputData (a save right now would include
// it), but markDirty() has not fired, so isSavePending() would otherwise say nothing is at risk.
// Exposed so bundletoolAutosave.js can fold a pending batch into what it warns about.
//
// A Set, not a single slot: processFiles() is called from several independent entry points (the
// drop handlers, sections.js, wsCover.js), and nothing stops two calls overlapping, for instance a
// drop landing while a witness statement cover is still batching its own rows. With a single slot,
// the first call's finally would clear the second call's still-pending batch, reporting nothing
// pending while the second call's rows sat unsaved. Each call only adds and removes its OWN batch
// object, so finishing never touches another call's live one.
const _activeBatches = new Set();
export function hasPendingRowBatches() {
  for (const batch of _activeBatches) if (batch.pendingCount > 0) return true;
  return false;
}

/**
 * Registers a batch for hasPendingRowBatches() to see, and returns a release function that
 * removes ONLY this one, never another call's still-active batch, however the two overlap or
 * finish. Kept apart from processFiles() itself (which needs a real page to exercise at all) so
 * the tracking logic is directly testable without one.
 */
export function trackRowBatch(batch) {
  _activeBatches.add(batch);
  return () => _activeBatches.delete(batch);
}

/** .docx only: mammoth cannot read the binary .doc format. */
function isDocxFile(file) {
  return file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.docx$/i.test(file.name);
}

/** How a picked file is remembered: name and size as chosen, before any conversion or rotation. */
const sourceSignature = (file) => `${file.name}|${file.size}`;

/**
 * A file counts as already added when a stored file carries the same name and
 * size. Names alone are not enough: the same name at a different size is a
 * revised document and both copies are kept (uniqueFilename renames the new
 * one). Sameness of bytes is not checked: hashing every drop would read every
 * file twice, and a same-name same-size different-bytes pair is rare enough
 * that the rename path is an acceptable miss.
 *
 * Also true for a file whose converted form is already in: a photo or Word document is stored as a PDF
 * with a different name and size, and a turned PDF changes size, so the stored file alone would never
 * match the original again. Each row's data remembers the signature of the file as it was picked.
 */
export function isAlreadyAdded(file) {
  for (const existing of state.filesMap.values()) {
    if (existing.name === file.name && existing.size === file.size) return true;
  }
  const sig = sourceSignature(file);
  for (const key of Object.keys(state.frontendInputData)) {
    if (state.frontendInputData[key]?.source === sig) return true;
  }
  return false;
}

/**
 * Parses a document's date from its own filename, reading the live date-reading-order control
 * directly (never state.config, a Config instance refreshed only by updateOptions() inside the
 * build and preview paths: reading that would keep applying a stale value from before the last
 * build, even after the control is switched back to UK with no further build). Exported and kept
 * separate from processFiles() below so the real
 * coupling between the control and the parse can be driven directly in a test, with no browser.
 * @param {string} filename
 * @param {object} chrono
 */
export async function parseDateFromAddedFilename(filename, chrono) {
  return parseDateFromFilename(
    filename.replace(/\.[a-zA-Z0-9]{1,4}$/, ''), chrono,
    document.getElementById('config-dateInputOrder')?.value);
}

/**
 * @param {File[]} files
 * @param {HTMLElement} [targetTbody] the section to add to (the first section when omitted)
 * @param {Element|null} [beforeRow] the row the new rows go in front of (the end of the section when
 *   null). It is checked again for each file, because a row can go while a file is being read.
 */
export async function processFiles(files, targetTbody, beforeRow = null) {
  if (!targetTbody) targetTbody = getDefaultSection0000();

  // Dropping a folder's worth of PDFs twice should not build a doubled bundle.
  const duplicates = files.filter(isAlreadyAdded).map(f => f.name);
  files = files.filter(f => !isAlreadyAdded(f));
  if (files.length === 0 && duplicates.length > 0) {
    showUploadWarningModal({
      code: 'BT-ADD-04',
      title: 'Already added',
      message: duplicates.length === 1
        ? `"${duplicates[0]}" is already in the bundle, so it was not added again.`
        : `All ${duplicates.length} of those files are already in the bundle, so they were not added again.`,
    });
    return;
  }

  let existingBytes = 0;
  for (const existingFile of state.filesMap.values()) existingBytes += existingFile.size;
  const tooBig = wholeAddProblem({
    incomingCount: files.length,
    incomingBytes: files.reduce((sum, f) => sum + f.size, 0),
    existingCount: state.filesMap.size,
    existingBytes,
  });
  if (tooBig) {
    showLimitNotice(tooBig);
    return;
  }

  const validationProgress = document.getElementById('validation-progress');
  const validationBar      = document.getElementById('validation-progress-bar');
  const validationLabel    = document.getElementById('validation-progress-label');
  const totalNewFiles = files.length;
  if (validationProgress && totalNewFiles > 0) {
    validationProgress.classList.remove('hidden');
    validationBar.style.width = '0%';
    validationLabel.textContent = `0 / ${totalNewFiles}`;
  }

  // Files that could not be added, collected so several bad files give ONE message listing them all
  // (a modal per file would replace the last, leaving only the final one visible). A single rejection
  // is shown by replaying its own modal at the end.
  const skipped = [];
  const skip = (name, reason, replay) => skipped.push({ name, reason, replay });
  // Things worth telling the person about files that WERE added (a renamed extension, a script that was
  // removed, an attachment that is not included), shown with the end-of-add message.
  const notes = [];
  let pagesSoFar = 0;
  for (const info of Object.values(state.frontendInputData)) pagesSoFar += info?.pageCount ?? 0;

  // Rows are inserted in batches (see rowBatch.js), not one per file: on a slow device, painting the
  // table again after every row would take most of the time spent adding many documents.
  const batch = createRowBatcher({
    insert: (rows) => {
      removeEmptyPlaceholder(targetTbody);
      const fragment = document.createDocumentFragment();
      for (const r of rows) fragment.appendChild(r);
      targetTbody.insertBefore(fragment, beforeRow && beforeRow.parentNode === targetTbody ? beforeRow : null);
      // A row held back by the batcher can miss its document's "Reading text…" badge (the check is quick): draw it now.
      for (const r of rows) setReadingBadge(r.dataset.filename);
      markDirty({ immediate: true });
    },
    measureFrame: measureFrameCost,
  });
  const releaseBatch = trackRowBatch(batch);
  // Progress writes are batched the same way: a style change per file is a paint per file.
  let progressAt = 0;
  const showProgress = (force = false) => {
    if (!validationBar) return;
    const t = performance.now();
    if (!force && t - progressAt < 150) return;
    progressAt = t;
    validationBar.style.width = `${(validatedCount / totalNewFiles) * 100}%`;
    validationLabel.textContent = `${validatedCount} / ${totalNewFiles}`;
  };

  let validatedCount = 0;
  try {
  for (let file of files) {
    const source = sourceSignature(file);   // as picked, before a photo or Word document becomes a PDF
    const originalName = file.name;
    // One gate decides what the file is from its bytes, whatever its name says, and refuses what
    // is empty, too large or of a kind BundleTool does not read, with a message that says what to do.
    const admission = await admitFile(file);
    if (!admission.ok) {
      skip(originalName, admission.reason, () => showUploadWarningModal({ code: admission.code, title: admission.title, message: admission.message, guide: true }));
      continue;
    }
    if (admission.note) notes.push(admission.note);
    // A name that hides or reverses text, holds path separators or runs on for ever is shown, stored and
    // downloaded in a safe form; the name as picked is still what recognises the same file again.
    const shownName = correctedName(safeFileName(originalName), admission.kind);
    if (shownName !== file.name) file = new File([file], shownName, { type: file.type });
    // A photographed or scanned exhibit (see bundletoolImages.js for the accepted types)
    // is wrapped into a PDF, one page per picture, and from here on it is a document like
    // any other. The A4/Letter wrapper follows the bundle's page size, so a photo added
    // to a Letter bundle is not silently placed on an A4 sheet.
    if (admission.route === 'photo') {
      try {
        file = await imageFileToPdfFile(file, document.getElementById('config-pageSize')?.value);
      } catch (error) {
        const reason = imageProblemReason(error);
        const name = file.name;
        if (reason) skip(name, reason, () => explainImageProblem(error, name, 'added'));
        else explainImageProblem(error, name, 'added');
        continue;
      }
    }

    // A Word document is read in the browser and rendered to a PDF page (or
    // several), the same way a photo above is wrapped onto one: from here on
    // it is a document like any other. Only .docx: mammoth cannot read the
    // binary .doc format.
    let convertedFromDocx = false;
    if (admission.route === 'docx') {
      try {
        const { docxToPdf } = await lazyImport(new URL('../bundletoolDocx.js', import.meta.url));
        const converted = await docxToPdf(new Uint8Array(await file.arrayBuffer()),
          document.getElementById('config-pageSize')?.value);
        const pdfName = file.name.replace(/\.(docx|docm)$/i, '') + '.pdf';
        file = new File([converted], pdfName, { type: 'application/pdf' });
        convertedFromDocx = true;
      } catch (error) {
        const name = file.name;
        if (error?.name === 'DocxReadError') {
          // A damaged or deliberately malformed package: the file's problem, so a plain refusal, not the bug-report modal.
          skip(name, 'a damaged Word file', () => showUploadWarningModal({ code: 'BT-ADD-09', title: 'That file is damaged', message: `"${name}" looks like a Word document but its contents do not read properly, so it was not added. Open it in Word, save it again as a Word document (.docx) or as a PDF, then add that.`, guide: true }));
          continue;
        }
        skip(name, 'could not be read as a Word document', () => showErrorModal({ code: 'BT-ADD-10', title: 'Could not convert this document', message: `"${name}" could not be read as a Word document, so it was not added.`, error }));
        continue;
      }
    }

    let fileBytes = new Uint8Array(await file.arrayBuffer());
    const key = uniqueFilename(file.name, state.filesMap);
    // Parse the date from the RAW name (extension off), then prettify what is
    // left. Prettify collapses dashes to spaces, so prettifying first would
    // turn "02-04-2026" into something that no longer looks like a date
    // before the date parser saw it.
    const dateParseObj = await parseDateFromAddedFilename(file.name, state.chrono);
    const displayTitle = stripDoubleChars(prettifyTitle(dateParseObj.name));
    if (!state.validateAndCountPages) {
      ({ validateAndCountPages: state.validateAndCountPages } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url)));
    }
    let validation = await state.validateAndCountPages(fileBytes);

    // Password-protected: ask for the password and decrypt on-device.
    // Blank-user-password files (court seals) never reach here: loadPdf has
    // already opened those silently, the way every ordinary viewer does. What
    // reaches here genuinely needs a password the user holds. Encryption is
    // still never IGNORED (that produces blank ciphertext pages); it is
    // removed, with the right password, before the file joins the bundle.
    if (validation.errorKind === 'encrypted') {
      batch.flush();   // the page shows what has been added before it asks anything
      const decrypted = await unlockWithPrompt(file.name, fileBytes);
      if (!decrypted) continue;
      fileBytes = decrypted instanceof Uint8Array ? decrypted : new Uint8Array(decrypted);
      file = new File([fileBytes], file.name, { type: 'application/pdf' });
      validation = await state.validateAndCountPages(fileBytes);
      if (validation.errorKind === 'encrypted') {
        // Unlocked bytes reporting encrypted again means something is badly
        // wrong with the file; treat it as unreadable rather than looping.
        const name = file.name;
        skip(name, 'could not be unlocked', () => showErrorModal({ code: 'BT-ADD-11', title: 'Could not unlock this PDF', message: `"${name}" could not be fully decrypted, so it was not added.` }));
        continue;
      }
    }

    if (validation.error) {
      const name = file.name;
      skip(name, 'not a valid PDF', () => showErrorModal({
        code: 'BT-ADD-12',
        title: 'Not a valid PDF file',
        message: `"${name}" does not appear to be a valid PDF file. Please check the file and try again. Reasons may include a file that is not really a PDF, one that is too badly damaged to recover (try to get a better copy), or one signed by software that adds non-standard elements (try printing it to a new PDF to flatten it).`,
      }));
      continue;
    }

    // What is inside the PDF that decides whether it can be added, and what to tell the person.
    const inspect = validation.inspect;
    if (inspect) {
      const name = file.name;
      const refuseIt = (code, reason, title, message) => skip(name, reason, () => showUploadWarningModal({ code, title, message: `"${name}" ${message}`, guide: true }));
      if (inspect.pages === 0) {
        refuseIt('BT-ADD-13', 'has no pages', 'That PDF has no pages', 'has no pages, so it was not added. It may be damaged: open it in a PDF reader and save a fresh copy.');
        continue;
      }
      if (inspect.pages > MAX_PDF_PAGES) {
        refuseIt('BT-ADD-14', `too many pages (${inspect.pages.toLocaleString('en-GB')})`, 'That PDF has too many pages',
          `has ${inspect.pages.toLocaleString('en-GB')} pages, more than the ${MAX_PDF_PAGES.toLocaleString('en-GB')} one document may have here, so it was not added. Split it into parts in a PDF tool, then add the parts.`);
        continue;
      }
      if (inspect.maxEdge > MAX_PAGE_POINTS) {
        const metres = (inspect.maxEdge / 72 * 0.0254).toFixed(1);
        refuseIt('BT-ADD-15', 'pages far larger than paper', 'That PDF has enormous pages',
          `has pages about ${metres} metres across (an A0 poster is 1.2 metres), which cannot be drawn reliably, so it was not added. Print it to a normal paper size (A4 or A3) from a PDF reader and add that.`);
        continue;
      }
      if (pagesSoFar + inspect.pages > MAX_TOTAL_PAGES) {
        refuseIt('BT-ADD-16', 'would take the bundle over the page limit', 'That would make the bundle too long',
          `would take the bundle past ${MAX_TOTAL_PAGES.toLocaleString('en-GB')} pages, so it was not added. Split the documents into separate volumes (for example "Bundle A" and "Bundle B") and create separate bundles.`);
        continue;
      }
      if (inspect.isPortfolio) notes.push(`"${name}" is a PDF portfolio: the files packed inside it are not pages, so they are not in the bundle. Open the portfolio in a PDF reader, save each file out, and add them separately.`);
      else if (inspect.attachments) notes.push(`"${name}" has files attached inside it. Attachments are not pages, so they are not in the bundle. Save them out and add them separately if you need them.`);
      if (inspect.expanding) notes.push(`"${name}" holds data that unpacks to far more than its size (over 128 MB from a small part of the file). It was added, but drawing its pages can use up a computer's memory in some PDF readers, and the preview here is switched off for it. Print it to a new PDF from a PDF reader if you can.`);
      if (inspect.hasXfa) notes.push(`"${name}" is a dynamic (XFA) form. Many PDF readers show such a form as a blank page or one that says "please wait". Check the page in the bundle, and print the form to a new PDF first if it is blank.`);
    }

    // A bundle this tool made, added as if it were a document. Nesting a whole
    // bundle inside another bundle is almost never the intent, so offer the
    // alternatives. This is also how a finished bundle is reopened for editing:
    // there is no separate Load from bundle PDF control.
    if (validation.bundle && validation.bundle.documents > 0) {
      const offerOpen = state.filesMap.size === 0 && totalNewFiles === 1;
      batch.flush();
      const choice = await confirmBundleAction(file.name, validation.bundle.documents, offerOpen);
      if (choice === 'skip') continue;
      if (choice === 'open') {
        batch.flush();
        if (validationProgress) validationProgress.classList.add('hidden');
        const { handleBundleRestore } = await lazyImport(new URL('./bundleGeneration.js', import.meta.url));
        await handleBundleRestore(file);
        return;
      }
      if (choice === 'splitHere') {
        const { splitBundleInPlace } = await lazyImport(new URL('./bundleGeneration.js', import.meta.url));
        batch.flush();   // it inserts rows itself, so the earlier ones must already be in place
        await splitBundleInPlace(file, targetTbody);
        validatedCount++;
        showProgress();
        continue;
      }
      // 'addAsIs' falls through to the ordinary path below.
    }

    // Damaged but recoverable: say exactly what came back and let the user
    // decide. Refusing outright could destroy the only route into a document
    // that exists nowhere else; adding it silently would put unverified pages
    // into a court bundle. Neither is acceptable, so the user chooses.
    let recovered = false;
    let recoveryNote = '';
    if (validation.damaged) {
      batch.flush();
      const accepted = await confirmDamagedFile(file.name, validation.disclosure);
      if (!accepted) continue;
      recovered = true;
      recoveryNote = validation.disclosure || '';
    }

    // Redaction markers that were never applied: the text underneath them is still in the file, and
    // a bundle would carry it. Say so before it goes in, and let the person remove it.
    const redactedPages = validation.redactedPages || [];
    if (redactedPages.length > 0) {
      batch.flush();
      const keep = await confirmRedactionMarkers(file.name, describePages(redactedPages));
      if (!keep) continue;
    }

    const pageCount = validation.pageCount;

    const materializedFile = new File([fileBytes], file.name, { type: 'application/pdf' });
    state.filesMap.set(key, materializedFile);
    pagesSoFar += pageCount ?? 0;
    state.frontendInputData[key] = {
      title: displayTitle, date: dateParseObj.date, pageCount, source,
      ...(originalName !== file.name ? { originalName } : {}),
      ...(validation.inspect?.expanding ? { expanding: true } : {}),
      ...(recovered ? { recovered, recoveryNote } : {}),
      ...(convertedFromDocx ? { convertedFromDocx } : {}),
      ...(admission.route === 'photo' ? { convertedFromImage: true } : {}),
      ...(redactedPages.length ? { redactedPages } : {}),
    };

    const row = makeFileRow(key, {
      title: displayTitle, date: dateParseObj.date, pageCount, recovered, convertedFromDocx, redactedPages,
    });
    batch.add(row);
    // Checked and, if needed, run in the background: never delays the row appearing, and a bundle
    // added entirely as text-PDFs costs nothing beyond the character check on each page.
    scheduleAutoOcr(key);

    validatedCount++;
    showProgress();
  }
  } finally {
    // Whatever ended the loop (done, an error, a return above), rows already checked go on the page.
    batch.flush();
    batch.cancel();
    releaseBatch();
    showProgress(true);
  }

  if (validationProgress) validationProgress.classList.add('hidden');

  let totalPagesNow = 0;
  let totalSizeMbNow = 0;
  for (const [fn, f] of state.filesMap) {
    totalSizeMbNow += f.size / (1024 * 1024);
    totalPagesNow  += state.frontendInputData[fn]?.pageCount ?? 0;
  }
  // One modal, not a queue of them: the size warning and the duplicate note
  // share the same element, so a second call would overwrite the first.
  const dupNote = duplicates.length === 0 ? ''
    : duplicates.length === 1
      ? `"${duplicates[0]}" was already in the bundle and was not added again.`
      : `${duplicates.length} of the files were already in the bundle and were not added again.`;
  reportAdded(skipped, totalPagesNow, totalSizeMbNow, dupNote, undefined, notes);
}

/**
 * The one message at the end of an add: nothing rejected leaves the size and duplicate notes as they
 * were; one rejection replays its own explanation; several are listed together. If the bundle is also
 * very large, that warning is the modal (it cannot share the element) and names the rejected files.
 */
export function reportAdded(skipped, totalPagesNow, totalSizeMbNow, dupNote = '', warnFn = showUploadWarningModal, notes = []) {
  // The one place every add ends up, whatever was skipped, so it is also the one place to bring the
  // Review Table's own running total and PD27A note up to date.
  refreshBundleTotals();
  // A duplicate note means files were left out, which is worth a code; notes about files that were added are not.
  const leftOutCode = dupNote ? 'BT-ADD-19' : null;
  // Notes about files that were added (see processFiles) ride along with the duplicate note.
  if (notes.length) dupNote = [dupNote, ...notes].filter(Boolean).join('\n\n');
  const noteTitle = notes.length ? (notes.length === 1 && !skipped.length ? 'Added, with a note' : 'Added, with notes') : null;
  if (skipped.length === 0) return maybeWarnLargeBundleOnAdd(totalPagesNow, totalSizeMbNow, dupNote, warnFn, noteTitle, leftOutCode);
  if (skipped.length === 1 && !isLargeBundle(totalPagesNow, totalSizeMbNow) && !dupNote) { skipped[0].replay(); return true; }
  const lines = skipped.map(s => `"${s.name}": ${s.reason}`);
  if (isLargeBundle(totalPagesNow, totalSizeMbNow)) {
    const note = `${skipped.length} file${skipped.length === 1 ? ' was' : 's were'} not added: ${lines.join('; ')}.`;
    return maybeWarnLargeBundleOnAdd(totalPagesNow, totalSizeMbNow, [dupNote, note].filter(Boolean).join('\n\n'), warnFn, null, 'BT-ADD-18');
  }
  warnFn({
    code: 'BT-ADD-17',
    title: skipped.length === 1 ? 'A file was not added' : `${skipped.length} files were not added`,
    message: [skipped.length === 1 ? 'This file could not be added:' : 'These files could not be added:', dupNote].filter(Boolean).join('\n\n'),
    items: lines,
    guide: true,
  });
  return true;
}

/**
 * The same 1000-page / 75MB threshold the build-time gate uses
 * (bundleGeneration.js confirmLargeBundle), applied here at add-time too so
 * the caller finds out before waiting through validation and pressing
 * Create Bundle, not after. This is deliberately non-blocking: it reuses
 * showUploadWarningModal (warn-and-continue), never a second confirm dialog;
 * the build-time gate still asks before it builds.
 *
 * warnFn is injectable so this can be exercised without a DOM. `code` is the error code when the note also says that
 * files were left out (errorCodes.js); the large-bundle warning on its own, and notes about files that were added,
 * only inform, so they carry none.
 */
export function maybeWarnLargeBundleOnAdd(totalPagesNow, totalSizeMbNow, dupNote = '', warnFn = showUploadWarningModal, noteTitle = null, code = null) {
  if (isLargeBundle(totalPagesNow, totalSizeMbNow)) {
    const parts = [];
    if (totalPagesNow  > LARGE_BUNDLE_PAGES) parts.push(`${totalPagesNow} pages`);
    if (totalSizeMbNow > LARGE_BUNDLE_MB)    parts.push(`${totalSizeMbNow.toFixed(1)} MB`);
    warnFn({
      code,
      title: 'Very large bundle',
      message: `Your documents total ${parts.join(' and ')}. Court bundles over ${LARGE_BUNDLE_PAGES.toLocaleString('en-GB')} pages or ${LARGE_BUNDLE_MB} MB are rare. Consider splitting the documents into separate volumes (for example "Bundle A" and "Bundle B"). If you proceed, BundleTool may take longer than usual to process.`
        + (dupNote ? `\n\n${dupNote}` : ''),
    });
    return true;
  } else if (dupNote) {
    warnFn({ code, title: noteTitle || 'Already added', message: dupNote });
    return true;
  }
  return false;
}

/** Route freshly chosen or dropped files to the right section, with errors surfaced. */
async function routeIncomingFiles(files, targetTbody = null, beforeRow = null) {
  if (!files.length) return;
  try {
    if (targetTbody) await processFiles(files, targetTbody, beforeRow);
    else if (state.isSectioned) showSectionPicker(files);
    else await processFiles(files);
  } catch (error) {
    showErrorModal({ code: 'BT-ADD-01', title: 'Error adding files', message: 'An unexpected error occurred while adding files.', error });
  }
}

/** True when the drag carries files from outside the page, not one of our own rows. */
function isOsFileDrag(e) {
  if (state.draggedRow || state.draggedSection) return false;
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

export function setup() {
  const fileInput = document.getElementById('file-input');

  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    fileInput.value = '';
    await routeIncomingFiles(files);
  });

  // The whole page is the drop target, not just the Select Documents box.
  // The indicator overlay is pointer-events:none, so the drop still lands on
  // whatever sits under the cursor, which is how dropping onto a section adds
  // the files to that section.
  const dropZone = document.getElementById('file-drop-zone');
  const overlay  = document.getElementById('page-drop-overlay');
  let dragDepth  = 0;

  const clearDropUI = () => {
    dragDepth = 0;
    overlay?.classList.add('hidden');
    overlay?.classList.remove('over-target');
    dropZone?.classList.remove('ring-2', 'ring-accent-400');
    clearDropIndicator();
  };

  document.addEventListener('dragenter', (e) => {
    if (!isOsFileDrag(e)) return;
    dragDepth++;
    overlay?.classList.remove('hidden');
    if (dropZone?.contains(e.target)) dropZone.classList.add('ring-2', 'ring-accent-400');
  });
  document.addEventListener('dragleave', (e) => {
    if (!isOsFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) clearDropUI();
    else if (dropZone && !dropZone.contains(e.relatedTarget)) dropZone.classList.remove('ring-2', 'ring-accent-400');
  });
  // While files are dragged over the table, a thin line shows where they will go (above or below the
  // row under the pointer), or a dashed outline marks the section they will join. The page-wide
  // "Drop files" card steps out of the way while a section is under the pointer.
  let lastMark = '';
  document.addEventListener('dragover', (e) => {
    if (!isOsFileDrag(e)) return;
    e.preventDefault();
    const drop = resolveDrop(e.target, e.clientY);
    const mark = drop ? `${drop.side}:${drop.row ? [...drop.tbody.children].indexOf(drop.row) : ''}:${drop.tbody.id}` : '';
    if (mark !== lastMark) {
      lastMark = mark;
      showDropIndicator(drop);
      overlay?.classList.toggle('over-target', !!drop);
    }
  });
  document.addEventListener('drop', async (e) => {
    if (!isOsFileDrag(e)) { clearDropUI(); return; }
    e.preventDefault();

    // Read the drop target BEFORE any await: the overlay teardown and the
    // browser reclaiming the dataTransfer both race an async handler.
    const drop = resolveDrop(e.target, e.clientY);
    const targetTbody = drop?.tbody ?? null;   // with sections and no section under the pointer, the picker asks
    const beforeRow = drop?.before ?? null;
    const dropped = Array.from(e.dataTransfer.files);
    // Which dropped items are folders: only the drop event can tell, so ask now, before any await.
    const folderNames = Array.from(e.dataTransfer.items ?? [])
      .filter((it) => it.kind === 'file' && it.webkitGetAsEntry?.()?.isDirectory)
      .map((it) => it.getAsFile()?.name ?? it.webkitGetAsEntry().name);
    lastMark = '';
    clearDropUI();

    // A manifest dropped alongside its PDFs replaces the current session
    // rather than adding to it: see manifestIO.js's importManifest() doc.
    // Exactly one .json in the drop is treated as a manifest; more than one
    // is ambiguous, so it falls through to the ordinary PDF-only path (and
    // the "only PDFs and images" warning below, which is an honest message
    // for that case).
    const manifestCandidates = dropped.filter(looksLikeManifest);
    if (manifestCandidates.length === 1) {
      const manifestFile = manifestCandidates[0];
      const pdfFiles = dropped.filter((f) => f !== manifestFile && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
      try {
        const { parseManifest, importManifest, ManifestLimitError } = await lazyImport(new URL('./manifestIO.js', import.meta.url));
        let imported;
        try {
          // A manifest over a limit (more sections than a bundle holds, too many files) is refused whole, as a warning.
          imported = await importManifest(await parseManifest(manifestFile), pdfFiles);
        } catch (limit) {
          if (!(limit instanceof ManifestLimitError)) throw limit;
          showLimitNotice(limit);
          return;
        }
        const { added, missing } = imported;
        if (missing.length > 0) {
          const hint = pdfFiles.length === 0
            ? 'A manifest only records structure, not the PDFs themselves. Drag it together with the original documents in the same drop, with their filenames unchanged.'
            : 'Filenames must match the manifest exactly, same name and same case. Check none were renamed since the manifest was exported.';
          if (missing.length === 1) {
            showUploadWarningModal({
              code: 'BT-MAN-05',
              title: added > 0 ? 'Manifest imported, some documents missing' : 'No documents matched the manifest',
              message: missing[0].includes(' (') ? `"${missing[0]}" is named in the manifest but could not be used.` : `"${missing[0]}" was named in the manifest but not found among the dropped files.`,
              hint,
            });
          } else {
            showUploadWarningModal({
              code: 'BT-MAN-06',
              title: added > 0 ? 'Manifest imported, some documents missing' : 'No documents matched the manifest',
              message: `${missing.length} file(s) named in the manifest could not be imported (missing from the drop, or not usable for the reason shown):`,
              items: missing,
              hint,
            });
          }
        }
      } catch (error) {
        showErrorModal({ code: 'BT-MAN-07', title: 'Could not import that manifest', message: error.message, error });
      }
      return;
    }

    // Everything dropped goes to the gate (fileGate.js), which decides from each file's own bytes and
    // says why a file was refused. Folders cannot be read by a page, so they are named here and left out.
    const folders = folderNames;
    const files = dropped.filter(f => !folders.includes(f.name));
    if (folders.length) {
      showUploadWarningModal({
        code: 'BT-ADD-08',
        title: folders.length === 1 ? 'A folder cannot be added' : 'Folders cannot be added',
        message: `${folders.map(n => `"${n}"`).join(', ')} ${folders.length === 1 ? 'is a folder' : 'are folders'}, so ${folders.length === 1 ? 'it was' : 'they were'} not added. Open the folder and drag the files inside it, or use Add Documents and select them there.`,
        guide: true,
      });
      if (files.length === 0) return;
    }
    await routeIncomingFiles(files, targetTbody, beforeRow);
  });
}
