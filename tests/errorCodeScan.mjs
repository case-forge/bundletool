/**
 * The source scan behind the error code tests: errorCodes.test.mjs (BundleTool, BT-), envelopeErrorCodes.test.mjs
 * (Envelope Guide, EG-) and chambersFinderErrorCodes.test.mjs (Chambers Finder, CF-). It reads the scripts as text,
 * the way the other guard tests do, so a new notice is checked whether or not anyone remembers to list it.
 *
 * What it checks, for one product:
 *  1. the registry: each code once, in the product's shape, with a one-line meaning;
 *  2. every code written in the source is in the registry, and is written in exactly one place, so a code finds its
 *     line (a code given out twice could not);
 *  3. every registered code is raised somewhere, unless it is retired, and a retired code is raised nowhere;
 *  4. every call to a notice (the product's list of sinks) passes a code: a `code` key in its object, or the code as
 *     its first argument. `null` is accepted only where the sink allows a notice that only informs;
 *  5. every object that describes a notice for a sink to show later (it has both a `title` and a `message`) carries a
 *     `code` too, so a descriptor cannot lose its code on the way.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'new', 'yield', 'await', 'instanceof']);

/**
 * Two views of a script, both the same length as the source so positions line up: `noComments` has comments blanked,
 * `masked` has comments and the contents of string, template and regex literals blanked (a template's `${...}` parts
 * stay, as code), so brackets and keys can be counted without a quote or a slash inside a literal getting in the way.
 */
export function maskScript(src) {
  const masked = src.split('');
  const noComments = src.split('');
  const blank = (arr, from, to) => { for (let i = from; i < to; i++) if (arr[i] !== '\n') arr[i] = ' '; };
  let i = 0;
  // Template nesting: each entry is the brace depth at which a `${` opened inside a template literal.
  const templates = [];
  let braceDepth = 0;
  let lastSig = '';   // the last significant character or word outside literals, to tell a regex from a division
  const n = src.length;
  const readTemplate = (start) => {
    // From just after a backtick (or a closing `}` of `${...}`), to the closing backtick or the next `${`.
    let j = start;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { blank(masked, start, j); return { end: j + 1, opened: false }; }
      if (src[j] === '$' && src[j + 1] === '{') { blank(masked, start, j); return { end: j + 2, opened: true }; }
      j++;
    }
    blank(masked, start, n);
    return { end: n, opened: false };
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const to = end === -1 ? n : end;
      blank(masked, i, to); blank(noComments, i, to);
      i = to; continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const to = end === -1 ? n : end + 2;
      blank(masked, i, to); blank(noComments, i, to);
      i = to; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(masked, i + 1, j);
      i = j + 1; lastSig = 'x'; continue;
    }
    if (c === '`') {
      const t = readTemplate(i + 1);
      if (t.opened) templates.push(braceDepth);
      i = t.end; lastSig = t.opened ? '{' : 'x'; continue;
    }
    if (c === '/') {
      const regexAllowed = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastSig);
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        blank(masked, i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        i = j; lastSig = 'x'; continue;
      }
    }
    if (c === '{') braceDepth++;
    if (c === '}') {
      // The `}` that ends a template's `${...}`: the template's text carries on after it.
      if (templates.length && templates[templates.length - 1] === braceDepth) {
        templates.pop();
        const t = readTemplate(i + 1);
        if (t.opened) templates.push(braceDepth);
        i = t.end; lastSig = t.opened ? '{' : 'x'; continue;
      }
      braceDepth--;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      lastSig = src.slice(i, j);
      if (!KEYWORDS_BEFORE_REGEX.has(lastSig)) lastSig = 'x';
      i = j; continue;
    }
    if (!/\s/.test(c)) lastSig = /[0-9)\]]/.test(c) ? 'x' : c;
    i++;
  }
  return { masked: masked.join(''), noComments: noComments.join('') };
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** The index of the bracket that closes the one at `open`, in masked text. */
export function closingBracket(masked, open) {
  const stack = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * The top-level keys of the object literal whose `{` is at `open`: { name: { valueStart, valueEnd } }, shorthand keys
 * (`{ code }`) included with the key itself as the value. `src` is the original text at the same positions.
 */
export function objectKeys(masked, src, open) {
  const close = closingBracket(masked, open);
  const keys = {};
  if (close === -1) return keys;
  // Split the body at top-level commas.
  const parts = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push([from, i]); from = i + 1; }
  }
  parts.push([from, close]);
  for (const [a, b] of parts) {
    const text = masked.slice(a, b);
    const lead = text.length - text.trimStart().length;
    const start = a + lead;
    if (start >= b || masked.startsWith('...', start)) continue;
    // A key: an identifier, or a quoted name (blanked in masked, read from the source).
    let m = /^([A-Za-z_$][\w$]*)\s*:/.exec(masked.slice(start, b));
    let name = m?.[1];
    let valueStart = m ? start + m[0].length : -1;
    if (!m && (src[start] === '\'' || src[start] === '"')) {
      const endQuote = src.indexOf(src[start], start + 1);
      const after = /^\s*:/.exec(masked.slice(endQuote + 1, b));
      if (endQuote !== -1 && after) { name = src.slice(start + 1, endQuote); valueStart = endQuote + 1 + after[0].length; }
    }
    if (name !== undefined) {
      keys[name] = { valueStart, valueEnd: b };
      continue;
    }
    const shorthand = /^([A-Za-z_$][\w$]*)\s*(?:=[^]*)?$/.exec(masked.slice(start, b).trimEnd());
    if (shorthand) keys[shorthand[1]] = { valueStart: start, valueEnd: start + shorthand[1].length, shorthand: true };
  }
  return keys;
}

