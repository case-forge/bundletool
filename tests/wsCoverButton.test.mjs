/**
 * wsCover.js: the "Add a witness statement cover page" button on a section's own header row.
 * filenameFromTitle() is the one pure function in it; the rest is DOM wiring (a modal, a file
 * insertion through the same path a drop uses), checked in a real browser instead, the same
 * split the codebase draws elsewhere between pure logic and DOM-heavy interaction.
 *
 * The cover-drawing side of this feature (only the title changing, everything else drawing
 * exactly as the real cover does) follows coverCaseNumberLabel.test.mjs's pattern; this file
 * adds the one case specific to this feature: overriding cover.bundleTitle
 * alone, with a court, case number and parties already set, changes only the title draw calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filenameFromTitle } from '../public/js/frontend/wsCover.js';
import { PDFDocument, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { getFontSettings } from '../public/js/bundletoolFontSettings.js';
import { layoutCover } from '../public/js/bundletoolCover.js';

test('the title box suggests "First witness statement of the Applicant", and nothing supplies the Respondent wording', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  const box = /<input[^>]*id="ws-cover-title-input"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(box, /placeholder="First witness statement of the Applicant"/);
  const js = fs.readFileSync(new URL('../public/js/frontend/wsCover.js', import.meta.url), 'utf8');
  for (const text of [html, js]) assert.doesNotMatch(text, /witness statement of the Respondent/i);
});

test('filenameFromTitle: a plain title becomes a plain .pdf name', () => {
  assert.equal(filenameFromTitle('First witness statement of the Applicant'), 'First witness statement of the Applicant.pdf');
});

test('filenameFromTitle: path separators and the other Windows-reserved characters are stripped, not left to break a stored filename', () => {
  assert.equal(filenameFromTitle('Statement: "Jones" / Reply (2nd)'), 'Statement Jones Reply (2nd).pdf');
});

test('filenameFromTitle: repeated or leading/trailing whitespace left over from stripping collapses cleanly', () => {
  assert.equal(filenameFromTitle('  A   /   B  '), 'A B.pdf');
});

test('filenameFromTitle: a title that strips down to nothing falls back to a sensible name rather than an empty one', () => {
  assert.equal(filenameFromTitle('///'), 'Witness statement.pdf');
});

async function loadFonts(face) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const s = getFontSettings(face);
  const get = async (url) => doc.embedFont(await fetch(url).then((r) => r.arrayBuffer()), { subset: false });
  return { regular: await get(s.regular.url), bold: await get(s.bold.url) };
}
const FONTS = { serif: await loadFonts('serif') };

function run(cv) {
  const texts = []; const lines = [];
  const page = {
    drawText: (text, o) => texts.push({ text, x: o.x, y: o.y, size: o.size }),
    drawLine: (o) => lines.push({ y: o.start.y }),
  };
  layoutCover({ 'index.fontFace': 'serif', 'pageOptions.pageSize': 'a4', 'heading.bundleTitle': 'Bundle for Hearing on 14.03.26', ...cv }, FONTS.serif, 1, page);
  return { texts, lines };
}
const BASE = {
  'cover.courtName': 'IN THE FAMILY COURT AT LONDON', 'heading.claimNumber': 'ZC26C00123',
  'cover.applicantName': 'A SMITH', 'cover.respondentName': 'B JONES', 'heading.author': 'A. Solicitor',
};

test('overriding cover.bundleTitle alone, the way the witness statement button does, changes only the title text: court, case number, parties and prepared by draw identically', () => {
  const before = run(BASE);
  const after = run({ ...BASE, 'cover.bundleTitle': 'FIRST WITNESS STATEMENT OF THE APPLICANT' });
  const titleBefore = before.texts.find((t) => t.text.includes('BUNDLE FOR HEARING'));
  const titleAfter = after.texts.find((t) => t.text.includes('WITNESS STATEMENT'));
  assert.ok(titleBefore && titleAfter, 'both draw a title line');
  const others = (r) => r.texts.filter((t) => !/BUNDLE FOR HEARING|WITNESS STATEMENT/.test(t.text));
  assert.deepEqual(others(before), others(after), 'every other line (court, case number, parties, prepared by) is unchanged');
  assert.deepEqual(before.lines, after.lines, 'the title rules move with the title exactly as they would for any other title');
});

test('overriding cover.bundleTitle with a blank court, case number and parties (a bundle nobody has configured yet) still draws a sensible one-page cover, not an error', () => {
  assert.doesNotThrow(() => run({ 'cover.bundleTitle': 'FIRST WITNESS STATEMENT OF THE APPLICANT', 'cover.courtName': '', 'heading.claimNumber': '', 'cover.applicantName': '', 'cover.respondentName': '', 'heading.author': '' }));
});
