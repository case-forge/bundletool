/**
 * BundleTool Node compatibility shim.
 *
 * Two things the browser gives every module here for free that plain Node
 * does not: resolving a root-absolute `/vendor/...` or `/js/shared/...` import
 * against the site, and resolving an absolute `/fonts/...`-style fetch() URL
 * against a page origin. Load this
 * with `node --import ./scripts/node-compat.mjs <entry point>` for ANY Node
 * consumer of public/js/*.js: the test suite (`tests/register-hooks.mjs`
 * re-exports this file so its own `--import` path keeps working) and
 * scripts/build-cli.mjs both need it, and neither should carry its own copy.
 * See scripts/node-compat-resolve.mjs for the module-resolution half.
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

register('./node-compat-resolve.mjs', pathToFileURL(path.dirname(fileURLToPath(import.meta.url)) + path.sep));

/**
 * Serves public/ over fetch(), for the absolute URLs the app uses.
 *
 * The footer font is fetched from '/fonts/...', so without this the
 * page-numbering path cannot run outside a browser at all. Serving the real
 * font lets the tests exercise the font the product actually draws with,
 * including its metrics, which the footer's centring depends on, rather than a
 * standard-14 stand-in. Anything not beginning with '/' falls through to the
 * real fetch.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(repoRoot, 'public');
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.startsWith('/')) return realFetch(input, init);

  const file = path.resolve(path.join(publicRoot, url));
  if (!file.startsWith(publicRoot + path.sep)) {
    throw new Error(`test fetch shim: refusing to serve outside public/: ${url}`);
  }
  if (!fs.existsSync(file)) {
    return { ok: false, status: 404, arrayBuffer: async () => { throw new Error(`404 ${url}`); } };
  }
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};
