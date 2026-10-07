import { state } from './state.js';
import { lazyImport } from '/js/shared/lazy-load.js';
import { shownCode } from './errorCodes.js';

/**
 * Puts an error code (errorCodes.js) in the small line after a notice's message, or hides the line when there is
 * none. Only a registered code is ever shown.
 */
function setCodeLine(id, code) {
  const el = document.getElementById(id);
  if (!el) return;
  const shown = shownCode(code);
  el.textContent = shown ? `Error code ${shown}` : '';
  el.classList.toggle('hidden', !shown);
}

export function isFileMissingError(error) {
  if (!error) return false;
  if (error.name === 'NotFoundError') return true;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('file or directory could not be found')
    || msg.includes('file not found')
    || msg.includes('cannot find the file')
    || msg.includes('no such file');
}

export function isLoadingError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('error loading dynamically')
    || msg.includes('dynamically imported module')
    || msg.includes('failed to fetch')
    || msg.includes('networkerror')
    || msg.includes('network connection')
    || msg.includes('font fetch failed');
}

export function isMemoryError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('realloc')
    || msg.includes('malloc')
    || msg.includes('out of memory')
    || msg.includes('allocation failed')
    || msg.includes('memory exhausted');
}

/**
 * Asks the user whether to include a damaged document that was only partially
 * recovered. Resolves true to include it, false to leave it out.
 *
 * This is a deliberate interruption. A damaged PDF is sometimes the only
 * surviving copy of a document, so BundleTool recovers what it can rather than
 * refusing, but what came back has not been checked against anything, and a
 * court bundle is the wrong place to discover that quietly. The disclosure text
 * says what was recovered and stops short of claiming what was lost, because
 * where the damage is in the cross-reference table there is no way to know.
 *
 * @param {string} filename
 * @param {string} disclosure - from bundletoolPdfLoad.js
 * @returns {Promise<boolean>}
 */
export function confirmDamagedFile(filename, disclosure) {
  const modal = document.getElementById('damaged-file-modal');
  const nameEl = document.getElementById('damaged-file-name');
  const msgEl = document.getElementById('damaged-file-msg');
  const includeBtn = document.getElementById('damaged-file-include');
  const skipBtn = document.getElementById('damaged-file-skip');

  // No modal in the DOM (e.g. under test): fail closed and leave it out rather
  // than silently including unverified pages.
  if (!modal || !includeBtn || !skipBtn) {
    console.warn('[modals] damaged-file modal missing; excluding the file');
    return Promise.resolve(false);
  }

  if (nameEl) nameEl.textContent = filename;
  if (msgEl) msgEl.textContent = disclosure || 'This file is damaged and may be incomplete.';
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      includeBtn.removeEventListener('click', onInclude);
      skipBtn.removeEventListener('click', onSkip);
      resolve(value);
    };
    const onInclude = () => finish(true);
    const onSkip = () => finish(false);
    includeBtn.addEventListener('click', onInclude);
    skipBtn.addEventListener('click', onSkip);
  });
}

/**
 * A document carrying redaction markers that were never applied: the text underneath can still be
 * read. Asks whether to leave the file in the bundle or remove it. Fails closed (removes it) when
 * the modal is not in the page.
 *
 * @param {string} filename
 * @param {string} pagesText - "page 2", "pages 2 and 4"
 * @returns {Promise<boolean>} true to leave it in, false to remove it
 */
export function confirmRedactionMarkers(filename, pagesText) {
  const modal = document.getElementById('redaction-modal');
  const nameEl = document.getElementById('redaction-file-name');
  const pagesEl = document.getElementById('redaction-pages');
  const keepBtn = document.getElementById('redaction-keep');
  const removeBtn = document.getElementById('redaction-remove');
  if (!modal || !keepBtn || !removeBtn) {
    console.warn('[modals] redaction modal missing; leaving the file out');
    return Promise.resolve(false);
  }
  if (nameEl) nameEl.textContent = filename;
  if (pagesEl) pagesEl.textContent = pagesText;
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      keepBtn.removeEventListener('click', onKeep);
      removeBtn.removeEventListener('click', onRemove);
      resolve(value);
    };
    const onKeep = () => finish(true);
    const onRemove = () => finish(false);
    keepBtn.addEventListener('click', onKeep);
    removeBtn.addEventListener('click', onRemove);
  });
}

