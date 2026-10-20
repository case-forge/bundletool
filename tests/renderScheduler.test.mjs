/**
 * The Envelope Guide preview scheduler (static/js/shared/renderScheduler.js): one redraw at a time, the
 * last edit always followed by a redraw, no fixed wait after typing stops. Driven with a fake clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderScheduler, copyFrame } from '/js/shared/renderScheduler.js';

function harness(runImpl, opts = {}) {
  let t = 0;
  const timers = [];
  const log = [];
  const setTimer = (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id; };
  const clearTimer = (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); };
  const scheduler = createRenderScheduler(async () => { log.push(['start', t]); await runImpl(log, () => t); log.push(['end', t]); },
    { minGapMs: 30, now: () => t, setTimer, clearTimer, ...opts });
  /** Advances the clock, firing due timers in order and letting promises settle. */
  async function advance(ms) {
    const target = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      t = Math.max(t, due.at);
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    t = target;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  const sleep = (ms) => new Promise((r) => setTimer(r, ms));
  return { scheduler, advance, log, now: () => t, sleep };
}

test('the first edit after a pause redraws at once, with no fixed wait', async () => {
  const h = harness(async () => {});
  h.scheduler.request();
  await h.advance(0);
  assert.deepEqual(h.log.map((e) => e[0]), ['start', 'end']);
  assert.equal(h.log[0][1], 0);
});

test('requests made together share one redraw', async () => {
  const h = harness(async () => {});
  h.scheduler.request(); h.scheduler.request(); h.scheduler.request();
  await h.advance(0);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1);
});

test('an edit during a redraw is not dropped and not run alongside it: one more redraw follows, after the first ends', async () => {
  let release;
  const h = harness((log) => new Promise((r) => { release = r; }));
  h.scheduler.request();
  await h.advance(0);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1);
  h.scheduler.request(); h.scheduler.request();           // typed while the first redraw is still running
  await h.advance(100);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1, 'never two redraws in flight');
  release(); await h.advance(0);
  await h.advance(100);
  const starts = h.log.filter((e) => e[0] === 'start').length;
  assert.equal(starts, 2, 'the edits made meanwhile got exactly one follow-up redraw');
  // the follow-up starts only after the first has ended
  const order = h.log.map((e) => e[0]).join(',');
  assert.match(order, /^start,end,start/);
});

test('redraws start at least the minimum gap apart', async () => {
  const h = harness(async () => {}, { minGapMs: 30 });
  h.scheduler.request(); await h.advance(0);
  h.scheduler.request(); await h.advance(10);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1, 'too soon after the last start');
  await h.advance(25);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 2);
  const starts = h.log.filter((e) => e[0] === 'start').map((e) => e[1]);
  assert.ok(starts[1] - starts[0] >= 30);
});

test('a redraw that throws does not stop later ones', async () => {
  let n = 0;
  const h = harness(async () => { if (++n === 1) throw new Error('boom'); });
  h.scheduler.request(); await h.advance(0);
  h.scheduler.request(); await h.advance(100);
  assert.equal(n, 2);
});

test('cancel drops a redraw that has not started; busy reports waiting and running work', async () => {
  const h = harness(async () => {}, { minGapMs: 30 });
  h.scheduler.request(); await h.advance(0);
  h.scheduler.request();
  assert.equal(h.scheduler.busy, true);
  h.scheduler.cancel();
  assert.equal(h.scheduler.busy, false);
  await h.advance(200);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1);
});

test('copyFrame resizes the visible canvas only when the size differs, and always draws in the same step', () => {
  const calls = [];
  const visible = { width: 100, height: 200, getContext: () => ({ drawImage: (b, x, y) => calls.push(['draw', visible.width, visible.height, b.tag, x, y]) }) };
  const same = { width: 100, height: 200, tag: 'same' };
  copyFrame(same, visible);
  assert.deepEqual(calls.pop(), ['draw', 100, 200, 'same', 0, 0]);
  const bigger = { width: 120, height: 240, tag: 'bigger' };
  copyFrame(bigger, visible);
  assert.deepEqual(calls.pop(), ['draw', 120, 240, 'bigger', 0, 0], 'resized, then drawn straight away');
});

