/**
 * Preview Bundle and Preview Index on a browser with no PDF viewer (navigator.pdfViewerEnabled === false, most
 * phones): the pages as pictures in the preview window, one at a time (frontend/previewPages.js), drawn and paged by
 * the document window's own code (frontend/pageView.js). A browser with a viewer keeps the iframe and never loads the
 * pictures. Paging by button, typed number and arrow key; only the page shown held; Save and Split for email still work
 * from the pictures, and a cancelled split comes back to the same page.
 *
 * Driven through the ids the real template gives the window (tests/fakeDom.mjs) and a real pdf.js, as the document
 * window's own tests are (tests/documentWindowHarness.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { FakeElement, elementsFromTemplate, templateBlock, fakeEvent } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';
import { doc, html, log, state, createCanvas, until, tick } from './documentWindowHarness.mjs';

for (const id of ['bundle-preview-modal', 'email-split-modal']) {
  const block = templateBlock(html, id);
  const el = doc.body.appendChild(new FakeElement(doc, 'div', id));
  el.className = 'hidden flex';
  elementsFromTemplate(doc, el, block.slice(block.indexOf('>') + 1), { makeCanvas: createCanvas });
}
const $ = (id) => doc.getElementById(id);
const modal = $('bundle-preview-modal');

const { openBundlePreview, openIndexPreview } = await import('../public/js/frontend/bundleUI.js');
const emailSplit = await import('../public/js/frontend/emailSplit.js');
emailSplit.setup();

/** What the browser says about its own PDF viewer: true, false, or not saying (undefined). */
function viewer(enabled) {
  Object.defineProperty(globalThis.navigator, 'pdfViewerEnabled', { value: enabled, configurable: true, writable: true });
}

const shown = (id) => !$(id).classList.contains('hidden');
const shownPage = () => Number($('bundle-preview-page-input').value);
const drawnOrFailed = () => shown('bundle-preview-canvas') || shown('bundle-preview-no-page');

/** Opens the preview on a fresh n-page PDF and waits for its first page and its page count. */
async function openPictures(pages = 3, open = openBundlePreview, name = 'bundle.pdf') {
  viewer(false);
  const bytes = await makePdf(pages, 'BUNDLE');
  log.got.length = 0;
  open(bytes, name);
  await until(() => log.got.includes(1) || shown('bundle-preview-no-page'), 'the first page');
  await until(() => $('bundle-preview-page-count').textContent === String(pages), 'the page count');
  await until(drawnOrFailed, 'the first picture');
  return bytes;
}

test('with a PDF viewer the preview is the iframe exactly as before, and the pictures are never loaded', async () => {
  for (const enabled of [true, undefined]) {
    viewer(enabled);
    log.got.length = 0;
    openBundlePreview(await makePdf(2), 'bundle.pdf');
    assert.equal(shown('bundle-preview-modal'), true);
    assert.equal(shown('bundle-preview-frame'), true, `the iframe shows (pdfViewerEnabled ${enabled})`);
    assert.match($('bundle-preview-frame').src, /^blob:/);
    for (const id of ['bundle-preview-stage', 'bundle-preview-pager', 'bundle-preview-no-viewer']) assert.equal(shown(id), false, `${id} stays hidden`);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(log.got, [], 'pdf.js is never asked for a page');
    $('bundle-preview-close').click();
    assert.equal($('bundle-preview-frame').src, 'about:blank');
  }
  // Nothing but a lazy import reaches the pictures, so a page with a viewer never fetches them or pdf.js.
  const ui = fs.readFileSync(new URL('../public/js/frontend/bundleUI.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /^import .*(previewPages|pageView|pdfjs)/m);
  assert.match(ui, /lazyImport\(new URL\('\.\/previewPages\.js', import\.meta\.url\)\)/);
});

test('with no viewer the preview shows the pages as pictures, from page 1 of N, in place of the note', async () => {
  await openPictures(3);
  assert.equal(shown('bundle-preview-frame'), false);
  assert.equal(shown('bundle-preview-no-viewer'), false, 'the "cannot display" note gives way to the pictures');
  assert.equal(shown('bundle-preview-stage'), true);
  assert.equal(shown('bundle-preview-pager'), true);
  assert.equal(shownPage(), 1);
  assert.equal($('bundle-preview-page-count').textContent, '3');
  assert.equal($('bundle-preview-canvas').getAttribute('aria-label'), 'Page 1 of 3');
  assert.equal($('bundle-preview-prev').disabled, true);
  assert.equal($('bundle-preview-next').disabled, false);
  if (createCanvas) assert.equal(shown('bundle-preview-canvas'), true, 'the page is drawn');
  // Read-only: none of the document window's own controls are part of this window.
  for (const id of ['rotate-left', 'rotate-ocr', 'rotate-remove']) assert.equal($(id).closest('#bundle-preview-modal'), null);
  $('bundle-preview-close').click();
});

test('the pictures page by button, by typed number and by arrow key, held to 1..N', async () => {
  await openPictures(4);
  $('bundle-preview-next').click();
  assert.equal(shownPage(), 2);
  assert.equal($('bundle-preview-canvas').getAttribute('aria-label'), 'Page 2 of 4');
  const input = $('bundle-preview-page-input');
  input.value = '4';
  input.dispatchEvent(fakeEvent('change'));
  assert.equal(shownPage(), 4);
  assert.equal($('bundle-preview-next').disabled, true, 'no page after the last');
  $('bundle-preview-next').click();
  assert.equal(shownPage(), 4);
  input.value = '1';
  input.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }));
  assert.equal(shownPage(), 1, 'Enter in the box goes there');
  for (const bad of ['', 'two', '2.5', '-1']) {
    input.value = bad;
    input.dispatchEvent(fakeEvent('change'));
    assert.equal(input.value, '1', `"${bad}" snaps back`);
  }
  input.value = '99';
  input.dispatchEvent(fakeEvent('change'));
  assert.equal(shownPage(), 4, 'past the end goes to the last page');
  const key = (k, target = $('bundle-preview-save')) => target.dispatchEvent(fakeEvent('keydown', { key: k }));
  key('ArrowLeft');
  assert.equal(shownPage(), 3, 'the arrow keys page while focus is in the window');
  key('ArrowRight');
  assert.equal(shownPage(), 4);
  key('ArrowLeft', doc.body.appendChild(new FakeElement(doc, 'button')));
  assert.equal(shownPage(), 4, 'a key pressed outside the window does nothing');
  $('bundle-preview-close').click();
});

