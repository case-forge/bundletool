/**
 * BunTool
 * Copyrght (c) 2025-2026 Tris Sheriker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation  of legal bundles.
 *  * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolConfig.js
 * Configuration class for the bundle generator. Takes options from the
 * frontend for parsing during bundle processing.
 */

import { validPageSizes } from './bundletoolPageSize.js';
export { validPageSizes };

export const validFonts = [
    "serif",
    "traditional",
    "sansSerif",
    "monospaced",
   "times",     // CharisSIL uses Graphite tables, incompatible with fontkit
    "helvetica", // Liberation Sans 2.1.5
    "courier"
  ];

/**
 * The font every unknown key resolves to: Liberation Sans, the "Arial style"
 * option. Chosen over a serif because it is metric-compatible with Arial and is
 * the page-number footer's default font.
 */
export const FALLBACK_FONT = "helvetica";

/**
 * Font keys a stored configuration may name that this build does not ship.
 *
 * TeX Gyre Heros is not part of this build, and "Arial style" resolves to
 * Liberation Sans. No version of `validFonts` offers it, so no configuration
 * should name it. This map exists because "should not" is not "cannot": a
 * bundle's embedded info:BundleIndex, an autosave snapshot and the saved
 * default configuration are all read back from storage this code does not
 * control. Without it, `document.getElementById('config-fontFace').value =
 * 'texgyreheros'` on a <select> without that option silently yields '', which
 * then fails validateOptions() as `Invalid index font:` with nothing after the
 * colon.
 */
export const RETIRED_FONTS = {
  texgyreheros: FALLBACK_FONT,
  texGyreHeros: FALLBACK_FONT,
  "tex-gyre-heros": FALLBACK_FONT,
};

/**
 * Coerces a font key to one this build can actually load.
 *
 * Anything valid is returned untouched. A retired key, an unknown key, an empty
 * string and a null all resolve to FALLBACK_FONT, so a configuration naming a
 * font this build does not have still opens and renders instead of throwing.
 *
 * @param {string|null|undefined} key
 * @param {string} [fallback=FALLBACK_FONT]
 * @returns {string}
 */
export function normaliseFontKey(key, fallback = FALLBACK_FONT) {
  if (validFonts.includes(key)) return key;
  const retired = RETIRED_FONTS[key];
  if (retired) {
    console.warn(`[config] font "${key}" is no longer shipped; using "${retired}"`);
    return retired;
  }
  if (key) console.warn(`[config] unknown font "${key}"; using "${fallback}"`);
  return fallback;
}

export const validFontSize = [
  "small",
  "medium",
  "large"
  ];

export const validAlignments = [
    "left",
    "centre",
    "center",
    "right"
  ];

export const validNumberingStyles = [
    "PageX",
    "PageXofY",
    "X",
    "XslashY",
    "XofY",
    "None",
  ];

// Which reading wins for a genuinely ambiguous slash/dash date parsed from a filename (both
// numbers 12 or under, so either could be the day or the month): UK reads day-first, US reads
// month-first. A day over 12 is never ambiguous either way, so this never changes that reading.
// Browser only: the CLI takes a document's date from the manifest as given, parsing no filenames
// itself. Kept in Config anyway (not a browser-only global) so it travels with settings links,
// saved defaults and exported manifests the same way every other Advanced Setting does.
export const validDateInputOrder = [
    "UK",
    "US",
  ];

export const validDateStyles = [
    "YYYY-MM-DD",
    "DD-MM-YYYY",
    "MM/DD/YYYY",
    "DD Mon. YYYY",
    "DD Month YYYY",
    "Mon DD, YYYY",
    "Mon. DD, YYYY", // not offered by the settings list, but accepted from saved settings
    "Month DD, YYYY",
    "None",
  ];

export const validOutlineStyles = [
    "plain",
    "withPage",
    "withDate",
    "withDateandPage",
  ];

export const validTableBorders = [
    true,
    false,
  ];
export const validPrintableBundle = [
    true,
    false,
  ];
export const validOcrAutoDetect = [
    true,
    false,
  ];
export const validOcrMode = [
    "auto",
    "off",
  ];
export const validOcrTurnUpright = [
    true,
    false,
  ];
export const validOcrStraighten = [
    true,
    false,
  ];
export const validSmallerPhotos = [
    true,
    false,
  ];

