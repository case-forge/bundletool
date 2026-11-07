/**
 * `--unpack`: a finished BundleTool PDF back into its documents and a manifest that builds the same bundle again.
 *
 * The same restore the page uses (openBundle, splitBundlePdf in bundletoolRestore.js), written to a folder:
 * `<out-dir>/docs/<each document>` and `<out-dir>/manifest.json`. The manifest carries the stored settings and
 * sections, so `bundletool <out-dir>/manifest.json <out-dir>/docs out.pdf` rebuilds the bundle; edit the manifest or
 * the documents first to change it.
 *
 * Two things the restore does for a rebuild to match:
 *  - A bundle made in print mode carries a "This page is intentionally left blank" page after each odd-length
 *    document, and those pages sit at the end of the extracted documents. They are removed here (the setting is
 *    kept, so a rebuild adds them again; turn pageOptions.printableBundle off to leave them out).
 *  - A bundle with a generated cover has no cover file: its settings rebuild it. An uploaded cover is written as
 *    coversheet.pdf and named by the manifest.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError } from './cli-contract.mjs';

/** Page numbers (1-based) of the last page of a document, when it is the blank page print mode adds. */
async function trailingPaddingPage(bytes, pdfjsLib, paddingText) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages < 2 || doc.numPages % 2 !== 0) return 0;
    const page = await doc.getPage(doc.numPages);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
    return text.includes(paddingText) ? doc.numPages : 0;
  } finally {
    await task.destroy();
  }
}

export async function unpackBundle({ bundleBytes, outDir, force, engine, readBundle }) {
  const { schema, Config, pages } = engine;
  const opened = await readBundle(bundleBytes);
  if (!Array.isArray(opened.metadata) || opened.metadata.length === 0) {
    throw Object.assign(new Error('This PDF carries no BundleTool index, so there is nothing to unpack. Only a bundle made by BundleTool (version 1 onward) can be.'), { notABundle: true });
  }
  const out = resolve(outDir);
  let existing = [];
  try { existing = await readdir(out); } catch { /* it does not exist yet */ }
  if (existing.length && !force) throw new CliError('output_exists', `${outDir} is not empty. Choose another folder or pass --force to write into it.`);
  const docsDir = join(out, 'docs');
  await mkdir(docsDir, { recursive: true });

  const config = opened.config ?? {};
  const coverSource = engine.restore.coverSourceOf(config);
  const files = await engine.restore.splitBundlePdf(opened.doc, opened.metadata, coverSource === 'uploaded');

  const printable = config.pageOptions?.printableBundle === true;
  const droppedBlank = [];
  if (printable) {
    const pdfjsLib = await import('/vendor/pdfjs.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.mjs';
    for (const [name, bytes] of files) {
      if (name === 'coversheet.pdf') continue;
      const last = await trailingPaddingPage(bytes, pdfjsLib, pages.PADDING_PAGE_TEXT);
      if (last) {
        files.set(name, await pages.removePdfPages(bytes, [last - 1]));
        droppedBlank.push(name);
      }
    }
  }
  for (const [name, bytes] of files) await writeFile(join(docsDir, name), bytes);

  const known = new Set(Object.keys(schema.flattenManifestConfig(new Config().options)));
  const flat = Object.fromEntries(Object.entries(schema.flattenManifestConfig(config)).filter(([k]) => known.has(k)));
  if (coverSource === 'generated') flat['pageOptions.generateCover'] = true;
  const manifest = {
    schemaVersion: 1,
    config: flat,
    ...(coverSource === 'uploaded' ? { coversheet: 'coversheet.pdf' } : {}),
    sections: engine.restore.normaliseBundleMetadata(opened.metadata).map((s) => ({
      sectionID: s.sectionID,
      sectionLabel: s.sectionLabel ?? '',
      sectionName: s.sectionName ?? '',
      files: (s.files ?? []).filter((f) => f.filename && files.has(f.filename)).map((f) => ({ filename: f.filename, title: f.title ?? '', date: f.date ?? '' })),
    })),
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    out, documents: [...files.keys()].filter((n) => n !== 'coversheet.pdf').length, coverSource,
    version: opened.version, printable, blankPagesRemoved: droppedBlank.length,
  };
}
