/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you
 * may not use this file except in compliance with the License. You may
 * obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolCrc32.js
 * The standard CRC-32 (polynomial 0xEDB88320), used for the zip's local and central
 * directory records (bundletoolZip.js) and to spot a damaged image chunk before it is
 * decoded (bundletoolImageCheck.js). One table and one implementation serve both: crc32()
 * covers the whole array or a byte range of it.
 */
let table = null;

function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 of bytes[start, end), as an unsigned integer. start and end default to the whole array. */
export function crc32(bytes, start = 0, end = bytes.length) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
