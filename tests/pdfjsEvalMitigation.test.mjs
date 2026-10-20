/**
 * CVE-2024-4367: pdf.js before 4.2.67 can execute attacker-controlled code via eval() reached
 * from a crafted font inside a PDF. This product pins pdf.js 4.0.379 (NOTICE explains why), so
 * every call site that loads a document a person did not write themselves must carry
 * isEvalSupported: false, or the mitigation NOTICE claims is in place would not actually be.
 *
 * A fixed list of known call sites can only ever prove the sites on the list are safe, not that
 * no unsafe one exists: a new call site, or one written as getDocument(opts) rather than an
 * inline object literal, would pass silently. This scans every shipped, non-vendor script instead.
 *
 * This file covers this product's own files only, and never walks another product's directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ holds the command line build (cliOcrDocument.mjs), the one site where eval would run with
// Node's own privileges rather than the browser's. A root that does not exist is skipped, so a
// standalone export that ships fewer folders still runs this test.
const ROOTS = ['../public/js', '../scripts'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') yield* walk(p); }
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}

test('every pdf.js getDocument() call on a document the person did not write passes isEvalSupported: false', () => {
  let callsFound = 0;
  for (const root of ROOTS) {
    const abs = fileURLToPath(new URL(root, import.meta.url));
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      // Comments say "getDocument()" in prose; only code is checked. A // counts as a comment only at
      // the start of a line or after whitespace, so a URL in a string does not hide the rest of its line.
      const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      // Every use of the name must be a call this scan reads. Bracket access, an alias or a re-export
      // would hide a call from the match below, so any of them fails here rather than passing silently.
      for (const m of text.matchAll(/getDocument\b/g)) {
        assert.match(text.slice(m.index), /^getDocument\s*\(/, `${file}: getDocument is used other than as a direct call, so this scan cannot verify it: ${text.slice(Math.max(0, m.index - 30), m.index + 40)}`);
      }
      for (const m of text.matchAll(/getDocument\s*\(/g)) {
        const rest = text.slice(m.index);
        const open = rest.indexOf('(');
        // The whole argument list, brace-matched so a nested object inside it (worker config, etc.)
        // does not end the scan early.
        let depth = 0, end = -1;
        for (let i = open; i < rest.length; i++) {
          if (rest[i] === '(') depth++;
          else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        assert.ok(end > -1, `${file}: getDocument( call has no matching close paren`);
        const args = rest.slice(open + 1, end);
        callsFound++;
        assert.match(args, /^\s*\{/, `${file}: getDocument() is not called with an inline object literal, so this scan cannot verify it: ${args.slice(0, 80)}`);
        const flag = args.match(/isEvalSupported:\s*false/);
        assert.ok(flag, `${file}: ${args.slice(0, 120)}`);
        // A spread after the flag could set it back to true.
        assert.ok(!/\.\.\./.test(args.slice(flag.index)), `${file}: a spread follows isEvalSupported: false, which could override it: ${args.slice(0, 160)}`);
      }
    }
  }
  assert.ok(callsFound > 0, 'no getDocument() call found anywhere under ' + ROOTS.join(', ') + ': the scan itself may be broken');
});
