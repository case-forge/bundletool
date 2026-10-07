#!/usr/bin/env node
/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you
 * may not use this file except in compliance with the License. You may
 * obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * build-cli.mjs
 * Headless bundle build: reads a JSON manifest + a directory of source PDFs,
 * builds the exact same PDF the browser app would, writes it to disk. No
 * browser, no server. The cover follows the browser's rule: a supplied cover page
 * (manifest "coversheet"), else the cover maker's page when pageOptions.generateCover is true.
 *
 * The command line contract (exit codes, --json, error codes, --version) is shared with the
 * Envelope Guide CLI and lives in scripts/cli-contract.mjs; the promise is written down in the
 * README's "Command line" section and in manifest.schema.json.
 *
 * Deliberately does NOT go through processTheBundle() in bundletoolMain.js,
 * because that function's build/footer/merge stages are wired to
 * runBuildViaWorker() / addPageNumberingViaWorker() / mergeTwoPdfsViaWorker(),
 * which construct a browser `Worker`. This script calls the same underlying
 * functions those workers call (buildBundlePdf, createTocEntries,
 * makeTocPages, makeCoverPdf) directly and in-process, exactly as
 * tests/build.test.mjs does under plain `node --test`, which shows this is
 * safe: no DOM, no Worker, no browser API anywhere in this call path.
 *
 * SECURITY: manifest content never becomes code or a shell command. It is
 * treated as data: JSON.parse only (no eval/Function/vm). Every `filename`
 * (and the cover's) must be a plain file name, and the file it names must
 * really live inside the documents directory once symbolic links are
 * resolved. Every resolved file is re-validated as a real, unencrypted,
 * readable PDF via validateAndCountPages() before use, and a manifest's
 * claimed pageCount is IGNORED in favour of the count read back from the
 * actual bytes: a manifest cannot misstate page counts to put the index out
 * of step with the built pages.
 */

import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { EXIT, CliError, parseArgs, readName, readVersion, runCli, helpResult } from './cli-contract.mjs';
import { prettifyTitle, stripDoubleChars } from '../public/js/frontend/utils.js';
import { isOverPd27aLimit, pd27aNote } from '../public/js/frontend/limits.js';

const TOOL = readName(new URL('../package.json', import.meta.url));
const VERSION = readVersion(new URL('../package.json', import.meta.url));
const SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** The tool's description of itself (help, topics, README tables): scripts/cli-docs.mjs. */
async function buildHelpDoc() {
  const { limits } = await loadEngine();
  const { buildDoc } = await import('./cli-docs.mjs');
  return buildDoc({ version: VERSION, limits });
}

/** What a recognised but unsupported file is called in a message, or null for a PDF, JPEG, PNG or anything unrecognised (which fails as a PDF). */
function kindName({ kind, zip }) {
  const names = { gif: 'a GIF picture', bmp: 'a BMP picture', webp: 'a WEBP picture', tiff: 'a TIFF picture', avif: 'an AVIF picture', heic: 'a HEIC picture', ole: 'an old Office document' };
  if (kind === 'zip') return zip?.flavour === 'docx' ? 'a Word document' : 'a zip file';
  return names[kind] ?? null;
}

/** Loads the PDF engine and the bundle modules after the Node shim is in place. */
async function loadEngine() {
  await import('./node-compat.mjs');
  const [{ default: Config }, { IndexData }, pages, toc, meta, build, schema, cover, sniff, photo, limits] = await Promise.all([
    import('../public/js/bundletoolConfig.js'),
    import('../public/js/bundletoolIndexData.js'),
    import('../public/js/bundletoolPages.js'),
    import('../public/js/bundletoolToc.js'),
    import('../public/js/bundletoolMeta.js'),
    import('../public/js/bundletoolBuild.js'),
    import('../public/js/manifestSchema.js'),
    import('../public/js/bundletoolCover.js'),
    import('../public/js/bundletoolSniff.js'),
    import('../public/js/bundletoolPhotoPdf.js'),
    import('../public/js/frontend/limits.js'),
  ]);
  return { Config, IndexData, pages, toc, meta, build, schema, cover, sniff, photo, limits };
}

/** A file that is a plain name and really lives inside `docsReal` (symbolic links resolved). Returns its bytes. */
async function readInside(docsDir, docsReal, name, what) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name !== basename(name)
      || name.includes('\\') || name.includes('\0')) {
    throw new CliError('invalid_filename', `${what} ${JSON.stringify(String(name).slice(0, 80))} is not a plain file name. Name a file inside the documents directory, with no folder in front of it.`, { details: { file: String(name).slice(0, 80) } });
  }
  let real;
  try { real = await realpath(join(docsDir, name)); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new CliError('file_not_found', `${what} ${name} is not in the documents directory.`, { details: { file: name } });
    throw new CliError('file_unreadable', `${what} ${name} could not be read (${err.code ?? 'error'}).`, { details: { file: name } });
  }
  if (!real.startsWith(docsReal + sep)) {
    throw new CliError('path_outside_docs', `${what} ${name} resolves outside the documents directory, so it was not read.`, { details: { file: name } });
  }
  try { return { bytes: await readFile(real), real }; } catch (err) {
    throw new CliError('file_unreadable', `${what} ${name} could not be read (${err.code ?? 'error'}).`, { details: { file: name } });
  }
}

