/**
 * The email splitter: parts must actually fit the target, cut on document
 * boundaries, and partition the bundle exactly.
 *
 * The fixture pages carry incompressible noise images so they have realistic
 * WEIGHT: a real bundle's size lives in its scans, not its text, and a
 * splitter tested only on featherweight pages would never exercise the
 * page-boundary fallback or the size arithmetic at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeNoisePng } from './fixtures.mjs';

import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { applyMeta } from '../public/js/bundletoolMeta.js';
import {
  splitForEmail, rawCeilingForMessage,
  EMAIL_MESSAGE_CEILING_BYTES, BASE64_INFLATION, DEFAULT_TARGET_BYTES,
} from '../public/js/bundletoolSplit.js';

function havePdftotext() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function pdfText(bytes, page = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-split-'));
  try {
    const file = path.join(dir, 's.pdf');
    fs.writeFileSync(file, bytes);
    const args = page ? ['-f', String(page), '-l', String(page), file, '-'] : [file, '-'];
    return execFileSync('pdftotext', args, { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A bundle-shaped PDF: cover (1) + index (1) + documents of `pagesEach` heavy
 * pages, with the real embedded BundleIndex recording each document's start.
 */
async function makeHeavyBundle({ documents = 4, pagesEach = 3, noiseSide = 64 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let seed = 1;
  const addPage = async (label) => {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(label, { x: 60, y: 780, size: 18, font });
    const png = await doc.embedPng(makeNoisePng(noiseSide, noiseSide, seed++));
    page.drawImage(png, { x: 60, y: 300, width: 300, height: 300 });
  };
  await addPage('COVER');
  await addPage('INDEX');
  const entries = [];
  let physicalPage = 3;
  for (let d = 1; d <= documents; d++) {
    for (let p = 1; p <= pagesEach; p++) await addPage(`DOC${d} page ${p}`);
    entries.push({
      tabNumber: d, title: `Document ${d}`, date: '2026-01-01',
      filename: `doc${d}.pdf`, pageCount: pagesEach,
      beginsOnPdfPage: physicalPage, beginsOnPageOfSection: 1,
      actualPdfStartPageWithToc: physicalPage,
    });
    physicalPage += pagesEach;
  }
  const bytes = await doc.save();
  const tocEntries = [{
    sectionID: '0001', sectionNumber: 1, sectionLabel: 'A', sectionTitle: 'Documents',
    beginsOnPdfPage: 3, actualPdfStartPageWithToc: 3, entries,
  }];
  const cv = {
    'heading.claimNumber': 'AB-1', 'heading.bundleTitle': 'Split Test Bundle',
    'heading.projectName': 'P', 'heading.author': 'A',
    'index.fontFace': 'serif', 'index.dateStyle': 'DD Mon. YYYY',
    'index.outlineItemStyle': 'plain', 'index.sectionPrefix': '',
    'pageOptions.printableBundle': false, 'pageOptions.coversheet': true,
    'pageOptions.coverSource': 'uploaded',
  };
  const withMeta = await applyMeta(bytes, [], tocEntries, cv);
  const docStartPages = entries.map((e) => e.beginsOnPdfPage);
  return { bytes: withMeta, docStartPages, pageCount: 2 + documents * pagesEach };
}

/**
 * Like makeHeavyBundle, but with `sections.length` real sections (A, B, C...)
 * of `docsPerSection` one-page documents each, for exercising mode: 'section'.
 */
async function makeMultiSectionBundle({ sections = 3, docsPerSection = 2, noiseSide = 32 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let seed = 1;
  const addPage = async (label) => {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(label, { x: 60, y: 780, size: 18, font });
    const png = await doc.embedPng(makeNoisePng(noiseSide, noiseSide, seed++));
    page.drawImage(png, { x: 60, y: 300, width: 300, height: 300 });
  };
  await addPage('COVER');
  await addPage('INDEX');
  let physicalPage = 3;
  const tocEntries = [];
  const sectionStartPages = [];
  for (let s = 0; s < sections; s++) {
    const sectionLabel = String.fromCharCode(65 + s);
    const entries = [];
    sectionStartPages.push(physicalPage);
    for (let d = 1; d <= docsPerSection; d++) {
      await addPage(`SEC${sectionLabel} DOC${d}`);
      entries.push({
        tabNumber: d, title: `Section ${sectionLabel} Document ${d}`, date: '2026-01-01',
        filename: `sec${sectionLabel}-doc${d}.pdf`, pageCount: 1,
        beginsOnPdfPage: physicalPage, beginsOnPageOfSection: 1,
        actualPdfStartPageWithToc: physicalPage,
      });
      physicalPage += 1;
    }
    tocEntries.push({
      sectionID: String(s + 1).padStart(4, '0'), sectionNumber: s + 1,
      sectionLabel, sectionTitle: `Section ${sectionLabel}`,
      beginsOnPdfPage: entries[0].beginsOnPdfPage,
      actualPdfStartPageWithToc: entries[0].beginsOnPdfPage, entries,
    });
  }
  const bytes = await doc.save();
  const cv = {
    'heading.claimNumber': 'AB-1', 'heading.bundleTitle': 'Multi-Section Bundle',
    'heading.projectName': 'P', 'heading.author': 'A',
    'index.fontFace': 'serif', 'index.dateStyle': 'DD Mon. YYYY',
    'index.outlineItemStyle': 'plain', 'index.sectionPrefix': '',
    'pageOptions.printableBundle': false, 'pageOptions.coversheet': true,
    'pageOptions.coverSource': 'uploaded',
  };
  const withMeta = await applyMeta(bytes, [], tocEntries, cv);
  return { bytes: withMeta, sectionStartPages, pageCount: 2 + sections * docsPerSection };
}

// ── The arithmetic ───────────────────────────────────────────────────────────

test('the default target fits a 25,000,000-byte message after base64', () => {
  // base64 is exactly 4/3, plus a CRLF per 76 encoded chars: about +36.8%.
  assert.ok(BASE64_INFLATION > 1.36 && BASE64_INFLATION < 1.37);
  // 25,000,000 decimal for the WHOLE message; the raw ceiling lands ~18.1 MB.
  const ceiling = rawCeilingForMessage(EMAIL_MESSAGE_CEILING_BYTES);
  assert.ok(ceiling > 17_500_000 && ceiling < 18_500_000,
    `raw ceiling should be about 18 MB, got ${ceiling}`);
  // The shipped default stays under the ceiling: not 25 MB, and not MiB.
  assert.ok(DEFAULT_TARGET_BYTES <= ceiling);
  assert.equal(DEFAULT_TARGET_BYTES, 18_000_000);
});

// ── Splitting ────────────────────────────────────────────────────────────────

test('parts fit the target, cut on document boundaries, and partition the bundle', async () => {
  const { bytes, docStartPages, pageCount } = await makeHeavyBundle();
  const target = Math.ceil(bytes.length / 3) + 8_000; // force a multi-part split
  const parts = await splitForEmail(bytes, { targetBytes: target, partCover: false });

  assert.ok(parts.length >= 2, `expected a multi-part split, got ${parts.length}`);
  for (const part of parts) {
    assert.ok(part.bytes.length <= target,
      `part ${part.partNumber} is ${part.bytes.length} bytes against a target of ${target}`);
    assert.equal(part.oversize, false);
  }

  // The ranges partition 1..pageCount with no gap and no overlap.
  assert.equal(parts[0].fromPage, 1);
  for (let i = 1; i < parts.length; i++) {
    assert.equal(parts[i].fromPage, parts[i - 1].toPage + 1);
  }
  assert.equal(parts[parts.length - 1].toPage, pageCount);

  // Every later part starts exactly where a document starts: no document is
  // split across two emails.
  for (const part of parts.slice(1)) {
    assert.ok(docStartPages.includes(part.fromPage),
      `part ${part.partNumber} starts at page ${part.fromPage}, not a document boundary`);
  }

  // Seamless: nothing added, so the page counts stitch back to the original.
  let total = 0;
  for (const part of parts) {
    const partDoc = await PDFDocument.load(part.bytes);
    assert.equal(partDoc.getPageCount(), part.toPage - part.fromPage + 1);
    total += partDoc.getPageCount();
  }
  assert.equal(total, pageCount);
});

test('part covers say which part this is and what it contains', async (t) => {
  const { bytes, pageCount } = await makeHeavyBundle();
  const target = Math.ceil(bytes.length / 2) + 12_000;
  const parts = await splitForEmail(bytes, { targetBytes: target, partCover: true });
  assert.ok(parts.length >= 2);

  for (const part of parts) {
    const partDoc = await PDFDocument.load(part.bytes);
    // One added page per part: the "Bundle X of N" cover.
    assert.equal(partDoc.getPageCount(), part.toPage - part.fromPage + 1 + 1);
  }

  if (!havePdftotext()) { t.diagnostic('pdftotext missing; cover text unchecked'); return; }
  const first = pdfText(parts[0].bytes, 1);
  assert.ok(first.includes(`BUNDLE 1 OF ${parts.length}`), `part cover says: ${first}`);
  assert.ok(first.includes('Split Test Bundle'), 'the bundle title belongs on the part cover');
  assert.ok(first.includes(`pages ${parts[0].fromPage} to ${parts[0].toPage} of ${pageCount}`),
    `the cover names the pages it carries: ${first}`);
  const second = pdfText(parts[1].bytes, 1);
  assert.ok(second.includes(`BUNDLE 2 OF ${parts.length}`));
  assert.ok(second.includes('front of part 1'), 'later parts point at the index in part 1');
});

test('a bundle already under the target comes back as one part', async () => {
  const { bytes, pageCount } = await makeHeavyBundle({ documents: 2, pagesEach: 1 });
  const parts = await splitForEmail(bytes, { targetBytes: bytes.length + 100_000, partCover: false });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].fromPage, 1);
  assert.equal(parts[0].toPage, pageCount);
});