/**
 * Asks what to do with an added file that is a BundleTool bundle.
 *
 * @param {string} filename
 * @param {number} documents - how many documents its index records
 * @param {boolean} offerOpen - true when the table is empty and this is the
 *   only file being added, so "open it for editing" (which replaces the table
 *   and the settings) cannot destroy anything
 * @returns {Promise<'open'|'splitHere'|'addAsIs'|'skip'>}
 */
export function confirmBundleAction(filename, documents, offerOpen) {
  const modal    = document.getElementById('bundle-detected-modal');
  const nameEl   = document.getElementById('bundle-detected-name');
  const msgEl    = document.getElementById('bundle-detected-msg');
  const openBtn  = document.getElementById('bundle-detected-open');
  const splitBtn = document.getElementById('bundle-detected-split');
  const asisBtn  = document.getElementById('bundle-detected-asis');
  const skipBtn  = document.getElementById('bundle-detected-skip');

  // No modal in the DOM (e.g. under test): add the file as an ordinary
  // document.
  if (!modal || !openBtn || !splitBtn || !asisBtn || !skipBtn) {
    return Promise.resolve('addAsIs');
  }

  if (nameEl) nameEl.textContent = filename;
  if (msgEl) {
    msgEl.textContent = `This PDF was made by BundleTool and contains ${documents} document${documents === 1 ? '' : 's'}.`
      + (offerOpen
        ? ' Opening it for editing brings back its documents, sections and settings.'
        : ' Its documents can be split out and added to the table individually.');
  }
  openBtn.classList.toggle('hidden', !offerOpen);
  splitBtn.classList.toggle('hidden', offerOpen);
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      openBtn.removeEventListener('click', onOpen);
      splitBtn.removeEventListener('click', onSplit);
      asisBtn.removeEventListener('click', onAsIs);
      skipBtn.removeEventListener('click', onSkip);
      resolve(value);
    };
    const onOpen  = () => finish('open');
    const onSplit = () => finish('splitHere');
    const onAsIs  = () => finish('addAsIs');
    const onSkip  = () => finish('skip');
    openBtn.addEventListener('click', onOpen);
    splitBtn.addEventListener('click', onSplit);
    asisBtn.addEventListener('click', onAsIs);
    skipBtn.addEventListener('click', onSkip);
  });
}

/**
 * Prompts for a password-protected PDF's password and decrypts it on-device.
 * Wrong passwords keep the modal open with an inline error; Skip resolves
 * null and the file is left out. Resolves the decrypted bytes on success.
 *
 * @param {string} filename
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array|null>}
 */
export async function unlockWithPrompt(filename, bytes) {
  const modal     = document.getElementById('pdf-password-modal');
  const nameEl    = document.getElementById('pdf-password-name');
  const input     = document.getElementById('pdf-password-input');
  const errEl     = document.getElementById('pdf-password-error');
  const unlockBtn = document.getElementById('pdf-password-unlock');
  const skipBtn   = document.getElementById('pdf-password-skip');

  // No modal (e.g. under test): fail closed and leave the file out.
  if (!modal || !input || !unlockBtn || !skipBtn) return null;

  const { unlockPdf } = await lazyImport(new URL('../bundletoolPdfLoad.js', import.meta.url));

  if (nameEl) nameEl.textContent = filename;
  input.value = '';
  errEl?.classList.add('hidden');
  modal.classList.remove('hidden');
  input.focus();

  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      input.value = '';
      unlockBtn.removeEventListener('click', onUnlock);
      skipBtn.removeEventListener('click', onSkip);
      input.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const label = unlockBtn.textContent;
    const onUnlock = async () => {
      // Decryption is real work on a large file, and a button that sits there
      // looking untouched reads as "Enter did nothing". Say what is
      // happening, then say it worked, before the modal disappears.
      unlockBtn.disabled = true;
      unlockBtn.textContent = 'Checking\u2026';
      errEl?.classList.add('hidden');
      // A frame, so the label actually paints before the main thread goes
      // into the decrypt. Without it the "Checking" state is computed and
      // replaced within one frame and is never seen.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const decrypted = await unlockPdf(bytes, input.value);
        unlockBtn.textContent = 'Unlocked \u2713';
        // Long enough to register, short enough not to be a wait: the same
        // 180ms the bundle-ready overlay uses, for the same reason.
        await new Promise((r) => setTimeout(r, 180));
        unlockBtn.disabled = false;
        unlockBtn.textContent = label;
        finish(decrypted);
      } catch (err) {
        unlockBtn.textContent = label;
        unlockBtn.disabled = false;
        if (errEl) {
          errEl.textContent = err?.userMessage ?? 'That password did not open the file.';
          errEl.classList.remove('hidden');
        }
        // A shake, so a wrong password registers even if you are looking at
        // the keyboard rather than at the error line. The INPUT shakes, not
        // the whole card: shaking the dialog moves the error text and the
        // buttons too, which is a lot of motion to say one field is wrong. The
        // class is removed and re-added after a reflow, or a second wrong
        // attempt would not replay the animation (the class would already be
        // there, so the browser would have nothing to animate).
        input.classList.remove('pw-shake');
        void input.offsetWidth;   // reflow, or a second wrong try would not replay
        input.classList.add('pw-shake');
        input.select();
      }
    };
    const onSkip = () => finish(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onUnlock(); } };
    unlockBtn.addEventListener('click', onUnlock);
    skipBtn.addEventListener('click', onSkip);
    input.addEventListener('keydown', onKey);
  });
}

