/**
 * A bundle is filed with a court and served to other people, so nothing a source document can use to
 * run a script, start a program, send data, play media or smuggle a file may reach it, whichever
 * route it takes. tests/fixtures/pdf/active.pdf tries every route (see make_fixtures.py); these tests
 * read the FINISHED bundle's bytes back, not just the cleaning function's own output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString } from '../public/js/bundletoolPdfLib.js';
import { prepareSourceForMerge } from '../public/js/bundletoolPdfSafety.js';
import { readBundleIndex } from '../public/js/bundletoolMeta.js';
import { readOutline } from '../public/js/bundletoolOutline.js';
import { buildFrom, fixture } from './helpers_bundle.mjs';

const load = (bytes) => PDFDocument.load(bytes, { throwOnInvalidObject: false });

const UNSAFE_ACTIONS = ['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition', 'Movie', 'Sound',
  'RichMediaExecute', 'GoTo3DView', 'Thread', 'SetOCGState', 'ResetForm', 'Hide', 'Named'];
const ACTIVE_KEYS = ['JS', 'AA', 'EF', 'RF', 'AF', 'OpenAction', 'XFA', 'Collection', 'PieceInfo', 'JavaScript', 'EmbeddedFiles', 'RichMediaContent', '3DD', 'Movie', 'Sound'];
const ACTIVE_SUBTYPES = ['FileAttachment', 'Screen', 'Movie', 'Sound', 'RichMedia', '3D'];
const SAFE_URI = /^(https?:|mailto:|tel:)/i;

/** Everything active found anywhere in a document, including inside object streams. */
function activeContentIn(doc) {
  const found = [];
  const walk = (value, where) => {
    if (value instanceof PDFStream) value = value.dict;
    if (value instanceof PDFArray) { for (let i = 0; i < value.size(); i++) walk(value.get(i), where); return; }
    if (!(value instanceof PDFDict)) return;
    for (const [key, child] of value.entries()) {
      const name = key.decodeText();
      if (ACTIVE_KEYS.includes(name)) found.push(`${where}: /${name}`);
      if (name === 'S' && child instanceof PDFName && UNSAFE_ACTIONS.includes(child.decodeText())) found.push(`${where}: action /${child.decodeText()}`);
      if (name === 'Subtype' && child instanceof PDFName && ACTIVE_SUBTYPES.includes(child.decodeText())) found.push(`${where}: annotation /${child.decodeText()}`);
      if (name === 'Type' && child instanceof PDFName && ['Filespec', 'EmbeddedFile'].includes(child.decodeText())) found.push(`${where}: /${child.decodeText()}`);
      if (name === 'URI' && (child instanceof PDFString || child instanceof PDFHexString) && !SAFE_URI.test(child.decodeText())) found.push(`${where}: URI ${child.decodeText()}`);
      if (name === 'Next' && value.has(PDFName.of('S'))) found.push(`${where}: chained /Next action`);
      if (!(child instanceof PDFRef)) walk(child, where);
    }
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) walk(obj, `object ${ref.tag}`);
  return found;
}

/** Every annotation on every page: { subtype, uri, dest (1-based page or null) }. */
function annotationsOf(doc) {
  const pageNumber = new Map(doc.getPages().map((p, i) => [p.ref.tag, i + 1]));
  const out = [];
  doc.getPages().forEach((page, i) => {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let k = 0; k < annots.size(); k++) {
      const a = doc.context.lookup(annots.get(k));
      if (!(a instanceof PDFDict)) continue;
      const row = { page: i + 1, subtype: a.get(PDFName.of('Subtype')).decodeText(), uri: null, dest: null, hasAP: a.has(PDFName.of('AP')) };
      const action = doc.context.lookup(a.get(PDFName.of('A')));
      if (action instanceof PDFDict && action.get(PDFName.of('S')) === PDFName.of('URI')) row.uri = doc.context.lookup(action.get(PDFName.of('URI'))).decodeText();
      let dest = a.get(PDFName.of('Dest')) ?? (action instanceof PDFDict ? action.get(PDFName.of('D')) : undefined);
      dest = dest && doc.context.lookup(dest);
      if (dest instanceof PDFArray && dest.get(0) instanceof PDFRef) row.dest = pageNumber.get(dest.get(0).tag) ?? 'not-in-tree';
      out.push(row);
    }
  });
  return out;
}

const pageObjectCount = (doc) => {
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) n++;
  }
  return n;
};

