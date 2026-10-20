/**
 * The BundleTool command line (scripts/build-cli.mjs), run for real as a child process under plain Node: the
 * contract (exit codes, --json, error codes, --version), the cover rule, and the adversarial inputs a program
 * calling it could send by mistake or on purpose. The shared contract helper has its own unit tests at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';
import { loadPdf } from '../public/js/bundletoolPdfLoad.js';
import { MANIFEST_KEYS, SECTION_KEYS, FILE_KEYS, unknownKeyProblems, validateManifestShape } from '../public/js/manifestSchema.js';
import { parseArgs, CliError, EXIT } from '../scripts/cli-contract.mjs';
import { PD27A_PAGE_LIMIT, isOverPd27aLimit, MAX_SECTIONS } from '../public/js/frontend/limits.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'scripts', 'build-cli.mjs');
const EXAMPLE = path.join(root, 'examples', 'family-c100-fl401-manifest.json');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'manifest.schema.json'), 'utf8'));
const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'btcli-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
/** A directory holding a real PDF for every file the manifest names, and the manifest written beside it. */
async function setup(d, mutate = () => {}) {
  const docs = path.join(d, 'docs'); fs.mkdirSync(docs, { recursive: true });
  const manifest = example();
  for (const s of manifest.sections) for (const f of s.files) fs.writeFileSync(path.join(docs, f.filename), await fx.makePdf(2, f.filename));
  fs.writeFileSync(path.join(docs, 'my-cover.pdf'), await fx.makePdf(3, 'MY COVER'));
  mutate(manifest, docs);
  const mp = path.join(d, 'm.json');
  fs.writeFileSync(mp, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return { docs, mp, out: path.join(d, 'out.pdf') };
}
const pagesOf = async (file) => (await loadPdf(new Uint8Array(fs.readFileSync(file)))).doc.getPageCount();

// ── The contract ────────────────────────────────────────────────────────────

test('--version reads the package version; --help lists the exit codes; both work as JSON', () => {
  const v = cli(['--version']);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), PKG.version);
  assert.equal(cli(['-V']).stdout.trim(), PKG.version);
  assert.equal(cli(['--json', '--version']).json.version, PKG.version);
  const h = cli(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage:/);
  assert.match(h.stdout, /^Exit codes:\n  0  Done\.\n  1  .*\n  2  The command line was wrong\.\n  3  The input was rejected/m);
  assert.deepEqual(PKG.bin, { bundletool: 'scripts/build-cli.mjs' });
});

test('usage mistakes exit 2 with a stable code', () => {
  for (const [args, code] of [
    [[], 'usage_missing_arguments'], [['m.json', 'docs'], 'usage_missing_arguments'], [['a', 'b', 'c', 'd'], 'usage_too_many_arguments'],
    [['--no-such-flag', 'a', 'b', 'c'], 'usage_unknown_option'], [['--version=1'], 'usage_bad_option'],
  ]) {
    const plain = cli(args);
    assert.equal(plain.status, 2, args.join(' '));
    assert.match(plain.stderr, new RegExp(`failed \\(${code}\\)`));
    const j = cli(['--json', ...args]);
    assert.equal(j.status, 2);
    assert.equal(j.json.error.code, code);
  }
});

test('--json: one JSON object on stdout and nothing on stderr; the engine chatter is silenced; the page counts are true', async () => {
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d);
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one line of JSON, no [meta] or [toc] lines');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tool, 'bundletool');
    assert.equal(r.json.cliVersion, PKG.version);
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.output, out);
    assert.equal(r.json.bytes, fs.statSync(out).size);
    assert.equal(r.json.coverSource, 'none');
    assert.equal(r.json.pages.total, await pagesOf(out), 'the reported page count is the real one');
    assert.equal(r.json.pages.source, 14);
    assert.deepEqual(r.json.warnings, [], 'the shipped example manifest has no unknown keys');
    // Without --json the progress is written for people.
    const plain = cli([mp, docs, path.join(d, 'plain.pdf')]);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /\[bundletool\] wrote /);
  } finally { rm(d); }
});

test('a failure with --json is one JSON object with a stable code, the file at fault, and nothing written', async () => {
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d, (m, docsDir) => fs.rmSync(path.join(docsDir, 'chronology.pdf')));
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 3);
    assert.equal(r.stderr, '');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'file_not_found');
    assert.equal(r.json.error.details.file, 'chronology.pdf');
    assert.equal(fs.existsSync(out), false);
  } finally { rm(d); }
});

