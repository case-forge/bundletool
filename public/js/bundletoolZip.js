/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolZip.js
 * A minimal zip writer for handing the parts of a split bundle over as one download.
 *
 * Entries are STORED, not deflated: a PDF is already compressed, so deflating it would cost time
 * and save next to nothing. Names are written as UTF-8 (general purpose flag bit 11), so a
 * Welsh or Polish document title survives. Plain zip, no zip64: the split modal never gathers
 * more than a few hundred megabytes, and anything that would not fit the format is refused.
 */

import { crc32 } from './bundletoolCrc32.js';
export { crc32 };

/** MS-DOS date and time words for a Date (local time, 2 second resolution, from 1980). */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/**
 * @param {Array<{name: string, bytes: Uint8Array}>} files  names must be distinct
 * @param {Date} [when]
 * @returns {Uint8Array} the zip file
 */
export function zipStore(files, when = new Date()) {
  if (files.length > MAX_ENTRIES) throw new Error('Too many files for one zip');
  const encoder = new TextEncoder();
  const stamp = dosStamp(when);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;
    if (size > MAX_BYTES || offset > MAX_BYTES) throw new Error('These files are too big for one zip');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0x0800, true);       // UTF-8 names
    local.setUint16(8, 0, true);            // stored
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, file.bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);   // central directory header
    entry.setUint16(4, 20, true);           // version made by
    entry.setUint16(6, 20, true);           // version needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, stamp.time, true);
    entry.setUint16(14, stamp.date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);      // where the local header starts
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  if (offset + centralSize > MAX_BYTES) throw new Error('These files are too big for one zip');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
