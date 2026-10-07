/** The Split for Email default: the Advanced Settings control, its saved value, and the dialog that reads it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS_KEYS } from '../public/js/frontend/configSanitise.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the Advanced Settings control exists, starts on size, and offers both ways', () => {
  const html = read('../layouts/partials/bundletool.html');
  assert.match(html, /<input type="hidden" id="config-splitBy" value="size">/);
  assert.match(html, /data-group="splitBy" data-value="size" class="btn-group btn-group-active"/);
  assert.match(html, /data-group="splitBy" data-value="section" class="btn-group"/);
});

test('the setting is saved, shared and reset with the others', () => {
  assert.ok(DEFAULTS_KEYS.includes('splitBy'));
  const page = read('../public/js/bundletoolPage.js');
  assert.match(page, /FACTORY = \{[\s\S]*splitBy: 'size'/);
  assert.match(page, /splitBy: document\.getElementById\('config-splitBy'\)/);
  assert.match(page, /resetGroup\('splitBy', d\.splitBy\)/);
});

test('the dialog opens the way the setting says, and still falls back to size without sections', () => {
  const dialog = read('../public/js/frontend/emailSplit.js');
  assert.match(dialog, /getElementById\('config-splitBy'\)\?\.value === 'section'/);
  assert.match(dialog, /showBy\(wantSection \? 'section' : 'size'\)/);
  // inspectSections puts the choice back on size when the PDF records no sections.
  assert.match(dialog, /if \(info\.sections\.length === 0\) \{[\s\S]*bySize\.checked = true;[\s\S]*showBy\('size'\)/);
});
