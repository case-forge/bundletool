/** The banner in front of static/vendor/matrix-render.js (qrcode-generator's own dist file, copied by build-vendor.mjs). */
export function qrBanner(version) {
  return `/* qrcode-generator@${version} by Kazuhiko Arase - MIT; licence recorded in NOTICE.
 * Vendored, not CDN-loaded: the policy test bans CDN URLs and this tool
 * must keep working offline. UMD wrapper kept intact; a named ESM export
 * is NOT appended: it is loaded with a <script> tag (a dynamic import of a
 * /public path is something Rollup tries to resolve at build time), and an
 * \`export\` statement in a classic script is a parse error. */
`;
}
