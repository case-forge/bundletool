/* CaseForge Settings modal: theme-lock and favicon-lock toggles.
 * Reached from the Settings entry of the header menu (the home page's menu holds only this
 * entry); the settings themselves are read by
 * shared/theme.js (every page but BundleTool) and BundleTool's
 * bundletoolTheme.js and baseof.html pre-paint script.
 *
 * Two plain choices for two things. By default the theme and the favicon
 * are shared everywhere, BundleTool included; turning off "Same theme
 * everywhere" gives BundleTool its own theme, and "Lock favicon" keeps the
 * favicon at its current colour.
 */
(function () {
  var openBtn = document.getElementById('settings-open-btn');
  var closeBtn = document.getElementById('settings-close-btn');
  var overlay = document.getElementById('settings-modal');
  if (!openBtn || !overlay) return;

  // The switch reads the other way round to the stored flag: cf_theme_locked
  // (BundleTool keeps its own light/dark) is true when this switch is OFF. The
  // key is kept as it is so nobody's saved choice changes meaning.
  var themeShared = document.getElementById('settings-theme-shared');
  var faviconLocked = document.getElementById('settings-favicon-locked');

  function getBool(key) {
    var v;
    try { v = localStorage.getItem(key); } catch (e) {}
    return v === 'true';
  }
  function setBool(key, val) {
    try { localStorage.setItem(key, val ? 'true' : 'false'); } catch (e) {}
  }

  function syncControls() {
    themeShared.checked = !getBool('cf_theme_locked');
    faviconLocked.checked = getBool('cf_favicon_locked');
  }

  function open() {
    syncControls();
    overlay.hidden = false;
    // The Settings entry lives in the menu, so shut the menu behind the dialog.
    var panel = document.getElementById('drawer-panel');
    var btn = document.getElementById('drawer-btn');
    if (panel) panel.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    closeBtn.focus({ preventScroll: true });
  }
  function close() {
    overlay.hidden = true;
    // The Settings entry is inside the (now closed) menu, so focus returns to the menu button.
    var menuBtn = document.getElementById('drawer-btn');
    (menuBtn || openBtn).focus({ preventScroll: true });
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  themeShared.addEventListener('change', function () {
    setBool('cf_theme_locked', !themeShared.checked);
    // BundleTool only: re-resolve which key is now authoritative and
    // re-apply immediately, as faviconLocked does below; otherwise the
    // toggle would write the flag but nothing would visibly change until
    // the next full page load.
    if (window.bundletoolRefreshTheme) window.bundletoolRefreshTheme();
  });
  faviconLocked.addEventListener('change', function () {
    if (faviconLocked.checked) {
      // Capture whatever the icon is showing right now as the frozen
      // value, so locking never jumps the colour: it just stops it
      // changing from this point.
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      try { localStorage.setItem('cf_favicon_frozen', current); } catch (e) {}
    }
    setBool('cf_favicon_locked', faviconLocked.checked);
    if (window.cfApplyFavicon) window.cfApplyFavicon();
  });
})();
