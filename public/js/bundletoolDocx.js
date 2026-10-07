/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolDocx.js
 * Converts a dropped .docx to a PDF, which is then added to the bundle like
 * any other document. The conversion runs one way only: Word to PDF.
 *
 * mammoth.convertToHtml() reads the docx's own structure (headings, bold and
 * italic, lists, tables) into plain HTML: not a pixel-exact copy of Word's
 * layout, but a readable rendering of the content, which is what a court
 * bundle needs. jsPDF's own .html() plugin (html2canvas underneath) then
 * paints that HTML onto page-size PDF pages, paginating across as many as the
 * content needs. The result is an ordinary PDF: added to state.filesMap and
 * merged through the same @cantoo/pdf-lib pipeline every other document uses,
 * the same way imageToPdf() in bundletoolPages.js turns a JPG or PNG into one.
 */
import mammoth from './vendor/mammoth.js';
import { jsPdfFormat } from './bundletoolPageSize.js';
import { getJsPdfCtor } from './bundletoolToc.js';

const UNPARSEABLE_COLOUR = /oklch|oklab|color-mix|\blab\(|\blch\(/;

/**
 * html2canvas (inside jsPDF's .html()) reads the page's own <html> and <body>
 * colours and throws on any colour function it cannot parse. In Classic those
 * come from Tailwind utilities and compute to oklch(), so without this a Word
 * file fails there with "Attempting to parse an unsupported color function
 * 'oklch'", while Modern (which remaps them to hex) converts fine. This pins
 * each such value to its exact sRGB equivalent for the duration of the
 * conversion (resolved through a canvas, so nothing visibly changes) and
 * returns a function that puts the original inline styles back.
 *
 * @returns {() => void} restore
 */
function pinPageColoursToRgb() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const toRgb = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  };
  const restores = [];
  for (const el of [document.documentElement, document.body]) {
    const computed = getComputedStyle(el);
    for (const prop of ['background-color', 'color']) {
      const value = computed.getPropertyValue(prop);
      if (!UNPARSEABLE_COLOUR.test(value)) continue;
      const priorValue = el.style.getPropertyValue(prop);
      const priorPriority = el.style.getPropertyPriority(prop);
      el.style.setProperty(prop, toRgb(value), 'important');
      restores.push(() => {
        if (priorValue) el.style.setProperty(prop, priorValue, priorPriority);
        else el.style.removeProperty(prop);
      });
    }
  }
  return () => restores.forEach((fn) => fn());
}

/** Parses HTML without running or loading anything, and removes active content from it. */
function inertBody(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach((el) => el.remove());
  parsed.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      const isUrl = name === 'href' || name === 'src' || name === 'xlink:href';
      if (name.startsWith('on') || (isUrl && /^(javascript|vbscript):/.test(value))) el.removeAttribute(attr.name);
    }
  });
  return parsed.body;
}

/** The file could not be read as a Word document (a damaged or deliberately malformed package): the file's problem, not a fault in BundleTool. */
export class DocxReadError extends Error {
  constructor(cause) {
    super('That Word file could not be read: ' + (cause?.message || 'its contents do not match its own directory'));
    this.name = 'DocxReadError';
    this.cause = cause;
  }
}

/**
 * @param {Uint8Array} docxBytes
 * @param {string} pageSizeKey
 * @returns {Promise<Uint8Array>} a PDF, however many pages the content needs
 */
