/**
 * BunTool
 * Copyrght (c) 2025-2026 Tris Sheriker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation  of legal bundles.
 *  * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolMain.js
 * Main logic pipeline module
 */
import Config from './bundletoolConfig.js';
import {
  createTocEntries,
  makeTocPages,
  makeDummyTocPages,
  } from './bundletoolToc.js';
import {
  addPageNumberingViaWorker,
  validateCoverPage,
  flattenFooterConfig,
  buildPageLabels,
  } from './bundletoolPages.js';
import {
  mergeTwoPdfsViaWorker as mergeTwoPdfs,
  } from './bundletoolMerge.js';
import {
  flattenConfig,
  } from './bundletoolMeta.js';
import {
  runBuildViaWorker,
  } from './bundletoolBuild.js';
import {
  makeCoverPdf,
  flattenCoverConfig,
  resolveCoverSource,
  } from './bundletoolCover.js';

/**
 * Function to process the bundle of PDFs according to the provided configuration.
 * @param {Map<string, File>} filesMap
 * @param {Array<Object>} indexData
 * @param {Config} config
 * @param {Function} [onProgress]
 * @param {File|null} [coversheetFile] - the user's own first page, if they supplied one.
 *        It wins over the generated cover; see bundletoolCover.js.
 * @returns {Promise<Uint8Array>} The processed payload PDF as a Uint8Array.
 */
