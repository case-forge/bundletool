/**
 * What a source document carries beyond its page content, and what a real build does with it:
 * unapplied redaction markers are found; annotations survive; form fields become page content
 * and cannot clash; internal links are re-pointed at the pages they now occupy; scripts, launch
 * actions and attachments are left out; the bundle's own index links and metadata stay.
 *
 * The fixtures are tests/fixtures/pdf/*.pdf (regenerate with make_fixtures.py; needs pikepdf and reportlab).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString } from '../public/js/bundletoolPdfLib.js';
import { findUnappliedRedactions, describePages } from '../public/js/bundletoolPdfSafety.js';
import { readBundleIndex } from '../public/js/bundletoolMeta.js';
import { readOutline } from '../public/js/bundletoolOutline.js';
import { buildFrom, fixture } from './helpers_bundle.mjs';

const load = (bytes) => PDFDocument.load(bytes, { throwOnInvalidObject: false });
const HAVE_PDFTOTEXT = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function pdfText(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-safety-'));
  try {
    fs.writeFileSync(path.join(dir, 's.pdf'), bytes);
    return execFileSync('pdftotext', ['-layout', path.join(dir, 's.pdf'), '-'], { encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Every annotation on every page: { page (1-based), subtype, dest (page number or null), action, uri, hasAP }. */
function annotations(doc) {
  const pageNumber = new Map(doc.getPages().map((p, i) => [p.ref.tag, i + 1]));
  const out = [];
  doc.getPages().forEach((page, i) => {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let k = 0; k < annots.size(); k++) {
      const a = doc.context.lookup(annots.get(k));
      if (!(a instanceof PDFDict)) continue;
      const row = { page: i + 1, subtype: a.get(PDFName.of('Subtype')).decodeText(), dest: null, action: null, uri: null, hasAP: a.has(PDFName.of('AP')) };
      const destOf = (d) => {
        d = doc.context.lookup(d);
        return d instanceof PDFArray && d.get(0) instanceof PDFRef ? (pageNumber.get(d.get(0).tag) ?? 'not-in-tree') : 'named';
      };
      if (a.has(PDFName.of('Dest'))) row.dest = destOf(a.get(PDFName.of('Dest')));
      const act = doc.context.lookup(a.get(PDFName.of('A')));
      if (act instanceof PDFDict) {
        row.action = act.get(PDFName.of('S')).decodeText();
        if (row.action === 'GoTo') row.dest = destOf(act.get(PDFName.of('D')));
        if (row.action === 'URI') row.uri = doc.context.lookup(act.get(PDFName.of('URI'))).decodeText();
      }
      out.push(row);
    }
  });
  return out;
}

function pageObjectCount(doc) {
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) n++;
  }
  return n;
}

test('unapplied redaction markers are found, page by page', async () => {
  assert.deepEqual(findUnappliedRedactions(await load(fixture('redact.pdf'))), [2, 4]);
  assert.deepEqual(findUnappliedRedactions(await load(fixture('clean3.pdf'))), []);
  assert.deepEqual(findUnappliedRedactions(await load(fixture('annots.pdf'))), []);   // other annotations are not redactions
  assert.deepEqual(findUnappliedRedactions(await load(fixture('links.pdf'))), []);
});

test('the redaction check never throws on a document it cannot read closely', () => {
  assert.deepEqual(findUnappliedRedactions({ getPages() { throw new Error('broken'); } }), []);
  assert.deepEqual(findUnappliedRedactions(null), []);
});

test('describePages words one, two and many pages', () => {
  assert.equal(describePages([2]), 'page 2');
  assert.equal(describePages([2, 4]), 'pages 2 and 4');
  assert.equal(describePages([2, 4, 9]), 'pages 2, 4 and 9');
});

test('a real build: annotations, forms, links and active content', async () => {
  const { bytes, counts } = await buildFrom(['clean3.pdf', 'annots.pdf', 'form_a.pdf', 'form_b.pdf', 'links.pdf']
    .map((n) => ({ filename: n, buffer: fixture(n) })));
  assert.deepEqual(counts, [3, 1, 1, 1, 4]);
  const doc = await load(bytes);
  assert.equal(doc.getPageCount(), 1 + 3 + 1 + 1 + 1 + 4);   // index + documents
  const all = annotations(doc);
  const on = (page) => all.filter((a) => a.page === page);

  // Annotations with an appearance stream survive and still have it.
  const annotsPage = on(5).filter((a) => a.subtype !== 'Link');
  assert.deepEqual(annotsPage.map((a) => a.subtype).sort(), ['FreeText', 'Highlight', 'Ink', 'Stamp', 'Text']);
  assert.ok(annotsPage.every((a) => a.hasAP), 'every annotation keeps its appearance stream');

  // Filled forms became page content: no widgets, no AcroForm, and the values still print.
  assert.equal(all.filter((a) => a.subtype === 'Widget').length, 0);
  assert.equal(doc.catalog.has(PDFName.of('AcroForm')), false);
  if (HAVE_PDFTOTEXT) {
    const text = pdfText(bytes);
    assert.match(text, /Alice/);
    assert.match(text, /Bob/);
  }

  // Links: the web address is kept; the three internal links point at the pages they now occupy
  // (links.pdf starts at bundle page 8: its page 3 is bundle page 10, its page 4 is page 11);
  // Launch and JavaScript links, and the attached file, are gone.
  const links = on(8).filter((a) => a.subtype === 'Link' && a.dest !== 1);   // 1 = the footer link to the index
  assert.deepEqual(links.filter((a) => a.uri).map((a) => a.uri), ['https://example.org/']);
  assert.deepEqual(links.filter((a) => a.dest !== null).map((a) => a.dest).sort(), [10, 10, 11]);
  assert.equal(all.some((a) => a.action === 'Launch' || a.action === 'JavaScript'), false);
  assert.equal(all.some((a) => a.subtype === 'FileAttachment'), false);

  // Nothing was dragged in as an unreachable page.
  assert.equal(pageObjectCount(doc), doc.getPageCount());

  // The bundle's own links, index and bookmarks are untouched.
  assert.equal(all.filter((a) => a.page === 1 && a.subtype === 'Link' && a.dest >= 2).length, 5, 'one index link per document');
  const idx = readBundleIndex(doc);
  assert.ok(idx, 'the embedded bundle index is still readable');
  assert.ok(readOutline(doc).length > 0, 'bookmarks are still there');
});

test('form fields with the same name in two documents do not clash', async () => {
  const { bytes } = await buildFrom(['form_a.pdf', 'form_b.pdf'].map((n) => ({ filename: n, buffer: fixture(n) })));
  const doc = await load(bytes);
  assert.equal(doc.getForm().getFields().length, 0);
  if (HAVE_PDFTOTEXT) {
    const text = pdfText(bytes);
    assert.match(text, /Alice/);
    assert.match(text, /Bob/);
  }
});
