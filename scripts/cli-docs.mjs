/**
 * BundleTool CLI: the tool describing itself (`bundletool --help`, `--help settings`, `--config-keys`, the README
 * tables). One description, built here from the engine's own tables: the setting keys and defaults come from the
 * Config class, the allowed values from its exported valid* lists, the limits from the modules that enforce them.
 * Only the one-line meaning of each setting and error is written by hand, and tests/cliHelp.test.mjs
 * fails if a key, a valid value, a thrown error code or an example is missing or out of date.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What each setting does, one line. Every key of the default config must appear here (a test checks). */
export const SETTING_HELP = {
  'heading.claimNumber': 'The case or claim number, printed at the top right of every index page (and on the cover unless cover.claimNumber says otherwise).',
  'heading.bundleTitle': 'The bundle title, printed as the index heading unless index.headingText is set.',
  'heading.projectName': 'The matter, for example "Re: X (A Child)", printed above the index heading.',
  'heading.author': 'The PDF Author and the cover\'s "Prepared by" line: who is responsible for the content.',
  'heading.fontSize': 'Size of the index heading text.',
  'pageNumbering.footerFont': 'Font of the page numbers in the footer.',
  'pageNumbering.footerFontSize': 'Size of the page numbers.',
  'pageNumbering.alignment': 'Where the page number sits along the footer.',
  'pageNumbering.numberingStyle': 'The wording of the page number: PageX is "Page 3", PageXofY "Page 3 of 40", X "3", XslashY "3/40", XofY "3 of 40", None prints no number.',
  'pageNumbering.footerPrefix': 'Text printed before the page number, for example a reference. Blank prints none.',
  'pageNumbering.pageNumberColour': 'Colour of the page number, #rrggbb (the old names black, red and blue are still read).',
  'pageNumbering.pageNumberPerSection': 'true restarts the page numbers at 1 in each section.',
  'pageNumbering.plateColour': 'Colour of the plate behind the page number, #rrggbb.',
  'pageNumbering.plateOpacity': 'Opacity of that plate, 0 to 100 (0 removes it).',
  'pageNumbering.footerLink': 'Where clicking the footer goes: the index, the first page (top) or nowhere.',
  'pageNumbering.frontMatterNumbering': 'How the cover and index pages are numbered: continuous with the rest, in roman numerals (i, ii) or not at all (skip).',
  'pageNumbering.footerOffset': 'Moves the footer up (positive) or down (negative) by this many points, -30 to 60.',
  'index.fontFace': 'Font of the index table.',
  'index.fontSize': 'Size of the index table text.',
  'index.dateStyle': 'How document dates are written in the index (None leaves them out).',
  'index.dateInputOrder': 'Browser only: how an ambiguous date in a file name (both numbers 12 or under, for example 03-04-2026) is read when documents are added, UK day-first or US month-first. A day over 12 is never ambiguous either way. The CLI takes each document\'s date from the manifest as given; it never parses file names itself.',
  'index.outlineItemStyle': 'What each bookmark in the PDF outline shows: the title alone, with the page, with the date, or both.',
  'index.showTableBorders': 'true draws grid lines in the index table.',
  'index.justTheIndex': 'Not for manifests: the page drives this internally for its own Preview Index button, but the CLI builds through a separate path that never reads it, so setting it here has no effect.',
  'index.sectionPrefix': 'A word before each section letter in the index: Section, Part, or blank for none.',
  'index.indexBookmarkLabel': 'The label of the outline bookmark that jumps to the index. Blank means "Index".',
  'index.headingText': 'The heading on the index page. Blank reuses heading.bundleTitle.',
  'pageOptions.pageSize': 'The size of the pages the tool draws (index, cover). Pages copied from your own documents keep their own size.',
  'pageOptions.printableBundle': 'true adds a page marked "This page is intentionally left blank" after any document with an odd number of pages, so double-sided printing starts each document on a fresh sheet.',
  'pageOptions.coversheet': 'Set by the tool from the cover source. Leave it alone.',
  'pageOptions.generateCover': 'true draws a cover page from the cover.* settings and puts it in front of the index. A "coversheet" file in the manifest wins over it.',
  'pageOptions.coverSource': 'Set by the tool: uploaded, generated or none. Leave it alone.',
  'pageOptions.watermark': 'true draws a diagonal watermark across every page.',
  'pageOptions.watermarkText': 'The watermark wording. Blank draws CONFIDENTIAL.',
  'pageOptions.watermarkColour': 'Watermark colour, #rrggbb.',
  'pageOptions.watermarkOpacity': 'Watermark opacity, 0 to 100.',
  'pageOptions.smallerPhotos': 'true (the default) puts each JPEG or PNG the tool turned into a page into the bundle at most 2000 pixels on its long edge, as a JPEG at quality 85, after OCR has read the full picture; the page looks the same and the file is much smaller. A PDF is never changed. false keeps the pictures as they are. Needs @napi-rs/canvas; without it the pictures stay as they are (photo_not_smaller).',
  'cover.courtName': 'The court line at the top of a generated cover.',
  'cover.matterOf': 'The subheading lines under the court, one per newline (for example the statute).',
  'cover.applicantName': 'The applicants, one per line, up to 4.',
  'cover.respondentName': 'The respondents, one per line, up to 4.',
  'cover.partyLabel1': 'The label for the first side. Blank means Applicant.',
  'cover.partyLabel2': 'The label for the second side. Blank means Respondent.',
  'cover.extraText': 'Extra lines under the cover title, one per newline.',
  'cover.claimNumber': 'The cover\'s own case number. null follows heading.claimNumber; a string, even an empty one, is what the cover shows.',
  'cover.bundleTitle': 'The cover\'s own title. null follows heading.bundleTitle.',
  'cover.author': 'The cover\'s own "Prepared by". null follows heading.author.',
  'cover.layout': 'The cover design: classic (parties stacked, title between rules) or grid (applicants left, respondents right).',
  'cover.caseNumberLine': 'court puts the case number on the court\'s line; own gives it a line of its own under the court.',
  'cover.partyLabelPlacement': 'below puts each party label under the name; inline puts it on the name\'s line.',
  'cover.partyAlign': 'Where the party names sit in the classic design.',
  'cover.caseNumberAlign': 'Where the case number sits when it has its own line.',
  'cover.headingAlign': 'Where the court and subheading lines sit.',
  'cover.titleLines': 'How many rules sit above and below the bundle title on the cover: single, or double (two thin rules a small distance apart). Either way the text is equidistant from the nearest rule.',
  'cover.caseNumberLabel': 'The prefix printed before the case number, "CASE NO:" by default. Set to "CLAIM NO:", "ORDER NO:", any other wording, or "" for no prefix at all.',
  'cover.preparedByLabel': 'The label printed before who prepared the bundle, "Prepared by:" by default. Set to "Compiled by:", "On behalf of:", any other wording, or "" for no label at all. Kept to 40 characters: unlike the case number label, this line never wraps.',
  'cover.partyJoiner': 'The word joining the two parties on the classic design, "-and-" by default. Set to "-v-", any other wording, or "" for no joining word at all, just the gap. Kept to 40 characters.',
  'ocr.autoDetect': 'Not for manifests: this is the browser\'s own auto-OCR toggle. The command line\'s equivalent is ocr.mode.',
  'ocr.turnUpright': 'true turns a scanned page OCR reads on its side or upside down to show upright, by setting its /Rotate (lossless; the text layer turns with it). Only pages OCR reads that have no text of their own, and only when the engine and the page\'s lines agree which way up it is. Off by default.',
  'ocr.straighten': 'true turns a scanned page OCR finds tilted (up to 10 degrees) level, by wrapping its content in a rotation about the page\'s centre: the scan is not redrawn, the page keeps its size and its outer corners are trimmed. The text layer is drawn level over it. A page with links, form fields or comments is left as scanned (ocr_not_straightened). Only pages OCR reads that have no text of their own. Off by default.',
  'ocr.mode': 'auto (the default) OCRs a page only if its own text layer is too short to search, the same check and threshold the browser uses; off skips the check for every file (a file\'s own "forceOcr" still overrides off for that one file). Needs @napi-rs/canvas and tesseract-wasm on this machine; if either is not available, the bundle still builds, just without a text layer for the pages that needed OCR (ocr_unavailable).',
};

