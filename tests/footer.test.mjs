/**
 * The page-number footer.
 *
 * The blanking-rectangle negative control at the bottom of this file renders
 * pages and compares pixels, because that is the only way to test the thing
 * the blanking rectangle actually does. It skips where poppler and Pillow are
 * not installed; the CI runner has both.
 */
import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, StandardFonts, rgb, degrees, getFontkit, pdflib as pdflibNS } from '../public/js/bundletoolPdfLib.js';
import {
  drawFooterOnPage, registerPageFont, removeTaggedFooters,
  visibleToUser, visibleSize, visibleToUserMatrix, plateRect,
  inkBandAtSize, baselineFor,
  PLATE_HEIGHT, PLATE_Y, PLATE_PADDING, FOOTER_STREAM_KEY,
} from '../public/js/bundletoolFooter.js';
import { countLinkAnnotations } from '../public/js/bundletoolLinks.js';
import {
  applyPageNumbering, buildFooterTexts, FOOTER_FONT_URL, footerFontUrl,
} from '../public/js/bundletoolPages.js';
import { validFonts } from '../public/js/bundletoolConfig.js';

const ROTATIONS = [0, 90, 180, 270];

async function pageWithFooter(rotation, text, opts = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.setRotation(degrees(rotation));
  page.drawText('Body content', { x: 60, y: 700, size: 18, font });
  drawFooterOnPage(doc, page, {
    text, font, fontKey: registerPageFont(page, font), fontSize: 12,
    colour: rgb(0.072, 0.021, 0.073), align: 'centre', ...opts,
  });
  return { doc, page, font };
}

test('plate geometry matches the BundleToolCLI reference', () => {
  // page_number_box_rect(): width = text width + 20, height 26, y = 8, centred.
  const r = plateRect(100, 595.28, 'centre');
  assert.equal(r.width, 100 + PLATE_PADDING);
  assert.equal(r.height, PLATE_HEIGHT);
  assert.equal(r.y, PLATE_Y);
  assert.equal(r.x, 595.28 / 2 - r.width / 2);
});

test('the visible-space transform maps page corners where they physically are', () => {
  const W = 400;
  const H = 800;
  assert.deepEqual(visibleSize(0, W, H), { width: 400, height: 800 });
  assert.deepEqual(visibleSize(90, W, H), { width: 800, height: 400 });
  assert.deepEqual(visibleSize(180, W, H), { width: 400, height: 800 });
  assert.deepEqual(visibleSize(270, W, H), { width: 800, height: 400 });

  // The displayed bottom-left corner, in unrotated user space.
  assert.deepEqual(visibleToUser(0, W, H, 0, 0), [0, 0]);
  assert.deepEqual(visibleToUser(90, W, H, 0, 0), [W, 0]);
  assert.deepEqual(visibleToUser(180, W, H, 0, 0), [W, H]);
  assert.deepEqual(visibleToUser(270, W, H, 0, 0), [0, H]);
});

test('the transform is a pure rotation: no scaling or skew creeps in', () => {
  for (const r of ROTATIONS) {
    const [a, b, c, d] = visibleToUserMatrix(r, 400, 800);
    assert.equal(Math.abs(a * d - b * c), 1, `rotation ${r} must preserve area`);
  }
});