test('only the page shown is held: each is freed when another takes its place, and the document on close', async () => {
  log.freed.length = 0;
  const destroyedBefore = log.destroyed;
  await openPictures(3);
  $('bundle-preview-next').click();
  await until(() => log.got.includes(2), 'page 2');
  await until(() => log.freed.includes(1), 'page 1 freed');
  $('bundle-preview-next').click();
  await until(() => log.freed.includes(2), 'page 2 freed');
  assert.equal(log.freed.includes(3), false, 'the page shown is kept');
  assert.deepEqual([...new Set(log.got)], [1, 2, 3], 'each page is asked for when it is shown, not before');
  $('bundle-preview-close').click();
  assert.equal(shown('bundle-preview-modal'), false);
  assert.ok(log.freed.includes(3), 'closing frees the page shown');
  await until(() => log.destroyed > destroyedBefore, 'the document freed');
  assert.equal(shown('bundle-preview-stage'), false);
  assert.equal($('bundle-preview-canvas').width, 0, 'the drawn picture is dropped');
});

test('Save from the pictures downloads the very bytes that were built, under the bundle\'s name, and closes', async () => {
  const saved = [];
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'a') el.click = () => saved.push({ name: el.download, blob: resolveObjectURL(el.href) });
    return el;
  };
  try {
    const destroyedBefore = log.destroyed;
    const bytes = await openPictures(3, openBundlePreview, 'Final hearing bundle.pdf');
    const copy = bytes.slice();
    $('bundle-preview-next').click();
    $('bundle-preview-save').click();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Final hearing bundle.pdf');
    assert.deepEqual(new Uint8Array(await saved[0].blob.arrayBuffer()), copy, 'the download is the built PDF, unchanged by drawing it');
    assert.equal(bytes.byteLength, copy.byteLength, 'drawing gave pdf.js a copy: the bytes the window holds are intact');
    assert.equal(shown('bundle-preview-modal'), false, 'Save closes the window');
    await until(() => log.destroyed > destroyedBefore, 'the pictures freed');
  } finally {
    doc.createElement = realCreate;
  }
});

