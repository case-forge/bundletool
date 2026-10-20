/** The row batcher (frontend/rowBatch.js): timing rules on a fake clock, and how fileProcessing.js uses it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRowBatcher, DEFAULT_BASE_GAP_MS, DEFAULT_MAX_GAP_MS } from '../public/js/frontend/rowBatch.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fake clock and timer queue. */
function harness(extra = {}) {
  let t = 0; const timers = new Map(); let nextId = 1; const batches = [];
  const b = createRowBatcher({
    insert: (rows) => batches.push(rows),
    now: () => t,
    schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    cancel: (id) => timers.delete(id),
    ...extra,
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      t = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    t = end;
  };
  return { b, batches, advance, timers, get now() { return t; } };
}

test('the first row goes in at once, the rest wait for the gap, and order is kept', () => {
  const h = harness();
  h.b.add('r1'); h.advance(0);
  assert.deepEqual(h.batches, [['r1']]);
  for (const r of ['r2', 'r3', 'r4']) { h.b.add(r); h.advance(10); }
  assert.equal(h.batches.length, 1, 'held back inside the gap');
  h.advance(DEFAULT_BASE_GAP_MS);
  assert.deepEqual(h.batches, [['r1'], ['r2', 'r3', 'r4']]);
});

test('200 rows added over time make a few batches, not 200', () => {
  const h = harness();
  for (let i = 0; i < 200; i++) { h.b.add(i); h.advance(20); }   // one row every 20 ms: 4 s
  h.b.flush();
  assert.equal(h.batches.flat().length, 200);
  assert.deepEqual(h.batches.flat(), Array.from({ length: 200 }, (_, i) => i), 'every row, in order, once');
  assert.ok(h.batches.length <= 20, `${h.batches.length} batches`);
});

test('flush inserts everything held back at once and cancels the timer; flushing nothing does nothing', () => {
  const h = harness();
  h.b.add('a'); h.advance(0); h.b.add('b'); h.b.add('c');
  assert.equal(h.b.pendingCount, 2);
  assert.equal(h.b.flush(), 2);
  assert.equal(h.timers.size, 0);
  assert.equal(h.b.flush(), 0);
  assert.deepEqual(h.batches, [['a'], ['b', 'c']]);
});

test('cancel drops held rows without inserting them', () => {
  const h = harness();
  h.b.add('a'); h.advance(0); h.b.add('b');
  h.b.cancel();
  h.advance(10_000);
  assert.deepEqual(h.batches, [['a']]);
  assert.equal(h.b.pendingCount, 0);
});

test('the gap grows with how long the browser took to draw the last batch, up to a maximum, and never shrinks below the base', () => {
  const costs = [400, 5, 100_000];
  const h = harness({ measureFrame: (done) => done(costs.shift()) });
  h.b.add(1); h.advance(0);
  assert.equal(h.b.stats.gap, 1200, '3 x 400 ms');
  h.b.add(2); h.advance(1200);
  assert.equal(h.b.stats.gap, DEFAULT_BASE_GAP_MS, 'a fast draw goes back to the base gap');
  h.b.add(3); h.advance(DEFAULT_BASE_GAP_MS);
  assert.equal(h.b.stats.gap, DEFAULT_MAX_GAP_MS, 'capped');
  assert.equal(h.batches.length, 3);
});

test('a measurement that is not a number is ignored', () => {
  const h = harness({ measureFrame: (done) => done(NaN) });
  h.b.add(1); h.advance(0);
  assert.equal(h.b.stats.gap, DEFAULT_BASE_GAP_MS);
});

test('fileProcessing.js batches its rows: one batcher, no per row insertion, and a flush before every prompt and at the end', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/frontend/fileProcessing.js'), 'utf8');
  assert.match(src, /createRowBatcher\(/);
  assert.match(src, /batch\.add\(row\)/);
  assert.doesNotMatch(src, /targetTbody\.insertBefore\(row,/, 'rows do not go in one at a time');
  for (const call of ['unlockWithPrompt(', 'confirmBundleAction(', 'confirmDamagedFile(', 'confirmRedactionMarkers(', 'splitBundleInPlace(', 'handleBundleRestore(']) {
    const i = src.indexOf(`await ${call}`) >= 0 ? src.indexOf(`await ${call}`) : src.indexOf(call, src.indexOf('await import'));
    assert.ok(i > 0, call);
    assert.match(src.slice(Math.max(0, i - 260), i), /batch\.flush\(\)/, `${call} is preceded by a flush`);
  }
  assert.match(src, /finally \{[\s\S]*batch\.flush\(\);[\s\S]*batch\.cancel\(\);/, 'the loop always ends with a flush');
});
