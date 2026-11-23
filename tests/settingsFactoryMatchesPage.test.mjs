/**
 * Share and Reset appear when settingsDiff() finds a setting that is not its factory value. If FACTORY (bundletoolPage.js)
 * disagrees with what the page shows on a fresh load, both buttons are on screen before anything was changed, and Reset
 * moves a control the person never touched. So every FACTORY key that has a control on the page equals that control's
 * initial value in the template, and every key the sanitiser accepts as a default is wired through FACTORY, the saved
 * defaults and the apply step (Title Lines was in none of them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS_KEYS } from '../public/js/frontend/configSanitise.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../layouts/partials/bundletool.html');
const page = read('../public/js/bundletoolPage.js');

const factory = Function(`return (${/const FACTORY = (\{[\s\S]*?\n  \});/.exec(page)[1]})`)();

/** The control's value on a fresh load, read from the template: a checkbox's checked, a select's selected (else first) option, an input's value. */
function initial(key) {
  const tag = new RegExp(`<(input|select)\\b[^>]*\\bid="config-${key}"[^>]*>`).exec(html);
  if (!tag) return undefined;
  if (tag[1] === 'select') {
    const block = new RegExp(`<select\\b[^>]*\\bid="config-${key}"[^>]*>([\\s\\S]*?)</select>`).exec(html)[1];
    const opts = [...block.matchAll(/<option\b([^>]*)>/g)];
    const chosen = opts.find((o) => /\bselected\b/.test(o[1])) || opts[0];
    return /value="([^"]*)"/.exec(chosen[1])?.[1];
  }
  if (/type="checkbox"/.test(tag[0])) return /\bchecked\b/.test(tag[0]);
  const v = /\bvalue="([^"]*)"/.exec(tag[0])?.[1];
  return typeof factory[key] === 'number' ? Number(v) : v;
}

test('every FACTORY value is what the page shows on a fresh load', () => {
  const mismatches = [];
  for (const [key, want] of Object.entries(factory)) {
    const got = initial(key);
    if (got === undefined) continue; // no control in the template (set by script, or ignored by the page)
    if (got !== want) mismatches.push(`${key}: the page starts on ${JSON.stringify(got)}, FACTORY says ${JSON.stringify(want)}`);
  }
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('every default the sanitiser accepts is in FACTORY, the saved defaults and the apply step', () => {
  const current = /function currentDefaults\(\) \{[\s\S]*?\n  \}\n/.exec(page)[0];
  const apply = /function applyDefaults\(raw\) \{[\s\S]*?\n  \}\n/.exec(page)[0];
  const missing = [];
  for (const key of DEFAULTS_KEYS) {
    const word = new RegExp(`\\b${key}\\b`);
    if (!(key in factory)) missing.push(`${key} is not in FACTORY`);
    if (!word.test(current)) missing.push(`${key} is not in currentDefaults()`);
    if (!word.test(apply)) missing.push(`${key} is not applied by applyDefaults()`);
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('Share and Reset are driven by one predicate', () => {
  const fn = /function refreshAdvancedActionButtons\(\) \{[\s\S]*?\n  \}\n/.exec(page)[0];
  assert.match(fn, /share-advanced-btn/);
  assert.match(fn, /reset-advanced-btn/);
  assert.equal((fn.match(/settingsDiff\(\)/g) || []).length, 1, 'settingsDiff() is read once, and both buttons follow it');
});
