/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you
 * may not use this file except in compliance with the License. You may
 * obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolTimeout.js
 * The "reject if a promise has not settled in time" plumbing, shared by bundletoolImages.js
 * (an ImageFormatError, so a slow decode reads as a normal refusal) and frontend/rotate.js (a
 * plain timeout-flagged Error, so the document window's preview can tell a timeout apart from a real
 * failure). Only the error each one raises differs, so that is a callback, not a shared type.
 */

/** Rejects with makeError()'s result if `promise` has not settled within `ms`. The work itself cannot be cancelled. */
export function raceTimeout(promise, ms, makeError) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
