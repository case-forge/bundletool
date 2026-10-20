/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolPdfLoad.js
 * The single front door for turning bytes into a PDF document.
 *
 * Two rules are enforced here rather than at each call site, because they are
 * the two ways a court bundle can be silently wrong:
 *
 *   ENCRYPTED: never `ignoreEncryption: true`. pdf-lib will happily "load" an
 *   encrypted document with that flag set and then hand back pages whose
 *   content streams are still ciphertext, which render blank. A blank page in a
 *   bundle is worse than a failed bundle: it is filed, served and relied on
 *   before anyone notices. Encrypted input is refused outright.
 *
 *   DAMAGED: refusing outright is also wrong. A damaged PDF is sometimes the
 *   only surviving copy of a document, and a tool that says "no" destroys the
 *   only route to its contents. So damage is recovered where it can be, and
 *   then *disclosed*: the caller is told exactly what came back and must
 *   confirm before it goes in the bundle.
 *
 * What "damaged" can actually be detected, and what cannot:
 *
 *   - A file needing the tolerant parser to load at all. Detected.
 *   - Pages whose content stream is missing or unresolvable: the page exists,
 *     the ink does not. Detected, and worth detecting: pdf-lib reports these as
 *     perfectly ordinary pages. On a fixture with content streams deleted,
 *     pdf-lib returns 7 pages and no error while poppler shows 3 of them
 *     empty.
 *   - The page tree declaring a different count from the pages actually found.
 *     Detected.
 *   - Pages the damaged file does not reference at all, because the cross-reference
 *     table that named them is the damaged part. NOT detectable. This is why
 *     the disclosure wording says "may be incomplete" and never invents a
 *     denominator: with a destroyed xref there is nothing left to count.
 */

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFStream, EncryptedPDFError } from './bundletoolPdfLib.js';

/** Thrown when the input is password-protected and no supplied password opened it. */
export class EncryptedPdfError extends Error {
  constructor(message) {
    super(message ?? ENCRYPTED_PDF_MESSAGE);
    this.name = 'EncryptedPdfError';
    this.userMessage = message ?? ENCRYPTED_PDF_MESSAGE;
  }
}

/** Thrown when the input cannot be read at all, even by the tolerant parser. */
export class UnreadablePdfError extends Error {
  constructor(message, cause) {
    super(message ?? UNREADABLE_PDF_MESSAGE);
    this.name = 'UnreadablePdfError';
    this.userMessage = UNREADABLE_PDF_MESSAGE;
    this.cause = cause;
  }
}

export const ENCRYPTED_PDF_MESSAGE =
  'This PDF is password-protected. Enter its password and BundleTool will '
  + 'unlock it on your device; nothing is uploaded anywhere.';

export const WRONG_PASSWORD_MESSAGE =
  'That password did not open the file. Check it and try again.';

export const UNREADABLE_PDF_MESSAGE =
  'This file could not be read as a PDF, even allowing for damage. '
  + 'It may not be a PDF at all, or it may be too badly damaged to recover. '
  + 'If it is the only copy you have, try opening it in a PDF reader and printing it to a new PDF.';

const STRICT_OPTIONS   = { throwOnInvalidObject: true,  updateMetadata: false };
const TOLERANT_OPTIONS = { throwOnInvalidObject: false, updateMetadata: false };

/**
 * True if the raw bytes carry an /Encrypt entry.
 *
 * Needed because the error pdf-lib raises for an encrypted file depends on how
 * far parsing got: the tolerant parser raises EncryptedPDFError, but the strict
 * parser usually trips over the ciphertext first and raises a generic parse
 * error instead. Without this check an encrypted file that fails both parses
 * would be misreported as merely damaged, and offered for partial recovery:
 * which is the blank-page failure this module exists to prevent.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function looksEncrypted(bytes) {
  // /Encrypt lives in the trailer, at the end of the file. Scan the tail as
  // latin1 so byte values survive unchanged, and cap the window so a large
  // file does not pay for a full-document string conversion.
  const window = bytes.subarray(Math.max(0, bytes.length - 8192));
  let tail = '';
  for (let i = 0; i < window.length; i++) tail += String.fromCharCode(window[i]);
  return /\/Encrypt\b/.test(tail);
}

/**
 * Counts pages whose content stream is missing or does not resolve to a stream.
 *
 * /Contents is either one stream reference or an array of them. A page can hold
 * a perfectly well-formed dictionary while the stream it names has been lost,
 * and that page renders blank with no error anywhere.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {number}
 */
