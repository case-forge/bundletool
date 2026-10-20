/**
 * configSanitise.js
 * One gate for every setting that arrives from somewhere other than the person typing it:
 * saved defaults, a settings link or QR code, an autosave snapshot, a form draft, a reopened bundle.
 *
 * Raw values cannot go straight into the form's selects. A select set to a value it has no option
 * for goes blank, and a blank fails validateOptions() ("Invalid date style: ") on every later
 * Preview Index and Create Bundle until the setting is changed by hand. A link could also carry an
 * out-of-range number or a 100,000-character string that would then be saved as the person's
 * defaults. Nothing here touches the page, so it is unit tested.
 *
 * sanitiseConfig(obj) returns a NEW object holding only values that would pass the build's own
 * validators. A value that does not is dropped (never repaired into something else), so the field
 * keeps its factory or current value. Values in an older stored form are mapped to their current
 * form first (a date style the list does not offer, the three named footer colours).
 */
import {
  validFonts, validFontSize, validAlignments, validNumberingStyles, validDateStyles, validDateInputOrder,
  validOutlineStyles, validFrontMatterNumbering, validFooterLinks, validCoverLayouts, validCoverCaseLines, validCoverLabelPlacements, validCoverPartyAligns, validCoverTitleLines,
  validSectionPrefixes, validPageSizes,
} from '../bundletoolConfig.js';
import { currentDateStyle } from './utils.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
// The three named footer colours a stored setting may hold, as the exact hex each draws.
const LEGACY_COLOURS = { black: '#120513', red: '#de081a', blue: '#1538df' };
const legacyColour = (v) => (typeof v === 'string' && Object.hasOwn(LEGACY_COLOURS, v.trim().toLowerCase()) ? LEGACY_COLOURS[v.trim().toLowerCase()] : v);
const MAX_LINE = 500;
const MAX_MULTILINE = 2000;

const enumOf = (list, map = (v) => v) => (v) => {
  const m = map(v);
  return typeof m === 'string' && list.includes(m) ? { value: m } : null;
};
const hexColour = (map = (v) => v) => (v) => {
  const m = map(v);
  return typeof m === 'string' && HEX.test(m) ? { value: m.toLowerCase() } : null;
};
const numberIn = (min, max, integer) => (v) => {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return { value: integer ? Math.round(v) : v };
};
const bool = (v) => (typeof v === 'boolean' ? { value: v } : null);
// Control characters other than a line break are removed; over-long text is refused, not cut, so a
// hostile or corrupt value is dropped rather than half-applied.
const text = (max, multiline) => (v) => {
  if (typeof v !== 'string') return null;
  const clean = v.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');
  return clean.length <= max ? { value: clean } : null;
};

