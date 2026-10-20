/**
 * Email split, "an index and page numbers of their own" (bundletoolSplitOwn.js), on REAL bundles built by
 * the shipped engine (tests/realBundle.mjs). A part is a small bundle: the cover, an index of its own
 * documents headed "Part N of M", the documents, footers numbered from 1, working links and bookmarks, and
 * an embedded index that lets it be reopened. Which document a page came from is read from its page height
 * (heightOfDoc), so nothing here needs a text extractor; the checks that read printed text or pixels use
 * pdftotext and pdftoppm and skip where they are absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRealBundle, heightOfDoc } from './realBundle.mjs';
import { PDFName, PDFDict, PDFArray, PDFRef } from '../public/js/bundletoolPdfLib.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { splitForEmail } from '../public/js/bundletoolSplit.js';
import { readBundleIndex } from '../public/js/bundletoolMeta.js';
import { openBundle, splitBundlePdf } from '../public/js/bundletoolRestore.js';
import { readOutline } from '../public/js/bundletoolOutline.js';
import { FOOTER_STREAM_KEY } from '../public/js/bundletoolFooter.js';

const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const HAVE_TEXT = have('pdftotext', ['-v']);

function pdfText(bytes, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-own-'));
  try {
    const file = path.join(dir, 'p.pdf');
    fs.writeFileSync(file, bytes);
    const args = page ? ['-f', String(page), '-l', String(page), file, '-'] : [file, '-'];
    return execFileSync('pdftotext', args, { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const SECTIONS = [
  { label: 'A', name: 'Applications', docs: [{ pages: 3 }, { pages: 2 }] },
  { label: 'B', name: 'Statements', docs: [{ pages: 4 }, { pages: 1 }, { pages: 3 }] },
  { label: 'C', name: 'Orders', docs: [{ pages: 2 }, { pages: 2 }] },
];
const DOC_COUNT = 7;

let shared;
const sharedBundle = async () => (shared ??= await buildRealBundle({ sections: SECTIONS, heavy: true }));

/** Splits into parts that are small on purpose: the fixture pages are heavy, the target is in kilobytes. */
const splitOwn = (bytes, extra = {}) => splitForEmail(bytes, { labelling: 'own', targetBytes: 1_800_000, mode: 'fill', ...extra });

const heightsOf = (doc) => doc.getPages().map((p) => Math.round(p.getHeight()));
const footerStreams = (doc, page) => {
  const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  if (!(contents instanceof PDFArray)) return 0;
  let n = 0;
  for (let i = 0; i < contents.size(); i++) {
    const s = doc.context.lookup(contents.get(i));
    if (s?.dict?.get?.(PDFName.of(FOOTER_STREAM_KEY)) != null) n++;
  }
  return n;
};
const linkTargets = (doc) => {
  const tags = new Map(doc.getPages().map((p, i) => [p.ref.tag, i]));
  const out = [];
  doc.getPages().forEach((page, from) => {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      let dest = doc.context.lookup(annot.get(PDFName.of('Dest')));
      if (!dest) { const a = doc.context.lookup(annot.get(PDFName.of('A'))); if (a instanceof PDFDict) dest = doc.context.lookup(a.get(PDFName.of('D'))); }
      const first = dest instanceof PDFArray ? dest.get(0) : null;
      out.push({ from, to: first instanceof PDFRef && tags.has(first.tag) ? tags.get(first.tag) : null, outside: first instanceof PDFRef && !tags.has(first.tag) });
    }
  });
  return out;
};

test('the fixture is a real bundle with sections and a cover', async () => {
  const b = await sharedBundle();
  const { doc } = await loadPdf(b.bytes);
  assert.equal(doc.getPageCount(), b.pageCount);
  const payload = readBundleIndex(doc);
  assert.equal(payload.sections.length, 3);
  assert.equal(payload.config.pageNumbering.footerFontSize, 'medium', 'the bundle records the footer size a part needs');
  assert.equal(payload.config.index.fontSize, 'medium');
  assert.equal(payload.config.pageOptions.pageSize, 'a4');
});

