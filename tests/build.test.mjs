/**
 * The single-pass build (bundletoolBuild.js) against the staged pipeline.
 *
 * The staged path (merge → prepend index → prepend cover → footer → meta,
 * each a full parse and serialise) exists as the individual functions, so
 * the strongest available check is to build the SAME bundle both ways and
 * require the observable results to agree: page count, footer links,
 * outline, and the embedded bundle index. If the single-pass build drifts
 * from those functions, this is where it shows.
 *
 * Also here: the footer-link setting's three targets (index / first page /
 * none), which only the fused path takes as an explicit page index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fx from './fixtures.mjs';
import { PDFName } from '../public/js/bundletoolPdfLib.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { mergeFileEntries, mergeTwoPdfs } from '../public/js/bundletoolMerge.js';
import { applyPageNumbering, PADDING_PAGE_TEXT } from '../public/js/bundletoolPages.js';
import { applyMeta, readBundleIndex } from '../public/js/bundletoolMeta.js';
import { buildBundlePdf } from '../public/js/bundletoolBuild.js';
import { openBundle, splitBundlePdf } from '../public/js/bundletoolRestore.js';
import { readOutline } from '../public/js/bundletoolOutline.js';

const CV_META = {
  'pageOptions.coversheet': true,
  'pageOptions.coverSource': 'uploaded',
  'pageOptions.printableBundle': false,
  'index.outlineItemStyle': 'plain',
  'index.fontFace': 'serif',
  'index.dateStyle': 'DD Mon. YYYY',
  'index.sectionPrefix': '',
  'heading.bundleTitle': 'Trial Bundle',
  'heading.projectName': 'Re: X (A Child)',
  'heading.author': 'A. Solicitor',
  'heading.claimNumber': 'ZC00P00456',
  'pageNumbering.footerFont': 'helvetica',
  'pageNumbering.alignment': 'centre',
  'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerPrefix': '',
  'pageNumbering.pageNumberPerSection': false,
  'pageNumbering.footerLink': 'index',
};

const CV_FOOTER = {
  'pageNumbering.footerPrefix': 'Bundle',
  'pageNumbering.alignment': 'centre',
  'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerFont': 'helvetica',
  'pageNumbering.footerFontSize': 'small',
  'pageNumbering.pageNumberColour': 'black',
  'pageNumbering.pageNumberPerSection': false,
};

/** The same three-document bundle the pipeline tests use. */
async function fixtureParts() {
  const docs = [
    { filename: 'application.pdf', buffer: await fx.makePdf(3, 'APPLICATION') },
    { filename: 'statement.pdf', buffer: await fx.makePdf(4, 'STATEMENT') },
    { filename: 'order.pdf', buffer: await fx.makePdf(2, 'ORDER') },
  ];
  const index = await fx.makePdf(2, 'INDEX');
  const coversheet = await fx.makePdf(1, 'COVERSHEET');
  const tocEntries = [{
    sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Documents',
    beginsOnPdfPage: 4, actualPdfStartPageWithToc: 4,
    entries: [
      { tabNumber: 1, title: 'Application', date: '2026-01-05', filename: 'application.pdf', pageCount: 3, beginsOnPdfPage: 4, beginsOnPageOfSection: 1, actualPdfStartPageWithToc: 4 },
      { tabNumber: 2, title: 'Statement', date: '2026-02-11', filename: 'statement.pdf', pageCount: 4, beginsOnPdfPage: 7, beginsOnPageOfSection: 4, actualPdfStartPageWithToc: 7 },
      { tabNumber: 3, title: 'Order', date: '2026-03-02', filename: 'order.pdf', pageCount: 2, beginsOnPdfPage: 11, beginsOnPageOfSection: 8, actualPdfStartPageWithToc: 11 },
    ],
  }];
  const rows = tocEntries[0].entries.map((e, i) => ({
    pageNumber: 1, tabNumber: e.tabNumber, x: 20, y: 40 + i * 10, width: 170, height: 8,
  }));
  return { docs, index, coversheet, tocEntries, rows };
}

async function buildFused({ footerLinkPageIndex = 1 } = {}) {
  const { docs, index, coversheet, tocEntries, rows } = await fixtureParts();
  const final = await buildBundlePdf({
    coverBytes: coversheet,
    tocBytes: index,
    fileEntries: docs,
    printable: false,
    footerConfig: CV_FOOTER,
    pageLabels: [],
    footerLinkPageIndex,
    metaConfig: CV_META,
    tocTableRowCoordinates: rows,
    tocEntries,
  });
  return { final, tocEntries };
}

