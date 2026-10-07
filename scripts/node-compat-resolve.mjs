/**
 * BundleTool Node module-resolver hook.
 *
 * Modules shared by every page live in the site's static/vendor/ and the browser
 * sources import them as root-absolute '/vendor/x.js'. Node has no site root, so
 * this hook maps those specifiers onto the files (and '/js/shared/x.js', the
 * site's shared scripts such as the EXIF orientation module, onto
 * static/js/shared/). Nothing is copied and nothing is rewritten:
 * any Node consumer (tests, scripts/build-cli.mjs) imports public/js/*.js
 * directly, byte for byte as it ships, and so gets exactly one instance of the
 * PDF library.
 * Two instances of one library make every `instanceof` across the boundary
 * false, which shows up as an outline that reads back empty and destination
 * arrays that serialise as dictionaries.
 *
 * Loaded via scripts/node-compat.mjs: do not `--import` this file directly.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The site's static/ folder is the nearest one above this file that holds vendor/: one level up from
// scripts/ when it sits beside the tool, or two levels up when the tool is built as part of the full site.
const STATIC = (() => {
  for (let dir = new URL('./', import.meta.url); ; ) {
    const candidate = new URL('static/', new URL('../', dir));
    if (existsSync(fileURLToPath(new URL('vendor/', candidate)))) return candidate;
    const up = new URL('../', dir);
    if (up.href === dir.href) throw new Error('node-compat-resolve: no static/vendor/ above ' + import.meta.url);
    dir = up;
  }
})();
const SHARED_VENDOR = new URL('vendor/', STATIC);
const SHARED_JS = new URL('js/shared/', STATIC);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/vendor/')) {
    return nextResolve(new URL(specifier.slice('/vendor/'.length), SHARED_VENDOR).href, context);
  }
  if (specifier.startsWith('/js/shared/')) {
    return nextResolve(new URL(specifier.slice('/js/shared/'.length), SHARED_JS).href, context);
  }
  return nextResolve(specifier, context);
}
