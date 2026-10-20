/**
 * Values that arrive from outside (saved defaults, a settings link, a snapshot, a reopened bundle's
 * metadata) must never reach a select or a build unless the build would accept them. See
 * public/js/frontend/configSanitise.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseConfig, sanitiseNestedConfig, DEFAULTS_KEYS, SETTING_SPEC } from '../public/js/frontend/configSanitise.js';
import { validDateStyles, validDateInputOrder } from '../public/js/bundletoolConfig.js';

test('an old date style is mapped to the current one, and every current one is kept', () => {
  assert.equal(sanitiseConfig({ dateStyle: 'Mon. DD, YYYY' }).dateStyle, 'Mon DD, YYYY');
  for (const style of validDateStyles) {
    assert.ok(validDateStyles.includes(sanitiseConfig({ dateStyle: style }).dateStyle), style);
  }
});

test('dateInputOrder is a strict enum: UK and US pass, anything else is dropped (never applied)', () => {
  for (const order of validDateInputOrder) {
    assert.equal(sanitiseConfig({ dateInputOrder: order }).dateInputOrder, order);
  }
  assert.deepEqual(sanitiseConfig({ dateInputOrder: 'FR' }), {}, 'an unknown value is dropped, not applied');
  assert.deepEqual(sanitiseConfig({ dateInputOrder: 'uk' }), {}, 'case-sensitive: lowercase is not a valid value either');
  assert.deepEqual(sanitiseConfig({ dateInputOrder: '' }), {}, 'an empty value is dropped, not treated as a choice');
  // Absent entirely (not even a key) is the real "default to UK" path: the field is left alone, and
  // Config's own default of 'UK' is what a saved copy or link without this key keeps.
  assert.deepEqual(sanitiseConfig({ fontFace: 'serif' }).dateInputOrder, undefined);
});

test('a date style, font or size the build would reject is dropped, never written', () => {
  const out = sanitiseConfig({ dateStyle: 'Made up', fontFace: '', footerFont: 'Comic Sans', indexFontSize: 'huge', alignment: 5 });
  assert.deepEqual(out, {});
});

test('numbers must be numbers in range; numeric strings are accepted, junk is not', () => {
  assert.equal(sanitiseConfig({ footerOffset: 999 }).footerOffset, undefined);
  assert.equal(sanitiseConfig({ footerOffset: -31 }).footerOffset, undefined);
  assert.equal(sanitiseConfig({ footerOffset: '12' }).footerOffset, 12);
  assert.equal(sanitiseConfig({ footerOffset: 'abc' }).footerOffset, undefined);
  assert.equal(sanitiseConfig({ plateOpacity: 101 }).plateOpacity, undefined);
  assert.equal(sanitiseConfig({ plateOpacity: '55' }).plateOpacity, 55);
  assert.equal(sanitiseConfig({ plateOpacity: NaN }).plateOpacity, undefined);
});

test('colours: hex is kept, the three colour names map to the hex they draw, anything else is dropped', () => {
  assert.equal(sanitiseConfig({ pageNumberColour: '#AABBCC' }).pageNumberColour, '#aabbcc');
  assert.equal(sanitiseConfig({ pageNumberColour: 'red' }).pageNumberColour, '#de081a');
  assert.equal(sanitiseConfig({ pageNumberColour: 'BLACK' }).pageNumberColour, '#120513');
  assert.equal(sanitiseConfig({ pageNumberColour: 'fuchsia' }).pageNumberColour, undefined);
  assert.equal(sanitiseConfig({ plateColour: 'javascript:alert(1)' }).plateColour, undefined);
});

test('the default email split is size or section, and nothing else', () => {
  assert.equal(sanitiseConfig({ splitBy: 'section' }).splitBy, 'section');
  assert.equal(sanitiseConfig({ splitBy: 'size' }).splitBy, 'size');
  for (const bad of ['Section', 'both', '', 1, true, null, ['section']]) assert.equal(sanitiseConfig({ splitBy: bad }).splitBy, undefined, String(bad));
});

test('booleans must be booleans', () => {
  assert.equal(sanitiseConfig({ printableBundle: 'true' }).printableBundle, undefined);
  assert.equal(sanitiseConfig({ printableBundle: true }).printableBundle, true);
});

test('text is length-capped, control characters removed, and over-long text refused rather than cut', () => {
  assert.equal(sanitiseConfig({ footerPrefix: 'Exhibit\u0000 A-' }).footerPrefix, 'Exhibit A-');
  assert.equal(sanitiseConfig({ footerPrefix: 'x'.repeat(501) }).footerPrefix, undefined);
  assert.equal(sanitiseConfig({ courtName: 'IN THE COURT\nAT LONDON' }).courtName, 'IN THE COURT\nAT LONDON');
  assert.equal(sanitiseConfig({ headingText: 'a\nb' }).headingText, 'ab');
  assert.equal(sanitiseConfig({ footerPrefix: { a: 1 } }).footerPrefix, undefined);
});

test('a settings link or saved defaults may only carry the defaults keys', () => {
  const out = sanitiseConfig({ dateStyle: 'DD-MM-YYYY', bundleTitle: 'Other matter', watermarkText: 'X', indexBookmarkLabel: 'Hi' }, { only: DEFAULTS_KEYS });
  assert.deepEqual(out, { dateStyle: 'DD-MM-YYYY' });
});

test('prototype-shaped keys never come through, and input is not mutated', () => {
  const input = JSON.parse('{"__proto__":{"polluted":1},"constructor":"x","fontFace":"serif"}');
  const out = sanitiseConfig(input, { passThrough: true });
  assert.equal(out.fontFace, 'serif');
  assert.equal(Object.hasOwn(out, 'constructor'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('anything that is not a plain object gives an empty result', () => {
  for (const v of [null, undefined, 3, 'x', [], [1, 2]]) assert.deepEqual(sanitiseConfig(v), {});
  for (const v of [null, undefined, 3, 'x', []]) assert.deepEqual(sanitiseNestedConfig(v), {});
});

test('every validator rejects an object and accepts nothing it should not', () => {
  for (const [key, check] of Object.entries(SETTING_SPEC)) {
    assert.equal(check({}), null, `${key} accepted an object`);
    assert.equal(check(undefined), null, `${key} accepted undefined`);
  }
});

test('nested config (a reopened bundle, a manifest) keeps valid fields and drops the rest', () => {
  const out = sanitiseNestedConfig({
    heading: { claimNumber: 'ABC123', bundleTitle: 'x'.repeat(600), extra: 1 },
    index: { dateStyle: 'Mon. DD, YYYY', dateInputOrder: 'US', fontFace: 'nope', sectionPrefix: 'Part' },
    page: { footerFont: 'serif', pageNumberColour: 'blue', alignment: 'left' },
    pageOptions: { pageSize: 'a4', watermark: true, coverSource: 'generated', watermarkOpacity: 500 },
    cover: { layout: 'grid', claimNumber: null, author: 'A. Author', bundleTitle: 42 },
    unknownGroup: { a: 1 },
  });
  assert.deepEqual(out.heading, { claimNumber: 'ABC123' });
  assert.deepEqual(out.index, { dateStyle: 'Mon DD, YYYY', dateInputOrder: 'US', sectionPrefix: 'Part' });
  assert.deepEqual(out.pageNumbering, { footerFont: 'serif', pageNumberColour: '#1538df', alignment: 'left' });
  assert.deepEqual(out.pageOptions, { pageSize: 'a4', watermark: true, coverSource: 'generated' });
  assert.deepEqual(out.cover, { layout: 'grid', claimNumber: null, author: 'A. Author' });
  assert.equal(out.unknownGroup, undefined);
});

test('nested config cannot be steered by inherited or prototype keys', () => {
  const input = JSON.parse('{"__proto__":{"index":{"dateStyle":"YYYY-MM-DD"}},"index":{"__proto__":{"dateStyle":"YYYY-MM-DD"}}}');
  const out = sanitiseNestedConfig(input);
  assert.equal(out.index?.dateStyle, undefined);
  assert.equal({}.dateStyle, undefined);
});
