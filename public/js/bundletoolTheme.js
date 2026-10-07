/**
 * Theme toggle.
 * The same data-theme and localStorage pattern as Chambers Finder's theme
 * scripts: three states (auto, light, dark) set through .theme-btn elements
 * with a data-t attribute, and persisted under BundleTool's own key so it
 * never collides with Chambers Finder's storage if both are open in the same
 * browser profile. The favicon and theme-colour swap follows Chambers
 * Finder's window.cfSetBrowserUI.
 *
 * Exported as window.bundletoolApplyTheme. bundletoolPrepaint.js repeats the
 * same logic on purpose, because it has to run before the first paint.
 */
(function () {
  // STORAGE KEY: DO NOT RENAME. This names data already sitting in users'
  // browsers. Renaming it does not migrate the value, it abandons it: everyone
  // who has chosen light or dark silently reverts to auto on their next visit.
  // The same applies to every other 'buntool'-prefixed storage key in this
  // codebase: the source files are named bundletool*, and the keys
  // deliberately keep their names.
  var OWN_KEY = 'buntool_theme';

  // The shared cf_theme is the default, and cf_theme_locked opts OUT into
  // BundleTool's own independent theme. A browser with no explicit choice
  // yet, but an existing buntool_theme value, is treated as locked: the
  // point is to preserve a preference someone already made, not silently
  // merge it into the shared theme.
  function themeKey() {
    var locked;
    try { locked = localStorage.getItem('cf_theme_locked'); } catch (e) {}
    if (locked === 'true') return OWN_KEY;
    if (locked === 'false') return 'cf_theme';
    var existing;
    try { existing = localStorage.getItem(OWN_KEY); } catch (e) {}
    return existing ? OWN_KEY : 'cf_theme';
  }

  // Favicon lock: the same idea as the theme lock, but its own flag, so a
  // visitor can lock the icon without locking the theme itself. Locked
  // freezes the icon at whatever colour it showed the moment it was locked
  // (cf_favicon_frozen, written by home-settings.js when the toggle is
  // switched on).
  function faviconMode(pageMode) {
    var locked;
    try { locked = localStorage.getItem('cf_favicon_locked'); } catch (e) {}
    if (locked !== 'true') return pageMode;
    var frozen;
    try { frozen = localStorage.getItem('cf_favicon_frozen'); } catch (e) {}
    return (frozen === 'light' || frozen === 'dark') ? frozen : pageMode;
  }

  function setBrowserUI(mode) {
    var favMode = faviconMode(mode);
    var link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    if (link) {
      var next = favMode === 'dark' ? link.dataset.dark : link.dataset.light;
      if (next && link.href.indexOf(next) === -1) link.href = next;
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    var palette = document.documentElement.getAttribute('data-palette');
    if (meta) meta.content = palette === 'classic'
      ? (mode === 'dark' ? '#020617' : '#f5f5f4')
      : (mode === 'dark' ? '#0e1014' : '#f0ebe1');
  }

  function apply(pref) {
    var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var mode = pref === 'auto' ? (systemDark ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.dataset.themePref = pref;
    setBrowserUI(mode);
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      var active = b.dataset.t === pref;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  window.bundletoolApplyTheme = apply;

  // Every storage access is guarded: with site data blocked the theme still works for this page load,
  // it just is not remembered.
  function readPref() {
    try { return localStorage.getItem(themeKey()) || 'auto'; } catch (e) { return 'auto'; }
  }
  function writePref(value) {
    try { localStorage.setItem(themeKey(), value); } catch (e) { /* not remembered */ }
  }

  document.addEventListener('DOMContentLoaded', function () {
    apply(readPref());
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        writePref(b.dataset.t);
        apply(b.dataset.t);
      });
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (readPref() === 'auto') apply('auto');
  });
})();
