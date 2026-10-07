/**
 * Email split on a REAL bundle: one built by the shipped pipeline (merge, page numbers with
 * footer links to the index, embedded index, index links, bookmarks), with pages heavy enough
 * that size matters.
 *
 * tests/split.test.mjs builds its bundles by hand with no links, so it cannot show a split that
 * copies most of the bundle into every part (copyPages follows link targets). Here the properties that matter to the person emailing the parts are checked directly:
 * a part holds only its own pages, is about the size of those pages, and every link and
 * bookmark left in it points at a page that is in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, StandardFonts } from '../public/js/bundletoolPdfLib.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { mergeFileEntries, mergeTwoPdfs } from '../public/js/bundletoolMerge.js';
import { applyPageNumbering, buildPageLabels } from '../public/js/bundletoolPages.js';
import { applyMeta, readBundleIndex } from '../public/js/bundletoolMeta.js';
import { splitForEmail, describePartPages, inspectBundleForSplit } from '../public/js/bundletoolSplit.js';
import { partFilenames } from '../public/js/frontend/emailSplit.js';
import { readOutline } from '../public/js/bundletoolOutline.js';

const HAVE_PDFTOTEXT = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function pdfText(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-splitreal-'));
  try {
    const file = path.join(dir, 's.pdf');
    fs.writeFileSync(file, bytes);
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PAGES_EACH = 3;
const FONT = 410_712;            // Liberation Sans, embedded whole in the bundle and so in each part
const FONT_OVERHEAD = 520_000;

/** A document of heavy pages: each carries an incompressible picture. */
async function heavyDoc(label, seed) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PAGES_EACH; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`${label} page ${i + 1}`, { x: 60, y: 780, size: 18, font });
    const png = await doc.embedPng(fx.makeNoisePng(128, 128, seed * 10 + i));
    page.drawImage(png, { x: 60, y: 300, width: 300, height: 300 });
  }
  return doc.save({ useObjectStreams: false });
}

const CV = {
  'pageOptions.coversheet': true, 'pageOptions.coverSource': 'uploaded', 'pageOptions.printableBundle': false,
  'index.outlineItemStyle': 'plain', 'index.fontFace': 'serif', 'index.dateStyle': 'DD Mon YYYY', 'index.sectionPrefix': '',
  'heading.bundleTitle': 'Bundle for hearing', 'heading.projectName': 'Re: X (A Child)',
  'heading.author': 'A. Solicitor', 'heading.claimNumber': 'ZC00P00456',
  'pageNumbering.footerFont': 'serif', 'pageNumbering.alignment': 'centre', 'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerPrefix': '', 'pageNumbering.pageNumberPerSection': false,
  'pageNumbering.footerFontSize': 'small', 'pageNumbering.pageNumberColour': 'black',
};

/**
 * A bundle built the way bundletoolMain.js builds one, minus the jsPDF index (a two-page stand-in):
 * cover, index, then `documents` documents of three pages in two sections.
 */
async function buildRealBundle({ documents = 8, cv = CV, frontMatterCount = 0 } = {}) {
  const docs = [];
  for (let d = 1; d <= documents; d++) docs.push({ filename: `doc${d}.pdf`, buffer: await heavyDoc(`DOC${d}`, d) });
  const merged = await mergeFileEntries(docs, false);
  const index = await fx.makePdf(2, 'INDEX');
  const withIndex = await mergeTwoPdfs(index, merged);
  const coversheet = await fx.makePdf(1, 'COVERSHEET');
  const withCover = await mergeTwoPdfs(coversheet, withIndex);
  const numbered = await applyPageNumbering(withCover, cv, [], 1, frontMatterCount);

  const half = documents / 2;
  const entryFor = (d) => ({
    tabNumber: d, title: `Document ${d}`, date: '2026-01-05', filename: `doc${d}.pdf`, pageCount: PAGES_EACH,
    beginsOnPdfPage: 4 + (d - 1) * PAGES_EACH, beginsOnPageOfSection: 1 + ((d - 1) % half) * PAGES_EACH,
    actualPdfStartPageWithToc: 4 + (d - 1) * PAGES_EACH,
  });
  const sectionOf = (n, label, from, to) => ({
    sectionID: `000${n}`, sectionNumber: n, sectionLabel: label, sectionTitle: `Part ${label}`,
    beginsOnPdfPage: 4 + (from - 1) * PAGES_EACH, actualPdfStartPageWithToc: 4 + (from - 1) * PAGES_EACH,
    entries: Array.from({ length: to - from + 1 }, (_, i) => entryFor(from + i)),
  });
  const tocEntries = [sectionOf(1, 'A', 1, half), sectionOf(2, 'B', half + 1, documents)];
  const rows = Array.from({ length: documents }, (_, i) => ({
    pageNumber: 1, tabNumber: i + 1, x: 20, y: 40 + i * 10, width: 170, height: 8,
  }));
  const final = await applyMeta(numbered, rows, tocEntries, cv);
  return { final, documents, pageCount: 3 + documents * PAGES_EACH };
}