/** key -> validator. A validator returns { value } to accept (possibly normalised) or null to drop. */
export const SETTING_SPEC = Object.freeze({
  // Advanced Settings
  fontFace: enumOf(validFonts),
  footerFont: enumOf(validFonts),
  dateStyle: enumOf(validDateStyles, currentDateStyle),
  dateInputOrder: enumOf(validDateInputOrder),
  outlineItemStyle: enumOf(validOutlineStyles),
  numberingStyle: enumOf(validNumberingStyles),
  frontMatterNumbering: enumOf(validFrontMatterNumbering),
  footerLink: enumOf(validFooterLinks),
  pageSize: enumOf(validPageSizes),
  alignment: enumOf(validAlignments),
  indexFontSize: enumOf(validFontSize),
  footerFontSize: enumOf(validFontSize),
  sectionPrefix: enumOf(validSectionPrefixes),
  coverLayout: enumOf(validCoverLayouts),
  coverCaseLine: enumOf(validCoverCaseLines),
  coverLabelPlacement: enumOf(validCoverLabelPlacements),
  coverPartyAlign: enumOf(validCoverPartyAligns),
  coverCaseAlign: enumOf(validCoverPartyAligns),
  coverHeadingAlign: enumOf(validCoverPartyAligns),
  coverTitleLines: enumOf(validCoverTitleLines),
  splitBy: enumOf(['size', 'section']),
  pageNumberColour: hexColour(legacyColour),
  plateColour: hexColour(),
  plateOpacity: numberIn(0, 100, true),
  footerOffset: numberIn(-30, 60, false),
  showTableBorders: bool,
  printableBundle: bool,
  ocrAutoDetect: bool,
  ocrTurnUpright: bool,
  ocrStraighten: bool,
  smallerPhotos: bool,
  pageNumberPerSection: bool,
  footerPrefix: text(MAX_LINE, false),
  headingText: text(MAX_LINE, false),
  // Cover text (firm-level defaults and per-bundle fields)
  courtName: text(MAX_MULTILINE, true),
  matterOf: text(MAX_MULTILINE, true),
  partyLabel1: text(MAX_LINE, false),
  partyLabel2: text(MAX_LINE, false),
  // Named to match the DOM id (config-caseNumberLabel) and bundletoolPage.js's own key, not
  // "cover"-prefixed like the toggles beside it: a settings link is built and read from
  // currentDefaults()'s bare `caseNumberLabel`, and DEFAULTS_KEYS below must use the exact same
  // name or sanitiseConfig's `only` filter drops the field. A settings link would then silently
  // lose a custom case number label, while typing one and building a bundle directly would still
  // work, so manual testing would not notice.
  caseNumberLabel: text(MAX_LINE, false),
  preparedByLabel: text(MAX_LINE, false),
  // Same naming rule as caseNumberLabel/preparedByLabel just above: bare, matching the DOM id
  // (config-partyJoiner) and bundletoolPage.js's own key.
  partyJoiner: text(MAX_LINE, false),
  // Per-bundle form fields (snapshots and drafts only)
  claimNumber: text(MAX_LINE, false),
  bundleTitle: text(MAX_LINE, false),
  projectName: text(MAX_LINE, false),
  author: text(MAX_LINE, false),
  watermarkText: text(MAX_LINE, false),
  watermarkColour: hexColour(),
  watermarkOpacity: numberIn(0, 100, true),
  generateCover: bool,
  applicantName: text(MAX_MULTILINE, true),
  respondentName: text(MAX_MULTILINE, true),
  coverExtraText: text(MAX_MULTILINE, true),
});

/** The keys a settings link or saved defaults may carry: Advanced Settings and firm-level cover text. */
export const DEFAULTS_KEYS = Object.freeze([
  'fontFace', 'footerFont', 'dateStyle', 'dateInputOrder', 'outlineItemStyle', 'numberingStyle', 'frontMatterNumbering',
  'footerLink', 'pageSize', 'alignment', 'indexFontSize', 'footerFontSize', 'sectionPrefix', 'coverLayout',
  'coverCaseLine', 'coverLabelPlacement', 'coverPartyAlign', 'coverCaseAlign', 'coverHeadingAlign', 'coverTitleLines',
  'caseNumberLabel', 'preparedByLabel', 'partyJoiner',
  'pageNumberColour', 'plateColour', 'plateOpacity', 'footerOffset', 'showTableBorders', 'printableBundle', 'ocrAutoDetect',
  'ocrTurnUpright', 'ocrStraighten', 'smallerPhotos', 'pageNumberPerSection', 'splitBy', 'footerPrefix', 'headingText', 'courtName', 'matterOf', 'partyLabel1', 'partyLabel2',
]);

/**
 * @param {unknown} input        an object from storage, a link, a snapshot or a draft
 * @param {{ only?: readonly string[], passThrough?: boolean }} [opts]
 *   only         accept just these keys (settings links and saved defaults use DEFAULTS_KEYS)
 *   passThrough  keep keys that have no validator (a snapshot carries other fields the form reads
 *                itself); off by default
 */
export function sanitiseConfig(input, opts = {}) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (opts.only && !opts.only.includes(key)) continue;
    const check = Object.hasOwn(SETTING_SPEC, key) ? SETTING_SPEC[key] : null;
    if (!check) {
      if (opts.passThrough) out[key] = input[key];
      continue;
    }
    const ok = check(input[key]);
    if (ok) out[key] = ok.value;
  }
  return out;
}

