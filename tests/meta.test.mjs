/**
 * Bundle metadata and the load-from-PDF round trip.
 *
 * The central claim being tested: the whole bundle index payload fits in the
 * Info dictionary, with no hidden annotation. If that is wrong, "load from
 * bundle PDF" breaks for every bundle built, so it is tested at the size it
 * will actually reach and well beyond.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName, PDFHexString } from '../public/js/bundletoolPdfLib.js';
import {
  setMetadata, readBundleIndex, buildBundleIndexPayload, buildOutlineTree,
  addIndexHyperlinks, applyMeta, BUNDLE_INDEX_KEY, BUNDLE_INDEX_VERSION,
} from '../public/js/bundletoolMeta.js';
import { openBundle } from '../public/js/bundletoolRestore.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { readOutline } from '../public/js/bundletoolOutline.js';

const CV = {
  'pageOptions.coversheet': false,
  'pageOptions.printableBundle': false,
  'index.outlineItemStyle': 'plain',
  'index.fontFace': 'serif',
  'index.dateStyle': 'DD Mon. YYYY',
  'index.sectionPrefix': 'Section ',
  'heading.bundleTitle': 'Bundle for Final Hearing',
  'heading.projectName': 'Re: A (A Child)',
  'heading.author': 'A. Solicitor',
  'heading.claimNumber': 'ZC00P00123',
  'pageNumbering.footerFont': 'serif',
  'pageNumbering.alignment': 'centre',
  'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerPrefix': '',
  'pageNumbering.pageNumberPerSection': true,
};

function tocEntries(fileCount = 3) {
  return [{
    sectionID: '0001',
    sectionNumber: 1,
    sectionLabel: 'A',
    sectionTitle: 'Applications',
    beginsOnPdfPage: 2,
    actualPdfStartPageWithToc: 2,
    entries: Array.from({ length: fileCount }, (_, i) => ({
      tabNumber: i + 1,
      title: `Document ${i + 1}`,
      date: '2026-03-12',
      filename: `doc-${i + 1}.pdf`,
      pageCount: 2,
      beginsOnPdfPage: 2 + i * 2,
      beginsOnPageOfSection: 1 + i * 2,
      actualPdfStartPageWithToc: 2 + i * 2,
    })),
  }];
}

test('the bundle index is written under the key load-from-PDF looks for', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(8, 'B'));
  setMetadata(doc, tocEntries(), CV);
  // mupdf's "info:BundleIndex" and pdf-lib's /BundleIndex are the same entry.
  assert.ok(doc.getInfoDict().get(PDFName.of('BundleIndex')));
});

test('the payload survives a save and reload', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(8, 'B'));
  setMetadata(doc, tocEntries(3), CV);
  const reread = await PDFDocument.load(await doc.save());
  const payload = readBundleIndex(reread);

  assert.equal(payload.version, BUNDLE_INDEX_VERSION);
  assert.equal(payload.config.heading.claimNumber, 'ZC00P00123');
  assert.equal(payload.sections.length, 1);
  assert.equal(payload.sections[0].files.length, 3);
  assert.equal(payload.sections[0].files[0].filename, 'doc-1.pdf');
});

test('the payload carries index.sectionPrefix and pageNumbering.pageNumberPerSection', async () => {
  // Without them, both settings would come back wrong whenever a bundle is
  // reopened.
  const payload = buildBundleIndexPayload(tocEntries(), CV);
  assert.equal(payload.config.index.sectionPrefix, 'Section ');
  assert.equal(payload.config.pageNumbering.pageNumberPerSection, true);
});

test('100,000 characters round-trip through the same metadata entry', async () => {
  // Far beyond the roughly 500 characters some PDF engines truncate metadata at.
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  const payload = 'x'.repeat(100_000);
  doc.getInfoDict().set(PDFName.of(BUNDLE_INDEX_KEY), PDFHexString.fromText(payload));
  const reread = await PDFDocument.load(await doc.save());
  const back = reread.getInfoDict().get(PDFName.of(BUNDLE_INDEX_KEY)).decodeText();
  assert.equal(back.length, 100_000);
  assert.equal(back, payload);
});

test('a realistic 300-document index fits in metadata', async () => {
  const big = [{
    sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Bundle',
    beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2,
    entries: Array.from({ length: 300 }, (_, i) => ({
      tabNumber: i + 1,
      title: `Statement of Ms Okonkwo-Ré dated 12 March 2026 (document ${i + 1})`,
      date: '2026-03-12', filename: `a-fairly-long-file-name-${i + 1}.pdf`,
      pageCount: 5, beginsOnPdfPage: 2 + i * 5, beginsOnPageOfSection: 1 + i * 5,
      actualPdfStartPageWithToc: 2 + i * 5,
    })),
  }];
  const json = JSON.stringify(buildBundleIndexPayload(big, CV));
  assert.ok(json.length > 30_000, `expected a large payload, got ${json.length} chars`);

  const doc = await PDFDocument.load(await fx.makePdf(4, 'B'));
  setMetadata(doc, big, CV);
  const reread = await PDFDocument.load(await doc.save());
  assert.equal(readBundleIndex(reread).sections[0].files.length, 300);
});

test('non-ASCII survives the metadata round trip', async () => {
  const cv = { ...CV, 'heading.projectName': 'Re: Ọkonkwò \u2014 «B» (A Child)' };
  const doc = await PDFDocument.load(await fx.makePdf(2, 'B'));
  setMetadata(doc, tocEntries(1), cv);
  const reread = await PDFDocument.load(await doc.save());
  assert.equal(readBundleIndex(reread).config.heading.projectName, 'Re: Ọkonkwò \u2014 «B» (A Child)');
  assert.equal(reread.getSubject(), 'Re: Ọkonkwò \u2014 «B» (A Child)');
});

test('no hidden annotation is written', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(4, 'B'));
  setMetadata(doc, tocEntries(), CV);
  const reread = await PDFDocument.load(await doc.save());
  const annots = reread.getPage(0).node.get(PDFName.of('Annots'));
  const resolved = annots ? reread.context.lookup(annots) : null;
  const count = resolved?.size ? resolved.size() : 0;
  assert.equal(count, 0, 'page 1 should carry no BundleIndexData annotation');
});

test('openBundle reads the index back for the restore flow', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(8, 'B'));
  setMetadata(doc, tocEntries(3), CV);
  const opened = await openBundle(await doc.save());
  assert.equal(opened.version, BUNDLE_INDEX_VERSION);
  assert.equal(opened.metadata.length, 1);
  assert.equal(opened.metadata[0].files.length, 3);
  assert.equal(opened.config.heading.bundleTitle, 'Bundle for Final Hearing');
});

test('a bundle with no index at all still yields what the standard fields hold', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(3, 'B'));
  doc.setTitle('CONFIDENTIAL Trial Bundle');
  doc.setSubject('Re: C (Children)');
  doc.setKeywords(['ZC00D00999']);
  const opened = await openBundle(await doc.save());
  assert.equal(opened.metadata, null);
  assert.equal(opened.config.heading.bundleTitle, 'Trial Bundle');
  assert.equal(opened.config.heading.claimNumber, 'ZC00D00999');
});

test('a recovered document stays flagged in the bundle metadata', async () => {
  const entries = tocEntries(2);
  entries[0].entries[1].recovered = true;
  entries[0].entries[1].recoveryNote = 'Recovered 4 pages; the file is damaged and may be incomplete.';
  const payload = buildBundleIndexPayload(entries, CV);
  assert.equal(payload.sections[0].files[0].recovered, undefined, 'clean files carry no flag');
  assert.equal(payload.sections[0].files[1].recovered, true);
  assert.match(payload.sections[0].files[1].recoveryNote, /may be incomplete/);
});

test('the outline nests documents under their section', () => {
  const items = buildOutlineTree(tocEntries(2), CV, 0);
  assert.equal(items[0].title, '[0] Index');
  assert.equal(items[1].title, 'A: Applications');
  assert.equal(items[1].children.length, 2);
});

test('the index bookmark label is the user\'s; blank falls back to Index', () => {
  const custom = buildOutlineTree(tocEntries(2), { ...CV, 'index.indexBookmarkLabel': 'go to index' }, 0);
  assert.equal(custom[0].title, '[0] go to index');
  // Blank and whitespace both fall back, so a bundle that does not record the
  // setting, and a user clearing the field, get the word Index.
  const blank = buildOutlineTree(tocEntries(2), { ...CV, 'index.indexBookmarkLabel': '  ' }, 0);
  assert.equal(blank[0].title, '[0] Index');
});

test('documents in the null section sit at the top level, not under an invented parent', () => {
  const entries = tocEntries(2);
  entries[0].sectionID = '0000';
  const items = buildOutlineTree(entries, CV, 0);
  assert.equal(items.length, 3, 'Index plus two documents, with no section heading');
  assert.equal(items[1].children, undefined);
});

test('index links point at the documents they name and sit on the page', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(10, 'B'));
  const rows = [
    { pageNumber: 1, tabNumber: 1, x: 20, y: 40, width: 170, height: 8 },
    { pageNumber: 1, tabNumber: 2, x: 20, y: 50, width: 170, height: 8 },
  ];
  const added = addIndexHyperlinks(doc, rows, tocEntries(2), CV);
  assert.equal(added, 2);

  const page = doc.getPage(0);
  const { height } = page.getMediaBox();
  const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
  const rect = doc.context.lookup(annots.get(0)).get(PDFName.of('Rect'));
  const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => rect.get(i).asNumber());

  assert.ok(x2 > x1 && y2 > y1);
  // Row 1 is 40mm from the TOP in jsPDF's frame, so it must be near the top of
  // the page in PDF coordinates, not 40mm up from the bottom.
  assert.ok(y2 > height * 0.7, `link should be near the top of the page, was at y=${y2}`);
});

test('applyMeta does all three stages in one pass', async () => {
  const bytes = await fx.makePdf(8, 'B');
  const out = await applyMeta(bytes, [{ pageNumber: 1, tabNumber: 1, x: 20, y: 40, width: 170, height: 8 }],
    tocEntries(2), CV);
  // Reload through loadPdf, not PDFDocument.load. pdf-lib's default load
  // option updateMetadata:true rewrites /Producer to its own name on the way
  // in, so a bare load would report pdf-lib's Producer and hide ours.
  const { doc: reread } = await loadPdf(out);

  assert.ok(readBundleIndex(reread), 'metadata written');
  assert.ok(readOutline(reread).length > 0, 'bookmarks written');
  assert.ok(reread.getPage(0).node.get(PDFName.of('Annots')), 'index links written');
  assert.equal(reread.getTitle(), CV['heading.bundleTitle']);
  assert.match(reread.getProducer(), /^BundleTool \(CaseForge\) v/);
});

test('opening a bundle does not rewrite the metadata it just read', async () => {
  // pdf-lib stamps its own /Producer and a fresh /ModDate on load unless told
  // not to. For a tool whose whole job is round-tripping bundles that would
  // quietly relabel every bundle it opened as having been produced by pdf-lib.
  const bytes = await fx.makePdf(4, 'B');
  const out = await applyMeta(bytes, [], tocEntries(1), CV);
  const opened = await openBundle(out);
  assert.match(opened.doc.getProducer(), /^BundleTool \(CaseForge\) v/);
});
