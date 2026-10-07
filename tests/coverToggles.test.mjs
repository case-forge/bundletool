/**
 * The cover's three toggles (case number line, party label placement, party alignment) and the numbered
 * labels, checked on geometry alone: layoutCover() is run against a page that records every drawText call and
 * a font whose widths are fixed, so no PDF has to be rendered and nothing is skipped without poppler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCover, PAGE_WIDTH, MARGIN, wrapText } from '../public/js/bundletoolCover.js';
import Config, { validCoverCaseLines, validCoverLabelPlacements, validCoverPartyAligns } from '../public/js/bundletoolConfig.js';
import { sanitiseConfig } from '../public/js/frontend/configSanitise.js';

const font = { widthOfTextAtSize: (t, size) => String(t).length * size * 0.55 };
const fonts = { regular: font, bold: font };

function draw(cv, scale = 1) {
  const items = [];
  const page = { drawText: (text, o) => items.push({ text, x: o.x, y: o.y, w: font.widthOfTextAtSize(text, o.size), size: o.size }), drawLine: () => {} };
  layoutCover({ 'pageOptions.pageSize': 'a4', 'index.fontFace': 'serif', 'heading.bundleTitle': 'BUNDLE', ...cv }, fonts, scale, page);
  return items;
}
const find = (items, re) => items.filter((i) => re.test(i.text));
const one = (items, re) => { const hit = find(items, re); assert.equal(hit.length, 1, `${re} drawn ${hit.length} times: ${items.map((i) => i.text).join(' | ')}`); return hit[0]; };
const BASE = { 'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'AB12', 'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES' };

test('case number on the court line, or on a line of its own beneath it', () => {
  for (const layout of ['classic', 'grid']) {
    const court = one(draw({ ...BASE, 'cover.layout': layout, 'cover.caseNumberLine': 'court' }), /FAMILY COURT/);
    const same = one(draw({ ...BASE, 'cover.layout': layout, 'cover.caseNumberLine': 'court' }), /CASE NO/);
    assert.equal(same.y, court.y, `${layout}: same line`);
    assert.ok(same.x + same.w <= PAGE_WIDTH - MARGIN + 0.01, `${layout}: inside the right margin`);
    assert.ok(court.x + court.w < same.x, `${layout}: the court never reaches the case number`);
    const items = draw({ ...BASE, 'cover.layout': layout, 'cover.caseNumberLine': 'own' });
    const own = one(items, /CASE NO/);
    assert.ok(own.y < one(items, /FAMILY COURT/).y, `${layout}: beneath the court`);
    assert.ok(Math.abs(own.x + own.w - (PAGE_WIDTH - MARGIN)) < 0.01, `${layout}: on its own line it is at the right by default`);
  }
});

test('a long court name wraps narrower beside the case number, and a case number too long drops to its own line', () => {
  const long = 'IN THE FAMILY COURT SITTING AT THE ROYAL COURTS OF JUSTICE IN THE CITY OF WESTMINSTER AND CENTRAL LONDON AND ELSEWHERE';
  const items = draw({ ...BASE, 'cover.courtName': long, 'cover.caseNumberLine': 'court' });
  const caseNo = one(items, /CASE NO/);
  for (const c of items.filter((i) => Math.abs(i.y - caseNo.y) < 1 && i !== caseNo)) assert.ok(c.x + c.w < caseNo.x, 'no overlap on the first line');
  assert.ok(items.filter((i) => /FAMILY COURT|CENTRAL LONDON|ROYAL/.test(i.text)).length >= 2, 'the court wrapped');
  const huge = draw({ ...BASE, 'heading.claimNumber': 'X'.repeat(55), 'cover.caseNumberLine': 'court' });
  assert.ok(one(huge, /CASE NO/).y < one(huge, /FAMILY COURT/).y, 'a case number that leaves the court under 140pt goes below it');
});

test('party labels sit under the name, aligned as the name is, or on the name line at the far side', () => {
  for (const align of ['left', 'centre', 'right']) {
    const below = draw({ ...BASE, 'cover.layout': 'classic', 'cover.partyLabelPlacement': 'below', 'cover.partyAlign': align });
    const name = one(below, /A SMITH/); const label = one(below, /^APPLICANT$/);
    assert.ok(label.y < name.y, `${align}: label under the name`);
    const mid = (i) => i.x + i.w / 2;
    if (align === 'centre') assert.ok(Math.abs(mid(name) - mid(label)) < 0.5, 'centred label under a centred name');
    if (align === 'left') assert.equal(label.x, name.x);
    if (align === 'right') assert.ok(Math.abs((label.x + label.w) - (name.x + name.w)) < 0.01);
    const inline = draw({ ...BASE, 'cover.layout': 'classic', 'cover.partyLabelPlacement': 'inline', 'cover.partyAlign': align });
    const n2 = one(inline, /A SMITH/); const l2 = one(inline, /^APPLICANT$/);
    assert.equal(l2.y, n2.y, `${align}: label on the name line`);
    assert.ok(n2.x + n2.w < l2.x || l2.x + l2.w < n2.x, `${align}: name and label never touch`);
  }
});

test('the two-column design keeps applicants left and respondents right whatever the alignment says', () => {
  for (const placement of ['below', 'inline']) for (const align of ['left', 'centre', 'right']) {
    const items = draw({ ...BASE, 'cover.layout': 'grid', 'cover.partyLabelPlacement': placement, 'cover.partyAlign': align });
    const a = one(items, /A SMITH/); const r = one(items, /B JONES/);
    assert.equal(a.x, MARGIN);
    assert.ok(Math.abs(r.x + r.w - (PAGE_WIDTH - MARGIN)) < 0.01);
  }
});

test('more than one person on a side is numbered, up to four; one person is not', () => {
  const four = draw({ ...BASE, 'cover.applicantName': 'A\nB\nC\nD\nE', 'cover.respondentName': 'R' });
  assert.deepEqual(find(four, /APPLICANT/).map((i) => i.text), ['1ST APPLICANT', '2ND APPLICANT', '3RD APPLICANT', '4TH APPLICANT']);
  assert.deepEqual(find(four, /RESPONDENT/).map((i) => i.text), ['RESPONDENT']);
  const custom = draw({ ...BASE, 'cover.partyLabel1': 'Claimant', 'cover.applicantName': 'A\nB' });
  assert.ok(find(custom, /^1ST CLAIMANT$/).length === 1 && find(custom, /^2ND CLAIMANT$/).length === 1);
});

test('nothing overlaps or leaves the margins for very long names, in any combination', () => {
  const longName = 'MS ALEXANDRIA CONSTANTINOPLE-WORTHINGTON-SMYTHE OF THE VERY LONG NAMED FAMILY OF MANCHESTER AND ELSEWHERE';
  for (const layout of ['classic', 'grid']) for (const cn of validCoverCaseLines) for (const lp of validCoverLabelPlacements) for (const al of validCoverPartyAligns) for (const ha of validCoverPartyAligns) for (const ca of validCoverPartyAligns) for (const caseNo of ['ZC26C00123', 'X'.repeat(30), 'Y'.repeat(60)]) {
    const items = draw({ 'cover.headingAlign': ha, 'cover.caseNumberAlign': ca, 'cover.layout': layout, 'cover.caseNumberLine': cn, 'cover.partyLabelPlacement': lp, 'cover.partyAlign': al,
      'cover.courtName': longName, 'heading.claimNumber': caseNo, 'cover.matterOf': `IN THE MATTER OF THE CHILDREN ACT 1989 AND THE VERY LONG SECOND LINE OF THE SUBHEADING THAT MUST WRAP\nRe: X (A Child)`,
      'cover.applicantName': `${longName}\nMR C\nMR D\nMR E`, 'cover.respondentName': `${longName}\nMS F` }, 1);
    const tag = `${layout}/${cn}/${lp}/${al}/h${ha}/c${ca}/${caseNo.length}`;
    for (const i of items) assert.ok(i.x >= MARGIN - 0.01 && i.x + i.w <= PAGE_WIDTH - MARGIN + 0.01, `${tag}: "${i.text.slice(0, 20)}" inside the margins`);
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const p = items[a]; const q = items[b];
      if (Math.abs(p.y - q.y) < 6 && p.x < q.x + q.w - 0.01 && q.x < p.x + p.w - 0.01) assert.fail(`${tag}: "${p.text}" overlaps "${q.text}"`);
    }
  }
});

test('the defaults, the validators and the sanitiser agree on the three settings', () => {
  const c = new Config();
  assert.equal(c.getOption('cover.caseNumberLine'), 'court');
  assert.equal(c.getOption('cover.partyLabelPlacement'), 'inline', 'the compact cover is the default');
  assert.equal(c.getOption('cover.titleLines'), 'single');
  assert.equal(c.getOption('cover.partyAlign'), 'centre');
  c.validateOptions();
  c.updateOptions({ cover: { partyAlign: 'diagonal' } });
  assert.throws(() => c.validateOptions(), /party alignment/);
  assert.deepEqual(sanitiseConfig({ coverCaseLine: 'own', coverLabelPlacement: 'inline', coverPartyAlign: 'right' }),
    { coverCaseLine: 'own', coverLabelPlacement: 'inline', coverPartyAlign: 'right' });
  assert.deepEqual(sanitiseConfig({ coverCaseLine: 'sideways', coverLabelPlacement: 7, coverPartyAlign: 'center' }), {}, 'bad values are dropped');
});

test('case number position applies on its own line: left, centre or right, default right', () => {
  for (const [ca, check] of [['left', (o) => o.x === MARGIN], ['centre', (o) => Math.abs(o.x + o.w / 2 - PAGE_WIDTH / 2) < 0.01], ['right', (o) => Math.abs(o.x + o.w - (PAGE_WIDTH - MARGIN)) < 0.01]]) {
    for (const layout of ['classic', 'grid']) {
      const items = draw({ ...BASE, 'cover.layout': layout, 'cover.caseNumberLine': 'own', 'cover.caseNumberAlign': ca });
      assert.ok(check(one(items, /CASE NO/)), `${layout}/${ca}`);
    }
  }
  // Sharing the court line it stays at the right whatever the setting says.
  const shared = draw({ ...BASE, 'cover.caseNumberLine': 'court', 'cover.caseNumberAlign': 'left' });
  const s = one(shared, /CASE NO/);
  assert.ok(Math.abs(s.x + s.w - (PAGE_WIDTH - MARGIN)) < 0.01);
});

test('heading position aligns the court and every subheading line; the case number never meets the court', () => {
  const sub = { 'cover.matterOf': 'IN THE MATTER OF THE CHILDREN ACT 1989\nRe: X (A Child)' };
  for (const [ha, check] of [['left', (o) => o.x === MARGIN], ['centre', (o) => Math.abs(o.x + o.w / 2 - PAGE_WIDTH / 2) < 0.01], ['right', (o) => Math.abs(o.x + o.w - (PAGE_WIDTH - MARGIN)) < 0.01]]) {
    for (const layout of ['classic', 'grid']) {
      const items = draw({ ...BASE, ...sub, 'cover.layout': layout, 'cover.caseNumberLine': 'own', 'cover.headingAlign': ha });
      for (const re of [/FAMILY COURT/, /CHILDREN ACT/, /Re: X/]) assert.ok(check(one(items, re)), `${layout}/${ha}/${re}`);
    }
    // Sharing the line: the court is aligned inside the column left of the case number.
    const items = draw({ ...BASE, ...sub, 'cover.caseNumberLine': 'court', 'cover.headingAlign': ha });
    const court = one(items, /FAMILY COURT/); const caseNo = one(items, /CASE NO/);
    assert.equal(court.y, caseNo.y);
    assert.ok(court.x >= MARGIN - 0.01 && court.x + court.w <= caseNo.x - 24 + 0.01, `${ha}: court inside its column, 24pt clear of the case number`);
    if (ha === 'right') assert.ok(Math.abs(court.x + court.w - (caseNo.x - 24)) < 0.01);
    // The subheading lines keep the whole width.
    if (ha === 'right') assert.ok(Math.abs(one(items, /CHILDREN ACT/).x + one(items, /CHILDREN ACT/).w - (PAGE_WIDTH - MARGIN)) < 0.01);
  }
});

test('sharing the line needs 140pt for the court: exactly at the threshold it shares, one point under it drops', () => {
  const caseFor = (n) => `CASE NO: ${'X'.repeat(n)}`;
  const usable = PAGE_WIDTH - 2 * MARGIN;
  const width = (n) => font.widthOfTextAtSize(caseFor(n), 10);
  let n = 1; while (usable - width(n + 1) - 24 >= 140) n++;
  const fits = draw({ 'cover.courtName': 'COURT', 'heading.claimNumber': 'X'.repeat(n), 'cover.caseNumberLine': 'court' });
  assert.equal(one(fits, /COURT/).y, one(fits, /CASE NO/).y, `${n} characters still share`);
  const over = draw({ 'cover.courtName': 'COURT', 'heading.claimNumber': 'X'.repeat(n + 1), 'cover.caseNumberLine': 'court' });
  assert.ok(one(over, /CASE NO/).y < one(over, /COURT/).y, `${n + 1} characters drop to their own line`);
  assert.ok(wrapText('a b', font, 10, 100).length >= 1);
});

test('the case number and heading alignments have validated defaults and a sanitiser', () => {
  const c = new Config();
  assert.equal(c.getOption('cover.caseNumberAlign'), 'right');
  assert.equal(c.getOption('cover.headingAlign'), 'left');
  c.updateOptions({ cover: { headingAlign: 'middle' } });
  assert.throws(() => c.validateOptions(), /heading alignment/);
  assert.deepEqual(sanitiseConfig({ coverCaseAlign: 'left', coverHeadingAlign: 'right' }), { coverCaseAlign: 'left', coverHeadingAlign: 'right' });
  assert.deepEqual(sanitiseConfig({ coverCaseAlign: 'top', coverHeadingAlign: 3 }), {});
});
