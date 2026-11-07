/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * justAssemble.js
 * Just Assemble: the documents in order and nothing added. One button, no settings: a run that leaves out the index,
 * the page numbers and the bookmarks (pageOptions.leaveOutIndex, leaveOutPageNumbers, leaveOutBookmarks, the same keys
 * the command line takes as --no-index, --no-page-numbers and --no-bookmarks). Create Bundle never leaves them out.
 */

/** The three keys a Just Assemble run turns on, and Create Bundle and Preview Index always leave off. */
export const JUST_ASSEMBLE_OPTIONS = Object.freeze({ leaveOutIndex: true, leaveOutPageNumbers: true, leaveOutBookmarks: true });

/** The file name of an assembled PDF: the bundle title when there is one, then the date. */
export function assembledFilename(bundleTitle, today) {
  const clean = String(bundleTitle || '').replace(/[<>:"/\\|?*.]/g, '-').trim();
  const name = clean ? `${clean}-assembled-${today}` : `assembled-${today}`;
  return `${name.slice(0, 247)}.pdf`;
}
