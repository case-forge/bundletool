import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeWarnLargeBundleOnAdd } from '../public/js/frontend/fileProcessing.js';

// The very-large-bundle warning fires at add time (the same 1000-page / 75 MB
// threshold the build-time gate uses), not only when Create Bundle is pressed,
// so the wait through validation is not wasted before the caller learns the
// bundle is oversize.

test('the large-bundle warning fires on add for an over-threshold set, and not for one under it', () => {
  // Under threshold: no warning.
  let underCalls = [];
  const warnedUnder = maybeWarnLargeBundleOnAdd(237, 30, '', (opts) => underCalls.push(opts));
  assert.equal(warnedUnder, false);
  assert.equal(underCalls.length, 0);

  // Over the page threshold: warns, non-blocking (warnFn is a plain callback,
  // not something the caller awaits a decision from).
  let overCalls = [];
  const warnedOver = maybeWarnLargeBundleOnAdd(1200, 30, '', (opts) => overCalls.push(opts));
  assert.equal(warnedOver, true);
  assert.equal(overCalls.length, 1);
  assert.match(overCalls[0].message, /1200 pages/);
  assert.equal(overCalls[0].title, 'Very large bundle');

  // Over the size threshold alone also warns.
  let sizeCalls = [];
  maybeWarnLargeBundleOnAdd(50, 80.4, '', (opts) => sizeCalls.push(opts));
  assert.equal(sizeCalls.length, 1);
  assert.match(sizeCalls[0].message, /80\.4 MB/);
});
