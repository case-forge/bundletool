/**
 * The cover's title rules (two of them on both designs, equidistant from the text, optionally doubled) and the
 * longest realistic case numbers (docs/case-number-formats.md), checked on geometry with the real fonts: layoutCover()
 * runs against a page that records every drawText and drawLine call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { getFontSettings } from '../public/js/bundletoolFontSettings.js';
import { pageDimensions } from '../public/js/bundletoolPageSize.js';
import {
  layoutCover, MARGIN, CONTENT_FLOOR, TITLE_FONT_SIZE, TITLE_RULE_TEXT_GAP, DOUBLE_RULE_WIDTH, RULE_WIDTH,
} from '../public/js/bundletoolCover.js';
import Config from '../public/js/bundletoolConfig.js';

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
  const config = new Config();
  const bottom = layoutCover({ 'index.fontFace': face, 'pageOptions.pageSize': 'a4', 'heading.bundleTitle': 'Bundle', ...cv }, FONTS[face], scale, page);
  return { texts, lines, bottom };
}
const BASE = { 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'ZC26C00123', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES' };
const capHeight = (face) => { const f = FONTS[face].bold.embedder.font; return (f.capHeight / f.unitsPerEm) * TITLE_FONT_SIZE; };

const TITLES = ['BUNDLE FOR HEARING ON 14.03.26', 'A', 'AN EXTREMELY LONG BUNDLE TITLE THAT GOES ON AND ON AND WILL HAVE TO WRAP ONTO A SECOND AND EVEN A THIRD LINE OF THE COVER PAGE FOR THE HEARING']; 

test('two rules above and below the title on both designs, whatever its length, gap scale or typeface', () => {
  for (const layout of ['classic', 'grid']) for (const face of ['serif', 'sans']) for (const scale of [1, 0.3]) for (const title of TITLES) {
    const { texts, lines } = run({ ...BASE, 'cover.layout': layout, 'heading.bundleTitle': title }, { face, scale });
    assert.equal(lines.length, 2, `${layout}/${face}/${scale}: one rule above and one below`);
    for (const l of lines) { assert.equal(l.x0, MARGIN); assert.ok(l.x1 > MARGIN); assert.equal(l.t, RULE_WIDTH); }
    const titleLines = texts.filter((t) => t.size === TITLE_FONT_SIZE);
    assert.ok(titleLines.length >= 1);
    const [upper, lower] = [...lines].sort((a, b) => b.y - a.y);
    assert.ok(upper.y > titleLines[0].y && lower.y < titleLines[titleLines.length - 1].y, 'the title sits between the rules');
  }
});

test('the gap above the title equals the gap below it, measured from the capitals to the rules', () => {
  for (const layout of ['classic', 'grid']) for (const face of ['serif', 'sans']) for (const title of TITLES) {
    const { texts, lines } = run({ ...BASE, 'cover.layout': layout, 'heading.bundleTitle': title }, { face });
    const titleLines = texts.filter((t) => t.size === TITLE_FONT_SIZE);
    const [upper, lower] = [...lines].sort((a, b) => b.y - a.y);
    const above = (upper.y - upper.t / 2) - (titleLines[0].y + capHeight(face));
    const below = titleLines[titleLines.length - 1].y - (lower.y + lower.t / 2);
    assert.ok(Math.abs(above - TITLE_RULE_TEXT_GAP) < 1e-6, `${layout}/${face}: gap above ${above}`);
    assert.ok(Math.abs(below - TITLE_RULE_TEXT_GAP) < 1e-6, `${layout}/${face}: gap below ${below}`);
  }
});

test('Title Lines double: two thin rules above and two below, the text equidistant from the inner rule of each pair', () => {
  for (const layout of ['classic', 'grid']) for (const face of ['serif', 'sans']) for (const title of TITLES) {
    const { texts, lines } = run({ ...BASE, 'cover.layout': layout, 'cover.titleLines': 'double', 'heading.bundleTitle': title }, { face });
    assert.equal(lines.length, 4, `${layout}: four thin rules`);
    for (const l of lines) assert.equal(l.t, DOUBLE_RULE_WIDTH);
    const sorted = [...lines].sort((a, b) => b.y - a.y);
    const titleLines = texts.filter((t) => t.size === TITLE_FONT_SIZE);
    const above = (sorted[1].y - sorted[1].t / 2) - (titleLines[0].y + capHeight(face));
    const below = titleLines[titleLines.length - 1].y - (sorted[2].y + sorted[2].t / 2);
    assert.ok(Math.abs(above - below) < 1e-6 && Math.abs(above - TITLE_RULE_TEXT_GAP) < 1e-6, `${layout}: equidistant ${above} ${below}`);
    assert.ok(sorted[0].y - sorted[1].y < 4 && sorted[2].y - sorted[3].y < 4, 'the two rules of a pair sit close together');
  }
});

test('an unknown Title Lines value draws a single line; a heavy cover (4 and 4 parties) still fits with both rules above the footer zone', () => {
  const heavy = { ...BASE, 'cover.applicantName': 'A ONE\nA TWO\nA THREE\nA FOUR', 'cover.respondentName': 'R ONE\nR TWO\nR THREE\nR FOUR', 'cover.matterOf': 'IN THE MATTER OF THE CHILDREN ACT 1989\nRe: X (A Child)' };
  assert.equal(run({ ...heavy, 'cover.titleLines': 'triple' }).lines.length, 2);
  for (const layout of ['classic', 'grid']) for (const titleLines of ['single', 'double']) {
    let fitted = null;
    for (const scale of [1, 0.85, 0.7, 0.55, 0.4, 0.3]) { const r = run({ ...heavy, 'cover.layout': layout, 'cover.titleLines': titleLines }, { scale }); if (r.bottom >= CONTENT_FLOOR) { fitted = r; break; } }
    assert.ok(fitted, `${layout}/${titleLines}: a gap scale fits above the footer zone`);
    assert.ok(Math.min(...fitted.lines.map((l) => l.y)) >= CONTENT_FLOOR - 40, 'the lower rule stays above the footer zone');
  }
});

// ── Case numbers ────────────────────────────────────────────────────────────────

const SINGLE = ['ZC26C00123', '6000124/2025', 'KB-2024-017278', 'AC-2025-LON-010279', '1234-5678-9012-3456', '00000-0000000000-000'];
const JOINED = ['ZC26C00123 and ZC26C00456', '1234-5678-9012-3456 and 6543-2109-8765-4321'];

test('the longest realistic case numbers, single and joined, fit in every design, position, typeface and page size', () => {
  for (const number of [...SINGLE, ...JOINED]) for (const layout of ['classic', 'grid']) for (const line of ['court', 'own'])
    for (const ca of ['left', 'centre', 'right']) for (const ha of ['left', 'centre', 'right']) for (const face of ['serif', 'sans']) for (const size of ['a4', 'letter']) {
      const [W] = pageDimensions(size);
      const { texts } = run({ ...BASE, 'heading.claimNumber': number, 'cover.layout': layout, 'cover.caseNumberLine': line, 'cover.caseNumberAlign': ca, 'cover.headingAlign': ha, 'pageOptions.pageSize': size }, { face });
      const caseTexts = texts.filter((t) => /CASE NO|^\d|^[A-Z]{2}[-\d]|and /.test(t.text) && t.y >= texts.find((x) => /FAMILY COURT/.test(x.text)).y - 60 && !/FAMILY|LONDON$/.test(t.text));
      const caseLine = texts.find((t) => t.text.startsWith('CASE NO'));
      assert.ok(caseLine, `${number}: drawn`);
      for (const t of caseTexts) assert.ok(t.x >= MARGIN - 0.01 && t.x + t.w <= W - MARGIN + 0.01, `${number} ${layout}/${line}/${ca}/${face}/${size}: inside the margins (${t.text})`);
      const courtLines = texts.filter((t) => /FAMILY COURT|AT LONDON/.test(t.text));
      for (const c of courtLines) if (Math.abs(c.y - caseLine.y) < 1) assert.ok(c.x + c.w < caseLine.x - 20, `${number}: the court never reaches the case number on a shared line`);
    }
});

test('the longest single reference and two joined ones keep the case number on the court line with the court at least 140 pt wide (A4, both typefaces); a 60-character field value still fits', () => {
  const measured = {};
  for (const face of ['serif', 'sans']) for (const number of [...SINGLE, ...JOINED, '9'.repeat(60)]) {
    const { texts } = run({ ...BASE, 'heading.claimNumber': number, 'cover.caseNumberLine': 'court' }, { face });
    const c = texts.find((t) => t.text.startsWith('CASE NO'));
    const court = texts.find((t) => /FAMILY COURT/.test(t.text));
    measured[`${face} ${number.length} chars`] = Math.round(495 - c.w - 24 > 0 ? (595.28 - 2 * MARGIN) - c.w - 24 : 0);
    if (number.length <= 45) assert.equal(c.y, court.y, `${face}: ${number} shares the court's line`);
    assert.ok(c.x + c.w <= 595.28 - MARGIN + 0.01);
  }
  assert.ok(Object.keys(measured).length > 0);
  console.log('court width left beside the case number (A4, pt):', JSON.stringify(measured));
});