export function countPagesMissingContent(doc) {
  let missing = 0;
  for (const page of doc.getPages()) {
    let node;
    try { node = page.node; } catch { missing++; continue; }
    if (!node) { missing++; continue; }

    const contents = node.get(PDFName.of('Contents'));
    if (!contents) { missing++; continue; }

    let resolved;
    try { resolved = doc.context.lookup(contents); } catch { missing++; continue; }

    if (resolved instanceof PDFArray) {
      // An array of stream refs. Real ink needs at least one to resolve.
      let anyStream = false;
      for (let i = 0; i < resolved.size(); i++) {
        let el;
        try { el = doc.context.lookup(resolved.get(i)); } catch { continue; }
        if (el instanceof PDFStream) { anyStream = true; break; }
      }
      if (!anyStream) missing++;
    } else if (!(resolved instanceof PDFStream)) {
      missing++;
    }
  }
  return missing;
}

/**
 * Reads the page count the document's own page tree declares, if it is readable.
 * This is the file's claim, not a measurement: treat it as such.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {number|null}
 */
export function declaredPageCount(doc) {
  try {
    const pagesRef = doc.catalog.get(PDFName.of('Pages'));
    const pagesDict = doc.context.lookup(pagesRef);
    const count = pagesDict?.get(PDFName.of('Count'));
    const n = count?.asNumber?.();
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} LoadResult
 * @property {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @property {boolean} damaged        - true if anything below is off
 * @property {boolean} neededRecovery - true if the strict parser refused it
 * @property {number}  pageCount      - pages actually recovered
 * @property {number|null} declaredPageCount - what the file's page tree claims
 * @property {number}  pagesMissingContent
 * @property {string|null} disclosure - user-facing sentence, or null when clean
 */

/**
 * Decrypts a password-protected PDF with the password its owner supplied.
 *
 * This is NOT ignoreEncryption: the ciphertext is genuinely decrypted (the
 * engine supports standard-security passwords), and the returned bytes are a
 * decrypted re-save that the rest of the pipeline can treat as an ordinary
 * PDF. The result carries real ink, not blank ciphertext pages: the blank-page
 * failure is the whole reason this module gates encryption.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {string} password
 * @returns {Promise<Uint8Array>} decrypted bytes
 * @throws {EncryptedPdfError} when the password does not open the file
 */
export async function unlockPdf(input, password) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ...TOLERANT_OPTIONS, password });
  } catch {
    throw new EncryptedPdfError(WRONG_PASSWORD_MESSAGE);
  }
  // The decrypted content is plaintext on save, but the trailer still carries
  // its stale /Encrypt reference, which makes the re-save LOOK encrypted to
  // looksEncrypted() (and to some strict readers). Drop it: the saved file is
  // not encrypted and must not claim to be.
  if (doc.context?.trailerInfo?.Encrypt) delete doc.context.trailerInfo.Encrypt;
  dropObjectStreams(doc);
  return doc.save();
}

/**
 * Removes the document's own object streams and cross-reference streams from memory, so that a file
 * saved from it holds each object once.
 *
 * pdf-lib expands every object stream into ordinary objects when it loads a file, but keeps the
 * object stream itself and writes it out again unchanged on save, next to the new copies. A reader
 * that follows the cross-reference table takes the new copy, so the file looks right in a viewer.
 * pdf-lib reads a file by scanning it, though, and lets the stale copy inside the original object stream
 * win. Without this, anything saved by this tool and loaded again (the OCR step's output going into
 * the build, above all) would come back as the original pages, without what had been added to them.
 * The objects inside each stream are already loaded, so dropping the streams loses nothing.
 *
 * A file already written with stale copies cannot be repaired here: the loader reads it as the
 * original. Running OCR on it again rewrites it cleanly.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} doc
 * @returns {number} how many streams were dropped
 */