test('Split for email from the pictures opens the split with the bundle, frees the pictures, and Cancel comes back to the same page', async () => {
  const destroyedBefore = log.destroyed;
  await openPictures(3, openBundlePreview, 'big bundle.pdf');
  $('bundle-preview-next').click();
  assert.equal(shownPage(), 2);
  assert.equal(shown('bundle-preview-split'), true);
  $('bundle-preview-split').click();
  await until(() => shown('email-split-modal'), 'the split window');
  assert.equal(shown('bundle-preview-modal'), false, 'the preview steps aside');
  assert.match($('email-split-source').textContent, /^big bundle\.pdf · /, 'the split has the bundle');
  await until(() => log.destroyed > destroyedBefore, 'the pictures freed while the split is open');
  assert.equal(shown('bundle-preview-canvas'), false, 'no emptied picture is left showing underneath');
  log.got.length = 0;
  $('email-split-cancel').click();
  assert.equal(shown('email-split-modal'), false);
  assert.equal(shown('bundle-preview-modal'), true, 'the preview comes back');
  await until(() => log.got.includes(2) || shown('bundle-preview-no-page'), 'page 2 drawn again');
  await until(drawnOrFailed, 'page 2 shown again');
  assert.equal(shownPage(), 2, 'on the page it was on');
  assert.equal($('bundle-preview-page-count').textContent, '3');
  assert.equal(shown('bundle-preview-stage'), true);
  $('bundle-preview-close').click();
});

test('Split pressed before the pictures have loaded still brings them back on Cancel, from page 1', async () => {
  viewer(false);
  openBundlePreview(await makePdf(3), 'quick.pdf');
  $('bundle-preview-split').click();
  await until(() => shown('email-split-modal'), 'the split window');
  log.got.length = 0;
  $('email-split-cancel').click();
  assert.equal(shown('bundle-preview-modal'), true);
  await until(() => log.got.includes(1) || shown('bundle-preview-no-page'), 'page 1 drawn');
  await until(drawnOrFailed, 'the picture shown');
  assert.equal(shownPage(), 1);
  assert.equal(shown('bundle-preview-stage'), true, 'pictures, not an empty box');
  $('bundle-preview-close').click();
});

test('Preview Index shows its pictures too, with Save index and no Split, and the window reopens cleanly', async () => {
  await openPictures(2, openIndexPreview, 'index.pdf');
  assert.equal($('bundle-preview-title').textContent, 'Index preview');
  assert.equal($('bundle-preview-save').textContent, 'Save index');
  assert.equal(shown('bundle-preview-split'), false, 'Split for email is a bundle\'s, not an index\'s');
  assert.equal(shown('bundle-preview-stage'), true);
  $('bundle-preview-next').click();
  assert.equal(shownPage(), 2);
  $('bundle-preview-close').click();
  await openPictures(5);
  assert.equal(shownPage(), 1, 'a new preview starts on page 1');
  assert.equal($('bundle-preview-page-count').textContent, '5');
  assert.equal(shown('bundle-preview-split'), true);
  assert.equal($('bundle-preview-save').textContent, 'Save bundle');
  $('bundle-preview-close').click();
});

test('a bundle holding a document flagged as expanding is not drawn: the note says to save it instead', async () => {
  viewer(false);
  state.frontendInputData['bomb.pdf'] = { title: 'Bomb', date: '', pageCount: 1, expanding: true };
  try {
    log.got.length = 0;
    openBundlePreview(await makePdf(2), 'bundle.pdf');
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(shown('bundle-preview-no-viewer'), true);
    assert.equal(shown('bundle-preview-stage'), false);
    assert.deepEqual(log.got, [], 'pdf.js is never asked for a page');
    $('bundle-preview-close').click();
    // An index holds none of the documents, so it is drawn.
    await openPictures(1, openIndexPreview, 'index.pdf');
    assert.equal(shown('bundle-preview-stage'), true);
    $('bundle-preview-close').click();
  } finally {
    delete state.frontendInputData['bomb.pdf'];
  }
});

test('the pictures use the document window\'s own drawing, with its pdf.js safety settings, and hide when they should', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const view = read('../public/js/frontend/pageView.js');
  assert.match(view, /getDocument\(\{ data: this\.bytes\.slice\(\), isEvalSupported: false, enableXfa: false, maxImageSize: 32 \* 1024 \* 1024 \}\)/);
  for (const rel of ['../public/js/frontend/previewPages.js', '../public/js/frontend/rotate.js']) {
    const src = read(rel);
    assert.match(src, /import \{ PageView, wirePager \} from '\.\/pageView\.js';/, `${rel} draws and pages through pageView.js`);
    assert.doesNotMatch(src, /getDocument|from '\/vendor\/pdfjs\.mjs'/, `${rel} has no pdf.js of its own`);
  }
  // The pager and stage carry unlayered display rules, so each needs its own .hidden rule (hiddenWins.test.mjs).
  const css = read('../assets/css/bundletool.css');
  assert.match(css, /\.bt-preview-stage\.hidden \{ display: none; \}/);
  assert.match(css, /\.bt-preview-pager\.hidden \{ display: none; \}/);
});