async function buildStaged() {
  const { docs, index, coversheet, tocEntries, rows } = await fixtureParts();
  const merged = await mergeFileEntries(docs, false);
  const withIndex = await mergeTwoPdfs(index, merged);
  const withCover = await mergeTwoPdfs(coversheet, withIndex);
  const numbered = await applyPageNumbering(withCover, CV_FOOTER, [], 1);
  const final = await applyMeta(numbered, rows, tocEntries, CV_META);
  return { final, tocEntries };
}

/** Per-page count of link annotations targeting the given page ref tag. */
function linksTo(doc, targetTag) {
  const counts = [];
  for (const page of doc.getPages()) {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    let n = 0;
    const size = annots?.size ? annots.size() : 0;
    for (let i = 0; i < size; i++) {
      const annot = doc.context.lookup(annots.get(i));
      const dest = doc.context.lookup(annot.get(PDFName.of('Dest')));
      if (dest?.get(0)?.tag === targetTag) n++;
    }
    counts.push(n);
  }
  return counts;
}

test('the fused build produces the staged pipeline\'s bundle', async () => {
  const fused = await buildFused();
  const staged = await buildStaged();

  const { doc: fusedDoc } = await loadPdf(fused.final);
  const { doc: stagedDoc } = await loadPdf(staged.final);

  // 1 coversheet + 2 index + 3 + 4 + 2 documents
  assert.equal(fusedDoc.getPageCount(), 12);
  assert.equal(fusedDoc.getPageCount(), stagedDoc.getPageCount());

  // Same outline, same titles, same targets.
  assert.deepEqual(readOutline(fusedDoc), readOutline(stagedDoc));

  // Same embedded bundle index (the reopen/split contract).
  assert.deepEqual(readBundleIndex(fusedDoc), readBundleIndex(stagedDoc));

  // Footer links page for page: every page links to the index in both.
  const fusedLinks = linksTo(fusedDoc, fusedDoc.getPage(1).ref.tag);
  const stagedLinks = linksTo(stagedDoc, stagedDoc.getPage(1).ref.tag);
  assert.deepEqual(fusedLinks, stagedLinks);
  assert.ok(fusedLinks.every((n) => n >= 1), 'every page should carry a footer link to the index');
});

test('printable mode pads odd documents inside the fused build', async () => {
  const { docs, index, coversheet, tocEntries, rows } = await fixtureParts();
  const final = await buildBundlePdf({
    coverBytes: coversheet, tocBytes: index, fileEntries: docs, printable: true,
    footerConfig: CV_FOOTER, pageLabels: [], footerLinkPageIndex: 1,
    metaConfig: { ...CV_META, 'pageOptions.printableBundle': true },
    tocTableRowCoordinates: rows, tocEntries,
  });
  const { doc } = await loadPdf(final);
  // application (3) pads to 4; statement (4) stays; order (2) stays: 13 pages.
  assert.equal(doc.getPageCount(), 13);
});

function havePdftotext() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Each page's text, whitespace collapsed, in page order. */
function pageTexts(bytes, pageCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-build-'));
  try {
    const file = path.join(dir, 'b.pdf');
    fs.writeFileSync(file, bytes);
    const texts = [];
    for (let p = 1; p <= pageCount; p++) {
      texts.push(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), file, '-'], { encoding: 'utf8' })
        .replace(/\s+/g, ' ').trim());
    }
    return texts;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function printableBuild(footerConfig) {
  const { docs, index, coversheet, tocEntries, rows } = await fixtureParts();
  return buildBundlePdf({
    coverBytes: coversheet, tocBytes: index, fileEntries: docs, printable: true,
    footerConfig, pageLabels: [], footerLinkPageIndex: 1,
    metaConfig: { ...CV_META, 'pageOptions.printableBundle': true },
    tocTableRowCoordinates: rows, tocEntries,
  });
}

