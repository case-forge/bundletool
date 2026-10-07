/**
 * BundleTool has one accent per palette and theme (--color-accent-*, read through the --bt-ink,
 * --bt-fill, --bt-tint and --bt-line-soft tokens at the end of assets/css/bundletool.css). A raw
 * Tailwind blue anywhere would break that: a link or "On" label shade that differs from the
 * toggle beside it, a navy label on a slate background in Classic dark, a hex blue on a section
 * row, or a JS-built row that names a blue utility. Nothing in the templates, the scripts or the
 * stylesheet may name a Tailwind blue: a control takes a semantic class (bt-link, bt-ink,
 * bt-hover-tint, bt-accent and so on) instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

// A blue utility (text-blue-600, dark:hover:bg-blue-950, ring-blue-500, accent-blue-500 ...), a
// blue scale variable, or one of the raw Tailwind blues and their pale and dark companions.
const BLUE_UTILITY = /\b[a-z][a-z0-9:-]*-blue-\d{2,3}\b|\bblue-\d{2,3}\b/;
const BLUE_VARIABLE = /--color-blue-/;
const RAW_BLUES = /#(?:3b82f6|2563eb|1d4ed8|1e40af|1e3a8a|60a5fa|93c5fd|bfdbfe|dbeafe|eff6ff|e0f2fe|172554|93b8e8|35507a|172033)\b/i;

function offenders(file, text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const re of [BLUE_UTILITY, BLUE_VARIABLE, RAW_BLUES]) {
      const m = line.match(re);
      if (m) found.push(`${path.relative(root, file)}:${i + 1} ${m[0]}`);
    }
  });
  return found;
}

test('no Tailwind blue in the BundleTool templates or scripts', () => {
  const files = [
    ...walk(path.join(root, 'layouts'), ['.html']),
    ...walk(path.join(root, 'public', 'js'), ['.js']),
  ];
  assert.ok(files.length > 10, 'the scan found the templates and scripts');
  const found = files.flatMap((f) => offenders(f, fs.readFileSync(f, 'utf8')));
  assert.deepEqual(found, [], `name the accent tokens or a semantic class, not a blue:\n${found.join('\n')}`);
});

test('no Tailwind blue in the BundleTool stylesheet, outside comments', () => {
  const file = path.join(root, 'assets', 'css', 'bundletool.css');
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));
  const found = offenders(file, css);
  assert.deepEqual(found, [], `use --bt-ink, --bt-fill, --bt-tint or --bt-line-soft:\n${found.join('\n')}`);
});

test('the accent tokens exist for every palette and theme', () => {
  const css = fs.readFileSync(path.join(root, 'assets', 'css', 'bundletool.css'), 'utf8');
  for (const token of ['--bt-ink', '--bt-ink-hover', '--bt-fill', '--bt-fill-hover', '--bt-tint', '--bt-line-soft']) {
    assert.match(css, new RegExp(`${token}:`), `${token} is defined`);
  }
  assert.match(css, /\[data-theme=dark\]\s*\{[^}]*--bt-ink:/, 'dark takes the lighter ink');
  assert.match(css, /\[data-palette=classic\]\[data-theme=dark\]\s*\{\s*--bt-ink:\s*#6ea6d6/, 'Classic dark keeps its legible light blue');
});
