/**
 * bundletoolBuildWorker.js and bundletoolFooterWorker.js each kick off prewarmFontkit() at module load,
 * not awaited, so the fetch overlaps the ready/job round-trip with the main thread instead of starting
 * only once a real job has begun processing, late and serially after that round-trip (about half a
 * second later on the first click over Fast 3G). It is prewarmFontkit(), specifically, not getFontkit():
 * silent on failure, since a job that never needs fontkit (no page numbering, no cover) never calls
 * getFontkit() at all, and a failure in a prefetch nobody has asked for yet is not one anyone should see
 * a reload toast for. With getFontkit(), an idle worker with fontkit blocked would post the toast signal
 * moments after announcing ready, for exactly that kind of job.
 *
 * This is a structural scan, not a behavioural one. Importing the worker module (under a self shim) and
 * then awaiting the same memoized getFontkit() from the test would pass even with the kickoff line
 * deleted, because the test's OWN await is itself a valid way to resolve the otherwise never-started
 * promise. A text scan checks instead that the kickoff comes before the worker starts listening for a
 * job, and is not awaited at its own call site (which would block postMessage({ready: true}) until
 * fontkit resolves, worse than not prefetching at all). Comments are stripped first: this file's own
 * header mentions "getFontkit()" in prose, and a scan that matched that occurrence instead of the real
 * call would let a kickoff moved inside the listener, or awaited at the top level, pass undetected.
 * The silent-versus-toast behaviour itself is tested in lazyLoad.test.mjs ({silent: true} posts nothing),
 * and the real-failure case that must still toast in workerLazyLoadFailure.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKERS = ['bundletoolBuildWorker.js', 'bundletoolFooterWorker.js'];

/** Same regex-literal-aware comment stripper as lazyLoadGuard.test.mjs (see its own docstring for why
 *  the regex-vs-division handling exists); duplicated rather than shared, consistent with this test
 *  suite's existing pattern of each scan file carrying its own copy. */
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
      }
    }
    out += c;
    i++;
  }
  return out;
}

for (const name of WORKERS) {
  test(`${name}: prewarmFontkit() is kicked off at module load, before the job message listener, without being awaited there`, () => {
    const abs = fileURLToPath(new URL(`../public/js/workers/${name}`, import.meta.url));
    const text = stripComments(fs.readFileSync(abs, 'utf8'));

    const kickoff = /prewarmFontkit\(\)/.exec(text);
    assert.ok(kickoff, `${name}: no prewarmFontkit() call found in real code (comments do not count): a bare getFontkit() here would show the reload toast for a fetch nobody has asked for yet`);

    const listener = text.indexOf("self.addEventListener('message'");
    assert.ok(listener > -1, `${name}: no self.addEventListener('message', ...) found: the scan itself may be stale`);
    assert.ok(
      kickoff.index < listener,
      `${name}: prewarmFontkit() must be called before the job message listener is registered, not from inside it`,
    );

    const before = text.slice(Math.max(0, kickoff.index - 10), kickoff.index);
    assert.ok(
      !/\bawait\s*$/.test(before),
      `${name}: prewarmFontkit() at module load must not be awaited there: that would delay postMessage({ready: true}) until fontkit resolves, worse than not prefetching at all`,
    );
  });
}
