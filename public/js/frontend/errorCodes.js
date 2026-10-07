/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * errorCodes.js
 * Every error a person can see in BundleTool carries a short code, shown small after the message and written into
 * the bug report, so a report points straight at the place that raised it. A code is `BT-<AREA>-<NN>`: the area is
 * where it happened (ADD adding documents, PHOTO a photo, MAN a manifest or section layout, BUILD Create Bundle, INDEX
 * Preview Index, OPEN reopening a bundle, COVER the coversheet, VIEW the document window, OCR reading text, DL the
 * Download button, SPLIT Split for email, SAVE saving in this browser, RESTORE putting work back, LINK a settings link,
 * PAGE anything no handler caught).
 *
 * The rules, kept by tests/errorCodes.test.mjs:
 *  - a code never changes meaning once it is given out. A code that is no longer raised moves to RETIRED_CODES and is
 *    never used for anything else;
 *  - each code is raised from exactly one place in the source, so the code alone finds the line;
 *  - every notice that says something failed, was refused or was left out passes a code. A notice that only informs
 *    (the large-bundle warning, "Your last session is back") passes `code: null`, so leaving a code out is never an
 *    accident;
 *  - a code is a fixed string written in the source: nothing from a document, a file name or an error message ever
 *    goes into one, and shownCode() below shows nothing for a value that is not a registered code.
 *
 * The table of codes in README.md (Troubleshooting) is checked against this one.
 */

