/**
 * No script this tool serves is named like an analytics or advertising file. Content blockers (Firefox's tracking
 * protection, Brave's shields, uBlock-style lists) match on the file name alone, and a blocked script is not an
 * error anyone can see: the request just fails, and the feature that needed it says the page must be reloaded. A
 * file called pageView.js did exactly that on a phone while loading perfectly everywhere without a blocker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  path.join(here, '..', 'public', 'js'),
  path.join(here, '..', '..', 'static', 'js'),
];
const BLOCKABLE = /page[-_]?view|analytics|tracking|tracker|beacon|telemetry|ad[-_]?serv|advert|sponsor|pixel|metrics|banner|hotjar|segment|gtag|fbevents/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  ));
}

test('no served script has a name a content blocker is likely to match', () => {
  const files = ROOTS.flatMap(walk).filter((f) => /\.(m?js|css|wasm)$/.test(f));
  assert.ok(files.length > 20, 'the scan found the tool\'s scripts');
  const bad = files.filter((f) => BLOCKABLE.test(path.basename(f))).map((f) => path.relative(path.join(here, '..', '..'), f));
  assert.deepEqual(bad, [], 'rename these: a blocker can silently refuse them');
});