export const validPageNumberColours = [
    "black",
    "red",
    "blue",
  ];

// How the front matter (cover and index) is numbered. "continuous" (the
// default) makes physical page 1 Page 1. "roman" numbers the front matter i,
// ii, iii and starts the documents at 1, which is the convention in printed
// bundles. "skip" leaves the front matter unnumbered and starts at 1 on the
// first document.
export const validFrontMatterNumbering = [
    "continuous",
    "roman",
    "skip",
  ];

// Where a page-number footer's hyperlink goes. "index" (the default) links to
// the index; "top" goes back to the first page; "none" keeps the footer but
// drops the link. The [00] Index bookmark is independent of this.
export const validFooterLinks = [
    "index",
    "top",
    "none",
  ];

export const justTheIndex = [
    true,
    false,
  ];

export const validCoversheet = [
    true,
    false,
  ];

export const validGenerateCover = [
    true,
    false,
  ];

export const validWatermark = [
    true,
    false,
  ];

/**
 * Where the bundle's cover page came from.
 *   'uploaded': the user supplied one; it wins over the generated cover.
 *   'generated': BundleTool drew it from the case details.
 *   'none': cover generation suppressed and nothing uploaded.
 * Written into the bundle's embedded index so a reopened bundle knows whether
 * to bring page 1 back as an uploaded coversheet or to regenerate it.
 */
export const validCoverSources = [
    "uploaded",
    "generated",
    "none",
  ];

/**
 * Which cover geometry layoutCover() draws (see the TWO LAYOUTS comment in
 * bundletoolCover.js): 'classic', the default, or 'grid', the four-corner
 * grid.
 */
export const validCoverLayouts = [
  "classic",
  "grid",
];

/** Where the case number sits: on the court's line, or on a line of its own beneath it. */
export const validCoverCaseLines = ["court", "own"];
/** Where each party's role label sits: under the name, or on the name's line. */
export const validCoverLabelPlacements = ["below", "inline"];
/** How the stacked cover design aligns the party names. */
export const validCoverPartyAligns = ["left", "centre", "right"];
/** The rules above and below the cover title: one each, or two thin ones each. */
export const validCoverTitleLines = ["single", "double"];

export const validSectionPrefixes = [
  "",
  "Section",
  "Part",
];

export const validPageNumberPerSection = [
  true,
  false,
];

