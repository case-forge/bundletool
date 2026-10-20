/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolBuild.js
 * The single-pass bundle build: cover, index and documents merged, numbered
 * and given their metadata in ONE PDFDocument, serialised ONCE.
 *
 * Every stage works on the same in-memory document, so the only parses are
 * one per SOURCE document (unavoidable: they arrive as bytes) and the only
 * serialise is the final save. A separate stage per step (source merge, index,
 * cover, footer, metadata), each parsing the entire document and writing it
 * back out, would cost five full parse and serialise cycles of the whole
 * bundle: on a 200-page, 29 MB bundle, most of a 7.8 s build.
 *
 * The merge keeps the memory discipline of bundletoolMerge.js: each source is
 * opened, copied in, and dropped before the next is opened, so peak memory
 * stays at roughly (destination + one source).
 *
 * buildBundlePdf() is the direct path (the tests run it; it is the shipped
 * logic, not a test double). runBuildViaWorker() runs it in a dedicated
 * worker that is terminated on completion.
 */

import { PDFDocument } from './bundletoolPdfLib.js';
import { loadPdf } from './bundletoolPdfLoad.js';
import { copyAllPages } from './bundletoolMerge.js';
import { copyDocumentPages } from './bundletoolPdfSafety.js';
import { pageDimensions } from './bundletoolPageSize.js';
import { applyPageNumberingToDoc } from './bundletoolPages.js';
import { applyMetaToDoc } from './bundletoolMeta.js';
import { startWorker, watchForLazyLoadFailures } from '/js/shared/lazy-load.js';

/**
 * Builds the finished bundle in one pass.
 *
 * @param {Object} job
 * @param {Uint8Array|ArrayBuffer|null} job.coverBytes - one-page cover, already validated/generated
 * @param {Uint8Array|ArrayBuffer} job.tocBytes - the index pages
 * @param {Array<{filename: string, buffer: ArrayBuffer|Uint8Array}>} job.fileEntries - sources, index order
 * @param {boolean} job.printable - blank page after any odd-length document
 * @param {string} job.pageSize - page size key for the pages this tool draws
 * @param {Object} job.footerConfig - flat footer config values
 * @param {Array<string>} job.pageLabels - sparse per-page section labels
 * @param {number|null} job.footerLinkPageIndex - footer link target, null for none
 * @param {number} job.frontMatterCount - cover + index pages, for roman/skip numbering
 * @param {Object} job.metaConfig - flat meta config values
 * @param {Array<Object>} job.tocTableRowCoordinates
 * @param {Array<Object>} job.tocEntries
 * @param {boolean} [job.yieldToUi] - serialise in yielding chunks; only for a
 *   caller running this on the main thread. The worker path leaves it false.
 * @param {(label: string) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function buildBundlePdf(job, onProgress) {
  const {
    coverBytes = null, tocBytes, fileEntries, printable = false, pageSize = 'a4',
    footerConfig, pageLabels = [], footerLinkPageIndex = null, frontMatterCount = 0,
    metaConfig, tocTableRowCoordinates, tocEntries, yieldToUi = false,
  } = job;

  if (!fileEntries?.length) throw new Error('No documents to merge');

  onProgress?.('Merging documents…');
  const dst = await PDFDocument.create();

  // Front matter first, so the physical page order is cover, index,
  // documents: the property every page offset in the pipeline depends on.
  if (coverBytes) {
    const { doc } = await loadPdf(coverBytes);
    await copyAllPages(dst, doc);
  }
  {
    const { doc } = await loadPdf(tocBytes);
    await copyAllPages(dst, doc);
  }

  // Pages added by printable mode: each is marked as BundleTool's own blank, so nobody reads it as
  // part of the document before it.
  const paddingPages = [];
  for (const { filename, buffer } of fileEntries) {
    const { doc: src, damaged } = await loadPdf(buffer);
    if (damaged) {
      // Already disclosed and confirmed when the file was added; recorded here
      // so a support log shows which document it was.
      console.warn('[build] a document was recovered from a damaged file');
    }
    // A user document: cleaned of scripts, attachments and dead links first (bundletoolPdfSafety.js).
    const pageCount = await copyDocumentPages(dst, src);
    if (printable && pageCount % 2 === 1) {
      dst.addPage(pageDimensions(pageSize));
      paddingPages.push(dst.getPageCount() - 1);
    }
  }
  // The progress track lists this step, so it is reported here even though
  // the index is already merged in above.
  onProgress?.('Merging index with documents…');

  onProgress?.('Adding page numbering…');
  await applyPageNumberingToDoc(dst, footerConfig, pageLabels, footerLinkPageIndex, frontMatterCount, { paddingPages });

  onProgress?.('Adding hyperlinks…');
  applyMetaToDoc(dst, tocTableRowCoordinates, tocEntries, metaConfig, onProgress);

  // objectsPerTick: Infinity. pdf-lib's save() yields to the event loop every
  // 50 objects so a page stays responsive while it serialises. That is the
  // right default in a page and pure overhead in a dedicated worker, where
  // there is nothing to keep responsive and the thread is terminated the
  // moment this returns.
  //
  // On a 30-document, 237-page bundle it takes the save from 928 ms to 250 ms;
  // with yielding, the save is by some distance the largest stage of the build
  // (57% of 2.37 s). The bytes are the same: saving the SAME document object
  // both ways gives an identical sha256, because the option governs only when
  // it pauses, not what it writes.
  //
  // yieldToUi is for a caller that runs this on the main thread. The page uses
  // runBuildViaWorker below, so the default is the fast one.
  return dst.save(yieldToUi ? undefined : { objectsPerTick: Infinity });
}

// --- worker-based version ---

const BUILD_WORKER_URL = new URL('./workers/bundletoolBuildWorker.js', import.meta.url);

/** Worker peak reading from the most recent build worker run. */
export const buildWorkerPeaks = {};

