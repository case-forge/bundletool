/**
 * cover.partyJoiner: the word joining the two parties on the classic design's "BETWEEN:" block,
 * freely overridable the same way cover.caseNumberLabel and cover.preparedByLabel are.
 * "-and-" is the stored default, checked against a real judiciary.uk High Court directions
 * template ("BETWEEN: [Claimant] Claimant -and- [Defendant] Defendant", the standard civil and
 * family joiner; criminal matters use "R v [Defendant]" instead of a BETWEEN heading, which this
 * tool never draws). "-v-" is the usual alternative. A caller that never sets partyJoiner (an
 * absent key in cv, not just a falsy one) must render byte-for-byte the same as one that sets the
 * default explicitly. layoutCover() runs against a page that records every drawText and drawLine
 * call, the same harness as coverCaseNumberLabel.test.mjs and coverPreparedByLabel.test.mjs.
 *
 * Unlike the case number, the joiner is never concatenated with another value: it is drawn alone
 * on its own line, at the classic design's full margin-to-margin width, and never dropped to a
 * line of its own the way the case number can be (it has no "own line" to drop to). So it shares
 * preparedByLabel's 40-character renderer clamp, not caseNumberLabel's 60, and the geometry test
 * below proves that bound actually holds rather than assuming it does.
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
const BASE = { 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'ZC26C00123', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES', 'cover.layout': 'classic' };

test('an absent cover.partyJoiner renders byte-for-byte the same as the stored default: "-and-" exactly, no other draw call changes', () => {
  const before = run(BASE);
  const after = run({ ...BASE, 'cover.partyJoiner': '-and-' });
  assert.deepEqual(before.texts, after.texts, 'an absent key and the explicit stored default draw identically');
  assert.deepEqual(before.lines, after.lines);
  assert.ok(before.texts.some((t) => t.text === '-and-'), 'the default joiner is drawn');
});

test('an explicit empty joiner draws just the gap: both parties still appear, with no leftover word between them', () => {
  const { texts } = run({ ...BASE, 'cover.partyJoiner': '' });
  assert.ok(texts.some((t) => t.text === 'A SMITH'), 'the applicant is drawn');
  assert.ok(texts.some((t) => t.text === 'B JONES'), 'the respondent is drawn');
  assert.ok(!texts.some((t) => t.text === '-and-'), 'no leftover default word');
  assert.ok(!texts.some((t) => t.text.trim() === ''), 'no blank text call either: the gap is spacing, not an empty draw');
});

test('whitespace round the joiner is trimmed before it is drawn', () => {
  const { texts } = run({ ...BASE, 'cover.partyJoiner': '  -v-  ' });
  assert.ok(texts.some((t) => t.text === '-v-'));
});

test('a joiner over 40 characters is clamped in the renderer, not just relied on the HTML field to stop it', () => {
  const long = 'AND FURTHERMORE BETWEEN THE SAID PARTIES HERETO AND THEREAFTER';
  const { texts } = run({ ...BASE, 'cover.partyJoiner': long });
  const line = texts.find((t) => t.text.startsWith('AND FURTHERMORE'));
  assert.equal(line.text.length, 40, 'clamped to 40 characters');
  assert.equal(line.text, long.slice(0, 40));
});

test('only one side present draws no joiner at all', () => {
  const oneSide = run({ ...BASE, 'cover.respondentName': '', 'cover.partyJoiner': '-v-' });
  assert.ok(!oneSide.texts.some((t) => t.text === '-v-'), 'nothing to join, so the joiner is never drawn');
});

test('the two-column design never draws a joiner, whatever the setting is: it has no gap for one to sit in', () => {
  const { texts } = run({ ...BASE, 'cover.layout': 'grid', 'cover.partyJoiner': '-v-' });
  assert.ok(!texts.some((t) => t.text === '-v-'), 'grid layout ignores partyJoiner entirely');
});

const JOINERS = ['-and-', '-v-', 'AND', 'A LONGER CUSTOM JOINING PHRASE SOMEONE TYPED'];
const NAMES = ['A SMITH', 'THE APPLICANT WITH A VERY LONG NAME INDEED FOR TESTING PURPOSES'];

test('every joiner preset, and long custom wording, with long party names, stay inside the margins in the classic design, both fonts and both page sizes, at every party position', () => {
  for (const joiner of JOINERS) for (const name of NAMES) for (const align of ['left', 'centre', 'right'])
    for (const face of ['serif', 'sans']) for (const size of ['a4', 'letter']) {
      const [W] = pageDimensions(size);
      const { texts, lines } = run({
        ...BASE, 'cover.applicantName': name, 'cover.respondentName': name, 'cover.partyJoiner': joiner,
        'cover.partyAlign': align, 'pageOptions.pageSize': size,
      }, { face });
      const ctx = `${JSON.stringify(joiner)}/${name.length} chars/${align}/${face}/${size}`;
      assert.ok(texts.some((t) => t.text === name), `${ctx}: the name is drawn`);
      for (const t of texts) assert.ok(t.x >= MARGIN - 0.01 && t.x + t.w <= W - MARGIN + 0.01, `${ctx}: "${t.text}" inside the margins`);
      for (const l of lines) assert.ok(l.x0 >= MARGIN - 0.01 && l.x1 <= W - MARGIN + 0.01, `${ctx}: a rule inside the margins`);
    }
});

test('the joiner follows Party Position, same as the party names beside it', () => {
  const [W] = pageDimensions('a4');
  for (const [align, expect] of [['left', MARGIN], ['right', null], ['centre', null]]) {
    const { texts } = run({ ...BASE, 'cover.partyJoiner': '-v-', 'cover.partyAlign': align });
    const joiner = texts.find((t) => t.text === '-v-');
    if (align === 'left') assert.equal(joiner.x, MARGIN, 'left-aligned to the margin');
    else if (align === 'right') assert.ok(Math.abs(joiner.x + joiner.w - (W - MARGIN)) < 0.01, 'right-aligned to the margin');
    else assert.ok(joiner.x > MARGIN && joiner.x + joiner.w < W - MARGIN, 'centred, touching neither margin');
  }
});
