/**
 * Shared mutable state for the BundleTool frontend.
 * All frontend submodules import this object and mutate it directly.
 */
export const state = {
  // lazy-loaded heavy modules (set during DOMContentLoaded)
  processTheBundle:      null,
  countPdfPages:         null,
  validateAndCountPages: null,
  validateCoverPage:     null,
  chrono:                null,

  // file data
  filesMap:          new Map(),   // filename → File
  // filename → { title, date, pageCount }. No prototype: a file called __proto__ or constructor (a
  // manifest or a reopened bundle can name one) is then an ordinary key, never a method or the prototype.
  frontendInputData: Object.create(null),
  coversheetFile:    null,
  coversheetConverted: false,   // the cover was made from a Word document

  // Text being read (OCR), one entry per document that has pages to read and has not finished:
  // filename → { status: 'waiting' | 'reading', source: 'auto' | 'force', pagesToRead, pagesDone,
  // controller, pageStartedAt }. Kept by frontend/ocrReading.js; the automatic check (ocrAuto.js)
  // and Force OCR (ocrForce.js) both report into it, and the row badge, the totals line and the
  // question Create Bundle asks all read it.
  ocrReading:        new Map(),
  // Documents that finished (read, skipped or stopped) since reading last started from nothing:
  // the "2" of "Reading text: 2 of 5 documents" counts these with the one being read. Back to 0
  // whenever nothing is left to read.
  ocrReadingFinished: 0,

  // section state
  isSectioned:    false,
  nextSectionNum: 1,

  // drag state
  draggedRow:     null,
  draggedSection: null,

  // config (assigned after DOMContentLoaded)
  config: null,

  // bundle generation flow state. The warning modals are awaited in sequence
  // inside one submission (frontend/modals.js askGate), so no confirm-gate
  // flags are kept here.
  _cancelReject:         null,
  // Set as early as possible once a real Create Bundle or preview submission is under way, and never
  // reset: nothing needs it to be. frontend.js's idle warm-up checks this so it never fires its own
  // fetches to compete with a build that is already fetching the same files for real.
  buildStarted:          false,

  // processing overlay UI state
  _trackInitialized:    false,
  _overlayOriginalHTML: null,
};