class Config {
  /*
  * Initialise with default configuration
  */
  constructor() {
    this.options = {
      heading: {
        claimNumber: "", // Default: blank
        bundleTitle: "Bundle", // Default: "Bundle"
        projectName: "", // Default: blank
        // PDF "Author": the person or organisation responsible for the CONTENT,
        // which the spec distinguishes from Producer/Creator (the software).
        // Left blank by default and deliberately not hardcoded to any firm:
        // this is a product with more than one customer.
        author: "", // Default: blank
        fontSize: "medium", // Default: medium
      },
      pageNumbering: {
        // Default: Liberation Sans ("helvetica", the "Arial style" option).
        footerFont: "helvetica",
        footerFontSize: "medium", // Default: medium
        alignment: "centre", // Default: Centre
        numberingStyle: "PageX", // Default: Page [X]
        footerPrefix: "", // Default: blank
        pageNumberColour: "#000000", // Default: black; any #rrggbb from the colour picker
        pageNumberPerSection: false, // Default: false
        // The plate behind the number: colour and opacity are the user's, so
        // the grey box can be tinted or removed. Defaults reproduce the CLI's
        // composited grey exactly (0.958 grey = #f4f4f4 at 100%).
        plateColour: "#f4f4f4",
        plateOpacity: 100,
        // Where the footer's hyperlink goes: index | top | none. Default: the
        // index.
        footerLink: "index",
        // How the cover and index are numbered. Default: "continuous".
        frontMatterNumbering: "continuous",
        // Nudges the footer up (positive) or down (negative) in points.
        // Zero is the CLI-derived position the plate geometry was built on.
        footerOffset: 0,
      },
      index: {
        fontFace: "serif", // Default: serif (Noto Serif)
        fontSize: "medium", // Default: medium
        dateStyle: "YYYY-MM-DD", // Default: YYYY-MM-DD
        dateInputOrder: "UK", // Default: UK (day-first for an ambiguous filename date)
        outlineItemStyle: "withPage", // Default: with page
        showTableBorders: true, // Default: true
        justTheIndex: false, // Default: false
        sectionPrefix: "", // No word before the section letter; the form's own starting choice is "Section"
        // The label on the bookmark that jumps to the index. Blank means
        // "Index".
        indexBookmarkLabel: "",
        // The heading printed on the index page itself. Blank reuses the
        // bundle title.
        headingText: "",
      },
      pageOptions: {
        // The size of pages BUNDLETOOL DRAWS: index, cover, blank padding
        // pages, and the wrapper an added image sits on. Pages copied from
        // the user's own documents keep their own size: rescaling someone's
        // evidence would change what the court sees.
        pageSize: "a4",
        printableBundle: false, // Default: false
        // Whether the finished bundle has a cover page at physical page 1, from
        // whatever source. Set by processTheBundle from `generateCover` and
        // whether a coversheet file was supplied; everything that offsets a
        // page number reads this one flag.
        coversheet: false,
        // True once the user confirms a design in the coversheet maker; the
        // cover is then drawn at build time from the `cover` block below.
        // Covers are opt-in, through the maker alone. A build with neither
        // this nor an uploaded coversheet warns and continues.
        generateCover: false,
        coverSource: "none", // resolved at build time; see validCoverSources
        // A diagonal mark repeated across every page.
        watermark: false,
        watermarkText: "", // Default: falls back to "CONFIDENTIAL" when drawn
        watermarkColour: "#999999", // Default: mid grey
        // 0-100, same shape as pageNumbering.plateOpacity. Default: 28.
        watermarkOpacity: 28,
        // On by default, browser and command line alike: a document BundleTool made from a picture (a photo, a
        // TIFF page) goes into the bundle with each picture at most SMALLER_PHOTO_EDGE pixels on its long edge, as
        // a JPEG (bundletoolSmallerPhotos.js). Never a PDF that was added as a PDF. false keeps the pictures as
        // they were converted.
        smallerPhotos: true,
      },
      // Case details that appear ONLY on the generated cover page. They follow
      // BundleToolCLI's BundleMetadata (court_name, applicant_name,
      // respondent_name); the case name, claim number and "Prepared By" the
      // cover also draws come from `heading` above.
      cover: {
        courtName: "",
        // The statute line beneath the court, e.g. "IN THE MATTER OF THE
        // FAMILY LAW ACT 1996". Every key here must also be in
        // flattenCoverConfig(), or what the user types never reaches a built
        // page; tests that hand the flat dictionary straight to the renderer
        // cannot see a key missing from either place.
        matterOf: "",
        applicantName: "",
        respondentName: "",
        // The role labels beside the parties, e.g. Claimant/Defendant. Blank
        // means the family-court default pair (Applicant/Respondent), applied
        // in bundletoolCover.js so a stored configuration without them needs no
        // migration.
        partyLabel1: "",
        partyLabel2: "",
        // Free-text lines beneath the cover title, one per newline. Set from
        // the coversheet maker's Additional lines box.
        extraText: "",
        // The cover's own Case Reference, Bundle Title and Prepared By. null follows
        // Basic Information (heading.*); a string, even an empty one, is what the cover
        // shows regardless (see frontend/coverOverrides.js).
        claimNumber: null,
        bundleTitle: null,
        author: null,
        // Which cover geometry is drawn (see the TWO LAYOUTS comment in
        // bundletoolCover.js): 'classic', the default, or 'grid', the
        // four-corner grid.
        layout: "classic",
        // The three cover toggles (see THE THREE TOGGLES in bundletoolCover.js).
        caseNumberLine: "court",
        partyLabelPlacement: "inline",
        partyAlign: "centre",
        caseNumberAlign: "right",
        headingAlign: "left",
        titleLines: "single",
        // The prefix drawn before the case number on the cover, freely overridable the same
        // way the party labels are, since not every case is an order. "CASE NO:"
        // is the default; set "CLAIM NO:", "ORDER NO:", any other wording, or "" for no
        // prefix at all.
        caseNumberLabel: "CASE NO:",
        // The label drawn before "Prepared By", freely overridable the same way,
        // the same hard-coded-prefix shape as caseNumberLabel above.
        // "Prepared by:" is the stored default; set to "Compiled by:", "On behalf of:", any
        // other wording, or "" for no label at all.
        preparedByLabel: "Prepared by:",
        // The word joining the two parties in the stacked design's "BETWEEN:" block, freely
        // overridable the same way. "-and-" is the standard civil and family joiner (a High
        // Court directions template on judiciary.uk reads "BETWEEN: [Claimant] Claimant -and-
        // [Defendant] Defendant"); criminal matters use "R v [Defendant]" rather than a BETWEEN
        // heading, and this tool only draws BETWEEN. "-and-" is the default; set "-v-", any
        // other wording, or "" to draw no joiner at all, just the gap.
        partyJoiner: "-and-",
      },
      ocr: {
        // On by default: a scanned page is checked (a character count against its own real text
        // layer, pdf.js's own) the moment it is added, and OCR'd automatically if it is short of
        // the threshold, so a bundle of already-text PDFs costs nothing extra and a scanned one
        // becomes searchable with nothing pressed. Force OCR (per document, in the Review Table)
        // works regardless of this setting, for the automatic check's own false negatives.
        autoDetect: true,
        // The command line's own on/off switch, independent of autoDetect above (a browser-only
        // setting this field has no bearing on). "auto" matches the browser's default behaviour
        // (only pages under bundletoolOcr.js's own character threshold are OCR'd); "off" skips OCR
        // entirely, for a caller that wants build speed or has no OCR runtime available. A file's
        // own "forceOcr" (manifest-only, not a Config field) overrides this per document, mirroring
        // the browser's Force OCR button.
        mode: "auto",
        // Off by default, browser and command line alike, and only ever applied to a scanned page OCR reads (one
        // with no visible text of its own): turnUpright gives a page the reader turned a quarter turn to read that
        // turn in its own /Rotate, so it is shown upright; straighten turns a tilted page's content level about its
        // centre, up to bundletoolOcrReorient.js's STRAIGHTEN_MAX. Both change the document's pages losslessly.
        turnUpright: false,
        straighten: false,
      },
    };
  }