/**
 * The notice with one dismiss button: a file that was refused or left out, or a warning.
 * @param {{code: string|null, title?: string, message?: string, items?: string[], hint?: string, guide?: boolean}} notice
 *   code: from errorCodes.js when something was refused or left out, null when the notice only informs
 */
export function showUploadWarningModal({ code, title, message, items, hint, guide } = {}) {
  const modal   = document.getElementById('upload-warning-modal');
  const titleEl = document.getElementById('upload-warning-modal-title');
  const msgEl   = document.getElementById('upload-warning-modal-msg');
  const listEl  = document.getElementById('upload-warning-modal-list');
  const hintEl  = document.getElementById('upload-warning-modal-hint');
  if (titleEl) titleEl.textContent = title   || 'Large upload';
  if (msgEl)   msgEl.textContent   = message || '';
  setCodeLine('upload-warning-modal-code', code);

  // A long list (a manifest missing every one of its files) scrolls inside
  // its own box rather than growing the modal past the viewport: textContent
  // per <li>, never innerHTML, since these are filenames the user picked,
  // not markup this modal should ever interpret.
  if (listEl) {
    listEl.innerHTML = '';
    if (items?.length) {
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        listEl.appendChild(li);
      }
      listEl.classList.remove('hidden');
    } else {
      listEl.classList.add('hidden');
    }
  }
  if (hintEl) {
    hintEl.textContent = hint || '';
    hintEl.classList.toggle('hidden', !hint);
  }
  // A link to the Guide's list of accepted files, for a file that was the wrong kind.
  document.getElementById('upload-warning-modal-guide')?.classList.toggle('hidden', !guide);
  modal?.classList.remove('hidden');
}

/**
 * The error box.
 * @param {{code: string, title?: string, message?: string, error?: unknown}} notice
 *   code: from errorCodes.js, shown after the message and written into the bug report
 */
