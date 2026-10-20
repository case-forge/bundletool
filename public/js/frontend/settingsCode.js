/**
 * settingsCode.js
 * Advanced Settings as text: the BT1./BT2. codes behind the Share button's link and QR code.
 *
 * BT1. + base64url(JSON of the settings that differ from the factory defaults). BT2. is the same,
 * gzipped with the browser's CompressionStream (shorter, so a scannable QR). BT1. is still decoded,
 * for links made in that format, and is the encoder's fallback where CompressionStream is missing. A
 * new format takes a new prefix rather than changing an existing one.
 *
 * A code comes from anyone who can send a link, so decoding is strict: anything that is not a
 * well-formed code throws SettingsCodeError with a message for the person, and what is decoded
 * goes through sanitiseConfig() so it only ever holds values the build accepts. Nothing here
 * touches the page (the template applies the result), so it is unit tested.
 */
import { sanitiseConfig, DEFAULTS_KEYS } from './configSanitise.js';

export const CODE_PREFIX_V1 = 'BT1.';
export const CODE_PREFIX_V2 = 'BT2.';
// A settings object is a few hundred characters; this only stops a link built to exhaust memory.
const MAX_CODE_LENGTH = 20_000;
const MAX_JSON_LENGTH = 50_000;

export class SettingsCodeError extends Error {
  constructor(message) { super(message); this.name = 'SettingsCodeError'; }
}

export function isSettingsCode(value) {
  return typeof value === 'string' && (value.startsWith(CODE_PREFIX_V1) || value.startsWith(CODE_PREFIX_V2));
}

const toBase64Url = (bytes) => {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function fromBase64Url(b64url) {
  if (!/^[A-Za-z0-9_-]*$/.test(b64url)) throw new SettingsCodeError('That settings code is not readable.');
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new SettingsCodeError('That settings code is not readable.');
  }
}

/** @param {object} diff  the settings that differ from factory */
export async function encodeSettingsCode(diff) {
  const json = JSON.stringify(diff);
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      return CODE_PREFIX_V2 + toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
    } catch { /* fall through to the uncompressed shape */ }
  }
  return CODE_PREFIX_V1 + toBase64Url(new TextEncoder().encode(json));
}

/**
 * @param {unknown} raw
 * @returns {Promise<object>} the settings in the code, cleaned: known keys, valid values only
 * @throws {SettingsCodeError}
 */
export async function decodeSettingsCode(raw) {
  const code = String(raw ?? '').trim();
  if (!isSettingsCode(code)) throw new SettingsCodeError('That is not a BundleTool settings code.');
  if (code.length > MAX_CODE_LENGTH) throw new SettingsCodeError('That settings code is too long to be one of ours.');
  let json;
  try {
    if (code.startsWith(CODE_PREFIX_V2)) {
      const bytes = fromBase64Url(code.slice(CODE_PREFIX_V2.length));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      // Read with a ceiling: a small code can gzip to something enormous.
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_JSON_LENGTH) { await reader.cancel(); throw new SettingsCodeError('That settings code is too long to be one of ours.'); }
        chunks.push(value);
      }
      json = await new Blob(chunks).text();
    } else {
      json = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(code.slice(CODE_PREFIX_V1.length)));
    }
  } catch (err) {
    if (err instanceof SettingsCodeError) throw err;
    throw new SettingsCodeError('That settings code is not readable.');
  }
  if (json.length > MAX_JSON_LENGTH) throw new SettingsCodeError('That settings code is too long to be one of ours.');
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new SettingsCodeError('That settings code is not readable.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsCodeError('That settings code is not readable.');
  return sanitiseConfig(parsed, { only: DEFAULTS_KEYS });
}
