/**
 * `hidden` must hide. bundletool.css keeps Tailwind's `.hidden{display:none}` inside a cascade layer, and its own
 * component rules (`.bt-rotate-controls{display:flex}`, `.bt-btn-modal{display:inline-flex}`) outside one, so a
 * component rule wins over `hidden` whatever the order: an element carrying both is shown while the code believes it is
 * hidden. Each such component then needs its own `.x.hidden{display:none}` (as `.bt-rotate-canvas.hidden` and
 * `.bt-badge-converted.hidden` have). This file finds every element the templates hide with `hidden`, or the scripts
 * hide by its id, and fails when the stylesheet would still display it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDocument, FakeElement } from './fakeDom.mjs';
import { displayRules, displayOf } from './cssDisplay.mjs';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = displayRules(fs.readFileSync(path.join(tool, 'assets', 'css', 'bundletool.css'), 'utf8'));
const doc = new FakeDocument();

const files = (dir, ext) => fs.readdirSync(dir, { recursive: true })
  .filter((f) => f.endsWith(ext) && !f.includes('vendor')).map((f) => path.join(dir, f));
const templates = files(path.join(tool, 'layouts'), '.html').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const scripts = files(path.join(tool, 'public', 'js'), '.js').map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** Every element of the templates as { tag, id, classes }. */
const elements = [...templates.matchAll(/<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map(([, tag, attrs]) => ({
  tag, id: /\bid="([^"]*)"/.exec(attrs)?.[1] ?? null, classes: (/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean),
}));

/** The ids a script hides or shows with the hidden class: a line that finds the element by its id and toggles hidden. */
const toggled = new Set();
for (const line of scripts.split('\n')) {
  if (!/classList\.(?:add|remove|toggle)\(\s*'hidden'/.test(line)) continue;
  for (const m of line.matchAll(/(?:getElementById|\$)\(\s*'([\w-]+)'\s*\)/g)) toggled.add(m[1]);
}

/** The display an element with these classes gets once `hidden` is added, its own rules alone. */
function displayWhenHidden({ tag, id, classes }) {
  const el = new FakeElement(doc, tag);
  if (id) el.setAttribute('id', id);
  el.className = [...new Set([...classes, 'hidden'])].join(' ');
  return displayOf(el, rules);
}

test('the stylesheet is read: .hidden is in a layer, and the window\'s own control rows are not', () => {
  const hidden = rules.find((r) => r.selector === '.hidden');
  assert.ok(hidden && hidden.layered && hidden.display === 'none');
  assert.ok(rules.some((r) => r.selector === '.bt-rotate-controls' && !r.layered && r.display === 'flex'));
});

test('NEGATIVE CONTROL: an unlayered display rule on its own wins over hidden, and a .x.hidden rule hides it again', () => {
  const css = '@layer utilities{.hidden{display:none}} .row{display:flex} .chip{display:inline-flex} .chip.hidden{display:none}';
  const own = displayRules(css);
  const make = (cls) => { const el = new FakeElement(doc, 'div'); el.className = cls; return displayOf(el, own); };
  assert.equal(make('hidden row'), 'flex', 'the unlayered rule wins');
  assert.equal(make('hidden chip'), 'none', 'the compound rule hides it');
  assert.equal(make('hidden'), 'none');
});

test('every element the templates or scripts hide with hidden is really hidden by the stylesheet', () => {
  const checked = elements.filter((e) => e.classes.includes('hidden') || (e.id && toggled.has(e.id)));
  assert.ok(checked.length > 50, `${checked.length} elements checked`);
  const shown = checked.filter((e) => displayWhenHidden(e) !== 'none' && displayWhenHidden(e) !== null)
    .map((e) => `${e.id ? `#${e.id}` : e.tag}.${e.classes.join('.')}: ${displayWhenHidden(e)}`);
  assert.deepEqual(shown, []);
});
