/**
 * Every dialog (role="dialog" in layouts/partials/bundletool.html) shares one Escape semantics:
 * bundletoolPage.js's MODAL_DISMISS map clicks the dialog's own safe exit button, so Escape never
 * means something different from dialog to dialog (see the comment above that map). A dialog left
 * out of the map has no Escape handling at all. This is a static scan, not a DOM test: it reads the
 * HTML and the JS as text, so it catches a new dialog whether or not anyone remembers to wire it by
 * hand.
 *
 * A dialog that deliberately has no MODAL_DISMISS entry is listed in KNOWN_EXCEPTIONS with the
 * reason, not silently absent: "absent" and "an intentional exception" must look different to this
 * test.
 *
 * The scan also covers three ways a check like this could pass when it should not, each with a
 * mutation test below: tag and attribute order (role="dialog" on a non-div, or id after role), a
 * mistyped dismiss-target id that names no real element in the HTML, and a content-safety gate
 * (redaction-modal and anything shaped like it) mapped to its WRONG button, the "keep it,
 * unchecked" one instead of the "exclude it" one.
 *
 * Known gap: CONTENT_SAFETY_EXCLUDE pins only the four gates listed. A native `<dialog>` element, or
 * a new content-safety gate not added to that map, is still caught by the general "is it covered at
 * all" check, just not pinned to its specific safe button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Two real dialogs with their own Escape handling OUTSIDE MODAL_DISMISS, each for a stated reason,
// not an oversight.
const KNOWN_EXCEPTIONS = {
  'processing-overlay': 'a build in flight has a Cancel button with consequences Escape should not trigger by accident (see the comment above MODAL_DISMISS)',
  'ws-cover-modal': 'has its own local keydown Escape handler in public/js/frontend/wsCover.js, not routed through MODAL_DISMISS',
};

// Content-safety gates: two meaningfully different answers, one of which leaves something
// unchecked in the bundle. Escape must always take the side that excludes it, pinned to the
// EXACT button id, not just "some button is mapped", so remapping to the wrong one still fails.
const CONTENT_SAFETY_EXCLUDE = {
  'redaction-modal': 'redaction-remove',       // "Leave it in" keeps unredacted text readable
  'damaged-file-modal': 'damaged-file-skip',   // "Include" keeps an unverified recovery
  'bundle-detected-modal': 'bundle-detected-skip',
  'pdf-password-modal': 'pdf-password-skip',   // the alternative is an undecrypted file
};

/** Every opening tag in `text`, as its raw attribute text (order-independent). */
function openTags(text) {
  return text.match(/<[a-zA-Z][a-zA-Z0-9]*\s[^>]*>/g) || [];
}

function hasAttr(tag, name, value) {
  const re = new RegExp(`\\b${name}="${value}"`);
  return re.test(tag);
}