export async function docxToPdf(docxBytes, pageSizeKey) {
  const arrayBuffer = docxBytes.buffer.slice(
    docxBytes.byteOffset, docxBytes.byteOffset + docxBytes.byteLength);
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml({ arrayBuffer }));
  } catch (error) {
    // Everything mammoth throws here comes from reading the package (a zip that lies about its
    // contents, a missing main part, broken XML): it is the file that is damaged.
    throw new DocxReadError(error);
  }

  const jsPDF = await getJsPdfCtor();
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    // The bundle's own page size, same reasoning as the index in
    // bundletoolToc.js: a converted document should match the rest of the
    // bundle, not default to whatever jsPDF ships with.
    format: jsPdfFormat(pageSizeKey),
  });
  const MARGIN_MM = 15;
  const contentWidthMm = doc.internal.pageSize.getWidth() - 2 * MARGIN_MM;

  // html2canvas measures actual layout, so the HTML needs a real place in
  // the document: not display:none, which reports zero size and produces a
  // blank PDF, and NOT a large negative left offset either, despite looking
  // like the obvious "keep it off-screen" choice. jsPDF's own doc.html()
  // computes each element's draw position from its real on-page
  // getBoundingClientRect(), so a -99999px offset carries straight into the
  // output: a PDF with real content in it (a correctly sized content stream,
  // a drawn table border box) but with every Tj text operator positioned tens
  // of thousands of points off the page, so it looks completely blank. That
  // holds in both autoPaging modes, 'text' and 'slice': it is about position,
  // not paging. z-index:-9999 keeps it out of view instead (behind the page's
  // own opaque background), at left:0/top:0, a real on-page position that
  // doc.html() computes correctly.
  const container = document.createElement('div');
  container.className = 'bundletool-docx-convert';
  container.style.cssText =
    'position:fixed; left:0; top:0; z-index:-9999; width:700px; font-family:helvetica,sans-serif; font-size:13px; line-height:1.4; color:#000; background:#fff;';
  // The HTML comes from a Word file, which is untrusted: it is parsed into an inert document and
  // stripped of anything that can run code before it touches the page (mammoth already escapes
  // text, so this is defence in depth, in the same spirit as the page's script-src policy).
  container.replaceChildren(...inertBody(html).childNodes);

  // The app's own Tailwind preflight resets `margin:0`/`padding:0` on
  // every element and `list-style:none` on every list, page-wide, and a
  // container appended under document.body inherits that cascade too: an
  // ordered list would render with no numbers, and every heading, paragraph
  // and table row would collapse onto the next with no visible gap.
  // mammoth's own HTML carries no inline styles or classes to override it
  // with, so these are fallback defaults, not a guess at the original
  // document's design: they restore ordinary heading, paragraph and list
  // spacing and add a visible table grid, since mammoth's plain
  // <table><td> markup carries no border information whether or not the
  // source table had one.
  const resetStyle = document.createElement('style');
  resetStyle.textContent = `
    .bundletool-docx-convert h1, .bundletool-docx-convert h2, .bundletool-docx-convert h3 {
      font-weight: bold; margin: 0.6em 0 0.3em;
    }
    .bundletool-docx-convert h1 { font-size: 1.6em; }
    .bundletool-docx-convert h2 { font-size: 1.35em; }
    .bundletool-docx-convert h3 { font-size: 1.15em; }
    .bundletool-docx-convert p { margin: 0 0 0.75em; }
    .bundletool-docx-convert ul, .bundletool-docx-convert ol {
      margin: 0 0 0.75em; padding-left: 1.6em;
    }
    .bundletool-docx-convert ul { list-style: disc; }
    .bundletool-docx-convert ol { list-style: decimal; }
    .bundletool-docx-convert li { margin: 0 0 0.25em; }
    .bundletool-docx-convert table { border-collapse: collapse; margin: 0 0 0.75em; }
    .bundletool-docx-convert td, .bundletool-docx-convert th {
      border: 1px solid #999; padding: 4px 8px;
    }
  `;
  container.prepend(resetStyle);
  document.body.appendChild(container);

  // jsPDF's .html() and html2canvas put a full-screen overlay
  // (.html2pdf__overlay, z-index 1000, pointer events on) and a hidden iframe
  // into the page while they work, and only remove them when they finish. An
  // error part-way (an unparseable colour, for example) would leave the
  // overlay behind, invisible, above every modal, including the error modal
  // about to be shown, so its Copy details, Report this bug and Close buttons
  // would not respond. Anything they add is removed below whatever happens.
  const strayBefore = new Set(document.querySelectorAll('.html2pdf__overlay, .html2canvas-container'));
  const restorePageColours = pinPageColoursToRgb();
  try {
    // width/windowWidth is jsPDF's own documented recipe for this: render the
    // container at windowWidth CSS pixels, then scale the result to fit
    // `width` mm on the page. See the comment above the container's own
    // styling for why it sits at left:0/top:0.
    await doc.html(container, {
      margin: MARGIN_MM,
      autoPaging: 'text',
      width: contentWidthMm,
      windowWidth: 700,
    });
  } finally {
    restorePageColours();
    document.body.removeChild(container);
    document.querySelectorAll('.html2pdf__overlay, .html2canvas-container').forEach((el) => {
      if (!strayBefore.has(el)) el.remove();
    });
  }

  return new Uint8Array(doc.output('arraybuffer'));
}