/** The refs of every page dictionary in the file's object table, and of the pages in its page tree. */
function pageObjects(doc) {
  const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
  const all = new Set();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) all.add(ref.tag);
  }
  return { inTree, all };
}

/** Every link annotation's target page ref tag (null for a link that is not to a page). */
function linkTargets(doc) {
  const out = [];
  for (const page of doc.getPages()) {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      let dest = doc.context.lookup(annot.get(PDFName.of('Dest')));
      if (!dest) {
        const action = doc.context.lookup(annot.get(PDFName.of('A')));
        if (action instanceof PDFDict) dest = doc.context.lookup(action.get(PDFName.of('D')));
      }
      const first = dest instanceof PDFArray ? dest.get(0) : null;
      out.push(first instanceof PDFRef ? first.tag : null);
    }
  }
  return out;
}

let bundle;
async function realBundle() { return (bundle ??= await buildRealBundle()); }

test('the fixture is a real bundle: footers and index rows link to pages, and it carries bookmarks', async () => {
  const { final, pageCount } = await realBundle();
  const { doc } = await loadPdf(final);
  assert.equal(doc.getPageCount(), pageCount);
  const targets = linkTargets(doc);
  assert.ok(targets.filter(Boolean).length >= pageCount, `expected a page link per page, found ${targets.length}`);
  assert.ok(readOutline(doc).length >= 2, 'the bundle has no bookmarks');
});

for (const partsWanted of [2, 3]) {
  test(`a real bundle split into about ${partsWanted} parts: each part holds only its own pages and is sized like them`, async () => {
    const { final, pageCount } = await realBundle();
    // Each part carries its own copy of the footer font (about 410 KB, embedded whole in the bundle), so a
    // part is its share of the pages plus that: the target allows for it.
    const target = Math.ceil((final.length - FONT) / partsWanted) + FONT + 20_000;
    const parts = await splitForEmail(final, { targetBytes: target, mode: 'fill', partCover: true, title: 'Bundle for hearing' });
    assert.ok(parts.length >= partsWanted && parts.length <= partsWanted + 2, `got ${parts.length} parts`);

    let coveredPages = 0;
    for (const part of parts) {
      const { doc } = await loadPdf(part.bytes);
      const own = part.toPage - part.fromPage + 1;
      assert.equal(doc.getPageCount(), own + 1, 'a part is its own pages plus its cover');
      coveredPages += own;
      const { inTree, all } = pageObjects(doc);
      assert.deepEqual([...all].filter((t) => !inTree.has(t)), [], 'the part holds pages that are not in it');
      assert.equal(part.oversize, false, `part ${part.partNumber} is flagged oversize at ${part.bytes.length} bytes against ${target}`);
      // The part is about the size of the share of the bundle it holds, not of the whole bundle.
      assert.ok(part.bytes.length < final.length * (own / pageCount) * 1.3 + FONT_OVERHEAD,
        `part ${part.partNumber} is ${part.bytes.length} bytes for ${own} of ${pageCount} pages of a ${final.length} byte bundle`);
      assert.ok(part.bytes.length < final.length * 0.9, 'a part is nearly as big as the whole bundle');
      for (const t of linkTargets(doc)) if (t !== null) assert.ok(inTree.has(t), 'a link points outside its part');
    }
    assert.equal(coveredPages, pageCount, 'the parts together hold every page exactly once');
  });
}