/**
 * Runs buildBundlePdf inside a dedicated worker, terminated on completion so
 * its heap goes back to the browser. Cover/TOC/source buffers are
 * TRANSFERRED; callers must not reuse them (the frontend's File objects are
 * unaffected: .arrayBuffer() hands over a copy).
 *
 * @param {Object} job - as buildBundlePdf, buffers as ArrayBuffers
 * @param {(label: string) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export function runBuildViaWorker(job, onProgress) {
  const own = (bytes) => {
    if (bytes == null) return null;
    if (bytes instanceof ArrayBuffer) return bytes;
    return bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
  };

  const message = {
    ...job,
    coverBytes: own(job.coverBytes),
    tocBytes: own(job.tocBytes),
  };
  const transferables = [];
  if (message.coverBytes) transferables.push(message.coverBytes);
  transferables.push(message.tocBytes);
  for (const entry of message.fileEntries) transferables.push(entry.buffer);

  return new Promise((resolve, reject) => {
    const worker = startWorker(BUILD_WORKER_URL, { type: 'module' });
    watchForLazyLoadFailures(worker);

    worker.onmessage = (e) => {
      if (e.data?.ready) {
        worker.postMessage(message, transferables);
        return;
      }
      if (e.data?.progress) { onProgress?.(e.data.progress); return; }
      // Not this handler's message: watchForLazyLoadFailures() (attached above) already turned it into
      // the reload toast. Only a worker's own genuine failure (an {error} reply, below) ends the build;
      // this one is not that, and treating it as the final (empty) result would terminate the worker
      // before its real reply (the error the lazy-load failure itself is about to cause) arrives.
      if (e.data?.type === 'lazy-load-failed') return;
      worker.terminate();
      if (e.data?.workerPeakMB != null) buildWorkerPeaks.build = e.data.workerPeakMB;
      if (e.data?.error) {
        const err = new Error(e.data.error);
        if (e.data.stack) err.stack = e.data.stack;
        reject(err);
      } else resolve(e.data.result);
    };

    worker.onerror = (e) => {
      console.error('[BuildWorker] onerror:', e.message, e);
      worker.terminate();
      reject(new Error(e.message ?? 'Worker error'));
    };

    worker.addEventListener('messageerror', (e) => {
      console.error('[BuildWorker] messageerror:', e);
      worker.terminate();
      reject(new Error('Worker messageerror'));
    });
  });
}