/** Every object literal in a masked script: the positions of their opening braces. */
function objectLiterals(masked) {
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '{') continue;
    // An object literal follows an expression position: after ( , = : [ ? return => or at the start of a value.
    const before = masked.slice(Math.max(0, i - 12), i).trimEnd();
    if (/(?:[(,=:[?]|=>|\breturn)$/.test(before)) out.push(i);
  }
  return out;
}

/** The line number of a position. */
export function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** The registry, read as text: [{ code, meaning, line }] in order, duplicates kept. */
export function readRegistry(text, prefix) {
  const out = [];
  const re = new RegExp(`^\\s*(['"])(${prefix}-[^'"]*)\\1:\\s*(['"])((?:(?!\\3)[^\\\\]|\\\\.)*)\\3,?\\s*$`, 'gm');
  for (const m of text.matchAll(re)) out.push({ code: m[2], meaning: m[4].replace(/\\(['"])/g, '$1'), line: lineOf(text, m.index) });
  return out;
}

/** Every file below `dir` with one of the extensions, as [relative path, text], skipping vendored code. */
export function sourceFiles(root, dirs, exts, skip = () => false) {
  const out = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    const list = fs.statSync(abs).isFile() ? [''] : fs.readdirSync(abs, { recursive: true });
    for (const f of list) {
      const rel = path.join(dir, f).split(path.sep).join('/');
      if (!exts.some((e) => rel.endsWith(e)) || /(^|\/)vendor\//.test(rel) || skip(rel)) continue;
      out.push([rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
    }
  }
  return out;
}

/** Comments of an HTML or Hugo template, blanked. */
function maskTemplate(src) {
  return src.replace(/<!--[\s\S]*?-->|\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Checks one product. Returns { problems: string[], counts } where an empty problems list is a pass.
 *
 * @param {{
 *   prefix: string,                       e.g. 'BT'
 *   registry: { text: string, codes: Record<string,string>, retired: string[] },
 *   scripts: Array<[string, string]>,     [path, text] of every script that may raise a code
 *   templates?: Array<[string, string]>,  [path, text] of templates that may carry a code in their markup
 *   sinks: Array<{ name: string, pattern: RegExp, arg: 'object'|'first', allowNull?: boolean }>,
 * }} product
 */
export function checkProduct({ prefix, registry, scripts, templates = [], sinks }) {
  const problems = [];
  const shape = new RegExp(`^${prefix}-[A-Z]{2,8}-\\d{2}$`);
  const anyCode = new RegExp(`\\b${prefix}-[A-Za-z0-9]+-\\d+\\b`, 'g');

  // 1. The registry.
  const entries = readRegistry(registry.text, prefix);
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.code)) problems.push(`registry: ${e.code} is listed twice (lines ${seen.get(e.code)} and ${e.line})`);
    seen.set(e.code, e.line);
    if (!shape.test(e.code)) problems.push(`registry: ${e.code} is not shaped ${prefix}-AREA-NN`);
    if (!e.meaning.trim() || /\n/.test(e.meaning)) problems.push(`registry: ${e.code} needs a one-line meaning`);
  }
  const parsed = entries.map((e) => e.code).sort();
  const loaded = Object.keys(registry.codes).sort();
  if (JSON.stringify([...new Set(parsed)]) !== JSON.stringify(loaded)) problems.push('registry: the codes read from the text differ from the codes the module exports (the test cannot read it)');
  for (const r of registry.retired) if (!Object.hasOwn(registry.codes, r)) problems.push(`registry: retired ${r} is not in the registry`);

  // 2. and 3. Codes written in the source.
  const uses = new Map();
  const note = (code, where) => { if (!uses.has(code)) uses.set(code, []); uses.get(code).push(where); };
  const views = new Map();
  for (const [file, src] of scripts) {
    const view = maskScript(src);
    views.set(file, { src, ...view });
    for (const m of view.noComments.matchAll(anyCode)) note(m[0], `${file}:${lineOf(src, m.index)}`);
  }
  for (const [file, src] of templates) {
    for (const m of maskTemplate(src).matchAll(anyCode)) note(m[0], `${file}:${lineOf(src, m.index)}`);
  }
  for (const [code, where] of uses) {
    if (!Object.hasOwn(registry.codes, code)) problems.push(`${where.join(', ')}: ${code} is not in the registry`);
    else if (registry.retired.includes(code)) problems.push(`${where.join(', ')}: ${code} is retired and must not be raised`);
    if (where.length > 1) problems.push(`${code} is raised in ${where.length} places (${where.join(', ')}): each code belongs to one place`);
  }
  for (const code of Object.keys(registry.codes)) {
    if (!uses.has(code) && !registry.retired.includes(code)) problems.push(`${code} is in the registry but raised nowhere: retire it rather than leave it`);
  }

  // 4. Every call to a sink passes a code.
  for (const [file, { src, masked }] of views) {
    for (const sink of sinks) {
      for (const m of masked.matchAll(sink.pattern)) {
        const before = masked.slice(Math.max(0, m.index - 20), m.index);
        if (/\bfunction\s*$/.test(before)) continue;   // the definition, not a call
        const open = masked.indexOf('(', m.index + m[0].length - 1);
        const close = closingBracket(masked, open);
        const where = `${file}:${lineOf(src, m.index)}`;
        if (close === -1) { problems.push(`${where}: could not read the call to ${sink.name}`); continue; }
        const argStart = open + 1 + (masked.slice(open + 1).length - masked.slice(open + 1).trimStart().length);
        let value = null;
        if (sink.arg === 'object') {
          if (masked[argStart] !== '{') { problems.push(`${where}: ${sink.name} is given something other than an object with a code`); continue; }
          const keys = objectKeys(masked, src, argStart);
          if (!keys.code) { problems.push(`${where}: ${sink.name} without a code`); continue; }
          value = keys.code.shorthand ? 'code' : src.slice(keys.code.valueStart, keys.code.valueEnd).trim();
        } else {
          let depth = 0;
          let end = close;
          for (let i = argStart; i < close; i++) {
            const c = masked[i];
            if (OPEN[c]) depth++;
            else if (c === ')' || c === ']' || c === '}') depth--;
            else if (c === ',' && depth === 0) { end = i; break; }
          }
          value = src.slice(argStart, end).trim();
        }
        if (value === 'null' || (!sink.allowNull && /\bnull\b/.test(value))) {
          if (!sink.allowNull) problems.push(`${where}: ${sink.name} must carry a code, not null`);
        } else if (/^['"`]/.test(value)) {
          const literal = /^(['"`])([^'"`]*)\1$/.exec(value)?.[2];
          if (!literal || !shape.test(literal)) problems.push(`${where}: ${sink.name} is given ${value}, which is not a code`);
        } else if (!value) {
          problems.push(`${where}: ${sink.name} without a code`);
        }
      }
    }
  }

  // 5. Descriptors carry a code.
  for (const [file, { src, masked }] of views) {
    for (const open of objectLiterals(masked)) {
      const keys = objectKeys(masked, src, open);
      if (keys.title && keys.message && !keys.code) problems.push(`${file}:${lineOf(src, open)}: a notice (title and message) without a code`);
    }
  }

  return { problems, uses };
}
