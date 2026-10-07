/**
 * The one gate every file passes on its way into BundleTool, from "Add Documents", a drop, the
 * coversheet or a manifest import.
 *
 * It decides three things, always from the file's own bytes:
 *   1. what the file is (bundletoolSniff.js), whatever its name says;
 *   2. whether it is one of the supported kinds and within the limits;
 *   3. what to tell the person, in plain words, if it is not: what happened, which file, what to do.
 *
 * It opens nothing. Reading, converting and validating happen after a file has been admitted.
 */
import { classifyBlob, docxTotals, readEntryHead } from '../bundletoolSniff.js';
import { readJpegInfo } from '../bundletoolImages.js';
import {
  MAX_FILE_MB, MAX_NAME_CHARS, DOCX_LIMITS, DOCX_MAX_PICTURE_PIXELS,
} from './limits.js';

const MB = 1024 * 1024;

/** What a kind is called in a sentence. */
const KIND_NAMES = {
  pdf: 'a PDF', jpeg: 'a JPEG photo', png: 'a PNG photo', gif: 'a GIF picture', bmp: 'a BMP picture',
  webp: 'a WEBP photo', tiff: 'a TIFF scan', avif: 'an AVIF photo', heic: 'a HEIC photo',
  docx: 'a Word document', docm: 'a Word document with macros', xlsx: 'an Excel spreadsheet',
  pptx: 'a PowerPoint presentation', odf: 'an OpenDocument file', pages: 'an Apple Pages document',
  zip: 'a zip archive', ole: 'an older Microsoft Office file (or one protected by a password)',
  exe: 'a program', shortcut: 'a Windows shortcut', html: 'a web page', svg: 'an SVG drawing',
  text: 'a plain text file', empty: 'an empty file', unknown: 'a file BundleTool does not recognise',
};

