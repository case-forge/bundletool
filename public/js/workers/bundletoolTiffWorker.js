/**
 * Decodes a TIFF off the main thread, one page at a time.
 *
 * Why a worker: a damaged compressed strip can send the decoder into a loop that never ends (a
 * 23 KB LZW file with a zeroed run did exactly that), and on the main thread that freezes the tab
 * and loses the person's unsaved work. Here the main thread simply gives up after a while and
 * terminates the worker.
 *
 * Protocol. In:  {cmd: 'open', buffer}  then {cmd: 'next'} once per page wanted.
 *               Out: {type: 'pages', count} after the file passes inspection, then
 *                    {type: 'page', index, width, height, grey, rgba} per {cmd: 'next'}
 *                    (rgba is transferred), or {type: 'error', code, message}; code 'load' means the
 *                    TIFF reader itself could not be fetched, not that the file is damaged.
 * One page is decoded per request, so only one page of raw pixels exists at a time.
 */
import { inspectTiff, decodeTiffPage, TiffProblem } from '../bundletoolTiff.js';
import { lazyImport } from '/js/shared/lazy-load.js';

let UTIF = null;
let buffer = null;
let pages = [];
let next = 0;

function fail(error) {
  const known = error instanceof TiffProblem;
  postMessage({
    type: 'error',
    code: known ? error.code : 'damaged',
    message: known ? error.message : 'That TIFF could not be read. It may be damaged.',
  });
}

self.onmessage = async (event) => {
  const { cmd } = event.data;
  try {
    if (cmd === 'open') {
      try {
        ({ default: UTIF } = await lazyImport(new URL('../vendor/utif2.js', import.meta.url)));
      } catch {
        postMessage({ type: 'error', code: 'load', message: 'The TIFF reader could not be loaded. Check your connection and try again.' });
        return;
      }
      buffer = event.data.buffer;
      pages = inspectTiff(UTIF, buffer);
      next = 0;
      postMessage({ type: 'pages', count: pages.length });
    } else if (cmd === 'next') {
      const index = next++;
      const { rgba, width, height, grey, orientation } = decodeTiffPage(UTIF, buffer, pages[index]);
      postMessage({ type: 'page', index, width, height, grey, orientation, rgba }, [rgba.buffer]);
    }
  } catch (error) {
    fail(error);
  }
};
