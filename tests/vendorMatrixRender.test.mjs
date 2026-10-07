/** The share-by-QR script is qrcode-generator's own dist file, copied by scripts/build-vendor.mjs from the pinned package. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { qrBanner } from '../scripts/vendor-banner.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const staticDir = fs.existsSync(here('../static/vendor')) ? '../static/vendor/' : '../../static/vendor/';

test('static/vendor/matrix-render.js is the pinned qrcode-generator dist file under its banner', () => {
  const pkg = JSON.parse(fs.readFileSync(here('../node_modules/qrcode-generator/package.json'), 'utf8'));
  const pinned = JSON.parse(fs.readFileSync(here('../package.json'), 'utf8')).devDependencies['qrcode-generator'];
  assert.equal(pkg.version, pinned, 'the installed version is the pinned one');
  const dist = fs.readFileSync(here('../node_modules/qrcode-generator/dist/qrcode.js'), 'utf8');
  assert.equal(fs.readFileSync(here(`${staticDir}matrix-render.js`), 'utf8'), qrBanner(pinned) + dist + '\n');
});
