/**
 * Icons for markup built in JavaScript: the site's shared Material Symbols
 * (static/js/shared/icons.js, loaded ahead of the app scripts). Returns an
 * inline <svg> string, or nothing where that script is absent (under test).
 */
export function icon(name, cls) {
  return typeof globalThis.cfIcon === 'function' ? globalThis.cfIcon(name, cls) : '';
}