/** Allowed values by setting key, taken from the engine's own valid* lists (names in bundletoolConfig.js). */
const ALLOWED = (c) => ({
  'heading.fontSize': c.validFontSize, 'pageNumbering.footerFont': c.validFonts, 'pageNumbering.footerFontSize': c.validFontSize,
  'pageNumbering.alignment': c.validAlignments.filter((v) => v !== 'center'), 'pageNumbering.numberingStyle': c.validNumberingStyles,
  'pageNumbering.footerLink': c.validFooterLinks, 'pageNumbering.frontMatterNumbering': c.validFrontMatterNumbering,
  'index.fontFace': c.validFonts, 'index.fontSize': c.validFontSize, 'index.dateStyle': c.validDateStyles,
  'index.dateInputOrder': c.validDateInputOrder,
  'index.outlineItemStyle': c.validOutlineStyles, 'index.sectionPrefix': c.validSectionPrefixes,
  'pageOptions.pageSize': c.validPageSizes, 'pageOptions.coverSource': c.validCoverSources,
  'cover.layout': c.validCoverLayouts, 'cover.caseNumberLine': c.validCoverCaseLines,
  'cover.partyLabelPlacement': c.validCoverLabelPlacements, 'cover.partyAlign': c.validCoverPartyAligns,
  'cover.caseNumberAlign': c.validCoverPartyAligns, 'cover.headingAlign': c.validCoverPartyAligns,
  'ocr.mode': c.validOcrMode,
});
const RANGES = {
  'pageNumbering.plateOpacity': '0 to 100', 'pageNumbering.footerOffset': '-30 to 60', 'pageOptions.watermarkOpacity': '0 to 100',
  'pageNumbering.pageNumberColour': '#rrggbb', 'pageNumbering.plateColour': '#rrggbb', 'pageOptions.watermarkColour': '#rrggbb',
};

