/**
 * Every vendored bundle is exactly what the pinned packages build: each BUNDLED entry of scripts/vendor-packages.mjs
 * is rebuilt in memory with build-vendor.mjs's own esbuild options and compared with the committed file, byte for
 * byte. A bundle left over from older dependencies fails here, and with it any list of what the bundle holds that
 * is read from a fresh build (NOTICE's), which would otherwise describe bytes nobody ships. Fix: npm run build:vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUNDLED, bundleOptions } from '../scripts/vendor-packages.mjs';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The site's shared static/ folder: beside the tool, or one level up when the tool is built as part of the full site.
const staticDir = fs.existsSync(path.join(toolDir, 'static', 'vendor')) ? path.join(toolDir, 'static') : path.join(toolDir, '..', 'static');
const DIRS = { own: path.join(toolDir, 'public', 'js', 'vendor'), shared: path.join(staticDir, 'vendor') };
const esbuildMain = path.join(toolDir, 'node_modules', 'esbuild', 'lib', 'main.js');

for (const { pkg, file, dir } of BUNDLED) {
  test(`${file} is what ${pkg} at its pinned version builds`, { skip: !fs.existsSync(esbuildMain) && 'npm ci first' }, async () => {
    const { build } = await import(pathToFileURL(esbuildMain).href);
    const version = JSON.parse(fs.readFileSync(path.join(toolDir, 'node_modules', pkg, 'package.json'), 'utf8')).version;
    const outfile = path.join(DIRS[dir], file);
    const r = await build({ ...bundleOptions({ pkg, version, toolDir, outfile }), write: false, logLevel: 'silent' });
    const built = Buffer.from(r.outputFiles[0].contents);
    const committed = fs.readFileSync(outfile);
    assert.ok(built.equals(committed), `${path.relative(toolDir, outfile)} differs from a fresh build of ${pkg}@${version}: run npm run build:vendor and commit the result`);
  });
}
