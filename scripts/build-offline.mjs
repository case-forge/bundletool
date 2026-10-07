#!/usr/bin/env node
/**
 * Writes the offline service workers for BundleTool into the built site.
 *
 *   hugo && node scripts/build-offline.mjs [publicDir]
 *   (OFFLINE_TOOLS=bundletool limits it to the named tools, for a standalone repository)
 *
 * It reads the pages Hugo built, follows everything they load (stylesheets, scripts, and from each script its
 * imports, workers, libraries and the fonts it names), hashes every file, and writes <tool>/sw.js from
 * scripts/offline/sw.template.js with that list in it. Because the list comes from the built files, a new script,
 * library or icon is picked up with no list to keep in step, and because the worker contains every file's hash, a
 * deploy that changes any of them changes the worker, so browsers install the new version.
 *
 * No dependencies: Node's standard library only, so the Pages build and CI can run it as they are.
 * docs/offline-mode.md describes the design; scripts/offline/sw.template.js is the worker itself.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'offline', 'sw.template.js');

// A file the pages name as "/fonts/..." lives under one tool's own folder in the built site (the app adds its base
// path at run time), so a root-absolute string that matches nothing is retried under these prefixes.
const BASE_ALIASES = ['/bundletool'];

const FONT_EXT = /\.(?:ttf|otf|woff2?)$/i;

export const TOOLS = [
  {
    id: 'bundletool',
    scope: '/bundletool/',
    pages: ['/bundletool/', '/bundletool/guide/'],
    extra: ['/bundletool/manifest.json', '/bundletool/images/pwa-192.png', '/bundletool/images/pwa-512.png',
      '/bundletool/images/pwa-maskable-512.png', '/bundletool/images/caseforge-apple-touch.png'],
    // The default index and footer fonts are stored at install; the other families are stored on first use and
    // when the browser is idle.
    essentialFonts: ['/bundletool/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf',
      '/bundletool/fonts/arialalt/liberation-sans/LiberationSans-Bold.ttf',
      '/bundletool/fonts/serif/NotoSerif-Regular.ttf', '/bundletool/fonts/serif/NotoSerif-Bold.ttf'],
  },
];

/**
 * Where a tool's worker file is published. Inside this site it is /<id>/sw.js; a tool served from the root of its own
 * site (a standalone repository) sets `swPath: '/sw.js'` with `scope: '/'`.
 */
export const swPathOf = (tool) => tool.swPath ?? `/${tool.id}/sw.js`;

/** The address the not-found page is fetched at: 404.html is served at /404 (a direct request for the file is a redirect). */
const notFoundUrl = (tool) => tool.notFound.replace(/\.html$/, '');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function attr(tag, name) {
  // Minified pages drop the quotes around a simple value, so the value may be bare.
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

/** Turns a reference found in a file into a site path, or null for anything that is not a same-origin file path. */
function toSitePath(ref, fromPath) {
  if (!ref) return null;
  ref = ref.trim().replace(/&amp;/g, '&');
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:)/i.test(ref)) return null;
  ref = ref.split('#')[0].split('?')[0];
  if (!ref) return null;
  return ref.startsWith('/') ? path.posix.normalize(ref) : path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), ref));
}

function urlsInHtml(html) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (/(^|\s)(stylesheet|icon|shortcut|apple-touch-icon|manifest|modulepreload|preload)(\s|$)/.test(rel)) {
      out.push(attr(tag, 'href'));
      // The favicon script swaps between the light and dark files named here.
      out.push(attr(tag, 'data-light'), attr(tag, 'data-dark'));
    }
  }
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) out.push(attr(tag, 'src'));
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/gi) || []) out.push(attr(tag, 'src'));
  return out.filter(Boolean);
}

