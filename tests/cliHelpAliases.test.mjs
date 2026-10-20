/** Every way a person or a program might ask a CLI for help reaches the help, and a mistyped option is corrected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = { bundletool: join(root, 'scripts', 'build-cli.mjs') };
const run = (file, args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });

for (const [name, file] of Object.entries(TOOLS)) {
  test(`${name}: --help, -h, -help, -?, /? and the word help all print the same help`, () => {
    const base = run(file, ['--help']);
    assert.equal(base.status, 0);
    assert.match(base.stdout, new RegExp(`^${name} `));
    for (const alias of [['-h'], ['-help'], ['-?'], ['/?'], ['--usage'], ['help']]) {
      const r = run(file, alias);
      assert.equal(r.status, 0, alias.join(' '));
      assert.equal(r.stdout, base.stdout, alias.join(' '));
    }
  });

  test(`${name}: a mistyped option names the nearest real one, and stays a usage error`, () => {
    for (const [typo, want] of [['--hewlp', '--help'], ['--jsn', '--json'], ['--versoin', '--version']]) {
      const r = run(file, [typo]);
      assert.equal(r.status, 2, typo);
      assert.match(r.stderr, new RegExp(`Did you mean ${want}\\?`), typo);
    }
  });
}