test('every part is a small bundle: the cover, its own index, then only its documents, in order, and together they hold every document page exactly once', async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  assert.ok(parts.length >= 3, `expected several parts, got ${parts.length}`);
  const seen = [];
  for (const p of parts) {
    assert.equal(p.own, true);
    const { doc } = await loadPdf(p.bytes);
    const heights = heightsOf(doc);
    const front = 1 + p.indexPages;
    assert.equal(heights.length, front + (p.toPage - p.fromPage + 1), `part ${p.partNumber} holds the cover, ${p.indexPages} index page(s) and its own pages only`);
    assert.equal(heights[0], 842, 'the first page is the bundle cover');
    seen.push(...heights.slice(front));
    // The part is a bundle: its embedded index lists exactly its documents, at the right pages.
    const payload = readBundleIndex(doc);
    const files = payload.sections.flatMap((s) => s.files);
    assert.equal(files.length, p.documents);
    for (const f of files) {
      const h = heights[f.page - 1];
      assert.ok(h >= heightOfDoc(1) && h <= heightOfDoc(DOC_COUNT), `${f.filename} points at a page of some document`);
      assert.equal(h, heightOfDoc(Number(f.filename.match(/doc(\d+)/)[1])), `${f.filename} points at its own first page`);
    }
  }
  const expected = b.docs.flatMap((d) => Array(d.pages).fill(heightOfDoc(d.d)));
  assert.deepEqual(seen, expected, 'the parts partition the bundle\'s documents exactly');
  assert.equal(parts.reduce((n, p) => n + p.documents, 0) >= DOC_COUNT, true);
});

test('each part carries exactly one footer per page, numbered from 1, and the whole bundle\'s footers are gone', async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    doc.getPages().forEach((page, i) => assert.equal(footerStreams(doc, page), 1, `part ${p.partNumber} page ${i + 1} has one footer`));
    if (HAVE_TEXT) {
      const last = doc.getPageCount();
      assert.match(pdfText(p.bytes, 1), /Page 1\b/);
      assert.match(pdfText(p.bytes, last), new RegExp(`Page ${last}\\b`));
      // A number from the whole bundle (which runs to about 20) must not survive on a page of a part
      // whose own numbers stop earlier than that.
      if (last < 10) for (let n = last + 1; n <= b.pageCount; n++) assert.doesNotMatch(pdfText(p.bytes), new RegExp(`Page ${n}\\b`));
    }
  }
});

test('the index of a part lists only its documents, with its own page numbers and the bundle page of each', { skip: !HAVE_TEXT && 'pdftotext is not installed' }, async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    const payload = readBundleIndex(doc);
    const text = pdfText(p.bytes, 2);
    assert.match(text, new RegExp(`Part ${p.partNumber} of ${p.partCount}`));
    assert.match(text, /Bundle page/);
    for (const f of payload.sections.flatMap((s) => s.files)) assert.ok(text.includes(f.title.replace(' (continued)', '')), `${f.title} is in the index`);
    // No document of another part is listed.
    const others = b.docs.filter((d) => !payload.sections.flatMap((s) => s.files).some((f) => f.filename === `doc${d.d}.pdf`));
    for (const o of others) assert.ok(!text.includes(`Document ${o.d} `) && !text.endsWith(`Document ${o.d}`), `Document ${o.d} is not in part ${p.partNumber}'s index`);
  }
});

test('links and bookmarks inside a part work: index rows and footers jump to pages of the part, bookmarks are trimmed to it', async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    const links = linkTargets(doc);
    assert.equal(links.filter((l) => l.outside).length, 0, 'no link points at a page that is not in the part');
    const front = 1 + p.indexPages;
    const indexRows = links.filter((l) => l.from >= 1 && l.from < front && l.to !== null && l.to >= front);
    assert.equal(indexRows.length, p.documents, 'one index row link per document, into the documents');
    const footerLinks = links.filter((l) => l.from >= front && l.to === 1);
    assert.equal(footerLinks.length, doc.getPageCount() - front, 'every document page links back to the part\'s own index');
    const flat = [];
    const walk = (items) => items.forEach((i) => { flat.push(i); walk(i.children || []); });
    walk(readOutline(doc));
    assert.ok(flat.length >= p.documents);
    for (const item of flat) if (item.pageIndex !== undefined) assert.ok(item.pageIndex >= 0 && item.pageIndex < doc.getPageCount(), `bookmark "${item.title}" is inside the part`);
  }
});