test('a single page bigger than the target ships alone, flagged oversize', async () => {
  // One one-page document whose noise image alone exceeds the target.
  const { bytes } = await makeHeavyBundle({ documents: 1, pagesEach: 1, noiseSide: 128 });
  const parts = await splitForEmail(bytes, { targetBytes: 12_000, partCover: false });
  const flagged = parts.filter((p) => p.oversize);
  assert.ok(flagged.length >= 1, 'the oversize page must be flagged, not silently shipped');
  for (const part of flagged) {
    assert.equal(part.fromPage, part.toPage, 'an oversize part is a single page');
  }
});

test('even mode keeps the part count and stays under the ceiling', async () => {
  const { bytes } = await makeHeavyBundle({ documents: 6, pagesEach: 2 });
  const target = Math.ceil(bytes.length / 2) + 12_000;
  const fill = await splitForEmail(bytes, { targetBytes: target, mode: 'fill', partCover: false });
  const even = await splitForEmail(bytes, { targetBytes: target, mode: 'even', partCover: false });
  assert.ok(even.length <= fill.length,
    `even mode must not need more parts (${even.length}) than fill (${fill.length})`);
  for (const part of even) assert.ok(part.bytes.length <= target);
  // Evenness: the largest part in even mode is no bigger than fill's largest.
  const maxOf = (parts) => Math.max(...parts.map((p) => p.bytes.length));
  assert.ok(maxOf(even) <= maxOf(fill) + 5_000);
});