test('links inside a part still work, and bookmarks are trimmed to the part', async () => {
  const { final } = await realBundle();
  const parts = await splitForEmail(final, { targetBytes: Math.ceil((final.length - FONT) / 3) + FONT + 20_000, mode: 'fill', partCover: false });
  const first = await loadPdf(parts[0].bytes);
  // Part 1 holds the cover, the index and the first documents: the index rows that point into it survive.
  assert.ok(linkTargets(first.doc).some((t) => t !== null), 'part 1 lost every link');
  const { inTree } = pageObjects(first.doc);
  const walk = (items) => items.forEach((it) => {
    assert.ok(it.pageIndex === null || it.pageIndex === undefined || it.pageIndex < first.doc.getPageCount(), 'a bookmark points past the part');
    walk(it.children || []);
  });
  walk(readOutline(first.doc));
  assert.ok(readOutline(first.doc).length > 0, 'part 1 has no bookmarks');
  const last = await loadPdf(parts[parts.length - 1].bytes);
  const lastOutline = readOutline(last.doc);
  assert.ok(lastOutline.length > 0, 'the last part has no bookmarks');
  assert.ok(inTree.size > 0);
});

test('a real bundle split in parts reads back with its own text and no other part\'s pages', { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the parts' }, async () => {
  const { final } = await realBundle();
  const parts = await splitForEmail(final, { targetBytes: Math.ceil((final.length - FONT) / 3) + FONT + 20_000, mode: 'fill', partCover: false });
  const text = parts.map((p) => pdfText(p.bytes));
  const docsIn = (t) => new Set([...t.matchAll(/DOC(\d) page/g)].map((m) => m[1]));
  const seen = new Set();
  for (const t of text) {
    for (const d of docsIn(t)) { assert.ok(!seen.has(d), `document ${d} appears in two parts`); seen.add(d); }
  }
  assert.equal(seen.size, 8, 'every document is in exactly one part');
});

for (const front of ['roman', 'skip']) {
  test(`a real bundle with ${front} front matter records it, and its part covers say the numbers printed on the pages`, { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the footers' }, async () => {
    const cv = { ...CV, 'pageNumbering.frontMatterNumbering': front };
    const { final } = await buildRealBundle({ cv, frontMatterCount: 3 });
    const { doc } = await loadPdf(final);
    const payload = readBundleIndex(doc);
    assert.equal(payload.config.pageNumbering.frontMatterNumbering, front, 'the bundle does not record how its front matter is numbered');
    const parts = await splitForEmail(final, { targetBytes: Math.ceil((final.length - FONT) / 2) + FONT + 20_000, mode: 'fill', partCover: true, title: 'T' });
    assert.ok(parts.length >= 2);
    const second = parts[1];
    assert.ok(second.fromPage > 3, 'the second part holds documents');
    const said = /bundle pages (\d+) to (\d+) of/.exec(pdfText(second.bytes));
    assert.ok(said, 'the part cover does not name printed bundle pages');
    assert.equal(Number(said[1]), second.fromPage - 3, 'the cover counts PDF pages, not the numbers printed in the footers');
    // The first page of the part, footer included, says the same number the cover promised.
    assert.match(pdfText(second.bytes), new RegExp(`Page ${said[1]}\\b`));
    assert.equal(describePartPages(payload, second.fromPage, second.toPage, 3 + 24).text.startsWith('bundle pages'), true);
  });
}

// ── Split by section, on a bundle with numbering restarted in each section ───────────────────────

/**
 * A cover, a two page index and three sections (A, B, C) of two three-page documents each, with the
 * footers numbered afresh in every section (A1..A6, B1..B6, C1..C6) as "Restart numbering per section" does.
 */
async function buildSectionBundle() {
  const labels = ['A', 'B', 'C'];
  const docs = [];
  for (let d = 1; d <= 6; d++) docs.push({ filename: `doc${d}.pdf`, buffer: await heavyDoc(`SEC${labels[Math.floor((d - 1) / 2)]}DOC${d}`, d) });
  const merged = await mergeFileEntries(docs, false);
  const index = await fx.makePdf(2, 'INDEX');
  const withCover = await mergeTwoPdfs(await fx.makePdf(1, 'COVERSHEET'), await mergeTwoPdfs(index, merged));
  const cv = { ...CV, 'pageNumbering.pageNumberPerSection': true };
  const entryFor = (d, section) => ({
    tabNumber: d, title: `Document ${d}`, date: '2026-01-05', filename: `doc${d}.pdf`, pageCount: PAGES_EACH,
    beginsOnPdfPage: 4 + (d - 1) * PAGES_EACH, beginsOnPageOfSection: 1 + ((d - 1) % 2) * PAGES_EACH,
    actualPdfStartPageWithToc: 4 + (d - 1) * PAGES_EACH, section,
  });
  const tocEntries = labels.map((label, n) => ({
    sectionID: `000${n + 1}`, sectionNumber: n + 1, sectionLabel: label, sectionTitle: ['Applications', 'Orders', 'Evidence'][n],
    beginsOnPdfPage: 4 + n * 2 * PAGES_EACH, actualPdfStartPageWithToc: 4 + n * 2 * PAGES_EACH,
    entries: [entryFor(n * 2 + 1, label), entryFor(n * 2 + 2, label)],
  }));
  const numbered = await applyPageNumbering(withCover, cv, buildPageLabels(tocEntries, true), 1, 0);
  const rows = Array.from({ length: 6 }, (_, i) => ({ pageNumber: 1, tabNumber: i + 1, x: 20, y: 40 + i * 10, width: 170, height: 8 }));
  return { final: await applyMeta(numbered, rows, tocEntries, cv), pageCount: 3 + 6 * PAGES_EACH };
}