// ── The cover rule ──────────────────────────────────────────────────────────

test('the cover follows the browser rule: none, generated, supplied, and supplied wins', async () => {
  const d = tmp();
  try {
    const build = async (name, mutate) => {
      const dir = path.join(d, name); fs.mkdirSync(dir);
      const { docs, mp, out } = await setup(dir, mutate);
      const r = cli(['--json', mp, docs, out]);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(r.json.pages.total, await pagesOf(out));
      return r.json;
    };
    const plain = await build('a', () => {});
    const generated = await build('b', (m) => { m.config['pageOptions.generateCover'] = true; });
    const supplied = await build('c', (m) => { m.coversheet = 'my-cover.pdf'; });
    const both = await build('d', (m) => { m.coversheet = 'my-cover.pdf'; m.config['pageOptions.generateCover'] = true; });
    assert.equal(generated.pages.total, plain.pages.total + 1);
    assert.equal(generated.coverSource, 'generated');
    assert.equal(supplied.pages.total, plain.pages.total + 1, 'only the first page of a supplied cover is used');
    assert.equal(supplied.coverSource, 'uploaded');
    assert.equal(both.coverSource, 'uploaded');
    assert.equal(both.pages.total, plain.pages.total + 1);
  } finally { rm(d); }
});

// ── Adversarial input ───────────────────────────────────────────────────────

test('a file that is not a PDF, an encrypted PDF and a truncated PDF are refused with their own codes, naming the file', async () => {
  const d = tmp();
  try {
    for (const [make, code] of [
      [async () => Buffer.from('this is plain text, not a PDF'), 'invalid_pdf'],
      [async () => Buffer.from(await fx.makeEncryptedPdf(2)), 'encrypted_pdf'],
      [async () => fx.truncate(Buffer.from(await fx.makePdf(4)), 0.4), 'invalid_pdf'],
      [async () => Buffer.alloc(0), 'invalid_pdf'],
    ]) {
      const dir = path.join(d, code + Math.random().toString(36).slice(2, 6)); fs.mkdirSync(dir);
      const { docs, mp, out } = await setup(dir);
      fs.writeFileSync(path.join(docs, 'chronology.pdf'), await make());
      const r = cli(['--json', mp, docs, out]);
      assert.equal(r.status, 3);
      assert.equal(r.json.error.code, code);
      assert.equal(r.json.error.details.file, 'chronology.pdf');
      assert.equal(fs.existsSync(out), false);
    }
  } finally { rm(d); }
});

test('the manifest is rejected, with its own code, when it is missing, not JSON, wrongly shaped or of another version', async () => {
  const d = tmp();
  try {
    const { docs, out } = await setup(d);
    const write = (v, n) => { const f = path.join(d, n); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
    const expectCode = (m, code) => { const r = cli(['--json', m, docs, out]); assert.equal(r.status, 3, code); assert.equal(r.json.error.code, code, JSON.stringify(r.json.error)); assert.equal(fs.existsSync(out), false); };
    expectCode(path.join(d, 'missing.json'), 'manifest_not_found');
    expectCode(write('{ not json', 'a.json'), 'invalid_json');
    expectCode(write('[1,2,3]', 'b.json'), 'invalid_manifest');
    expectCode(write('"text"', 'c.json'), 'invalid_manifest');
    expectCode(write({ sections: 'nope' }, 'd.json'), 'invalid_manifest');
    expectCode(write({ sections: [] }, 'e.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: 'x' }] }, 'f.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: [{ filename: 5 }] }] }, 'g.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: [{ filename: 'a.pdf', title: 7 }] }] }, 'h.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: [{ filename: 'a.pdf' }] }], config: [1] }, 'i.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: [{ filename: 'a.pdf' }] }], config: { 'heading.bundleTitle': { nested: true } } }, 'j.json'), 'invalid_manifest');
    expectCode(write({ sections: [{ files: [{ filename: 'a.pdf' }] }], coversheet: 5 }, 'k.json'), 'invalid_manifest');
    expectCode(write({ ...example(), schemaVersion: 2 }, 'l.json'), 'unsupported_schema_version');
    expectCode(write({ ...example(), schemaVersion: '1' }, 'l2.json'), 'unsupported_schema_version');
    expectCode(write({ sections: [{ files: [{ filename: 'a.pdf' }] }], surprise: 1 }, 'm.json'), 'unknown_key');
    const big = write(' '.repeat(5 * 1024 * 1024 + 1), 'n.json');
    expectCode(big, 'manifest_too_large');
  } finally { rm(d); }
});

