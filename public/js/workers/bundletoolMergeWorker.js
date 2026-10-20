/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0.
 *
 * bundletoolMergeWorker.js
 * Web Worker for PDF merge operations.
 *
 * Thin by design: the merging itself lives in bundletoolMerge.js and is
 * imported here rather than reimplemented, so the worker and the main thread
 * cannot drift apart.
 *
 * One worker per operation, terminated by the caller on completion, so the
 * heap a large merge builds up is returned to the browser instead of staying
 * resident for as long as the page is open.
 */

import { mergeTwoPdfs } from '../bundletoolMerge.js';

self.postMessage({ ready: true });

self.addEventListener('message', async (e) => {
  const { op } = e.data;

  // performance.memory is Chrome/Edge main-thread only and undefined in
  // workers; the poll silently records nothing elsewhere.
  let peakBytes = performance?.memory?.usedJSHeapSize ?? null;
  const poll = setInterval(() => {
    const b = performance?.memory?.usedJSHeapSize;
    if (b != null && b > (peakBytes ?? 0)) peakBytes = b;
  }, 50);

  try {
    let result;
    if (op === 'mergeTwoPdfs') {
      result = await mergeTwoPdfs(e.data.bufA, e.data.bufB);
    } else {
      // The full-bundle merge runs in the single-pass build worker, not here.
      throw new Error(`Unknown operation: ${op}`);
    }

    clearInterval(poll);
    const final = performance?.memory?.usedJSHeapSize ?? null;
    if (final != null && final > (peakBytes ?? 0)) peakBytes = final;

    self.postMessage(
      { result, workerPeakMB: peakBytes != null ? peakBytes / (1024 * 1024) : null },
      [result.buffer],
    );
  } catch (err) {
    clearInterval(poll);
    console.error('[MergeWorker] error:', err);
    self.postMessage({ error: err.message, stack: err.stack });
  }
});
