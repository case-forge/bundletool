/**
 * BunTool
 * Copyrght (c) 2025-2026 Tris Sheriker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation  of legal bundles.
 *
 *  * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolToc.js
 * This module handles the creation of Table of Contents pages using jsPDF to generate new pdf documents.
 */

import { jsPdfFormat } from './bundletoolPageSize.js'
import Config from './bundletoolConfig.js';
import { validFonts, normaliseFontKey } from './bundletoolConfig.js';
import { getFontSettings } from './bundletoolFontSettings.js';
import { lazyImport } from '/js/shared/lazy-load.js';

// jsPDF and its autoTable plugin (jointly ~244KB) are only needed once a bundle actually gets an index
// page built, which is well after page load, so both are fetched lazily, through the two memoized
// getters below rather than a module-level import. Memoized (not just called inline at each use) for
// two reasons: frontend.js's idle warm-up calls these same getters ahead of time, so the real "Create
// Bundle" click reuses an already-resolved promise instead of starting the fetch cold; and a rejection
// clears its own memo, so a later, separate call gets a fresh attempt rather than a standing failure
// for as long as the page is open (lazyImport's own cache-busted retry covers one call, not that).
let _jsPdfPromise = null;
export function getJsPdfCtor() {
  if (!_jsPdfPromise) {
    const p = lazyImport(new URL('./vendor/jspdf.js', import.meta.url)).then((ns) => ns.jsPDF);
    p.catch(() => { if (_jsPdfPromise === p) _jsPdfPromise = null; });
    _jsPdfPromise = p;
  }
  return _jsPdfPromise;
}

let _autoTablePromise = null;
export function getAutoTable() {
  if (!_autoTablePromise) {
    const p = lazyImport(new URL('./vendor/jspdf-autotable.js', import.meta.url)).then((ns) => ns.default);
    p.catch(() => { if (_autoTablePromise === p) _autoTablePromise = null; });
    _autoTablePromise = p;
  }
  return _autoTablePromise;
}

/**
 * Formats a date string according to the specified style.
 * @param {string} entryDate - Date string in YYYY-MM-DD format
 * @param {string} style - Desired date format style (e.g., "YYYY-MM-DD", "DD-MM-YYYY", "DD Mon. YYYY", etc.)
 * @returns {string} Formatted date string, or empty string if style is "None"
 */
export function formatDate(entryDate, style) {

  const monthFullName = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const monthShortName = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];

  if (!entryDate || entryDate === '') {
    return '';
  }

  // entry.date is a free-text field a user can type into (or chrono-node's
  // parse of a date in the file name), so it is not guaranteed to be
  // YYYY-MM-DD. A malformed value is shown as it is, rather than throwing
  // (d.padStart on undefined when split() does not return three parts) and
  // breaking the whole index page over one date.
  const parts = entryDate.split("-");
  const [y, m, d] = parts;
  const monthNumber = Number(m) - 1;
  if (parts.length !== 3 || !y || !m || !d || Number.isNaN(Number(m)) || Number.isNaN(Number(y)) || monthNumber < 0 || monthNumber > 11) {
    console.warn('[toc] formatDate: a date is not YYYY-MM-DD, showing as-is');
    return entryDate;
  }
  const year = y;
  const day = d.padStart(2, "0");
  switch (style) {
    case "YYYY-MM-DD":
      return `${year}-${m}-${d}`;
    case "DD-MM-YYYY":
      return `${day}-${m}-${year}`;
    case "MM/DD/YYYY":
      return `${m}/${day}/${year}`;
    case "DD Mon. YYYY":
      return `${day} ${monthShortName[monthNumber]} ${year}`;
    case "DD Month YYYY":
      return `${day} ${monthFullName[monthNumber]} ${year}`;
    case "Mon DD, YYYY":
    case "Mon. DD, YYYY": // accepted from saved settings and bundles
      return `${monthShortName[monthNumber]} ${day}, ${year}`;
    case "Month DD, YYYY":
      return `${monthFullName[monthNumber]} ${day}, ${year}`;
    case "None":
      return "";
    default:
      return entryDate;
  }
}