async function build(ctx, argv) {
  const args = parseArgs(argv, { flags: ['--json', '--help', '--version', '--config-keys', '--schema', '--force'], short: { h: '--help', V: '--version', f: '--force' } });
  if (args.flags.version) return { body: { version: VERSION, schemaVersion: SCHEMA_VERSION }, text: VERSION };
  const help = await helpResult(args, buildHelpDoc);
  if (help) return help;
  if (args.flags['config-keys']) {
    const { Config, schema } = await loadEngine();
    const defaults = schema.flattenManifestConfig(new Config().options);
    return { body: { configKeys: defaults }, text: Object.entries(defaults).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') };
  }
  if (args.positionals.length < 3) throw new CliError('usage_missing_arguments', 'Needs <manifest.json> <docs-dir> <output.pdf>. Run with --help.', { exit: EXIT.USAGE });
  if (args.positionals.length > 3) throw new CliError('usage_too_many_arguments', 'Takes exactly three arguments: <manifest.json> <docs-dir> <output.pdf>.', { exit: EXIT.USAGE });
  const [manifestArg, docsDirArg, outputArg] = args.positionals;

  // ── Read the manifest: everything here is input, so every failure is exit 3 ──
  let manifestText;
  try {
    if ((await stat(resolve(manifestArg))).size > MAX_MANIFEST_BYTES) throw new CliError('manifest_too_large', `The manifest is larger than ${MAX_MANIFEST_BYTES / 1024 / 1024} MB.`);
    manifestText = await readFile(resolve(manifestArg), 'utf8');
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('manifest_not_found', `The manifest ${manifestArg} could not be read (${err.code ?? 'error'}).`);
  }
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { throw new CliError('invalid_json', 'The manifest is not valid JSON.'); }

  const { Config, IndexData, pages, toc, meta, build: buildMod, schema, cover, sniff, photo, limits } = await loadEngine();
  try { schema.validateManifestShape(manifest); } catch (err) { throw new CliError('invalid_manifest', err.message); }
  const unknown = schema.unknownKeyProblems(manifest);
  if (unknown.length) throw new CliError('unknown_key', `The manifest has keys this version does not know: ${unknown.slice(0, 5).join('; ')}${unknown.length > 5 ? `; and ${unknown.length - 5} more` : ''}.`, { details: { problems: unknown.slice(0, 20) } });
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new CliError('unsupported_schema_version', `The manifest's schemaVersion is ${JSON.stringify(manifest.schemaVersion)}; this version reads schemaVersion ${SCHEMA_VERSION}.`);
  }
  if (manifest.coversheet !== undefined && manifest.coversheet !== null && typeof manifest.coversheet !== 'string') {
    throw new CliError('invalid_manifest', 'The manifest\'s coversheet must be a file name.');
  }

  // ── Documents directory and output location ──
  let docsDir; let docsReal;
  try {
    docsDir = resolve(docsDirArg);
    docsReal = await realpath(docsDir);
    if (!(await stat(docsReal)).isDirectory()) throw new Error('not a directory');
  } catch { throw new CliError('docs_dir_not_found', `The documents directory ${docsDirArg} does not exist.`); }
  const outputPath = resolve(outputArg);
  try {
    if (!(await stat(dirname(outputPath))).isDirectory()) throw new Error('not a directory');
  } catch { throw new CliError('output_dir_missing', `The folder for ${outputArg} does not exist.`); }

  // ── Config ──
  const config = new Config();
  const known = new Set(Object.keys(schema.flattenManifestConfig(config.options)));
  const strays = Object.keys(manifest.config ?? {}).filter((k) => !k.startsWith('_') && !known.has(k));
  if (strays.length) {
    const nearest = (stray) => {
      const last = stray.split('.').pop().toLowerCase();
      return [...known].filter((k) => { const l = k.split('.').pop().toLowerCase(); return l.includes(last) || last.includes(l); }).slice(0, 3);
    };
    const shown = strays.slice(0, 8).map((k) => { const n = nearest(k); return n.length ? `${k} (did you mean ${n.join(' or ')}?)` : k; });
    ctx.warn('unknown_config_key', `Ignored ${strays.length} config key${strays.length === 1 ? '' : 's'} this version does not know: ${shown.join(', ')}${strays.length > 8 ? ', ...' : ''}. Run with --config-keys for the full list.`);
  }
  try { config.updateOptions(schema.nestManifestConfig(manifest.config)); } catch (err) { throw new CliError('invalid_config', err.message); }

  // ── Documents: each must be a plain name inside the directory and a real PDF ──
  const resolvedSections = [];
  const fileBytesByFilename = new Map();
  const sourcePaths = new Set();
  let totalBytes = 0;
  const ocrMode = config.getOption('ocr.mode');
  // Off unless the manifest switches them on: a sideways scanned page turned upright, a tilted one straightened.
  const reorient = { turnUpright: config.getOption('ocr.turnUpright') === true, straighten: config.getOption('ocr.straighten') === true };
  // On unless the manifest switches it off: a JPEG or PNG made into a page goes into the bundle at most 2000 pixels
  // on its long edge (cliSmallerPhotos.mjs). The codec is loaded with the first picture; null once it cannot load.
  const smallerPhotos = config.getOption('pageOptions.smallerPhotos') !== false;
  let photoCodec;
  // Set once the FIRST file that needs OCR learns the runtime cannot load, so a second or third
  // scanned file in the same batch does not repeat the (real, dynamic-import) probe that already
  // failed once. Each such file still gets its OWN ocr_unavailable warning below, naming it: a
  // cached failure is passed straight back in through ocrDocument()'s own test-injection point,
  // rather than skipping the call (and the warning) for every file after the first.
  let cachedUnavailable = null;
  // Checked for every file before any of them is read or OCR'd: a bad forceOcr on file 5 of 6
  // must not cost files 1 to 4 real work (reading, sniffing, rotating, OCR itself) only to fail
  // the whole build anyway. The rotate type check is inline in the loop below.
  for (const section of manifest.sections ?? []) {
    for (const entry of section.files ?? []) {
      if (entry.forceOcr !== undefined && typeof entry.forceOcr !== 'boolean') {
        throw new CliError('invalid_manifest', `${entry.filename}: forceOcr must be true or false, not ${JSON.stringify(entry.forceOcr)}.`, { details: { file: entry.filename } });
      }
    }
  }
  for (const [sectionIndex, section] of (manifest.sections ?? []).entries()) {
    const files = [];
    for (const entry of section.files ?? []) {
      if (entry.rotate !== undefined && ![90, 180, 270].includes(entry.rotate)) {
        throw new CliError('invalid_rotation', `${entry.filename}: rotate must be 90, 180 or 270 (a clockwise turn in degrees), not ${JSON.stringify(entry.rotate)}.`, { details: { file: entry.filename } });
      }
      // forceOcr's own type is already checked for every file, above, before this loop starts.
      const read = await readInside(docsDir, docsReal, entry.filename, 'The document');
      const { real } = read;
      let bytes = read.bytes;
      sourcePaths.add(real);
      if (bytes.length > limits.MAX_FILE_MB * 1024 * 1024) {
        throw new CliError('file_too_large', `${entry.filename} is larger than ${limits.MAX_FILE_MB} MB, the most BundleTool takes for one file.`, { details: { file: entry.filename } });
      }
      totalBytes += bytes.length;
      if (totalBytes > limits.MAX_TOTAL_MB * 1024 * 1024) {
        throw new CliError('bundle_too_large', `The documents together are larger than ${limits.MAX_TOTAL_MB} MB, the most BundleTool takes for one bundle.`);
      }
      // What the file is comes from its own bytes, never its name. A PDF is used as it is; a JPEG or PNG
      // becomes a one-page PDF (the browser's rule, without a canvas); everything else the browser can
      // read needs a canvas or a page, so it is refused with what to do about it.
      const kind = await sniff.classifyBytes(bytes);
      const named = kindName(kind);
      if (named) {
        throw new CliError('unsupported_input_type', `${entry.filename} is ${named}. The command line takes PDF, JPEG and PNG files: convert it to a PDF first (the browser tool opens it directly).`, { details: { file: entry.filename, type: named } });
      }
      const isPicture = kind.kind === 'jpeg' || kind.kind === 'png';
      if (isPicture) {
        try { bytes = await photo.photoToPdf(bytes, config.getOption('pageOptions.pageSize')); } catch (err) {
          if (err instanceof photo.PhotoError) throw new CliError(err.code === 'toolarge' ? 'image_too_large' : 'invalid_image', `${entry.filename}: ${err.message}`, { details: { file: entry.filename } });
          throw err;
        }
      }
      const check = await pages.validateAndCountPages(bytes);
      if (check.error) {
        throw new CliError(check.errorKind === 'encrypted' ? 'encrypted_pdf' : 'invalid_pdf', `${entry.filename}: ${check.error}`, { details: { file: entry.filename } });
      }
      if (entry.rotate) bytes = await pages.rotatePdfBytes(bytes, entry.rotate);

      // OCR: "auto" (the default) OCRs only pages short of bundletoolOcr.js's own text-layer
      // threshold; "off" skips the check entirely UNLESS this file's own forceOcr overrides it, the
      // same relationship the browser's autoDetect setting and its per-document Force OCR button
      // have. Never fatal (ocr_failed/ocr_unavailable are warnings): a build that cannot OCR a page
      // still ships that page, just without a searchable text layer, matching the browser's own
      // never-block-the-build philosophy for this feature.
      const forceOcr = entry.forceOcr === true;
      if (ocrMode !== 'off' || forceOcr) {
        const { ocrDocument, releaseBytes } = await import('./cliOcrDocument.mjs');
        // Progress, page by page, for a person watching a long scan being read (silent under --json).
        const onPage = (done, total) => ctx.log(`${entry.filename}: reading text, page ${done} of ${total}`);
        const result = await ocrDocument(bytes, { force: forceOcr, reorient, onPage, ...(cachedUnavailable ? { _loadOcrRuntime: async () => cachedUnavailable } : {}) });
        if (!result.ok && result.reason === 'unavailable') {
          if (!cachedUnavailable) cachedUnavailable = { available: false, reason: result.detail };
          ctx.warn('ocr_unavailable', `${entry.filename}: OCR was needed but the OCR engine cannot load on this machine (${result.detail}). The bundle will build without a searchable text layer for any scanned page.`, { file: entry.filename });
        } else if (!result.ok && result.reason === 'failed') {
          // A document-level failure, not tied to any one page (opening the document with pdf.js,
          // loading the model, opening it for pdf-lib), so the whole file is named, not a page.
          ctx.warn('ocr_failed', `${entry.filename}: OCR failed (${result.detail}). That document has no searchable text layer; the rest of the build continues.`, { file: entry.filename });
        } else {
          // ok: true. One failed page never stops OCR on the others in the same file
          // (cliOcrDocument.mjs attempts every target page independently), so each failure in
          // result.failures gets its own warning naming just that page, without implying that the
          // pages after it were skipped.
          // The OCR'd bytes replace the file's; nothing reads the old ones again, so they are freed now rather
          // than left for the garbage collector while the bundle build parses the new ones (cliOcrDocument.mjs,
          // "THE CALLER'S COPY").
          if (result.bytes) {
            const replaced = bytes;
            bytes = result.bytes;
            releaseBytes(replaced, bytes);
          }
          for (const failure of result.failures) {
            ctx.warn('ocr_failed', `${entry.filename}, page ${failure.page}: OCR failed (${failure.detail}). That page has no searchable text layer; the rest of the build continues.`, { file: entry.filename, page: failure.page });
          }
          const { turned = [], straightened = [] } = result.reoriented ?? {};
          if (turned.length || straightened.length) {
            ctx.log(`${entry.filename}: ${[turned.length ? `${turned.length} page(s) turned upright` : '', straightened.length ? `${straightened.length} page(s) straightened` : ''].filter(Boolean).join(', ')}`);
          }
          for (const page of result.reoriented?.notStraightened ?? []) {
            ctx.warn('ocr_not_straightened', `${entry.filename}, page ${page}: left tilted as scanned, because it has links, form fields or comments that would no longer line up with the page. Its text layer is added as usual.`, { file: entry.filename, page });
          }
        }
      }
      // After OCR, which reads the full picture: the text layer is page content and stays over the same words.
      if (isPicture && smallerPhotos) {
        // Imported here, after loadEngine() has put the Node shim in place: it reads the browser's own module.
        const { loadNodeCodec, smallerPhotoPdf } = await import('./cliSmallerPhotos.mjs');
        if (photoCodec === undefined) photoCodec = await loadNodeCodec();
        if (!photoCodec) {
          ctx.warn('photo_not_smaller', `${entry.filename}: pageOptions.smallerPhotos is on, but @napi-rs/canvas cannot load on this machine, so the picture goes into the bundle at its own size.`, { file: entry.filename });
        } else {
          const smaller = await smallerPhotoPdf(bytes, photoCodec);
          if (smaller.bytes !== bytes) {
            ctx.log(`${entry.filename}: picture made smaller for the bundle, ${(smaller.before / 1048576).toFixed(1)} MB to ${(smaller.after / 1048576).toFixed(1)} MB`);
            bytes = smaller.bytes;
          }
        }
      }
      // The manifest's own pageCount is never trusted: the count is always the
      // one read back from the file just validated.
      // A missing, null or blank title is not left empty: the engine requires a non-empty one
      // (bundletoolIndexData.js), and the browser never sends a blank one (a title field left
      // empty on focusout is filled in from the filename by frontend/fileRows.js) before the title
      // ever reaches generation. The CLI does the same, with the same two functions, so a manifest
      // that leaves "title" out (documented as optional in manifest.schema.json) behaves like the
      // browser rather than failing with "title must be a non-empty string".
      const rawTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
      const title = rawTitle || stripDoubleChars(prettifyTitle(entry.filename));
      files.push({ filename: entry.filename, title, date: entry.date ?? null, pageCount: check.pageCount });
      fileBytesByFilename.set(entry.filename, bytes);
    }
    resolvedSections.push({
      // Optional in a manifest: left out, a section is numbered by its position ("0000", "0001", ...).
      sectionID: section.sectionID ?? String(sectionIndex).padStart(4, '0'),
      sectionLabel: section.sectionLabel ?? '',
      sectionName: section.sectionName ?? '',
      files,
    });
  }
  if (sourcePaths.has(outputPath)) throw new CliError('output_overwrites_input', 'The output path is one of the source documents; choose another name.');
  if (!args.flags.force && existsSync(outputPath)) throw new CliError('output_exists', `${outputArg} already exists. Choose another name or pass --force to overwrite it.`);

  let indexData;
  try {
    indexData = new IndexData(resolvedSections);
    indexData.validateIndexStructure();
  } catch (err) { throw new CliError('invalid_manifest', err.message); }
  try {
    config.validateStructure();
    config.validateOptions();
  } catch (err) { throw new CliError('invalid_config', err.message); }

  ctx.log(`${indexData.totalFileCount} file(s), ${indexData.totalSectionCount} section(s), ${indexData.totalPageCount} source page(s)`);

  // Where the cover comes from is decided exactly as in the browser (resolveCoverSource): a
  // supplied cover page wins, otherwise the cover maker's page is drawn from the manifest's
  // cover.* fields when pageOptions.generateCover is true, otherwise there is no cover. A supplied
  // cover is the manifest's top-level "coversheet": a PDF file name inside the documents directory
  // (only its first page is used).
  let uploadedCover = null;
  if (manifest.coversheet) {
    const { bytes } = await readInside(docsDir, docsReal, manifest.coversheet, 'The coversheet');
    uploadedCover = new Blob([bytes]);
  }
  const coverSource = cover.resolveCoverSource({
    hasUploadedCover: uploadedCover !== null,
    generateCover: config.getOption('pageOptions.generateCover'),
  });
  config.updateOptions({ pageOptions: { coversheet: coverSource !== 'none', coverSource } });
  try { config.validateOptions(); } catch (err) { throw new CliError('invalid_config', err.message); }
  const indexPageIndex = coverSource !== 'none' ? 1 : 0;
  const footerLinkSetting = config.getOption('pageNumbering.footerLink') || 'index';
  const footerLinkPageIndex = footerLinkSetting === 'none' ? null : footerLinkSetting === 'top' ? 0 : indexPageIndex;

  let coverPdf = null;
  try {
    if (coverSource === 'uploaded') coverPdf = await pages.validateCoverPage(uploadedCover);
    else if (coverSource === 'generated') coverPdf = await cover.makeCoverPdf(cover.flattenCoverConfig(config));
  } catch (err) {
    throw new CliError('invalid_cover', `The cover page could not be made: ${err.message}`);
  }

  // ── Build: anything that fails from here is the engine's, not the caller's ──
  let bundleBytes; let expectedTocLength;
  try {
    const tocOptions = {
      font: { family: 'helvetica', sizeTitle: 18, sizeProject: 14, sizeTable: 11 },
      color: { headerFill: [200, 200, 200] },
      table: { showBorders: true, cellPadding: 2, lineHeight: 1.3 },
      margins: { top: 25, right: 22, bottom: 25, left: 22 },
    };
    const tocEntries = await toc.createTocEntries(indexData, config);
    expectedTocLength = await toc.makeDummyTocPages(tocEntries, tocOptions, config);
    const [tocPdf, tocTableRowCoordinates] = await toc.makeTocPages(tocEntries, tocOptions, config, expectedTocLength);

    const fileEntries = [];
    for (const section of tocEntries) {
      for (const entry of section.entries) {
        const buffer = fileBytesByFilename.get(entry.filename);
        if (!buffer) throw new Error(`internal: no bytes resolved for ${entry.filename}`);
        fileEntries.push({ filename: entry.filename, buffer });
      }
    }

    bundleBytes = await buildMod.buildBundlePdf({
      coverBytes: coverPdf,
      tocBytes: tocPdf,
      fileEntries,
      printable: config.getOption('pageOptions.printableBundle'),
      pageSize: config.getOption('pageOptions.pageSize'),
      footerConfig: pages.flattenFooterConfig(config),
      pageLabels: pages.buildPageLabels(tocEntries, config.getOption('pageNumbering.pageNumberPerSection')),
      frontMatterCount: (coverSource !== 'none' ? 1 : 0) + expectedTocLength,
      footerLinkPageIndex,
      metaConfig: meta.flattenConfig(config),
      tocTableRowCoordinates,
      tocEntries,
    }, (label) => ctx.log(label));
  } catch (err) {
    throw new CliError('build_failed', `The bundle could not be built: ${err.message}`, { exit: EXIT.BUILD });
  }

  try { await writeFile(outputPath, bundleBytes); } catch (err) {
    throw new CliError('output_write_failed', `${outputArg} could not be written (${err.code ?? 'error'}).`, { exit: EXIT.BUILD });
  }
  ctx.log(`wrote ${outputArg} (${bundleBytes.length} bytes)`);

  const totalPages = (coverSource !== 'none' ? 1 : 0) + expectedTocLength + indexData.totalPageCount;
  // A court rule, not a build problem: never refuses the bundle, only says so, the same as the page's
  // own Review Table note (frontend/limits.js, frontend/bundleTotals.js) so the two never drift apart.
  if (isOverPd27aLimit(totalPages)) ctx.warn('over_pd27a_page_limit', pd27aNote(totalPages));

  return {
    body: {
      schemaVersion: SCHEMA_VERSION,
      output: outputPath,
      bytes: bundleBytes.length,
      files: indexData.totalFileCount,
      sections: indexData.totalSectionCount,
      coverSource,
      pages: {
        total: totalPages,
        cover: coverSource !== 'none' ? 1 : 0,
        index: expectedTocLength,
        source: indexData.totalPageCount,
      },
    },
  };
}

const argv = process.argv.slice(2);
await runCli({ tool: TOOL, version: VERSION, json: argv.includes('--json'), main: (ctx) => build(ctx, argv) });
