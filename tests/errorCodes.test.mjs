/**
 * BundleTool's error codes (public/js/frontend/errorCodes.js): every error a person can see carries a code from the
 * registry, each code is raised from one place, and the codes never change meaning. A static scan of the scripts and
 * templates (errorCodeScan.mjs), like the other guard tests, so a new notice is checked without anyone listing it.
 * The mutation checks below plant each kind of mistake and expect the scan to name it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProduct, sourceFiles } from './errorCodeScan.mjs';
import { ERROR_CODES, RETIRED_CODES, shownCode, describeCode } from '../public/js/frontend/errorCodes.js';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'public/js/frontend/errorCodes.js';
const registryText = fs.readFileSync(path.join(tool, REGISTRY), 'utf8');

/** The calls that show a notice, and how each takes its code. */
const SINKS = [
  { name: 'showErrorModal', pattern: /\bshowErrorModal\s*\(/g, arg: 'object' },
  { name: 'showUploadWarningModal', pattern: /\bshowUploadWarningModal\s*\(/g, arg: 'object', allowNull: true },
  { name: 'warnFn', pattern: /\bwarnFn\s*\(/g, arg: 'object', allowNull: true },
  { name: 'showPageNotice', pattern: /\bshowPageNotice\s*\(/g, arg: 'object', allowNull: true },
  { name: 'showSettingsNotice', pattern: /\bshowSettingsNotice\s*\(/g, arg: 'object', allowNull: true },
  { name: 'refuse', pattern: /\brefuse\s*\(/g, arg: 'first' },
  { name: 'refuseIt', pattern: /\brefuseIt\s*\(/g, arg: 'first' },
  { name: 'cfBugReport.report', pattern: /\bcfBugReport\??\.report\s*\(/g, arg: 'object' },
];

const scripts = sourceFiles(tool, ['public/js'], ['.js', '.mjs'], (rel) => rel === REGISTRY || rel.startsWith('public/js/workers/') || rel.endsWith('pdfjs.worker.mjs'));
const templates = sourceFiles(tool, ['layouts'], ['.html']);
const product = (overrides = {}) => ({
  prefix: 'BT',
  registry: { text: registryText, codes: ERROR_CODES, retired: [...RETIRED_CODES] },
  scripts, templates, sinks: SINKS, ...overrides,
});

test('the scan reads the real source: it finds the sinks and most of the codes', () => {
  assert.ok(scripts.length > 60, `${scripts.length} scripts`);
  assert.ok(scripts.some(([f]) => f === 'public/js/frontend/modals.js'));
  assert.ok(Object.keys(ERROR_CODES).length >= 80, `${Object.keys(ERROR_CODES).length} codes`);
});

test('every notice carries a registered code, each code is raised in one place, and none is left over', () => {
  const { problems } = checkProduct(product());
  assert.deepEqual(problems, []);
});

test('shownCode shows only a registered code: never a file name, a message or a made-up code', () => {
  assert.equal(shownCode('BT-ADD-01'), 'BT-ADD-01');
  for (const bad of ['BT-ADD-99', 'letter.pdf', 'BT-ADD-01 letter.pdf', 'bt-add-01', '', null, undefined, 42, { toString: () => 'BT-ADD-01' }]) {
    assert.equal(shownCode(bad), '', String(bad));
  }
  assert.match(describeCode('BT-OCR-02'), /Force OCR/);
  assert.equal(describeCode('nope'), '');
});

test('the README lists every code with its meaning, in the registry\'s order', () => {
  const readme = fs.readFileSync(path.join(tool, 'README.md'), 'utf8');
  const block = /<!-- error-codes -->\n([\s\S]*?)<!-- \/error-codes -->/.exec(readme);
  assert.ok(block, 'README.md has the error-codes table');
  const rows = [...block[1].matchAll(/^\| `(BT-[A-Z]+-\d{2})` \| (.*) \|$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, Object.entries(ERROR_CODES).filter(([code]) => !RETIRED_CODES.includes(code)),
    'README.md\'s table is out of date: node --import ./tests/register-hooks.mjs tests/errorCodes.test.mjs --print-table prints it');
});

// ── Mutation checks: each kind of mistake is named ──────────────────────────────

/** The product with one script's text changed (or a new script added). */
const withScript = (file, edit) => {
  const list = scripts.map(([f, t]) => [f, f === file ? edit(t) : t]);
  if (!scripts.some(([f]) => f === file)) list.push([file, edit('')]);
  return product({ scripts: list });
};

test('MUTATION: an error box with no code is caught', () => {
  const { problems } = checkProduct(withScript('planted/notice.js', () => "showErrorModal({ title: 'Oops', message: 'It broke.' });\n"));
  assert.deepEqual(problems, [
    'planted/notice.js:1: showErrorModal without a code',
    'planted/notice.js:1: a notice (title and message) without a code',
  ]);
});

test('MUTATION: an error box with code null is caught; a warning may say null on purpose', () => {
  const planted = "showErrorModal({ code: null, title: 'Oops' });\nshowUploadWarningModal({ code: null, title: 'Only so you know' });\n";
  const { problems } = checkProduct(withScript('planted/notice.js', () => planted));
  assert.deepEqual(problems, ['planted/notice.js:1: showErrorModal must carry a code, not null']);
});

test('MUTATION: a code given out twice is caught, naming both places', () => {
  const { problems } = checkProduct(withScript('planted/notice.js', () => "showErrorModal({ code: 'BT-ADD-01', title: 'Again' });\n"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^BT-ADD-01 is raised in 2 places \(.*public\/js\/frontend\/fileProcessing\.js:\d+.*planted\/notice\.js:1\)/);
});

test('MUTATION: a code missing from the registry is caught, and so is a misshapen one', () => {
  const planted = "showErrorModal({ code: 'BT-ADD-99', title: 'New' });\nshowErrorModal({ code: 'BT-add-1', title: 'Odd' });\n";
  const { problems } = checkProduct(withScript('planted/notice.js', () => planted));
  assert.ok(problems.includes('planted/notice.js:1: BT-ADD-99 is not in the registry'), problems.join('\n'));
  assert.ok(problems.includes("planted/notice.js:2: showErrorModal is given 'BT-add-1', which is not a code"), problems.join('\n'));
});

test('MUTATION: a duplicate key in the registry is caught even though the object keeps only one', () => {
  const doubled = registryText.replace("  'BT-ADD-02':", "  'BT-ADD-01': 'Something else entirely.',\n  'BT-ADD-02':");
  const { problems } = checkProduct(product({ registry: { text: doubled, codes: ERROR_CODES, retired: [] } }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^registry: BT-ADD-01 is listed twice/);
});

test('MUTATION: a registered code that nothing raises is caught unless it is retired', () => {
  const extra = { ...ERROR_CODES, 'BT-ADD-98': 'Planted.' };
  const text = registryText.replace("  'BT-ADD-02':", "  'BT-ADD-98': 'Planted.',\n  'BT-ADD-02':");
  assert.deepEqual(checkProduct(product({ registry: { text, codes: extra, retired: [] } })).problems,
    ['BT-ADD-98 is in the registry but raised nowhere: retire it rather than leave it']);
  assert.deepEqual(checkProduct(product({ registry: { text, codes: extra, retired: ['BT-ADD-98'] } })).problems, []);
});

test('MUTATION: a notice described for later (title and message) without a code is caught', () => {
  const planted = "export const tooBig = () => ({ kind: 'warning', title: 'Too big', message: 'It is too big.' });\n";
  const { problems } = checkProduct(withScript('planted/notice.js', () => planted));
  assert.deepEqual(problems, ['planted/notice.js:1: a notice (title and message) without a code']);
});

test('MUTATION: the shared reporter called without a code is caught', () => {
  const { problems } = checkProduct(withScript('planted/notice.js', () => "window.cfBugReport?.report({ error: e, title: 'Preview failed' });\n"));
  assert.deepEqual(problems, ['planted/notice.js:1: cfBugReport.report without a code']);
});

test('MUTATION: a code in a comment is not counted, and a code in a string or template is', () => {
  const planted = "// showErrorModal({ code: 'BT-ADD-97' })\nconst t = `Error code ${x ? 'BT-ADD-96' : ''}`;\n";
  const { problems } = checkProduct(withScript('planted/notice.js', () => planted));
  assert.deepEqual(problems, ['planted/notice.js:2: BT-ADD-96 is not in the registry']);
});

if (process.argv.includes('--print-table')) {
  console.log(['| Code | Meaning |', '| --- | --- |', ...Object.entries(ERROR_CODES).filter(([c]) => !RETIRED_CODES.includes(c)).map(([c, m]) => `| \`${c}\` | ${m} |`)].join('\n'));
}