/**
 * Where each nested config field lives in SETTING_SPEC. A bundle's own embedded metadata and a
 * manifest both carry the nested Config.options shape ({ index: { dateStyle }, pageNumbering: {...} }).
 * Building the result from THIS table, not from the input's keys, means an input can never add a key
 * of its own, including "__proto__" or "toString".
 */
const NESTED = {
  heading: { claimNumber: 'claimNumber', bundleTitle: 'bundleTitle', projectName: 'projectName', author: 'author' },
  index: { fontFace: 'fontFace', dateStyle: 'dateStyle', dateInputOrder: 'dateInputOrder', outlineItemStyle: 'outlineItemStyle', sectionPrefix: 'sectionPrefix' },
  pageNumbering: {
    footerFont: 'footerFont', footerFontSize: 'footerFontSize', alignment: 'alignment', numberingStyle: 'numberingStyle',
    footerPrefix: 'footerPrefix', pageNumberColour: 'pageNumberColour', plateColour: 'plateColour', plateOpacity: 'plateOpacity',
    footerLink: 'footerLink', frontMatterNumbering: 'frontMatterNumbering', footerOffset: 'footerOffset',
    pageNumberPerSection: 'pageNumberPerSection',
  },
  pageOptions: {
    printableBundle: 'printableBundle', watermarkText: 'watermarkText', watermarkColour: 'watermarkColour',
    watermarkOpacity: 'watermarkOpacity', pageSize: 'pageSize', smallerPhotos: 'smallerPhotos',
  },
  cover: {
    courtName: 'courtName', matterOf: 'matterOf', applicantName: 'applicantName', respondentName: 'respondentName',
    partyLabel1: 'partyLabel1', partyLabel2: 'partyLabel2', extraText: 'coverExtraText', layout: 'coverLayout',
    caseNumberLine: 'coverCaseLine', partyLabelPlacement: 'coverLabelPlacement', partyAlign: 'coverPartyAlign',
    caseNumberAlign: 'coverCaseAlign', headingAlign: 'coverHeadingAlign', titleLines: 'coverTitleLines',
    caseNumberLabel: 'caseNumberLabel', preparedByLabel: 'preparedByLabel', partyJoiner: 'partyJoiner',
  },
  ocr: { autoDetect: 'ocrAutoDetect', turnUpright: 'ocrTurnUpright', straighten: 'ocrStraighten' },
};
// Cover fields that follow Basic Information: a string (an override, even an empty one) or null.
const COVER_FOLLOW_KEYS = ['claimNumber', 'bundleTitle', 'author'];

/**
 * Cleans a nested config object (a reopened bundle's metadata, or a manifest's translated config)
 * to the same standard as sanitiseConfig(): only known fields, only values the build accepts.
 * Returns a new nested object; fields that failed are simply absent, so the caller's own default
 * applies to them.
 */
export function sanitiseNestedConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const read = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);
  // Some bundles call the page numbering group "page".
  for (const group of Object.keys(NESTED)) {
    let src = read(input, group);
    if (src === undefined && group === 'pageNumbering') src = read(input, 'page');
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const dest = {};
    for (const [field, specKey] of Object.entries(NESTED[group])) {
      const v = read(src, field);
      if (v === undefined) continue;
      const ok = SETTING_SPEC[specKey](v);
      if (ok) dest[field] = ok.value;
    }
    // Booleans that live in these groups but are not in SETTING_SPEC under a shared name.
    if (group === 'pageOptions') {
      for (const f of ['watermark', 'coversheet', 'generateCover']) {
        const v = read(src, f);
        if (typeof v === 'boolean') dest[f] = v;
      }
      const cs = read(src, 'coverSource');
      if (cs === 'uploaded' || cs === 'generated' || cs === 'none') dest.coverSource = cs;
    }
    if (group === 'index') {
      const v = read(src, 'showTableBorders');
      if (typeof v === 'boolean') dest.showTableBorders = v;
    }
    if (group === 'cover') {
      for (const f of COVER_FOLLOW_KEYS) {
        const v = read(src, f);
        if (v === null) dest[f] = null;
        else if (typeof v === 'string' && v.length <= MAX_LINE) dest[f] = v.replace(/[\u0000-\u001F\u007F]/g, '');
      }
    }
    out[group] = dest;
  }
  return out;
}