/**
 * Creates table of contents entries from index data.
 * Processes input documents and section headings, calculating page numbers and tab numbers.
 * Each entry holds the tab or section number, title, date, the first page number in the PDF,
 * the first page number within its section, and the filename.
 * @param {Array<Object>} indexData - indexData object (bundletoolIndexData.js class)
 * @param {Config} config - Configuration object containing pageOptions.printableBundle flag
 * @returns {Promise<Array<Object>>} Array of TOC entry objects with tab numbers, titles, dates, page references, and blankPageAfter flag
 */
export async function createTocEntries(indexData, config) {
  let tocEntries = [];
  let pdfPageCountTracker = 0;
  let tabNumberTracker = 0;
  let sectionNumberTracker = 0;
  const coversheetOffset = config.getOption('pageOptions.coversheet') ? 1 : 0;

  for (let si = 0; si < indexData.sections.length; si++) {
    const section = indexData.sections[si];
    let sectionPageCountTracker = 0;
    const isZerothSection = section.sectionID === '0000'; // special case for zeroth section,
    // which is really the null section

    if (!isZerothSection) sectionNumberTracker++;

    const remainingSections = indexData.sections.slice(si + 1);
    const hasFilesAfter = section.files.length > 0 || remainingSections.some(s => s.files.length > 0);
    const sectionBeginPage = hasFilesAfter
      ? pdfPageCountTracker + 1 + coversheetOffset
      : pdfPageCountTracker + coversheetOffset;

    const entries = [];

    for (const file of section.files) {
      tabNumberTracker++;

      // A missing or non-numeric pageCount would propagate as NaN through
      // every page-number calculation for the REST of the bundle (NaN + n
      // is always NaN), so one bad file would wreck every page number after
      // it with no error anywhere. It is coerced to 0 and surfaced through
      // the same recovered/recoveryNote path damaged-PDF recovery uses.
      const pageCountValid = Number.isFinite(file.pageCount) && file.pageCount > 0;
      const pageCount = pageCountValid ? file.pageCount : 0;
      if (!pageCountValid) {
        console.warn(`[toc] a document has no valid page count (got ${file.pageCount}); treating as 0 pages`);
      }
      const willAddBlankPage = config.getOption('pageOptions.printableBundle') && (pageCount % 2 === 1);

      entries.push({
        tabNumber:             tabNumberTracker,
        title:                 file.title,
        date:                  file.date,
        pageCount:             pageCount,
        // Set when the source PDF was damaged and only partially recovered,
        // or when its page count couldn't be determined at all (see above).
        recovered:             file.recovered === true || !pageCountValid,
        recoveryNote:          file.recoveryNote || (!pageCountValid ? 'Page count unknown; treated as 0 pages.' : ''),
        // Carried through to the embedded bundle index for the same reason
        // as recovered above, but deliberately NOT appended to the title the
        // way recovered is further down this file: that would permanently
        // mark the document in the finished bundle's own index, which goes
        // beyond the add-time warning this field is for.
        convertedFromDocx:     file.convertedFromDocx === true,
        beginsOnPdfPage:       pdfPageCountTracker + 1 + coversheetOffset,
        beginsOnPageOfSection: sectionPageCountTracker + 1,
        filename:              file.filename,
        blankPageAfter:        willAddBlankPage
      });

      pdfPageCountTracker += pageCount;
      sectionPageCountTracker += pageCount;
      if (willAddBlankPage) {
        pdfPageCountTracker += 1;
        sectionPageCountTracker += 1;
      }
    }

    tocEntries.push({
      sectionID:       section.sectionID,
      sectionNumber:   isZerothSection ? null : sectionNumberTracker,
      sectionLabel:    isZerothSection ? null : section.sectionLabel || '',
      sectionTitle:    isZerothSection ? null : section.sectionName || '',
      beginsOnPdfPage: sectionBeginPage,
      entries
    });
  }

  console.log(`[toc] ${tocEntries.length} index entries created`);
  return tocEntries;
}