test('a real bundle split by section: cover and index, then one part per section, each holding only its own pages', async () => {
  const { final, pageCount } = await buildSectionBundle();
  const info = await inspectBundleForSplit(final);
  assert.equal(info.title, 'Bundle for hearing');
  assert.deepEqual(info.sections.map((sec) => `${sec.label} ${sec.name}`), ['A Applications', 'B Orders', 'C Evidence']);

  const parts = await splitForEmail(final, { mode: 'section', targetBytes: 50_000_000, partCover: false });
  assert.deepEqual(parts.map((p) => [p.kind, p.sectionLabel]), [['front', ''], ['section', 'A'], ['section', 'B'], ['section', 'C']]);
  assert.deepEqual(parts.map((p) => p.toPage - p.fromPage + 1), [3, 2 * PAGES_EACH, 2 * PAGES_EACH, 2 * PAGES_EACH]);

  let covered = 0;
  for (const part of parts) {
    const { doc } = await loadPdf(part.bytes);
    assert.equal(doc.getPageCount(), part.toPage - part.fromPage + 1, 'a seamless part is exactly its own pages');
    covered += doc.getPageCount();
    const { inTree, all } = pageObjects(doc);
    assert.deepEqual([...all].filter((t) => !inTree.has(t)), [], 'the part holds pages that are not in it');
    for (const t of linkTargets(doc)) if (t !== null) assert.ok(inTree.has(t), 'a link points outside its part');
    assert.ok(part.bytes.length < final.length * 0.6, 'a part is nearly as big as the whole bundle');
  }
  assert.equal(covered, pageCount, 'the parts together hold every page exactly once');

  // Bookmarks are trimmed to the part: the last part keeps its own and none point past its pages.
  const last = await loadPdf(parts[3].bytes);
  const walk = (items) => items.forEach((it) => {
    assert.ok(it.pageIndex == null || it.pageIndex < last.doc.getPageCount(), 'a bookmark points past the part');
    walk(it.children || []);
  });
  walk(readOutline(last.doc));

  // Names: bundle title, then the section.
  assert.deepEqual(partFilenames('whatever.pdf', parts), [
    'Bundle for hearing - Cover and index.pdf',
    'Bundle for hearing - A Applications.pdf',
    'Bundle for hearing - B Orders.pdf',
    'Bundle for hearing - C Evidence.pdf',
  ]);
});

test('parts split by section print the same page numbers they had in the whole bundle', { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the footers' }, async () => {
  const { final } = await buildSectionBundle();
  const parts = await splitForEmail(final, { mode: 'section', targetBytes: 50_000_000, partCover: false });
  const whole = pdfText(final);
  for (const label of ['A', 'B', 'C']) assert.match(whole, new RegExp(`\\b${label}1\\b`), `the whole bundle prints ${label}1`);
  const text = parts.map((p) => pdfText(p.bytes));
  // Section B's part starts at B1 and runs to B6, and carries nothing of A or C.
  assert.match(text[2], /\bB1\b/);
  assert.match(text[2], /\bB6\b/);
  assert.doesNotMatch(text[2], /SECADOC|SECCDOC|\bA\d\b|\bC\d\b/);
  assert.match(text[3], /\bC1\b/);
  assert.match(text[3], /SECCDOC5 page 1/);
  assert.doesNotMatch(text[1], /SECBDOC/);
  assert.match(text[0], /COVERSHEET/);
  assert.match(text[0], /INDEX/);
  assert.doesNotMatch(text[0], /SEC[ABC]DOC/);
});