export function dropObjectStreams(doc) {
  const stale = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj?.dict;
    if (!(dict instanceof PDFDict)) continue;
    const type = dict.get(PDFName.of('Type'));
    if (type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) stale.push(ref);
  }
  for (const ref of stale) doc.context.delete(ref);
  return stale.length;
}

/**
 * Loads a PDF, refusing encryption and disclosing damage.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<LoadResult>}
 * @throws {EncryptedPdfError} if the document is encrypted
 * @throws {UnreadablePdfError} if it cannot be parsed at all
 */
export async function loadPdf(input, _unlockDepth = 0) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Tries the blank user password before refusing. Owner-password-only files
  // (court seals, "no editing" exports) have a BLANK user password and every
  // ordinary viewer opens them without asking; so does this. It is a real
  // decryption with the (empty) user password, never ignoreEncryption. The
  // depth guard turns any decrypt-loop bug into a refusal instead of a hang.
  const refuseOrUnlock = async () => {
    if (_unlockDepth >= 1) throw new EncryptedPdfError();
    let unlocked;
    try {
      unlocked = await unlockPdf(bytes, '');
    } catch {
      throw new EncryptedPdfError();
    }
    return loadPdf(unlocked, _unlockDepth + 1);
  };

  let doc = null;
  let neededRecovery = false;
  let strictError = null;

  try {
    // NOTE: ignoreEncryption is deliberately never passed. See the file header.
    doc = await PDFDocument.load(bytes, STRICT_OPTIONS);
  } catch (err) {
    if (err instanceof EncryptedPDFError) return refuseOrUnlock();
    strictError = err;
  }

  if (!doc) {
    try {
      doc = await PDFDocument.load(bytes, TOLERANT_OPTIONS);
      neededRecovery = true;
    } catch (err) {
      if (err instanceof EncryptedPDFError) return refuseOrUnlock();
      // The strict parser usually trips over ciphertext with a generic parse
      // error before reaching the encryption dictionary, so an unparseable
      // file that carries /Encrypt in its trailer is classified as encrypted,
      // not merely damaged: offering partial recovery of ciphertext is the
      // blank-page failure this module exists to prevent.
      if (looksEncrypted(bytes)) return refuseOrUnlock();
      throw new UnreadablePdfError(undefined, err ?? strictError);
    }
  }

  dropObjectStreams(doc);

  const pageCount = doc.getPageCount();
  const declared = declaredPageCount(doc);
  const pagesMissingContent = countPagesMissingContent(doc);

  const countMismatch = declared != null && declared !== pageCount;
  const damaged = neededRecovery || countMismatch || pagesMissingContent > 0;

  return {
    doc,
    damaged,
    neededRecovery,
    pageCount,
    declaredPageCount: declared,
    pagesMissingContent,
    disclosure: damaged ? describeDamage({ pageCount, declared, pagesMissingContent, countMismatch }) : null,
  };
}

/**
 * Builds the sentence the user is shown for a damaged file.
 *
 * Deliberately does not invent a denominator. "Recovered 4 of 7 pages" is only
 * ever said when the file itself still records 7; where the cross-reference
 * table is the damaged part there is no way to know how many pages there were,
 * and claiming otherwise in a court bundle is worse than saying less.
 *
 * @returns {string}
 */
function describeDamage({ pageCount, declared, pagesMissingContent, countMismatch }) {
  const pages = `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  let msg = `Recovered ${pages}; the file is damaged and may be incomplete.`;

  if (countMismatch) {
    msg += ` The file's own page index records ${declared} page${declared === 1 ? '' : 's'},`
         + ` so ${declared > pageCount ? 'some pages appear to be missing' : 'the index disagrees with what was recovered'}.`;
  }
  if (pagesMissingContent > 0) {
    // "1 of the recovered pages lost its content": the plural belongs to the
    // set being counted from, not to the count.
    msg += ` ${pagesMissingContent} of the recovered pages`
         + ` lost ${pagesMissingContent === 1 ? 'its' : 'their'} content and will appear blank.`;
  }
  msg += ' Please check it against the original before including it.';
  return msg;
}