// ── Split by section ─────────────────────────────────────────────────────────

test('section mode makes a part for the cover and index, then one per section', async () => {
  const { bytes, sectionStartPages, pageCount } = await makeMultiSectionBundle({ sections: 3, docsPerSection: 2 });
  const parts = await splitForEmail(bytes, { mode: 'section', targetBytes: 50_000_000, partCover: false });

  assert.equal(parts.length, sectionStartPages.length + 1);
  assert.equal(parts[0].kind, 'front');
  assert.equal(parts[0].fromPage, 1);
  assert.equal(parts[0].toPage, sectionStartPages[0] - 1, 'the front part is the cover and index only');
  for (let i = 0; i < sectionStartPages.length; i++) {
    assert.equal(parts[i + 1].kind, 'section');
    assert.equal(parts[i + 1].fromPage, sectionStartPages[i], `section ${i + 1} should start where it starts`);
  }
  assert.equal(parts[parts.length - 1].toPage, pageCount);

  // Contiguous, no gap or overlap.
  for (let i = 1; i < parts.length; i++) {
    assert.equal(parts[i].fromPage, parts[i - 1].toPage + 1);
  }

  // Section labels are carried through for filename/display use.
  assert.deepEqual(parts.map((p) => p.sectionLabel), ['', 'A', 'B', 'C']);
  assert.ok(parts.every((p) => p.subPart === 0 && p.oversize === false), 'nothing was over the target, so nothing was cut further');
  assert.ok(parts.every((p) => p.bundleTitle === 'Multi-Section Bundle'));
});

test('a section over the size target is cut further by size and labelled part N of M', async () => {
  const { bytes } = await makeMultiSectionBundle({ sections: 2, docsPerSection: 4, noiseSide: 96 });
  const whole = await splitForEmail(bytes, { mode: 'section', targetBytes: 50_000_000, partCover: false });
  const sectionA = whole.find((p) => p.sectionLabel === 'A');
  // A target that fits about half of section A: it must come back in pieces, in order, under the target.
  const target = Math.ceil(sectionA.bytes.length * 0.6);
  const parts = await splitForEmail(bytes, { mode: 'section', targetBytes: target, partCover: false });
  const pieces = parts.filter((p) => p.sectionLabel === 'A');
  assert.ok(pieces.length >= 2, 'section A was not cut further');
  pieces.forEach((p, i) => { assert.equal(p.subPart, i + 1); assert.equal(p.subPartCount, pieces.length); });
  assert.equal(pieces[0].fromPage, sectionA.fromPage);
  assert.equal(pieces[pieces.length - 1].toPage, sectionA.toPage);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].fromPage, parts[i - 1].toPage + 1);
  assert.deepEqual(parts.map((p) => p.partNumber), parts.map((_, i) => i + 1), 'parts stay numbered in order');
  assert.ok(parts.every((p) => p.partCount === parts.length));
});

