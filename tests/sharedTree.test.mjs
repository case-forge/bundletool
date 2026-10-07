/**
 * node:test runs the *.test.mjs files at the same time, all reading one tree: the tool's own scripts and public files,
 * its node_modules and the site's static folder. A test that moves, overwrites or deletes anything there for the length
 * of one check breaks whichever other file reads it in that moment: OCR tests once failed now and then because one test
 * moved @napi-rs/canvas aside and another truncated the real OCR model. A test that needs a package missing or a file
 * different works on a copy (cliOcr.test.mjs's isolatedTool), and this file fails when one does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every place a test file writes into the tool's own folders (or the repository's): a file-system call that writes,
 * truncates, deletes or moves, aimed at a path built from the folder the test file names the tool or repository by
 * (root, toolDir, repoRoot), or at a variable it set from one. Returns "file: call(target)" for each. Moving anything
 * is reported wherever it points.
 */
function sharedTreeWrites(files) {
  const WRITE = /\b(writeFileSync|appendFileSync|truncateSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|symlinkSync|writeFile|appendFile|truncate|rm|rmdir|unlink|rename|copyFile|cp)\(/g;
  const ROOT = /^(?:path\.(?:join|resolve)\(\s*)?(?:root|toolDir|repoRoot)\b/;
  const found = [];
  for (const [file, code] of files) {
    // Variables set from the tool's or repository's folder, one step away: const modelPath = path.join(root, ...). A
    // name is judged by its nearest declaration before the call, so the same name declared elsewhere does not count.
    const declarations = [...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/g)]
      .map((d) => ({ name: d[1], at: d.index, fromRoot: ROOT.test(d[2].trim()) }));
    const fromRoot = (name, at) => {
      const nearest = declarations.filter((d) => d.name === name && d.at < at).pop();
      return Boolean(nearest?.fromRoot);
    };
    for (const m of code.matchAll(WRITE)) {
      const args = [];
      let depth = 0;
      let arg = '';
      for (let i = m.index + m[0].length; i < code.length; i++) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) { args.push(arg.trim()); break; }
          depth--;
        }
        if (c === ',' && depth === 0) { args.push(arg.trim()); arg = ''; continue; }
        arg += c;
      }
      const call = m[1];
      if (call.startsWith('rename')) { found.push(`${file}: ${call}(${args[0]})`); continue; }
      // A copy or a link writes its second argument; everything else its first.
      const target = /^(copyFile|cp|symlink)/.test(call) ? args[1] : args[0];
      if (!target) continue;
      const head = target.replace(/^path\.(?:join|resolve)\(\s*/, '').split(/[\s,)]/)[0];
      if (ROOT.test(target) || fromRoot(head, m.index)) found.push(`${file}: ${call}(${target})`);
    }
  }
  return found;
}

test('no test file writes, truncates, deletes or moves anything in the tool\'s own folders', () => {
  // This file holds the patterns it looks for, as data for the negative control.
  const files = fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && f !== 'sharedTree.test.mjs')
    .map((f) => [f, fs.readFileSync(path.join(here, f), 'utf8')]);
  assert.ok(files.length > 50, 'the test files are read');
  assert.deepEqual(sharedTreeWrites(files), []);
});

test('NEGATIVE CONTROL: moving a package aside, truncating a shared file and deleting from the tool folders are caught, and work on a copy is not', () => {
  const moved = `const canvasDir = path.join(root, 'node_modules', '@napi-rs', 'canvas');
fs.renameSync(canvasDir, movedAside);`;
  const truncated = `const modelPath = path.join(root, 'public', 'ocr', 'eng.traineddata');
fs.writeFileSync(modelPath, realModel.subarray(0, 1000));`;
  assert.equal(sharedTreeWrites([['moved.mjs', moved]]).length, 1, 'moving a package aside');
  assert.deepEqual(sharedTreeWrites([['truncated.mjs', truncated]]), ['truncated.mjs: writeFileSync(modelPath)']);
  assert.equal(sharedTreeWrites([['direct.mjs', "fs.rmSync(path.join(root, 'public', 'x'), { force: true });"]]).length, 1);
  const copy = `const d = tmp();
fs.writeFileSync(path.join(d, 'scan.pdf'), bytes);
fs.cpSync(path.join(root, 'scripts'), path.join(tool, 'scripts'), { recursive: true });
fs.symlinkSync(path.join(root, 'public'), path.join(tool, 'public'));
rm(d);`;
  assert.deepEqual(sharedTreeWrites([['copy.mjs', copy]]), [], 'writing into a temporary folder, or copying from the tool into one');
  const scoped = `function a() { const file = path.join(root, 'icons', 'x.png'); return fs.readFileSync(file); }
function b() { const file = path.join(out, 'x.json'); fs.writeFileSync(file, '{}'); }`;
  assert.deepEqual(sharedTreeWrites([['scoped.mjs', scoped]]), [], 'a name judged by its own nearest declaration');
});
