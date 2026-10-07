/**
 * The command line contract of BundleTool's CLI (scripts/build-cli.mjs), the same one the other CaseForge
 * command line tools keep. It promises the same things to a program that calls them:
 *
 *   exit code   0 done, 1 the build failed, 2 wrong command line, 3 the input was rejected
 *   --json      stdout is exactly one JSON object, on success and on failure; nothing else is written there
 *   error code  a stable lower_snake_case string per failure class, in error.code
 *   --version   the tool's version, from its package.json
 *   --help      the tool documents itself: `--help` is a short overview, `--help <topic>` the detail, `--schema` the
 *               JSON Schema, and `--json --help` the same content as one JSON object (see the help section below)
 *
 * Pure Node, no dependencies, no engine: it can be imported before the PDF engine is resolvable.
 */
import { readFileSync } from 'node:fs';

/** Exit codes. Documented in each tool's README; changing one is a major version. */
export const EXIT = Object.freeze({ OK: 0, BUILD: 1, USAGE: 2, INPUT: 3 });

/** What each exit code means, the same words in every tool's help and README. */
export const EXIT_MEANINGS = Object.freeze({
  0: 'Done.',
  1: 'The input was fine and the build or the write failed (an unexpected fault).',
  2: 'The command line was wrong.',
  3: 'The input was rejected: the request or manifest, a file it names, or a place to write.',
});

/** The usage errors every tool can raise, with their meaning. */
export const USAGE_ERRORS = Object.freeze([
  { code: 'usage_missing_arguments', exit: 2, meaning: 'A required argument is missing.' },
  { code: 'usage_too_many_arguments', exit: 2, meaning: 'More arguments were given than the tool takes.' },
  { code: 'usage_unknown_option', exit: 2, meaning: 'An option the tool does not have (a typo is never taken for a file name).' },
  { code: 'usage_bad_option', exit: 2, meaning: 'An option was given without a value, or with a value it does not take.' },
  { code: 'usage_unknown_topic', exit: 2, meaning: '`--help` was asked for a topic the tool does not have.' },
]);

/** The one failure every tool can raise besides its own. */
export const INTERNAL_ERROR = Object.freeze({ code: 'internal_error', exit: 1, meaning: 'An unexpected fault in the tool itself (no stack trace is printed).' });