/** Every id="..." on a role="dialog" element, any tag name, attributes in any order. */
function dialogIdsInHtml(text) {
  const ids = [];
  for (const tag of openTags(text)) {
    if (!hasAttr(tag, 'role', 'dialog')) continue;
    const m = tag.match(/\bid="([a-z0-9-]+)"/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** Every id="..." on any element at all: the universe a dismiss-target id must be drawn from. */
function allIdsInHtml(text) {
  const ids = new Set();
  for (const tag of openTags(text)) {
    const m = tag.match(/\bid="([a-z0-9-]+)"/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function modalDismissEntries(text) {
  const start = text.indexOf('MODAL_DISMISS = {');
  assert.ok(start !== -1, 'MODAL_DISMISS object literal not found in bundletoolPage.js: did it move or get renamed?');
  const end = text.indexOf('};', start);
  const body = text.slice(start, end);
  const entries = {};
  const re = /'([a-z0-9-]+)':\s*'([a-z0-9-]+)'/g;
  let m;
  while ((m = re.exec(body))) entries[m[1]] = m[2];
  return entries;
}

function check(html, pageJs) {
  const dialogIds = dialogIdsInHtml(html);
  const elementIds = allIdsInHtml(html);
  const entries = modalDismissEntries(pageJs);
  const dismissKeys = new Set(Object.keys(entries));

  const uncovered = dialogIds.filter((id) => !dismissKeys.has(id) && !(id in KNOWN_EXCEPTIONS));
  const dialogIdSet = new Set(dialogIds);
  const stale = [...dismissKeys].filter((k) => !dialogIdSet.has(k));
  const danglingTarget = Object.entries(entries).filter(([, target]) => !elementIds.has(target));
  const wrongSafeButton = Object.entries(CONTENT_SAFETY_EXCLUDE)
    .filter(([modalId]) => dismissKeys.has(modalId))
    .filter(([modalId, required]) => entries[modalId] !== required)
    .map(([modalId]) => [modalId, entries[modalId]]);

  return { uncovered, stale, danglingTarget, wrongSafeButton };
}

test('every dialog is in MODAL_DISMISS or a stated KNOWN_EXCEPTIONS reason', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const { uncovered, stale, danglingTarget, wrongSafeButton } = check(html, pageJs);

  const dialogCount = dialogIdsInHtml(html).length;
  assert.ok(dialogCount > 20, `expected to find BundleTool's real dialog count, found ${dialogCount}: did the HTML move?`);

  assert.deepEqual(uncovered, [], `dialog(s) with no Escape handling and no stated exception: ${uncovered.join(', ')}`);

  // An entry for an id that is not in the HTML is dead weight that looks like coverage but covers
  // nothing.
  assert.deepEqual(stale, [], `MODAL_DISMISS entr(y/ies) naming a dialog id not found in the HTML: ${stale.map(String).join(', ')}`);

  // A dismiss target that is not a real element id: Escape would click nothing at runtime, silently.
  assert.deepEqual(danglingTarget, [], `MODAL_DISMISS entr(y/ies) pointing at an id that does not exist anywhere in the HTML: ${danglingTarget.map(([k, v]) => `${k} -> ${v}`).join(', ')}`);

  // A content-safety gate mapped to its "keep the risky thing, unreviewed" button instead of its
  // exclude button: looks covered, does the wrong thing.
  assert.deepEqual(wrongSafeButton, [], `content-safety gate(s) mapped to the wrong button: ${wrongSafeButton.map(([k, v]) => `${k} -> ${v}`).join(', ')}`);
});

test('a dialog added without Escape coverage or a stated exception fails (mutation check)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const planted = html + '\n<div id="planted-test-modal" class="hidden" role="dialog" aria-modal="true"></div>\n';
  assert.deepEqual(check(planted, pageJs).uncovered, ['planted-test-modal'], 'planting an uncovered dialog should be exactly what this guard catches');
});

test('removing a real MODAL_DISMISS entry fails (mutation check)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const planted = pageJs.replace("'redaction-modal': 'redaction-remove',\n", '');
  assert.deepEqual(check(html, planted).uncovered, ['redaction-modal'], 'removing one real entry should surface exactly that one dialog as uncovered');
});

test('role="dialog" on a non-div, or with id after role, is still found (mutation check)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const planted = html + '\n<section role="dialog" aria-modal="true" id="planted-section-modal"></section>\n';
  assert.deepEqual(check(planted, pageJs).uncovered, ['planted-section-modal'], 'a dialog on a non-div tag, or with id after role, must still be caught');
});

test('a typo in a dismiss target id is caught (mutation check)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const planted = pageJs.replace("'redaction-modal': 'redaction-remove',", "'redaction-modal': 'redaction-remov',");
  const { danglingTarget } = check(html, planted);
  assert.deepEqual(danglingTarget, [['redaction-modal', 'redaction-remov']], 'a dismiss target that names no real element must be caught, not treated as coverage');
});

test('mapping a content-safety gate to its wrong (keep-it) button is caught (mutation check)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'layouts/partials/bundletool.html'), 'utf8');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public/js/bundletoolPage.js'), 'utf8');
  const planted = pageJs.replace("'redaction-modal': 'redaction-remove',", "'redaction-modal': 'redaction-keep',");
  const { wrongSafeButton } = check(html, planted);
  assert.deepEqual(wrongSafeButton, [['redaction-modal', 'redaction-keep']], 'mapping to the keep-it-unchecked button must be caught even though a mapping exists');
});
