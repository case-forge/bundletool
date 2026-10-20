/**
 * Stored settings from another build must not crash this one.
 *
 * A saved configuration, an autosave snapshot, a settings code or the manifest
 * inside a bundle can come from a build with more fields (a feature this build
 * does not have) or fewer (one this build adds). Config.updateOptions() is the
 * one door they all go through, so it is tested with both shapes: keys this
 * build does not have must be ignored, and keys an older build never wrote
 * must keep their defaults. The form-side loaders (applyDefaults, applySnapshot) skip
 * unknown and missing keys by construction and are covered by reading, not here:
 * they need a DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Config from '../public/js/bundletoolConfig.js';
import { nestManifestConfig } from '../public/js/manifestSchema.js';

test('keys this build does not have are ignored, not rejected', () => {
  const c = new Config();
  assert.doesNotThrow(() => c.updateOptions({
    cover: { hearingInfo: 'BUNDLE FOR HEARING', hearingDate: '14 March 2026', dateStyle: 'DD Month YYYY', courtName: 'COURT' },
    someFutureSection: { anything: 1 },
    heading: { retiredField: 'x', bundleTitle: 'T' },
  }));
  assert.doesNotThrow(() => c.validateStructure());
  assert.doesNotThrow(() => c.validateOptions());
  assert.equal(c.getOption('cover.courtName'), 'COURT');
  assert.equal(c.getOption('heading.bundleTitle'), 'T');
});

test('keys an older build never wrote keep their defaults', () => {
  const fresh = new Config();
  const c = new Config();
  c.updateOptions({ heading: { bundleTitle: 'Old bundle' }, cover: {} });
  assert.equal(c.getOption('cover.layout'), fresh.getOption('cover.layout'));
  assert.equal(c.getOption('pageNumbering.alignment'), fresh.getOption('pageNumbering.alignment'));
  assert.doesNotThrow(() => c.validateStructure());
});

test('a manifest carrying keys this build does not know loads through the same door', () => {
  const nested = nestManifestConfig({
    'heading.bundleTitle': 'From a manifest',
    'cover.hearingInfo': 'RETIRED',
    'cover.hearingDate': 'RETIRED',
    'cover.dateStyle': 'RETIRED-BUT-INVALID',
  });
  const c = new Config();
  assert.doesNotThrow(() => { c.updateOptions(nested); c.validateOptions(); });
  assert.equal(c.getOption('heading.bundleTitle'), 'From a manifest');
});
