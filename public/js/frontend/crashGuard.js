/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * crashGuard.js
 * Records that a bundle build started and finished, so a build that never finished can be
 * noticed on the next load (frontend/autoRestore.js puts the documents back and says so).
 *
 * A bundle exists only in the browser tab that is building it. There is no
 * server copy and no upload (that is the whole privacy proposition), so a tab
 * crash during a large build destroys the work with no trace anywhere. A
 * 1500-page bundle peaks at around 829 MB in one process, so the memory cliff
 * is far off, but it is still there.
 *
 * The autosave layer writes the source documents to IndexedDB before a build
 * starts, so the material is usually still there; what matters is that the
 * person is TOLD. Coming back to an empty table after a crash looks exactly
 * like coming back to a fresh session, so the natural conclusion would be that
 * the work is gone and the only option is to start again.
 *
 * This is a flag that outlives the tab (it must survive the tab being killed outright, which no in-page
 * cleanup handler can promise), plus a heartbeat and a tab id so a build running in one tab is never
 * mistaken for a crash by another. localStorage is used rather than sessionStorage precisely because a
 * crashed tab's session storage dies with it.
 */

import { getTabId } from './tabSession.js';

const BUILD_FLAG_KEY = 'buntool_build_in_progress';
// The tab that is building refreshes a heartbeat in the flag. A flag from ANOTHER tab counts as a
// crash only when its heartbeat has stopped: otherwise opening a second tab while a build runs in the
// first would show a false "didn't finish" notice and delete the flag of a build that is fine.
const HEARTBEAT_MS = 2_000;
// Three minutes, not seconds: a background tab's timers are throttled to about one a minute, and a
// build in a hidden tab must not look like a crashed one.
export const HEARTBEAT_STALE_MS = 180_000;
let heartbeatTimer = null;

function writeFlag(details) {
  localStorage.setItem(BUILD_FLAG_KEY, JSON.stringify({ ...details, tabId: getTabId(), heartbeat: Date.now() }));
}

/**
 * Records that a build has started, with enough context for the notice to be
 * specific about what was being built.
 *
 * @param {{pages?: number, files?: number, title?: string}} [details]
 */
export function markBuildStarted(details = {}) {
  try {
    const flag = { startedAt: Date.now(), ...details };
    writeFlag(flag);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => { try { writeFlag(flag); } catch { /* storage went away */ } }, HEARTBEAT_MS);
    heartbeatTimer?.unref?.();
  } catch {
    // Private browsing, or storage full. A missing crash notice is a smaller
    // problem than a failed bundle, so this never throws upward.
  }
}

/** Records that this tab's build finished, successfully or with a handled error. Another tab's flag is left alone. */
export function markBuildFinished() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try {
    const raw = localStorage.getItem(BUILD_FLAG_KEY);
    if (!raw) return;
    let flag = null;
    try { flag = JSON.parse(raw); } catch { /* unreadable: remove it */ }
    if (!flag || !flag.tabId || flag.tabId === getTabId() || isStale(flag)) localStorage.removeItem(BUILD_FLAG_KEY);
  } catch { /* see above */ }
}

function isStale(flag, now = Date.now()) {
  const beat = Number(flag?.heartbeat ?? flag?.startedAt) || 0;
  return now - beat > HEARTBEAT_STALE_MS;
}

/**
 * The unfinished build this tab should tell the person about, or null. That is a flag this tab wrote
 * (it was refreshed or reopened mid-build), or one from another tab whose heartbeat has stopped (that
 * tab died). A build still running in another tab is not a crash.
 *
 * @returns {{startedAt: number, pages?: number, files?: number, title?: string, tabId?: string}|null}
 */
export function readUnfinishedBuild(now = Date.now()) {
  try {
    const raw = localStorage.getItem(BUILD_FLAG_KEY);
    if (!raw) return null;
    const flag = JSON.parse(raw);
    if (!flag || typeof flag !== 'object') return null;
    if (!flag.tabId || flag.tabId === getTabId() || isStale(flag, now)) return flag;
    return null;
  } catch {
    return null;
  }
}

/**
 * Estimated peak memory for a bundle of a given size.
 *
 * THIS IS AN ESTIMATE, not a measurement of the bundle in front of the user.
 * It is a fit over four measured runs of this codebase's own pipeline
 * (Node, all stages in one process, synthetic documents):
 *
 *      pages   input     measured peak
 *       1503     ~1 MB       350 MB     text-only
 *        100     35 MB       331 MB     one 200dpi JPEG scan per page
 *        400    139 MB       936 MB     ditto
 *       1000    346 MB     1,955 MB     ditto
 *
 * Two terms, because the two shapes of bundle cost memory differently: file
 * size dominates for scans, page count dominates for text-only documents.
 * The fit predicts 351 / 345 / 1014 / 2346 MB for those four points: close,
 * and deliberately high at the top end, since a warning that overstates is
 * safer than one that understates.
 *
 * It will be wrong for unusual documents. It is offered to the user as an
 * estimate and should stay described that way.
 *
 * @param {number} totalPages
 * @param {number} totalSizeMB
 * @returns {number} estimated peak MB
 */
export function estimatePeakMemoryMB(totalPages, totalSizeMB) {
  const BASELINE_MB = 120;   // browser, engine and fonts before any work starts
  const PER_INPUT_MB = 6;    // parsed object graph plus copies during merging
  const PER_PAGE_MB = 0.15;  // page tree, resources and annotations
  return Math.round(BASELINE_MB + totalSizeMB * PER_INPUT_MB + totalPages * PER_PAGE_MB);
}
