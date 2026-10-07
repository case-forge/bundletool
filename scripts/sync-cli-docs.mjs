#!/usr/bin/env node
/**
 * Keeps the generated tables in the README equal to what `node scripts/build-cli.mjs --help` prints.
 *
 *   node scripts/sync-cli-docs.mjs          rewrite the sections between the markers
 *   node scripts/sync-cli-docs.mjs --check  exit 1 when the README is out of date
 *
 * The README opts in with `<!-- cli-docs:NAME -->` ... `<!-- /cli-docs:NAME -->` marker pairs (exit-codes, errors,
 * warnings, settings). tests/cliHelp.test.mjs runs the same check on every push.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readVersion, readmeSections, markdownTable, fillReadme } from './cli-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function bundletoolDoc() {
  await import('./node-compat.mjs');
  const limits = await import('../public/js/frontend/limits.js');
  const { buildDoc } = await import('./cli-docs.mjs');
  const doc = await buildDoc({ version: readVersion(new URL('../package.json', import.meta.url)), limits });
  return { doc, extra: {
    settings: markdownTable(['Setting', 'Allowed values', 'Default', 'Meaning'], doc.settingRows.map((r) => [`\`${r.name}\``, r.type, `\`${r.default}\``, r.meaning])),
  } };
}

/** { path: [current text, generated text] } for every README that opts in. */
export async function renderReadmes() {
  const { doc, extra } = await bundletoolDoc();
  const current = readFileSync(root + 'README.md', 'utf8');
  return { 'README.md': [current, fillReadme(current, readmeSections(doc, extra))] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, [current, next]] of Object.entries(await renderReadmes())) {
    if (current === next) continue;
    stale++;
    if (check) console.error(`${rel} is out of date: run node scripts/sync-cli-docs.mjs`);
    else { writeFileSync(root + rel, next); console.log(`updated ${rel}`); }
  }
  process.exitCode = check && stale ? 1 : 0;
}
