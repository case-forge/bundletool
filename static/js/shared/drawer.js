/* The header menu (#drawer-btn and #drawer-panel): opens on click, closes on an outside click, Escape
 * or a choice. An external file, not inline, so the pages' Content-Security-Policy can forbid inline script. */
(function () {
  var btn = document.getElementById('drawer-btn');
  var panel = document.getElementById('drawer-panel');
  if (!btn || !panel) return;
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function open() { panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (panel.hidden) open(); else close();
  });
  document.addEventListener('click', function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus({ preventScroll: true }); }
  });
  panel.addEventListener('click', function (e) {
    if (e.target.closest('.drawer-item, .drawer-app')) close();
  });
  // Tabbing out of the open menu closes it, so it is never left hanging open behind the page.
  document.addEventListener('focusin', function (e) {
    // Not while BundleTool's tutorial is running: it opens this menu on purpose to point at it.
    if (document.getElementById('tutorial-card')) return;
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) close();
  });
  // Up and Down move between the menu's controls, Home and End jump to the ends.
  panel.addEventListener('keydown', function (e) {
    var keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (keys.indexOf(e.key) < 0) return;
    var items = Array.prototype.filter.call(panel.querySelectorAll('button, a[href]'), function (el) { return el.getClientRects().length > 0; });
    if (!items.length) return;
    var i = items.indexOf(document.activeElement);
    var next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    e.preventDefault();
    items[next].focus({ preventScroll: true });
  });
  // Opening from the keyboard with Down puts focus on the first item.
  btn.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (panel.hidden) open();
    var first = panel.querySelector('button, a[href]');
    if (first) first.focus({ preventScroll: true });
  });
})();