test('unknown keys are rejected at the top level, in sections and in files, and listed with where they are', async () => {
  const d = tmp();
  try {
    const { docs, out } = await setup(d);
    const m = example();
    m.extra = 1; m.sections[0].colour = 'red'; m.sections[1].files[0].note = 'x';
    const f = path.join(d, 'u.json'); fs.writeFileSync(f, JSON.stringify(m));
    const r = cli(['--json', f, docs, out]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'unknown_key');
    assert.deepEqual(r.json.error.details.problems, ['unknown key "extra" at the top level', 'unknown key "colour" in sections[0]', 'unknown key "note" in sections[1].files[0]']);
    // The browser's own export (its _comment, no schemaVersion, pageCount-free files) is accepted as it is.
    assert.deepEqual(unknownKeyProblems({ _comment: 'x', config: {}, sections: [{ sectionID: 'a', sectionLabel: 'A', sectionName: 'N', files: [{ filename: 'a.pdf', title: 't', date: null }] }] }), []);
  } finally { rm(d); }
});

test('an unknown config key is a warning, not an error, and the build still runs', async () => {
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d, (m) => { m.config['heading.noSuchSetting'] = 'x'; m.config['pageOptions.oldThing'] = true; m.config._note = 'ignored quietly'; });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout);
    const w = r.json.warnings.filter((x) => x.code === 'unknown_config_key');
    assert.equal(w.length, 1);
    assert.match(w[0].message, /heading\.noSuchSetting/);
    assert.match(w[0].message, /pageOptions\.oldThing/);
    assert.doesNotMatch(w[0].message, /_note/);
  } finally { rm(d); }
});

test('a huge section count and a huge file count are refused before any file is read', async () => {
  const d = tmp();
  try {
    const { docs, out } = await setup(d);
    const sections = Array.from({ length: 201 }, (_, i) => ({ sectionID: `s${i}`, sectionLabel: 'A', sectionName: 'N', files: [{ filename: 'case-summary.pdf' }] }));
    const f1 = path.join(d, 'sec.json'); fs.writeFileSync(f1, JSON.stringify({ sections }));
    const r1 = cli(['--json', f1, docs, out]);
    assert.equal(r1.status, 3);
    assert.equal(r1.json.error.code, 'invalid_manifest');
    assert.match(r1.json.error.message, /201 sections/);
    const many = { sections: [{ sectionID: 's', sectionLabel: 'A', sectionName: 'N', files: Array.from({ length: 2001 }, () => ({ filename: 'case-summary.pdf' })) }] };
    const f2 = path.join(d, 'files.json'); fs.writeFileSync(f2, JSON.stringify(many));
    const r2 = cli(['--json', f2, docs, out]);
    assert.equal(r2.status, 3);
    assert.match(r2.json.error.message, /2000 files/);
    assert.equal(fs.existsSync(out), false);
  } finally { rm(d); }
});

test('file names must be plain names inside the documents folder: dot dots, folders, absolute paths, backslashes, links out', async () => {
  const d = tmp();
  const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'secret.pdf'), await fx.makePdf(1, 'SECRET'));
    fs.writeFileSync(path.join(d, 'up.pdf'), await fx.makePdf(1, 'UP'));
    const { docs, out } = await setup(d);
    fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(docs, 'link.pdf'));
    fs.symlinkSync(outside, path.join(docs, 'dirlink'));
    const bad = [
      ['../up.pdf', 'invalid_filename'], ['sub/case-summary.pdf', 'invalid_filename'], [path.join(outside, 'secret.pdf'), 'invalid_filename'],
      ['..\\up.pdf', 'invalid_filename'], ['..', 'invalid_filename'], ['.', 'invalid_filename'], ['a\0.pdf', 'invalid_filename'],
      ['link.pdf', 'path_outside_docs'], ['nope.pdf', 'file_not_found'],
    ];
    for (const [name, code] of bad) {
      const m = { sections: [{ sectionID: 's', sectionLabel: 'A', sectionName: 'N', files: [{ filename: name }] }] };
      const mp = path.join(d, 'x.json'); fs.writeFileSync(mp, JSON.stringify(m));
      const r = cli(['--json', mp, docs, out]);
      assert.equal(r.status, 3, name);
      assert.equal(r.json.error.code, code, name);
      assert.equal(fs.existsSync(out), false, `${name}: nothing written`);
    }
  } finally { rm(d); rm(outside); }
});