export function showErrorModal({ code, title, message, error } = {}) {
  const modal          = document.getElementById('error-modal');
  const titleEl        = document.getElementById('error-modal-title');
  const msgEl          = document.getElementById('error-modal-msg');
  const hintEl         = document.getElementById('error-modal-hint');
  const detailsWrapper = document.getElementById('error-modal-details-wrapper');
  const detailsEl      = document.getElementById('error-modal-details');
  const copyBtn        = document.getElementById('error-modal-copy-btn');
  const reportLink     = document.getElementById('error-modal-report-link');

  if (titleEl) titleEl.textContent = title   || 'Something went wrong';
  if (msgEl)   msgEl.textContent   = message || '';
  setCodeLine('error-modal-code', code);

  if (isFileMissingError(error)) {
    hintEl?.classList.remove('hidden');
  } else {
    hintEl?.classList.add('hidden');
  }

  if (error) {
    // One report for every page: the shared reporter (static/js/shared/bug-report.js, loaded by
    // this page's footer) builds it, capped so the largest possible report fits the contact
    // form's limit. If that script did not load, the error alone is still offered.
    const shown     = shownCode(code);
    const details   = window.cfBugReport
      ? window.cfBugReport.details(error, title, shown)
      : `${shown ? `Code: ${shown}\n` : ''}Error: ${error.message || error}`;
    if (detailsEl) detailsEl.value = details;
    detailsWrapper?.classList.remove('hidden');
    copyBtn?.classList.remove('hidden');
    if (reportLink) {
      // The contact form's message field caps at 1200 characters (server-
      // and client-enforced). The report is capped below that, so the prefill
      // is the whole report; the truncation stays only as a backstop.
      // The prefill opens with a line asking what the person was doing, which
      // is the one thing the details cannot say.
      //
      // Handed to the contact page through localStorage, NOT the URL: an error
      // message can name the file that failed (a client's document), and a URL
      // is logged by the browser history, the CDN and any analytics. Contact
      // reads the key once and deletes it (the contact page's own script).
      const lead = 'What were you doing when this happened?\n\n';
      const maxPrefill = 1200 - lead.length;
      const truncated = details.length > maxPrefill
        ? details.slice(0, maxPrefill - 30) + '\n[...truncated, see Copy details]'
        : details;
      window.cfCopy?.(lead + truncated);
      reportLink.href = 'https://caseforge.uk/contact/?type=bug';
      reportLink.classList.remove('hidden');
    }
  } else {
    detailsWrapper?.classList.add('hidden');
    copyBtn?.classList.add('hidden');
    reportLink?.classList.add('hidden');
  }

  modal?.classList.remove('hidden');
}

/**
 * The notice above the form (#restore-notice): what happened to the saved work, or to a settings link. Its own
 * Dismiss button closes it (autoRestore.js wires it).
 * @param {{code: string|null, title: string, message: string}} notice
 *   code: from errorCodes.js when something failed, null when the notice only informs
 */
export function showPageNotice({ code, title, message }) {
  const box = document.getElementById('restore-notice');
  if (!box) return;
  const t = document.getElementById('restore-notice-title');
  const m = document.getElementById('restore-notice-msg');
  if (t) t.textContent = title;
  if (m) m.textContent = message;
  setCodeLine('restore-notice-code', code);
  box.classList.remove('hidden');
}

/**
 * A limit's own notice (wholeAddProblem in limits.js, ManifestLimitError in manifestIO.js): the error box for an
 * error, the warning otherwise, with the code the limit carries.
 * @param {{kind: 'error'|'warning', code: string, title: string, message: string}} limit
 */
export function showLimitNotice({ kind, code, title, message }) {
  if (kind === 'error') showErrorModal({ code, title, message });
  else showUploadWarningModal({ code, title, message });
}

const bundleInfoFields = [
  { id: 'config-bundleTitle', label: 'bundle title' },
  { id: 'config-claimNumber', label: 'court reference' },
  { id: 'config-projectName', label: 'parties' },
  // 'Prepared by' writes the PDF /Author field. Listed last so 'Add info'
  // focuses the case-identifying fields first when several are blank.
  // Warn-and-allow, not a hard block, the same treatment the other three
  // get: a bundle is often assembled against a filing deadline, and refusing
  // to generate over one missing field would strand someone mid-deadline. It
  // asks for the author before leaving; 'I'm sure' still works.
  { id: 'config-author', label: 'Prepared By' },
];

/**
 * One warning gate: shows `modalId`, resolves true through `proceedId` and
 * false through `dismissId`. Listeners attach per call and detach on either
 * answer, the same shape confirmDamagedFile uses.
 *
 * Each gate is awaited inside one submission, which is what a sequence of
 * questions actually is. Setting a flag per confirm and calling
 * form.requestSubmit() again instead would not work: the submit handler resets
 * each flag as it passes, so confirming a second warning would resubmit with
 * the first one's flag already reset, and the first modal would come back.
 */
function askGate(modalId, proceedId, dismissId) {
  const modal      = document.getElementById(modalId);
  const proceedBtn = document.getElementById(proceedId);
  const dismissBtn = document.getElementById(dismissId);
  // No modal in the DOM (e.g. under test): warn-and-continue gates continue.
  if (!modal || !proceedBtn || !dismissBtn) return Promise.resolve(true);
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      proceedBtn.removeEventListener('click', onProceed);
      dismissBtn.removeEventListener('click', onDismiss);
      resolve(value);
    };
    const onProceed = () => finish(true);
    const onDismiss = () => finish(false);
    proceedBtn.addEventListener('click', onProceed);
    dismissBtn.addEventListener('click', onDismiss);
  });
}

