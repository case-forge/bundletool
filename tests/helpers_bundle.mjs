/**
 * Builds a bundle through the shipped single-pass pipeline from a list of source PDFs, for tests
 * that need to look at what a real build does to a source document's annotations, forms and links.
 */
import fs from 'node:fs';
import * as fx from './fixtures.mjs';
import { PDFDocument } from '../public/js/bundletoolPdfLib.js';
import { buildBundlePdf } from '../public/js/bundletoolBuild.js';

export const META = {
  'pageOptions.coversheet': false, 'pageOptions.coverSource': 'none', 'pageOptions.printableBundle': false,
  'index.outlineItemStyle': 'plain', 'index.fontFace': 'serif', 'index.dateStyle': 'DD Mon YYYY', 'index.sectionPrefix': '',
  'heading.bundleTitle': 'Bundle', 'heading.projectName': 'Re: X', 'heading.author': 'A. Solicitor', 'heading.claimNumber': 'ZC1',
  'pageNumbering.footerFont': 'helvetica', 'pageNumbering.alignment': 'centre', 'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerPrefix': '', 'pageNumbering.pageNumberPerSection': false, 'pageNumbering.footerLink': 'index',
};
export const FOOTER = {
  'pageNumbering.footerPrefix': '', 'pageNumbering.alignment': 'centre', 'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerFont': 'helvetica', 'pageNumbering.footerFontSize': 'small',
  'pageNumbering.pageNumberColour': 'black', 'pageNumbering.pageNumberPerSection': false,
};

/** @param {Array<{filename: string, buffer: Uint8Array}>} docs */
export async function buildFrom(docs) {
  const counts = [];
  for (const d of docs) counts.push((await PDFDocument.load(d.buffer, { throwOnInvalidObject: false })).getPageCount());
  let next = 2; // the index is one page
  const entries = docs.map((d, i) => {
    const e = { tabNumber: i + 1, title: `Document ${i + 1}`, date: '2026-01-05', filename: d.filename, pageCount: counts[i],
      beginsOnPdfPage: next, beginsOnPageOfSection: next - 1, actualPdfStartPageWithToc: next };
    next += counts[i];
    return e;
  });
  const tocEntries = [{ sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Documents',
    beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2, entries }];
  const rows = entries.map((e, i) => ({ pageNumber: 1, tabNumber: e.tabNumber, x: 20, y: 40 + i * 10, width: 170, height: 8 }));
  const index = await fx.makePdf(1, 'INDEX');
  const bytes = await buildBundlePdf({
    coverBytes: null, tocBytes: index, fileEntries: docs, printable: false, pageSize: 'a4',
    footerConfig: FOOTER, pageLabels: [], footerLinkPageIndex: 0, frontMatterCount: 1,
    metaConfig: META, tocTableRowCoordinates: rows, tocEntries,
  });
  return { bytes, counts };
}

export function fixture(name) {
  return new Uint8Array(fs.readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url)));
}