test('a bundle with no recorded sections comes back whole in section mode', async () => {
  const plain = await PDFDocument.create();
  for (let i = 0; i < 3; i++) plain.addPage([595.28, 841.89]);
  const parts = await splitForEmail(await plain.save(), { mode: 'section', targetBytes: 50_000_000, partCover: false });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'whole');
});

test('section mode with a generous target is not flagged oversize', async () => {
  const { bytes } = await makeMultiSectionBundle({ sections: 2, docsPerSection: 1 });
  const parts = await splitForEmail(bytes, { mode: 'section', targetBytes: 50_000_000, partCover: false });
  assert.equal(parts.length, 3, 'cover and index, then two sections');
  for (const part of parts) assert.equal(part.oversize, false);
});

test('section mode part covers still say which part this is', async (t) => {
  const { bytes } = await makeMultiSectionBundle({ sections: 2, docsPerSection: 1 });
  const parts = await splitForEmail(bytes, { mode: 'section', targetBytes: 50_000_000, partCover: true });
  assert.equal(parts.length, 3);
  for (const part of parts) {
    const partDoc = await PDFDocument.load(part.bytes);
    assert.equal(partDoc.getPageCount(), part.toPage - part.fromPage + 1 + 1);
  }
  if (!havePdftotext()) { t.diagnostic('pdftotext missing; cover text unchecked'); return; }
  const first = pdfText(parts[0].bytes, 1);
  assert.ok(first.includes(`BUNDLE 1 OF ${parts.length}`), `part cover says: ${first}`);
});

// ── Oversize is judged against the user's target ─────────────────────────────

test('an even split is flagged oversize only when a part really exceeds the user\'s target', async () => {
  const { bytes } = await makeHeavyBundle();
  // Two-part split: "even" aims each part at half, well under the target. None of them is over it.
  const target = Math.ceil(bytes.length / 2) + 40_000;
  const parts = await splitForEmail(bytes, { targetBytes: target, mode: 'even', partCover: true });
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.ok(part.bytes.length <= target);
    assert.equal(part.oversize, false, `part ${part.partNumber} (${part.bytes.length} bytes) is under ${target}`);
  }
});

// ── What a part's page range is called ───────────────────────────────────────

import { describePartPages } from '../public/js/bundletoolSplit.js';

test('a part cover names page numbers that match the footers, or says PDF pages when they would not', () => {
  const sections = [{ files: [{ page: 4 }, { page: 9 }] }];   // three pages of cover and index
  const cfg = (pageNumbering) => ({ config: { pageNumbering }, sections });
  // Plain continuous numbering: the printed number is the PDF position.
  assert.equal(describePartPages(cfg({ numberingStyle: 'PageX', frontMatterNumbering: 'continuous' }), 4, 8, 20).text,
    'bundle pages 4 to 8 of 20');
  // Skipped or roman front matter: documents restart at 1, so page 4 prints as 1.
  assert.equal(describePartPages(cfg({ numberingStyle: 'PageX', frontMatterNumbering: 'skip' }), 4, 8, 20).text,
    'bundle pages 1 to 5 of 17');
  assert.equal(describePartPages(cfg({ numberingStyle: 'PageX', frontMatterNumbering: 'roman' }), 1, 3, 20).text,
    'the cover and index (PDF pages 1 to 3 of 20)');
  // Numbers per section (C1, C2 ...) or no numbers at all: nothing printed to match, so say PDF pages.
  assert.equal(describePartPages(cfg({ numberingStyle: 'PageX', pageNumberPerSection: true }), 4, 8, 20).text,
    'PDF pages 4 to 8 of 20');
  assert.equal(describePartPages(cfg({ numberingStyle: 'None' }), 4, 8, 20).text, 'PDF pages 4 to 8 of 20');
  // A bundle with no readable index falls back to plain continuous numbering.
  assert.equal(describePartPages(null, 1, 5, 5).text, 'bundle pages 1 to 5 of 5');
});