/** The kinds that are photos, for routing. */
const PHOTO_KINDS = new Set(['jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'avif', 'heic']);

/** The extension a name claims, lower case, without the dot ('' when there is none). */
export function claimedExtension(name) {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

/** Extensions that are right for each kind (a mismatch is worth a note, never a refusal on its own). */
const EXTENSIONS = {
  pdf: ['pdf'], jpeg: ['jpg', 'jpeg', 'jpe'], png: ['png'], gif: ['gif'], bmp: ['bmp'], webp: ['webp'],
  tiff: ['tif', 'tiff'], avif: ['avif'], heic: ['heic', 'heif'], docx: ['docx'],
};

/**
 * A file name that is safe to show, store and offer for download: no control characters, no
 * characters that reverse or hide text (which can make report.exe look like report.pdf), no path
 * separators, no leading dots, and no more than MAX_NAME_CHARS characters. The real name is kept
 * elsewhere for recognising the same file again.
 *
 * @param {string} name
 * @returns {string} never empty
 */
export function safeFileName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿￹-￻]/g, '');
  s = s.split(/[\\/]/).filter(Boolean).pop() ?? s;   // a path keeps only its last part
  s = s.replace(/[:*?"<>|]+/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  const withExtension = /\.[A-Za-z0-9]{1,6}$/.exec(s)?.[0] ?? '';
  s = s.replace(/^[.\s]+/, '');             // ".." and ".hidden" become ordinary names
  // A name that was only dots and an extension ("....pdf") keeps the extension on a plain name.
  if (withExtension && !s.includes('.')) s = `document${withExtension}`;
  s = s.replace(/[.\s]+$/, '');            // Windows drops trailing dots and spaces
  if (!s) return 'document';
  if (s.length > MAX_NAME_CHARS) {
    const ext = claimedExtension(s);
    const keep = ext ? `.${ext}` : '';
    s = s.slice(0, MAX_NAME_CHARS - keep.length - 1).trimEnd() + '…' + keep;
  }
  return s;
}

/**
 * The name with an extension that matches what the file really is: a photo saved as scan.pdf becomes
 * scan.jpg, a PDF saved as scan.jpg becomes scan.pdf. A name with no claim to correct is returned as it is.
 */
export function correctedName(name, kind) {
  const wanted = EXTENSIONS[kind];
  const claimed = claimedExtension(name);
  if (!wanted || wanted.includes(claimed)) return name;
  const known = ['pdf', 'jpg', 'jpeg', 'jpe', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'docx', 'docm'];
  const base = known.includes(claimed) ? name.slice(0, -(claimed.length + 1)) : name;
  return `${base}.${wanted[0]}`;
}

const fmtMb = (bytes) => (bytes / MB >= 10 ? Math.round(bytes / MB) : (bytes / MB).toFixed(1));

/**
 * @typedef {Object} Admission
 * @property {boolean} ok
 * @property {'pdf'|'docx'|'photo'} [route]  what to do with the file when ok
 * @property {string} [kind]                 what the bytes are (see bundletoolSniff.js)
 * @property {string} [note]                 something to tell the person even though the file is fine
 * @property {string} [code]                 the error code of a refusal (errorCodes.js)
 * @property {string} [reason]               short reason for a list of refused files
 * @property {string} [title]                modal title for a single refused file
 * @property {string} [message]              modal text for a single refused file
 */

const refuse = (code, name, reason, title, message) => ({
  ok: false, code, reason, title, message: `"${name}" ${message}`,
});

/**
 * Decides whether a file may be added, and how.
 *
 * @param {File} file
 * @param {{outcome?: string}} [opts] what did not happen if it is refused, for example 'added'
 * @returns {Promise<Admission>}
 */
export async function admitFile(file, opts = {}) {
  const name = file.name;
  const outcome = opts.outcome ?? 'added';
  const notDone = `so it was not ${outcome}`;

  if (file.size === 0) {
    return refuse('BT-ADD-20', name, 'empty (0 bytes)', 'That file is empty',
      `is empty (0 bytes), ${notDone}. It may not have finished copying: check the original and try again.`);
  }
  if (file.size > MAX_FILE_MB * MB) {
    return refuse('BT-ADD-21', name, `too large (${fmtMb(file.size)} MB)`, 'That file is too large',
      `is ${fmtMb(file.size)} MB, more than the ${MAX_FILE_MB} MB one file may be, ${notDone}. Split it into smaller parts in a PDF tool, or save it again at a lower quality, then add it.`);
  }

  let info;
  try {
    info = await classifyBlob(file);
  } catch {
    // A folder, or a file that has moved or is locked: the browser cannot read a single byte of it.
    return refuse('BT-ADD-22', name, 'could not be read', 'That file could not be read',
      `could not be read, ${notDone}. If it is a folder, open it and choose the files inside. If it is on a network drive or a phone, copy it to this computer first.`);
  }
  let kind = info.kind;
  let flavour = info.zip?.flavour;
  const claimed = claimedExtension(name);

  if (kind === 'zip') {
    if (info.zip.error) {
      return refuse('BT-ADD-23', name, 'a damaged zip or Word file', 'That file is damaged',
        `looks like a Word document or zip file but is damaged or cut short, ${notDone}. Open it in Word, save it again as a Word document (.docx) or as a PDF, then add that.`);
    }
    if (flavour === 'docx' || flavour === 'docm') {
      const problem = await checkDocx(file, info.zip.entries);
      if (problem) {
        return refuse(problem.code, name, problem.reason, problem.title,
          `${problem.message}, ${notDone}. In Word, choose Save As and pick PDF, then add the PDF (it keeps the layout exactly).`);
      }
      const note = flavour === 'docm'
        ? `"${name}" has macros. They were ignored: BundleTool only reads the text and pictures.` : '';
      return { ok: true, route: 'docx', kind: 'docx', note };
    }
    kind = flavour === 'zip' ? 'zip' : flavour;
  }

  if (kind === 'pdf' || PHOTO_KINDS.has(kind)) {
    const wanted = EXTENSIONS[kind] ?? [];
    const kindName = KIND_NAMES[kind];
    // The name and the bytes disagree: go by the bytes, and say so.
    const mismatch = claimed && !wanted.includes(claimed) && ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'docx'].includes(claimed);
    const note = mismatch ? `"${name}" is named .${claimed} but is really ${kindName}, so it was treated as one.` : '';
    return { ok: true, route: kind === 'pdf' ? 'pdf' : 'photo', kind, note };
  }

  // Not something BundleTool reads. Say what it looks like, and what to do about it.
  const what = KIND_NAMES[kind] ?? KIND_NAMES.unknown;
  const looksLike = claimed === 'pdf' || claimed === 'docx' || PHOTO_KINDS.has(claimed) || claimed === 'jpg' || claimed === 'jpeg'
    ? `is named .${claimed} but is really ${what}` : `is ${what}`;
  const advice = {
    ole: 'BundleTool reads Word documents saved as .docx, not older .doc files, and cannot open a file protected by a password. In Word, remove any password, choose Save As and pick Word Document (.docx) or PDF, then add that.',
    exe: 'It cannot be added and was never opened.',
    shortcut: 'A shortcut only points at a file. Add the file it points to.',
    html: 'It was not opened. Save the page as a PDF (print it to PDF), then add that.',
    svg: 'It was not opened or drawn. Save the picture as a PNG or JPG, then add that.',
    text: 'Print or save it as a PDF from the program you made it in, then add that.',
    xlsx: 'Print or save the spreadsheet as a PDF from Excel, then add that.',
    pptx: 'Save the presentation as a PDF from PowerPoint, then add that.',
    odf: 'Save it as a PDF or a Word document (.docx), then add that.',
    pages: 'Export it as a PDF or Word document from Pages, then add that.',
    zip: 'Unzip it and add the files inside.',
    docm: 'Save it as a Word document (.docx) or PDF, then add that.',
    unknown: 'Convert it to a PDF, photo or Word document (.docx) first.',
    empty: 'It has nothing in it.',
  }[kind] ?? 'Convert it to a PDF, photo or Word document (.docx) first.';
  return {
    ok: false,
    code: 'BT-ADD-24',
    reason: `${what}, not a type BundleTool reads`,
    title: 'That file cannot be added',
    message: `"${name}" ${looksLike}, ${notDone}. ${advice}`,
    guide: true,
  };
}

/**
 * Looks inside a Word document's directory and its pictures (without unpacking any of it) and
 * returns a description of the problem when it is too big to convert safely, or null.
 */
async function checkDocx(file, entries) {
  const t = docxTotals(entries, DOCX_LIMITS);
  if (t.problem === 'entries') {
    return { code: 'BT-ADD-25', reason: 'a Word document with too many parts', title: 'That Word document is too complex',
      message: `contains ${entries.length.toLocaleString('en-GB')} separate parts, far more than a normal document has` };
  }
  if (t.problem === 'total') {
    return { code: 'BT-ADD-26', reason: 'a Word document that unpacks to too much', title: 'That Word document is too large',
      message: `would unpack to ${fmtMb(t.total)} MB, more than BundleTool can convert (${DOCX_LIMITS.maxTotalBytes / MB} MB)` };
  }
  if (t.problem === 'xml') {
    return { code: 'BT-ADD-27', reason: 'a Word document that is too long to convert', title: 'That Word document is too long to convert',
      message: `is very long (its text alone unpacks to ${fmtMb(t.xml)} MB)` };
  }
  if (t.problem === 'media') {
    return { code: 'BT-ADD-28', reason: 'a Word document with a very large picture', title: 'That Word document holds a very large picture',
      message: `holds a picture of ${fmtMb(t.largestMedia)} MB` };
  }
  // Length is judged by the text itself: drawing a document costs time and memory for every page, and
  // 7,000 short paragraphs are only about 2 MB unpacked.
  const docXml = entries.find((e) => e.name === 'word/document.xml');
  if (docXml) {
    const bytes = await readEntryHead(file, docXml, DOCX_LIMITS.maxXmlBytes);
    if (bytes) {
      const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      let chars = 0;
      for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) chars += m[1].length;
      const paragraphs = (xml.match(/<\/w:p>/g) ?? []).length;
      const pages = Math.round((chars + 60 * paragraphs) / 3000);
      if (pages > DOCX_LIMITS.maxEstimatedPages) {
        return { code: 'BT-ADD-29', reason: 'a Word document that is too long to convert', title: 'That Word document is too long to convert',
          message: `is very long (about ${pages} pages), and converting that many pages would use more memory than a browser tab has` };
      }
    }
  }
  // A picture can be small in the file and huge on the page: read each picture's size from its header.
  for (const e of entries) {
    if (!e.name.startsWith('word/media/')) continue;
    const head = await readEntryHead(file, e, 65536);
    if (!head) continue;
    const pixels = pictureSize(head);
    if (pixels && pixels > DOCX_MAX_PICTURE_PIXELS) {
      return { code: 'BT-ADD-30', reason: 'a Word document with a very large picture', title: 'That Word document holds a very large picture',
        message: `holds a picture of about ${Math.round(pixels / 1e6)} million pixels, too large to draw` };
    }
  }
  return null;
}

/** Pixel count of a PNG or JPEG from its first bytes, or 0 when it cannot be read. */
function pictureSize(head) {
  if (head.length > 24 && head[0] === 0x89 && head[1] === 0x50) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return dv.getUint32(16) * dv.getUint32(20);
  }
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    const { width, height } = readJpegInfo(head);
    return width * height;
  }
  return 0;
}
