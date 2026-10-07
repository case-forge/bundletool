/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0.
 *
 * bundletoolBuildWorker.js
 * Web Worker for the single-pass bundle build.
 *
 * Thin by design: the build itself lives in bundletoolBuild.js and is
 * imported. One worker
 * per build, terminated by the caller on completion, so the heap a large
 * bundle needs is returned to the browser rather than staying resident.
 */

import { buildBundlePdf } from '../bundletoolBuild.js';
import { prewarmFontkit } from '../bundletoolPdfLib.js';

// Kicked off now, not awaited: buildBundlePdf() below calls getFontkit() partway through a real job
// (via bundletoolPages.js), and reuses this exact memoised promise rather than fetching twice. Starting
// it here overlaps the fetch with the ready/job round-trip with the main thread. Started only once a
// real job has begun, it would run serially after that round-trip and add about 0.5s to the first
// click on a slow (Fast 3G) connection.
//
// prewarmFontkit(), not getFontkit(): silent on failure. A job with no page numbering and no cover
// never calls getFontkit() at all, so a failure here is not yet a failure anyone is waiting on; with
// getFontkit(), an idle worker with fontkit blocked would post the reload-toast signal moments after
// announcing ready, for exactly that kind of job. A real, later getFontkit() call still shows the toast
// if it fails too; this one only clears the memo so that call starts fresh.
prewarmFontkit().catch(() => {});

self.postMessage({ ready: true });

self.addEventListener('message', async (e) => {
  // performance.memory is Chrome/Edge main-thread only and undefined in
  // workers; the poll silently records nothing elsewhere.
  let peakBytes = performance?.memory?.usedJSHeapSize ?? null;
  const poll = setInterval(() => {
    const b = performance?.memory?.usedJSHeapSize;
    if (b != null && b > (peakBytes ?? 0)) peakBytes = b;
  }, 50);

  try {
    const result = await buildBundlePdf(
      e.data,
      (label) => self.postMessage({ progress: label }),
    );

    clearInterval(poll);
    const final = performance?.memory?.usedJSHeapSize ?? null;
    if (final != null && final > (peakBytes ?? 0)) peakBytes = final;

    self.postMessage(
      { result, workerPeakMB: peakBytes != null ? peakBytes / (1024 * 1024) : null },
      [result.buffer],
    );
  } catch (err) {
    clearInterval(poll);
    console.error('[BuildWorker] error:', err);
    self.postMessage({ error: err.message, stack: err.stack });
  }
});
