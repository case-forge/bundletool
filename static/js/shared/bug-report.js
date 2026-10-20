/* One bug reporter for every CaseForge page (Home, Chambers Finder, Envelope Guide,
 * BundleTool, Contact, Privacy). Included by shared/footer.html.
 *
 * It does two jobs.
 *
 * 1. window.cfBugReport.report({ error, title }) is what a page calls from a catch
 *    block when something it did not expect fails (a library that will not load, a
 *    PDF that will not render). It builds the same report BundleTool's error box
 *    does, leaves it for the contact form, and shows a small "Report this" notice.
 * 2. A detector for what nobody caught: an uncaught error or an unhandled promise
 *    rejection from one of OUR scripts (same origin) raises the same notice, once per
 *    page. Errors from browser extensions, other origins and the harmless
 *    "ResizeObserver loop" message are ignored, so the notice means something, and
 *    nothing is raised while the "reload to continue" notice is up.
 *
 * The contact form this would prefill is on another origin, not in this repository: the
 * toast's link opens it empty. The error modal elsewhere on this page has its own Copy
 * details button, which still works.
 *
 * What it cannot find: a page that works but looks or behaves wrongly. That needs a
 * person to say so, through the contact form.
 *
 * Error codes: a product that names its errors (BundleTool BT-, Envelope Guide EG-,
 * Chambers Finder CF-, each in its own registry) passes `code`, and the report opens
 * with it and the notice shows it. An uncaught error takes the page's own code from
 * <meta name="cf-error-page">. Only a value shaped like a code is ever written, so
 * nothing else (a file name, a message) can travel in that field.
 */
(function () {
  'use strict';
  var KEY = 'cf-bug-report';
  // The contact form's message limit (the form's maxlength, contact.js and
  // functions/api/contact.js). Change them together.
  var MAX = 1200;
  var LEAD = 'What were you doing when this happened?\n\n';
  var shown = false;
  var CODE = /^(?:BT|EG|CF)-[A-Z]{2,8}-\d{2}$/;

  function codeOf(code) { return typeof code === 'string' && CODE.test(code) ? code : ''; }

  // The page's own code for an error nothing else caught, or none.
  function pageCode() {
    var m = document.querySelector('meta[name="cf-error-page"]');
    return codeOf(m && m.content);
  }

  function browser(ua) {
    var s = String(ua || '');
    var m = s.match(/(Edg|OPR|Firefox|Chrome|CriOS|FxiOS)\/(\d+)/);
    var names = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox' };
    var label = m ? (names[m[1]] || m[1]) + ' ' + m[2] : null;
    if (!label) { var v = s.match(/Version\/(\d+)[\s\S]*Safari/); if (v) label = 'Safari ' + v[1]; }
    var platform = (s.match(/\(([^;)]+)/) || [])[1];
    return cap(label ? label + (platform ? ' on ' + platform : '') : s, 60);
  }

  // Every part has a ceiling, so the largest report that can ever be built is known: message 300,
  // stack 6 lines of 100, 60 each for browser, page and what happened, and an error code of at most
  // 20 with its label. With the worst possible input that is about 1,300 characters with the lead
  // line, over the limit above, so stash() and the error box cut the end (the stack) to fit. The
  // code is the first line, so a cut never reaches it.
  function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  function stack(st, message) {
    if (!st) return '';
    var lines = String(st).split('\n');
    if (lines[0] && message && lines[0].indexOf(String(message).slice(0, 60)) !== -1) lines.shift();
    lines = lines.slice(0, 6).map(function (l) { return cap(l.replace(/https?:\/\/[^/\s)]+/g, ''), 100); });
    return lines.length ? 'Stack:\n' + lines.join('\n') : '';
  }

  function buildLine() {
    var m = document.querySelector('meta[name="cf-build"]');
    var sha = (m && m.content) || 'unknown';
    var run = m && m.getAttribute('data-run');
    return sha + (run ? ' (run ' + run + ')' : '');
  }

  function details(error, title, code) {
    var root = document.documentElement;
    var msg = (error && error.message) || String(error || 'Unknown error');
    code = codeOf(code);
    return [
      code ? 'Code: ' + code : '',
      'Build: ' + buildLine(),
      'Time: ' + new Date().toISOString(),
      'Browser: ' + browser(navigator.userAgent),
      'Page: ' + cap(location.pathname, 60),
      'Look: ' + (root.getAttribute('data-palette') || 'default') + ' / ' + (root.getAttribute('data-theme') || '?'),
      title ? 'What: ' + cap(title, 60) : '',
      'Error: ' + cap(msg, 300),
      stack(error && error.stack, msg)
    ].filter(Boolean).join('\n');
  }

  function stash(text) {
    var room = MAX - LEAD.length;
    var body = text.length > room ? text.slice(0, room - 30) + '\n[...truncated]' : text;
    // Not carried: the form this would prefill is on another origin, not in this repository. The toast's
    // own link still opens it, empty, the same fallback as when storage itself is blocked.
  }

  function toast(code) {
    if (shown || !document.body) return;
    shown = true;
    var box = document.createElement('div');
    box.id = 'cf-bug-toast';
    box.setAttribute('role', 'status');
    var text = document.createElement('span');
    text.textContent = 'Something went wrong on this page.';
    code = codeOf(code);
    if (code) {
      var small = document.createElement('small');
      small.className = 'cf-bug-code';
      small.textContent = 'Error code ' + code;
      text.appendChild(document.createTextNode(' '));
      text.appendChild(small);
    }
    var go = document.createElement('a');
    go.href = 'https://caseforge.uk/contact/?type=bug';
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = 'Report this';
    var no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Dismiss';
    no.addEventListener('click', function () { box.remove(); });
    box.appendChild(text); box.appendChild(go); box.appendChild(no);
    document.body.appendChild(box);
  }

  function report(opts) {
    opts = opts || {};
    stash(details(opts.error, opts.title, opts.code));
    toast(opts.code);
  }

  function ours(src) { return !src || src.indexOf(location.origin) === 0; }

  // The "reload to continue" notice (lazy-load.js, sw-register.js) is up: this page is out of date,
  // usually a file that has gone since the last deploy, and reloading is the fix. A second notice
  // asking for a bug report about the same failure would only be noise.
  function reloadNoticeShowing() { return !!document.getElementById('cf-update-toast'); }

  window.addEventListener('error', function (e) {
    if (shown || reloadNoticeShowing()) return;
    if (/ResizeObserver loop|Script error/.test(e.message || '')) return;
    if (e.filename && !ours(e.filename)) return;
    if (!e.error && !e.message) return;   // resource load failures arrive here without an error
    report({ error: e.error || new Error(e.message), code: pageCode() });
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (shown || reloadNoticeShowing()) return;
    var r = e.reason;
    var st = r && r.stack ? String(r.stack) : '';
    if (!st || st.indexOf(location.origin) === -1) return;   // no stack of ours, or someone else's code
    report({ error: r, code: pageCode() });
  });

  window.cfBugReport = { report: report, details: details };
})();
