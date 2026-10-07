/**
 * Puts many new table rows on the page in a few batches instead of one at a time.
 *
 * Inserting each row as soon as its file is checked would ask the browser for a new frame every time, and
 * painting the ever longer table costs more each time, so on a slow processor nearly all of the wait would
 * be painting (about 580 paints for 100 files). Rows are held back and inserted together: the first at
 * once, so something appears straight away, then at most one batch per gap. The gap grows with how long
 * the browser took to draw the last batch, so a slow device paints less often.
 *
 * Nothing here touches the page: `insert(rows)` does that, and the clock, timer and frame measurement are
 * injected, so the timing rules are tested without a browser.
 */

export const DEFAULT_BASE_GAP_MS = 250;
export const DEFAULT_COST_FACTOR = 3;
export const DEFAULT_MAX_GAP_MS = 2000;

/**
 * @param {Object}   opts
 * @param {(rows: any[]) => void} opts.insert   Puts a batch of rows, in order, on the page.
 * @param {() => number} [opts.now]             A millisecond clock.
 * @param {(fn: () => void, ms: number) => any} [opts.schedule]
 * @param {(handle: any) => void} [opts.cancel]
 * @param {(done: (ms: number) => void) => void} [opts.measureFrame]  Calls back with how long the browser
 *        took to draw what `insert` just added. Without it the gap stays at the base gap.
 * @param {number} [opts.baseGapMs]
 * @param {number} [opts.costFactor]            The gap is at least this many times the last draw time.
 * @param {number} [opts.maxGapMs]
 */
export function createRowBatcher({
  insert,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  measureFrame = null,
  baseGapMs = DEFAULT_BASE_GAP_MS,
  costFactor = DEFAULT_COST_FACTOR,
  maxGapMs = DEFAULT_MAX_GAP_MS,
} = {}) {
  let pending = [];
  let timer = null;
  let lastFlushAt = null;
  let gap = baseGapMs;
  let inserted = 0;
  let batches = 0;

  const run = () => {
    if (timer !== null) { cancel(timer); timer = null; }
    if (pending.length === 0) return 0;
    const rows = pending;
    pending = [];
    lastFlushAt = now();
    insert(rows);
    inserted += rows.length;
    batches++;
    if (measureFrame) {
      measureFrame((ms) => {
        if (Number.isFinite(ms) && ms >= 0) gap = Math.min(maxGapMs, Math.max(baseGapMs, ms * costFactor));
      });
    }
    return rows.length;
  };

  return {
    /** Holds a row back; it goes in with the next batch. */
    add(row) {
      pending.push(row);
      if (timer !== null) return;
      const wait = lastFlushAt === null ? 0 : Math.max(0, lastFlushAt + gap - now());
      timer = schedule(run, wait);
    },
    /** Inserts everything held back, now. Returns how many rows went in. Call it before anything that
     *  shows a prompt, changes the table itself, or ends the run, so the page and the data agree. */
    flush: run,
    /** Drops the timer without inserting; rows still held are discarded. */
    cancel() {
      if (timer !== null) { cancel(timer); timer = null; }
      pending = [];
    },
    get pendingCount() { return pending.length; },
    get stats() { return { inserted, batches, gap }; },
  };
}

/**
 * The browser's own cost of drawing what was just inserted: the time between the next two animation frames
 * (the first runs before the draw, the second after it). Used as `measureFrame` in the page.
 */
export function measureFrameCost(done) {
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame((first) => {
    requestAnimationFrame((second) => done(second - first));
  });
}