/** Every error code the CLI can answer with, and what it means. A test checks this against the codes the source throws. */
export const ERRORS = [
  { code: 'manifest_not_found', exit: 3, meaning: 'The manifest file could not be read.' },
  { code: 'manifest_too_large', exit: 3, meaning: 'The manifest is over 5 MB.' },
  { code: 'invalid_json', exit: 3, meaning: 'The manifest is not valid JSON.' },
  { code: 'invalid_manifest', exit: 3, meaning: 'The manifest is not shaped like a manifest (no sections, a wrong type, a bad sectionID, too many sections or files).' },
  { code: 'unknown_key', exit: 3, meaning: 'The manifest has a key at the top level, in a section or in a file entry that this version does not know.' },
  { code: 'unsupported_schema_version', exit: 3, meaning: 'schemaVersion is present and is not 1.' },
  { code: 'invalid_config', exit: 3, meaning: 'A setting has a value the engine refuses (a value not in its allowed list, an opacity out of range).' },
  { code: 'docs_dir_not_found', exit: 3, meaning: 'The documents directory does not exist.' },
  { code: 'output_dir_missing', exit: 3, meaning: 'The folder the output file would go in does not exist.' },
  { code: 'output_overwrites_input', exit: 3, meaning: 'The output path is one of the source documents.' },
  { code: 'output_exists', exit: 3, meaning: 'The output file already exists; pass --force to overwrite it.' },
  { code: 'invalid_filename', exit: 3, meaning: 'A filename is not a plain file name: it has a folder in front of it, or an odd character.' },
  { code: 'file_not_found', exit: 3, meaning: 'A file the manifest names is not in the documents directory.' },
  { code: 'file_unreadable', exit: 3, meaning: 'A file exists but could not be read.' },
  { code: 'path_outside_docs', exit: 3, meaning: 'A file resolves, through a symbolic link, to somewhere outside the documents directory.' },
  { code: 'invalid_pdf', exit: 3, meaning: 'A file is not a readable PDF (damaged, truncated or not a PDF at all).' },
  { code: 'encrypted_pdf', exit: 3, meaning: 'A PDF is password protected.' },
  { code: 'unsupported_input_type', exit: 3, meaning: 'A file is a type the CLI does not convert (Word, TIFF, WEBP, HEIC, GIF, BMP and others). Convert it to PDF first.' },
  { code: 'invalid_image', exit: 3, meaning: 'A JPEG or PNG is damaged or cannot be read.' },
  { code: 'image_too_large', exit: 3, meaning: 'A picture has more pixels than the limit (100 million for a JPEG, 40 million for a PNG).' },
  { code: 'file_too_large', exit: 3, meaning: 'A file is over 200 MB.' },
  { code: 'bundle_too_large', exit: 3, meaning: 'The documents together are over 450 MB.' },
  { code: 'invalid_rotation', exit: 3, meaning: 'A file\'s rotate is not 90, 180 or 270.' },
  { code: 'invalid_cover', exit: 3, meaning: 'The supplied coversheet is not a usable PDF (no pages, encrypted, oversize).' },
  { code: 'build_failed', exit: 1, meaning: 'The bundle could not be built, though the input was accepted.' },
  { code: 'output_write_failed', exit: 1, meaning: 'The finished bundle could not be written.' },
];
export const WARNINGS = [
  { code: 'unknown_config_key', meaning: 'A config key this version does not know was ignored; the message names the nearest known keys.' },
  { code: 'engine_warning', meaning: 'The PDF engine warned about something (for example a document it repaired).' },
  { code: 'over_pd27a_page_limit', meaning: 'The bundle is over 350 pages. Family Procedure Rules Practice Direction 27A limits an e-bundle to that by default; the build still finishes.' },
  { code: 'ocr_failed', meaning: 'OCR raised a real error, on a specific page (names the file and page) or while setting up for the whole document (names the file, no page); the affected page or document has no searchable text layer, the build still finishes.' },
  { code: 'ocr_not_straightened', meaning: 'ocr.straighten is on and a tilted scanned page has links, form fields or comments, which do not move with the page\'s content, so it was left tilted as scanned (names the file and page); its text layer is still added.' },
  { code: 'ocr_unavailable', meaning: 'OCR was needed (or forced) but the engine cannot load on this machine (@napi-rs/canvas or tesseract-wasm missing, or no prebuilt binary for this platform); the build still finishes, without a text layer for the pages that needed it.' },
  { code: 'photo_not_smaller', meaning: 'pageOptions.smallerPhotos is on but @napi-rs/canvas cannot load on this machine, so a JPEG or PNG went into the bundle at its own size (names the file); the build still finishes.' },
];