test('the fixture really is hostile: the scanner finds every route in the source document', async () => {
  const found = activeContentIn(await load(fixture('active.pdf')));
  for (const needle of ['action /JavaScript', 'action /Launch', 'action /SubmitForm', 'action /ImportData', 'action /GoToR',
    'annotation /FileAttachment', 'annotation /Screen', 'annotation /Movie', 'annotation /Sound', 'annotation /RichMedia', 'annotation /3D',
    '/AA', '/JS', '/EF', '/OpenAction', '/XFA', '/Collection', '/JavaScript', '/EmbeddedFiles', 'chained /Next action', 'URI javascript:', 'URI file:']) {
    assert.ok(found.some((f) => f.includes(needle)), `the fixture should carry ${needle}`);
  }
});

test('a real build carries no script, program, submit, import, media or attachment from any route', async () => {
  const { bytes } = await buildFrom([{ filename: 'active.pdf', buffer: fixture('active.pdf') }]);
  const doc = await load(bytes);
  assert.deepEqual(activeContentIn(doc), []);
  // Document level: the bundle is a new document, and none of the source's catalog entries came along.
  for (const key of ['OpenAction', 'AA', 'AcroForm', 'Collection', 'AF', 'Names', 'Dests']) {
    assert.equal(doc.catalog.has(PDFName.of(key)), false, `catalog /${key}`);
  }
});

test('a /Next JavaScript link, a JavaScript widget, a Launch calc.exe action and a SubmitForm link are clean in a real build', async () => {
  const { bytes } = await buildFrom([{ filename: 'review4_actions.pdf', buffer: fixture('review4_actions.pdf') }]);
  assert.deepEqual(activeContentIn(await load(bytes)), []);
});

test('what is good survives: web, mail and phone links (even the ones with a chain behind them), the link to page 2, the highlight', async () => {
  const { bytes } = await buildFrom([{ filename: 'active.pdf', buffer: fixture('active.pdf') }]);
  const doc = await load(bytes);
  const onPage2 = annotationsOf(doc).filter((a) => a.page === 2);   // the source's page 1 (page 1 is the index)
  const uris = onPage2.filter((a) => a.uri).map((a) => a.uri).sort();
  // The chained and the looping links keep their own web address; what was chained behind them is gone.
  assert.deepEqual(uris, ['https://example.org/chained', 'https://example.org/good', 'https://example.org/loop', 'mailto:clerk@example.org', 'tel:+442070000000']);
  assert.deepEqual(onPage2.filter((a) => a.subtype === 'Link' && a.dest === 3).length, 1, 'the link to the source page 2 now points at bundle page 3');
  const highlight = onPage2.find((a) => a.subtype === 'Highlight');
  assert.ok(highlight && highlight.hasAP, 'the highlight keeps its appearance');
  // The annotations that had an action keep their look: the widget without a form, the square and the stamp.
  assert.deepEqual(onPage2.filter((a) => ['Square', 'Stamp', 'Widget'].includes(a.subtype)).map((a) => a.subtype).sort(), ['Square', 'Stamp', 'Widget']);
  assert.ok(onPage2.filter((a) => ['Square', 'Stamp', 'Widget'].includes(a.subtype)).every((a) => a.hasAP));
});

test('an article thread does not drag other pages in, and no orphan page is left', async () => {
  const { bytes } = await buildFrom([{ filename: 'active.pdf', buffer: fixture('active.pdf') }]);
  const doc = await load(bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(pageObjectCount(doc), 3);
});

test("the bundle's own index links, bookmarks and metadata are untouched by the clean-up", async () => {
  const { bytes } = await buildFrom([{ filename: 'clean3.pdf', buffer: fixture('clean3.pdf') }, { filename: 'active.pdf', buffer: fixture('active.pdf') }]);
  const doc = await load(bytes);
  assert.deepEqual(activeContentIn(doc), []);
  const links = annotationsOf(doc).filter((a) => a.page === 1 && a.subtype === 'Link' && a.dest >= 2);
  assert.equal(links.length, 2, 'one index link per document');
  assert.ok(readBundleIndex(doc), 'the embedded bundle index is still readable');
  assert.ok(readOutline(doc).length > 0, 'bookmarks are still there');
});

test('a document with a loop of chained actions is cleaned and does not hang', async () => {
  const src = await load(fixture('active.pdf'));
  const started = Date.now();
  prepareSourceForMerge(src);
  assert.ok(Date.now() - started < 2000);
  const copy = await PDFDocument.create();
  for (const page of await copy.copyPages(src, src.getPageIndices())) copy.addPage(page);
  assert.deepEqual(activeContentIn(await load(await copy.save())), []);
});

test('the coversheet path cleans a document the same way', async () => {
  const src = await load(fixture('active.pdf'));
  prepareSourceForMerge(src);
  const single = await PDFDocument.create();
  const [first] = await single.copyPages(src, [0]);
  single.addPage(first);
  const reloaded = await load(await single.save());
  assert.deepEqual(activeContentIn(reloaded), []);
});
