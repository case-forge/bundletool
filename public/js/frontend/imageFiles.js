/**
 * The front-end side of adding a photo: turns the chosen file into a PDF File, or tells the
 * person plainly why it could not be used. Shared by "Add Documents" and the coversheet's
 * "add your own", so both accept the same photos and word their problems the same way.
 */
import { imageToPages, isImageFile, stripPhotoExtension, ImageFormatError } from '../bundletoolImages.js';
import { showErrorModal, showUploadWarningModal } from './modals.js';
import { lazyImport } from '/js/shared/lazy-load.js';

export { isImageFile };

/**
 * @param {File} file
 * @param {string} [pageSizeKey] the bundle's page size, so a photo is not placed on the wrong sheet
 * @returns {Promise<File>} a PDF named after the photo
 * @throws {ImageFormatError | Error}
 */
export async function imageFileToPdfFile(file, pageSizeKey) {
  const pages = await imageToPages(new Uint8Array(await file.arrayBuffer()));
  const { imagesToPdf } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url));
  let pdf;
  try {
    pdf = await imagesToPdf(pages, pageSizeKey);
  } catch (error) {
    // A JPEG or PNG that is passed through untouched is only parsed here, so a damaged one fails
    // here: that is a problem with the photo, not a bug to report.
    throw new ImageFormatError('decode', 'That picture is damaged and could not be read.');
  }
  return new File([pdf], `${stripPhotoExtension(file.name)}.pdf`, { type: 'application/pdf' });
}

/**
 * A short reason for a photo BundleTool cannot use, for a list of several rejected files, or null when
 * the failure is not about the photo itself (a bug, which is reported in full instead).
 */
export function imageProblemReason(error) {
  if (!(error instanceof ImageFormatError)) return null;
  switch (error.code) {
    case 'heic': return 'this browser cannot open HEIC photos';
    case 'unsupported': return 'not a type of photo BundleTool can read';
    case 'toolarge': return 'too large';
    case 'decode': return 'damaged or cut short';
    default: return null;
  }
}

/**
 * Explains a failed photo. A file that is simply the wrong kind, or a HEIC this browser cannot
 * open, is a warning with a link to the Guide's list; a photo that failed to read is an error
 * the person can report.
 *
 * @param {Error} error
 * @param {string} fileName
 * @param {string} outcome what did not happen, for example "added" or "used as a coversheet"
 */
export function explainImageProblem(error, fileName, outcome) {
  if (error instanceof ImageFormatError && error.code === 'heic') {
    showUploadWarningModal({
      code: 'BT-PHOTO-01',
      title: 'This browser cannot open HEIC photos',
      message: `"${fileName}" was not ${outcome}. ${error.userMessage}`,
      guide: true,
    });
  } else if (error instanceof ImageFormatError && error.code === 'unsupported') {
    showUploadWarningModal({
      code: 'BT-PHOTO-02',
      title: 'That file is not a supported photo',
      message: `"${fileName}" is not a type of photo BundleTool can read, so it was not ${outcome}.`,
      guide: true,
    });
  } else if (error instanceof ImageFormatError && (error.code === 'decode' || error.code === 'toolarge')) {
    // The picture itself is the problem (damaged, cut short or too large), not the program: say so
    // plainly and point at the Guide rather than offering a bug report.
    showUploadWarningModal({
      code: error.code === 'toolarge' ? 'BT-PHOTO-03' : 'BT-PHOTO-04',
      title: error.code === 'toolarge' ? 'That photo is too large' : 'That photo could not be read',
      message: `"${fileName}" was not ${outcome}. ${error.userMessage} The Guide lists what BundleTool can open.`,
      guide: true,
    });
  } else {
    showErrorModal({
      code: 'BT-PHOTO-05',
      title: 'Could not convert this photo',
      message: `"${fileName}" could not be read as a photo, so it was not ${outcome}. ${error instanceof ImageFormatError ? error.userMessage : ''}`.trim(),
      error,
    });
  }
}
