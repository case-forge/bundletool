/**
 * Shared by the live previews (Envelope Guide, the BundleTool cover maker).
 *
 * When the live preview redraws.
 *
 * Every edit asks for a redraw with request(). At most one redraw is ever in flight. An edit that
 * arrives while one is running does not start a second one or get dropped: it is remembered, and one more
 * redraw starts the moment the first finishes, reading the fields as they are then, so the last thing typed
 * is always what ends up on screen and nothing stale is drawn over it. Redraws start at least `minGapMs`
 * apart, and requests made in the same moment (an input and a change event for one keystroke) share one
 * redraw. There is no fixed wait after typing stops: the first edit after a pause redraws at once.
 *
 * Slow redraws back off. A cheap redraw (the Envelope Guide takes about 15 ms) follows every keystroke. One that
 * takes longer than `slowMs` (the cover maker takes about 150 ms, and about 400 ms on a phone-class CPU) would
 * otherwise run back to back for as long as the person types, keeping the main thread busy and delaying the
 * keystrokes themselves (key events can wait up to 370 ms). So after a slow redraw the next one starts
 * no sooner than its duration times (1 + `idleRatio`) after the last start, which leaves the main thread idle for
 * `idleRatio` of that duration between redraws. The last edit is still always drawn.
 *
 * The timer functions are parameters so the behaviour can be tested without waiting.
 */
export function createRenderScheduler(run, { minGapMs = 30, slowMs = 60, idleRatio = 0.5, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false;
  let dirty = false;
  let timer = null;
  let lastStart = -Infinity;
  let lastDuration = 0;

  async function start() {
    timer = null;
    running = true;
    dirty = false;
    lastStart = now();
    try {
      await run();
    } catch {
      // A failed redraw is the caller's to report; the scheduler must keep working for the next edit.
    } finally {
      running = false;
      lastDuration = now() - lastStart;
    }
    if (dirty) plan();
  }

  function plan() {
    if (timer !== null) return;
    const gap = lastDuration > slowMs ? Math.max(minGapMs, lastDuration * (1 + idleRatio)) : minGapMs;
    const wait = Math.max(0, lastStart + gap - now());
    timer = setTimer(start, wait);
  }

  return {
    /** An edit happened: make sure a redraw follows it. */
    request() {
      if (running) { dirty = true; return; }
      plan();
    },
    /** True while a redraw is running or waiting to start. */
    get busy() { return running || timer !== null; },
    /** Drops a redraw that has not started yet. One already running finishes. */
    cancel() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      dirty = false;
    },
  };
}

/**
 * Copies a finished offscreen frame onto the visible canvas in one synchronous step: the visible canvas is
 * resized only if the frame's size differs (resizing clears it) and drawn straight away, in the same task, so the
 * browser never paints a cleared or half-drawn preview. The visible canvas keeps its last good frame until then.
 *
 * @param {HTMLCanvasElement} buffer   the finished frame, drawn offscreen
 * @param {HTMLCanvasElement} visible  the canvas on screen
 */
export function copyFrame(buffer, visible) {
  if (visible.width !== buffer.width || visible.height !== buffer.height) {
    visible.width = buffer.width;
    visible.height = buffer.height;
  }
  visible.getContext('2d').drawImage(buffer, 0, 0);
}
