/**
 * What the standalone repository must keep true on its own: the response headers, templates without inline script,
 * an offline worker that names no other origin, and a site that links to the live CaseForge pages instead of
 * carrying copies of them. (The strict offline build in CI checks that the worker lists every file the pages load.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSectionId, cleanSectionId } from '../public/js/frontend/sectionId.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
};

function rules() {
  const blocks = [];
  let cur = null;
  for (const line of read('static/_headers').split('\n')) {
    if (!line.trim() || line.startsWith('#')) { cur = null; continue; }
    if (/^\s/.test(line)) { cur?.lines.push(line.trim()); continue; }
    cur = { path: line.trim(), lines: [] };
    blocks.push(cur);
  }
  return blocks;
}
const cspOf = (block) => block?.lines.find((l) => l.startsWith('Content-Security-Policy:'))?.slice('Content-Security-Policy:'.length).trim();

test('the tool page sends a CSP that allows no inline script and nothing from another origin', () => {
  const csp = cspOf(rules().find((b) => b.path === '/bundletool/*'));
  assert.ok(csp, 'a rule on /bundletool/* sets a CSP');
  const dirs = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));
  assert.deepEqual(dirs['default-src'], ["'none'"]);
  assert.deepEqual(dirs['script-src'], ["'self'"], 'no inline script, no eval, no other origin');
  assert.deepEqual(dirs['frame-ancestors'], ["'none'"]);
  assert.deepEqual(dirs['object-src'], ["'none'"]);
  assert.ok(!/https?:\/\//.test(csp), 'the policy names no other origin');
});

test('the root page has its own CSP, nothing sets one on /*, and no path matches two rules that both set a CSP', () => {
  const all = rules();
  assert.ok(cspOf(all.find((b) => b.path === '/')));
  assert.equal(cspOf(all.find((b) => b.path === '/*')), undefined, 'a CSP on /* would also match the tool');
  assert.equal(all.filter((b) => cspOf(b)).map((b) => b.path).sort().join(), '/,/bundletool/*');
});

test('the security headers are sent for every page, and HSTS does not claim subdomains or the preload list', () => {
  const global = rules().find((b) => b.path === '/*');
  const has = (name) => global.lines.some((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  for (const h of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Strict-Transport-Security']) assert.ok(has(h), h);
  assert.ok(!/includeSubDomains|preload/i.test(global.lines.join(' ')));
});

test('no template has an inline <script>, an inline event handler or a javascript: URL', () => {
  for (const f of walk('layouts').filter((p) => p.endsWith('.html'))) {
    const t = read(f);
    for (const m of t.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1], /\bsrc\s*=/, `${f}: an inline <script>`);
    assert.doesNotMatch(t, /\son[a-z]+\s*=\s*["']/i, `${f}: an inline event handler`);
    assert.doesNotMatch(t, /javascript:/i, `${f}: a javascript: URL`);
  }
});

test('the offline worker template names no other origin', () => {
  const t = read('scripts/offline/sw.template.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(t, /https?:\/\//);
});

test('the footer and the error box link to the live CaseForge pages, and no template links to a page this repository does not have', () => {
  assert.match(read('hugo.toml'), /contactUrl = "https:\/\/caseforge\.uk\/contact\/"/);
  assert.match(read('hugo.toml'), /privacyUrl = "https:\/\/caseforge\.uk\/privacy\/"/);
  assert.match(read('layouts/partials/footer.html'), /More tools at caseforge\.uk/);
  for (const f of ['public/js/frontend/modals.js', 'static/js/shared/bug-report.js']) assert.doesNotMatch(read(f), /['"]\/contact\//, `${f}: a local /contact/ path`);
  for (const f of walk('layouts').filter((p) => p.endsWith('.html'))) assert.doesNotMatch(read(f), /(?:href|src)="\/(?:contact|privacy|success|chambers-finder|envelope-guide)\//, f);
});

test('a section id is four digits or it is replaced; nothing else reaches the markup', () => {
  assert.ok(isSectionId('0001'));
  for (const bad of ['', '1', '00001', 'abcd', '0001x', '0001 ', ' 0001']) assert.equal(isSectionId(bad), false, bad);
  assert.match(cleanSectionId('0001x', new Set(), 1), /^\d{4}$/);
});