/** Runnable examples: `files` are written into a scratch folder by the tests, which then run `args` there. */
export const EXAMPLES = [
  {
    title: 'Build a bundle with a generated cover',
    args: ['--json', 'manifest.json', 'docs', 'bundle.pdf'],
    files: {
      'manifest.json': {
        schemaVersion: 1,
        config: {
          'heading.bundleTitle': 'Hearing bundle', 'heading.projectName': 'Re: T (A Child)', 'heading.claimNumber': 'XY26C00123',
          'pageOptions.generateCover': true, 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES',
        },
        sections: [
          { sectionLabel: 'A', sectionName: 'Applications', files: [{ filename: 'application.pdf', title: 'Application', date: '2026-09-01' }, { filename: 'statement.pdf', title: 'Statement', rotate: 90 }] },
          { sectionLabel: 'B', sectionName: 'Orders', files: [{ filename: 'order.pdf', title: 'Order' }] },
        ],
      },
      'docs/application.pdf': '@pdf:2', 'docs/statement.pdf': '@pdf:3', 'docs/order.pdf': '@pdf:1',
    },
    note: 'The manifest is data only. Put the source files in docs/. The result says how many pages the cover, index and documents came to.',
  },
  { title: 'List every setting the manifest\'s "config" may carry, with its default', args: ['--config-keys'], files: {} },
  { title: 'Print the manifest\'s JSON Schema', args: ['--schema'], files: {} },
];

const TOPIC_ORDER = ['manifest', 'settings', 'inputs'];
const readJson = (relative) => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