export async function processTheBundle(filesMap, indexData, config, onProgress, coversheetFile = null){

    let payloadPdf = new Uint8Array();

  // The index layout used by makeTocPages. These are fixed defaults, kept in
  // one object so they can become settings.
  const tocOptions = {
    font: {
      family: 'helvetica',
      sizeTitle: 18,
      sizeProject: 14,
      sizeTable: 11
    },
    color: {
      headerFill: [200, 200, 200],
      //  headerText: 150,
      //  text: 250
    },
    table: {
      showBorders: true,
      cellPadding: 2,
      lineHeight: 1.3
    },
    margins: {
      top: 25,
      right: 22,
      bottom: 25,
      left: 22
    }
  };

  console.log('[0/13] Validating files and indexData structure...');
  console.log(`Processing bundle: ${indexData.totalFileCount} files across ${indexData.sections.length} section(s), ${indexData.totalPageCount} total pages`);

  if (!filesMap || filesMap.size === 0) {
    throw new Error('Error: No files provided');
  }

  if (!indexData) {
    throw new Error('Error: No index data provided');
  }
  try {
    indexData.validateIndexStructure();
  } catch (error) {
    console.error(`[ERROR] Index data structure validation error: `, error.message);
    throw error;
  }
  console.log('[0/13]...done')
  onProgress?.('Validating files and index data…');

  console.log('[1/13] Validating configuration...');
  if (!config) {
    throw new Error('Error: No configuration provided');
  }

  // WHERE THE COVER PAGE COMES FROM. Resolved once, here, so that every later
  // stage reads one flag rather than each working it out again.
  //
  //   an uploaded coversheet  -> 'uploaded'   (it wins; nothing is generated)
  //   otherwise, generateCover -> 'generated'
  //   otherwise                -> 'none'
  //
  // `pageOptions.coversheet` means "there is a cover page at physical page 1",
  // and is written back here so createTocEntries' coversheetOffset, applyMeta's
  // link offsets and the embedded index all agree with what was actually
  // merged. It follows the resolved cover source, not whether a file was
  // picked: a generated cover is a cover too.
  const coverSource = resolveCoverSource({
    hasUploadedCover: !!coversheetFile,
    generateCover: config.getOption('pageOptions.generateCover'),
  });
  config.updateOptions({
    pageOptions: { coversheet: coverSource !== 'none', coverSource },
  });

  // The index pages are merged in front of the documents and the cover, if any,
  // is prepended in front of the index, so the index is page 1 without a
  // cover and page 2 with one. The "Index" bookmark always links here.
  // Assuming page 1 is only right half the time.
  const indexPageIndex = coverSource !== 'none' ? 1 : 0;

  // Where the footer's own hyperlink goes is a setting: the index (the
  // default), the first page, or nowhere. Only the footer follows it; the
  // bookmark above does not.
  const footerLinkSetting = config.getOption('pageNumbering.footerLink') || 'index';
  const footerLinkPageIndex =
    footerLinkSetting === 'none' ? null :
    footerLinkSetting === 'top'  ? 0 :
    indexPageIndex;

  try //validate structure with method from bundletoolConfig
  {
    config.validateStructure();
  } catch (error) {
      console.error(`[ERROR] Config structure validation error: `, error.message);
      throw error;
  }
  console.log('[1/13]...done')
  onProgress?.('Validating configuration…');

  console.log('[2/13] Validating configuration options...');
  try { //validate options with method from bundletoolConfig
    config.validateOptions();
  } catch (error) {
      console.error(`[ERROR] Config validation error: `, error.message);
      throw error;
  }
  console.log('[2/13]...done')

  let coverPdf = null;
  if (coverSource === 'uploaded') {
    console.log('[3/13] Validating coversheet...');
    try {
      coverPdf = await validateCoverPage(coversheetFile);
      console.log('[3/13]...done');
    } catch (error) {
      console.error('[ERROR] Failed to validate coversheet: ', error.message);
      throw error;
    }
  } else if (coverSource === 'generated') {
    console.log('[3/13] Generating cover page...');
    onProgress?.('Generating cover page…');
    try {
      coverPdf = await makeCoverPdf(flattenCoverConfig(config));
      console.log('[3/13]...done');
    } catch (error) {
      console.error('[ERROR] Failed to generate cover page: ', error.message);
      throw error;
    }
  }
  onProgress?.('Creating index entries…');

  console.log('[4/13] Creating TOC entries...');
  let tocEntries;
  try {
    tocEntries = await createTocEntries(indexData, config);
    console.log('[4/13]...done')
  } catch (error) {
    console.error(`[ERROR] Failed to create TOC entries: `, error.message);
    throw error;
  }
  onProgress?.('Generating index pages…');

  console.log('[5/13] Generating dummy TOC pages...');
  let expectedLengthOfToc = 0;
  try {
    expectedLengthOfToc = await makeDummyTocPages(tocEntries, tocOptions, config);
    console.log(`[5/13]...done - dummy TOC PDF length: ${expectedLengthOfToc} pages`)
  } catch (error) {
    console.error(`[ERROR] Failed to generate dummy TOC pages: `, error.message);
    throw error;
  }

  console.log('[6/13] Generating TOC pages...');
  let tocPdf, tocTableRowCoordinates;
  try {
    [tocPdf, tocTableRowCoordinates] = await makeTocPages(tocEntries, tocOptions, config, expectedLengthOfToc);
    console.log(`[6/13]...done - TOC PDF size: ${tocPdf?.length || 0} bytes`)
  } catch (error) {
    console.error(`[ERROR] Failed to generate TOC pages: `, error.message);
    throw error;
  }

  if (config.getOption('index.justTheIndex')) {
    console.log('Config option justTheIndex is true - returning TOC PDF without merging content PDFs');
    let justIndexPdf = tocPdf;
    if (coverPdf) {
      justIndexPdf = await mergeTwoPdfs(coverPdf, justIndexPdf);
      console.log(`...prepended ${coverSource} cover - PDF size: ${justIndexPdf?.length || 0} bytes`);
    }
    onProgress?.('Adding page numbering…');
    justIndexPdf = await addPageNumberingViaWorker(justIndexPdf, config, tocEntries, footerLinkPageIndex);
    console.log(`...added page numbering - TOC PDF size: ${justIndexPdf?.length || 0} bytes`);
    return justIndexPdf;
  }
  onProgress?.('Merging documents…');

// PDF HANDLING: one worker, one pass.
//
// Steps 7 to 13 (source merge, index prepend, cover prepend, footer pass,
// metadata pass) run against a single PDFDocument inside one build worker
// (bundletoolBuild.js): each source is parsed once and the output is
// serialised once, with no full parse and serialise of the whole bundle
// between stages. On a 200-page, 29MB bundle those round trips would cost
// about 6.3s of a 7.8s build.
  console.log('[7-13/13] Building bundle (single pass: merge, footer, meta)...');
  try {
    const fileEntries = [];
    for (const section of tocEntries) {
      for (const entry of section.entries) {
        const file = filesMap.get(entry.filename);
        if (!file) throw new Error(`File not found in filesMap: ${entry.filename}`);
        // .arrayBuffer() returns a copy, so transferring it leaves the
        // frontend's File objects intact and re-bundling still works.
        fileEntries.push({ filename: entry.filename, buffer: await file.arrayBuffer() });
      }
    }

    payloadPdf = await runBuildViaWorker({
      coverBytes: coverPdf,
      tocBytes: tocPdf,
      fileEntries,
      printable: config.getOption('pageOptions.printableBundle'),
      pageSize: config.getOption('pageOptions.pageSize'),
      footerConfig: flattenFooterConfig(config),
      pageLabels: buildPageLabels(tocEntries, config.getOption('pageNumbering.pageNumberPerSection')),
      // Cover (0 or 1) + the index pages. Roman and skip numbering both need
      // to know where the front matter stops and the evidence starts.
      frontMatterCount: (coverSource !== 'none' ? 1 : 0) + expectedLengthOfToc,
      footerLinkPageIndex,
      metaConfig: flattenConfig(config),
      tocTableRowCoordinates,
      tocEntries,
    }, onProgress);
    console.log(`[7-13/13]...done - Final PDF size: ${payloadPdf?.length || 0} bytes`)
  } catch (error) {
    console.error(`[ERROR] Failed to build bundle: `, error.message);
    throw error;
  }

  console.log(`✓ Bundle processing complete! Returning PDF of size: ${payloadPdf?.length || 0} bytes`);

  return payloadPdf;
}