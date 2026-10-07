/**
 * The cover maker redraws the cover on every keystroke. Each face's bytes are fetched once per page load and its
 * parsed font is reused (bundletoolCover.js, `cachedFontkit`). That must change nothing in the output: this pins
 * that a second draw fetches no font again and is the same PDF as the first apart from the creation time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCoverPdf, flattenCoverConfig } from '../public/js/bundletoolCover.js';
import Config from '../public/js/bundletoolConfig.js';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { PDFRawStream, PDFDict, decodePDFRawStream, PDFName } from '../public/js/bundletoolPdfLib.js';

function cover(fontFace, text) {
  const c = new Config();
  c.updateOptions({ cover: { courtName: text, applicantName: 'A SMITH\nC DOE', respondentName: 'B JONES', claimNumber: 'ZC26C00123' }, index: { fontFace } });
  return flattenCoverConfig(c);
}

/**
 * Every decoded CONTENT stream (the embedded font program, the drawn text and lines), so two
 * covers can be compared without pdf-lib's own internal bookkeeping: the /XRef stream (the file's
 * own table of object numbers to byte offsets, which shifts whenever anything else in the file's
 * byte layout does and so is not evidence of a real difference); /ObjStm streams (several small
 * objects packed together, with their own internal offset table, in a packing order nothing this
 * module controls pins down); and /ToUnicode CMaps (used for text extraction only, never for
 * rendering, and built by sorting and deduplicating by glyph id: where two codepoints share one
 * id, which one "wins" the tie is not provably stable across two draws of an already-used, shared
 * font object). None of the three is content a reader sees; the streams a reader does see are
 * compared in full.
 */
async function streams(bytes) {
  const { doc } = await loadPdf(bytes);
  const out = [];
  const BOOKKEEPING_TYPES = new Set(['ObjStm', 'XRef']);
  // Excluding /ObjStm above means the Font/CIDFont dicts packed inside it (including the CIDFont's own
  // /W widths array, the one thing in there that affects where text sits on the page) would otherwise
  // never be checked: they are unpacked as plain PDFDicts, not PDFRawStreams, so the loop below never
  // sees them either. Collected separately: every indirect dict whose /Type is /Font, the keys that
  // change what is drawn or where (not /FontDescriptor or other object refs, which vary with packing
  // and prove nothing), with refs inside those values replaced by a placeholder, sorted so packing
  // order cannot matter here either.
  const RENDER_KEYS = ['Subtype', 'BaseFont', 'W', 'DW', 'Widths', 'FirstChar', 'Encoding'];
  const fontDicts = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font') {
      const row = RENDER_KEYS.map((k) => `${k}=${obj.get(PDFName.of(k))?.toString().replace(/\d+ \d+ R/g, 'REF') ?? ''}`).join(';');
      fontDicts.push(row);
    }
  }
  out.push(...fontDicts.sort());
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const type = obj.dict.get(PDFName.of('Type'));
    if (type && BOOKKEEPING_TYPES.has(type.toString().replace(/^\//, ''))) continue;
    const text = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
    if (text.includes('/CIDInit /ProcSet findresource begin')) continue;
    // The object streams also hold the document's creation and modification times, which move on between draws.
    out.push(text.replace(/D:\d{14}Z?/g, 'D:X').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, 'T:X'));
  }
  return out;
}

test('a second cover draw fetches no font again and produces the same streams', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = (...a) => { asked.push(String(a[0])); return realFetch(...a); };
  try {
    for (const face of ['serif', 'helvetica']) {
      const cv = cover(face, 'IN THE FAMILY COURT AT CENTRAL LONDON');
      const first = await makeCoverPdf(cv);
      const before = asked.length;
      const second = await makeCoverPdf(cv);
      assert.equal(asked.length, before, `${face}: the second draw fetched a font again`);
      assert.deepEqual(await streams(second), await streams(first), `${face}: the two covers differ`);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('a different text on the same fonts still draws that text, with the parsed font shared', async () => {
  const a = await streams(await makeCoverPdf(cover('serif', 'COURT ONE')));
  const b = await streams(await makeCoverPdf(cover('serif', 'COURT TWO')));
  assert.notDeepEqual(a, b, 'changing the text changes the page');
  assert.equal(a.length, b.length);
});
