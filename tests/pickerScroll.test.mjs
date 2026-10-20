/**
 * The section pickers (which section to add to, what to download, where to move a deleted section's files) keep their
 * list of choices within the screen however many sections there are: the list scrolls, so the title and Cancel stay
 * in view and the last choice can always be reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../assets/css/bundletool.css', import.meta.url), 'utf8');

test('every section picker list carries the scrolling class', () => {
  for (const id of ['section-picker-list', 'download-picker-list', 'delete-section-picker-list']) {
    const tag = new RegExp(`<div id="${id}" class="([^"]*)"`).exec(html);
    assert.ok(tag, `${id} is in the page`);
    assert.ok(tag[1].split(/\s+/).includes('bt-picker-list'), `${id} scrolls within the screen`);
  }
});

test('the scrolling class caps the list at the screen and scrolls it', () => {
  const rule = /\.bt-picker-list\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the rule exists');
  assert.match(rule[1], /max-height:\s*calc\(100dvh - 10rem\)/);
  assert.match(rule[1], /max-height:\s*calc\(100vh - 10rem\)/, 'a fallback for browsers without dvh');
  assert.match(rule[1], /overflow-y:\s*auto/);
});