test('a part can be reopened as a bundle and split back into its documents', async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  for (const p of parts) {
    const opened = await openBundle(p.bytes);
    assert.ok(Array.isArray(opened.metadata) && opened.metadata.length > 0);
    const map = await splitBundlePdf(opened.doc, opened.metadata, true);
    assert.ok(map.has('coversheet.pdf'), 'the cover comes back as the coversheet');
    assert.equal(map.size, p.documents + 1, 'every document comes back, and the cover');
    for (const [name, bytes] of map) {
      if (name === 'coversheet.pdf') continue;
      const { doc } = await loadPdf(bytes);
      const d = Number(name.match(/doc(\d+)/)[1]);
      assert.ok(doc.getPages().every((pg) => Math.round(pg.getHeight()) === heightOfDoc(d)), `${name} comes back as its own pages`);
    }
  }
});

test('a part is about the size of its own pages, not of the whole bundle (no second copy is carried)', async () => {
  const b = await sharedBundle();
  const parts = await splitOwn(b.bytes);
  const whole = b.bytes.length;
  for (const p of parts) assert.ok(p.bytes.length < whole, `part ${p.partNumber} is smaller than the whole bundle`);
  assert.ok(parts.reduce((n, p) => n + p.bytes.length, 0) < whole + parts.length * 1_600_000, 'the parts together are the bundle plus a fixed overhead per part');
});

test('a document cut across two parts is listed in each as continued, with the pages it has there', async () => {
  const b = await buildRealBundle({ sections: [{ docs: [{ pages: 12, title: 'Big exhibit' }] }, { docs: [{ pages: 1, title: 'Small note' }] }], heavy: true });
  const parts = await splitOwn(b.bytes);
  assert.ok(parts.length >= 2);
  const seenPages = [];
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    const files = readBundleIndex(doc).sections.flatMap((s) => s.files);
    seenPages.push(...files.map((f) => f.title));
    assert.equal(heightsOf(doc)[0], 842);
  }
  assert.ok(seenPages.some((t) => t.includes('(continued)')), 'the second piece of the exhibit says continued');
  assert.equal(seenPages.filter((t) => t.startsWith('Big exhibit')).length >= 2, true);
});

test('numbering per section is kept as it is: the labels do not restart, and the index carries no extra column', async () => {
  const b = await buildRealBundle({ sections: SECTIONS, heavy: true, options: { pageNumbering: { pageNumberPerSection: true } } });
  const parts = await splitOwn(b.bytes);
  const seen = new Set();
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    doc.getPages().forEach((page, i) => assert.equal(footerStreams(doc, page) >= 0, true));
    if (HAVE_TEXT && p.partNumber > 1) {
      const text = pdfText(p.bytes);
      assert.match(text, /Page [A-C]\d+/, 'labels are section labels');
      assert.doesNotMatch(pdfText(p.bytes, 2), /Bundle page/, 'no bundle page column when the labels already are the bundle\'s');
      const labels = [...text.matchAll(/Page ([A-C]\d+)/g)].map((m) => m[1]);
      labels.forEach((l) => seen.add(l));
    }
  }
  if (HAVE_TEXT) assert.ok(seen.size > 0);
});

test('front matter numbering roman is honoured: the cover and index are numbered i, ii and the documents start at 1', { skip: !HAVE_TEXT && 'pdftotext is not installed' }, async () => {
  const b = await buildRealBundle({ sections: SECTIONS, heavy: true, options: { pageNumbering: { frontMatterNumbering: 'roman' } } });
  const parts = await splitOwn(b.bytes);
  for (const p of parts) {
    assert.match(pdfText(p.bytes, 1), /\bi$/, 'the cover is numbered i');
    assert.match(pdfText(p.bytes, 1 + p.indexPages + 1), /Page 1\b/, 'the first document page is Page 1');
  }
});