/**
 * Resolves true when the build should proceed: either nothing is missing, or
 * the user answered "I'm sure". "Add info" resolves false and focuses the
 * first blank field.
 */
export async function confirmMissingInfo() {
  const missing = bundleInfoFields
    .filter(f => !document.getElementById(f.id)?.value.trim())
    .map(f => f.label);
  if (missing.length === 0) return true;
  const formatted = missing.length === 1
    ? missing[0]
    : missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1];
  const msgEl = document.getElementById('bundle-confirm-msg');
  if (msgEl) msgEl.textContent = `Are you sure you want to leave out the ${formatted}?`;
  const proceed = await askGate('bundle-confirm-modal', 'bundle-confirm-sure', 'bundle-confirm-addinfo');
  if (!proceed) {
    const first = bundleInfoFields.find(f => !document.getElementById(f.id)?.value.trim());
    if (first) {
      const el = document.getElementById(first.id);
      el?.focus();
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  return proceed;
}

/**
 * Warns when a bundle is about to be built with no sections and/or no
 * coversheet, naming only what is missing. Warn-and-continue, never a block:
 * both are legitimate bundles (a short bundle needs no sections; some firms
 * bind their own covers). Resolves true to proceed.
 */
export function confirmStructureWarning() {
  const hasSections = document.querySelector('.section-tbody .section-header-row') !== null;
  const hasCover = state.coversheetFile !== null
    || document.getElementById('config-generateCover')?.checked === true;
  const missing = [];
  if (!hasSections) missing.push('no sections');
  if (!hasCover) missing.push('no coversheet');
  if (missing.length === 0) return Promise.resolve(true);
  const msgEl = document.getElementById('bundle-structure-msg');
  if (msgEl) {
    msgEl.textContent = `This bundle has ${missing.join(' and ')}. `
      + (!hasCover
        ? 'You can add a coversheet or sections under Select Documents, or continue without.'
        : 'You can add sections under Select Documents, or continue without.');
  }
  return askGate('bundle-structure-modal', 'bundle-structure-continue', 'bundle-structure-goback');
}

/**
 * Warns when sections have no name. A section name is optional (the bundle
 * still builds, labelled by its letter or number alone), so this asks rather
 * than blocks. "Name them" outlines the unnamed name boxes in red and focuses
 * the first; "Continue" clears any outline and proceeds. Resolves true to
 * proceed. It is a page dialog rather than a native browser confirm(), so it
 * can point at the boxes that need a name.
 */
export async function confirmUnnamedSections() {
  const unnamed = Array.from(document.querySelectorAll('.section-tbody'))
    .filter(t => t.querySelector('.section-header-row') && !t.querySelector('.section-name-input')?.value.trim());
  const inputs = Array.from(document.querySelectorAll('.section-name-input'));
  if (unnamed.length === 0) {
    inputs.forEach(inp => { inp.style.outline = ''; });
    return true;
  }
  const msgEl = document.getElementById('unnamed-sections-msg');
  if (msgEl) {
    msgEl.textContent = unnamed.length === 1
      ? 'One section has no name. Continue without naming it?'
      : `${unnamed.length} sections have no name. Continue without naming them?`;
  }
  const proceed = await askGate('unnamed-sections-modal', 'unnamed-sections-continue', 'unnamed-sections-name');
  if (!proceed) {
    unnamed.forEach(t => {
      const inp = t.querySelector('.section-name-input');
      if (inp) inp.style.outline = '2px solid #ef4444';
    });
    const first = unnamed[0].querySelector('.section-name-input');
    first?.focus();
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  inputs.forEach(inp => { inp.style.outline = ''; });
  return true;
}

/**
 * The large-bundle warning, with this bundle's own estimated cost filled in
 * by the caller (bundleGeneration.js). Resolves true to proceed.
 */
export function confirmLargeBundle() {
  return askGate('large-bundle-modal', 'large-bundle-proceed', 'large-bundle-goback');
}

/** Wire up static modal close/action buttons. Called once from frontend.js init. */
export function setupModals() {
  // The warning gates (missing info, structure, large bundle) bind their
  // buttons per invocation in askGate(); nothing to wire here.
}
