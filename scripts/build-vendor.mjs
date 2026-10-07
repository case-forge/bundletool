/**
 * Rebuilds the self-hosted dependency bundles (public/js/vendor/ and the site's shared static/vendor/).
 *
 * Every library is served from this origin, never loaded from a CDN at run
 * time: a CDN would make the app depend on that host and on a network
 * connection, and every page load would disclose request metadata to a third
 * party. Vendoring bundles each package (with its own dependencies) into one
 * ESM file. All are permissive (MIT, BSD-2-Clause or Apache-2.0: mammoth is
 * BSD-2-Clause, pdfjs-dist and comlink are Apache-2.0, pako is MIT AND Zlib,
 * tesseract-wasm is BSD-2-Clause, the rest MIT); NOTICE records them as
 * redistributed.
 *
 * Run after changing a pinned version in package.json:
 *   node scripts/build-vendor.mjs
 * then commit the regenerated files. The versions are pinned exactly in
 * devDependencies; the banner in each output names what it was built from.
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrBanner } from './vendor-banner.mjs';
import { BUNDLED, COPIED, bundleOptions } from './vendor-packages.mjs';

// The tool's own folder (the one holding package.json and node_modules). The site's shared static/ folder is
// beside the tool's own files, or one level up when the tool is built as part of the full site.
const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = existsSync(resolve(TOOL_DIR, 'static', 'vendor')) ? resolve(TOOL_DIR, 'static') : resolve(TOOL_DIR, '..', 'static');

// Read straight from node_modules: several packages' exports maps do not
// expose their package.json to require().
const versionOf = (pkg) =>
  JSON.parse(readFileSync(resolve(TOOL_DIR, 'node_modules', pkg, 'package.json'), 'utf8')).version;

// What is built or copied, and where it lands, is listed in scripts/vendor-packages.mjs: BundleTool's own
// libraries stay under public/js/vendor/ ('own'), the ones other pages also import go to the site's shared
// static/vendor/ ('shared', served at /vendor/).
const DIRS = { own: resolve(TOOL_DIR, 'public/js/vendor'), shared: resolve(STATIC_DIR, 'vendor') };

for (const { pkg, file, dir } of BUNDLED) {
  const version = versionOf(pkg);
  await build(bundleOptions({ pkg, version, toolDir: TOOL_DIR, outfile: resolve(DIRS[dir], file) }));
  console.log(`${file} <- ${pkg}@${version}`);
}

// Copied, not bundled. qrcode-generator is a plain UMD script loaded with a <script> tag, so its dist file is
// copied under a banner. tesseract-wasm (OCR) ships already-built files, including two WASM binaries (SIMD and a
// non-SIMD fallback the library picks between) and a worker that finds its WASM next to itself
// (`new URL('./tesseract-worker.js', import.meta.url)` inside lib.js): re-bundling would break that, so the files
// are copied as they are into one folder. Both are served from this origin, so both are redistributed and
// recorded in NOTICE. eng.traineddata (public/ocr/) is not from npm: it is tesseract-ocr/tessdata_fast's "fast"
// English data, fetched once and committed, since it is not a versioned package.
for (const { pkg, dir, files } of COPIED) {
  const version = versionOf(pkg);
  for (const { from, to } of files) {
    const dest = resolve(DIRS[dir], to);
    mkdirSync(dirname(dest), { recursive: true });
    if (pkg === 'qrcode-generator') {
      writeFileSync(dest, qrBanner(version) + readFileSync(resolve(TOOL_DIR, 'node_modules', pkg, from), 'utf8') + '\n');
    } else {
      copyFileSync(resolve(TOOL_DIR, 'node_modules', pkg, from), dest);
    }
    console.log(`${to} <- ${pkg}@${version}`);
  }
}
