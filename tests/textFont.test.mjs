/**
 * Text that Helvetica cannot draw (Welsh, Polish and Turkish letters) must print, not turn into "?":
 * the watermark and the title on a split part's cover choose a Liberation Sans subset when needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as fx from './fixtures.mjs';
import { PDFDocument } from '../public/js/bundletoolPdfLib.js';
import { textFontFor, unlikelyToPrint } from '../public/js/bundletoolTextFont.js';
import { applyWatermarkToDoc } from '../public/js/bundletoolWatermark.js';
import { splitForEmail } from '../public/js/bundletoolSplit.js';
import { applyMeta } from '../public/js/bundletoolMeta.js';

const HAVE_PDFTOTEXT = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const skipNoText = !HAVE_PDFTOTEXT && 'pdftotext is needed to read the text back';

function pdfText(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-textfont-'));
  try {
    const file = path.join(dir, 't.pdf');
    fs.writeFileSync(file, bytes);
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TITLE = 'Re Tŷ Ŵyn Łódź Yılmaz';

test('plain text stays in Helvetica: nothing is fetched or embedded for it', async () => {
  const doc = await PDFDocument.create();
  const r = await textFontFor(doc, 'Re Smith, and Jones');
  assert.equal(r.unicode, false);
  assert.deepEqual(r.unprintable, []);
});

test('Welsh, Polish and Turkish letters choose the Liberation Sans subset and are all drawable', async () => {
  const doc = await PDFDocument.create();
  const r = await textFontFor(doc, TITLE, { bold: true });
  assert.equal(r.unicode, true);
  assert.deepEqual(r.unprintable, []);
  assert.equal(r.text, TITLE);
});

test('a character no font has is reported and drawn as a question mark', async () => {
  const doc = await PDFDocument.create();
  const r = await textFontFor(doc, 'Tŷ 机密');
  assert.deepEqual(r.unprintable.sort(), ['密', '机'].sort());
  assert.equal(r.text, 'Tŷ ??');
});

test('the typing warning names what is unlikely to print and lets Latin, Greek and Cyrillic through', () => {
  assert.deepEqual(unlikelyToPrint(TITLE + ' Ελλάδα Россия'), []);
  assert.deepEqual(unlikelyToPrint('DRAFT 机密 😀').sort(), ['机', '密', '😀'].sort());
});

test('a watermark in Welsh and Polish letters prints them', { skip: skipNoText }, async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  await applyWatermarkToDoc(doc, 'DRAFFT Tŷ Ŵyn Łódź', '#999999', 40);
  const text = pdfText(await doc.save());
  // The mark is diagonal, so pdftotext gives it back in pieces: look for the letters, and for no "?".
  for (const ch of ['ŷ', 'Ŵ', 'Ł', 'ó', 'ź']) assert.ok(text.includes(ch), `watermark lost ${ch}: ${text}`);
  assert.ok(!text.includes('?'), `watermark printed a question mark: ${text}`);
});

test('a split part cover prints a Welsh and Polish title', { skip: skipNoText }, async () => {
  const docs = [];
  for (let d = 1; d <= 3; d++) docs.push(await fx.makePdf(2, `DOC${d}`));
  const merged = await PDFDocument.create();
  for (const bytes of [await fx.makePdf(1, 'COVER'), await fx.makePdf(1, 'INDEX'), ...docs]) {
    const src = await PDFDocument.load(bytes);
    for (const page of await merged.copyPages(src, src.getPageIndices())) merged.addPage(page);
  }
  const bundle = await applyMeta(await merged.save(), [], [{
    sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Docs', beginsOnPdfPage: 3, actualPdfStartPageWithToc: 3,
    entries: docs.map((_, i) => ({ tabNumber: i + 1, title: `D${i + 1}`, date: '', filename: `d${i + 1}.pdf`, pageCount: 2,
      beginsOnPdfPage: 3 + i * 2, beginsOnPageOfSection: 1 + i * 2, actualPdfStartPageWithToc: 3 + i * 2 })),
  }], { 'heading.bundleTitle': TITLE });
  const parts = await splitForEmail(bundle, { targetBytes: 10_000, mode: 'section', partCover: true, title: TITLE });
  const text = pdfText(parts[0].bytes);
  assert.ok(text.includes('Tŷ') && text.includes('Ŵyn') && text.includes('Łódź') && text.includes('Yılmaz'), `cover printed as: ${text}`);
});