test('an unknown rotation falls back to upright rather than throwing', () => {
  assert.deepEqual(visibleToUserMatrix(45, 400, 800), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(visibleToUserMatrix(-90, 400, 800), visibleToUserMatrix(270, 400, 800));
});

test('the footer draws on every rotation and lands in the bottom band', async () => {
  for (const rotation of ROTATIONS) {
    const { doc, page } = await pageWithFooter(rotation, 'Bundle Page 7');
    const bytes = await doc.save();
    assert.ok(bytes.length > 0, `rotation ${rotation} produced no output`);

    // The visible bottom edge is a DIFFERENT PHYSICAL EDGE for each rotation.
    // Rotating a page 90 degrees clockwise for display puts its right-hand edge
    // along the bottom, so that is where the footer must physically sit.
    // Measuring the y coordinate regardless of rotation would fail a correctly
    // placed footer.
    const { width, height } = page.getMediaBox();
    const v = visibleSize(rotation, width, height);
    const plate = plateRect(60, v.width, 'centre');
    const [ux, uy] = visibleToUser(rotation, width, height, plate.x, plate.y);

    const distanceToExpectedEdge = {
      0:   uy,           // bottom
      90:  width - ux,   // right
      180: height - uy,  // top
      270: ux,           // left
    }[rotation];

    assert.ok(
      Math.abs(distanceToExpectedEdge - PLATE_Y) < 0.01,
      `rotation ${rotation}: the footer should sit ${PLATE_Y}pt from the edge displayed at the `
      + `bottom, but is ${distanceToExpectedEdge.toFixed(2)}pt from it`,
    );
  }
});

test('a page box that does not start at the origin is respected', () => {
  // A CropBox offset from (0,0) must shift the whole footer with it, or the
  // footer is drawn outside the region the reader displays.
  const [a, b, c, d, e, f] = visibleToUserMatrix(0, 400, 800, 30, 50);
  assert.deepEqual([a, b, c, d], [1, 0, 0, 1]);
  assert.deepEqual([e, f], [30, 50]);
  assert.deepEqual(visibleToUser(0, 400, 800, 10, 20, 30, 50), [40, 70]);
  // ...and the offset composes with rotation rather than replacing it.
  assert.deepEqual(visibleToUser(90, 400, 800, 0, 0, 30, 50), [430, 50]);
});

test('the footer is positioned against the CropBox, not the MediaBox', async () => {
  // A page cropped to the middle of a larger sheet: common in scans.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([842, 1191]);            // A3 media
  page.setCropBox(100, 200, 595.28, 841.89);        // A4 crop, offset
  drawFooterOnPage(doc, page, {
    text: 'Bundle Page 3', font, fontKey: registerPageFont(page, font),
    fontSize: 12, colour: rgb(0, 0, 0), indexPageIndex: 0,
  });

  const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
  const rect = doc.context.lookup(annots.get(0)).get(PDFName.of('Rect'));
  const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => rect.get(i).asNumber());

  const crop = page.getCropBox();
  assert.ok(y1 >= crop.y && y2 <= crop.y + crop.height,
    `footer at y ${y1}..${y2} is outside the CropBox ${crop.y}..${crop.y + crop.height}`);
  assert.ok(x1 >= crop.x && x2 <= crop.x + crop.width,
    `footer at x ${x1}..${x2} is outside the CropBox ${crop.x}..${crop.x + crop.width}`);
  // Specifically: sitting PLATE_Y up from the CropBox's bottom edge.
  assert.ok(Math.abs((y1 - crop.y) - PLATE_Y) < 0.01);
});

test('the footer links to the index page, not to page one', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 4; i++) doc.addPage([595.28, 841.89]);

  // A bundle with a coversheet: page 1 is the coversheet, the index is page 2.
  const INDEX_PAGE_INDEX = 1;
  doc.getPages().forEach((page, i) => {
    drawFooterOnPage(doc, page, {
      text: `Bundle Page ${i + 1}`, font, fontKey: registerPageFont(page, font),
      fontSize: 12, colour: rgb(0, 0, 0), indexPageIndex: INDEX_PAGE_INDEX,
    });
  });

  const reread = await PDFDocument.load(await doc.save());
  const indexPageRef = reread.getPage(INDEX_PAGE_INDEX).ref;
  for (const page of reread.getPages()) {
    const annots = reread.context.lookup(page.node.get(PDFName.of('Annots')));
    assert.ok(annots, 'every page should carry a footer link');
    const annot = reread.context.lookup(annots.get(0));
    const dest = reread.context.lookup(annot.get(PDFName.of('Dest')));
    assert.equal(dest.get(0).tag, indexPageRef.tag,
      'the footer link must target the index page');
  }
});

test('the footer link is clickable where the footer is drawn', async () => {
  for (const rotation of ROTATIONS) {
    const { doc, page } = await pageWithFooter(rotation, 'Bundle Page 7', { indexPageIndex: 0 });
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    const rect = doc.context.lookup(annots.get(0)).get(PDFName.of('Rect'));
    const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => rect.get(i).asNumber());
    assert.ok(x2 > x1 && y2 > y1, `rotation ${rotation}: /Rect must be normalised`);
    const { width, height } = page.getMediaBox();
    assert.ok(x1 >= -1 && x2 <= width + 1, `rotation ${rotation}: /Rect off the page horizontally`);
    assert.ok(y1 >= -1 && y2 <= height + 1, `rotation ${rotation}: /Rect off the page vertically`);
  }
});

test('adding a footer link does not discard annotations already on the page', async () => {
  const { doc, page, font } = await pageWithFooter(0, 'Bundle Page 1', { indexPageIndex: 0 });
  assert.equal(countLinkAnnotations(doc, page), 1);
  drawFooterOnPage(doc, page, {
    text: 'Bundle Page 2', font, fontKey: registerPageFont(page, font),
    fontSize: 12, colour: rgb(0, 0, 0), indexPageIndex: 0,
  });
  assert.equal(countLinkAnnotations(doc, page), 2, '/Annots must be appended to, not replaced');
});

test('the footer goes into its own tagged content stream', async () => {
  const { doc, page } = await pageWithFooter(0, 'Bundle Page 3');
  const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  let tagged = 0;
  for (let i = 0; i < contents.size(); i++) {
    const s = doc.context.lookup(contents.get(i));
    if (s?.dict?.get(PDFName.of(FOOTER_STREAM_KEY)) != null) tagged++;
  }
  assert.equal(tagged, 1);
});

