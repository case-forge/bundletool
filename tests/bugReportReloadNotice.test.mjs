/**
 * A lazy load that fails in an out-of-date tab raises the "reload to continue" notice (lazy-load.js), then
 * lets the failure through, so a caller with no catch of its own ends in an unhandled rejection. The bug
 * reporter's detector (static/js/shared/bug-report.js) must not answer that with a second notice asking for a
 * bug report: reloading is the fix. It still reports the same rejection when no reload notice is up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SOURCE = fs.readFileSync(fileURLToPath(import.meta.resolve('/js/shared/bug-report.js')), 'utf8');
const ORIGIN = 'https://example.test';

function load({ reloadNotice }) {
  const listeners = {};
  const appended = [];
  const el = () => ({ setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {} });
  const document = {
    body: { appendChild: (node) => appended.push(node) },
    documentElement: { getAttribute: () => null },
    getElementById: (id) => (id === 'cf-update-toast' && reloadNotice ? {} : null),
    querySelector: () => null,
    createElement: el,
  };
  const window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
  const context = {
    window, document,
    location: { origin: ORIGIN, pathname: '/bundletool/' },
    navigator: { userAgent: 'test' },
    localStorage: { setItem() {} },
  };
  vm.runInNewContext(SOURCE, context);
  const reject = (reason) => { for (const fn of listeners.unhandledrejection || []) fn({ reason }); };
  return { reject, bugNotices: () => appended.filter((n) => n.id === 'cf-bug-toast').length };
}

// What Chrome rejects a failed dynamic import with: the message, and so the stack, names our own URL.
const importFailure = () => {
  const err = new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/bundletool/js/frontend/rotate.js`);
  err.stack = `TypeError: ${err.message}`;
  return err;
};

test('an unhandled lazy-load failure raises no bug notice while the reload notice is up', () => {
  const page = load({ reloadNotice: true });
  page.reject(importFailure());
  assert.equal(page.bugNotices(), 0);
});

test('the same unhandled rejection still raises the bug notice when no reload notice is up', () => {
  const page = load({ reloadNotice: false });
  page.reject(importFailure());
  assert.equal(page.bugNotices(), 1);
});