  /**
   * Method to update options
   * Options mainly passed in from frontend.
   */
    updateOptions(newOptions) {
      this.options = {
        heading: { ...this.options.heading, ...newOptions.heading },
        pageNumbering: { ...this.options.pageNumbering, ...newOptions.pageNumbering },
        index: { ...this.options.index, ...newOptions.index },
        pageOptions: { ...this.options.pageOptions, ...newOptions.pageOptions },
        cover: { ...this.options.cover, ...newOptions.cover },
        ocr: { ...this.options.ocr, ...newOptions.ocr },
      };
      // Font keys are coerced HERE rather than at each of the four places that
      // feed a stored configuration in (bundle reload, autosave snapshot, saved
      // default configuration, direct API use). A key this build cannot load
      // (a font this build does not ship, or an empty string from a <select> that
      // was handed a value it has no option for) becomes the fallback instead
      // of reaching validateOptions() and throwing.
      this.options.index.fontFace = normaliseFontKey(this.options.index.fontFace);
      this.options.pageNumbering.footerFont = normaliseFontKey(this.options.pageNumbering.footerFont);
    }

  /**
   * Method to validate options
   * Defines valid values
   * Errors thrown for invalid options
  */
  validateOptions() {
    if (!validFonts.includes(this.options.index.fontFace)) {
      throw new Error(`Invalid index font: ${this.options.index.fontFace}`);
    }
    if (!validFonts.includes(this.options.pageNumbering.footerFont)) {
        throw new Error(`Invalid footer font: ${this.options.pageNumbering.footerFont}`);
    }
    if (!validFontSize.includes(this.options.pageNumbering.footerFontSize)) {
      throw new Error(`Invalid footer font size: ${this.options.pageNumbering.footerFontSize}`);
    }
    if (!validFontSize.includes(this.options.heading.fontSize)) {
      throw new Error(`Invalid heading font size: ${this.options.heading.fontSize}`);
    }
    if (!validFontSize.includes(this.options.index.fontSize)) {
      throw new Error(`Invalid index font size: ${this.options.index.fontSize}`);
    }
    if (!validAlignments.includes(this.options.pageNumbering.alignment)) {
      throw new Error(`Invalid alignment: ${this.options.pageNumbering.alignment}`);
    }
    if (!validNumberingStyles.includes(this.options.pageNumbering.numberingStyle)) {
      throw new Error(`Invalid numbering style: ${this.options.pageNumbering.numberingStyle}`);
    }
    if (!validDateStyles.includes(this.options.index.dateStyle)) {
      throw new Error(`Invalid date style: ${this.options.index.dateStyle}`);
    }
    if (!validDateInputOrder.includes(this.options.index.dateInputOrder)) {
      throw new Error(`Invalid date input order: ${this.options.index.dateInputOrder}`);
    }
    if (!validOutlineStyles.includes(this.options.index.outlineItemStyle)) {
      throw new Error(`Invalid outline item style: ${this.options.index.outlineItemStyle}`);
    }
    if (!validPageSizes.includes(this.options.pageOptions.pageSize)) {
      throw new Error(`Invalid page size: ${this.options.pageOptions.pageSize}`);
    }
    if (!validPrintableBundle.includes(this.options.pageOptions.printableBundle)) {
      throw new Error(`Invalid printable bundle option: ${this.options.pageOptions.printableBundle}`);
    }
    if (!validOcrAutoDetect.includes(this.options.ocr.autoDetect)) {
      throw new Error(`Invalid OCR auto-detect option: ${this.options.ocr.autoDetect}`);
    }
    if (!validOcrMode.includes(this.options.ocr.mode)) {
      throw new Error(`Invalid OCR mode: ${this.options.ocr.mode}`);
    }
    if (!validOcrTurnUpright.includes(this.options.ocr.turnUpright)) {
      throw new Error(`Invalid OCR turn upright option: ${this.options.ocr.turnUpright}`);
    }
    if (!validOcrStraighten.includes(this.options.ocr.straighten)) {
      throw new Error(`Invalid OCR straighten option: ${this.options.ocr.straighten}`);
    }
    if (!validSmallerPhotos.includes(this.options.pageOptions.smallerPhotos)) {
      throw new Error(`Invalid smaller photos option: ${this.options.pageOptions.smallerPhotos}`);
    }
    if (!validCoversheet.includes(this.options.pageOptions.coversheet)) {
      throw new Error(`Invalid coversheet option: ${this.options.pageOptions.coversheet}`);
    }
    if (!validGenerateCover.includes(this.options.pageOptions.generateCover)) {
      throw new Error(`Invalid generateCover option: ${this.options.pageOptions.generateCover}`);
    }
    if (!validWatermark.includes(this.options.pageOptions.watermark)) {
      throw new Error(`Invalid watermark option: ${this.options.pageOptions.watermark}`);
    }
    if (!validCoverSources.includes(this.options.pageOptions.coverSource)) {
      throw new Error(`Invalid cover source: ${this.options.pageOptions.coverSource}`);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(String(this.options.pageOptions.watermarkColour))) {
      throw new Error(`Invalid watermark colour: ${this.options.pageOptions.watermarkColour}`);
    }
    {
      const opacity = Number(this.options.pageOptions.watermarkOpacity);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) {
        throw new Error(`Invalid watermark opacity: ${this.options.pageOptions.watermarkOpacity}`);
      }
    }
    // Any hex colour is valid; the three named presets ("black", "red",
    // "blue") validate too, for bundles and autosave snapshots that store a
    // name.
    if (!/^#[0-9a-fA-F]{6}$/.test(String(this.options.pageNumbering.pageNumberColour))
      && !validPageNumberColours.includes(this.options.pageNumbering.pageNumberColour)) {
      throw new Error(`Invalid page number colour: ${this.options.pageNumbering.pageNumberColour}`);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(String(this.options.pageNumbering.plateColour))) {
      throw new Error(`Invalid footer plate colour: ${this.options.pageNumbering.plateColour}`);
    }
    {
      const opacity = Number(this.options.pageNumbering.plateOpacity);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) {
        throw new Error(`Invalid footer plate opacity: ${this.options.pageNumbering.plateOpacity}`);
      }
    }
    if (!validFrontMatterNumbering.includes(this.options.pageNumbering.frontMatterNumbering)) {
      throw new Error(`Invalid front matter numbering: ${this.options.pageNumbering.frontMatterNumbering}`);
    }
    {
      const off = Number(this.options.pageNumbering.footerOffset);
      if (!Number.isFinite(off) || off < -30 || off > 60) {
        throw new Error(`Invalid footer offset: ${this.options.pageNumbering.footerOffset}`);
      }
    }
    if (!validCoverLayouts.includes(this.options.cover.layout)) {
      throw new Error(`Invalid cover layout: ${this.options.cover.layout}`);
    }
    if (!validCoverCaseLines.includes(this.options.cover.caseNumberLine)) {
      throw new Error(`Invalid cover case number line: ${this.options.cover.caseNumberLine}`);
    }
    if (!validCoverLabelPlacements.includes(this.options.cover.partyLabelPlacement)) {
      throw new Error(`Invalid cover party label placement: ${this.options.cover.partyLabelPlacement}`);
    }
    if (!validCoverPartyAligns.includes(this.options.cover.caseNumberAlign)) {
      throw new Error(`Invalid cover case number alignment: ${this.options.cover.caseNumberAlign}`);
    }
    if (!validCoverPartyAligns.includes(this.options.cover.headingAlign)) {
      throw new Error(`Invalid cover heading alignment: ${this.options.cover.headingAlign}`);
    }
    if (!validCoverTitleLines.includes(this.options.cover.titleLines)) {
      throw new Error(`Invalid cover title lines: ${this.options.cover.titleLines}`);
    }
    if (!validCoverPartyAligns.includes(this.options.cover.partyAlign)) {
      throw new Error(`Invalid cover party alignment: ${this.options.cover.partyAlign}`);
    }
    if (!validFooterLinks.includes(this.options.pageNumbering.footerLink)) {
      throw new Error(`Invalid footer link: ${this.options.pageNumbering.footerLink}`);
    }
    if (!validTableBorders.includes(this.options.index.showTableBorders)) {
      throw new Error(`Invalid show table borders option: ${this.options.index.showTableBorders}`);
    }
    if (!justTheIndex.includes(this.options.index.justTheIndex)) {
      throw new Error(`Invalid justTheIndex option: ${this.options.index.justTheIndex}`);
    }
    if (!validSectionPrefixes.includes(this.options.index.sectionPrefix)) {
      throw new Error(`Invalid section prefix: ${this.options.index.sectionPrefix}`);
    }
    if (!validPageNumberPerSection.includes(this.options.pageNumbering.pageNumberPerSection)) {
      throw new Error(`Invalid pageNumberPerSection option: ${this.options.pageNumbering.pageNumberPerSection}`);
    }
  }

  /**
   * Method to validate structure
   * Defines required fields
   * Errors thrown for missing fields
  */
 validateStructure() {
    const requiredPaths = {
      heading: ["claimNumber", "bundleTitle", "projectName", "author", "fontSize"],
      pageNumbering: ["footerFont", "footerFontSize", "alignment", "numberingStyle", "footerPrefix", "pageNumberColour", "pageNumberPerSection", "plateColour", "plateOpacity", "footerLink", "frontMatterNumbering", "footerOffset"],
      index: ["fontFace", "fontSize", "dateStyle", "dateInputOrder", "outlineItemStyle", "showTableBorders", "justTheIndex", "sectionPrefix", "indexBookmarkLabel", "headingText"],
      pageOptions: ["pageSize", "printableBundle", "coversheet", "generateCover", "coverSource", "watermark", "watermarkText", "watermarkColour", "watermarkOpacity", "smallerPhotos"],
      cover: ["courtName", "matterOf", "applicantName", "respondentName", "partyLabel1", "partyLabel2", "extraText", "claimNumber", "bundleTitle", "author", "layout", "caseNumberLine", "partyLabelPlacement", "partyAlign", "caseNumberAlign", "headingAlign", "titleLines", "caseNumberLabel", "preparedByLabel", "partyJoiner"],
      ocr: ["autoDetect", "mode", "turnUpright", "straighten"],
    };

    for (const [section, fields] of Object.entries(requiredPaths)) {
      if (!this.options[section]) {
        throw new Error(`Invalid config: Missing configuration section: ${section}`);
      }
      for (const field of fields) {
        if (this.options[section][field] === undefined) {
          throw new Error(`Invalid config: Missing configuration field: ${section}.${field}`);
        }
      }
    }
  }

  /**
   * Method to retrieve option by key path
   * returns value, or null if not found
   */
  getOption(key) {
    return key.split(".").reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : null), this.options);
    }
  }

export default Config;