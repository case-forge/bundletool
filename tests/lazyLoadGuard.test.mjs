/**
 * A dynamic `import()`/`new Worker()`/`new SharedWorker()`/`importScripts()` call that fails almost
 * always means this tab is running an old page against a newer deployment: the specifier it names has
 * gone. Routed through /js/shared/lazy-load.js's lazyImport()/startWorker(), that shows the person the
 * same "reload to continue" toast sw-register.js already owns, then lets the failure through unchanged.
 * A bare call skips that: the person sees only whatever that one call site's own error handling happens
 * to do, which for a vendor library load is often nothing visible at all.
 *
 * Two checks, both scanning every shipped, non-vendor script:
 *
 *  1. Every bare call either goes through the helpers (so there is none at all outside
 *     /js/shared/lazy-load.js) or is on ALLOWED_CALLS with the file's EXACT current count and the reason
 *     it cannot use them: not a blanket per-file pass. Pinning the exact count means one more call in an
 *     already-listed file, not just a new file, still fails. Every first-party lazy load goes through the
 *     helpers; what is on the list is a genuine exception.
 *  2. No non-vendor script carries a static import/export-from of pdf-lib-fontkit, jspdf or
 *     jspdf-autotable, the three libraries that load lazily. A static import of any of them would make
 *     that load eager again, with every other check here still green (the bare-call scan only looks at
 *     CALL syntax, not import/export clauses).
 *
 * Both block and line comments are stripped before scanning, respecting string/template literals (so a
 * URL or any other text containing two slashes inside a string is left alone), and the call-syntax scan
 * runs against the whole file text rather than line by line, so `import`/`(` or `new`/`Worker(` split
 * across a line break are still matched: `\s` in the patterns below spans newlines, which a line-by-line
 * scan would defeat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '../public/js';

// The only bare import()/new Worker()/new SharedWorker()/importScripts() calls allowed: each
// file's EXACT count and the one-line reason it cannot go through the helpers. ANY change to a listed
// file's count, or a call in any file not listed, fails.
const ALLOWED_CALLS = {
  'bundletoolPage.js': {
    count: 1,
    reason: 'a classic script: its only way to reach lazyImport() is an import() of /js/shared/lazy-load.js itself',
  },
};

// The three libraries that load lazily: no non-vendor file may name any of them in a static
// import/export-from, in either direction (both forms bind the module at parse time, before the lazy
// getters below ever run).
const STATIC_IMPORT_TARGETS = ['pdf-lib-fontkit', 'jspdf-autotable', 'jspdf'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') yield* walk(p); }
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}

/**
 * Blanks out block and line comments (keeping line breaks, so a reported line number still points at
 * the right place), leaving string, template and regex literals untouched so two slashes, a slash-star,
 * or a quote inside one of those (a URL, or a character class like /[&<>"']/) is never mistaken for a
 * comment start or a string boundary of its own. Telling a regex from a division (both start with `/`)
 * uses the ordinary lexer heuristic, the last significant character already emitted, rather than a real
 * parser. Without it, a `/[&<>"']/g` reads as a string starting at its `"`, swallows a `//` comment
 * further down into that "string" and blinds every scan after it, the dangerous direction for a tripwire
 * test to fail in (missing a real violation, not just over-reporting one). It is still not a full parser
 * (a more unusual construct could in principle confuse it), an accepted gap for this first-party
 * codebase.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/') {
      const trimmed = out.replace(/\s+$/, '');
      const looksLikeRegexStart = trimmed === '' || /[([{,;:=&|!?+\-*%^~<>]$/.test(trimmed)
        || /\b(?:return|typeof|new|in|of|delete|throw|case|void|instanceof|yield|await)$/.test(trimmed);
      if (looksLikeRegexStart) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '\n') break;
          if (text[j] === '[') { inClass = true; j++; continue; }
          if (text[j] === ']') { inClass = false; j++; continue; }
          if (text[j] === '/' && !inClass) { j++; closed = true; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[a-z]/i.test(text[j])) j++;
          out += text.slice(i, j);
          i = j;
          continue;
        }
        // Unterminated before a newline: not a regex literal after all (or the guess was wrong). Fall
        // through and treat the slash as an ordinary character rather than risk eating the rest of
        // the file looking for a close that was never going to be a regex's.
      }
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const CALL_PATTERNS = [
  /(?:^|[^.\w$])import\s*\(/g,
  /\bnew\s+Worker\s*\(/g,
  /\bnew\s+SharedWorker\s*\(/g,
  /\bimportScripts\s*\(/g,
];

test('every bare import()/new Worker()/new SharedWorker()/importScripts() under public/js matches an exact allowlisted count', () => {
  const abs = fileURLToPath(new URL(ROOT, import.meta.url));
  let callsFound = 0;
  const seen = {};
  const locations = {};
  for (const file of walk(abs)) {
    const rel = path.relative(abs, file).split(path.sep).join('/');
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const re of CALL_PATTERNS) {
      for (const m of text.matchAll(re)) {
        callsFound++;
        seen[rel] = (seen[rel] || 0) + 1;
        (locations[rel] ||= []).push(lineOf(text, m.index));
      }
    }
  }
  assert.ok(callsFound > 0, `no call found anywhere under ${ROOT}: the scan itself may be broken`);

  const bad = [];
  for (const [file, count] of Object.entries(seen)) {
    const expected = ALLOWED_CALLS[file]?.count;
    if (expected === undefined) {
      bad.push(`${file}: ${count} call(s) found, not on the allowlist at all (lines ${locations[file].join(', ')})`);
    } else if (count !== expected) {
      bad.push(`${file}: ${count} call(s) found, allowlisted for exactly ${expected} (lines ${locations[file].join(', ')})`);
    }
  }
  for (const file of Object.keys(ALLOWED_CALLS)) {
    if (!(file in seen)) bad.push(`${file}: allowlisted for ${ALLOWED_CALLS[file].count}, found 0: the allowlist is stale, tighten it`);
  }
  assert.deepEqual(bad, [], `bare call count mismatch (route a genuinely new one through /js/shared/lazy-load.js instead):\n${bad.join('\n')}`);
});

test('every allowlisted bare call carries a count and a one-line reason', () => {
  for (const [file, entry] of Object.entries(ALLOWED_CALLS)) {
    assert.ok(Number.isInteger(entry?.count) && entry.count > 0, `${file}: count must be a positive integer`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0 && !entry.reason.includes('\n'),
      `${file}: an exception needs a one-line reason`);
  }
});

test('no non-vendor script statically imports pdf-lib-fontkit, jspdf or jspdf-autotable', () => {
  const abs = fileURLToPath(new URL(ROOT, import.meta.url));
  // Matches the `from '...'` clause directly rather than anchoring back to `import`/`export`: in valid
  // JS, a bare `from` keyword followed by a module-specifier string occurs only in an import-from or
  // export-from declaration (`import X from '...'`, `import { X } from '...'`, `export * from '...'`,
  // `export { X } from '...'`), so this covers both forms without having to also match the clause in
  // between (possibly multi-line, possibly brace-containing, possibly semicolon-free).
  const re = new RegExp(
    String.raw`\bfrom\s+(['"\`])[^'"\`]*?\/(` + STATIC_IMPORT_TARGETS.join('|') + String.raw`)\.m?js\1`,
    'g',
  );
  let filesScanned = 0;
  const bad = [];
  for (const file of walk(abs)) {
    filesScanned++;
    const rel = path.relative(abs, file).split(path.sep).join('/');
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(re)) {
      bad.push(`${rel}:${lineOf(text, m.index)}: ${m[0].trim()}`);
    }
  }
  assert.ok(filesScanned > 0, `no file scanned under ${ROOT}: the scan itself may be broken`);
  assert.deepEqual(bad, [], `a non-vendor file statically imports a library that must be loaded through its lazy getter instead:\n${bad.join('\n')}`);
});

const WORKER_SPAWN_PATTERNS = [/\bnew\s+Worker\s*\(/g, /\bstartWorker\s*\(/g];
const WATCH_PATTERN = /\bwatchForLazyLoadFailures\s*\(/g;

test('every new Worker()/startWorker() spawn site has a matching watchForLazyLoadFailures() call in the same file', () => {
  // Per file, not per call site paired to its own spawn: every site attaches its watcher immediately
  // after construction, but counting rather than pairing is all this needs, because a NEW spawn site
  // added without its watcher shows up as a count mismatch wherever in the file it lands.
  // watchForLazyLoadFailures() is harmless to attach even on a worker that never emits the message it
  // listens for (bundletoolTiffWorker.js has no lazy-loaded dependency), so no site needs an exemption.
  const abs = fileURLToPath(new URL(ROOT, import.meta.url));
  let spawnSitesFound = 0;
  const bad = [];
  for (const file of walk(abs)) {
    const rel = path.relative(abs, file).split(path.sep).join('/');
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    let spawnCount = 0;
    const spawnLines = [];
    for (const re of WORKER_SPAWN_PATTERNS) {
      for (const m of text.matchAll(re)) { spawnCount++; spawnLines.push(lineOf(text, m.index)); }
    }
    if (spawnCount === 0) continue;
    spawnSitesFound += spawnCount;
    let watchCount = 0;
    for (const m of text.matchAll(WATCH_PATTERN)) watchCount++;
    if (watchCount < spawnCount) {
      bad.push(`${rel}: ${spawnCount} worker spawn site(s) (lines ${spawnLines.join(', ')}) but only ${watchCount} watchForLazyLoadFailures() call(s)`);
    }
  }
  assert.ok(spawnSitesFound > 0, `no worker spawn site found anywhere under ${ROOT}: the scan itself may be broken`);
  assert.deepEqual(bad, [], `worker spawn site(s) without a matching watchForLazyLoadFailures():\n${bad.join('\n')}`);
});