test('the coversheet cannot be read from outside the documents folder either', async () => {
  const d = tmp();
  const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'cover.pdf'), await fx.makePdf(1, 'SECRET COVER'));
    const { docs, out } = await setup(d);
    fs.symlinkSync(path.join(outside, 'cover.pdf'), path.join(docs, 'linked-cover.pdf'));
    fs.writeFileSync(path.join(d, 'up.pdf'), await fx.makePdf(1, 'UP'));
    for (const [name, code] of [['../up.pdf', 'invalid_filename'], [path.join(outside, 'cover.pdf'), 'invalid_filename'], ['linked-cover.pdf', 'path_outside_docs'], ['absent.pdf', 'file_not_found']]) {
      const m = example(); m.coversheet = name;
      const mp = path.join(d, 'c.json'); fs.writeFileSync(mp, JSON.stringify(m));
      const r = cli(['--json', mp, docs, out]);
      assert.equal(r.status, 3, name);
      assert.equal(r.json.error.code, code, name);
      assert.equal(fs.existsSync(out), false);
    }
    // A cover that is not a real PDF is refused as a cover, not built around.
    fs.writeFileSync(path.join(docs, 'bad-cover.pdf'), 'not a pdf');
    const m = example(); m.coversheet = 'bad-cover.pdf';
    const mp = path.join(d, 'c2.json'); fs.writeFileSync(mp, JSON.stringify(m));
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'invalid_cover');
  } finally { rm(d); rm(outside); }
});

test('the documents folder and the output place are checked, and the output may not be one of the inputs', async () => {
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d);
    assert.equal(cli(['--json', mp, path.join(d, 'nodocs'), out]).json.error.code, 'docs_dir_not_found');
    assert.equal(cli(['--json', mp, path.join(docs, 'chronology.pdf'), out]).json.error.code, 'docs_dir_not_found');
    assert.equal(cli(['--json', mp, docs, path.join(d, 'no', 'such', 'out.pdf')]).json.error.code, 'output_dir_missing');
    const before = fs.readFileSync(path.join(docs, 'chronology.pdf'));
    const r = cli(['--json', mp, docs, path.join(docs, 'chronology.pdf')]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'output_overwrites_input');
    assert.ok(fs.readFileSync(path.join(docs, 'chronology.pdf')).equals(before), 'the source document is untouched');
  } finally { rm(d); }
});

test('running twice at the same output path is refused unless --force is given', async () => {
  const d = tmp();
  try {
    const { mp, docs, out } = await setup(d);
    const first = cli(['--json', mp, docs, out]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const before = fs.readFileSync(out);
    const second = cli(['--json', mp, docs, out]);
    assert.equal(second.status, 3);
    assert.equal(second.json.error.code, 'output_exists');
    assert.ok(fs.readFileSync(out).equals(before), 'the existing file is untouched without --force');
    const forced = cli(['--json', '--force', mp, docs, out]);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  } finally { rm(d); }
});

test('a missing, null or blank title is filled in from the filename, exactly as the page does when a title field is cleared', async () => {
  const d = tmp();
  for (const mutate of [
    (m) => { delete m.sections[0].files[0].title; },
    (m) => { m.sections[0].files[0].title = null; },
    (m) => { m.sections[0].files[0].title = '   '; },
  ]) {
    const sub = path.join(d, String(Math.random()).slice(2));
    fs.mkdirSync(sub);
    const { mp, docs, out } = await setup(sub, mutate);
    const filename = JSON.parse(fs.readFileSync(mp, 'utf8')).sections[0].files[0].filename;
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.warnings, [], `no warning for a derived title (${filename})`);
  }
  rm(d);
});

test('a setting the engine rejects is an input error with its own code, not a crash', async () => {
  const d = tmp();
  try {
    let refused = 0;
    for (const [i, [key, value]] of [['pageOptions.pageSize', 'giant'], ['pageOptions.printableBundle', 'yes'], ['pageNumbering.footerLink', 'sideways']].entries()) {
      const dir = path.join(d, `k${i}`); fs.mkdirSync(dir);
      const { docs, mp, out } = await setup(dir, (m) => { m.config[key] = value; });
      const r = cli(['--json', mp, docs, out]);
      assert.notEqual(r.json.error?.code, 'internal_error', key);
      if (r.status === 3) { refused++; assert.equal(r.json.error.code, 'invalid_config', key); }
    }
    assert.ok(refused >= 1, 'at least one of these bad settings is refused as invalid_config');
  } finally { rm(d); }
});

