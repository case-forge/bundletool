/**
 * The index's own "Page" column must name the number that actually appears on that page's
 * footer, not the page's raw physical position in the finished PDF. Under 'continuous' those
 * are the same number. Under 'roman' and 'skip' the footer restarts the documents at 1,
 * subtracting the front matter (cover plus index pages) from the physical position. The index
 * (bundletoolToc.js, makeTocPages) makes the same subtraction; without it the index would print a
 * page number that matches nothing in the bundle.
 *
 * Built with the real engine (tests/realBundle.mjs: the same createTocEntries/makeTocPages/
 * buildBundlePdf path the CLI and the browser use), then read back with pdftotext so both the
 * index text and every page's own footer text come from the finished PDF, not from a value the
 * test computed the same way the code under test computes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRealBundle } from './realBundle.mjs';

const HAVE_PDFTOTEXT = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** The text of one page, 1-based, whitespace collapsed. */
function pageText(bytes, pageNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-toc-fm-'));
  try {
    const file = path.join(dir, 's.pdf');
    fs.writeFileSync(file, bytes);
    return execFileSync('pdftotext', ['-layout', '-f', String(pageNumber), '-l', String(pageNumber), file, '-'], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The number after "Page " on a page, or null if there is none (front matter under 'skip'). */
function footerNumberOn(bytes, pageNumber) {
  const m = pageText(bytes, pageNumber).match(/Page (\d+)/);
  return m ? Number(m[1]) : null;
}

/** The number printed in the index's own "Page" column for a document title, or null if not found. */
function indexNumberFor(indexText, title) {
  const line = indexText.split('\n').find((l) => l.includes(title));
  if (!line) return null;
  const m = line.trim().match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

const SECTIONS = [
  { name: 'Applications', docs: [{ title: 'Case Summary', pages: 2 }, { title: 'Chronology', pages: 1 }] },
  { name: 'Statements', docs: [{ title: 'Statement of Applicant', pages: 3 }, { title: 'Statement of Respondent', pages: 2 }] },
];

for (const front of ['continuous', 'roman', 'skip']) {
  test(`a real bundle's index page numbers match the printed footers, front matter numbering '${front}'`, { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the built pages' }, async () => {
    const built = await buildRealBundle({ sections: SECTIONS, options: { pageNumbering: { frontMatterNumbering: front } } });
    const indexPageNumber = built.indexPages >= 1 ? (1 /* cover */ + 1) : 1; // index starts right after the cover
    const indexText = Array.from({ length: built.indexPages }, (_, i) => pageText(built.bytes, indexPageNumber + i)).join('\n');
    for (const { title, start } of built.docs) {
      const indexPage = indexNumberFor(indexText, title);
      const footerPage = footerNumberOn(built.bytes, start);
      assert.ok(indexPage !== null, `'${title}' is in the index (front matter '${front}')`);
      assert.ok(footerPage !== null, `page ${start} ('${title}') has a footer page number (front matter '${front}')`);
      assert.equal(indexPage, footerPage, `the index says '${title}' is at page ${indexPage}, but its own footer (physical page ${start}) says ${footerPage} (front matter '${front}')`);
    }
  });
}

test("front matter numbering 'continuous': the cover and index count towards the same sequence as the documents", { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the built pages' }, async () => {
  const built = await buildRealBundle({ sections: SECTIONS, options: { pageNumbering: { frontMatterNumbering: 'continuous' } } });
  assert.equal(footerNumberOn(built.bytes, 1), 1, 'the cover (physical page 1) reads "Page 1" under continuous numbering');
  assert.equal(footerNumberOn(built.bytes, 2), 2, 'the index page (physical page 2) reads "Page 2" under continuous numbering');
});

test("front matter numbering 'skip': the cover and index carry no page number at all", { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the built pages' }, async () => {
  const built = await buildRealBundle({ sections: SECTIONS, options: { pageNumbering: { frontMatterNumbering: 'skip' } } });
  assert.equal(footerNumberOn(built.bytes, 1), null, 'the cover has no footer number');
  assert.equal(footerNumberOn(built.bytes, 2), null, 'the index page has no footer number');
});

test("front matter numbering 'roman': the cover and index are both numbered in lower case roman numerals, in order", { skip: !HAVE_PDFTOTEXT && 'pdftotext is needed to read the built pages' }, async () => {
  const built = await buildRealBundle({ sections: SECTIONS, options: { pageNumbering: { frontMatterNumbering: 'roman' } } });
  assert.match(pageText(built.bytes, 1), /\bi\b/, 'the cover carries the roman numeral i');
  assert.match(pageText(built.bytes, 2), /\bii\b/, 'the index page carries the roman numeral ii');
});
