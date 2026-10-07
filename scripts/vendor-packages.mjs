/**
 * What scripts/build-vendor.mjs puts in the two vendor folders, and how each file gets there. One list, read by
 * build-vendor.mjs to build the files and by the standalone exports to ship and check the licence text of every
 * package inside them: a vendored file that no entry here names fails the export, so a library cannot ship
 * without its licence.
 *
 *   BUNDLED    built by esbuild from an npm package, with every package it imports inside the one file
 *   COPIED     an npm package's own dist files, copied as they are; `contains` names what those files hold
 *              besides the package itself (a library the package inlined, code compiled into a .wasm file)
 *   COMMITTED  files kept in the repository as they are; build-vendor.mjs does not rebuild them
 *
 * `dir` is 'own' (public/js/vendor/, BundleTool only) or 'shared' (the site's static/vendor/, served at /vendor/).
 */
export const BUNDLED = [
  { pkg: '@cantoo/pdf-lib', file: 'cantoo-pdf-lib.js', dir: 'shared' },
  { pkg: '@pdf-lib/fontkit', file: 'pdf-lib-fontkit.js', dir: 'shared' },
  { pkg: 'jspdf', file: 'jspdf.js', dir: 'own' },
  { pkg: 'jspdf-autotable', file: 'jspdf-autotable.js', dir: 'own' },
  { pkg: 'chrono-node', file: 'chrono-node.js', dir: 'shared' },
  { pkg: 'mammoth', file: 'mammoth.js', dir: 'own' },
  { pkg: 'utif2', file: 'utif2.js', dir: 'own' },
];

export const COPIED = [
  // A plain UMD script loaded with a <script> tag (share by QR code): copied under a banner, not bundled.
  { pkg: 'qrcode-generator', dir: 'shared', files: [{ from: 'dist/qrcode.js', to: 'matrix-render.js' }], contains: [] },
  // OCR. lib.js finds its worker and the worker finds its .wasm files next to itself, so the files are copied
  // into one folder as they are. lib.js and the worker carry comlink inside them, and the .wasm files are
  // Tesseract and Leptonica compiled to WebAssembly.
  {
    pkg: 'tesseract-wasm',
    dir: 'shared',
    files: [
      { from: 'dist/lib.js', to: 'tesseract-wasm/lib.js' },
      { from: 'dist/tesseract-worker.js', to: 'tesseract-wasm/tesseract-worker.js' },
      { from: 'dist/tesseract-core.wasm', to: 'tesseract-wasm/tesseract-core.wasm' },
      { from: 'dist/tesseract-core-fallback.wasm', to: 'tesseract-wasm/tesseract-core-fallback.wasm' },
    ],
    contains: ['comlink', 'tesseract-ocr', 'leptonica'],
  },
];

/**
 * The esbuild options a BUNDLED entry is built with. build-vendor.mjs writes the file with them, and
 * tests/vendorReproducible.test.mjs rebuilds with the same ones and compares, so the committed file is always what
 * the pinned packages build (and NOTICE's list of what is inside it, read from the same build, is true of it).
 */
export function bundleOptions({ pkg, version, toolDir, outfile }) {
  return {
    entryPoints: [pkg],
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'browser',
    outfile,
    absWorkingDir: toolDir,
    banner: { js: `/* ${pkg}@${version} - bundled by scripts/build-vendor.mjs; licence in NOTICE */` },
    logLevel: 'warning',
  };
}

export const COMMITTED = [
  // pdf.js 4.0.379, the prebuilt library and its worker.
  { component: 'pdfjs-dist', dir: 'shared', files: ['pdfjs.mjs', 'pdfjs.worker.mjs'] },
];
