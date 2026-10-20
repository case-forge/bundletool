/**
 * Footer removal and content-stream surgery.
 *
 * A footer block cannot safely be found with a regex such as
 * `q[\s\S]*?<colour> rg[\s\S]*?Q` with the /g flag: that matches from the
 * FIRST q in the stream to the FIRST Q after the colour, which is safe only
 * while every footer sits in its own self-contained q/Q block. That is true of
 * the streams pdf-lib writes and is not a property of PDFs in general. The two
 * HAZARD tests are the cases in which such a regex destroys page content; both
 * are written against the behaviour (what is left in the stream), not against
 * the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName, StandardFonts, rgb } from '../public/js/bundletoolPdfLib.js';
import {
  stripFooterBlocks, findGraphicsStateOperators, removePageNumbering,
  normaliseBundleMetadata, FOOTER_COLOURS,
} from '../public/js/bundletoolRestore.js';
import { drawFooterOnPage, registerPageFont } from '../public/js/bundletoolFooter.js';
import { setMetadata } from '../public/js/bundletoolMeta.js';
import { validateAndCountPages } from '../public/js/bundletoolPages.js';

const FOOTER_BLOCK = `q
1 g
270.5 4 74 34 re f
0.958 g
278.5 8 58 26 re f
BT
${FOOTER_COLOURS[0]} rg
/F1 12 Tf
286 16 Td
(Bundle Page 7) Tj
ET
Q
`;

const BODY_BLOCK = `q
1 0 0 1 60 700 cm
BT
0 0 0 rg
/F1 18 Tf
(Witness statement of Ms A) Tj
ET
Q
`;

test('a footer in its own block is removed', () => {
  const { cleaned, removed } = stripFooterBlocks(BODY_BLOCK + FOOTER_BLOCK);
  assert.equal(removed, 1);
  assert.ok(cleaned.includes('Witness statement of Ms A'));
  assert.ok(!cleaned.includes('Bundle Page 7'));
});

test('THE HAZARD: body content before a footer in the same stream survives', () => {
  // A lazy regex would start at the body's `q` and run to the first `Q` after
  // the footer colour, taking the body's drawing operators with it.
  const stream = BODY_BLOCK + FOOTER_BLOCK;
  const { cleaned, removed } = stripFooterBlocks(stream);
  assert.equal(removed, 1);
  assert.ok(cleaned.includes('1 0 0 1 60 700 cm'), 'body transformation matrix was deleted');
  assert.ok(cleaned.includes('(Witness statement of Ms A) Tj'), 'body text was deleted');
  const q = (cleaned.match(/(^|\s)q(\s|$)/g) || []).length;
  const Q = (cleaned.match(/(^|\s)Q(\s|$)/g) || []).length;
  assert.equal(q, Q, 'graphics state left unbalanced');
});

test('THE HAZARD: a footer nested inside an outer graphics state', () => {
  // Only the inner block should go. A lazy regex would match from the outer q
  // and leave a stray Q behind.
  const stream = `q\n0.5 0 0 0.5 0 0 cm\n${BODY_BLOCK}${FOOTER_BLOCK}Q\n`;
  const { cleaned, removed } = stripFooterBlocks(stream);
  assert.equal(removed, 1);
  assert.ok(cleaned.includes('0.5 0 0 0.5 0 0 cm'), 'outer graphics state was destroyed');
  assert.ok(cleaned.includes('(Witness statement of Ms A) Tj'));
  assert.ok(!cleaned.includes('Bundle Page 7'));
  const q = (cleaned.match(/(^|\s)q(\s|$)/g) || []).length;
  const Q = (cleaned.match(/(^|\s)Q(\s|$)/g) || []).length;
  assert.equal(q, Q, 'graphics state left unbalanced');
});

test('a block that draws an image is never treated as a footer', () => {
  // A scanned page whose text happens to be set in the footer colour must not
  // lose its scan.
  const stream = `q\n${FOOTER_COLOURS[1]} rg\n595 0 0 841 0 0 cm\n/Im0 Do\nQ\n`;
  const { removed } = stripFooterBlocks(stream);
  assert.equal(removed, 0);
});

test('an oversized block is left alone even if it carries the colour', () => {
  const filler = '0 0 100 100 re f\n'.repeat(200);
  const stream = `q\n${FOOTER_COLOURS[0]} rg\n${filler}Q\n`;
  assert.ok(stream.length > 2048);
  assert.equal(stripFooterBlocks(stream).removed, 0);
});

test('q and Q inside a literal string are not read as operators', () => {
  // "(Quote)" contains a Q. Treating it as a graphics-state operator
  // unbalances the stack for the whole rest of the stream.
  const stream = `q\nBT\n(A q Q quote) Tj\nET\nQ\n`;
  const ops = findGraphicsStateOperators(stream);
  assert.equal(ops.length, 2, 'only the real q and Q should be found');
  assert.equal(ops[0].char, 'q');
  assert.equal(ops[1].char, 'Q');
});

test('q and Q inside hex strings and comments are not read as operators', () => {
  const stream = `q\n% a comment mentioning q and Q\nBT\n<5171> Tj\nET\nQ\n`;
  assert.equal(findGraphicsStateOperators(stream).length, 2);
});

test('escaped parentheses inside a string do not end it early', () => {
  const stream = `q\nBT\n(a \\) Q not an operator) Tj\nET\nQ\n`;
  assert.equal(findGraphicsStateOperators(stream).length, 2);
});

test('a stream with no footer colour is returned untouched', () => {
  const { cleaned, removed } = stripFooterBlocks(BODY_BLOCK);
  assert.equal(removed, 0);
  assert.equal(cleaned, BODY_BLOCK);
});

test('all three footer colours are recognised', () => {
  for (const colour of FOOTER_COLOURS) {
    const stream = `q\nBT\n${colour} rg\n/F1 12 Tf\n(Page 1) Tj\nET\nQ\n`;
    assert.equal(stripFooterBlocks(stream).removed, 1, `colour ${colour} not matched`);
  }
});

test('several footers in one stream all go', () => {
  const { removed } = stripFooterBlocks(FOOTER_BLOCK + BODY_BLOCK + FOOTER_BLOCK);
  assert.equal(removed, 2);
});

test('end to end: a footered page comes back clean', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(3, 'SRC'));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.getPages().forEach((page, i) => {
    drawFooterOnPage(doc, page, {
      text: `Bundle Page ${i + 1}`, font, fontKey: registerPageFont(page, font),
      fontSize: 12, colour: rgb(0.072, 0.021, 0.073), indexPageIndex: 0,
    });
  });
  const withFooters = await doc.save();

  const stripped = await removePageNumbering(withFooters);
  const reread = await PDFDocument.load(stripped);
  assert.equal(reread.getPageCount(), 3, 'stripping must not lose pages');

  // Nothing tagged as a footer should remain on any page.
  for (const page of reread.getPages()) {
    const contents = reread.context.lookup(page.node.get(PDFName.of('Contents')));
    const size = contents?.size ? contents.size() : 1;
    for (let i = 0; i < size; i++) {
      const s = reread.context.lookup(contents.get(i));
      assert.equal(s?.dict?.get(PDFName.of('BundleToolFooter')), undefined);
    }
  }
});

test('removePageNumbering returns the input unchanged when there is nothing to remove', async () => {
  const bytes = await fx.makePdf(2, 'PLAIN');
  const out = await removePageNumbering(bytes);
  assert.equal(out, bytes, 'should return the identical object, not a re-saved copy');
});

test('metadata in the flat format is normalised into sections', () => {
  const legacy = [
    { filename: 'a.pdf', title: 'Intro', page: 3 },
    { section: true, title: 'A: Background Documents' },
    { filename: 'b.pdf', title: 'Report', page: 5 },
  ];
  const sections = normaliseBundleMetadata(legacy);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].sectionID, '0000');
  assert.equal(sections[0].files[0].filename, 'a.pdf');
  assert.equal(sections[1].sectionLabel, 'A');
  assert.equal(sections[1].sectionName, 'Background Documents');
  assert.equal(sections[1].files[0].filename, 'b.pdf');
});

test('a long colon-prefixed section title is not mistaken for a label', () => {
  const sections = normaliseBundleMetadata([
    { section: true, title: 'Correspondence: solicitors' },
  ]);
  assert.equal(sections[1].sectionLabel, '');
  assert.equal(sections[1].sectionName, 'Correspondence: solicitors');
});

// ── Detecting a bundle at add time ───────────────────────────────────────────

const DETECT_CV = {
  'pageOptions.coversheet': false,
  'index.outlineItemStyle': 'plain',
  'index.fontFace': 'serif',
  'heading.bundleTitle': 'Bundle A',
  'heading.claimNumber': 'ZC00P00123',
};

function detectTocEntries(fileCount = 3) {
  return [{
    sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Applications',
    beginsOnPdfPage: 2, actualPdfStartPageWithToc: 2,
    entries: Array.from({ length: fileCount }, (_, i) => ({
      tabNumber: i + 1, title: `Document ${i + 1}`, date: '2026-03-12',
      filename: `doc-${i + 1}.pdf`, pageCount: 2,
      beginsOnPdfPage: 2 + i * 2, beginsOnPageOfSection: 1 + i * 2,
      actualPdfStartPageWithToc: 2 + i * 2,
    })),
  }];
}

test('a bundle this tool made is recognised when added as an ordinary file', async () => {
  // The metadata is written by the real writer (setMetadata), not planted by
  // hand, so this fails if the writer and the detector ever drift apart.
  const doc = await PDFDocument.load(await fx.makePdf(8, 'B'));
  setMetadata(doc, detectTocEntries(3), DETECT_CV);
  const result = await validateAndCountPages(await doc.save());
  assert.ok(result.bundle, 'a bundle with a written index must be detected');
  assert.equal(result.bundle.documents, 3);
  assert.ok(result.bundle.version >= 3);
});

test('an ordinary PDF is not mistaken for a bundle', async () => {
  const result = await validateAndCountPages(await fx.makePdf(4, 'P'));
  assert.equal(result.bundle, null);
  assert.equal(result.pageCount, 4);
});

test('detection failing must not stop the file being added', async () => {
  // A damaged-but-recoverable PDF still validates; whatever detection makes of
  // it, the validation result must come back rather than throw.
  const damaged = await fx.makePdf(3, 'D');
  const result = await validateAndCountPages(damaged);
  assert.equal(typeof result.pageCount, 'number');
  assert.ok('bundle' in result, 'the bundle field must always be present');
});
