/**
 * The diagonal watermark (bundletoolWatermark.js): the opacity setting, the
 * colour, blank text, the size of a short word, and rotated pages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument, PDFName, PDFArray, PDFRef, StandardFonts, getFontkit, decodePDFRawStream,
} from '../public/js/bundletoolPdfLib.js';
import {
  drawWatermarkOnPage, applyWatermarkToDoc, watermarkOpacityFraction,
} from '../public/js/bundletoolWatermark.js';

test('watermarkOpacityFraction converts the stored 0-100 value to a 0-1 fraction', () => {
  assert.equal(watermarkOpacityFraction(50), 0.5);
  assert.equal(watermarkOpacityFraction(0), 0);
  assert.equal(watermarkOpacityFraction(100), 1);
});

test('watermarkOpacityFraction falls back to the default 0.28 when unset', () => {
  assert.equal(watermarkOpacityFraction(undefined), 0.28);
  assert.equal(watermarkOpacityFraction(null), 0.28);
  assert.equal(watermarkOpacityFraction(NaN), 0.28);
  assert.equal(watermarkOpacityFraction('not a number'), 0.28);
});

test('watermarkOpacityFraction clamps out-of-range values, same as the footer plate opacity', () => {
  assert.equal(watermarkOpacityFraction(-20), 0);
  assert.equal(watermarkOpacityFraction(150), 1);
});

/**
 * The decoded content stream of a one-page PDF, and its ExtGState `ca`
 * values by resource name. Needs a save()+load() round trip first: a
 * freshly-created in-memory page's content isn't yet a real PDFRawStream,
 * which decodePDFRawStream requires.
 */
async function pageOpsAndAlphas(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);

  let contents = page.node.get(PDFName.of('Contents'));
  if (contents instanceof PDFRef) contents = doc.context.lookup(contents);
  // A page with nothing drawn on it at all (blank watermark) has no Contents
  // entry: not an empty stream, no entry at all.
  const streams = contents == null
    ? []
    : (contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i)))
      : [contents]);
  const ops = streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('');

  const alphas = {};
  const resources = page.node.get(PDFName.of('Resources'));
  const extGState = resources && doc.context.lookup(resources.get(PDFName.of('ExtGState')));
  if (extGState) {
    for (const key of extGState.keys()) {
      const obj = doc.context.lookup(extGState.get(key));
      alphas[key.toString()] = obj.get(PDFName.of('ca'))?.asNumber();
    }
  }
  return { ops, alphas };
}

async function onePageWatermarkedPdf(text, colourHex, opacity100) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  drawWatermarkOnPage(page, font, text, colourHex, opacity100);
  return doc.save();
}

test('a configured opacity is written as a real ExtGState alpha, not just a fixed 0.28', async () => {
  const bytes = await onePageWatermarkedPdf('CONFIDENTIAL', '#999999', 65);
  const { ops, alphas } = await pageOpsAndAlphas(bytes);
  assert.match(ops, /\/GS\S*\s+gs/, 'the watermark needs an ExtGState to draw at a non-default opacity');
  const values = Object.values(alphas);
  assert.ok(values.some((v) => Math.abs(v - 0.65) < 1e-6), `expected a 0.65 alpha among ${JSON.stringify(alphas)}`);
});

test('no opacity configured draws at the default 0.28', async () => {
  const bytes = await onePageWatermarkedPdf('CONFIDENTIAL', '#999999');
  const { alphas } = await pageOpsAndAlphas(bytes);
  const values = Object.values(alphas);
  assert.ok(values.some((v) => Math.abs(v - 0.28) < 1e-6), `expected the default 0.28 alpha among ${JSON.stringify(alphas)}`);
});

test('blank watermark text draws nothing at all', async () => {
  const bytes = await onePageWatermarkedPdf('   ', '#999999', 50);
  const { ops } = await pageOpsAndAlphas(bytes);
  assert.ok(!/\bTj\b|\bTJ\b/.test(ops), 'a blank watermark must not draw any text');
});