test('tagged footers can be removed exactly, leaving the page content alone', async () => {
  const { doc, page } = await pageWithFooter(0, 'Bundle Page 3');
  const before = doc.context.lookup(page.node.get(PDFName.of('Contents'))).size();
  assert.equal(removeTaggedFooters(doc), 1);
  const after = doc.context.lookup(page.node.get(PDFName.of('Contents'))).size();
  assert.equal(after, before - 1);
  assert.equal(removeTaggedFooters(doc), 0, 'removal is idempotent');
});

// ── The negative control ─────────────────────────────────────────────────────

function haveRenderTools() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Renders page 1 of each PDF and returns the count of pixels that differ.
 */
function pixelDiff(pdfA, pdfB, dir) {
  const script = `
import subprocess, sys
from PIL import Image, ImageChops
def render(p):
    stem = p[:-4]
    subprocess.run(["pdftoppm","-r","150","-png","-f","1","-l","1",p,stem], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Image.open(stem + "-1.png").convert("L")
a, b = render(sys.argv[1]), render(sys.argv[2])
if a.size != b.size:
    print(-1); sys.exit()
d = ImageChops.difference(a, b)
print(sum(1 for p in d.get_flattened_data() if p > 8))
`;
  const out = execFileSync('python3', ['-c', script, pdfA, pdfB], { cwd: dir, encoding: 'utf8' });
  return Number(out.trim());
}

test('NEGATIVE CONTROL: the blanking rectangle stops re-bundled footers stacking', async (t) => {
  if (!haveRenderTools()) return skip('pdftoppm and python3-PIL are needed to compare pixels');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-blank-'));

  // The scenario blanking is FOR, given that every page of a document gets the
  // same plate: last month's bundle ran to 99 pages, so its plate was sized for
  // "Bundle Page 99". It is re-bundled into a 7-page bundle, whose plate is one
  // digit narrower. The old plate therefore sticks out either side of the new
  // one, and only the blanking rectangle's overhang covers it.
  //
  // Within one document this cannot arise at all: the plates are identical, so
  // the new plate covers the old exactly. That is why this control has to use
  // two different document widths to have anything left to prove. The gap it
  // covers is bounded: one digit at 12pt is 3.3pt each side, inside the 8pt
  // overhang. A previous bundle far wider than that is removed rather than
  // blanked, which is what bundletoolRestore.js is for.
  const build = async (rotation, first, second, drawBlanking) => {
    let doc = await PDFDocument.create();
    let font = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595.28, 841.89]);
    page.setRotation(degrees(rotation));
    page.drawText('Body content that must survive', { x: 60, y: 700, size: 18, font });

    const stamp = (d, p, f, text, widest, blank) => drawFooterOnPage(d, p, {
      text, font: f, fontKey: registerPageFont(p, f), fontSize: 12,
      colour: rgb(0.072, 0.021, 0.073), align: 'centre',
      maxTextWidth: f.widthOfTextAtSize(widest, 12),
      indexPageIndex: 0, drawBlanking: blank,
    });

    if (first) {
      stamp(doc, page, font, first, 'Bundle Page 99', true);
      doc = await PDFDocument.load(await doc.save());
      font = await doc.embedFont(StandardFonts.HelveticaBold);
      stamp(doc, doc.getPage(0), font, second, 'Bundle Page 7', drawBlanking);
    } else {
      stamp(doc, page, font, second, 'Bundle Page 7', drawBlanking);
    }
    return doc.save();
  };

  for (const rotation of ROTATIONS) {
    const ref = path.join(dir, `ref_${rotation}.pdf`);
    const on = path.join(dir, `on_${rotation}.pdf`);
    const off = path.join(dir, `off_${rotation}.pdf`);
    fs.writeFileSync(ref, await build(rotation, null, 'Bundle Page 7', true));
    fs.writeFileSync(on, await build(rotation, 'Bundle Page 99', 'Bundle Page 7', true));
    fs.writeFileSync(off, await build(rotation, 'Bundle Page 99', 'Bundle Page 7', false));

    assert.equal(pixelDiff(ref, on, dir), 0,
      `rotation ${rotation}: with blanking, a re-bundled page must be identical to a clean single pass`);

    // The control. If this ever reads 0, the blanking rectangle has stopped
    // doing anything and the test above has stopped meaning anything.
    assert.ok(pixelDiff(ref, off, dir) > 0,
      `rotation ${rotation}: NEGATIVE CONTROL FAILED: removing the blanking changed nothing, `
      + 'so this test does not prove the blanking works');
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Plate colour and opacity ─────────────────────────────────────────────────

/** The decoded text of the page's tagged footer content stream. */
function footerStreamText(doc, page) {
  const { PDFArray: PA, PDFRef: PR, decodePDFRawStream: dec } = pdflibNS;
  let contents = page.node.get(PDFName.of('Contents'));
  if (contents instanceof PR) contents = doc.context.lookup(contents);
  const streams = contents instanceof PA
    ? Array.from({ length: contents.size() }, (_, i) => doc.context.lookup(contents.get(i)))
    : [contents];
  for (const s of streams) {
    if (s?.dict?.get?.(PDFName.of(FOOTER_STREAM_KEY)) == null) continue;
    if (typeof s.getUnencodedContents === 'function') return Buffer.from(s.getUnencodedContents()).toString('latin1');
    return Buffer.from(dec(s).decode()).toString('latin1');
  }
  return null;
}

test('plate opacity 0 draws no box at all (no plate, no blanking) but keeps the number', async () => {
  const { doc, page } = await pageWithFooter(0, 'Bundle Page 1', { plateOpacity: 0 });
  const ops = footerStreamText(doc, page);
  assert.ok(ops, 'the tagged footer stream must still exist');
  assert.ok(!/\bre\b/.test(ops), `no rectangle belongs in a boxless footer: ${ops}`);
  assert.ok(/\bTj\b|\bTJ\b/.test(ops), 'the page number itself must still be drawn');
});

test('a custom plate colour is drawn in that colour; the default keeps the CLI grey', async () => {
  const custom = await pageWithFooter(0, 'Bundle Page 1', { plateColour: rgb(1, 0.9, 0.8) });
  const customOps = footerStreamText(custom.doc, custom.page);
  assert.match(customOps, /1 0\.9 0\.8 rg/, 'the plate must be filled in the chosen colour');

  const stock = await pageWithFooter(0, 'Bundle Page 1');
  const stockOps = footerStreamText(stock.doc, stock.page);
  assert.match(stockOps, /0\.958 g/, 'the default plate is the CLI\'s composited grey');
});

test('a translucent plate gets a real ExtGState alpha and skips the blanking', async () => {
  const { doc, page } = await pageWithFooter(0, 'Bundle Page 1', { plateOpacity: 0.4 });
  const ops = footerStreamText(doc, page);
  assert.match(ops, /\/GS\S*\s+gs/, 'a translucent plate needs an ExtGState');
  // Exactly one rectangle: the plate. The opaque white blanking under a
  // translucent plate would composite straight back into a box.
  assert.equal((ops.match(/\bre\b/g) || []).length, 1, `expected only the plate rectangle: ${ops}`);
});

// ── Centring ─────────────────────────────────────────────────────────────────

const CV = {
  'pageNumbering.footerPrefix': 'Bundle',
  'pageNumbering.alignment': 'centre',
  'pageNumbering.numberingStyle': 'PageX',
  'pageNumbering.footerFontSize': 'medium',
  'pageNumbering.pageNumberColour': 'black',
  'pageNumbering.pageNumberPerSection': false,
};

async function blankPages(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([595.28, 841.89]);
  return doc.save();
}

test('no footer label carries a character the reader cannot see', () => {
  // pdf-lib draws an invisible character such as U+200B with the advance width
  // of the glyph it maps to (the space, in Liberation Sans), so two of them
  // would be 10pt of whitespace inside a box sized to include them, pushing the
  // label off centre. Nothing invisible belongs in this string.
  const { texts } = buildFooterTexts({ ...CV }, [], 5);
  // Zero-width and bidi-control characters, written as escapes so the pattern
  // survives being copied through an editor.
  const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]');
  for (const t of texts) {
    assert.ok(!INVISIBLE.test(t), `footer label ${JSON.stringify(t)} contains an invisible character`);
  }
  assert.equal(texts[0], 'Bundle Page 1');
});

