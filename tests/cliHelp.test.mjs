/**
 * The command line tool documents itself (`--help`, `--help <topic>`, `--schema`, `--json --help`), and
 * this file is what stops that documentation drifting from the code: every setting, field, envelope preset, error
 * code, exit code and example the tools have must be in their help, every example must run, and the generated
 * README tables must equal what the tool prints. The help itself is generated from the tool's own tables
 * (scripts/cli-docs.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import { EXIT_MEANINGS, USAGE_ERRORS, INTERNAL_ERROR, renderHelp, helpBody, topicNames, wrap, formatRows } from '../scripts/cli-contract.mjs';
import { renderReadmes } from '../scripts/sync-cli-docs.mjs';
import * as btDocs from '../scripts/cli-docs.mjs';
import * as cfg from '../public/js/bundletoolConfig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TOOLS = {
  bundletool: { script: path.join(root, 'scripts', 'build-cli.mjs'), name: 'bundletool', docs: btDocs, sources: ['scripts/build-cli.mjs'], topics: ['manifest', 'settings', 'inputs'] },
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clihelp-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function run(tool, args, { cwd, input } = {}) {
  const r = spawnSync(process.execPath, [TOOLS[tool].script, ...args], { encoding: 'utf8', cwd, input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── The help itself ─────────────────────────────────────────────────────────────────────────────────────────

test('--help alone works in an empty folder, is plain stable text, and lists options, inputs, exit codes, examples and topics', () => {
  for (const [tool, t] of Object.entries(TOOLS)) {
    const d = tmp();
    try {
      const a = run(tool, ['--help'], { cwd: d });
      const b = run(tool, ['--help'], { cwd: d });
      assert.equal(a.status, 0, tool);
      assert.equal(a.stderr, '');
      assert.equal(a.stdout, b.stdout, `${tool}: the help is stable`);
      assert.doesNotMatch(a.stdout, /\u001b\[/, `${tool}: no colour codes`);
      assert.match(a.stdout, new RegExp(`^${t.name} \\d+\\.\\d+\\.\\d+: `), `${tool}: the first line names the tool and version`);
      for (const word of ['Usage:', 'Options:', 'Exit codes:', 'Examples:', 'More:']) assert.ok(a.stdout.includes(word), `${tool}: ${word}`);
      for (const code of Object.keys(EXIT_MEANINGS)) assert.match(a.stdout, new RegExp(`^  ${code}  `, 'm'), `${tool}: exit code ${code}`);
      for (const topic of [...t.topics, 'errors', 'examples', 'schema']) assert.ok(a.stdout.includes(topic), `${tool}: lists the topic ${topic}`);
      const doc = a.stdout.split('\n');
      assert.ok(doc.length < 70, `${tool}: the overview stays about a screen or two (${doc.length} lines)`);
      assert.ok(doc.every((l) => l.length <= 130), `${tool}: no very long lines`);
    } finally { rm(d); }
  }
});

test('every option the help lists is one the tool accepts, and -h works like --help', () => {
  for (const [tool, t] of Object.entries(TOOLS)) {
    const help = run(tool, ['--json', '--help']).json;
    for (const { flag } of help.options) {
      const name = flag.split(/[ [<]/)[0];
      if (!name.startsWith('--') || ['--help', '--version'].includes(name)) continue;
      const r = run(tool, ['--json', name]);
      assert.notEqual(r.json?.error?.code, 'usage_unknown_option', `${tool} ${name} is a known option`);
    }
    assert.equal(run(tool, ['-h']).stdout, run(tool, ['--help']).stdout);
  }
});

test('every topic prints, an unknown topic is a usage error, and --json --help is one JSON object with the same text', () => {
  for (const [tool, t] of Object.entries(TOOLS)) {
    for (const topic of [...t.topics, 'errors', 'examples', 'schema']) {
      const text = run(tool, ['--help', topic]);
      assert.equal(text.status, 0, `${tool} ${topic}`);
      assert.ok(text.stdout.length > 100, `${tool} ${topic} has content`);
      const j = run(tool, ['--json', '--help', topic]);
      assert.equal(j.status, 0);
      assert.equal(j.stderr, '');
      assert.equal(j.json.ok, true);
      assert.equal(j.json.topic, topic);
      assert.equal(j.json.help.trim(), text.stdout.trim(), `${tool} ${topic}: the JSON help carries the same text`);
    }
    const bad = run(tool, ['--json', '--help', 'nonsense']);
    assert.equal(bad.status, 2);
    assert.equal(bad.json.error.code, 'usage_unknown_topic');
    assert.equal(run(tool, ['--help', 'a', 'b']).status, 2);
    const overview = run(tool, ['--json', '--help']).json;
    assert.deepEqual(overview.exitCodes, JSON.parse(JSON.stringify(EXIT_MEANINGS)));
    assert.ok(Array.isArray(overview.topics) && overview.examples.length >= 2);
    assert.ok(overview.examples.every((e) => e.command.includes(`${t.name} `)));
  }
});

test('--schema prints the tool\'s JSON Schema, byte for byte the file, also as JSON', () => {
  const files = { bundletool: 'manifest.schema.json' };
  for (const [tool, rel] of Object.entries(files)) {
    const printed = run(tool, ['--schema']);
    assert.equal(printed.status, 0);
    assert.deepEqual(JSON.parse(printed.stdout), JSON.parse(read(rel)));
    assert.deepEqual(run(tool, ['--json', '--schema']).json.schema, JSON.parse(read(rel)));
  }
});

// ── Nothing is left out ─────────────────────────────────────────────────────────────────────────────────────

test('BundleTool: every setting has a description and appears in the help with its allowed values and default; nothing is described that does not exist', () => {
  const keys = Object.keys(run('bundletool', ['--json', '--config-keys']).json.configKeys);
  assert.ok(keys.length > 40);
  assert.deepEqual([...keys].sort(), Object.keys(btDocs.SETTING_HELP).sort(), 'every default setting is described, and no description is for a setting that does not exist');
  const help = run('bundletool', ['--help', 'settings']).stdout.replace(/\s+/g, ' ');
  for (const k of keys) assert.ok(help.includes(k), `--help settings lists ${k}`);
  const lists = { 'cover.layout': cfg.validCoverLayouts, 'cover.caseNumberLine': cfg.validCoverCaseLines, 'cover.partyLabelPlacement': cfg.validCoverLabelPlacements, 'pageOptions.pageSize': cfg.validPageSizes, 'index.dateStyle': cfg.validDateStyles, 'pageNumbering.numberingStyle': cfg.validNumberingStyles, 'pageNumbering.frontMatterNumbering': cfg.validFrontMatterNumbering };
  for (const [key, values] of Object.entries(lists)) {
    const line = run('bundletool', ['--json', '--help', 'settings']).json.rows.find((r) => r.name === key).text;
    for (const v of values) assert.ok(line.includes(v), `${key} lists ${v}`);
  }
});

test('every error and warning code the source can raise is documented, and everything documented is in the source', () => {
  for (const [tool, t] of Object.entries(TOOLS)) {
    const source = t.sources.map(read).join('\n');
    const documented = new Set([...USAGE_ERRORS.map((e) => e.code), INTERNAL_ERROR.code, ...t.docs.ERRORS.map((e) => e.code)]);
    const thrown = [...source.matchAll(/(?:CliError|RequestError|fail)\(\s*'([a-z][a-z_]+)'/g)].map((m) => m[1]);
    const block = source.match(/const OUTSIDE_CODE = \{[\s\S]*?\};/)?.[0] ?? '';
    const mapped = [...block.matchAll(/'([a-z][a-z_]+)'/g)].map((m) => m[1]).filter((c) => c.startsWith('postcode_'));
    const more = source.includes('readStdinText') ? ['request_too_large'] : [];
    for (const code of new Set([...thrown, ...mapped, ...more])) assert.ok(documented.has(code), `${tool}: ${code} is raised but not documented`);
    for (const e of t.docs.ERRORS) assert.ok(new RegExp(`'${e.code}'`).test(source), `${tool}: ${e.code} is documented but never raised`);
    for (const w of t.docs.WARNINGS) if (w.code !== 'engine_warning') assert.ok(new RegExp(`'${w.code}'`).test(source), `${tool}: warning ${w.code} is documented but never raised`);
    const raisedWarnings = [...source.matchAll(/(?:warn\(\s*|code:\s*)'([a-z][a-z_]+)'/g)].map((m) => m[1]).filter((c) => !documented.has(c));
    const warned = new Set(t.docs.WARNINGS.map((w) => w.code));
    for (const c of raisedWarnings) assert.ok(warned.has(c), `${tool}: warning ${c} is raised but not documented`);
    const text = run(tool, ['--help', 'errors']).stdout;
    for (const code of documented) assert.ok(text.includes(code), `${tool}: --help errors lists ${code}`);
  }
});

// ── The examples run ────────────────────────────────────────────────────────────────────────────────────────

test('every example in every help works exactly as written', async () => {
  for (const [tool, t] of Object.entries(TOOLS)) {
    for (const ex of t.docs.EXAMPLES) {
      const d = tmp();
      try {
        for (const [name, content] of Object.entries(ex.files ?? {})) {
          const file = path.join(d, name);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (typeof content === 'string' && content.startsWith('@pdf:')) fs.writeFileSync(file, await fx.makePdf(Number(content.slice(5)), name));
          else fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
        }
        const input = ex.stdinFile ? fs.readFileSync(path.join(d, ex.stdinFile), 'utf8') : undefined;
        const r = run(tool, ex.args, { cwd: d, input });
        assert.equal(r.status, 0, `${tool}: "${ex.title}" (${ex.args.join(' ')}): ${r.stderr || r.stdout.slice(0, 300)}`);
        if (ex.args.includes('--json') && !ex.args.includes('--config-keys')) assert.equal(r.json.ok, true, `${tool}: "${ex.title}" answers ok`);
      } finally { rm(d); }
    }
  }
});

// ── One source with the README ──────────────────────────────────────────────────────────────────────────────

test('the generated tables in the README equal what the tools print (run node scripts/sync-cli-docs.mjs to fix)', async () => {
  for (const [rel, [current, generated]] of Object.entries(await renderReadmes())) {
    assert.equal(current, generated, `${rel} is out of date: run node scripts/sync-cli-docs.mjs`);
    assert.ok(/<!-- cli-docs:errors -->/.test(current) && /<!-- cli-docs:exit-codes -->/.test(current), `${rel} has its generated sections`);
  }
});

// ── The renderer ────────────────────────────────────────────────────────────────────────────────────────────

test('the help renderer wraps at the help width, pads names, and refuses topics that do not exist', () => {
  assert.ok(wrap('word '.repeat(60), 2, 4).every((l) => l.length <= 100));
  assert.equal(wrap('a b', 2)[0], '  a b');
  const rows = formatRows([{ name: 'a', text: 'first' }, { name: 'longer', text: 'second' }]);
  assert.equal(rows[0], '  a       first');
  const doc = { tool: 't', version: '1.0.0', summary: ['s'], usage: ['t x'], options: [['--x', 'x']], errors: [], examples: [{ title: 'e', args: ['--x'] }], topics: {} };
  assert.throws(() => renderHelp(doc, 'nope'), (e) => e.code === 'usage_unknown_topic' && e.exit === 2);
  assert.ok(helpBody(doc).help.startsWith('t 1.0.0: s'));
  assert.deepEqual(topicNames(doc), ['errors', 'examples']);
});