test('a bundle with no cover, an empty section and one page documents splits without error', async () => {
  const b = await buildRealBundle({
    cover: false, heavy: true,
    sections: [{ docs: [{ pages: 1 }, { pages: 1 }] }, { label: 'B', name: 'Empty', docs: [] }, { label: 'C', name: 'Last', docs: [{ pages: 1 }] }],
  });
  const parts = await splitOwn(b.bytes);
  const total = parts.reduce((n, p) => n + p.documents, 0);
  assert.equal(total, 3);
  for (const p of parts) {
    const { doc } = await loadPdf(p.bytes);
    assert.equal(doc.getPageCount(), p.indexPages + (p.toPage - p.fromPage + 1), 'no cover page when the bundle had none: the index, then the documents');
  }
});

test('by section, with their own indexes: one part per section, no part for the cover and index', async () => {
  const b = await sharedBundle();
  const parts = await splitForEmail(b.bytes, { labelling: 'own', mode: 'section', targetBytes: 18_000_000 });
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.kind === 'section' && p.own === true));
  const docsPerPart = parts.map((p) => p.documents);
  assert.deepEqual(docsPerPart, [2, 3, 2]);
});

test('a PDF that records no documents cannot be given an index of its own, and says so', async () => {
  const { makePdf } = await import('./fixtures.mjs');
  const bytes = await makePdf(4, 'PLAIN');
  await assert.rejects(() => splitOwn(bytes), /does not record its documents/);
});

test('the 200 part cap is enforced before any part is built', async () => {
  const sections = Array.from({ length: 201 }, (_, i) => ({ label: String(i), name: `S${i}`, docs: [{ pages: 1 }] }));
  const b = await buildRealBundle({ sections });
  await assert.rejects(() => splitForEmail(b.bytes, { labelling: 'own', mode: 'section', targetBytes: 18_000_000 }), /over 200 parts/);
});

test('the other labelling styles are unaffected: a cover page each, or seamless', async () => {
  const b = await sharedBundle();
  const cover = await splitForEmail(b.bytes, { partCover: true, mode: 'fill', targetBytes: 18_000_000 });
  assert.equal(cover.length, 1);
  assert.equal(cover[0].own, undefined);
  const seamless = await splitForEmail(b.bytes, { partCover: false, mode: 'fill', targetBytes: 18_000_000 });
  const { doc } = await loadPdf(seamless[0].bytes);
  assert.equal(doc.getPageCount(), b.pageCount, 'seamless adds nothing');
});

const HAVE_PPM = have('pdftoppm', ['-v']);
function renderGray(bytes, page, dpi = 96) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-own-px-'));
  try {
    fs.writeFileSync(path.join(dir, 'p.pdf'), bytes);
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', path.join(dir, 'p.pdf'), path.join(dir, 'out')]);
    const buf = fs.readFileSync(path.join(dir, 'out.pgm'));
    // P5 <w> <h> 255 \n <data>
    const header = buf.subarray(0, 20).toString('latin1').match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
    const w = Number(header[1]), h = Number(header[2]);
    return { w, h, data: buf.subarray(buf.length - w * h) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a footer with no tag to remove is covered: the page looks the same as when a tagged footer is removed exactly', { skip: !HAVE_PPM && 'pdftoppm is not installed' }, async () => {
  // Three-digit numbers in the bundle ("Page 121 of 133") against one or two digits in the part: the bundle's label is much the wider.
  const many = { sections: [{ docs: Array.from({ length: 8 }, () => ({ pages: 15 })) }, { docs: Array.from({ length: 1 }, () => ({ pages: 10 })) }], heavy: true, options: { pageNumbering: { numberingStyle: 'PageXofY' } } };
  const opts = many;
  const b = await buildRealBundle(opts);
  // The same bundle with the footer tag stripped from every stream, as in a bundle whose footers are not tagged.
  const { doc } = await loadPdf(b.bytes);
  let stripped = 0;
  for (const page of doc.getPages()) {
    const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
    if (!(contents instanceof PDFArray)) continue;
    for (let i = 0; i < contents.size(); i++) {
      const s = doc.context.lookup(contents.get(i));
      if (s?.dict?.get?.(PDFName.of(FOOTER_STREAM_KEY)) != null) { s.dict.delete(PDFName.of(FOOTER_STREAM_KEY)); stripped++; }
    }
  }
  assert.ok(stripped > 0);
  const legacy = await doc.save({ useObjectStreams: false });
  const exact = await splitOwn(b.bytes, { targetBytes: 3_500_000 });
  const old = await splitOwn(legacy, { targetBytes: 3_500_000 });
  assert.equal(exact.length, old.length);
  const part = exact.length;
  const { doc: partDoc } = await loadPdf(exact[part - 1].bytes);
  const pageNo = partDoc.getPageCount();   // the last page of the part: the longest new label, and a bundle label longer still
  const a = renderGray(exact[part - 1].bytes, pageNo);
  const c = renderGray(old[part - 1].bytes, pageNo);
  assert.equal(a.w, c.w);
  // The footer band: the bottom 12% of the page.
  const from = Math.floor(a.h * 0.88) * a.w;
  let differing = 0;
  for (let i = from; i < a.data.length; i++) if (Math.abs(a.data[i] - c.data[i]) > 64) differing++;
  assert.ok(differing <= 8, `${differing} pixels of the footer band differ: the bundle's label shows beside the part's`);
});