/** A failure the caller can act on. `code` is the stable string; `exit` is the process exit code. */
export class CliError extends Error {
  constructor(code, message, { exit = EXIT.INPUT, details = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exit = exit;
    this.details = details;
  }
}

/** A request problem in a JSON request: `code` is the stable string, `path` says where in the request it is. */
export class RequestError extends Error {
  constructor(code, message, path = '') { super(message); this.code = code; this.path = path; }
}

/** All of standard input as text, refusing more than `maxBytes` (request_too_large). */
export async function readStdinText(maxBytes, what = 'The request') {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new CliError('request_too_large', `${what} is larger than ${maxBytes / 1024 / 1024} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Throws unknown_key for the first key of `raw` that is not in `allowed`. */
export function rejectUnknownKeys(raw, allowed, where = 'the request') {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new RequestError('unknown_key', `Unknown key ${JSON.stringify(key.slice(0, 60))} in ${where}.`, key);
  }
}

/**
 * Reads argv into flags, options and positionals. `spec.flags` are booleans (`--json`), `spec.options` take a
 * value (`--base-dir <dir>`), `spec.short` maps single letters. Anything else starting with a dash is a usage error,
 * so a typo is never silently treated as a file name. `--` ends option parsing.
 */
export function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags ?? []);
  const options = new Set(spec.options ?? []);
  const short = spec.short ?? {};
  const out = { positionals: [], flags: {}, options: {} };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') { out.positionals.push(...argv.slice(i + 1)); break; }
    if (arg.length === 2 && arg[0] === '-' && arg[1] !== '-') arg = short[arg[1]] ?? arg;
    // People and programs ask for help in several ways: -help, -?, /?, --usage all mean --help.
    if (flags.has('--help') && HELP_ALIASES.has(arg)) arg = '--help';
    if (!arg.startsWith('-') || arg === '-') { out.positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (flags.has(name)) {
      if (eq !== -1) throw new CliError('usage_bad_option', `${name} does not take a value.`, { exit: EXIT.USAGE });
      out.flags[name.slice(2)] = true;
    } else if (options.has(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw new CliError('usage_bad_option', `${name} needs a value.`, { exit: EXIT.USAGE });
      out.options[name.slice(2)] = value;
    } else {
      const near = nearestOption(name, [...flags, ...options]);
      throw new CliError('usage_unknown_option', `Unknown option ${arg}.${near ? ` Did you mean ${near}?` : ''} Run with --help for the list.`, { exit: EXIT.USAGE });
    }
  }
  // `tool help` and `tool help <topic>` mean --help, as in git and npm; only when it cannot be a real argument list.
  if (flags.has('--help') && !out.flags.help && out.positionals[0] === 'help' && out.positionals.length <= 2) {
    out.flags.help = true;
    out.positionals.shift();
  }
  return out;
}

const HELP_ALIASES = new Set(['-help', '-?', '/?', '--usage', '-usage']);

/** The known option closest to a mistyped one (a typo of at most two edits, or a prefix), or null. */
function nearestOption(name, known) {
  const distance = (x, y) => {
    const row = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[y.length];
  };
  let best = null; let bestD = 3;
  for (const k of known) {
    const d = k.startsWith(name) && name.length >= 3 ? 1 : distance(name, k);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

/** The version in a package.json, or 'unknown' if it cannot be read. */
export function readVersion(packageJsonUrl) {
  try { return String(JSON.parse(readFileSync(packageJsonUrl, 'utf8')).version ?? 'unknown'); } catch { return 'unknown'; }
}

/**
 * The package's own name from its package.json, so the name a tool reports cannot drift from the
 * package. Read from the file, not npm_package_name: that is the name of whichever package's npm
 * script launched the process, wrong when one tool's script runs another tool's CLI.
 */
export function readName(packageJsonUrl) {
  // Throws rather than falling back to a placeholder: the name is the contract's `tool` field, and a
  // silent "unknown" would change what every caller reads without anything failing.
  const name = JSON.parse(readFileSync(packageJsonUrl, 'utf8')).name;
  if (typeof name !== 'string' || !name) throw new Error(`${String(packageJsonUrl)} has no package name, which the CLI reports as its tool name`);
  return name;
}

const clip = (s, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Runs `main(ctx)` under the contract. `ctx` carries `json`, a `log(message)` for progress (silent under --json),
 * and `warn(code, message)` for warnings. `main` returns the success fields of the JSON object, or throws a
 * CliError. Any other throw is reported as `internal_error` (exit 1) without a stack trace.
 *
 * Under --json the engine's own console output is silenced (warnings are collected into `warnings`) so stdout
 * holds one JSON object and nothing else.
 */
export async function runCli({ tool, version, json, main }) {
  const warnings = [];
  const real = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const ctx = {
    json,
    warnings,
    log: (message) => { if (!json) real.log(`[${tool}] ${message}`); },
    warn: (code, message, extra = {}) => { warnings.push({ code, message, ...extra }); if (!json) console.warn(`[${tool}] warning: ${message}`); },
  };
  if (json) {
    console.log = console.info = console.debug = () => {};
    console.warn = (...args) => { warnings.push({ code: 'engine_warning', message: clip(args.map(String).join(' ')) }); };
  }
  let exit = EXIT.OK;
  let body;
  try {
    const result = await main(ctx);
    exit = result.exit ?? EXIT.OK;
    if (result.text && !json) real.log(result.text);
    body = { ok: exit === EXIT.OK, tool, cliVersion: version, ...result.body };
    if (result.error) body.error = result.error;
  } catch (err) {
    const known = err instanceof CliError;
    exit = known ? err.exit : EXIT.BUILD;
    body = {
      ok: false, tool, cliVersion: version,
      error: {
        code: known ? err.code : 'internal_error',
        message: known ? err.message : clip(String(err?.message ?? err)),
        ...(known && err.details ? { details: err.details } : {}),
      },
    };
  }
  body.warnings = warnings;
  console.log = real.log; console.info = real.info; console.debug = real.debug; console.warn = real.warn;
  if (json) {
    process.stdout.write(JSON.stringify(body) + '\n');
  } else if (!body.ok) {
    console.error(`[${tool}] failed (${body.error?.code ?? 'error'}): ${body.error?.message ?? ''}`.trim());
  }
  process.exitCode = exit;
  return body;
}

// ── Built-in help ────────────────────────────────────────────────────────────────────────────────────────────
// Each tool writes ONE description of itself (a "doc": its summary, options, settings or fields, error codes,
// examples and JSON Schema) built from its own tables, and this section renders it as the plain text of
// `--help`, the topics of `--help <topic>`, the JSON of `--json --help`, and the tables in its README. The help
// is stable text: no colour, no terminal width, no reading of any file the user names.
//
// A doc is { tool, version, summary: [line, line], usage: [line], options: [[flag, text]], inputs: [line],
//   errors: [{code, exit, meaning}], warnings: [{code, meaning}], topics: { name: { title, lines?, rows? } },
//   examples: [{ title, args: [word], files: { name: object | string | '@pdf:N' }, note? }], schema? }
// where a topic's rows are [{ name, text }].

const WIDTH = 100;

/** Wraps `text` to the help width; every line after the first is indented by `hang` spaces. */
export function wrap(text, indent = 0, hang = indent, width = WIDTH) {
  const out = [];
  let line = ' '.repeat(indent);
  let empty = true;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + word.length > width) { out.push(line); line = ' '.repeat(hang) + word; } else { line += (empty ? '' : ' ') + word; }
    empty = false;
  }
  out.push(line);
  return out;
}

/** Name and description rows as text: names padded to the longest (up to 34), descriptions wrapped beside them. */
export function formatRows(rows, indent = 2) {
  const w = Math.min(34, Math.max(...rows.map((r) => r.name.length)));
  const out = [];
  for (const r of rows) {
    if (r.name.length > w) { out.push(' '.repeat(indent) + r.name); out.push(...wrap(r.text, indent + w + 2, indent + w + 2)); continue; }
    const [first, ...rest] = wrap(r.text, indent + w + 2, indent + w + 2);
    out.push(' '.repeat(indent) + r.name.padEnd(w) + '  ' + first.trimStart());
    out.push(...rest);
  }
  return out;
}

/** The command line of an example, quoted so it can be pasted into a shell. */
export function exampleCommand(doc, ex) {
  const q = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  return `${ex.stdinFile ? `cat ${q(ex.stdinFile)} | ` : ''}${doc.tool} ${ex.args.map(q).join(' ')}`;
}

const filesText = (ex) => Object.entries(ex.files ?? {}).flatMap(([name, content]) => {
  if (typeof content === 'string' && content.startsWith('@pdf:')) return [`  ${name}: a PDF of ${content.slice(5)} page(s)`];
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return [`  ${name}:`, ...body.split('\n').map((l) => '    ' + l)];
});

const allErrors = (doc) => [...USAGE_ERRORS, ...doc.errors, INTERNAL_ERROR];

/** The names of the topics a doc offers, in the order they are listed. */
export const topicNames = (doc) => [...Object.keys(doc.topics ?? {}), 'errors', 'examples', ...(doc.schema ? ['schema'] : [])];

/** Plain text for `--help` (no topic) or `--help <topic>`. Throws a usage CliError for an unknown topic. */
export function renderHelp(doc, topic) {
  const out = [];
  if (topic === undefined) {
    out.push(`${doc.tool} ${doc.version}: ${doc.summary[0]}`, ...doc.summary.slice(1).map((l) => '  ' + l), '');
    out.push('Usage:', ...doc.usage.map((l) => '  ' + l), '');
    out.push('Options:', ...formatRows(doc.options.map(([name, text]) => ({ name, text }))), '');
    if (doc.inputs?.length) out.push('Inputs:', ...doc.inputs.flatMap((l) => wrap(l, 2, 4)), '');
    out.push('Exit codes:', ...Object.entries(EXIT_MEANINGS).map(([c, m]) => `  ${c}  ${m}`), '');
    out.push('Examples:', ...doc.examples.slice(0, 3).flatMap((ex) => [`  ${ex.title}`, `    $ ${exampleCommand(doc, ex)}`]), '');
    out.push(`More: ${doc.tool} --help <topic>   topics: ${topicNames(doc).join(', ')}`);
    out.push('      --schema prints the JSON Schema; --json --help gives all of this as one JSON object.');
    return out.join('\n');
  }
  if (topic === 'errors') {
    out.push('Error codes (error.code in the --json output; the exit code is in brackets):', '');
    out.push(...formatRows(allErrors(doc).map((e) => ({ name: `${e.code} (${e.exit})`, text: e.meaning }))));
    if (doc.warnings?.length) out.push('', 'Warnings (warnings[].code; the run still succeeds):', '', ...formatRows(doc.warnings.map((w) => ({ name: w.code, text: w.meaning }))));
    out.push('', 'Exit codes:', ...Object.entries(EXIT_MEANINGS).map(([c, m]) => `  ${c}  ${m}`));
    return out.join('\n');
  }
  if (topic === 'examples') {
    out.push('Examples (each is run by the tests, so it works as written):');
    for (const ex of doc.examples) {
      out.push('', ex.title, `  $ ${exampleCommand(doc, ex)}`);
      if (ex.note) out.push(...wrap(ex.note, 2, 2));
      const f = filesText(ex);
      if (f.length) out.push('  with these files in the current folder:', ...f);
    }
    return out.join('\n');
  }
  if (topic === 'schema' && doc.schema) return JSON.stringify(doc.schema, null, 2);
  const t = doc.topics?.[topic];
  if (!t) throw new CliError('usage_unknown_topic', `No help topic "${String(topic).slice(0, 40)}". Topics: ${topicNames(doc).join(', ')}.`, { exit: EXIT.USAGE });
  out.push(t.title, '');
  if (t.lines) out.push(...t.lines.flatMap((l) => (l === '' ? [''] : wrap(l, 0, 0))));
  if (t.rows) out.push(...formatRows(t.rows));
  return out.join('\n');
}

/** `--json --help [topic]`: the same content as an object. `help` is the text, the rest is structured. */
export function helpBody(doc, topic) {
  const text = renderHelp(doc, topic);
  const base = { help: text, topic: topic ?? null };
  if (topic === 'schema') return { ...base, schema: doc.schema };
  if (topic !== undefined && doc.topics?.[topic]) return { ...base, title: doc.topics[topic].title, lines: doc.topics[topic].lines ?? [], rows: doc.topics[topic].rows ?? [] };
  if (topic === 'errors') return { ...base, errors: allErrors(doc), warnings: doc.warnings ?? [], exitCodes: EXIT_MEANINGS };
  if (topic === 'examples') return { ...base, examples: doc.examples.map((e) => ({ title: e.title, command: exampleCommand(doc, e), args: e.args, files: e.files ?? {}, note: e.note ?? null })) };
  return {
    ...base, summary: doc.summary, usage: doc.usage, options: doc.options.map(([flag, text]) => ({ flag, text })), inputs: doc.inputs ?? [],
    exitCodes: EXIT_MEANINGS, topics: topicNames(doc),
    examples: doc.examples.map((e) => ({ title: e.title, command: exampleCommand(doc, e) })),
  };
}

/**
 * The result a tool's main() returns for `--help [topic]` or `--schema`: `parsed` is the parseArgs result. Returns null
 * when neither was asked for, so the tool goes on. The doc is built lazily because a tool's settings may come from its engine.
 */
export async function helpResult(parsed, buildDoc) {
  const wantsSchema = parsed.flags.schema === true;
  if (!parsed.flags.help && !wantsSchema) return null;
  const doc = await buildDoc();
  if (wantsSchema) {
    if (!doc.schema) throw new CliError('usage_unknown_topic', `${doc.tool} has no JSON Schema.`, { exit: EXIT.USAGE });
    return { body: { schema: doc.schema }, text: JSON.stringify(doc.schema, null, 2) };
  }
  if (parsed.positionals.length > 1) throw new CliError('usage_too_many_arguments', '--help takes at most one topic.', { exit: EXIT.USAGE });
  const topic = parsed.positionals[0];
  return { body: helpBody(doc, topic), text: renderHelp(doc, topic) };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A Markdown table, for the README sections generated from a doc. */
export function markdownTable(header, rows) {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** The README sections a doc can produce: name, then the Markdown that sits between the two marker comments. */
export function readmeSections(doc, extra = {}) {
  return {
    'exit-codes': markdownTable(['Exit code', 'Meaning'], Object.entries(EXIT_MEANINGS).map(([c, m]) => [c, m])),
    errors: markdownTable(['Error code', 'Exit', 'Meaning'], allErrors(doc).map((e) => [`\`${e.code}\``, e.exit, e.meaning])),
    ...(doc.warnings?.length ? { warnings: markdownTable(['Warning code', 'Meaning'], doc.warnings.map((w) => [`\`${w.code}\``, w.meaning])) } : {}),
    ...extra,
  };
}

/** Replaces the text between `<!-- cli-docs:NAME -->` and `<!-- /cli-docs:NAME -->` in a README with the generated section. */
export function fillReadme(text, sections) {
  let out = text;
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- cli-docs:${name} -->)[\\s\\S]*?(<!-- /cli-docs:${name} -->)`);
    if (re.test(out)) out = out.replace(re, (_m, a, b) => `${a}\n${body}\n${b}`);
  }
  return out;
}