/** Builds the doc. Loads the engine's config module (after the Node shim is registered by the caller). */
export async function buildDoc({ version, limits }) {
  const cfg = await import('../public/js/bundletoolConfig.js');
  const schemaMod = await import('../public/js/manifestSchema.js');
  const defaults = schemaMod.flattenManifestConfig(new cfg.default().options);
  const allowed = ALLOWED(cfg);
  const settingRows = Object.entries(defaults).map(([key, value]) => {
    const kind = typeof value === 'boolean' ? 'true or false' : typeof value === 'number' ? `number${RANGES[key] ? ' ' + RANGES[key] : ''}` : value === null ? 'text or null' : (RANGES[key] === '#rrggbb' ? 'colour #rrggbb' : 'text');
    const list = allowed[key] ? `one of ${allowed[key].map((v) => (v === '' ? '""' : v)).join(', ')}` : kind;
    return { name: key, type: list, default: JSON.stringify(value), meaning: SETTING_HELP[key] ?? '' };
  });
  return {
    tool: 'bundletool', version,
    summary: ['build a court bundle (cover, index, page numbers, bookmarks, links) from a manifest and a folder of PDFs',
      'The same engine as the BundleTool page, with no browser: a JSON manifest in, one PDF out.'],
    usage: ['bundletool [--json] <manifest.json> <docs-dir> <output.pdf>', 'bundletool --config-keys | --schema | --version', 'bundletool --help [topic]'],
    options: [
      ['--json', 'Write exactly one JSON object to stdout, on success and on failure, and nothing else.'],
      ['--force', 'Overwrite the output file if it already exists (refused otherwise, with output_exists). Also -f.'],
      ['--config-keys', 'List every setting the manifest\'s "config" may carry, with its default.'],
      ['--schema', 'Print the manifest\'s JSON Schema.'],
      ['--help [topic]', `A short overview, or the detail of a topic: ${[...TOPIC_ORDER, 'errors', 'examples', 'schema'].join(', ')}.`],
      ['--version', 'Print the version.'],
    ],
    inputs: [
      `Source files (a plain name inside <docs-dir>): PDF, or JPEG or PNG photos (read from their bytes, not their extension), each JPEG or PNG becoming one page. Word, TIFF, WEBP, HEIC, GIF and BMP are refused (unsupported_input_type): convert them to PDF first.`,
      `Limits: ${limits.MAX_FILE_MB} MB a file, ${limits.MAX_TOTAL_MB} MB in total, ${limits.MAX_SECTIONS} sections, 2000 files, a 5 MB manifest.`,
      'A file may be given "rotate": 90, 180 or 270 to turn it clockwise. A top-level "coversheet" names your own cover PDF.',
      'OCR: ocr.mode "auto" (the default) OCRs a page only if its own text layer is too short to search; "off" skips the check for every file. A file\'s own "forceOcr": true OCRs it regardless, overriding "off" for that one file. Needs @napi-rs/canvas and tesseract-wasm on this machine, both optional: if either is not available the bundle still builds, just without a text layer for the pages that needed it (ocr_unavailable).',
      'OCR can also turn a sideways scanned page upright (ocr.turnUpright) and straighten a tilted one (ocr.straighten). Both are off by default and change only scanned pages OCR reads, never a page with text of its own.',
      'Smaller photos (pageOptions.smallerPhotos, on by default): a JPEG or PNG goes into the bundle at most 2000 pixels on its long edge, after OCR has read the full picture. A PDF is never changed. Needs @napi-rs/canvas (photo_not_smaller without it).',
    ],
    errors: ERRORS, warnings: WARNINGS,
    topics: {
      manifest: {
        title: 'The manifest (JSON; the full format is in --schema)',
        lines: [
          `The top level has: schemaVersion (optional, 1), config (settings: ONE flat object of "group.field" keys such as "heading.bundleTitle": "Title", never nested objects), coversheet (optional, a PDF file name in <docs-dir>) and sections (required, 1 to ${limits.MAX_SECTIONS}).`,
          'Each section has sectionID (optional, four digits, numbered by position when left out), sectionLabel (for example "A"), sectionName and files.',
          'Each file has filename (required, a plain name in <docs-dir>), title (optional: a blank or missing title is filled in from the filename, exactly as the page does when a title field is left empty), date (any text, shown in the index), rotate (90, 180 or 270) and forceOcr (true or false).',
          'The cover comes from the first of: a "coversheet" file; pageOptions.generateCover true (drawn from the cover.* settings); none.',
          'Keys the schema does not list are refused (unknown_key), except inside "config", where an unknown key is ignored with an unknown_config_key warning.',
        ],
      },
      settings: { title: 'Settings (the manifest\'s "config"): key, allowed values, default, meaning', rows: settingRows.map((r) => ({ name: r.name, text: `${r.type}; default ${r.default}. ${r.meaning}` })) },
      inputs: { title: 'Inputs the CLI accepts', lines: ['PDF files; JPEG and PNG photos (one page each, fitted to the bundle\'s page size with the browser\'s margins, EXIF orientation applied, and at most 2000 pixels on the long edge in the bundle unless pageOptions.smallerPhotos is false).', `Refused with unsupported_input_type: Word documents, TIFF, WEBP, AVIF, HEIC, GIF, BMP, zip and old Office files. Convert them to PDF before calling the tool.`, `Limits: ${limits.MAX_FILE_MB} MB a file (file_too_large), ${limits.MAX_TOTAL_MB} MB in total (bundle_too_large), 100 million pixels for a JPEG and 40 million for a PNG (image_too_large).`] },
    },
    examples: EXAMPLES,
    schema: readJson('../manifest.schema.json'),
    settingRows,
  };
}
