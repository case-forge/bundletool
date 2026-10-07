/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * smallerPhotos.js
 * The browser's side of Smaller photos (config-smallerPhotos, pageOptions.smallerPhotos, on by default): when a
 * bundle is built, every document BundleTool made from a picture (its entry's convertedFromImage) goes into the
 * bundle as a copy with smaller pictures (bundletoolSmallerPhotos.js). The documents held in the Review Table are
 * never changed, so the setting applies to photos added before it was switched, in either direction, and Force OCR
 * and Download keep the full pictures. A PDF the person added is never touched.
 *
 * A copy is made once per held file and kept while that file is held (a WeakMap keyed by the File), so building
 * again costs nothing until the document changes. A document whose copy fails goes in as it is.
 */
import { state } from './state.js';
import { lazyImport } from '/js/shared/lazy-load.js';

const copies = new WeakMap();

/** The setting as it stands in Advanced Settings (on when the control is missing, as by default). */
export function smallerPhotosOn() {
  return document.getElementById('config-smallerPhotos')?.checked ?? true;
}

/** The documents BundleTool made from pictures, by name. */
export function convertedPictures(filesMap) {
  return [...filesMap].filter(([name]) => state.frontendInputData[name]?.convertedFromImage === true);
}

/**
 * The files a bundle is built from: `filesMap` itself when the setting is off or no document was made from a
 * picture, otherwise a new map in the same order with those documents replaced by their smaller copies.
 *
 * @param {Map<string, File>} filesMap
 * @param {{on?: boolean, onProgress?: (label: string) => void, shrink?: (bytes: Uint8Array) => Promise<{bytes: Uint8Array}>}} [opts]
 *   on: the setting (read from the page unless given). shrink: the re-encoding, bundletoolSmallerPhotos.js's
 *   smallerPicturePdf with the browser's codec unless a test passes its own
 * @returns {Promise<Map<string, File>>}
 */
export async function filesForBundle(filesMap, { on = smallerPhotosOn(), onProgress, shrink } = {}) {
  if (!on) return filesMap;
  const pictures = convertedPictures(filesMap);
  if (pictures.length === 0) return filesMap;
  if (!shrink) {
    const { smallerPicturePdf, browserCodec } = await lazyImport(new URL('../bundletoolSmallerPhotos.js', import.meta.url));
    shrink = (bytes) => smallerPicturePdf(bytes, browserCodec);
  }
  const out = new Map(filesMap);
  for (const [i, [name, file]] of pictures.entries()) {
    onProgress?.(`Making photos smaller (${i + 1} of ${pictures.length})…`);
    let copy = copies.get(file);
    if (!copy) {
      copy = (async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await shrink(bytes);
        return result.bytes === bytes ? file : new File([result.bytes], file.name, { type: 'application/pdf' });
      })();
      copies.set(file, copy);
      copy.catch(() => copies.delete(file));
    }
    try {
      out.set(name, await copy);
    } catch (error) {
      console.warn('[smaller photos] a document went into the bundle as it was:', error?.message ?? error);
    }
  }
  return out;
}
