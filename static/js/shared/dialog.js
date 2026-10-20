/* Shared dialog behaviour for every hand-made modal on the site (BundleTool's dialogs, the Envelope
 * Guide history window, the home Settings window, the tutorial card). One place, so they all act the
 * same way for a keyboard or screen-reader user:
 *   - when a dialog opens, focus moves into it (an element marked data-autofocus, else the first
 *     control, else the dialog itself), unless the page has already put it there;
 *   - Tab and Shift+Tab stay inside the topmost open dialog;
 *   - when it closes, focus goes back to whatever opened it, or to its data-return-focus selector
 *     when that control has gone (a menu item in a menu that has since closed).
 * Escape is left to each page, which knows what dismissing its dialogs should mean.
 * Native <dialog> elements (Chambers Finder's share window) already do all of this and are ignored.
 *
 *   cfDialog.watch(el)          follow an element whose visibility is toggled with `hidden` or the
 *                               `hidden` class (all [role="dialog"] elements are watched on load)
 *   cfDialog.activate(el, opts) explicit open for a dialog that is added and removed (the tutorial):
 *                               opts.opener, opts.fallback (selector), opts.initialFocus (element)
 *   cfDialog.deactivate(el)     explicit close
 */
(function () {
  'use strict';
  var stack = [];          // open dialogs, topmost last: { el, opener, fallback }
  var lastOutside = null;  // the last control focused outside any open dialog: the opener

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function shown(el) {
    if (!el || el.hidden) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  }
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), shown);
  }
  function isOpen(el) {
    return !el.hidden && !el.classList.contains('hidden');
  }
  function entryFor(el) {
    for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return stack[i];
    return null;
  }

  document.addEventListener('focusin', function (e) {
    for (var i = 0; i < stack.length; i++) if (stack[i].el.contains(e.target)) return;
    lastOutside = e.target;
  }, true);

  function activate(el, opts) {
    if (!el || entryFor(el)) return;
    opts = opts || {};
    var here = document.activeElement;
    // Normally the control that was just used to open this dialog; for one opened from inside
    // another dialog that is a control in the first, so closing returns there.
    var opener = opts.opener || (here && here !== document.body && !el.contains(here) ? here : lastOutside);
    stack.push({ el: el, opener: opener, fallback: opts.fallback || el.getAttribute('data-return-focus') });
    if (el.contains(document.activeElement) && document.activeElement !== el) return;
    var target = opts.initialFocus || el.querySelector('[data-autofocus]') || focusables(el)[0];
    if (!target) { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); target = el; }
    target.focus({ preventScroll: true });
  }

  function deactivate(el) {
    var entry = entryFor(el);
    if (!entry) return;
    stack.splice(stack.indexOf(entry), 1);
    var active = document.activeElement;
    // Only move focus if it is still in the dialog (or nowhere): a caller that has already sent
    // it somewhere on purpose keeps that.
    if (active && active !== document.body && !el.contains(active)) return;
    var back = entry.opener && document.contains(entry.opener) && shown(entry.opener) ? entry.opener : null;
    if (!back && entry.fallback) back = document.querySelector(entry.fallback);
    if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !stack.length) return;
    var top = stack[stack.length - 1].el;
    var items = focusables(top);
    if (!items.length) { e.preventDefault(); top.focus({ preventScroll: true }); return; }
    var first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (!top.contains(active)) { e.preventDefault(); first.focus({ preventScroll: true }); }
    else if (e.shiftKey && (active === first || active === top)) { e.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
  });

  function sync(el) {
    if (isOpen(el)) activate(el); else deactivate(el);
  }
  function watch(el) {
    if (el.__cfDialogWatched) return;
    el.__cfDialogWatched = true;
    new MutationObserver(function () { sync(el); })
      .observe(el, { attributes: true, attributeFilter: ['hidden', 'class'] });
    if (isOpen(el)) sync(el);
  }

  function watchAll() {
    Array.prototype.forEach.call(document.querySelectorAll('[role="dialog"]'), watch);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchAll);
  else watchAll();

  window.cfDialog = { watch: watch, activate: activate, deactivate: deactivate };
})();
