/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * manifestIO.js
 * Export/import of a bundle's STRUCTURE (config + sections/titles/dates) as a
 * standalone JSON file, in the same schema scripts/build-cli.mjs reads. This
 * is the browser half of that CLI: an exported manifest here is a valid input
 * to the CLI, and a manifest built for the CLI (see examples/) imports here
 * unchanged. Never carries the PDFs themselves: those are matched by
 * filename against whatever is dropped alongside the manifest.
 *
 * SECURITY, same discipline as scripts/build-cli.mjs:
 *   - JSON.parse only. Nothing here ever evals or interprets manifest content
 *     as code.
 *   - A manifest's claimed pageCount is NEVER trusted; the real count comes
 *     from validateAndCountPages() on the actual matched PDF bytes, the same
 *     check the ordinary drag-and-drop add path already runs. A manifest
 *     cannot desync the index from the real page count.
 *   - Every text field is type-checked and length-capped by validateManifestShape(), then section
 *     labels, names and titles go through stripUnsuitableChars() before they reach the page. The
 *     config is reduced to known fields and valid values (sanitiseNestedConfig) and its keys are
 *     allow-listed (nestManifestConfig), so no key of a manifest can name a built-in property.
 *   - Hard caps on section/file counts and string lengths reject a manifest
 *     built purely to make the tab do a huge amount of DOM/array work before
 *     any real PDF is even touched.
 *   - A manifest's `filename` is used ONLY as a lookup key against File
 *     objects the user already picked via their own OS file picker or drop:
 *     never as a path read from disk. The browser sandbox means there is no
 *     filesystem for a filename to escape into, unlike the Node CLI (which
 *     has its own, separate containment: see scripts/build-cli.mjs).
 */

import { admitFile, safeFileName } from './fileGate.js';
import { MAX_PDF_PAGES, MAX_PAGE_POINTS, MAX_TOTAL_PAGES, wholeAddProblem, sectionLimitProblem } from './limits.js';
import { state } from './state.js';
import { stripUnsuitableChars, uniqueFilename } from './utils.js';
import { buildIndexData, makeFileRow, ensureEmptyPlaceholder } from './fileRows.js';
import { refreshBundleTotals } from './bundleTotals.js';
import { stopAllReading } from './ocrReading.js';
import { createSectionTbody, createSection0000HeaderRow } from './sections.js';
import { getDefaultSection0000 } from './helpers.js';
import { markDirty } from '../bundletoolAutosave.js';
import { setCurrentSnapshot } from './tabSession.js';
import { gatherConfigOptions, applyExtractedConfig } from './bundleGeneration.js';
import { flattenManifestConfig, nestManifestConfig, validateManifestShape } from '../manifestSchema.js';
import { lazyImport } from '/js/shared/lazy-load.js';

export { looksLikeManifest } from '../manifestSchema.js';

/**
 * Builds the manifest object from the current session (whatever is on the
 * page right now) and triggers a download. Same object shape build-cli.mjs
 * reads, so exporting once and hand-editing the result is the supported way
 * to author a new manifest: no separate editor.
 */
