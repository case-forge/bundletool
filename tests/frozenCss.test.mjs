/**
 * assets/css/bundletool.css is a frozen, hand-vendored Tailwind build (see its
 * own file header): a class used in markup gets no rule at all unless one
 * is written into it by hand. Such a class renders in the DOM with no
 * matching CSS rule anywhere, so the intended layout silently does not happen
 * (a `.grid-cols-3`, an `.object-contain` or an `.md:col-span-2`, for example).
 * This checks every class the templates use, not a list of known ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = path.join(repoRoot, 'assets', 'css', 'bundletool.css');
const css = fs.readFileSync(cssPath, 'utf8');

const templateFiles = [
  'layouts/partials/bundletool.html',
  'layouts/partials/header.html',
  'layouts/partials/footer.html',
  'layouts/_default/baseof.html',
  'layouts/_default/guide.html',
];

// Tailwind escapes ':' '.' '/' '%' '[' ']' '(' ')' etc with a backslash in the
// compiled selector; build the literal selector substring the same way.
function cssSelectorFor(cls) {
  return '.' + [...cls].map((ch) => (":./%[]()#,!@'".includes(ch) ? `\\${ch}` : ch)).join('');
}

// Real JS-hook/semantic classes that happen to contain a hyphen, so they'd
// otherwise look like an un-styled Tailwind utility to the heuristic below.
// None of these carry their own CSS rule by design: their look comes from a
// sibling class (bt-*) or plain element defaults. Adding a new one of these
// needs a deliberate addition here, which is the point: it forces a human to
// confirm "this one really doesn't need a rule" rather than the check just
// staying silent.
const KNOWN_HOOK_CLASSES = new Set([
  'add-section-btn', 'no-docs', 'pw-eye-open', 'pw-eye-shut',
  'sort-indicator', 'step-collapse', 'drawer-item',
  // Styled by the shared footer's own stylesheet, not this file: it is
  // the class the footer's extra slot uses to look like the shared links line.
  'cf-footer-links',
]);

function classesUsedIn(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) found.add(c);
  }
  return found;
}

test('every literal utility class used in a template has a matching rule in the frozen CSS', () => {
  const missing = [];
  for (const rel of templateFiles) {
    for (const cls of classesUsedIn(rel)) {
      if (cls.startsWith('bt-') || cls === 'hidden' || KNOWN_HOOK_CLASSES.has(cls)) continue;
      // Only check things that look like a real Tailwind utility token: a
      // '-' or a ':' (variant prefix), a signal with no false positives beyond
      // the hand-maintained hook-class list above.
      if (!cls.includes('-') && !cls.includes(':')) continue;
      if (!css.includes(cssSelectorFor(cls))) missing.push(`${rel}: ${cls}`);
    }
  }
  assert.deepEqual(missing, [], `class(es) with no matching rule in bundletool.css: add the rule to that file or, if this is a JS-only hook with no styling of its own, add it to KNOWN_HOOK_CLASSES above:\n${missing.join('\n')}`);
});