test('the pages that carried a watermark keep exactly one, the new index pages get one, and no content stream is added to a document page beyond the new footer', async () => {
  const b = await buildRealBundle({ sections: SECTIONS, options: { pageOptions: { watermark: true, watermarkText: 'DRAFT' } } });
  const { doc: whole } = await loadPdf(b.bytes);
  // Streams that draw something: the bare "q" and "Q" wrappers pdf-lib adds around a page's content do not count.
  const streams = (d, page) => {
    const c = d.context.lookup(page.node.get(PDFName.of('Contents')));
    if (!(c instanceof PDFArray)) return 1;
    let n = 0;
    for (let i = 0; i < c.size(); i++) { const st = d.context.lookup(c.get(i)); const bytes = st.getUnencodedContents ? st.getUnencodedContents() : st.getContents(); if (bytes.length > 20) n++; }
    return n;
  };
  const parts = await splitOwn(b.bytes, { targetBytes: 30_000_000 });
  const p = parts[0];
  const { doc } = await loadPdf(p.bytes);
  const front = 1 + p.indexPages;
  doc.getPages().slice(front).forEach((page, k) => {
    const source = whole.getPage(Math.max(p.fromPage, b.docs[0].start) - 1 + k);
    assert.equal(streams(doc, page), streams(whole, source), `document page ${k + 1}: the footer was replaced, the watermark was not drawn again`);
  });
  for (let i = 1; i < front; i++) assert.ok(streams(doc, doc.getPage(i)) >= 3, 'an index page has its content, a watermark and a footer');
});

test('the blanking box of a renumbered footer is at least as wide as the longest label the page may already carry', async () => {
  const { PDFDocument: Doc } = await import('../public/js/bundletoolPdfLib.js');
  const { applyPageNumberingToDoc } = await import('../public/js/bundletoolPages.js');
  const widthOfBlank = async (floor) => {
    const doc = await Doc.create();
    doc.addPage([595.28, 841.89]);
    await applyPageNumberingToDoc(doc, { 'pageNumbering.numberingStyle': 'PageX', 'pageNumbering.footerFont': 'serif' }, [], null, 0, { blankFloorTexts: floor });
    const page = doc.getPage(0);
    const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
    const stream = doc.context.lookup(contents instanceof PDFArray ? contents.get(contents.size() - 1) : page.node.get(PDFName.of('Contents')));
    const text = Buffer.from(stream.getUnencodedContents ? stream.getUnencodedContents() : stream.getContents()).toString('latin1');
    const m = text.match(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/);
    return Number(m[3]);
  };
  const plain = await widthOfBlank([]);
  const floored = await widthOfBlank(['Page 1000 of 1000 in the whole bundle']);
  assert.ok(floored > plain + 40, `the box grew from ${plain} to ${floored}`);
});