export function exportManifest() {
  const indexData = buildIndexData();
  const config = flattenManifestConfig(gatherConfigOptions());
  const manifest = {
    _comment: 'BundleTool manifest. config keys are "group.field"; sections/files carry structure only, never the PDFs themselves: see examples/ in the BundleTool repo.',
    config,
    sections: indexData.sections.map((s) => ({
      sectionID: s.sectionID,
      sectionLabel: s.sectionLabel,
      sectionName: s.sectionName,
      files: s.files.map((f) => ({ filename: f.filename, title: f.title, date: f.date })),
    })),
  };

  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bundletool-manifest.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Parses and validates a manifest's STRUCTURE only: no DOM touched, no PDFs
 * read. Throws with a message safe to show the user on anything malformed,
 * oversized, or missing required shape. Call before importManifest() so a bad
 * manifest is rejected before any of the current session is disturbed.
 */
export async function parseManifest(manifestFile) {
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  // More sections than a bundle holds is refused whole, as a limit (ManifestLimitError) rather than a broken file.
  const tooMany = sectionLimitProblem(Array.isArray(manifest?.sections) ? manifest.sections.length : 0);
  if (tooMany) throw new ManifestLimitError(tooMany);
  validateManifestShape(manifest);
  return manifest;
}

/**
 * A manifest import refused as a whole for going past a limit that applies to every add (files, documents, size,
 * pages, sections); nothing was changed.
 */
export class ManifestLimitError extends Error {
  constructor({ kind, code, title, message }) {
    super(message);
    this.name = 'ManifestLimitError';
    this.kind = kind;
    this.code = code;
    this.title = title;
  }
}

/**
 * Replaces the current session with a parsed manifest's structure, matching
 * each section's files[].filename against `candidateFiles` (whatever PDFs
 * were dropped alongside the .json). A manifest name with no matching PDF is
 * reported, not silently dropped or silently fabricated. This is a REPLACE,
 * the same as opening a rendered bundle (handleBundleRestore): a manifest is
 * a template to start a new bundle from, not a patch onto whatever is
 * already on the page.
 *
 * @param {Object} manifest - already validated by parseManifest()
 * @param {File[]} candidateFiles - PDFs dropped/selected alongside the manifest
 * @returns {Promise<{added: number, missing: string[]}>}
 */
export async function importManifest(manifest, candidateFiles) {
  const byName = new Map(candidateFiles.map((f) => [f.name, f]));

  // PHASE 1: read and check everything the manifest needs, touching nothing on the page. If anything
  // throws here the current session is exactly as it was, not an empty table.
  const missing = [];
  const plan = [];

  // No more sections than a bundle holds (parseManifest refuses it first; checked again here for any other caller).
  const tooMany = sectionLimitProblem(manifest.sections.length);
  if (tooMany) throw new ManifestLimitError(tooMany);

  // The same whole-add limits as every other way of adding files: how many files, how many documents,
  // how many bytes. The manifest replaces the session, so nothing already on the page counts.
  const wanted = new Set();
  for (const section of manifest.sections) {
    for (const entry of section.files ?? []) { const f = byName.get(entry.filename); if (f) wanted.add(f); }
  }
  const tooBig = wholeAddProblem({
    incomingCount: wanted.size,
    incomingBytes: [...wanted].reduce((sum, f) => sum + f.size, 0),
  });
  if (tooBig) throw new ManifestLimitError(tooBig);
  let pagesSoFar = 0;
  const { validateAndCountPages } = await lazyImport(new URL('../bundletoolPages.js', import.meta.url));

  for (const section of manifest.sections) {
    const entries = [];
    for (const entry of section.files ?? []) {
      const file = byName.get(entry.filename);
      if (!file) { missing.push(entry.filename); continue; }

      // Never trust the manifest's own pageCount; re-derive from the actual
      // bytes, and refuse anything that is not a real, readable, unencrypted
      // PDF: the same gate the ordinary add-files path applies.
      // The file gate first: a manifest names PDFs, so anything that is not a real PDF within the
      // size and page limits is refused here for the same plain reason as anywhere else.
      const admission = await admitFile(file, { outcome: 'imported' });
      if (!admission.ok || admission.route !== 'pdf') {
        missing.push(`${entry.filename} (${admission.ok ? 'not a PDF' : admission.reason})`);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = await validateAndCountPages(bytes);
      if (check.error) { missing.push(`${entry.filename} (${check.error})`); continue; }
      const inspect = check.inspect;
      if (inspect && (inspect.pages === 0 || inspect.pages > MAX_PDF_PAGES || inspect.maxEdge > MAX_PAGE_POINTS)) {
        missing.push(`${entry.filename} (${inspect.pages === 0 ? 'has no pages' : inspect.pages > MAX_PDF_PAGES ? 'too many pages' : 'pages far larger than paper'})`);
        continue;
      }
      pagesSoFar += check.pageCount ?? 0;
      if (pagesSoFar > MAX_TOTAL_PAGES) {
        throw new ManifestLimitError({
          kind: 'warning',
          code: 'BT-MAN-04',
          title: 'Too many pages',
          message: `These documents would take the bundle past ${MAX_TOTAL_PAGES.toLocaleString('en-GB')} pages, so nothing was imported. Split the documents into separate volumes (for example "Bundle A" and "Bundle B") and create separate bundles.`,
        });
      }
      entries.push({ entry, file, pageCount: check.pageCount });
    }
    plan.push({
      sectionLabel: stripUnsuitableChars(typeof section.sectionLabel === 'string' ? section.sectionLabel : ''),
      sectionName: stripUnsuitableChars(typeof section.sectionName === 'string' ? section.sectionName : ''),
      entries,
    });
  }

  // PHASE 2: replace the session. Everything from here is synchronous DOM work on values already checked.
  // The table now holds a different session, so the form is not in step with the last snapshot.
  setCurrentSnapshot(null);
  document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').forEach((el) => el.remove());
  const section0000 = getDefaultSection0000();
  if (section0000) section0000.innerHTML = '';
  stopAllReading();
  state.filesMap.clear();
  Object.keys(state.frontendInputData).forEach((key) => delete state.frontendInputData[key]);
  state.isSectioned = false;
  state.nextSectionNum = 1;
  document.getElementById('file-table')?.classList.remove('sectioned');

  applyExtractedConfig(nestManifestConfig(manifest.config));

  const table = document.querySelector('#file-table table');
  let added = 0;
  let restoreLabel0000 = '', restoreName0000 = '';

  for (let si = 0; si < plan.length; si++) {
    const { sectionLabel, sectionName, entries } = plan[si];
    let tbody;
    if (si === 0) {
      tbody = section0000;
      restoreLabel0000 = sectionLabel;
      restoreName0000 = sectionName;
    } else {
      const sectionID = String(state.nextSectionNum++).padStart(4, '0');
      tbody = createSectionTbody(sectionID, sectionLabel, sectionName);
      table?.appendChild(tbody);
      if (!state.isSectioned) {
        state.isSectioned = true;
        document.getElementById('file-table')?.classList.add('sectioned');
      }
    }

    for (const { entry, file, pageCount } of entries) {
      // The manifest is untrusted text: its file name is shown and stored only in a safe form.
      const key = uniqueFilename(safeFileName(entry.filename), state.filesMap);
      state.filesMap.set(key, file);
      state.frontendInputData[key] = {
        title: stripUnsuitableChars(entry.title || ''),
        date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '') ? entry.date : '',
        pageCount,
      };
      tbody?.appendChild(makeFileRow(key, state.frontendInputData[key]));
      added++;
    }
    if (state.isSectioned && tbody) ensureEmptyPlaceholder(tbody);
  }

  // Section A's label and name are kept even when it holds no documents yet (a structure-only import).
  if (state.isSectioned && section0000) {
    createSection0000HeaderRow(section0000, restoreLabel0000, restoreName0000);
    ensureEmptyPlaceholder(section0000);
  }

  // Final check: the DOM this just built must itself describe a valid
  // IndexData. It should by construction, but this is what would catch a
  // future bug in the loop above rather than shipping a broken bundle.
  buildIndexData().validateIndexStructure();

  refreshBundleTotals();

  // Saved even when it added no documents: a structure-only import replaced the session too, and must
  // not come back as the old one after a refresh.
  markDirty({ immediate: true });
  return { added, missing };
}
