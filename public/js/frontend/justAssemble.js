/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * justAssemble.js
 * The Just assemble group's "Just this once" switch (browser only; the command line runs once anyway).
 *
 * Just assemble is three independent switches, Leave out the index page, Leave out page numbers and Leave
 * out bookmarks (pageOptions.leaveOutIndex, leaveOutPageNumbers, leaveOutBookmarks). With Just this once
 * on, they apply to the next bundle only: once Create Bundle has finished and shown "Bundle ready!", all
 * four are put back to off, a notice says so, and the off state is saved, so a reload does not bring
 * them back. A failed or cancelled build, Preview Index and the bundle preview change nothing. With Just
 * this once off, the switches stay as they are.
 */

/** The three switches, by element id. */
export const JUST_ASSEMBLE_IDS = Object.freeze(['config-leaveOutIndex', 'config-leaveOutPageNumbers', 'config-leaveOutBookmarks']);
export const ONCE_ID = 'config-justAssembleOnce';
export const BACK_OFF_NOTICE = 'Just assemble is back off, so the next bundle is normal.';

/**
 * Called after a bundle has been made. Puts the three switches and Just this once back to off when Just
 * this once is on, then saves and tells the person. Does nothing otherwise.
 *
 * @param {Document} doc
 * @param {{ save?: () => void, notify?: (message: string) => void }} [hooks]
 * @returns {boolean} true when the switches were put back
 */
export function resetJustAssembleAfterBuild(doc, { save, notify } = {}) {
  const once = doc.getElementById(ONCE_ID);
  if (once?.checked !== true) return false;
  for (const id of [...JUST_ASSEMBLE_IDS, ONCE_ID]) {
    const el = doc.getElementById(id);
    if (el) el.checked = false;
  }
  save?.();
  notify?.(BACK_OFF_NOTICE);
  return true;
}