test('the label is centred in the plate by the width it is actually drawn at', async () => {
  // The failure this guards is measuring with one font and drawing with
  // another. Both numbers here come from the same font object, so the padding
  // either side of the label must be exactly equal.
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(
    await fetch(FOOTER_FONT_URL).then((r) => r.arrayBuffer()),
  );
  for (const text of ['Bundle Page 1', 'Bundle Page 999', 'Bundle Page 1000']) {
    const widest = font.widthOfTextAtSize('Bundle Page 1000', 18);
    const plate = plateRect(widest, 595.28, 'centre');
    const w = font.widthOfTextAtSize(text, 18);
    const left = (plate.width - w) / 2;
    const right = plate.width - w - left;
    assert.ok(Math.abs(left - right) < 1e-9, `${text}: ${left} left vs ${right} right`);
    assert.ok(left >= PLATE_PADDING / 2 - 1e-9,
      `${text}: only ${left.toFixed(2)}pt of padding: a four-digit label does not fit`);
  }
});

test('the baseline centres the ink band, and falls back cleanly when it cannot', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(
    await fetch(FOOTER_FONT_URL).then((r) => r.arrayBuffer()),
  );
  const texts = ['Bundle Page 1', 'Bundle Page 1000'];
  const ink = inkBandAtSize(font, texts, 18);
  assert.ok(ink && ink.top > 0 && ink.bottom < 0, `expected an ink band, got ${JSON.stringify(ink)}`);

  const plate = plateRect(200, 595.28, 'centre', font.heightAtSize(18) + 10);
  const baseline = baselineFor(plate.y, plate.height, ink);
  const above = (plate.y + plate.height) - (baseline + ink.top);
  const below = (baseline + ink.bottom) - plate.y;
  assert.ok(Math.abs(above - below) < 1e-9, `${above} above vs ${below} below`);

  // A standard-14 font has no outlines to measure; the CLI's fixed baseline is
  // used instead of guessing.
  const std = await doc.embedFont(StandardFonts.HelveticaBold);
  assert.equal(inkBandAtSize(std, texts, 18), null);
  assert.equal(baselineFor(8, 26, null), 8 + 8);
});