/**
 * The index font, fetched once and base64-encoded once per URL for the life of
 * the page. A build calls makeTocPages TWICE (makeDummyTocPages measures how
 * many pages the index will be, then makeTocPages renders it for real), so
 * without this cache every bundle would fetch and encode both fonts twice, once
 * for a document that is thrown away.
 *
 * The encoding is chunked: btoa(bytes.reduce((s, b) => s + fromCharCode(b), ''))
 * builds the string quadratically, about 124ms across a 493KB font against 6ms
 * for the chunked form, with byte-identical output.
 *
 * Keyed by URL, so switching index font while the page is open still works and
 * pays once for the new one.
 */
const _fontCache = new Map();

async function loadIndexFontBase64(url) {
  const hit = _fontCache.get(url);
  if (hit) return hit;
  const buf = await fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Font fetch failed: ${res.url} (${res.status})`);
    return res.arrayBuffer();
  });
  const bytes = new Uint8Array(buf);
  // 8192 keeps each apply() well inside the argument-count limit that makes
  // the whole-array form throw on a large font.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const out = { bytes: buf, b64: btoa(bin) };
  _fontCache.set(url, out);
  return out;
}

/**
 * Generates the index: a PDF with a title, project name and a table that can span multiple pages.
 * This is a long function which operates on a single PDF document, and so is self-contained rather than
 * being split into sub-functions.
 * @param {Array<Object>} tocEntries - the index entries, by section (from createTocEntries)
 * @param {Object} options - Configuration options for the PDF
 * @param {Object} options.font - Font configuration
 * @param {string} options.font.family - Font family (default: 'helvetica')
 * @param {number} options.font.sizeTitle - Font size for title (default: 16)
 * @param {number} options.font.sizeProject - Font size for project name (default: 14)
 * @param {number} options.font.sizeTable - Font size for table content (default: 10)
 * @param {Object} options.color - Colour configuration
 * @param {string} options.color.headerFill - Background colour for header row (default: '#f8f8f8')
 * @param {string} options.color.headerText - Text colour for header row (default: '#000000')
 * @param {string} options.color.text - Main text colour (default: '#000000')
 * @param {Object} options.table - Table configuration
 * @param {number} options.table.cellPadding - Cell padding in mm (default: 3)
 * @param {Object} options.margins - Page margin configuration in mm
 * @param {number} options.margins.top - Top margin (default: 20)
 * @param {number} options.margins.right - Right margin (default: 15)
 * @param {number} options.margins.bottom - Bottom margin (default: 20)
 * @param {number} options.margins.left - Left margin (default: 15)
 * @param {Config} config - the bundle's configuration (heading, index and page options)
 * @param {number} [expectedTocLength=1] - how many pages the index takes, from makeDummyTocPages
 * @returns {Promise<[Uint8Array, Array<Object>, number]>} the PDF bytes, the table's row coordinates and the page count
 */
export async function makeTocPages(tocEntries, options = {}, config, expectedTocLength = 1) {

  // The index page's own heading. Blank reuses the bundle title.
  const title = String(config.getOption('index.headingText') ?? '').trim()
    || config.getOption('heading.bundleTitle') || 'Bundle Index';
  const project = config.getOption('heading.projectName');
  const claimNumber = config.getOption('heading.claimNumber');
  const dateStyle = config.getOption('index.dateStyle');
  const indexFontSize = config.getOption('index.fontSize');
  const titleFontSize = config.getOption('heading.fontSize');
  const showBorders = config.getOption('index.showTableBorders');
  const lineHeight = {large: 1.2, medium: 1.1, small: 1}[indexFontSize] || 1.2;

  // First, add formattedDate property to each entry
  for (const section of tocEntries) {
    for (const entry of section.entries) {
      if (entry.date && !entry.formattedDate) {
      entry.formattedDate = formatDate(entry.date, dateStyle);
      }
    }
  };


    // Fine-tuning of the index layout is through this internal config, not settings.
    const tocInternalConfig = {
      font: {
        family: options.font?.family || 'helvetica',
        sizeTitle: options.font?.sizeTitle || 24,
        sizeProject: options.font?.sizeProject || 18,
        sizeClaimNumber: options.font?.sizeClaimNumber || 14,
        sizeTable: options.font?.sizeTable || 12
      },
      color: {
        headerFill: options.color?.headerFill || [200, 200, 200],
        headerText: options.color?.headerText || [0, 0, 0],
        text: options.color?.text || 0,
      },
      table: {
        cellPadding: options.table?.cellPadding || 3,
      },
      margins: {
        top: options.margins?.top || 10,
        right: options.margins?.right || 25,
        bottom: options.margins?.bottom || 20,
        left: options.margins?.left || 25,
        parPadding: 9
      }
    };

    // Create the PDF document at the bundle's page size
    const jsPDF = await getJsPdfCtor();
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      // The index follows the bundle's page size. jsPDF takes a format NAME
      // here because this document is constructed in millimetres, which is
      // why bundletoolPageSize exposes jsPdfFormat() rather than points.
      format: jsPdfFormat(config.getOption('pageOptions.pageSize'))
    });

    // Set font for the document
    let fontForIndexBytes = [];
    let fontForTitleBytes = [];
    let fontForIndex = 'helvetica';
    let fontForTitle = 'helvetica';

    // Config.updateOptions() already coerces an unknown or retired font key, so
    // this is a backstop for a Config built some other way rather than the
    // first line of defence. It agrees with normaliseFontKey(), so there is
    // one answer to "what does an unrecognised font become" instead of two.
    if (!validFonts.includes(config.getOption('index.fontFace'))) {
      const replacement = normaliseFontKey(config.getOption('index.fontFace'));
      console.warn(`[WARNING] Invalid fontFace option '${config.getOption('index.fontFace')}'. Reverting to '${replacement}'.`);
      config.updateOptions({ index: { fontFace: replacement } });
    }

    // Look up font file paths, jsPDF names, and pt sizes from bundletoolFontSettings.js
    const fontDef = getFontSettings(config.getOption('index.fontFace'));

    //Get and set main font:
    const regularFont = await loadIndexFontBase64(fontDef.regular.url);
    fontForIndexBytes = regularFont.bytes;
    doc.addFileToVFS(fontDef.regular.vfsName, regularFont.b64);
    doc.addFont(fontDef.regular.vfsName, fontDef.regular.fontName, 'normal');
    fontForIndex = fontDef.regular.fontName;

    //Get and set title font:
    const boldFont = await loadIndexFontBase64(fontDef.bold.url);
    fontForTitleBytes = boldFont.bytes;
    doc.addFileToVFS(fontDef.bold.vfsName, boldFont.b64);
    doc.addFont(fontDef.bold.vfsName, fontDef.bold.fontName, 'bold');
    fontForTitle = fontDef.bold.fontName;

    //set font sizes:
    tocInternalConfig.font.sizeClaimNumber = fontDef.sizes.claimNumber[titleFontSize] ?? fontDef.sizes.claimNumber.medium;
    tocInternalConfig.font.sizeTitle       = fontDef.sizes.title[titleFontSize]       ?? fontDef.sizes.title.medium;
    tocInternalConfig.font.sizeProject     = fontDef.sizes.project[titleFontSize]     ?? fontDef.sizes.project.medium;
    //set table font size:
    tocInternalConfig.font.sizeTable       = fontDef.sizes.table[indexFontSize]       ?? fontDef.sizes.table.medium;

    doc.setFont(fontForIndex);

    // Get page dimensions
    const pageWidth = doc.internal.pageSize.getWidth();
    const borderWidths = { top: 0.2, right: 0.2, bottom: 0.3, left: 0.2 };

    // Add Claim No, right-aligned at the top:
    doc.setFontSize(tocInternalConfig.font.sizeClaimNumber);
    doc.setTextColor(tocInternalConfig.color.text);
    doc.text(
      claimNumber,
      pageWidth - tocInternalConfig.margins.right,
      tocInternalConfig.margins.top,
      { maxWidth: pageWidth * 0.8, align: 'right' }
    );

    // Measure the claim number's height to position the next element:
    const claimNumberHeight = doc.getTextDimensions(claimNumber, {
      maxWidth: pageWidth * 0.8,
      align: 'right',
    }).h;
    const projectNameYOffset = tocInternalConfig.margins.top + claimNumberHeight + tocInternalConfig.margins.parPadding-5;

    // Add project name
    doc.setFontSize(tocInternalConfig.font.sizeProject);
    doc.text(
      project,
      (pageWidth) / 2,
      projectNameYOffset,
      { maxWidth: pageWidth * 0.9, align: 'center' }
    );

    // Measure its dimensions to position the next elements
    const projectNameDimensions = doc.getTextDimensions(project, {
      maxWidth: pageWidth * 0.9,
      align: 'center',
    });

    const titleYOffset = projectNameYOffset + projectNameDimensions.h + tocInternalConfig.margins.parPadding;

    // Add bundle title
    doc.setFontSize(tocInternalConfig.font.sizeTitle)
    doc.setFont(fontForTitle, 'bold'); // setFontStyle is deprecated
    let titleDimensions = {};
    doc.setTextColor(tocInternalConfig.color.text); // Reset text colour to default
    doc.text(
      title,
      pageWidth / 2,
      titleYOffset,
      { maxWidth: pageWidth * 0.7, align: 'center' }
    );
    // Measure the title's height and width to position the next element
    titleDimensions = doc.getTextDimensions(title,
      {
        maxWidth: pageWidth * 0.7,
        align: 'center'
      });

    // Add tramlines:
    // width = title width
    // the first line goes above the title, the second under it
    // The -5 and +5 in the x coordinates just extend the lines beyond the title a little
    // The rules are 0.6mm (the document unit is mm): 1.7pt, about 2.3px on a 96dpi
    // screen, which reads as a deliberate rule at print size rather than a hairline.
    // The draw colour is full black.
    doc.setLineWidth(0.6);
    doc.setDrawColor(0, 0, 0);
    doc.line(
      ((pageWidth - titleDimensions.w) / 2) - 5,
      titleYOffset - tocInternalConfig.margins.parPadding,
      ((pageWidth + titleDimensions.w) / 2) + 5,
      titleYOffset - tocInternalConfig.margins.parPadding
    );
    doc.line(
      ((pageWidth - titleDimensions.w) / 2) - 5,
      titleYOffset + titleDimensions.h - 3,
      ((pageWidth + titleDimensions.w) / 2) + 5,
      titleYOffset + titleDimensions.h - 3
    );

    // Now move on to set up the table of entries:
    const indexTableYOffset = titleYOffset + titleDimensions.h + tocInternalConfig.margins.parPadding - 4;

    // Prepare table data
    const showDate = config.getOption('index.dateStyle') !== 'None';
    // A split part's own index (bundletoolSplitOwn.js) says where each document sits in the whole
    // bundle too: an entry carrying `bundlePage` adds a "Bundle page" column. An ordinary index has none.
    const showBundlePage = tocEntries.some((section) => section.entries.some((entry) => entry.bundlePage != null));
    const pageNumberPerSection = config.getOption('pageNumbering.pageNumberPerSection');
    // What the index PRINTS for a page must match what that page's own footer actually says
    // (buildFooterTexts, bundletoolPages.js), not the page's raw physical position in the
    // finished PDF. Under 'continuous' those are the same number. Under 'roman'/'skip' the
    // footer restarts the documents at 1, subtracting the front matter (cover + index) from
    // the physical position: the index has to subtract the same amount, or it names a page
    // number that appears nowhere in the bundle. actualPdfStartPageWithToc itself is NOT
    // touched by this: addHyperlinks/addOutlineItems and the embedded bundle index
    // (bundletoolMeta.js) use it as the real physical page for navigation, and repurposing it
    // for display would silently send a bookmark to the wrong page.
    const coversheetOffset = config.getOption('pageOptions.coversheet') ? 1 : 0;
    const frontMatterMode = config.getOption('pageNumbering.frontMatterNumbering') || 'continuous';
    const frontMatterOffset = frontMatterMode === 'continuous' ? 0 : Math.max(0, coversheetOffset + expectedTocLength);
    const body = [];
    for (const section of tocEntries) {
      if (section.sectionID !== '0000') {
        // Set actualPdfStartPageWithToc on tocEntries itself, so
        // addHyperlinks/addOutlineItems can use it: this accounts for the
        // pages the index adds after the first calculation
        section.actualPdfStartPageWithToc = section.beginsOnPdfPage + expectedTocLength;
        let pagesInThisSection = 1 + (section.entries || []).reduce((sum, entry) =>
          sum + (Number(entry.pageCount) || 0) + (entry.blankPageAfter ? 1 : 0)
        , 0);
        // The word before the section label is a setting (index.sectionPrefix):
        const left = [config.getOption('index.sectionPrefix') || '', section.sectionLabel].filter(Boolean).join(' ');
        const sectionPageDisplay = pageNumberPerSection
          ? `${section.sectionLabel || ''}1 - ${section.sectionLabel || ''}${pagesInThisSection}`
          : (() => {
              const start = (Number(section.actualPdfStartPageWithToc) || 0) - frontMatterOffset;
              const end = start - 1 + Number(pagesInThisSection) - 1;
              return `${start} - ${end}`;
            })();
        // now push values for the table:
        body.push({
          tabNumber:    '',
          title: [left, section.sectionTitle].filter(Boolean).join(': ') || '',
          ...(showDate && { formattedDate: '' }),
          actualPdfStartPageWithToc: section.entries.length > 0 ? sectionPageDisplay : '',
          ...(showBundlePage && { bundlePage: '' }),
          isSectionHeading: true
        });
      }
      for (const entry of section.entries) {
        // as above, set new actual start page property for tocEntries entry:
        entry.actualPdfStartPageWithToc = entry.beginsOnPdfPage + expectedTocLength;
        const entryPageDisplay = pageNumberPerSection
          ? `${section.sectionLabel || ''}${entry.beginsOnPageOfSection}`
          : entry.actualPdfStartPageWithToc - frontMatterOffset;
        // now push values for the table:
        body.push({
          tabNumber:   entry.tabNumber,
          // A recovered document is flagged in the index itself. Whoever reads
          // the bundle needs to know which documents came from a damaged file,
          // not just whoever built it.
          title:       entry.recovered ? `${entry.title}  [recovered, may be incomplete]` : entry.title,
          ...(showDate && { formattedDate: entry.formattedDate || '' }),
          actualPdfStartPageWithToc: entryPageDisplay,
          ...(showBundlePage && { bundlePage: String(entry.bundlePage ?? '') }),
          isSectionHeading: false
        });
      }
    }

    //define autotable content by reference to headers
    const headers = {
      tabNumber: 'Tab',
      title: 'Title',
      ...(showDate && {formattedDate: 'Date'}),
      actualPdfStartPageWithToc: 'Page',
      ...(showBundlePage && { bundlePage: 'Bundle page' })
    }

    const tableWidthSetting = pageWidth - tocInternalConfig.margins.left - tocInternalConfig.margins.right;
    const rowCoordinates = [];

    // Configure autoTable
    const autoTable = await getAutoTable();
    autoTable(doc, {
      head: [headers],
      body: body,
      startY: indexTableYOffset, // Start below the title and project name
      margin: {
        top: tocInternalConfig.margins.top,
        right: tocInternalConfig.margins.right,
        bottom: tocInternalConfig.margins.bottom,
        left: tocInternalConfig.margins.left
      },
      styles: {
        fontSize: tocInternalConfig.font.sizeTable,
        cellPadding: tocInternalConfig.table.cellPadding,
        lineColor: showBorders ? tocInternalConfig.color.text : false,
        lineWidth: showBorders ? borderWidths : 0,
        font: fontForIndex,
        textColor: tocInternalConfig.color.text,
        lineHeight: lineHeight
      },
      headStyles: {
        fillColor: tocInternalConfig.color.headerFill,
        textColor: tocInternalConfig.color.headerText,
        font: fontForTitle,
      },
      alternateRowStyles: {
        fillColor: [255, 255, 255]
      },
      // Customise columns
      columnStyles: {
        0: { halign: 'right' },
        ...(showDate && { 2: { minCellWidth: 28 } }), // date, if shown
        [showDate ? 3 : 2]: { halign: 'right' }, // the index shifts with showDate
        ...(showBundlePage && { [showDate ? 4 : 3]: { halign: 'right', minCellWidth: 26 } }),
      },
      tableWidth: tableWidthSetting,

      //Shading for section breaks
      didParseCell: (data) => {
        if (data.section === "body" && data.row.raw.isSectionHeading) {
          data.cell.styles.fillColor = [225, 225, 225];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.font = fontForTitle;
          data.cell.styles.halign = 'left';
        }
      },

      // Handle page breaks automatically
      willDrawPage: function (data) {
        // Reset font and colours for each page
        doc.setFont(tocInternalConfig.font.family);
        doc.setTextColor(tocInternalConfig.color.text);
      },

      // jsPDF autotable reports where it drew each cell, so the coordinates can be used later:
      didDrawCell: (data) => {
        // Check if this is the first cell in the row (push once per row)
        if (data.section === "body" && data.column.index === 0) {
          const rowInfo = {
            rowNumber: data.row.index + 1, // Row number (1-based index)
            tabNumber: data.cell.raw, // Tab number from the cell
            x: data.cell.x, // X-coords of the row
            y: data.cell.y, // Y-coords of the row
            width: tableWidthSetting,  // Width of the row (=entire table width)
            height: data.row.height, // Height of the row
            pageNumber: data.pageNumber, // Page number where the row is located
            sectionMarker: data.row.raw.isSectionHeading // Whether this row is a section break
          };
          rowCoordinates.push(rowInfo);
        }
      },
    });
    console.log(`[toc] drew index table (${rowCoordinates.length} rows)`);
    const docBytes = doc.output('arraybuffer'); // Get the PDF as an ArrayBuffer
    const uint8Array = new Uint8Array(docBytes); // Convert ArrayBuffer to Uint8Array
    const pageCount = doc.internal.getNumberOfPages();
    return [uint8Array, rowCoordinates, pageCount];
  }

/**
 * Generates dummy TOC pages to determine how many pages the TOC will take up.
 * This is necessary to calculate the correct page numbers for the actual TOC entries.
 * @param {Array<Object>} tocEntries - Array of TOC entry objects
 * @param {Object} options - Configuration options for the PDF
 * @param {Object} config - Configuration object containing heading and index options
 * @returns {Promise<number>} The number of pages the TOC will occupy
 */
export async function makeDummyTocPages (tocEntries, options = {}, config) {
  let dummyTocEntries = tocEntries;
  const [dummyTocPdf, _, pageCount] = await makeTocPages(dummyTocEntries, options, config, 1);
  return pageCount;
}

