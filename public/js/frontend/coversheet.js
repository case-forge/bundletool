import { state } from './state.js';
import { markDirty } from '../bundletoolAutosave.js';
import { showErrorModal, showUploadWarningModal, unlockWithPrompt, confirmRedactionMarkers } from './modals.js';
import { admitFile, safeFileName, correctedName } from './fileGate.js';
import { imageFileToPdfFile, explainImageProblem } from './imageFiles.js';
import { lazyImport } from '/js/shared/lazy-load.js';

const coversheetInput    = document.getElementById('coversheet-input');
const coversheetFilename = document.getElementById('coversheet-filename');
const coversheetClearBtn = document.getElementById('coversheet-clear-btn');
const coversheetBtnText  = document.getElementById('coversheet-btn-text');
const coversheetConvertedBadge = document.getElementById('coversheet-converted');

/**
 * Renders the cover slot's status from the two pieces of cover state: an
 * uploaded file (state.coversheetFile) or a maker-confirmed design
 * (config-generateCover). Exactly one can be active (the upload and confirm
 * paths each clear the other), so the status line names one thing or nothing.
 */
export function refreshCoverStatus() {
  const uploaded  = state.coversheetFile;
  const generated = document.getElementById('config-generateCover')?.checked === true;
  const label = uploaded ? uploaded.name : generated ? 'Coversheet designed' : '';
  if (coversheetFilename) {
    coversheetFilename.textContent = label;
    coversheetFilename.title = label;   // the line is cut short with an ellipsis when long
    coversheetFilename.classList.toggle('hidden', !label);
  }
  coversheetClearBtn?.classList.toggle('hidden', !label);
  // The name is cut short on screen, so the button says which cover page it removes.
  coversheetClearBtn?.setAttribute('aria-label', label ? `Remove cover page ${label}` : 'Remove cover page');
  coversheetConvertedBadge?.classList.toggle('hidden', !(uploaded && state.coversheetConverted));
  if (coversheetBtnText) coversheetBtnText.textContent = generated ? 'Edit Coversheet' : 'Add Coversheet';
}

/**
 * Kept for the callers that set or clear an uploaded coversheet: passing null
 * clears the upload; passing a name only refreshes the display (the caller
 * has already set state.coversheetFile).
 */
export function setCoversheetSelected(name) {
  if (!name) state.coversheetFile = null;
  refreshCoverStatus();
}

/** Clears whichever cover is active: the upload, or the maker's design. */
function removeCover() {
  state.coversheetFile = null;
  state.coversheetConverted = false;
  const generateCoverEl = document.getElementById('config-generateCover');
  if (generateCoverEl) generateCoverEl.checked = false;
  refreshCoverStatus();
  markDirty();
}

function acceptUpload(file, processedBytes, converted = false) {
  state.coversheetFile = new File([processedBytes], file.name, { type: 'application/pdf' });
  state.coversheetConverted = converted;
  // One cover slot: the user's own page discards any maker-confirmed design.
  const generateCoverEl = document.getElementById('config-generateCover');
  if (generateCoverEl) generateCoverEl.checked = false;
  refreshCoverStatus();
  markDirty({ immediate: true });
}

export function setup() {
  coversheetInput?.addEventListener('change', async (e) => {
    let file = e.target.files?.[0];
    coversheetInput.value = '';
    if (!file) return;

    // The same gate as Add Documents: what the file is comes from its bytes, and a file that is empty,
    // too large or of a kind BundleTool does not read is refused with a message that says what to do.
    const admission = await admitFile(file, { outcome: 'used as a coversheet' });
    if (!admission.ok) {
      showUploadWarningModal({ code: admission.code, title: admission.title, message: admission.message, guide: true });
      return;
    }
    if (admission.note) showUploadWarningModal({ code: null, title: 'Used as a coversheet, with a note', message: admission.note });
    const shownName = correctedName(safeFileName(file.name), admission.kind);
    if (shownName !== file.name) file = new File([file], shownName, { type: file.type });

    // A letterhead arrives as a photo as often as a PDF; wrap it into a PDF the same
    // way a photo added as a document is (only its first page is used).
    if (admission.route === 'photo') {
      try {
        file = await imageFileToPdfFile(file, document.getElementById('config-pageSize')?.value);
      } catch (error) {
        explainImageProblem(error, file.name, 'used as a coversheet');
        return;
      }
    }

    // A Word document is converted the way one added as a document is, so a
    // firm's letterhead can stay a .docx. Only the first page is used, as for
    // any other coversheet.
    let convertedFromDocx = false;
    if (admission.route === 'docx') {
      try {
        const { docxToPdf } = await lazyImport(new URL('../bundletoolDocx.js', import.meta.url));
        const converted = await docxToPdf(new Uint8Array(await file.arrayBuffer()),
          document.getElementById('config-pageSize')?.value);
        file = new File([converted], file.name.replace(/\.(docx|docm)$/i, '') + '.pdf', { type: 'application/pdf' });
        convertedFromDocx = true;
      } catch (error) {
        if (error?.name === 'DocxReadError') {
          showUploadWarningModal({ code: 'BT-COVER-01', title: 'That file is damaged', message: `"${file.name}" looks like a Word document but its contents do not read properly, so it was not used as a coversheet. Open it in Word, save it again as a Word document (.docx) or as a PDF, then add that.`, guide: true });
          return;
        }
        showErrorModal({ code: 'BT-COVER-02', title: 'Could not convert this document', message: `"${file.name}" could not be read as a Word document, so it was not used as a coversheet.`, error });
        return;
      }
    }

    // Only the first page is used, so only a redaction marker on it matters. A file that cannot be
    // read closely here (password-protected, damaged) is dealt with by the validation just below.
    try {
      const { coverRedactionPages } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url));
      if ((await coverRedactionPages(file)).length && !(await confirmRedactionMarkers(file.name, 'page 1'))) return;
    } catch { /* not a readable PDF yet: the validation below says why */ }

    if (!state.validateCoverPage) {
      ({ validateCoverPage: state.validateCoverPage } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url)));
    }
    try {
      acceptUpload(file, await state.validateCoverPage(file), convertedFromDocx);
    } catch (error) {
      // A password-protected coversheet gets the same prompt-and-decrypt flow
      // the file table gives, not a refusal.
      if (error?.name === 'EncryptedPdfError') {
        const decrypted = await unlockWithPrompt(file.name, new Uint8Array(await file.arrayBuffer()));
        if (!decrypted) return;
        try {
          const unlocked = new File([decrypted], file.name, { type: 'application/pdf' });
          acceptUpload(unlocked, await state.validateCoverPage(unlocked), convertedFromDocx);
        } catch (retryError) {
          showErrorModal({ code: 'BT-COVER-03', title: 'That coversheet could not be used', message: `"${file.name}" was unlocked but could not be used as a coversheet. Choose another file.`, error: retryError });
        }
      } else if (error?.name === 'CoverPageError') {
        showUploadWarningModal({
          code: 'BT-COVER-04',
          title: 'That file cannot be used as a coversheet',
          message: `"${file.name}" ${error.userMessage}, so it was not used as a coversheet. Choose another file, or print its first page to a new PDF from a PDF reader.`,
          guide: true,
        });
      } else {
        showErrorModal({
          code: 'BT-COVER-05',
          title: 'That coversheet could not be read',
          message: `"${file.name}" could not be read as a PDF, so it was not used as a coversheet. It may be damaged or not really a PDF: open it in a PDF reader and print it to a new PDF, or choose another file.`,
          error,
        });
      }
    }
  });

  coversheetClearBtn?.addEventListener('click', removeCover);
}
