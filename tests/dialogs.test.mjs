/**
 * Every dialog in a template is announced as one and has a name. The behaviour (focus in, Tab
 * trapped, focus back on close) lives in static/js/shared/dialog.js, which both footers must load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function templates(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') templates(p, out); }
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Comments are not markup: one of them mentions a <dialog> in prose.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');

const files = ['layouts']
  .flatMap((d) => templates(path.join(site, d)));

test('every role="dialog" element is modal and has an accessible name', () => {
  const offenders = [];
  let seen = 0;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/<(?:div|section)\b[^>]*role="(?:alert)?dialog"[^>]*>/g)) {
      seen++;
      const tag = m[0];
      const id = /id="([^"]+)"/.exec(tag)?.[1] ?? '(no id)';
      if (!/aria-modal="true"/.test(tag)) offenders.push(`${path.relative(site, f)} #${id}: no aria-modal`);
      if (!/aria-label(?:ledby)?="[^"]+"/.test(tag)) offenders.push(`${path.relative(site, f)} #${id}: no name`);
      const lab = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
      if (lab && !new RegExp(`id="${lab}"`).test(src)) offenders.push(`${path.relative(site, f)} #${id}: aria-labelledby points at a missing id (${lab})`);
    }
  }
  assert.ok(seen > 20, 'the templates were scanned');
  assert.deepEqual(offenders, []);
});

test('native <dialog> elements are named', () => {
  const offenders = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/<dialog\b[^>]*>/g)) {
      if (!/aria-label(?:ledby)?="[^"]+"/.test(m[0])) offenders.push(path.relative(site, f));
    }
  }
  assert.deepEqual(offenders, []);
});

test('both footers load the shared dialog script', () => {
  for (const f of ['layouts/partials/footer.html']) {
    assert.match(fs.readFileSync(path.join(site, f), 'utf8'), /js\/shared\/dialog\.js/, f);
  }
});
