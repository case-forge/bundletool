/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0.
 *
 * bundletoolFooterWorker.js
 * Web Worker for the page-number footer pass.
 *
 * The footer logic lives in bundletoolPages.js and bundletoolFooter.js and is
 * imported here rather than copied, so the worker and the main thread draw the
 * same footer.
 */

import { applyPageNumbering } from '../bundletoolPages.js';
import { prewarmFontkit } from '../bundletoolPdfLib.js';

// Kicked off now, not awaited: applyPageNumbering() below calls getFontkit() partway through a real
// job, and reuses this exact memoized promise rather than fetching twice. Same reasoning, and same
// prewarmFontkit()-not-getFontkit() silent-on-failure choice, as bundletoolBuildWorker.js's identical
// line: overlap the fetch with the ready/job round trip instead of starting it serially, late, only
// once a real job is already under way, without showing the reload toast for a fetch nobody has
// actually asked for yet.
prewarmFontkit().catch(() => {});

self.postMessage({ ready: true });

self.addEventListener('message', async (e) => {
  const { buffer, configValues, pageLabels = [], indexPageIndex = null } = e.data;

  let peakBytes = performance?.memory?.usedJSHeapSize ?? null;
  const poll = setInterval(() => {
    const b = performance?.memory?.usedJSHeapSize;
    if (b != null && b > (peakBytes ?? 0)) peakBytes = b;
  }, 50);

  try {
    const result = await applyPageNumbering(buffer, configValues, pageLabels, indexPageIndex);
    clearInterval(poll);
    const final = performance?.memory?.usedJSHeapSize ?? null;
    if (final != null && final > (peakBytes ?? 0)) peakBytes = final;

    self.postMessage(
      { result, workerPeakMB: peakBytes != null ? peakBytes / (1024 * 1024) : null },
      [result.buffer],
    );
  } catch (err) {
    clearInterval(poll);
    console.error('[FooterWorker] error:', err);
    self.postMessage({ error: err.message, stack: err.stack });
  }
});