// ── Schema and shared helper ────────────────────────────────────────────────

test('the JSON Schema names exactly the keys the CLI accepts', () => {
  assert.deepEqual(Object.keys(SCHEMA.properties).sort(), [...MANIFEST_KEYS].sort());
  assert.deepEqual(Object.keys(SCHEMA.properties.sections.items.properties).sort(), [...SECTION_KEYS].sort());
  assert.deepEqual(Object.keys(SCHEMA.properties.sections.items.properties.files.items.properties).sort(), [...FILE_KEYS].sort());
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(SCHEMA.properties.sections.items.additionalProperties, false);
  assert.equal(SCHEMA.properties.sections.items.properties.files.items.additionalProperties, false);
  assert.equal(SCHEMA.properties.sections.maxItems, MAX_SECTIONS, 'the schema holds sections to the bundle limit in frontend/limits.js');
  assert.doesNotThrow(() => validateManifestShape(example()));
});

test('the shared argument parser: flags, values, short letters, the "--" separator and the errors', () => {
  const spec = { flags: ['--json', '--strict'], options: ['--base-dir'], short: { V: '--version' } };
  assert.deepEqual(parseArgs(['a', '--json', 'b', '--base-dir', 'x', '--base-dir=y'], spec), { positionals: ['a', 'b'], flags: { json: true }, options: { 'base-dir': 'y' } });
  assert.deepEqual(parseArgs(['--', '--json', '-x'], spec).positionals, ['--json', '-x']);
  assert.deepEqual(parseArgs(['-'], spec).positionals, ['-']);
  for (const bad of [['--nope'], ['--json=1'], ['--base-dir'], ['--base-dir='], ['-z']]) {
    assert.throws(() => parseArgs(bad, spec), (e) => e instanceof CliError && e.exit === EXIT.USAGE, bad.join(' '));
  }
  assert.deepEqual(EXIT, { OK: 0, BUILD: 1, USAGE: 2, INPUT: 3 });
});