export const ERROR_CODES = Object.freeze({
  'BT-ADD-01': 'An unexpected fault while adding documents chosen with Add Documents or dropped on the page.',
  'BT-ADD-02': 'An unexpected fault while adding documents to the section picked in "Add files to which section?".',
  'BT-ADD-03': 'An unexpected fault while adding documents to a new section made from "Add files to which section?".',
  'BT-ADD-04': 'Every document chosen is already in the bundle, so none was added again.',
  'BT-ADD-05': 'More files were chosen at once than BundleTool adds in one go, so none was added.',
  'BT-ADD-06': 'The documents would take the bundle over the most documents one bundle holds, so none was added.',
  'BT-ADD-07': 'The documents together are over the size limit for one bundle, so none was added.',
  'BT-ADD-08': 'A folder was dropped: a page cannot read a folder, so it was left out.',
  'BT-ADD-09': 'A Word document is damaged inside, so it was not added.',
  'BT-ADD-10': 'A Word document could not be converted to PDF pages, so it was not added.',
  'BT-ADD-11': 'A password-protected PDF was unlocked but could not be fully decrypted, so it was not added.',
  'BT-ADD-12': 'A file is not a readable PDF, so it was not added.',
  'BT-ADD-13': 'A PDF has no pages, so it was not added.',
  'BT-ADD-14': 'A PDF has more pages than one document may have, so it was not added.',
  'BT-ADD-15': 'A PDF has pages far larger than any paper size, so it was not added.',
  'BT-ADD-16': 'A PDF would take the bundle over its page limit, so it was not added.',
  'BT-ADD-17': 'Several files could not be added; the notice lists each with its reason.',
  'BT-ADD-18': 'Some files could not be added, and the bundle is also very large.',
  'BT-ADD-19': 'Some of the documents chosen were already in the bundle and were not added again.',
  'BT-ADD-20': 'A file is empty (0 bytes), so it was refused.',
  'BT-ADD-21': 'A file is over the size limit for one document, so it was refused.',
  'BT-ADD-22': 'The browser could not read a file, so it was refused.',
  'BT-ADD-23': 'A zip or Word file is damaged, so it was refused.',
  'BT-ADD-24': 'A file is not a type BundleTool reads, so it was refused without being opened.',
  'BT-ADD-25': 'A Word document has too many parts to convert safely, so it was refused.',
  'BT-ADD-26': 'A Word document unpacks to more than BundleTool can convert, so it was refused.',
  'BT-ADD-27': 'The text of a Word document is too long to convert, so it was refused.',
  'BT-ADD-28': 'A picture inside a Word document is too large in bytes, so the document was refused.',
  'BT-ADD-29': 'A Word document has too many pages to convert in a browser tab, so it was refused.',
  'BT-ADD-30': 'A picture inside a Word document has too many pixels to draw, so the document was refused.',
  'BT-PHOTO-01': 'This browser cannot open HEIC photos, so the photo was left out.',
  'BT-PHOTO-02': 'A file is not a type of photo BundleTool reads, so it was left out.',
  'BT-PHOTO-03': 'A photo has too many pixels to draw, so it was left out.',
  'BT-PHOTO-04': 'A photo is damaged or cut short, so it was left out.',
  'BT-PHOTO-05': 'A photo could not be converted to a PDF page for another reason.',
  'BT-MAN-01': 'A section layout chosen with "import" is not a valid manifest.',
  'BT-MAN-02': 'A section layout could not be imported, so the bundle was left as it was.',
  'BT-MAN-03': 'A section layout was imported, but some documents it names were not found.',
  'BT-MAN-04': 'The documents a manifest names would take the bundle over its page limit, so nothing was imported.',
  'BT-MAN-05': 'A manifest was imported, but one document it names was not among the dropped files or could not be used.',
  'BT-MAN-06': 'A manifest was imported, but several documents it names were not among the dropped files or could not be used.',
  'BT-MAN-07': 'A dropped manifest could not be imported.',
  'BT-MAN-08': 'A section layout or manifest has more sections than a bundle holds, so none of it was imported.',
  'BT-BUILD-01': 'Create Bundle was pressed with no documents in the Review Table.',
  'BT-BUILD-02': 'The Review Table could not be turned into an index (its structure did not check out).',
  'BT-BUILD-03': 'Creating the bundle took longer than four minutes and was stopped.',
  'BT-BUILD-04': 'The browser ran out of memory while creating the bundle.',
  'BT-BUILD-05': 'A part of BundleTool could not be loaded while creating the bundle (a connection problem).',
  'BT-BUILD-06': 'Creating the bundle failed for another reason.',
  'BT-BUILD-07': 'The preview of a finished bundle or index could not draw a page as a picture (the PDF itself is unchanged).',
  'BT-INDEX-01': 'Preview Index was pressed with no documents in the Review Table.',
  'BT-INDEX-02': 'Building the index preview took too long and was stopped.',
  'BT-INDEX-03': 'A part of BundleTool could not be loaded while building the index preview (a connection problem).',
  'BT-INDEX-04': 'Building the index preview failed for another reason.',
  'BT-OPEN-01': 'A PDF opened for editing holds no BundleTool data, so it is not a BundleTool bundle.',
  'BT-OPEN-02': 'A bundle opened for editing is password-protected.',
  'BT-OPEN-03': 'A bundle opened for editing could not be read as a PDF.',
  'BT-OPEN-04': 'Opening a bundle for editing failed for another reason.',
  'BT-OPEN-05': 'A bundle whose documents were to be added holds no BundleTool data after all, so nothing was added.',
  'BT-OPEN-06': 'A bundle whose documents were to be added could not be read.',
  'BT-OPEN-07': 'Splitting a bundle into its documents failed for another reason.',
  'BT-OPEN-08': 'Documents taken from a reopened bundle carry redaction markers that were never applied.',
  'BT-OPEN-09': 'A bundle opened for editing has more sections than a bundle holds, so it was not opened.',
  'BT-COVER-01': 'A Word document chosen as the coversheet is damaged inside.',
  'BT-COVER-02': 'A Word document chosen as the coversheet could not be converted.',
  'BT-COVER-03': 'A password-protected coversheet was unlocked but could not be used.',
  'BT-COVER-04': 'A PDF chosen as the coversheet cannot be used as one (its first page is unsafe or unusable).',
  'BT-COVER-05': 'A file chosen as the coversheet could not be read as a PDF.',
  'BT-COVER-06': 'The coversheet maker could not build the coversheet PDF.',
  'BT-COVER-07': 'A witness statement cover page could not be drawn.',
  'BT-COVER-08': 'The coversheet maker could not draw its preview (the coversheet itself still works).',
  'BT-VIEW-01': 'The document window could not read the document it was opened for.',
  'BT-VIEW-02': 'A turn waiting in the document window could not be written before Force OCR.',
  'BT-VIEW-03': 'The document window could not remove a page.',
  'BT-VIEW-04': 'Turn document could not write the turn into the document.',
  'BT-VIEW-05': 'Put back as scanned could not undo the straightening of a page.',
  'BT-VIEW-06': 'The document window could not draw the page (turning and reading still work).',
  'BT-OCR-01': 'An image on some pages is too large to read, so those pages have no searchable text.',
  'BT-OCR-02': 'Force OCR could not read the text in a document, which was left as it was.',
  'BT-DL-01': 'The Download button could not gather the documents.',
  'BT-SPLIT-01': 'The part size for Split for email is under 1 MB.',
  'BT-SPLIT-02': 'Split for email could not split the bundle.',
  'BT-SPLIT-03': 'Split for email could not put the parts into one zip.',
  'BT-SAVE-01': 'This browser has no room left to keep a copy of the work.',
  'BT-SAVE-02': 'This browser refused to keep a copy of the work.',
  'BT-SAVE-03': 'Delete all saved copies could not delete what this browser holds.',
  'BT-RESTORE-01': 'The last build never finished, and no saved copy of its documents was found.',
  'BT-RESTORE-02': 'The last build never finished; the documents saved just before it were put back.',
  'BT-LINK-01': 'A settings link or QR code could not be used, so nothing was changed.',
  'BT-PAGE-01': 'Something failed on the page that no other check caught.',
});

/** Codes no longer raised. Each keeps its meaning above and is never given to anything else. */
export const RETIRED_CODES = Object.freeze([]);

const FORMAT = /^BT-[A-Z]{2,8}-\d{2}$/;

/**
 * The code as it is shown, or '' for anything that is not a registered code: a code on the screen or in a bug report
 * is only ever one of the fixed strings above.
 * @param {unknown} code
 * @returns {string}
 */
export function shownCode(code) {
  return typeof code === 'string' && FORMAT.test(code) && Object.hasOwn(ERROR_CODES, code) ? code : '';
}

/** What a code means, or '' for an unknown one. */
export function describeCode(code) {
  return shownCode(code) ? ERROR_CODES[code] : '';
}