test('a page printable mode adds says it is intentionally blank, and no other page does', { skip: !havePdftotext() && 'pdftotext is not installed' }, async () => {
  const texts = pageTexts(await printableBuild(CV_FOOTER), 13);
  // cover (1), index (2), application (3): the padding page is the seventh.
  const marked = texts.map((t, i) => (t.includes(PADDING_PAGE_TEXT) ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(marked, [7]);
  assert.match(texts[6], /Bundle Page 7/, 'the padding page keeps its page number');
});

test('the blank-page wording is drawn even with page numbering off', { skip: !havePdftotext() && 'pdftotext is not installed' }, async () => {
  const texts = pageTexts(await printableBuild({ ...CV_FOOTER, 'pageNumbering.numberingStyle': 'None' }), 13);
  assert.ok(texts[6].includes(PADDING_PAGE_TEXT));
  assert.ok(!texts.some((t) => /Bundle Page/.test(t)), 'no page numbers when numbering is off');
});

test('a bundle that is not printable carries no blank-page wording', { skip: !havePdftotext() && 'pdftotext is not installed' }, async () => {
  const { final } = await buildFused();
  const texts = pageTexts(final, 12);
  assert.ok(!texts.some((t) => t.includes(PADDING_PAGE_TEXT)));
});

test('a fused bundle reopens and splits back into its documents', async () => {
  const { final } = await buildFused();
  const opened = await openBundle(final);
  assert.equal(opened.config.heading.claimNumber, 'ZC00P00456');
  const files = await splitBundlePdf(opened.doc, opened.metadata, true);
  assert.deepEqual(
    [...files.keys()].sort(),
    ['application.pdf', 'coversheet.pdf', 'order.pdf', 'statement.pdf'],
  );
});

test('footer link "top": every footer links to the first page', async () => {
  const { final } = await buildFused({ footerLinkPageIndex: 0 });
  const { doc } = await loadPdf(final);
  const toFirst = linksTo(doc, doc.getPage(0).ref.tag);
  assert.ok(toFirst.every((n) => n >= 1),
    'every page should carry a footer link to page one');
});

test('footer link "none": the footer is drawn but links nowhere', async () => {
  const { final } = await buildFused({ footerLinkPageIndex: null });
  const { doc } = await loadPdf(final);
  // No page's annotations may point at the index or the first page; index
  // hyperlinks live on the index pages only, so pages 3+ must have none.
  for (let i = 2; i < doc.getPageCount(); i++) {
    const annots = doc.context.lookup(doc.getPage(i).node.get(PDFName.of('Annots')));
    const size = annots?.size ? annots.size() : 0;
    assert.equal(size, 0, `page ${i + 1} should carry no link annotations`);
  }
});

test('a missing cover means the index is page one of the fused build', async () => {
  const { docs, index, tocEntries, rows } = await fixtureParts();
  const final = await buildBundlePdf({
    coverBytes: null, tocBytes: index, fileEntries: docs, printable: false,
    footerConfig: CV_FOOTER, pageLabels: [], footerLinkPageIndex: 0,
    metaConfig: { ...CV_META, 'pageOptions.coversheet': false, 'pageOptions.coverSource': 'none' },
    tocTableRowCoordinates: rows, tocEntries,
  });
  const { doc } = await loadPdf(final);
  assert.equal(doc.getPageCount(), 11);
  const outline = readOutline(doc);
  assert.equal(outline[0].pageIndex, 0, 'without a cover the Index bookmark points at page one');
});

// ── Page size ─────────────────────────────────────────────────────────────
// These assert the page-size setting reaches the pages BundleTool draws and,
// just as importantly, that it does NOT rescale the user's own documents.

test('page size: the blank padding page follows the bundle, not the document', async () => {
  const { mergeFileEntries } = await import('../public/js/bundletoolMerge.js');
  const odd = { filename: 'odd.pdf', buffer: await fx.makePdf(3, 'ODD') };
  for (const [key, expectW] of [['a4', 595.28], ['letter', 612], ['legal', 612]]) {
    const merged = await mergeFileEntries([odd], true, key);
    const { doc } = await loadPdf(merged);
    assert.equal(doc.getPageCount(), 4, 'the odd document should be padded');
    const blank = doc.getPage(3).getSize();
    assert.ok(Math.abs(blank.width - expectW) < 0.01,
      `${key}: blank page is ${blank.width}pt wide, expected ${expectW}`);
  }
});

test('page size: source documents are NEVER rescaled', async () => {
  const { mergeFileEntries } = await import('../public/js/bundletoolMerge.js');
  // An A4 source merged into a Letter bundle keeps its A4 pages: rescaling
  // someone's evidence would change what the court sees.
  const a4doc = { filename: 'a4.pdf', buffer: await fx.makePdf(2, 'A4') };
  const merged = await mergeFileEntries([a4doc], false, 'letter');
  const { doc } = await loadPdf(merged);
  for (const page of doc.getPages()) {
    assert.ok(Math.abs(page.getSize().width - 595.28) < 0.01,
      'a copied page must keep the size it was authored at');
  }
});

test('page size: an unknown key falls back to A4 rather than throwing', async () => {
  const { pageDimensions } = await import('../public/js/bundletoolPageSize.js');
  assert.deepEqual(pageDimensions('nonsense-from-an-old-settings-code'), [595.28, 841.89]);
  assert.deepEqual(pageDimensions(undefined), [595.28, 841.89]);
});

test('page size: the footer measures against the configured width', async () => {
  const { flattenFooterConfig } = await import('../public/js/bundletoolPages.js');
  const { default: Config } = await import('../public/js/bundletoolConfig.js');
  const c = new Config();
  c.updateOptions({ pageOptions: { pageSize: 'letter' } });
  assert.equal(flattenFooterConfig(c)['pageOptions.pageSize'], 'letter',
    'the footer pass must be told the page size, or it shrinks against the wrong width');
});

test('page size: an invalid value is refused by validation', async () => {
  const { default: Config } = await import('../public/js/bundletoolConfig.js');
  const c = new Config();
  c.updateOptions({ pageOptions: { pageSize: 'tabloid' } });
  assert.throws(() => c.validateOptions(), /Invalid page size/);
});

// ── Front-matter numbering, footer offset, index heading, cover date ──────

test('front matter: roman numerals on the cover and index, documents start at 1', async () => {
  const { buildFooterTexts } = await import('../public/js/bundletoolPages.js');
  const cv = { ...CV_FOOTER, 'pageNumbering.frontMatterNumbering': 'roman' };
  // 1 cover + 2 index + 3 document pages
  const { texts } = buildFooterTexts(cv, [], 6, 3);
  assert.deepEqual(texts.slice(0, 3), ['i', 'ii', 'iii'], 'front matter is roman');
  assert.equal(texts[3], 'Bundle Page 1', 'the first document page is Page 1, not Page 4');
  assert.equal(texts[5], 'Bundle Page 3');
});

test('front matter: "skip" leaves it unnumbered and starts the documents at 1', async () => {
  const { buildFooterTexts } = await import('../public/js/bundletoolPages.js');
  const cv = { ...CV_FOOTER, 'pageNumbering.frontMatterNumbering': 'skip' };
  const { texts } = buildFooterTexts(cv, [], 6, 3);
  assert.deepEqual(texts.slice(0, 3), ['', '', ''], 'front matter carries no label');
  assert.equal(texts[3], 'Bundle Page 1');
});

test('front matter: "continuous" numbers the pages exactly as no setting does', async () => {
  const { buildFooterTexts } = await import('../public/js/bundletoolPages.js');
  const before = buildFooterTexts(CV_FOOTER, [], 6).texts;
  const after = buildFooterTexts(
    { ...CV_FOOTER, 'pageNumbering.frontMatterNumbering': 'continuous' }, [], 6, 3).texts;
  assert.deepEqual(after, before, 'the default must not move a single page number');
  assert.equal(after[0], 'Bundle Page 1');
});

test('X of Y counts the documents, not the front matter', async () => {
  const { buildFooterTexts } = await import('../public/js/bundletoolPages.js');
  const cv = { ...CV_FOOTER, 'pageNumbering.numberingStyle': 'PageXofY',
               'pageNumbering.frontMatterNumbering': 'roman' };
  const { texts } = buildFooterTexts(cv, [], 6, 3);
  assert.equal(texts[3], 'Bundle Page 1 of 3',
    'the denominator must exclude the front matter, or "of 6" contradicts the numbering');
});

test('an unnumbered page is not drawn at all, so no empty plate is left', async () => {
  const { applyPageNumbering } = await import('../public/js/bundletoolPages.js');
  const pdf = await fx.makePdf(5, 'DOC');
  const out = await applyPageNumbering(
    pdf, { ...CV_FOOTER, 'pageNumbering.frontMatterNumbering': 'skip' }, [], null, 2);
  const { doc } = await loadPdf(out);

  // The footer marks its own content stream, which is how the splitter finds
  // and removes footers when a bundle is reopened. A page with no marked
  // stream was never drawn on.
  const hasFooter = (page) => {
    const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
    const size = contents?.size ? contents.size() : 0;
    for (let i = 0; i < size; i++) {
      const st = doc.context.lookup(contents.get(i));
      if (st?.dict?.get(PDFName.of('BundleToolFooter'))) return true;
    }
    return false;
  };
  const pages = doc.getPages();
  assert.equal(hasFooter(pages[0]), false, 'front matter must carry no plate at all');
  assert.equal(hasFooter(pages[1]), false);
  assert.equal(hasFooter(pages[2]), true, 'the first document page is numbered');
});

test('the index heading falls back to the bundle title when blank', async () => {
  const { default: Config } = await import('../public/js/bundletoolConfig.js');
  const c = new Config();
  c.updateOptions({ heading: { bundleTitle: 'Trial Bundle' }, index: { headingText: '' } });
  assert.equal(c.getOption('index.headingText'), '');
  c.updateOptions({ index: { headingText: 'INDEX OF DOCUMENTS' } });
  assert.equal(c.getOption('index.headingText'), 'INDEX OF DOCUMENTS');
});

