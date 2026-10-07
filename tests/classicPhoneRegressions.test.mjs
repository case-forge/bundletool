/**
 * Classic dark on a phone, pinned at source level:
 * text-only sort headings that are keyboard buttons, Classic dark outlines and cards, no dead space under
 * the coversheet link, no sideways scroll range from the tap-area overhang, an accessible Remove button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('assets', 'css', 'bundletool.css');
const html = read('layouts', 'partials', 'bundletool.html');

/** Every declaration block of the rule(s) whose selector list contains `selector` exactly. */
function blocks(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) if (m[1].split(',').map((s) => s.trim().replace(/^.*\}\s*/, '')).includes(selector)) out.push(m[2]);
  return out;
}

test('phone sort headings have no pill fill or radius, and are 40px targets', () => {
  const rules = blocks('#file-table thead th');
  assert.ok(rules.length >= 2, 'both copies of the phone rule exist');
  for (const body of rules.filter((b) => b.includes('inline-flex'))) {
    assert.doesNotMatch(body, /background/, 'no fill');
    assert.doesNotMatch(body, /999px/, 'no pill radius');
    assert.match(body, /min-height:\s*40px/);
  }
  assert.doesNotMatch(css, /var\(--cf-field, #eef1f6\)/, 'no fallback that would show a pale pill in Classic dark');
});

test('the sort headings are keyboard buttons and the sorted one says so', () => {
  assert.equal((html.match(/tabindex="0" data-sort-col=/g) || []).length, 4);
  const js = read('public', 'js', 'frontend.js');
  assert.match(js, /setAttribute\('aria-sort'/);
  assert.match(js, /removeAttribute\('aria-sort'\)/);
  assert.match(js, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.match(css, /#file-table thead th\[data-sort-col\]:focus-visible\s*\{[^}]*outline/);
});

test('Classic dark keeps outlines: section boxes, file rows and the phone file cards use the slate scale', () => {
  assert.match(css, /\[data-palette=classic\]\[data-theme=dark\] \.section-label-input,\s*\n?\[data-palette=classic\]\[data-theme=dark\] \.section-name-input \{ border-color: var\(--color-slate-500\); \}/);
  assert.match(css, /\[data-palette=classic\]\[data-theme=dark\] #file-table tr\.file-row \{ border-color: var\(--color-slate-600\); \}/);
  assert.match(css, /\[data-palette=classic\]\[data-theme=dark\] #file-table \.section-tbody tr\.file-row \{ background: var\(--color-slate-800\)/);
});

test('an empty coversheet status line takes no room and leaves no flex gap', () => {
  assert.match(css, /#coversheet-section:not\(:has\(#coversheet-filename:not\(\.hidden\)\)\) \{ display: none; \}/);
});

test('the phone review table cannot scroll sideways from the tap-area overhang', () => {
  assert.match(css, /@media \(max-width: 767px\) \{\s*#file-table-content \{ overflow-x: clip; \}/);
});

test('the cover name is cut with an ellipsis and a full-name tooltip; Remove says which cover it removes', () => {
  assert.match(css, /#coversheet-section #coversheet-filename \{[^}]*text-overflow: ellipsis/);
  const js = read('public', 'js', 'frontend', 'coversheet.js');
  assert.match(js, /coversheetFilename\.title = label/);
  assert.match(js, /`Remove cover page \$\{label\}`/);
  assert.match(css, /#coversheet-clear-btn::after \{ content: ""; position: absolute; inset: -12px -8px; \}/);
});
