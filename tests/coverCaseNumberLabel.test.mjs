/**
 * cover.caseNumberLabel: the prefix drawn before the case number, freely overridable the same
 * way the party labels are. "CASE NO:" is the stored default; a caller that
 * never sets it (an absent key in cv, not just a falsy one) must render byte-for-byte the same
 * as one that sets the default explicitly. layoutCover() runs against a page that records every
 * drawText and drawLine call, the same harness as coverPolish.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { getFontSettings } from '../public/js/bundletoolFontSettings.js';
import { pageDimensions } from '../public/js/bundletoolPageSize.js';
import { layoutCover, MARGIN } from '../public/js/bundletoolCover.js';

async function loadFonts(face) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const s = getFontSettings(face);
  const get = async (url) => doc.embedFont(await fetch(url).then((r) => r.arrayBuffer()), { subset: false });
  return { regular: await get(s.regular.url), bold: await get(s.bold.url) };
}
const FONTS = { serif: await loadFonts('serif'), sans: await loadFonts('sans') };

function run(cv, { face = 'serif', scale = 1 } = {}) {
  const texts = []; const lines = [];
  const page = {
    drawText: (text, o) => texts.push({ text, x: o.x, y: o.y, size: o.size, w: (o.font ?? FONTS[face].bold).widthOfTextAtSize(text, o.size) }),
    drawLine: (o) => lines.push({ y: o.start.y, x0: o.start.x, x1: o.end.x, t: o.thickness }),
  };
  const bottom = layoutCover({ 'index.fontFace': face, 'pageOptions.pageSize': 'a4', 'heading.bundleTitle': 'Bundle', ...cv }, FONTS[face], scale, page);
  return { texts, lines, bottom };
}
const BASE = { 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'ZC26C00123', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES' };

test('an absent cover.caseNumberLabel renders byte-for-byte the same as the stored default: "CASE NO:" exactly, no other draw call changes', () => {
  const before = run(BASE);
  const after = run({ ...BASE, 'cover.caseNumberLabel': 'CASE NO:' });
  assert.deepEqual(before.texts, after.texts, 'an absent key and the explicit stored default draw identically');
  assert.deepEqual(before.lines, after.lines);
  const caseLine = before.texts.find((t) => t.text.startsWith('CASE NO'));
  assert.equal(caseLine.text, 'CASE NO: ZC26C00123');
});

test('an explicit empty label prints the number with no prefix at all, a real and different choice from the default', () => {
  const { texts } = run({ ...BASE, 'cover.caseNumberLabel': '' });
  assert.ok(texts.some((t) => t.text === 'ZC26C00123'), 'the bare number is drawn');
  assert.ok(!texts.some((t) => t.text.includes('CASE NO')), 'no leftover prefix');
});

test('whitespace round the label is trimmed before it is drawn, so no double space appears before the number', () => {
  const { texts } = run({ ...BASE, 'cover.caseNumberLabel': '  CLAIM NO:  ' });
  const c = texts.find((t) => t.text.startsWith('CLAIM NO'));
  assert.equal(c.text, 'CLAIM NO: ZC26C00123');
});

const LABELS = ['CASE NO:', 'CLAIM NO:', 'ORDER NO:', 'COURT REF:', 'A VERY LONG CUSTOM REFERENCE LABEL SOMEONE TYPED:'];
const SINGLE = ['ZC26C00123', '00000-0000000000-000'];
const JOINED = ['1234-5678-9012-3456 and 6543-2109-8765-4321'];

test('the longest custom labels, with the longest realistic case numbers, fit in every design, position, typeface and page size', () => {
  // A label this long combined with a joined number can exceed one line and wrap (block()'s job,
  // exactly as a long court name or title already can), so the invariant checked here is the one
  // that actually matters: nothing drawn ever crosses a margin, whatever it wrapped to.
  for (const label of LABELS) for (const number of [...SINGLE, ...JOINED]) for (const layout of ['classic', 'grid'])
    for (const line of ['court', 'own']) for (const ca of ['left', 'centre', 'right']) for (const ha of ['left', 'centre', 'right'])
    for (const face of ['serif', 'sans']) for (const size of ['a4', 'letter']) {
      const [W] = pageDimensions(size);
      const { texts, lines } = run({
        ...BASE, 'heading.claimNumber': number, 'cover.caseNumberLabel': label, 'cover.layout': layout,
        'cover.caseNumberLine': line, 'cover.caseNumberAlign': ca, 'cover.headingAlign': ha, 'pageOptions.pageSize': size,
      }, { face });
      const ctx = `${JSON.stringify(label)}/${number} ${layout}/${line}/${ca}/${ha}/${face}/${size}`;
      assert.ok(texts.some((t) => t.text.includes(number.split(' ')[0])), `${ctx}: the number is drawn somewhere`);
      for (const t of texts) assert.ok(t.x >= MARGIN - 0.01 && t.x + t.w <= W - MARGIN + 0.01, `${ctx}: "${t.text}" inside the margins`);
      for (const l of lines) assert.ok(l.x0 >= MARGIN - 0.01 && l.x1 <= W - MARGIN + 0.01, `${ctx}: a rule inside the margins`);
    }
});

test('a short label and a short number never wrap, and share the court line', () => {
  for (const label of ['CASE NO:', 'CLAIM NO:', 'ORDER NO:', 'COURT REF:']) {
    const { texts } = run({ ...BASE, 'cover.caseNumberLabel': label });
    const c = texts.find((t) => t.text.startsWith(label));
    const court = texts.find((t) => /FAMILY COURT/.test(t.text));
    assert.equal(c.text, `${label} ZC26C00123`, `${label}: one unbroken line`);
    assert.equal(c.y, court.y, `${label}: still shares the court's line`);
  }
});
