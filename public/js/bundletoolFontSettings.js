/**
 * BunTool
 * Copyrght (c) 2025-2026 Tris Sheriker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation  of legal bundles.
 *
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolFontSettings.js
 * Font metadata for TOC PDF generation: file paths, jsPDF names, and pt sizes per size label.
 */

export const FONT_SETTINGS = {
  times: {
    regular: { url: '/fonts/timesalt/CharisSILR.ttf',    vfsName: 'CharisSILR.ttf', fontName: 'CharisSILR' },
    bold:    { url: '/fonts/timesalt/CharisSILB.ttf',    vfsName: 'CharisSILB.ttf', fontName: 'CharisSILB' },
    sizes: {
      claimNumber: { large: 16, medium: 14, small: 12 },
      title:       { large: 26, medium: 24, small: 22 },
      project:     { large: 20, medium: 18, small: 16 },
      table:       { large: 13, medium: 12, small: 10 },
    },
  },
  helvetica: {
    regular: { url: '/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf', vfsName: 'LiberationSans-Regular.ttf', fontName: 'LiberationSans-Regular' },
    bold:    { url: '/fonts/arialalt/liberation-sans/LiberationSans-Bold.ttf',    vfsName: 'LiberationSans-Bold.ttf',   fontName: 'LiberationSans-Bold' },
    sizes: {
      claimNumber: { large: 16, medium: 14, small: 12 },
      title:       { large: 24, medium: 22, small: 20 },
      project:     { large: 18, medium: 16, small: 14 },
      table:       { large: 12, medium: 11, small: 10 },
    },
  },
  serif: {
    regular: { url: '/fonts/serif/NotoSerif-Regular.ttf', vfsName: 'NotoSerif.ttf',     fontName: 'NotoSerif' },
    bold:    { url: '/fonts/serif/NotoSerif-Bold.ttf',    vfsName: 'NotoSerifBold.ttf', fontName: 'NotoSerifBold' },
    sizes: {
      claimNumber: { large: 16, medium: 14, small: 12 },
      title:       { large: 26, medium: 24, small: 22 },
      project:     { large: 20, medium: 18, small: 16 },
      table:       { large: 13, medium: 12, small: 10 },
    },
  },
  sansSerif: {
    regular: { url: '/fonts/sans/static/PlusJakartaSans-Regular.ttf', vfsName: 'PlusJakartaSans.ttf',     fontName: 'PlusJakartaSans' },
    bold:    { url: '/fonts/sans/static/PlusJakartaSans-Bold.ttf',    vfsName: 'PlusJakartaSansBold.ttf', fontName: 'PlusJakartaSansBold' },
    sizes: {
      claimNumber: { large: 16, medium: 14, small: 12 },
      title:       { large: 24, medium: 22, small: 20 },
      project:     { large: 18, medium: 16, small: 14 },
      table:       { large: 12, medium: 11, small: 10 },
    },
  },
  monospaced: {
    regular: { url: '/fonts/mono/UbuntuMono-Regular.ttf', vfsName: 'UbuntuMono.ttf',     fontName: 'UbuntuMono' },
    bold:    { url: '/fonts/mono/UbuntuMono-Bold.ttf',    vfsName: 'UbuntuMonoBold.ttf', fontName: 'UbuntuMonoBold' },
    sizes: {
      claimNumber: { large: 16, medium: 14, small: 12 },
      title:       { large: 24, medium: 22, small: 20 },
      project:     { large: 18, medium: 16, small: 14 },
      table:       { large: 12, medium: 11, small: 10 },
    },
  },
  traditional: {
    regular: { url: '/fonts/trad/static/EBGaramond-Regular.ttf', vfsName: 'EBGaramond.ttf',     fontName: 'EBGaramond' },
    bold:    { url: '/fonts/trad/static/EBGaramond-Bold.ttf',    vfsName: 'EBGaramondBold.ttf', fontName: 'EBGaramondBold' },
    sizes: {
      claimNumber: { large: 18, medium: 16, small: 14 },
      title:       { large: 26, medium: 24, small: 22 },
      project:     { large: 20, medium: 18, small: 16 },
      table:       { large: 14, medium: 13, small: 12 },
    },
  },
};

// FONT_SETTINGS itself stays on plain '/fonts/...' paths, deliberately: the
// Node fetch shim scripts/node-compat.mjs (the CLI, the test suite) resolves
// any '/'-leading fetch() straight against public/ on disk and has no concept
// of a base path, so prefixing the raw table would break it.
//
// The prefix is derived from THIS module's own import.meta.url rather than
// from a global on `window`: this file is imported both on the main thread
// AND inside the build and footer Web Workers (bundletoolBuildWorker.js,
// bundletoolFooterWorker.js), and a Worker's global scope has no `window` at
// all (it is `self`), so a window-based check would fall back to "no prefix"
// there and every font fetch made off the main thread would 404.
// import.meta.url is set in every ES module context (main thread, Worker and
// Node), so deriving the prefix from it covers all three without
// special-casing any of them.
function computeBasePrefix() {
  try {
    const { protocol, pathname } = new URL(import.meta.url);
    if (protocol !== 'http:' && protocol !== 'https:') return ''; // Node (file://)
    const marker = '/js/';
    const idx = pathname.indexOf(marker);
    return idx > 0 ? pathname.slice(0, idx) : '';
  } catch {
    return '';
  }
}
const BASE_PREFIX = computeBasePrefix();

export function withBase(url) {
  if (!BASE_PREFIX) return url;
  return url.startsWith('/') ? BASE_PREFIX + url : url;
}

export function getFontSettings(fontKey) {
  const def = FONT_SETTINGS[fontKey] ?? FONT_SETTINGS.sansSerif;
  return {
    ...def,
    regular: { ...def.regular, url: withBase(def.regular.url) },
    bold: { ...def.bold, url: withBase(def.bold.url) },
  };
}