// ── Measured centring, against rendered pixels ───────────────────────────────

/**
 * Renders one page and reports, in points, the grey plate's box and the dark
 * ink's box. The plate is drawn at 0.958 grey and the text well below 0.5, so
 * a greyscale render separates them without any knowledge of the layout.
 *
 * The two bounding boxes are found with point()+getbbox() rather than a Python
 * loop over the pixels. This runs at 600dpi over every selectable footer font,
 * where such a loop would be 2.5 million interpreted iterations per page.
 * point() builds a 256-entry lookup table and getbbox() scans in C, so the
 * same numbers come back in a fraction of the time. "The same numbers" is
 * checked rather than assumed: see 'the pixel measurement agrees with a direct
 * pixel-by-pixel scan' below.
 *
 * PIL and poppler only. Nothing here needs numpy, which is not
 * guaranteed on every machine that runs the suite.
 */
function measureFooter(pdf, dir, page = 1, dpi = 300) {
  const script = `
import subprocess, sys, glob
from PIL import Image
pdf, page, dpi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
# The stem MUST be unique per (pdf, page, dpi). pdftoppm names its output
# <stem>-<page>.png, so a stem shared between pages leaves several files
# matching the glob and the sorted-first one is always page 1: page 1 measured
# three times over, believed to be three different pages, passes every
# comparison, because a page compared with itself always matches.
stem = "%s-m%d-p%d" % (pdf[:-4], dpi, page)
subprocess.run(["pdftoppm","-r",str(dpi),"-f",str(page),"-l",str(page),"-gray","-png",pdf,stem],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
rendered = sorted(glob.glob(stem + "-*.png"))
if len(rendered) != 1:
    print("ambiguous:" + str(len(rendered))); sys.exit()
im = Image.open(rendered[0]).convert("L")
w, h = im.size
s = 72.0 / dpi
top = h - int(60 / s)
band = im.crop((0, top, w, h))
plate = band.point(lambda v: 255 if 230 <= v <= 252 else 0).getbbox()
ink   = band.point(lambda v: 255 if v < 128 else 0).getbbox()
if plate is None or ink is None:
    print("none"); sys.exit()
def out(b):
    # getbbox() is (left, upper, right, lower) within the band; shift back to
    # page coordinates, then flip to PDF's bottom-left origin.
    x0, y0, x1, y1 = b[0], b[1] + top, b[2], b[3] + top
    return [x0*s, (h-y1)*s, x1*s, (h-y0)*s]
print(" ".join(f"{v:.4f}" for v in out(plate) + out(ink)))
`;
  const raw = execFileSync('python3', ['-c', script, pdf, String(page), String(dpi)],
    { cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
  if (raw.startsWith('ambiguous:')) {
    throw new Error(`measureFooter: ${raw.split(':')[1]} renders matched one page's glob: the measurement would be of the wrong page`);
  }
  if (raw === 'none') return null;
  const n = raw.split(/\s+/).map(Number);
  return {
    plate: { x0: n[0], y0: n[1], x1: n[2], y1: n[3] },
    ink: { x0: n[4], y0: n[5], x1: n[6], y1: n[7] },
  };
}

const offset = (m) => ({
  dx: ((m.ink.x0 + m.ink.x1) - (m.plate.x0 + m.plate.x1)) / 2,
  dy: ((m.ink.y0 + m.ink.y1) - (m.plate.y0 + m.plate.y1)) / 2,
});

test('MEASURED: the rendered label is centred in its plate on both axes', async (t) => {
  if (!haveRenderTools()) return skip('pdftoppm and python3-PIL are needed to measure pixels');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-centre-'));
  try {
    const good = path.join(dir, 'good.pdf');
    fs.writeFileSync(good, await applyPageNumbering(await blankPages(1), CV, [], null));
    const m = measureFooter(good, dir);
    assert.ok(m, 'nothing was rendered to measure');

    const { dx, dy } = offset(m);
    // The residual is the difference between the advance widths the layout is
    // built from and the ink's own side bearings, plus one 300dpi pixel of
    // quantisation. Half a point is comfortably inside both.
    assert.ok(Math.abs(dx) < 0.5, `label is ${dx.toFixed(2)}pt off centre horizontally`);
    assert.ok(Math.abs(dy) < 0.5, `label is ${dy.toFixed(2)}pt off centre vertically`);

    // The control: a label with two zero-width spaces, which are measured into
    // the plate's width but drawn as ordinary spaces, so the label shifts right
    // by half of what they add. If this reads as centred, the measurement above
    // is not measuring anything.
    const doc = await PDFDocument.create();
    doc.registerFontkit(await getFontkit());
    const font = await doc.embedFont(await fetch(FOOTER_FONT_URL).then((r) => r.arrayBuffer()));
    const page = doc.addPage([595.28, 841.89]);
    drawFooterOnPage(doc, page, {
      text: '\u200B\u200BBundle Page 1', font, fontKey: registerPageFont(page, font),
      fontSize: 18, colour: rgb(0.072, 0.021, 0.073), align: 'centre',
    });
    const bad = path.join(dir, 'bad.pdf');
    fs.writeFileSync(bad, await doc.save());
    const control = offset(measureFooter(bad, dir));
    assert.ok(control.dx > 4,
      `NEGATIVE CONTROL FAILED: the known-off-centre case measured ${control.dx.toFixed(2)}pt, `
      + 'so this test cannot tell centred from off-centre');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MEASURED: a four-digit page number still fits its plate', async (t) => {
  if (!haveRenderTools()) return skip('pdftoppm and python3-PIL are needed to measure pixels');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-4digit-'));
  try {
    // Per-section labels let a three-page document be numbered 999, 1000, 1001
    // without building a thousand-page fixture.
    const pdf = path.join(dir, 'wide.pdf');
    fs.writeFileSync(pdf, await applyPageNumbering(
      await blankPages(3),
      { ...CV, 'pageNumbering.pageNumberPerSection': true },
      ['999', '1000', '1001'], null,
    ));

    const plates = [];
    for (const page of [1, 2, 3]) {
      const m = measureFooter(pdf, dir, page);
      assert.ok(m, `page ${page} rendered no footer`);
      plates.push(m.plate);

      // The ink has to be inside the plate, with the CLI's 10pt padding intact.
      assert.ok(m.ink.x0 - m.plate.x0 > 8, `page ${page}: label overflows the plate on the left`);
      assert.ok(m.plate.x1 - m.ink.x1 > 8, `page ${page}: label overflows the plate on the right`);
      assert.ok(Math.abs(offset(m).dx) < 0.5, `page ${page}: label is off centre`);
    }

    // And the box itself does not move or resize across the 999/1000 boundary.
    for (const p of plates) {
      assert.ok(Math.abs(p.x0 - plates[0].x0) < 0.2 && Math.abs(p.x1 - plates[0].x1) < 0.2,
        'the plate changes width between three-digit and four-digit pages');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Every selectable footer font ─────────────────────────────────────────────

/**
 * The direct measurement: a Python loop over every pixel in the band. It is
 * here so the fast measureFooter() can be checked against it rather than
 * trusted: a bug in the measuring harness would report a footer broken (or
 * fine) on the strength of the harness alone, so the harness gets its own
 * check.
 */
function measureFooterSlow(pdf, dir, page = 1, dpi = 300) {
  const script = `
import subprocess, sys, glob
from PIL import Image
pdf, page, dpi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
stem = "%s-slow%d-p%d" % (pdf[:-4], dpi, page)   # unique per page: see measureFooter
subprocess.run(["pdftoppm","-r",str(dpi),"-f",str(page),"-l",str(page),"-gray","-png",pdf,stem],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
rendered = sorted(glob.glob(stem + "-*.png"))
if len(rendered) != 1:
    print("ambiguous:" + str(len(rendered))); sys.exit()
im = Image.open(rendered[0]).convert("L")
w, h = im.size
px = im.load()
s = 72.0 / dpi
top = h - int(60 / s)
plate = ink = None
def grow(box, x, y):
    if box is None: return [x, y, x + 1, y + 1]
    return [min(box[0], x), min(box[1], y), max(box[2], x + 1), max(box[3], y + 1)]
for y in range(top, h):
    for x in range(w):
        v = px[x, y]
        if 230 <= v <= 252: plate = grow(plate, x, y)
        elif v < 128: ink = grow(ink, x, y)
if plate is None or ink is None:
    print("none"); sys.exit()
def out(b):
    return [b[0]*s, (h-b[3])*s, b[2]*s, (h-b[1])*s]
print(" ".join(f"{v:.4f}" for v in out(plate) + out(ink)))
`;
  const raw = execFileSync('python3', ['-c', script, pdf, String(page), String(dpi)],
    { cwd: dir, encoding: 'utf8' }).trim();
  if (raw.startsWith('ambiguous:')) throw new Error(`measureFooterSlow: ${raw}`);
  if (raw === 'none') return null;
  const n = raw.split(/\s+/).map(Number);
  return {
    plate: { x0: n[0], y0: n[1], x1: n[2], y1: n[3] },
    ink: { x0: n[4], y0: n[5], x1: n[6], y1: n[7] },
  };
}

test('HARNESS CHECK: the pixel measurement agrees with a direct pixel-by-pixel scan', async (t) => {
  if (!haveRenderTools()) return skip('pdftoppm and python3-PIL are needed to measure pixels');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-harness-'));
  try {
    const pdf = path.join(dir, 'h.pdf');
    fs.writeFileSync(pdf, await applyPageNumbering(await blankPages(1), CV, [], null));
    const fast = measureFooter(pdf, dir, 1, 300);
    const slow = measureFooterSlow(pdf, dir, 1, 300);
    assert.ok(fast && slow, 'both measurements must find a footer');
    assert.deepEqual(fast, slow,
      'the fast measurement disagrees with the direct scan; the per-font results below cannot be trusted');

    // And it really measures the page it was asked for. Without this, the
    // per-page assertions in this file could be comparing page 1 with itself,
    // and could not fail.
    const multi = path.join(dir, 'multi.pdf');
    fs.writeFileSync(multi, await applyPageNumbering(
      await blankPages(3),
      { ...CV, 'pageNumbering.pageNumberPerSection': true },
      ['9', '1000', '9'], null,
    ));
    const p1 = measureFooter(multi, dir, 1, 300);
    const p2 = measureFooter(multi, dir, 2, 300);
    const p3 = measureFooter(multi, dir, 3, 300);
    const inkWidth = (m) => m.ink.x1 - m.ink.x0;
    assert.ok(inkWidth(p2) - inkWidth(p1) > 10,
      `page 2 ("Bundle Page 1000") should have visibly wider ink than page 1 ("Bundle Page 9"), `
      + `but measured ${inkWidth(p1).toFixed(2)}pt vs ${inkWidth(p2).toFixed(2)}pt: the page argument is being ignored`);
    assert.ok(Math.abs(inkWidth(p3) - inkWidth(p1)) < 0.5,
      'pages 1 and 3 carry the same label and must measure the same');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Where the ink of `text` sits horizontally relative to the box the layout
 * centres: the box being the sum of the advance widths pdf-lib draws with.
 *
 * Centring by advance width is the right thing to do and it does NOT put the
 * ink dead centre: a glyph's outline does not fill its advance, so a label
 * beginning with 'B' and ending in '1' has more empty space on one side than
 * the other. That difference is a property of the typeface, not a defect, and
 * this function is what lets the measured test below say how much of the
 * residual is expected rather than shrugging at a loose tolerance.
 *
 * @returns {number} points; negative means the ink sits left of the box centre
 */
function predictedInkOffset(font, text, size) {
  const fk = font.embedder.font;
  const bbox = fk.layout(text).bbox;
  const scale = size / fk.unitsPerEm;
  return ((bbox.minX + bbox.maxX) / 2) * scale - font.widthOfTextAtSize(text, size) / 2;
}

test('MEASURED at 600dpi: every selectable footer font is centred in its plate', async (t) => {
  if (!haveRenderTools()) return skip('pdftoppm and python3-PIL are needed to measure pixels');

  // The footer font is a free choice, so the geometry has to come out right
  // for whatever font is chosen. Every font in validFonts is rendered and
  // measured on its own pixels at 600dpi: one 300dpi pixel of quantisation cut
  // in half.
  //
  // Three pages numbered 999, 1000 and 1001 do triple duty: the arithmetic and
  // the pixels are checked on each, and the plate is checked to be identical
  // across all three, which is the "one plate size per document" guarantee:
  // the plate is sized from the widest label in the document, not from each
  // page's own.
  //
  // TOLERANCES, and why they are not all 0. The arithmetic is exact and is
  // asserted as exact. The pixels are not: the widest measured residual across
  // the seven fonts is 0.84pt, Charis SIL drawing "Bundle Page 1001", and it is
  // the glyph side bearings described above rather than anything the layout
  // does. The off-centre case this family of tests exists to catch is 5pt,
  // and the negative control in 'MEASURED: the rendered label is centred'
  // reproduces it and requires it to exceed 4pt, so a 1.0pt bound here still
  // separates centred from off-centre by a factor of five.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-fonts-'));
  try {
    const labels = ['999', '1000', '1001'];
    for (const fontKey of validFonts) {
      const cv = {
        ...CV,
        'pageNumbering.footerFont': fontKey,
        'pageNumbering.pageNumberPerSection': true,
      };
      const pdf = path.join(dir, `f_${fontKey}.pdf`);
      fs.writeFileSync(pdf, await applyPageNumbering(await blankPages(3), cv, labels, null));

      // The same font object the drawing path used, for the arithmetic checks.
      const probe = await PDFDocument.create();
      probe.registerFontkit(await getFontkit());
      const font = await probe.embedFont(
        await fetch(footerFontUrl(fontKey)).then((r) => r.arrayBuffer()),
      );
      const texts = labels.map((n) => `Bundle Page ${n}`);
      const widest = Math.max(...texts.map((t2) => font.widthOfTextAtSize(t2, 18)));

      const plates = [];
      for (let i = 0; i < 3; i++) {
        const page = i + 1;
        const text = texts[i];

        // 1. The arithmetic, exactly: the plate is sized from the widest label
        //    and this label is centred inside it by the width it is drawn at.
        const plate = plateRect(widest, 595.28, 'centre', font.heightAtSize(18) + 10);
        const w = font.widthOfTextAtSize(text, 18);
        const left = (plate.width - w) / 2;
        assert.ok(Math.abs(left - (plate.width - w - left)) < 1e-9,
          `${fontKey} page ${page}: the layout itself is not centred`);
        assert.ok(left >= PLATE_PADDING / 2 - 1e-9,
          `${fontKey} page ${page}: only ${left.toFixed(2)}pt of padding`);

        // 2. The pixels.
        const m = measureFooter(pdf, dir, page, 600);
        assert.ok(m, `${fontKey}: page ${page} rendered no footer to measure`);
        plates.push(m.plate);

        const { dx, dy } = offset(m);
        assert.ok(Math.abs(dx) < 1.0,
          `${fontKey} page ${page} ("${text}"): label is ${dx.toFixed(2)}pt off centre horizontally`);
        assert.ok(Math.abs(dy) < 0.5,
          `${fontKey} page ${page} ("${text}"): label is ${dy.toFixed(2)}pt off centre vertically`);

        // 3. And the residual is the side bearings, not a layout error. If the
        //    ink lands somewhere the font's own glyph boxes do not predict,
        //    something other than the typeface is moving it.
        const predicted = predictedInkOffset(font, text, 18);
        assert.ok(Math.abs(dx - predicted) < 0.6,
          `${fontKey} page ${page}: ink is ${dx.toFixed(2)}pt off centre but the font's glyph boxes `
          + `predict ${predicted.toFixed(2)}pt: the difference is not explained by the typeface`);

        // 4. The label stays inside the plate with the CLI's padding intact,
        //    whatever the font's side bearings do.
        assert.ok(m.ink.x0 - m.plate.x0 > 8, `${fontKey} page ${page}: label overflows the plate on the left`);
        assert.ok(m.plate.x1 - m.ink.x1 > 8, `${fontKey} page ${page}: label overflows the plate on the right`);
      }

      // 5. Constant plate per document, per font: page 999 and page 1000 get
      //    the same box, in the same place, at the same height.
      for (const p of plates) {
        assert.ok(Math.abs(p.x0 - plates[0].x0) < 0.15 && Math.abs(p.x1 - plates[0].x1) < 0.15,
          `${fontKey}: the plate changes width between three-digit and four-digit pages`);
        assert.ok(Math.abs(p.y0 - plates[0].y0) < 0.15 && Math.abs(p.y1 - plates[0].y1) < 0.15,
          `${fontKey}: the plate changes height from page to page`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the footer font setting actually selects the font it names', async () => {
  // This catches a setting that is accepted and stored but ignored. Two
  // different fonts must produce two different plates for the same label,
  // because the plate is sized from the font's own advance widths.
  const widths = new Map();
  for (const fontKey of ['helvetica', 'monospaced', 'traditional']) {
    const bytes = await applyPageNumbering(
      await blankPages(1), { ...CV, 'pageNumbering.footerFont': fontKey }, [], null,
    );
    const doc = await PDFDocument.load(bytes);
    // The embedded font's BaseFont name is the plainest evidence of which file
    // was actually embedded.
    const names = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const base = obj?.get?.(PDFName.of('BaseFont'));
      if (base) names.push(String(base));
    }
    widths.set(fontKey, names.join(','));
  }
  assert.match(widths.get('helvetica'), /Liberation/i);
  assert.match(widths.get('monospaced'), /Ubuntu/i);
  assert.match(widths.get('traditional'), /Garamond/i);
});

test('an unknown footer font falls back to Liberation Sans instead of failing', async () => {
  assert.equal(footerFontUrl('texgyreheros'), FOOTER_FONT_URL);
  assert.equal(footerFontUrl('no-such-font'), FOOTER_FONT_URL);
  assert.equal(footerFontUrl(undefined), FOOTER_FONT_URL);
  assert.equal(footerFontUrl('monospaced'), '/fonts/mono/UbuntuMono-Regular.ttf');

  const bytes = await applyPageNumbering(
    await blankPages(1), { ...CV, 'pageNumbering.footerFont': 'no-such-font' }, [], null,
  );
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test('every page of one document gets exactly the same plate', () => {
  // Inside a document the box cannot change, so page 999 and page 1000 look
  // the same and neither can leave an edge of the other showing.
  const widest = 200;
  const rects = ['Bundle Page 7', 'Bundle Page 999', 'Bundle Page 1000']
    .map(() => plateRect(widest, 595.28, 'centre'));
  for (const r of rects) assert.deepEqual(r, rects[0]);
});
