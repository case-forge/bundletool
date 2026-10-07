/**
 * BundleTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolMerge.js
 * Merging source documents into one bundle.
 *
 * Pages are copied with pdf-lib's copyPages. Each source document is opened,
 * copied into the destination, and dropped before the next one is opened, so
 * peak memory stays at roughly (destination + one source) rather than every
 * source at once. On a 300-document bundle that is the difference between
 * working and not.
 *
 * Blank pages for printable mode are added directly to the destination rather
 * than built as a one-page PDF and merged in.
 */

import { PDFDocument } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import { pageDimensions } from './bundletoolPageSize.js';
import { copyDocumentPages } from './bundletoolPdfSafety.js';
import { startWorker, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';

/**
 * Copies every page of a source document into the destination.
 *
 * @param {import('./bundletoolPdfLib.js').PDFDocument} dst
 * @param {import('./bundletoolPdfLib.js').PDFDocument} src
 * @returns {Promise<number>} number of pages copied
 */
export async function copyAllPages(dst, src) {
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const page of pages) dst.addPage(page);
  return pages.length;
}

/**
 * Merges the source PDFs in index order.
 *
 * @param {Array<{filename: string, buffer: ArrayBuffer|Uint8Array}>} fileEntries
 * @param {boolean} printable - append a blank page after any odd-length document
 * @returns {Promise<Uint8Array>}
 */
export async function mergeFileEntries(fileEntries, printable, pageSizeKey) {
  if (!fileEntries?.length) throw new Error('No documents to merge');

  const dst = await PDFDocument.create();

  for (const { filename, buffer } of fileEntries) {
    const { doc: src, damaged } = await loadPdf(buffer);
    if (damaged) {
      // Already disclosed and confirmed when the file was added; recorded here
      // so a support log shows which document it was.
      console.warn('[merge] a document was recovered from a damaged file');
    }
    const pageCount = await copyDocumentPages(dst, src);
    // The blank follows the BUNDLE's page size, not the document it pads:
    // a printable bundle is read as a physical stack, and a short blank in
    // the middle of it is worse than no blank at all.
    if (printable && pageCount % 2 === 1) dst.addPage(pageDimensions(pageSizeKey));
  }

  return dst.save();
}

/**
 * Concatenates two PDFs.
 *
 * @param {Uint8Array|ArrayBuffer} pdfAbytes
 * @param {Uint8Array|ArrayBuffer} pdfBbytes
 * @returns {Promise<Uint8Array>}
 */
export async function mergeTwoPdfs(pdfAbytes, pdfBbytes) {
  const { doc: dst } = await loadPdf(pdfAbytes);
  const { doc: src } = await loadPdf(pdfBbytes);
  await copyAllPages(dst, src);
  return dst.save();
}

// --- worker-based version ---
//
// Spawns a worker, transfers the data in, and terminates the worker on
// completion so its heap is released rather than accumulating on the main
// thread. The full-bundle merge runs inside the single-pass build
// (bundletoolBuild.js); mergeTwoPdfs here serves the small index-preview path.

const WORKER_URL = new URL('./workers/bundletoolMergeWorker.js', import.meta.url);

/** Worker peak readings from the most recent run, keyed by op name. */
export const workerPeaks = {};

/**
 * Runs mergeTwoPdfs inside a dedicated worker. Both inputs are transferred;
 * the caller must not use the original Uint8Arrays afterwards.
 *
 * @param {Uint8Array} pdfAbytes
 * @param {Uint8Array} pdfBbytes
 * @returns {Promise<Uint8Array>}
 */
export function mergeTwoPdfsViaWorker(pdfAbytes, pdfBbytes) {
  const own = (u8) => (u8.buffer.byteLength === u8.byteLength ? u8.buffer : u8.slice().buffer);
  const bufA = own(pdfAbytes);
  const bufB = own(pdfBbytes);
  return runWorkerOp({ op: 'mergeTwoPdfs', bufA, bufB }, [bufA, bufB]);
}

/**
 * Spawns a merge worker, posts the work once it signals ready, and terminates
 * it on the first non-ready message.
 */
function runWorkerOp(message, transferables) {
  return new Promise((resolve, reject) => {
    const worker = startWorker(WORKER_URL, { type: 'module' });
    watchForLazyLoadFailures(worker);

    worker.onmessage = (e) => {
      if (e.data?.ready) {
        worker.postMessage(message, transferables);
        return;
      }
      // Not this handler's message: watchForLazyLoadFailures() (attached above) has already turned it
      // into the reload toast. Only a worker's own failure (an {error} reply, below) ends the op;
      // treating this one as the final (empty) result would terminate the worker before its real reply
      // (the error the lazy-load failure itself is about to cause) arrives.
      if (e.data?.type === 'lazy-load-failed') return;
      worker.terminate();
      if (e.data?.workerPeakMB != null) workerPeaks[message.op] = e.data.workerPeakMB;
      if (e.data?.error) {
        const err = new Error(e.data.error);
        if (e.data.stack) err.stack = e.data.stack;
        reject(err);
      } else resolve(e.data.result);
    };

    worker.onerror = (e) => {
      console.error('[MergeWorker] onerror:', e.message, e);
      worker.terminate();
      reject(new Error(e.message ?? 'Worker error'));
    };

    worker.addEventListener('messageerror', (e) => {
      console.error('[MergeWorker] messageerror:', e);
      worker.terminate();
      reject(new Error('Worker messageerror'));
    });
  });
}