test('applyWatermarkToDoc marks every page, carrying the configured opacity to each', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]);
  await applyWatermarkToDoc(doc, 'CONFIDENTIAL', '#999999', 40);
  const bytes = await doc.save();
  for (let i = 0; i < 3; i++) {
    const { ops, alphas } = await pageOpsAndAlphas(bytes, i);
    assert.match(ops, /\bTj\b|\bTJ\b/, `page ${i} must carry the watermark text`);
    const values = Object.values(alphas);
    assert.ok(values.some((v) => Math.abs(v - 0.4) < 1e-6), `page ${i} missing the 0.4 alpha: ${JSON.stringify(alphas)}`);
  }
});

test('applyWatermarkToDoc does nothing when the text is blank', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  doc.addPage([595.28, 841.89]);
  await applyWatermarkToDoc(doc, '', '#999999', 40);
  const bytes = await doc.save();
  const { ops } = await pageOpsAndAlphas(bytes);
  assert.ok(!/\bTj\b|\bTJ\b/.test(ops), 'a blank watermark must not draw any text');
});

test('a short word is drawn at a sane size, not letters taller than the page is wide', async () => {
  // A size that starts at 0.9 x the page's short side and only shrinks for
  // LONG text would draw a short word such as "CONFID" (a truncated
  // CONFIDENTIAL) enormous, cutting across the whole page.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const sizes = [];
  const realDrawText = page.drawText.bind(page);
  page.drawText = (t, o) => { sizes.push(o.size); return realDrawText(t, o); };
  drawWatermarkOnPage(page, font, 'CONFID', '#999999', 30);
  assert.equal(sizes.length, 1);
  assert.ok(sizes[0] <= 595.28 * 0.22 + 0.001, `size ${sizes[0]} should be capped near 0.22 x the short side`);
  assert.ok(sizes[0] >= 100, `size ${sizes[0]} should still be a bold mark`);
});

// ── Rotated pages ────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { degrees } from '../public/js/bundletoolPdfLib.js';

function haveRenderTools() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

test('the watermark reads the same way up on a page turned 90, 180 or 270 degrees', async (t) => {
  if (!haveRenderTools()) return t.skip('pdftoppm and python3-PIL are needed to compare pixels');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-wm-'));
  const make = async (w, h, rotation, name) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([w, h]);
    page.setRotation(degrees(rotation));
    await applyWatermarkToDoc(doc, 'CONFIDENTIAL', '#000000', 100);
    fs.writeFileSync(path.join(dir, name), await doc.save());
  };
  const script = `
import subprocess, sys
from PIL import Image, ImageChops
def render(p):
    stem = p[:-4]
    subprocess.run(["pdftoppm","-r","40","-png","-f","1","-l","1",p,stem], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Image.open(stem + "-1.png").convert("L")
a, b = render(sys.argv[1]), render(sys.argv[2])
if a.size != b.size: print(-1); sys.exit()
d = ImageChops.difference(a, b)
print(sum(1 for p in d.getdata() if p > 60))
`;
  try {
    for (const rotation of [90, 180, 270]) {
      // The page as it is displayed once turned (595 x 842 upright, or 842 x 595 sideways)...
      const sideways = rotation === 90 || rotation === 270;
      await make(sideways ? 842 : 595, sideways ? 595 : 842, 0, `plain${rotation}.pdf`);
      // ...against a page stored the other way about and turned to that same display.
      await make(sideways ? 595 : 595, sideways ? 842 : 842, rotation, `turned${rotation}.pdf`);
      // For 90 and 270 the stored page is 595 x 842 turned to 842 x 595; for 180 the same size turned upside down.
      const out = execFileSync('python3', ['-c', script, `plain${rotation}.pdf`, `turned${rotation}.pdf`], { cwd: dir, encoding: 'utf8' });
      const differing = Number(out.trim());
      assert.ok(differing >= 0 && differing < 40, `rotation ${rotation}: ${differing} pixels differ from the upright drawing`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