test('a section without a sectionID is numbered by its position; one that is not four digits is refused', async () => {
  const d = tmp();
  try {
    const plain = await setup(d, (m) => { for (const s of m.sections) delete s.sectionID; });
    const ok = cli(['--json', plain.mp, plain.docs, plain.out]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(ok.json.ok, true);
    const bad = await setup(path.join(d, 'bad'), (m) => { m.sections[0].sectionID = 's1'; });
    const r = cli(['--json', bad.mp, bad.docs, bad.out]);
    assert.equal(r.status, 3);
    assert.equal(r.json.error.code, 'invalid_manifest');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('--config-keys lists the settings, and an unknown config key is ignored with a hint at the nearest real ones', async () => {
  const listed = cli(['--json', '--config-keys']);
  assert.equal(listed.status, 0);
  assert.equal(listed.json.configKeys['heading.claimNumber'], '');
  assert.ok('cover.applicantName' in listed.json.configKeys);
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d, (m) => { m.config['heading.applicant'] = 'X'; m.config['heading.caseNumber'] = 'Y'; });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const w = r.json.warnings.find((x) => x.code === 'unknown_config_key');
    assert.match(w.message, /heading\.applicant \(did you mean cover\.applicantName\?\)/);
    assert.match(w.message, /--config-keys/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('index.dateInputOrder is a known setting (browser only, the CLI never parses filenames), defaulting to UK', async () => {
  const keys = cli(['--json', '--config-keys']).json.configKeys;
  assert.equal(keys['index.dateInputOrder'], 'UK');
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d, (m) => { m.config['index.dateInputOrder'] = 'US'; });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.warnings, [], 'no unknown_config_key warning for index.dateInputOrder');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the cover toggles are known settings: listed by --config-keys, accepted in a manifest, drawn on the cover', async () => {
  const keys = cli(['--json', '--config-keys']).json.configKeys;
  assert.equal(keys['cover.caseNumberLine'], 'court');
  assert.equal(keys['cover.partyLabelPlacement'], 'inline');
  assert.equal(keys['cover.titleLines'], 'single');
  assert.equal(keys['cover.partyAlign'], 'centre');
  assert.equal(keys['cover.caseNumberAlign'], 'right');
  assert.equal(keys['cover.headingAlign'], 'left');
  const d = tmp();
  try {
    const { docs, mp, out } = await setup(d, (m) => {
      m.config['pageOptions.generateCover'] = true;
      Object.assign(m.config, { 'cover.caseNumberLine': 'own', 'cover.partyLabelPlacement': 'inline', 'cover.partyAlign': 'left', 'cover.caseNumberAlign': 'left', 'cover.headingAlign': 'centre', 'cover.applicantName': 'A\nB' });
    });
    const r = cli(['--json', mp, docs, out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.coverSource, 'generated');
    assert.deepEqual(r.json.warnings, [], 'no unknown_config_key warning for these settings');
    const bad = await setup(path.join(d, 'bad'), (m) => { m.config['pageOptions.generateCover'] = true; m.config['cover.partyAlign'] = 'diagonal'; });
    const b = cli(['--json', bad.mp, bad.docs, bad.out]);
    assert.notEqual(b.status, 0, 'an invalid alignment is refused, not silently drawn');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a bundle over 350 pages warns about Practice Direction 27A, without failing the build; one at or under 350 does not warn', async () => {
  // pages.total is the source pages plus at least one index page (and a cover, if there is one), so
  // a manifest with exactly 350 source pages is already over 350 in the built bundle: the boundary is
  // checked against pages.total itself (isOverPd27aLimit, the same function the page uses), not
  // against the source count chosen here. The three cases still bracket the real boundary either
  // side, which is what matters.
  const d = tmp();
  try {
    for (const sourcePages of [100, 349, 900]) {
      const sub = path.join(d, String(sourcePages));
      const docs = path.join(sub, 'docs'); fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, 'big.pdf'), await fx.makePdf(sourcePages, 'PAGE'));
      const mp = path.join(sub, 'm.json');
      fs.writeFileSync(mp, JSON.stringify({ schemaVersion: 1, sections: [{ sectionID: '0000', sectionLabel: 'A', files: [{ filename: 'big.pdf' }] }] }));
      const out = path.join(sub, 'out.pdf');
      const r = cli(['--json', mp, docs, out]);
      assert.equal(r.status, 0, `${sourcePages} source pages: ${r.stdout + r.stderr}`);
      assert.equal(r.json.ok, true);
      const warning = r.json.warnings.find((w) => w.code === 'over_pd27a_page_limit');
      const expectWarning = isOverPd27aLimit(r.json.pages.total);
      if (expectWarning) {
        assert.ok(warning, `${sourcePages} source pages, ${r.json.pages.total} total: expected the PD27A warning`);
        assert.match(warning.message, /Practice Direction 27A/);
        assert.match(warning.message, /350/);
        assert.match(warning.message, new RegExp(String(r.json.pages.total)));
      } else {
        assert.equal(warning, undefined, `${sourcePages} source pages, ${r.json.pages.total} total: expected no PD27A warning`);
      }
    }
    // The exact boundary itself: a source count chosen so the built total lands on 350 precisely.
    const probeDir = path.join(d, 'probe', 'docs'); fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'p.pdf'), await fx.makePdf(1, 'PAGE'));
    const probeMp = path.join(d, 'probe', 'm.json');
    fs.writeFileSync(probeMp, JSON.stringify({ schemaVersion: 1, sections: [{ sectionID: '0000', sectionLabel: 'A', files: [{ filename: 'p.pdf' }] }] }));
    const probe = cli(['--json', probeMp, probeDir, path.join(d, 'probe', 'out.pdf')]).json;
    const overhead = probe.pages.total - 1; // index (+ cover, none here) pages for a one-file, one-section bundle
    const boundarySourcePages = PD27A_PAGE_LIMIT - overhead;
    const bd = path.join(d, 'boundary'); const bdocs = path.join(bd, 'docs'); fs.mkdirSync(bdocs, { recursive: true });
    fs.writeFileSync(path.join(bdocs, 'p.pdf'), await fx.makePdf(boundarySourcePages, 'PAGE'));
    const bmp = path.join(bd, 'm.json');
    fs.writeFileSync(bmp, JSON.stringify({ schemaVersion: 1, sections: [{ sectionID: '0000', sectionLabel: 'A', files: [{ filename: 'p.pdf' }] }] }));
    const bout = path.join(bd, 'out.pdf');
    const b = cli(['--json', bmp, bdocs, bout]);
    assert.equal(b.json.pages.total, PD27A_PAGE_LIMIT, 'the probe put the built total exactly on the limit');
    assert.equal(b.json.warnings.find((w) => w.code === 'over_pd27a_page_limit'), undefined, 'exactly 350 is not over the limit');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
