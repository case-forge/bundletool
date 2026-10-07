/**
 * The outline (bookmarks) builder.
 *
 * Written from ISO 32000-1:2008 section 12.3.3. The /Count sign convention is
 * the field most easily got wrong, so it is asserted here explicitly rather
 * than inferred from "the bookmarks look fine".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './fixtures.mjs';
import { PDFDocument, PDFName } from '../public/js/bundletoolPdfLib.js';
import { setOutline, readOutline, destinationForPage } from '../public/js/bundletoolOutline.js';

const TREE = [
  { title: 'Index', pageIndex: 0 },
  { title: 'A: Applications', pageIndex: 1, children: [
    { title: '[01] C100 Application', pageIndex: 1 },
    { title: '[02] Statement of Ms Okonkwo-Ré \u2014 «accented»', pageIndex: 4 },
  ] },
  { title: 'B: Orders', pageIndex: 6, open: false, children: [
    { title: '[03] Order of DJ Patel', pageIndex: 6 },
    { title: '[04] Order of HHJ Bennett', pageIndex: 8, children: [
      { title: '[04a] Recitals', pageIndex: 8 },
    ] },
  ] },
];

async function withOutline(tree = TREE, pages = 12) {
  const doc = await PDFDocument.load(await fx.makePdf(pages, 'BUNDLE'));
  const written = setOutline(doc, tree);
  // Reloading from bytes proves the tree survives serialisation, which is
  // where a tree of inline dictionaries rather than references falls apart.
  return { written, doc: await PDFDocument.load(await doc.save()) };
}

test('the outline reads back as a correctly nested tree', async () => {
  const { written, doc } = await withOutline();
  assert.equal(written, 8);
  const got = readOutline(doc);

  assert.deepEqual(got.map((n) => n.title), ['Index', 'A: Applications', 'B: Orders']);
  assert.deepEqual(got[1].children.map((n) => n.title),
    ['[01] C100 Application', '[02] Statement of Ms Okonkwo-Ré \u2014 «accented»']);
  assert.deepEqual(got[2].children.map((n) => n.title),
    ['[03] Order of DJ Patel', '[04] Order of HHJ Bennett']);
  assert.deepEqual(got[2].children[1].children.map((n) => n.title), ['[04a] Recitals']);
});

test('every item points at the page it names', async () => {
  const { doc } = await withOutline();
  const got = readOutline(doc);
  assert.equal(got[0].pageIndex, 0);
  assert.equal(got[1].pageIndex, 1);
  assert.equal(got[1].children[0].pageIndex, 1);
  assert.equal(got[1].children[1].pageIndex, 4);
  assert.equal(got[2].pageIndex, 6);
  assert.equal(got[2].children[1].children[0].pageIndex, 8);
});

test('/Count is positive when open and negative when closed', async () => {
  const { doc } = await withOutline();
  const got = readOutline(doc);
  assert.equal(got[0].count, null, 'a childless item has no /Count');
  assert.equal(got[1].count, 2, 'open, two visible descendants');
  assert.equal(got[2].count, -2, 'closed, minus the immediate child count');
  assert.equal(got[2].children[1].count, 1, 'open, one visible descendant');
});

test('an open item counts descendants at every level, not just its children', async () => {
  const tree = [{ title: 'S', pageIndex: 0, children: [
    { title: 'a', pageIndex: 1, children: [{ title: 'a1', pageIndex: 2 }] },
    { title: 'b', pageIndex: 3 },
  ] }];
  const { doc } = await withOutline(tree, 5);
  assert.equal(readOutline(doc)[0].count, 3, 'a + a1 + b');
});

test('a closed child hides its own descendants from the parent count', async () => {
  const tree = [{ title: 'S', pageIndex: 0, children: [
    { title: 'a', pageIndex: 1, open: false, children: [{ title: 'a1', pageIndex: 2 }] },
    { title: 'b', pageIndex: 3 },
  ] }];
  const { doc } = await withOutline(tree, 5);
  assert.equal(readOutline(doc)[0].count, 2, 'a and b are visible; a1 is not');
});

test('the outline root counts the items visible on opening', async () => {
  const { doc } = await withOutline();
  const root = doc.context.lookup(doc.catalog.get(PDFName.of('Outlines')));
  // Index + A + its 2 children + B (closed, children hidden) = 5
  assert.equal(root.get(PDFName.of('Count')).asNumber(), 5);
  assert.equal(root.get(PDFName.of('Type')), PDFName.of('Outlines'));
});

test('every item is an indirect object with a reference to its parent', async () => {
  // Inline dictionaries here are what makes readers offer to repair the file.
  const { doc } = await withOutline();
  const check = (nodes) => {
    for (const n of nodes) {
      assert.equal(n.parentTagMatches, true, `${n.title} has the wrong /Parent`);
      check(n.children);
    }
  };
  check(readOutline(doc));
});

test('non-ASCII titles survive the round trip', async () => {
  const { doc } = await withOutline();
  assert.equal(readOutline(doc)[1].children[1].title,
    '[02] Statement of Ms Okonkwo-Ré \u2014 «accented»');
});

test('destinations preserve the reader\'s zoom and target the top of the page', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(3, 'X'));
  const dest = doc.context.obj(destinationForPage(doc, 1)).toString();
  assert.match(dest, /\/XYZ/);
  assert.match(dest, /null\s*\]$/, 'a null zoom means "keep the current magnification"');
  assert.match(dest, /841\.89/, 'top of an A4 page, not its bottom');
});

test('an out-of-range page index is clamped rather than producing a broken link', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(3, 'X'));
  assert.doesNotThrow(() => destinationForPage(doc, 99));
  assert.doesNotThrow(() => destinationForPage(doc, -4));
});

test('an empty outline removes the catalog entry instead of writing an empty tree', async () => {
  const doc = await PDFDocument.load(await fx.makePdf(2, 'X'));
  setOutline(doc, [{ title: 'x', pageIndex: 0 }]);
  assert.ok(doc.catalog.get(PDFName.of('Outlines')));
  setOutline(doc, []);
  assert.equal(doc.catalog.get(PDFName.of('Outlines')), undefined);
});

test('the bundle opens with the bookmarks panel showing', async () => {
  const { doc } = await withOutline();
  assert.equal(doc.catalog.get(PDFName.of('PageMode')), PDFName.of('UseOutlines'));
});

test('a page turned by /Rotate gets the destination of the corner that shows top-left', async () => {
  const { degrees } = await import('../public/js/bundletoolPdfLib.js');
  const doc = await PDFDocument.load(await fx.makePdf(5, 'X'));
  const box = doc.getPage(0).getMediaBox();
  const expected = { 0: [box.x, box.y + box.height], 90: [box.x, box.y], 180: [box.x + box.width, box.y], 270: [box.x + box.width, box.y + box.height] };
  [0, 90, 180, 270, 90].forEach((angle, i) => { if (i < 4) doc.getPage(i).setRotation(degrees(angle)); });
  doc.getPage(4).setRotation(degrees(450));   // 450 is 90 once turned
  for (const [i, angle] of [[0, 0], [1, 90], [2, 180], [3, 270], [4, 90]]) {
    const dest = destinationForPage(doc, i);
    assert.deepEqual([dest[2].asNumber(), dest[3].asNumber()], expected[angle], `page ${i} rotated ${angle}`);
  }
});
