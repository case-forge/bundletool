/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * manifestSchema.js
 * The JSON manifest format (config + sections/files, no PDFs) shared by
 * BOTH consumers: scripts/build-cli.mjs (Node, headless) and
 * frontend/manifestIO.js (browser, drag-and-drop). Deliberately has no DOM
 * dependency and no filesystem dependency, so both sides share one
 * definition that cannot drift between them, and its validation is
 * unit-tested in one place (tests/manifestSchema.test.mjs).
 *
 * Everything here is pure: parsing and shape-checking only. Neither side's
 * own trust boundary (path containment in the CLI, DOM-write sanitising in
 * the browser) lives here: this module only decides whether a manifest is
 * well-formed enough to hand to that boundary at all.
 */

import { MAX_SECTIONS } from './frontend/limits.js';

const MAX_FILES = 2000;
const MAX_STRING_LENGTH = 500;
const MAX_DATE_LENGTH = 40;
const MAX_CONFIG_KEYS = 200;

/** Config.options' nested {group: {field: value}} shape -> flat "group.field" keys. */
export function flattenManifestConfig(nested) {
  const flat = {};
  for (const [group, fields] of Object.entries(nested ?? {})) {
    for (const [field, value] of Object.entries(fields ?? {})) {
      flat[`${group}.${field}`] = value;
    }
  }
  return flat;
}

// Config.options groups a manifest may carry. Anything else is ignored: the keys of a manifest are
// untrusted, and "__proto__.x" or "toString.call" must never become a property write on a built-in.
const CONFIG_GROUPS = ['heading', 'index', 'pageNumbering', 'page', 'pageOptions', 'cover', 'ocr'];
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** The inverse: a manifest's flat "group.field" keys -> Config.options nesting. */
export function nestManifestConfig(flat) {
  const nested = {};
  if (!flat || typeof flat !== 'object' || Array.isArray(flat)) return nested;
  for (const dottedKey of Object.keys(flat)) {
    if (dottedKey.startsWith('_')) continue; // e.g. "_comment"
    const parts = dottedKey.split('.');
    if (parts.length !== 2) continue;        // malformed key: ignored, not fatal
    const [group, field] = parts;
    if (!CONFIG_GROUPS.includes(group) || !FIELD_NAME.test(field)) continue;
    if (field === 'constructor' || field === 'prototype') continue;
    if (!Object.hasOwn(nested, group)) Object.defineProperty(nested, group, { value: {}, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(nested[group], field, { value: flat[dottedKey], enumerable: true, writable: true, configurable: true });
  }
  return nested;
}

/**
 * True when `file` looks like a manifest worth trying to parse: a .json file
 * under a sane size. Cheap pre-filter so an ordinary PDF/JPG drop never pays
 * for a JSON.parse attempt.
 */
export function looksLikeManifest(file) {
  return /\.json$/i.test(file.name) && file.size <= 2 * 1024 * 1024;
}

/**
 * Validates a parsed manifest's SHAPE only: no PDFs, no filesystem, no DOM.
 * Throws an Error with a message safe to show a user on the first violation
 * found. Both scripts/build-cli.mjs and frontend/manifestIO.js call this
 * before doing anything else with a manifest, so a manifest built to exhaust
 * memory/time by claiming an enormous number of sections or files, or by
 * carrying implausibly long strings, is rejected before either side does any
 * real work on it.
 *
 * @param {unknown} manifest - the result of JSON.parse on manifest text
 */
export function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('That JSON is not a BundleTool manifest (expected an object with "sections").');
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error('The manifest has no sections.');
  }
  if (manifest.sections.length > MAX_SECTIONS) {
    throw new Error(`The manifest names ${manifest.sections.length} sections; a bundle holds up to ${MAX_SECTIONS}.`);
  }
  // config: an object of "group.field" keys with plain values. Which keys mean anything is decided
  // later (nestManifestConfig, sanitiseNestedConfig); here it only has to be a sane shape.
  if (manifest.config !== undefined) {
    const cfg = manifest.config;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('The manifest\'s config is not an object.');
    const keys = Object.keys(cfg);
    if (keys.length > MAX_CONFIG_KEYS) throw new Error('The manifest\'s config has too many entries.');
    for (const k of keys) {
      const v = cfg[k];
      if (k.length > 100) throw new Error('A config key in the manifest is implausibly long.');
      if (v !== null && typeof v === 'object') throw new Error(`The manifest's config must be flat "group.field" keys, for example "heading.bundleTitle": "Title". The value of "${k}" is an object, which is not allowed.`);
      if (typeof v === 'string' && v.length > MAX_STRING_LENGTH) throw new Error('A config value in the manifest is implausibly long.');
    }
  }
  let fileCount = 0;
  for (const section of manifest.sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error('A section in the manifest is not an object.');
    }
    for (const field of ['sectionID', 'sectionLabel', 'sectionName']) {
      const v = section[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') throw new Error(`A section's ${field} in the manifest is not text.`);
      if (v.length > MAX_STRING_LENGTH) throw new Error('A section name in the manifest is implausibly long.');
    }
    if (section.files !== undefined && !Array.isArray(section.files)) {
      throw new Error('A section\'s files in the manifest are not a list.');
    }
    for (const entry of section.files ?? []) {
      fileCount++;
      if (fileCount > MAX_FILES) throw new Error(`The manifest lists more than ${MAX_FILES} files.`);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('A file entry in the manifest is not an object.');
      }
      if (typeof entry.filename !== 'string' || !entry.filename) {
        throw new Error('A file entry in the manifest has no filename.');
      }
      if (entry.filename.length > MAX_STRING_LENGTH) {
        throw new Error('A filename or title in the manifest is implausibly long.');
      }
      for (const field of ['title', 'date']) {
        const v = entry[field];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string') throw new Error(`A file's ${field} in the manifest is not text.`);
        if (v.length > (field === 'date' ? MAX_DATE_LENGTH : MAX_STRING_LENGTH)) {
          throw new Error(`A file's ${field} in the manifest is implausibly long.`);
        }
      }
    }
  }
}

// ── Strict keys, for the command line ───────────────────────────────────────
// The browser ignores keys it does not know (a manifest exported by an older or newer version must still
// open). A program that writes manifests should be told when it has misspelt one, so the CLI also runs this
// check: every unknown key at the top level, in a section or in a file entry is reported with its path.
// Unknown keys inside `config` are not errors (the config groups grow and shrink); the CLI warns about them.
export const MANIFEST_KEYS = ['schemaVersion', '_comment', 'config', 'sections', 'coversheet'];
export const SECTION_KEYS = ['sectionID', 'sectionLabel', 'sectionName', 'files'];
export const FILE_KEYS = ['filename', 'title', 'date', 'pageCount', 'rotate', 'forceOcr'];

/** @returns {string[]} one message per unknown key, each naming where it is. Call after validateManifestShape. */
export function unknownKeyProblems(manifest) {
  const problems = [];
  const show = (k) => JSON.stringify(String(k).slice(0, 60));
  for (const k of Object.keys(manifest)) if (!MANIFEST_KEYS.includes(k)) problems.push(`unknown key ${show(k)} at the top level`);
  (manifest.sections ?? []).forEach((section, si) => {
    for (const k of Object.keys(section)) if (!SECTION_KEYS.includes(k)) problems.push(`unknown key ${show(k)} in sections[${si}]`);
    (section.files ?? []).forEach((file, fi) => {
      for (const k of Object.keys(file)) if (!FILE_KEYS.includes(k)) problems.push(`unknown key ${show(k)} in sections[${si}].files[${fi}]`);
    });
  });
  return problems;
}
