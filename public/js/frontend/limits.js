/**
 * The size at which BundleTool warns that a bundle is large. One place, so the two checks
 * (when documents are added, and when the bundle is built) and every sentence that names the
 * numbers say the same thing: over 1,000 pages or over 75 MB.
 */
export const LARGE_BUNDLE_PAGES = 1000;
export const LARGE_BUNDLE_MB = 75;

/** True when a bundle of this many pages and megabytes is large enough to warn about. */
export function isLargeBundle(pages, megabytes) {
  return pages > LARGE_BUNDLE_PAGES || megabytes > LARGE_BUNDLE_MB;
}

/**
 * The family court's own page limit, separate from LARGE_BUNDLE_PAGES above: this is a court rule,
 * not a performance concern, and a bundle can be over one without being over the other. Practice
 * Direction 27A (Family Proceedings: Court Bundles, in force 2 March 2026), paragraph 11.2(b):
 * "an e-bundle may only be up to 350 pages (A4 size pages) and this default limit may only be
 * exceeded with the court's permission." https://www.justice.gov.uk/courts/procedure-rules/family/practice_directions/pd_part_27a
 */
export const PD27A_PAGE_LIMIT = 350;

/** True once a bundle has gone past the PD27A default limit and would need the court's permission. */
export function isOverPd27aLimit(pages) {
  return pages > PD27A_PAGE_LIMIT;
}

/** The PD27A note's wording, shared by the page and the CLI so the two never drift apart. */
export function pd27aNote(pages) {
  return `This bundle is ${pages.toLocaleString('en-GB')} pages. Family Procedure Rules Practice Direction 27A limits an e-bundle to ${PD27A_PAGE_LIMIT} pages by default; exceeding that needs the court's permission.`;
}

/**
 * Hard limits on what is added, chosen from measurements in a real browser: a tab that reads a file
 * holds several copies of it in memory, so the numbers are what a laptop with a few gigabytes free
 * handles without losing the person's work.
 */
export const MAX_FILE_MB = 200;             // one file
export const MAX_FILES_PER_ADD = 300;       // files chosen or dropped in one go
export const MAX_DOCUMENTS = 1000;          // documents in one bundle
export const MAX_TOTAL_MB = 450;            // every document in the bundle together
export const MAX_PDF_PAGES = 5000;          // pages in one PDF
export const MAX_TOTAL_PAGES = 10000;       // pages in the whole bundle
export const MAX_PAGE_POINTS = 5000;        // longest side of a PDF page, in points (A0 is 3,370; 1 point is 1/72 inch)
/**
 * The whole-add checks, shared by every way of adding files (the file picker, a drop, and a manifest
 * dropped with its PDFs), so no path can slip past a limit another enforces. Returns null when the
 * files fit, or what to tell the person: `{ kind: 'warning' | 'error', code, title, message }` (code: errorCodes.js). Nothing is
 * added when it returns a problem.
 *
 * @param {{ incomingCount: number, incomingBytes: number, existingCount?: number, existingBytes?: number }} add
 */
export function wholeAddProblem({ incomingCount, incomingBytes, existingCount = 0, existingBytes = 0 }) {
  const n = (v) => v.toLocaleString('en-GB');
  if (incomingCount > MAX_FILES_PER_ADD) {
    return {
      kind: 'warning',
      code: 'BT-ADD-05',
      title: 'Too many files at once',
      message: `You chose ${n(incomingCount)} files. BundleTool adds up to ${MAX_FILES_PER_ADD} at a time, so none of them were added. Add them in groups of ${MAX_FILES_PER_ADD} or fewer, or put them into sections of their own.`,
    };
  }
  if (existingCount + incomingCount > MAX_DOCUMENTS) {
    return {
      kind: 'warning',
      code: 'BT-ADD-06',
      title: 'Too many documents',
      message: `A bundle holds up to ${n(MAX_DOCUMENTS)} documents and this one has ${n(existingCount)}. Adding ${n(incomingCount)} more would go over that, so none were added. Split the documents into separate volumes (for example "Bundle A" and "Bundle B") and create separate bundles.`,
    };
  }
  const totalMB = (existingBytes + incomingBytes) / (1024 * 1024);
  if (totalMB > MAX_TOTAL_MB) {
    return {
      kind: 'error',
      code: 'BT-ADD-07',
      title: 'Total file size too large',
      message: `You have chosen ${totalMB.toFixed(1)} MB of documents, which would create a very large bundle. This is too big to be handled reliably, and exceeds the permitted file size. Please split the documents into separate volumes (for example "Bundle A" and "Bundle B") and create separate bundles.`,
    };
  }
  return null;
}

/**
 * Sections in one bundle, and characters in a section's label (the "A" or "B" box). A label is a short mark that
 * leads the section's page numbers ("A12") and its line in the index; the section's name is the place for words, and
 * keeps its own longer limit.
 */
export const MAX_SECTIONS = 100;
export const MAX_SECTION_LABEL_CHARS = 10;

/**
 * The section limit for a section layout, a manifest or a reopened bundle. Returns null when `count` sections fit,
 * or what to tell the person: `{ kind: 'warning', code, title, message }` (code: errorCodes.js). An import over the limit is refused whole, never
 * cut short, so nothing is half-applied and the bundle on the page stays as it was.
 *
 * @param {number} count  sections in what is being imported
 * @param {'layout' | 'bundle'} [source]  a section layout or manifest, or a bundle being reopened
 */
export function sectionLimitProblem(count, source = 'layout') {
  if (count <= MAX_SECTIONS) return null;
  const n = (v) => v.toLocaleString('en-GB');
  const what = source === 'bundle'
    ? `This bundle has ${n(count)} sections. A bundle holds up to ${MAX_SECTIONS}, so it was not opened`
    : `This section layout has ${n(count)} sections. A bundle holds up to ${MAX_SECTIONS}, so none of it was imported`;
  return {
    kind: 'warning',
    code: source === 'bundle' ? 'BT-OPEN-09' : 'BT-MAN-08',
    title: 'Too many sections',
    message: `${what} and the bundle on the page was left as it was. Combine some sections, or split the documents into separate bundles of up to ${MAX_SECTIONS} sections each.`,
  };
}

/** A Word document is converted by drawing it, so its size is limited before that starts. */
export const DOCX_LIMITS = {
  maxEntries: 3000,                         // files inside the .docx package
  maxTotalBytes: 250 * 1024 * 1024,         // everything inside, unpacked
  maxXmlBytes: 6 * 1024 * 1024,             // the text of the document itself, unpacked
  maxEstimatedPages: 250,                   // by the amount of text: drawing 440 pages takes about 20 seconds and 1.2 GB of memory
  maxMediaBytes: 60 * 1024 * 1024,          // any one picture inside
};
/** Most pixels a picture inside a Word document may have. */
export const DOCX_MAX_PICTURE_PIXELS = 50e6;
/** Longest file name kept, in characters, before it is shortened for display and download. */
export const MAX_NAME_CHARS = 120;
