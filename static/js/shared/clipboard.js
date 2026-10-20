/* window.cfCopy(text[, box]) -> Promise<boolean>: copy text to the clipboard.
 *
 * navigator.clipboard only exists on https or localhost, so on a plain-http
 * address it is undefined; then the document.execCommand('copy') route is
 * used on a text box. Pass `box` (an input or textarea already showing the
 * text) to copy from it, otherwise a hidden one is made. Resolves false if
 * both routes are blocked, so the caller can tell the person to copy by hand.
 */
(function () {
  window.cfCopy = function (text, box) {
    return new Promise(function (resolve) {
      function legacy() {
        var ok = false, tmp = null;
        try {
          var el = box;
          if (!el) {
            tmp = el = document.createElement('textarea');
            el.value = text;
            el.setAttribute('readonly', '');
            el.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            // Inside an open modal dialog everything outside it is inert.
            (document.querySelector('dialog[open]') || document.body).appendChild(el);
          }
          el.focus();
          el.select();
          ok = document.execCommand('copy');
        } catch (e) { ok = false; }
        if (tmp) tmp.remove();
        resolve(ok);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, legacy);
      } else {
        legacy();
      }
    });
  };
})();
