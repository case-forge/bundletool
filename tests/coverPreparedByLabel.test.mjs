/**
 * cover.preparedByLabel: the label drawn before who prepared the bundle, freely overridable the
 * same way cover.caseNumberLabel is. "Prepared by:" is the stored default; a caller that never
 * sets it (an absent key in cv, not just a falsy one) must render byte-for-byte the same as one
 * that sets the default explicitly. layoutCover() runs against a page that records every
 * drawText and drawLine call, the same harness as coverCaseNumberLabel.test.mjs.
 *
 * Unlike the case number, "Prepared by" is a single fixed line above the footer (PREPARED_BY_Y):
 * it is never wrapped or dropped to a line of its own when it will not fit. So the label is
 * clamped to 40 characters in the renderer itself, not just by the HTML field's maxlength (see
 * bundletoolCover.js), and the geometry test below proves that bound actually holds rather than
 * assuming it does.
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
const BASE = { 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'ZC26C00123', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES', 'heading.author': 'A. Solicitor' };

test('an absent cover.preparedByLabel renders byte-for-byte the same as the stored default: "Prepared by:" exactly, no other draw call changes', () => {
  const before = run(BASE);
  const after = run({ ...BASE, 'cover.preparedByLabel': 'Prepared by:' });
  assert.deepEqual(before.texts, after.texts, 'an absent key and the explicit stored default draw identically');
  assert.deepEqual(before.lines, after.lines);
  const line = before.texts.find((t) => t.text.startsWith('Prepared by'));
  assert.equal(line.text, 'Prepared by: A. Solicitor');
});

test('an explicit empty label prints who prepared it with no label at all, a real and different choice from the default', () => {
  const { texts } = run({ ...BASE, 'cover.preparedByLabel': '' });
  assert.ok(texts.some((t) => t.text === 'A. Solicitor'), 'the bare value is drawn');
  assert.ok(!texts.some((t) => t.text.includes('Prepared')), 'no leftover label');
});

test('whitespace round the label is trimmed before it is drawn, so no double space appears', () => {
  const { texts } = run({ ...BASE, 'cover.preparedByLabel': '  Compiled by:  ' });
  const line = texts.find((t) => t.text.startsWith('Compiled by'));
  assert.equal(line.text, 'Compiled by: A. Solicitor');
});

test('a label over 40 characters is clamped in the renderer, not just relied on the HTML field to stop it', () => {
  const long = 'A'.repeat(60) + ':';
  const { texts } = run({ ...BASE, 'cover.preparedByLabel': long });
  const line = texts.find((t) => t.text.startsWith('A. Solicitor') === false && t.text.includes('A. Solicitor'));
  assert.equal(line.text.length, 40 + ' A. Solicitor'.length);
  assert.ok(line.text.startsWith('A'.repeat(40)), 'clamped to the first 40 characters of the label');
});

const LABELS = ['Prepared by:', 'Compiled by:', 'On behalf of:', 'On behalf of the Applicant, instructed by:'];
// The tightest combination measured (Two columns, A4, sans) holds with an author this long; the
// clamp above guarantees the label itself never needs more room than this leaves.
const AUTHORS = ['A. Solicitor', 'A. Solicitors, per A. Solicitor, senior associate'];

test('every label preset, and the longest realistic author, stay inside the margins in both designs, both fonts and both page sizes', () => {
  for (const label of LABELS) for (const author of AUTHORS) for (const layout of ['classic', 'grid'])
    for (const face of ['serif', 'sans']) for (const size of ['a4', 'letter']) {
      const [W] = pageDimensions(size);
      const { texts, lines } = run({
        ...BASE, 'heading.author': author, 'cover.preparedByLabel': label, 'cover.layout': layout,
        'pageOptions.pageSize': size,
      }, { face });
      const ctx = `${JSON.stringify(label)}/${author.length} chars ${layout}/${face}/${size}`;
      assert.ok(texts.some((t) => t.text.includes(author)), `${ctx}: the value is drawn`);
      for (const t of texts) assert.ok(t.x >= MARGIN - 0.01 && t.x + t.w <= W - MARGIN + 0.01, `${ctx}: "${t.text}" inside the margins`);
      for (const l of lines) assert.ok(l.x0 >= MARGIN - 0.01 && l.x1 <= W - MARGIN + 0.01, `${ctx}: a rule inside the margins`);
    }
});

test('the label sits on the prepared-by line, right-aligned in the two-column design and left-aligned in the stacked design', () => {
  const grid = run({ ...BASE, 'cover.preparedByLabel': 'Compiled by:', 'cover.layout': 'grid' });
  const classic = run({ ...BASE, 'cover.preparedByLabel': 'Compiled by:', 'cover.layout': 'classic' });
  const [W] = pageDimensions('a4');
  const g = grid.texts.find((t) => t.text.startsWith('Compiled by'));
  const c = classic.texts.find((t) => t.text.startsWith('Compiled by'));
  assert.ok(Math.abs(g.x + g.w - (W - MARGIN)) < 0.01, 'two-column: right-aligned to the margin');
  assert.equal(c.x, MARGIN, 'stacked: left-aligned to the margin');
});