function urlsInCss(css) {
  const out = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) out.push(m[2]);
  for (const m of css.matchAll(/@import\s+(['"])([^'"]+)\1/g)) out.push(m[2]);
  return out;
}

function urlsInJs(js) {
  const out = [];
  const add = (re, group) => { for (const m of js.matchAll(re)) out.push(m[group]); };
  add(/(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(['"])([^'"\n]+)\1/g, 2);
  add(/\bimport\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g, 2);
  add(/new URL\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url/g, 2);
  add(/importScripts\(\s*(['"])([^'"]+)\1/g, 2);
  add(/(['"`])(\/[A-Za-z0-9_@.\-/]+\.(?:m?js|css|json|wasm|ttf|otf|woff2?|png|jpe?g|gif|svg|webp|ico))\1/g, 2);
  add(/(['"])(\.{1,2}\/[A-Za-z0-9_@.\-/]+\.(?:m?js|css|json|wasm))\1/g, 2);
  return out;
}

/** Everything one tool's pages need, as {path -> bytes}. Missing references are reported, never guessed. */
export function collect(publicDir, tool) {
  const files = new Map();
  const missing = [];
  const exists = (p) => { try { return fs.statSync(path.join(publicDir, p)).isFile(); } catch { return false; } };
  const resolve = (p) => {
    if (exists(p)) return p;
    for (const base of BASE_ALIASES) if (exists(base + p)) return base + p;
    return null;
  };
  const queue = [];
  const enqueue = (p, from) => {
    if (!p || p === swPathOf(tool) || /\.map$/.test(p)) return;
    const real = resolve(p);
    if (!real) { if (!/^\/vendor\//.test(from) && /\.(?:m?js|css|json|wasm|ttf|otf|woff2?|png|jpe?g|gif|svg|webp|ico)$/i.test(p)) missing.push(`${p} (from ${from})`); return; }
    if (!files.has(real)) { files.set(real, null); queue.push(real); }
  };
  function drain() {
    while (queue.length) {
      const p = queue.shift();
      const buf = fs.readFileSync(path.join(publicDir, p));
      files.set(p, buf);
      let refs = [];
      if (/\.css$/i.test(p)) refs = urlsInCss(buf.toString('utf8'));
      else if (/\.m?js$/i.test(p)) refs = urlsInJs(buf.toString('utf8'));
      for (const ref of refs) enqueue(toSitePath(ref, p), p);
    }
  }
  for (const page of tool.pages) {
    const htmlPath = path.posix.join(page, 'index.html');
    if (!exists(htmlPath)) throw new Error(`page ${page} is not in the build (${htmlPath})`);
    const html = fs.readFileSync(path.join(publicDir, htmlPath), 'utf8');
    files.set(page, Buffer.from(html));
    for (const ref of urlsInHtml(html)) enqueue(toSitePath(ref, page), page);
  }
  for (const p of [...tool.extra, ...tool.essentialFonts]) enqueue(p, 'the tool list');
  drain();
  const soft = new Set();
  if (tool.notFound) {
    if (!exists(tool.notFound)) throw new Error(`the not-found page ${tool.notFound} is not in the build`);
    const before = new Set(files.keys());
    const html = fs.readFileSync(path.join(publicDir, tool.notFound), 'utf8');
    const url = notFoundUrl(tool);
    files.set(url, Buffer.from(html));
    soft.add(url);
    for (const ref of urlsInHtml(html)) enqueue(toSitePath(ref, tool.notFound), tool.notFound);
    drain();
    for (const k of files.keys()) if (!before.has(k)) soft.add(k);
  }
  return { files, missing, soft };
}

export function generate(publicDir, tool) {
  const { files, missing, soft: softSet } = collect(publicDir, tool);
  const essential = new Set(tool.essentialFonts);
  const core = [], optional = [], soft = [];
  let coreBytes = 0, optionalBytes = 0, softBytes = 0;
  for (const p of [...files.keys()].sort()) {
    const buf = files.get(p);
    const entry = [p, sha(buf).slice(0, 16)];
    if (softSet.has(p)) { soft.push(entry); softBytes += buf.length; }
    else if (FONT_EXT.test(p) && !essential.has(p)) { optional.push(entry); optionalBytes += buf.length; }
    else { core.push(entry); coreBytes += buf.length; }
  }
  // Live files are fetched fresh, so only their paths (not their bytes) belong to the version.
  const live = tool.live || [];
  let liveBytes = 0;
  for (const p of live) {
    const file = path.join(publicDir, p);
    if (!fs.existsSync(file)) throw new Error(`the live file ${p} is not in the build`);
    liveBytes += fs.statSync(file).size;
  }
  const notFound = tool.notFound ? notFoundUrl(tool) : null;
  // Pages are fetched fresh at every install and never verified against their hash: an edge can add to a page
  // (an analytics snippet, an email obfuscation script) without the page being wrong, and a page is the one file a
  // stale copy cannot hide behind a label (it is small, and it always comes from this install).
  const fresh = [...tool.pages, ...(notFound ? [notFound] : [])];
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const version = sha(JSON.stringify([tool.id, core, optional, soft, live, notFound, fresh, template])).slice(0, 12);
  const body = template
    .replaceAll('__TOOL__', JSON.stringify(tool.id))
    .replace('__VERSION__', JSON.stringify(version))
    .replace('__CORE__', JSON.stringify(core))
    .replace('__OPTIONAL__', JSON.stringify(optional))
    .replace('__SOFT__', JSON.stringify(soft))
    .replace('__PAGES__', JSON.stringify(tool.pages))
    .replace('__LIVE__', JSON.stringify(live))
    .replace('__NOTFOUND__', JSON.stringify(notFound))
    .replace('__FRESH__', JSON.stringify(fresh));
  return { tool: tool.id, version, core, optional, soft, live, notFound, coreBytes, optionalBytes, softBytes, liveBytes, missing, body };
}

/**
 * True when the tool's built entry page registers its worker (the register partial adds the data-sw tag). With
 * `[params.offline] enabled = false` Hugo leaves the tag out and publishes the stand-in worker at the same path;
 * that build must ship the stand-in, so this script leaves the tool alone (writing a real worker over it would
 * defeat the kill switch for every browser that already has the worker).
 */
export function registersWorker(publicDir, tool) {
  try {
    const html = fs.readFileSync(path.join(publicDir, tool.pages[0], 'index.html'), 'utf8');
    // Minified output drops the quotes around the value, so accept both forms.
    const swPath = swPathOf(tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`data-sw=["']?${swPath}(?=["'\\s>])`).test(html);
  } catch { return false; }
}

/** OFFLINE_TOOLS=bundletool,envelope-guide limits the build to those tools: a standalone repository holds one. */
const only = () => (process.env.OFFLINE_TOOLS ? process.env.OFFLINE_TOOLS.split(',').map((t) => t.trim()).filter(Boolean) : null);

export function buildOffline(publicDir, { write = true, log = () => {}, tools = TOOLS } = {}) {
  const results = [];
  const wanted = only();
  for (const tool of tools) {
    if (wanted && !wanted.includes(tool.id)) continue;
    if (!registersWorker(publicDir, tool)) {
      log(`offline ${tool.id}: disabled (its page does not register a worker), the stand-in worker is kept`);
      continue;
    }
    const r = generate(publicDir, tool);
    if (write) fs.writeFileSync(path.join(publicDir, swPathOf(tool)), r.body);
    log(`offline ${tool.id}: version ${r.version}, ${r.core.length} files stored at install (${(r.coreBytes / 1048576).toFixed(1)} MB), ` +
      `${r.optional.length} stored on use (${(r.optionalBytes / 1048576).toFixed(1)} MB)` +
      (r.soft.length ? `, ${r.soft.length} best effort (${(r.softBytes / 1048576).toFixed(1)} MB)` : '') +
      (r.live.length ? `, ${r.live.length} kept fresh (${(r.liveBytes / 1048576).toFixed(1)} MB)` : ''));
    for (const m of r.missing) log(`offline ${tool.id}: WARNING referenced but not in the build: ${m}`);
    results.push(r);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node scripts/build-offline.mjs [publicDir] [--tools file.mjs]`: the file exports TOOLS (or a default array),
  // used instead of the three tools of this site (a standalone repository lists its own one tool).
  const argv = process.argv.slice(2);
  const toolsAt = argv.indexOf('--tools');
  let tools = TOOLS;
  if (toolsAt !== -1) {
    const mod = await import(pathToFileURL(path.resolve(argv[toolsAt + 1])).href);
    tools = mod.TOOLS ?? mod.default;
    argv.splice(toolsAt, 2);
  }
  const publicDir = path.resolve(argv[0] || 'public');
  const strict = process.env.OFFLINE_STRICT === '1';
  const results = buildOffline(publicDir, { log: (m) => console.log(m), tools });
  if (strict && results.some((r) => r.missing.length)) {
    console.error('offline: references to files that are not in the build (OFFLINE_STRICT=1)');
    process.exit(1);
  }
}
