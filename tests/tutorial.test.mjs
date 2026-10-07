/**
 * The tour (bundletoolTutorial.js): every step points at something the page has, and the Review Table step speaks
 * of the controls the table has (four row buttons, the eye's window, Download) and of none it lacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeDocument, FakeElement } from './fakeDom.mjs';

const doc = new FakeDocument();
globalThis.document = doc;
const { STEPS } = await import('../public/js/bundletoolTutorial.js');
const { syncReviewTableHeader } = await import('../public/js/frontend/reviewTableHeader.js');

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const templates = read('../layouts/partials/bundletool.html') + read('../layouts/partials/header.html');
const text = (step) => (Array.isArray(step.body) ? step.body.join(' ') : step.body);

test('every step\'s target is on the page', () => {
  const ids = new Set([...templates.matchAll(/\bid="([^"{}]+)"/g), ...templates.matchAll(/"id" "([^"]+)"/g)].map((m) => m[1]));
  const targets = STEPS.map((s) => s.element).filter(Boolean);
  assert.ok(targets.length >= 8);
  for (const id of targets) assert.ok(ids.has(id), `#${id} is in the templates`);
});

test('the Review Table step speaks of the four row buttons, the document window and Download', () => {
  const step = STEPS.find((s) => s.element === 'file-table');
  const body = text(step);
  for (const words of ['four buttons', 'the eye', 'type a page number', 'Turn document', 'Force OCR', 'looks blank', 'Download']) {
    assert.ok(body.includes(words), `mentions ${words}`);
  }
  assert.equal(step.showPlaceholderRows, true);
  assert.equal(step.showDownload, true, 'the step shows the Download button while it is on screen');
  for (const s of STEPS) {
    assert.doesNotMatch(text(s), /rotate button|OCR button|download (this|each) (PDF|file|document)/i, `${s.title} names no button the table lacks`);
  }
});

test('Step 1 names the fields Basic Information has', () => {
  const body = text(STEPS.find((s) => s.element === 'step-1-info'));
  for (const label of ['Case Reference', 'Bundle Title', 'Parties', 'Prepared By']) assert.match(templates, new RegExp(`\\b${label}\\b`));
  assert.match(body, /case reference, the bundle title, the parties and who prepared the bundle/);
});

test('the Download button the tour shows stays shown while the example rows come and go, and goes with the step', () => {
  const tableEl = doc.body.appendChild(new FakeElement(doc, 'table'));
  const tbody = tableEl.appendChild(new FakeElement(doc, 'tbody'));
  tbody.className = 'section-tbody';
  const button = doc.body.appendChild(new FakeElement(doc, 'button', 'download-docs-btn'));
  button.hidden = true;
  button.dataset.tutorialDemo = 'true';
  button.hidden = false;
  tbody.appendChild(new FakeElement(doc, 'tr')).className = 'tutorial-row';
  syncReviewTableHeader(doc);
  assert.equal(button.hidden, false, 'kept for the tour');
  delete button.dataset.tutorialDemo;
  syncReviewTableHeader(doc);
  assert.equal(button.hidden, true, 'hidden again once the tour lets go of it');
  const source = read('../public/js/bundletoolTutorial.js');
  assert.match(source, /function hideDownloadDemo\(\)[\s\S]*?btn\.inert = false/, 'the tour gives the button back');
  assert.match(source, /function endTutorial\(\)[\s\S]*?hideDownloadDemo\(\)/, 'and does so when the tour ends early');
});
