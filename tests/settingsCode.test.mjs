/** Settings links and QR codes (BT1./BT2.) come from anyone who can send a link. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSettingsCode, decodeSettingsCode, isSettingsCode, SettingsCodeError, CODE_PREFIX_V1 } from '../public/js/frontend/settingsCode.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const v1 = (obj) => CODE_PREFIX_V1 + b64url(JSON.stringify(obj));

test('a code round-trips, compressed (BT2.) and plain (BT1.)', async () => {
  const diff = { dateStyle: 'DD-MM-YYYY', footerOffset: 10, printableBundle: true, courtName: 'IN THE FAMILY COURT' };
  const code = await encodeSettingsCode(diff);
  assert.match(code, /^BT2\./);
  assert.deepEqual(await decodeSettingsCode(code), diff);
  assert.deepEqual(await decodeSettingsCode(v1(diff)), diff);
});

test('dateInputOrder and dateStyle both survive a full link/QR round trip together', async () => {
  const diff = { dateInputOrder: 'US', dateStyle: 'MM/DD/YYYY' };
  const code = await encodeSettingsCode(diff);
  assert.match(code, /^BT2\./);
  assert.deepEqual(await decodeSettingsCode(code), diff);
  assert.deepEqual(await decodeSettingsCode(v1(diff)), diff);
  // An invalid dateInputOrder alongside a valid dateStyle: the bad one is dropped, the good one
  // still travels: the same "drop what's wrong, keep what's right" rule as every other setting here.
  assert.deepEqual(await decodeSettingsCode(v1({ dateInputOrder: 'FR', dateStyle: 'YYYY-MM-DD' })), { dateStyle: 'YYYY-MM-DD' });
});

test('a link naming the date style "Mon. DD, YYYY" is read as "Mon DD, YYYY"', async () => {
  assert.deepEqual(await decodeSettingsCode(v1({ dateStyle: 'Mon. DD, YYYY' })), { dateStyle: 'Mon DD, YYYY' });
});

test('a value the build would reject is dropped from the code, not saved', async () => {
  const out = await decodeSettingsCode(v1({ footerOffset: 999, dateStyle: 'nonsense', fontFace: 'serif' }));
  assert.deepEqual(out, { fontFace: 'serif' });
});

test('keys outside the defaults list (per-bundle fields, unknown ones) are ignored', async () => {
  const out = await decodeSettingsCode(v1({ bundleTitle: 'Planted', claimNumber: 'X', watermarkText: 'Y', indexBookmarkLabel: 'Z', pageSize: 'a4' }));
  assert.deepEqual(out, { pageSize: 'a4' });
});

test('the default split travels in a settings code, and a bad value is dropped', async () => {
  assert.deepEqual(await decodeSettingsCode(await encodeSettingsCode({ splitBy: 'section' })), { splitBy: 'section' });
  assert.deepEqual(await decodeSettingsCode(v1({ splitBy: 'nonsense', pageSize: 'a4' })), { pageSize: 'a4' });
});

test('malformed codes throw SettingsCodeError with a message, never a raw error', async () => {
  const bad = ['BT1.@@@', 'BT1.', 'BT2.%%%', 'BT2.AAAA', v1('not an object').replace(/^BT1\..*/, 'BT1.' + b64url('"str"')),
    'BT1.' + b64url('[1,2]'), 'BT1.' + b64url('{oops'), 'BT9.abc', 'hello', '', null, undefined];
  for (const code of bad) {
    await assert.rejects(() => decodeSettingsCode(code), (err) => err instanceof SettingsCodeError && err.message.length > 0, String(code));
  }
});

test('an over-long code, and a small code that inflates enormously, are refused', async () => {
  await assert.rejects(() => decodeSettingsCode('BT1.' + 'A'.repeat(25_000)), SettingsCodeError);
  const { gzipSync } = await import('node:zlib');
  const bomb = 'BT2.' + b64url(gzipSync(Buffer.from('{"footerPrefix":"' + 'a'.repeat(5_000_000) + '"}')));
  assert.ok(bomb.length < 20_000);
  await assert.rejects(() => decodeSettingsCode(bomb), SettingsCodeError);
});

test('isSettingsCode only recognises our two prefixes', () => {
  assert.equal(isSettingsCode('BT1.abc'), true);
  assert.equal(isSettingsCode('BT2.abc'), true);
  assert.equal(isSettingsCode('BT3.abc'), false);
  assert.equal(isSettingsCode(42), false);
});