// ── Failures ─────────────────────────────────────────────────────────────────

test('a redraw that throws does not stop the scheduler: the next edit redraws again', async () => {
  let n = 0;
  const h = harness(async () => { n++; if (n === 1) throw new Error('simulated build failure'); });
  h.scheduler.request();
  await h.advance(0);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1);
  assert.equal(h.scheduler.busy, false, 'not stuck busy after a failure');
  h.scheduler.request();
  await h.advance(100);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 2, 'the next edit after the failure redraws');
});

test('an edit made while a redraw fails is still followed by a redraw', async () => {
  let release; let n = 0;
  const h = harness(() => new Promise((_, reject) => { n++; if (n === 1) release = () => reject(new Error('simulated pdf.js failure')); else release = () => {}; }));
  h.scheduler.request();
  await h.advance(0);
  h.scheduler.request();                       // typed while the first redraw is in flight
  release();                                    // ... which then fails
  await h.advance(0);
  await h.advance(100);
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 2, 'the remembered edit is redrawn after the failure');
});

test('only the Nth redraw failing never leaves two redraws in flight and the last edit is redrawn', async () => {
  let inFlight = 0; let maxInFlight = 0; let n = 0;
  const h = harness(async () => {
    n++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { await h.sleep(20); if (n === 3) throw new Error('simulated failure of the third redraw'); } finally { inFlight--; }
  });
  for (let i = 0; i < 12; i++) { h.scheduler.request(); await h.advance(10); }
  await h.advance(400);
  assert.equal(maxInFlight, 1);
  const last = h.log.filter((e) => e[0] === 'start').at(-1)[1];
  assert.ok(last >= 110, 'a redraw started after the last request (at 110 ms)');
  assert.equal(h.scheduler.busy, false);
});

// ── Slow redraws back off ────────────────────────────────────────────────────

test('a cheap redraw is followed at the minimum gap; nothing backs off', async () => {
  const h = harness(async () => { await h.sleep(15); });
  for (let i = 0; i < 6; i++) { h.scheduler.request(); await h.advance(5); }
  await h.advance(300);
  const starts = h.log.filter((e) => e[0] === 'start').map((e) => e[1]);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] <= 45, `gap ${starts[i] - starts[i - 1]} stays near the minimum`);
});

test('after a slow redraw the next starts no sooner than its duration times 1.5, and the last edit is still drawn', async () => {
  const h = harness(async () => { await h.sleep(200); });
  h.scheduler.request();
  await h.advance(0);
  h.scheduler.request();                        // during the first redraw
  await h.advance(200);                         // first redraw ends at 200
  await h.advance(90);                          // 290: still inside the back off (next start due at 300)
  assert.equal(h.log.filter((e) => e[0] === 'start').length, 1, 'the main thread is left idle after a slow redraw');
  await h.advance(20);                          // 310
  const starts = h.log.filter((e) => e[0] === 'start').map((e) => e[1]);
  assert.equal(starts.length, 2, 'the remembered edit is drawn');
  assert.ok(starts[1] >= 300, `second start at ${starts[1]}`);
});

test('the back off applies only above slowMs and its ratio is a parameter', async () => {
  const fast = harness(async () => { await fast.sleep(50); }, { slowMs: 60 });
  fast.scheduler.request(); await fast.advance(0); fast.scheduler.request(); await fast.advance(50); await fast.advance(20);
  assert.equal(fast.log.filter((e) => e[0] === 'start').length, 2, '50 ms is not slow: it follows at the minimum gap');
  const slow = harness(async () => { await slow.sleep(100); }, { slowMs: 60, idleRatio: 1 });
  slow.scheduler.request(); await slow.advance(0); slow.scheduler.request(); await slow.advance(100); await slow.advance(90);
  assert.equal(slow.log.filter((e) => e[0] === 'start').length, 1, 'ratio 1 waits twice the duration from the start (200 ms)');
  await slow.advance(20);
  assert.equal(slow.log.filter((e) => e[0] === 'start').length, 2);
});
