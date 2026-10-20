/**
 * A real bundle for the tests, built the way the command line builds one (the shipped engine: index
 * pages drawn by the index code, footers with links, bookmarks and the embedded index), from generated
 * documents. Each document's pages have their own page height, so a test can tell which document a
 * page came from without reading text.
 */
import * as fx from './fixtures.mjs';
import { PDFDocument, StandardFonts } from '../public/js/bundletoolPdfLib.js';
import Config from '../public/js/bundletoolConfig.js';
import { IndexData } from '../public/js/bundletoolIndexData.js';
import { createTocEntries, makeDummyTocPages, makeTocPages } from '../public/js/bundletoolToc.js';
import { buildPageLabels, flattenFooterConfig } from '../public/js/bundletoolPages.js';
import { flattenConfig } from '../public/js/bundletoolMeta.js';
import { buildBundlePdf } from '../public/js/bundletoolBuild.js';

const TOC_OPTIONS = {
  font: { family: 'helvetica', sizeTitle: 18, sizeProject: 14, sizeTable: 11 },
  color: { headerFill: [200, 200, 200] },
  table: { showBorders: true, cellPadding: 2, lineHeight: 1.3 },
  margins: { top: 25, right: 22, bottom: 25, left: 22 },
};

/** The page height of document number `d` (1-based): 700 + d points, so the source of a page can be read from its size. */
export const heightOfDoc = (d) => 700 + d;

/** A document of `pages` pages, each 595 by heightOfDoc(d), optionally carrying incompressible weight. */
export async function makeDocument(d, pages, { heavy = false, seed = d } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, heightOfDoc(d)]);
    page.drawText(`DOC${d} page ${i + 1}`, { x: 60, y: 600, size: 18, font });
    if (heavy) {
      const png = await doc.embedPng(fx.makeNoisePng(200, 200, seed * 100 + i));
      page.drawImage(png, { x: 60, y: 200, width: 300, height: 300 });
    }
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * @param {Object} opts
 * @param {Array<{label?: string, name?: string, docs: Array<{pages: number, title?: string}>}>} opts.sections
 * @param {Object} [opts.options] - nested Config options to set
 * @param {boolean} [opts.cover] - page 1 is a cover page
 * @param {boolean} [opts.heavy] - every page carries an incompressible picture
 * @returns {Promise<{bytes: Uint8Array, docs: Array<{d: number, pages: number, start: number, title: string}>, pageCount: number, indexPages: number}>}
 */
export async function buildRealBundle({ sections, options = {}, cover = true, heavy = false } = {}) {
  const config = new Config();
  config.updateOptions({
    heading: { bundleTitle: 'Test bundle', projectName: 'Re: T (A Child)', claimNumber: 'ZC00P00456', author: 'A. Solicitor' },
    pageOptions: { coversheet: cover, coverSource: cover ? 'uploaded' : 'none', printableBundle: false },
    ...options,
  });
  let d = 0;
  const built = sections.map((s, si) => ({
    sectionID: String(si + 1).padStart(4, '0'), sectionLabel: s.label ?? String.fromCharCode(65 + si), sectionName: s.name ?? `Section ${si + 1}`,
    files: s.docs.map((doc) => { d += 1; return { filename: `doc${d}.pdf`, title: doc.title ?? `Document ${d}`, date: '2026-01-05', pageCount: doc.pages, _d: d }; }),
  }));
  const indexData = new IndexData(built.map((s) => ({ ...s, files: s.files.map(({ _d, ...f }) => f) })));
  indexData.validateIndexStructure();
  config.validateStructure();
  config.validateOptions();

  const tocEntries = await createTocEntries(indexData, config);
  const expected = await makeDummyTocPages(tocEntries, TOC_OPTIONS, config);
  const [tocPdf, rows] = await makeTocPages(tocEntries, TOC_OPTIONS, config, expected);

  const fileEntries = [];
  const docs = [];
  for (const section of built) {
    for (const f of section.files) {
      fileEntries.push({ filename: f.filename, buffer: await makeDocument(f._d, f.pageCount, { heavy }) });
    }
  }
  const frontMatterCount = (cover ? 1 : 0) + expected;
  const footerLinkSetting = config.getOption('pageNumbering.footerLink') || 'index';
  const indexPageIndex = cover ? 1 : 0;
  const bytes = await buildBundlePdf({
    coverBytes: cover ? await fx.makePdf(1, 'COVER') : null,
    tocBytes: tocPdf,
    fileEntries,
    printable: false,
    pageSize: config.getOption('pageOptions.pageSize'),
    footerConfig: flattenFooterConfig(config),
    pageLabels: buildPageLabels(tocEntries, config.getOption('pageNumbering.pageNumberPerSection')),
    frontMatterCount,
    footerLinkPageIndex: footerLinkSetting === 'none' ? null : footerLinkSetting === 'top' ? 0 : indexPageIndex,
    metaConfig: flattenConfig(config),
    tocTableRowCoordinates: rows,
    tocEntries,
  });
  let page = frontMatterCount + 1;
  for (const section of built) {
    for (const f of section.files) { docs.push({ d: f._d, pages: f.pageCount, start: page, title: f.title }); page += f.pageCount; }
  }
  return { bytes, docs, pageCount: frontMatterCount + docs.reduce((n, x) => n + x.pages, 0), indexPages: expected };
}
