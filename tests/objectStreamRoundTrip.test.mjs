/**
 * A document that is loaded, changed and saved by this tool must read back with the change.
 *
 * pdf-lib keeps a loaded file's object streams and writes them out unchanged beside the new copies of
 * the objects inside them. A viewer follows the cross-reference table and shows the new copy; pdf-lib
 * scans the file and, when the old object stream comes after the page objects (as it does in files from
 * many producers), lets the stale copy win. The OCR step saves a scanned document with an invisible text
 * layer and the build loads it again, so with the stale copies the bundle would hold the original pages
 * and no searchable text. loadPdf() drops the object streams so a save holds each object once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  PDFDocument, PDFName, PDFArray, StandardFonts, TextRenderingMode, decodePDFRawStream,
} from '../public/js/bundletoolPdfLib.js';
import { loadPdf, dropObjectStreams } from '../public/js/bundletoolPdfLoad.js';
import { mergeFileEntries } from '../public/js/bundletoolMerge.js';

/**
 * One page, written the way many producers do: the catalog, page tree and page live in an object
 * stream, and that stream comes after the page's content stream. Built by hand because pdf-lib's own
 * files put the stream first, where the problem does not show.
 */
function sourceWithObjectStreamLast() {
  const parts = [];
  let offset = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); offset += buf.length; };
  const at = {};
  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const content = '0.5 g 10 10 100 100 re f';
  at[4] = offset;
  push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>',
  ];
  let header = '';
  let body = '';
  objects.forEach((o, i) => { header += `${i + 1} ${body.length} `; body += `${o}\n`; });
  const stream = zlib.deflateSync(Buffer.from(header + body, 'latin1'));
  at[5] = offset;
  push(Buffer.concat([
    Buffer.from(`5 0 obj\n<< /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`, 'latin1'),
    stream, Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]));
  at[6] = offset;
  const row = (type, a, b) => Buffer.from([type, (a >> 8) & 255, a & 255, b]);
  const xref = zlib.deflateSync(Buffer.concat([
    row(0, 0, 255), row(2, 5, 0), row(2, 5, 1), row(2, 5, 2), row(1, at[4], 0), row(1, at[5], 0), row(1, at[6], 0),
  ]));
  push(Buffer.concat([
    Buffer.from(`6 0 obj\n<< /Type /XRef /Size 7 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /Length ${xref.length} >>\nstream\n`, 'latin1'),
    xref, Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]));
  push(`startxref\n${at[6]}\n%%EOF\n`);
  return Uint8Array.from(Buffer.concat(parts));
}

/** What OCR does: an invisible text layer drawn over a page. */
async function addInvisibleText(doc) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText('searchable', { x: 40, y: 700, size: 12, font, renderMode: TextRenderingMode.Invisible });
}

/** The page's own content streams, joined: what a reader draws, not whatever else is in the file. */
function pageContent(doc, index = 0) {
  const entry = doc.getPage(index).node.get(PDFName.of('Contents'));
  const resolved = doc.context.lookup(entry);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [entry];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    // A stream drawn in memory is not yet encoded; one read from a file is (and may be compressed).
    const bytes = typeof stream.getUnencodedContents === 'function' ? stream.getUnencodedContents() : decodePDFRawStream(stream).decode();
    return Buffer.from(bytes).toString('latin1');
  }).join('\n');
}

test('the fixture is read as written', async () => {
  const { doc } = await loadPdf(sourceWithObjectStreamLast());
  assert.equal(doc.getPageCount(), 1);
  assert.ok(pageContent(doc).includes('re f'));
});

test('text added to a loaded document is still on the page when the saved file is loaded again', async () => {
  const { doc } = await loadPdf(sourceWithObjectStreamLast());
  await addInvisibleText(doc);
  assert.match(pageContent(doc), /3 Tr/, 'it is on the page before saving');

  const reloaded = await loadPdf(await doc.save());
  assert.match(pageContent(reloaded.doc), /3 Tr/, 'and on the page of the document loaded from the saved file');
  assert.ok(pageContent(reloaded.doc).includes('re f'), 'with the original drawing as well');
});

test('a build keeps the text layer of a source that was saved by this tool', async () => {
  const { doc } = await loadPdf(sourceWithObjectStreamLast());
  await addInvisibleText(doc);
  const merged = await mergeFileEntries([{ filename: 'scan.pdf', buffer: await doc.save() }], false, 'a4');
  const { doc: bundle } = await loadPdf(merged);
  assert.match(pageContent(bundle), /3 Tr/, 'the merged bundle still has the invisible text on the page');
});

test('loadPdf drops a file\'s object streams; a document loaded without it still has them', async () => {
  const bytes = sourceWithObjectStreamLast();
  const { doc } = await loadPdf(bytes);
  assert.equal(dropObjectStreams(doc), 0, 'loadPdf already dropped them');
  const raw = await PDFDocument.load(bytes);
  assert.equal(dropObjectStreams(raw), 2, 'the object stream and the cross-reference stream');
  assert.equal(raw.getPageCount(), 1, 'the pages are untouched');
});
