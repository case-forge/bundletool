/**
 * The document window (frontend/rotate.js) set up in Node for a test file: a fake DOM holding the ids the real
 * template gives the window (tests/fakeDom.mjs), a real pdf.js drawing onto @napi-rs/canvas when that is installed,
 * and a record of which pages pdf.js was asked for and told to free.
 */
import fs from 'node:fs';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { FakeDocument, FakeElement, elementsFromTemplate, templateBlock, fakeEvent } from './fakeDom.mjs';
import { makePdf } from './fixtures.mjs';

export let createCanvas = null;
try { ({ createCanvas } = await import('@napi-rs/canvas')); } catch { /* optional: without it nothing is drawn, and the window says so */ }

export const doc = new FakeDocument();
globalThis.document = doc;
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
// pdf.js runs its worker in this thread when the worker module is already loaded.
globalThis.pdfjsWorker = await import('/vendor/pdfjs.worker.mjs');
// Outside a browser pdf.js has no files for the standard fonts and says so on every page it draws.
const plainLog = console.log;
console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('Warning:'))) plainLog(...args); };

export const html = fs.readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
const block = templateBlock(html, 'rotate-modal');
export const modal = new FakeElement(doc, 'div', 'rotate-modal');
modal.className = 'hidden flex';
doc.body.appendChild(modal);
elementsFromTemplate(doc, modal, block.slice(block.indexOf('>') + 1), { makeCanvas: createCanvas });
export const outside = doc.body.appendChild(new FakeElement(doc, 'button', 'somewhere-else'));

// Which pages pdf.js was asked for, and which it was told to free, through the same module the window uses.
const pdfjs = await import('/vendor/pdfjs.mjs');
const probeTask = pdfjs.getDocument({ data: await makePdf(1), isEvalSupported: false });
const probe = await probeTask.promise;
const taskProto = Object.getPrototypeOf(probeTask);
const docProto = Object.getPrototypeOf(probe);
const pageProto = Object.getPrototypeOf(await probe.getPage(1));
export const log = { got: [], freed: [], destroyed: 0 };
const realGetPage = docProto.getPage;
docProto.getPage = function (n) { log.got.push(n); return realGetPage.call(this, n); };
const realCleanup = pageProto.cleanup;
pageProto.cleanup = function (...args) { log.freed.push(this.pageNumber); return realCleanup.apply(this, args); };
const realDestroy = taskProto.destroy;
taskProto.destroy = function (...args) { log.destroyed++; return realDestroy.apply(this, args); };
await probeTask.destroy();

export const { state } = await import('../public/js/frontend/state.js');
export const { openDocumentWindow } = await import('../public/js/frontend/rotate.js');

export const $ = (id) => doc.getElementById(id);
export const tick = () => new Promise((r) => setTimeout(r, 0));
export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const anglesOf = async (file) => (await PDFDocument.load(await file.arrayBuffer())).getPages().map((p) => p.getRotation().angle);
export const shownPage = () => Number($('rotate-page-input').value);
export const key = (k, target = $('rotate-right')) => target.dispatchEvent(fakeEvent('keydown', { key: k }));

/** Holds `bytes` (or a fresh n-page PDF) as a document called `name`, and opens the window on it. */
export async function open(name = 'statement.pdf', pages = 3, opts) {
  const bytes = pages instanceof Uint8Array ? pages : await makePdf(pages, 'WIN');
  const count = (await PDFDocument.load(bytes)).getPageCount();
  state.filesMap.set(name, new File([bytes], name, { type: 'application/pdf' }));
  state.frontendInputData[name] = { title: name, date: '', pageCount: count };
  const opener = doc.body.appendChild(new FakeElement(doc, 'button'));
  await openDocumentWindow(name, opener, opts);
  await until(() => log.got.includes(1) || !$('rotate-no-preview').classList.contains('hidden'), 'the first page');
  return { name, opener, file: state.filesMap.get(name) };
}

const font = fs.readFileSync(new URL('../public/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf', import.meta.url));

/**
 * A PDF whose pages pdf.js can draw without a browser's fonts (the font is embedded): `pages` lists each page's
 * lines of text, [] for a blank page.
 */
export async function textPdf(pages) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f = await pdf.embedFont(font, { subset: false });
  for (const lines of pages) {
    const page = pdf.addPage([595.28, 841.89]);
    lines.forEach((t, i) => page.drawText(t, { x: 72, y: 700 - i * 18, size: 12, font: f, color: rgb(0, 0, 0) }));
  }
  return pdf.save();
}
