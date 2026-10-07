/* BundleTool's page script: the modals, share links, saved defaults, Advanced Settings state and the
 * other wiring that sits between the page markup and the modules. It is a file rather than an
 * inline <script> in bundletool.html so the page's Content-Security-Policy can forbid inline script
 * (a hostile bundle PDF that got markup onto the page could otherwise run code there). Loaded
 * deferred, ahead of the module scripts, so it runs before them. */
  const step4Choice = document.getElementById('step-4-choice');

  function updateDocState() {
    const hasFiles = document.querySelectorAll('.section-tbody tr.file-row').length > 0;
    // hasSections: true when there are 0001+ sections OR section 0000 has been
    // converted to a labelled section (its header row exists). Without this second
    // check, adding the 0000 header row triggers the observer which then re-hides
    // the table because no non-0000 section exists yet.
    const hasSections =
      document.querySelectorAll('.section-tbody:not(#tbody-section-0000)').length > 0 ||
      document.querySelector('#tbody-section-0000 .section-header-row') !== null;
    // The tutorial's example rows count, so its review-table step can show them
    // before any document is added.
    const hasContent = hasFiles || hasSections || document.querySelector('.section-tbody tr.tutorial-row') !== null;
    document.getElementById('file-table-empty')?.classList.toggle('hidden', hasContent);
    document.getElementById('file-table-content')?.classList.toggle('hidden', !hasContent);
    document.querySelectorAll('.btn-needs-docs').forEach(btn => {
      btn.classList.toggle('docs-inactive', !hasFiles);
    });
  }

  const observer = new MutationObserver(updateDocState);
  document.querySelectorAll('.section-tbody').forEach(tbody => {
    observer.observe(tbody, { childList: true });
  });

  // Re-observe when new section tbodys are added to the table
  const tableObserver = new MutationObserver(() => {
    document.querySelectorAll('.section-tbody').forEach(tbody => {
      observer.observe(tbody, { childList: true });
    });
    updateDocState();
  });
  const tableEl = document.querySelector('#file-table table');
  if (tableEl) tableObserver.observe(tableEl, { childList: true });

  /*
    NEW FEATURE MODAL LOGIC: a template for announcements. Uncomment together with the
    commented-out new-feature modal in layouts/partials/bundletool.html, and give the
    announcement its own key and the date it stops showing.
    const newFeatureKey = 'bundletool_feature_seen_[name]';
    const featureExpiry = new Date('[YYYY-MM-DD]').getTime();
    if (Date.now() < featureExpiry && !localStorage.getItem(newFeatureKey)) {
      document.getElementById('new-feature-modal')?.classList.remove('hidden');
    }
    document.getElementById('new-feature-modal-close')?.addEventListener('click', () => {
      document.getElementById('new-feature-modal')?.classList.add('hidden');
      localStorage.setItem(newFeatureKey, '1');
    });
  */

  // Upload warning modal
  document.getElementById('upload-warning-modal-close')?.addEventListener('click', () => {
    document.getElementById('upload-warning-modal')?.classList.add('hidden');
  });

  // Delete-section modal: step transitions handled in frontend.js via window globals
  document.getElementById('delete-section-keep-btn')?.addEventListener('click', () => {
    document.getElementById('delete-section-modal')?.classList.add('hidden');
    document.getElementById('delete-section-step1')?.classList.remove('hidden');
    document.getElementById('delete-section-step2')?.classList.add('hidden');
    window._deleteSectionResolve?.({ action: 'headerOnly' });
  });
  document.getElementById('delete-section-remove-btn')?.addEventListener('click', () => {
    document.getElementById('delete-section-modal')?.classList.add('hidden');
    document.getElementById('delete-section-step1')?.classList.remove('hidden');
    document.getElementById('delete-section-step2')?.classList.add('hidden');
    window._deleteSectionResolve?.({ action: 'remove' });
  });
  document.getElementById('delete-section-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('delete-section-modal')?.classList.add('hidden');
    document.getElementById('delete-section-step1')?.classList.remove('hidden');
    document.getElementById('delete-section-step2')?.classList.add('hidden');
    window._deleteSectionResolve?.({ action: 'cancel' });
  });
  document.getElementById('delete-section-move-btn')?.addEventListener('click', () => {
    // Switch to step 2: picker list is populated by frontend.js before showing the modal
    document.getElementById('delete-section-step1')?.classList.add('hidden');
    document.getElementById('delete-section-step2')?.classList.remove('hidden');
  });
  document.getElementById('delete-section-back-btn')?.addEventListener('click', () => {
    document.getElementById('delete-section-step2')?.classList.add('hidden');
    document.getElementById('delete-section-step1')?.classList.remove('hidden');
  });

  // Clear-all modal wiring
  document.getElementById('clear-all-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('clear-all-modal')?.classList.add('hidden');
    window._clearAllResolve?.(false);
  });
  document.getElementById('clear-all-confirm-btn')?.addEventListener('click', () => {
    document.getElementById('clear-all-modal')?.classList.add('hidden');
    window._clearAllResolve?.(true);
  });

  // Basic Information clear-all modal wiring: the same promise-per-click
  // pattern as Clear-all above. Basic Information's clear and Advanced
  // Settings Reset both confirm before acting, as Review Table's Clear All
  // does.
  document.getElementById('basic-info-clear-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('basic-info-clear-modal')?.classList.add('hidden');
    window._basicInfoClearResolve?.(false);
  });
  document.getElementById('basic-info-clear-confirm-btn')?.addEventListener('click', () => {
    document.getElementById('basic-info-clear-modal')?.classList.add('hidden');
    window._basicInfoClearResolve?.(true);
  });

  // Advanced Settings reset modal wiring
  document.getElementById('advanced-reset-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('advanced-reset-modal')?.classList.add('hidden');
    window._advancedResetResolve?.(false);
  });
  document.getElementById('advanced-reset-confirm-btn')?.addEventListener('click', () => {
    document.getElementById('advanced-reset-modal')?.classList.add('hidden');
    window._advancedResetResolve?.(true);
  });

  // Global sort modal wiring
  document.getElementById('global-sort-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('global-sort-modal')?.classList.add('hidden');
    window._globalSortResolve?.(false);
  });
  document.getElementById('global-sort-confirm-btn')?.addEventListener('click', () => {
    document.getElementById('global-sort-modal')?.classList.add('hidden');
    window._globalSortResolve?.(true);
  });

  // Error modal
  document.getElementById('error-modal-close')?.addEventListener('click', () => {
    document.getElementById('error-modal')?.classList.add('hidden');
  });
  document.getElementById('error-modal-copy-btn')?.addEventListener('click', () => {
    const box = document.getElementById('error-modal-details');
    const details = box?.value;
    const btn = document.getElementById('error-modal-copy-btn');
    const done = (ok) => {
      if (!btn) return;
      btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C to copy';
      setTimeout(() => { btn.textContent = 'Copy details'; }, 2500);
    };
    if (!details) return;
    // If both copy routes are blocked the text is left selected for Ctrl+C.
    window.cfCopy(details, box).then(done);
  });

  // Advanced Settings is Step 5: a normal collapsible card, whose chevron is
  // its only control, as on every other step. advancedIsOpen() and
  // setAdvancedOpen() are for Escape, below.
  const advancedSettings = document.getElementById('advanced-settings');
  const advancedBody = document.getElementById('advanced-settings-body');

  function advancedIsOpen() {
    return advancedBody && !advancedBody.classList.contains('hidden');
  }

  /** Drives the step's own collapse control, so one mechanism owns the
   *  open/closed state and the chevron can never disagree with the body. */
  function setAdvancedOpen(open) {
    if (!advancedBody || advancedIsOpen() === open) return;
    advancedSettings?.querySelector('.step-collapse')?.click();
  }

  // Escape dismisses the open modal by clicking its own safe exit, so every
  // dialog keeps exactly one dismissal semantics: the damaged-file and
  // password prompts resolve as Skip (fail closed), confirmations as Cancel.
  // The processing overlay is deliberately absent: a build in flight has a
  // Cancel button with consequences Escape should not trigger by accident.
  const MODAL_DISMISS = {
    'autosave-modal': 'autosave-modal-close',
    'finished-bundles-modal': 'finished-bundles-modal-close',
    'upload-warning-modal': 'upload-warning-modal-close',
    'error-modal': 'error-modal-close',
    'large-bundle-modal': 'large-bundle-goback',
    'bundle-confirm-modal': 'bundle-confirm-addinfo',
    'bundle-structure-modal': 'bundle-structure-goback',
    // Text still being read when Create Bundle was pressed: Escape builds nothing, as Cancel does.
    'ocr-wait-modal': 'ocr-wait-cancel',
    'unnamed-sections-modal': 'unnamed-sections-name',
    'damaged-file-modal': 'damaged-file-skip',
    'bundle-detected-modal': 'bundle-detected-skip',
    'pdf-password-modal': 'pdf-password-skip',
    'delete-section-modal': 'delete-section-cancel-btn',
    'clear-all-modal': 'clear-all-cancel-btn',
    'basic-info-clear-modal': 'basic-info-clear-cancel-btn',
    'advanced-reset-modal': 'advanced-reset-cancel-btn',
    'global-sort-modal': 'global-sort-cancel-btn',
    'section-picker-popover': 'section-picker-cancel',
    'download-picker-popover': 'download-picker-cancel',
    'cover-editor-modal': 'cover-editor-cancel',
    'rotate-modal': 'rotate-cancel',
    'email-split-modal': 'email-split-close',
    'bundle-preview-modal': 'bundle-preview-close',
    'share-code-modal': 'share-code-modal-close',
    'new-feature-modal': 'new-feature-modal-close',
    // This dialog has no separate X/close control, only its two real answers, so Escape
    // takes the same side every other content-safety gate above takes (damaged-file-modal,
    // bundle-detected-modal, pdf-password-modal: all default to excluding the file, never to
    // including it unreviewed). "Leave it in" means the redacted text is still readable
    // underneath; Escape must not silently choose that.
    'redaction-modal': 'redaction-remove',
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const [modalId, dismissId] of Object.entries(MODAL_DISMISS)) {
      const modal = document.getElementById(modalId);
      if (modal && !modal.classList.contains('hidden')) {
        document.getElementById(dismissId)?.click();
        return;
      }
    }
    // An undismissable dialog (the processing overlay) still holds Escape.
    if (document.querySelector('[role="dialog"]:not(.hidden)')) return;
    // Escape collapses Advanced Settings if it is the only thing open. It
    // is a step, not a dialog, so this is a convenience rather than the
    // dialog-dismissal contract above.
    if (advancedIsOpen()) setAdvancedOpen(false);
  });

  // Button groups. Only .btn-group-active moves; the colours for both states
  // live in the stylesheet, where dark mode and the palettes can reach them.
  document.querySelectorAll('.btn-group').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('btn-group-active'));
      btn.classList.add('btn-group-active');
      document.getElementById(`config-${group}`).value = btn.dataset.value;
      // A hidden input fires no change event, so persist explicitly.
      window.scheduleDefaultsSave?.();
      // ...and bring what depends on the choice (the dimmed Party Position under Two columns) into step.
      window.refreshAdvancedState?.();
    });
  });

  // Reset to defaults
  function resetGroup(group, defaultValue) {
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => {
      b.classList.toggle('btn-group-active', b.dataset.value === defaultValue);
    });
    document.getElementById(`config-${group}`).value = defaultValue;
  }

  document.getElementById('reset-advanced-btn')?.addEventListener('click', async () => {
    // Confirms first, as Review Table's own Clear All does.
    const modal = document.getElementById('advanced-reset-modal');
    if (!modal) return;
    const confirmed = await new Promise((resolve) => {
      window._advancedResetResolve = resolve;
      modal.classList.remove('hidden');
    });
    if (!confirmed) return;
    // Drives the FACTORY table above rather than a second inline copy of the
    // same values. The cover fields are deliberately untouched: whether a
    // cover has been designed is per-bundle state, and its fields are case
    // data: losing a designed coversheet to a button labelled "Reset" is
    // not a fair trade. With autosave-on-change, Reset persists what it did.
    applyDefaults(RESET_TO);
    refreshPlateOpacityLabel();
    saveDefaultConfig();
    // No "Done" flash needed: Reset/Share hiding again
    // once settingsDiff() is empty is signal enough on its own.
  });

  // STORAGE KEY: DO NOT RENAME (see bundletoolTheme.js). This holds each
  // user's saved default bundle configuration.
  const DEFAULTS_KEY = 'buntool-default-config';

  // The code that checks settings coming from outside (saved defaults, a settings link) lives in
  // its own tested modules. Loaded by dynamic import because this is a classic script; everything
  // that applies settings waits for btSettingsReady. Both go through lazyImport(), so a load that
  // fails raises the reload notice; a classic script has no static import to reach that helper by,
  // and no import.meta, so the modules are named against this script's own address.
  const PAGE_SCRIPT_URL = document.currentScript?.src || new URL('/bundletool/js/bundletoolPage.js', location.href).href;
  let SETTINGS_LIB = null;
  window.btSettingsReady = import('/js/shared/lazy-load.js')
    .then(({ lazyImport }) => Promise.all([
      lazyImport(new URL('./frontend/configSanitise.js', PAGE_SCRIPT_URL)),
      lazyImport(new URL('./frontend/settingsCode.js', PAGE_SCRIPT_URL)),
    ]))
    .then(([sanitise, code]) => { SETTINGS_LIB = { ...sanitise, ...code }; })
    .catch((err) => { console.warn('[settings] could not load the settings checker:', err?.message); });

  // The slider's percentage readout; also called by Reset and applyDefaults.
  function refreshPlateOpacityLabel() {
    const label = document.getElementById('config-plateOpacity-label');
    const value = document.getElementById('config-plateOpacity')?.value;
    if (label && value !== undefined) label.textContent = `${value}%`;
  }
  document.getElementById('config-plateOpacity')?.addEventListener('input', refreshPlateOpacityLabel);

  // Same pattern as refreshPlateOpacityLabel above. Not driven by Reset or
  // applyDefaults(FACTORY): watermarkColour and watermarkOpacity are
  // per-bundle state via autosave, not a remembered Advanced Settings
  // default, so Reset leaves them alone.
  function refreshWatermarkOpacityLabel() {
    const label = document.getElementById('config-watermarkOpacity-label');
    const value = document.getElementById('config-watermarkOpacity')?.value;
    if (label && value !== undefined) label.textContent = `${value}%`;
  }
  document.getElementById('config-watermarkOpacity')?.addEventListener('input', refreshWatermarkOpacityLabel);

  // A convenience, not a constraint: switching to US reading order pre-selects the matching US
  // display style, since someone choosing US-ordered dates is likely drafting for a US-style
  // reader. One-shot only: it sets the value once on this change, the same way a person would by
  // hand, and never overrides a later choice of a different display style. A switch back to UK
  // deliberately does NOT re-pick DD-MM-YYYY, for the same reason: it is a suggestion offered
  // once, not a rule tying the two settings together.
  document.getElementById('config-dateInputOrder')?.addEventListener('change', (e) => {
    if (e.target.value === 'US') {
      const dateStyle = document.getElementById('config-dateStyle');
      if (dateStyle) dateStyle.value = 'MM/DD/YYYY';
    }
  });

  /**
   * Factory settings, in one place.
   *
   * Both Reset and the settings-code encoder read this, so "is this value a
   * default?" has one answer in the file.
   */
  const FACTORY = {
    fontFace: 'serif', dateStyle: 'DD Mon. YYYY', dateInputOrder: 'UK', outlineItemStyle: 'plain',
    indexBookmarkLabel: '', footerFont: 'helvetica', numberingStyle: 'PageX',
    footerPrefix: '', plateColour: '#f4f4f4', plateOpacity: 100,
    footerLink: 'index', pageSize: 'a4',
    headingText: '', frontMatterNumbering: 'continuous', footerOffset: 0,
    alignment: 'centre', pageNumberColour: '#000000',
    indexFontSize: 'medium', footerFontSize: 'medium',
    sectionPrefix: 'Section', showTableBorders: true, printableBundle: false, ocrAutoDetect: true,
    ocrTurnUpright: false, ocrStraighten: false, smallerPhotos: true,
    pageNumberPerSection: false, splitBy: 'size',
    courtName: '', matterOf: '', partyLabel1: '', partyLabel2: '', caseNumberLabel: 'CASE NO:', preparedByLabel: 'Prepared by:', partyJoiner: '-and-', coverLayout: 'classic',
    coverCaseLine: 'court', coverLabelPlacement: 'below', coverPartyAlign: 'centre',
    coverCaseAlign: 'right', coverHeadingAlign: 'left',
  };
  // The Coversheet panel's text and layout belong to the matter in hand, not to the Advanced Settings that
  // Reset and a settings link describe. Blanking them would wipe the court name, the "In the matter of" line
  // and the party labels (and save the blanks as the new defaults), so they are only ever SET, never reset.
  const COVER_KEYS = ['courtName', 'matterOf', 'partyLabel1', 'partyLabel2', 'caseNumberLabel', 'preparedByLabel', 'partyJoiner', 'coverLayout', 'coverCaseLine', 'coverLabelPlacement', 'coverPartyAlign', 'coverCaseAlign', 'coverHeadingAlign'];
  const RESET_TO = Object.fromEntries(Object.entries(FACTORY).filter(([k]) => !COVER_KEYS.includes(k)));

  function currentDefaults() {
    return {
      fontFace: document.getElementById('config-fontFace').value,
      dateStyle: document.getElementById('config-dateStyle').value,
      dateInputOrder: document.getElementById('config-dateInputOrder').value,
      outlineItemStyle: document.getElementById('config-outlineItemStyle').value,
      indexBookmarkLabel: document.getElementById('config-indexBookmarkLabel').value,
      footerFont: document.getElementById('config-footerFont').value,
      numberingStyle: document.getElementById('config-numberingStyle').value,
      footerPrefix: document.getElementById('config-footerPrefix').value,
      headingText: document.getElementById('config-headingText').value,
      frontMatterNumbering: document.getElementById('config-frontMatterNumbering').value,
      footerOffset: Number(document.getElementById('config-footerOffset').value) || 0,
      pageSize: document.getElementById('config-pageSize').value,
      plateColour: document.getElementById('config-plateColour').value,
      plateOpacity: Number(document.getElementById('config-plateOpacity').value),
      footerLink: document.getElementById('config-footerLink').value,
      alignment: document.getElementById('config-alignment').value,
      pageNumberColour: document.getElementById('config-pageNumberColour').value,
      indexFontSize: document.getElementById('config-indexFontSize').value,
      footerFontSize: document.getElementById('config-footerFontSize').value,
      sectionPrefix: document.getElementById('config-sectionPrefix').value,
      showTableBorders: document.getElementById('config-showTableBorders').checked,
      printableBundle: document.getElementById('config-printableBundle').checked,
      ocrAutoDetect: document.getElementById('config-ocrAutoDetect').checked,
      ocrTurnUpright: document.getElementById('config-ocrTurnUpright')?.checked === true,
      ocrStraighten: document.getElementById('config-ocrStraighten')?.checked === true,
      smallerPhotos: document.getElementById('config-smallerPhotos')?.checked ?? true,
      pageNumberPerSection: document.getElementById('config-pageNumberPerSection').checked,
      splitBy: document.getElementById('config-splitBy')?.value || 'size',
      // The court, statute line and party labels are firm-level defaults worth
      // keeping. The party NAMES are not:
      // they belong to one matter, and restoring last matter's respondent onto
      // the front of this matter's bundle is the kind of error that reaches a
      // judge. Whether a cover has been designed is per-bundle state, so it is
      // deliberately not remembered either: a remembered "always generate"
      // would put a cover on bundles nobody designed one for.
      courtName: document.getElementById('config-courtName')?.value || '',
      matterOf: document.getElementById('config-matterOf')?.value || '',
      partyLabel1: document.getElementById('config-partyLabel1')?.value || '',
      partyLabel2: document.getElementById('config-partyLabel2')?.value || '',
      // Blank is a real value here (no prefix), different from the default "CASE NO:", so ?? not ||.
      caseNumberLabel: document.getElementById('config-caseNumberLabel')?.value ?? 'CASE NO:',
      // Blank is a real value here (no label), different from the default "Prepared by:", so ?? not ||.
      preparedByLabel: document.getElementById('config-preparedByLabel')?.value ?? 'Prepared by:',
      // Blank is a real value here (no joining word), different from the default "-and-", so ?? not ||.
      partyJoiner: document.getElementById('config-partyJoiner')?.value ?? '-and-',
      coverLayout: document.getElementById('config-coverLayout')?.value || 'classic',
      coverCaseLine: document.getElementById('config-coverCaseLine')?.value || 'court',
      coverLabelPlacement: document.getElementById('config-coverLabelPlacement')?.value || 'below',
      coverPartyAlign: document.getElementById('config-coverPartyAlign')?.value || 'centre',
      coverCaseAlign: document.getElementById('config-coverCaseAlign')?.value || 'right',
      coverHeadingAlign: document.getElementById('config-coverHeadingAlign')?.value || 'left',
    };
  }

  function saveDefaultConfig() {
    // Storage can be blocked or full: the settings simply are not remembered, and nothing is reported.
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(currentDefaults())); } catch (_) { /* not remembered */ }
    refreshAdvancedActionButtons();
  }

  /** Applies a defaults object to the form; unknown keys are ignored and
   *  missing keys leave the form alone, which is what lets a settings code
   *  from an older or newer build still apply. */
  function applyDefaults(raw) {
    // Only values the build accepts are written: a select set to a value it has no option for goes
    // blank and then fails every Preview Index and Create Bundle (saved defaults from another
    // version, a settings link).
    if (!SETTINGS_LIB) return;
    const d = SETTINGS_LIB.sanitiseConfig(raw, { only: SETTINGS_LIB.DEFAULTS_KEYS });
    if (d.fontFace) document.getElementById('config-fontFace').value = d.fontFace;
    if (d.dateStyle) document.getElementById('config-dateStyle').value = d.dateStyle;
    if (d.dateInputOrder) document.getElementById('config-dateInputOrder').value = d.dateInputOrder;
    if (d.outlineItemStyle) document.getElementById('config-outlineItemStyle').value = d.outlineItemStyle;
    // d.indexBookmarkLabel from a saved-defaults object or settings code is ignored: the page has
    // no such setting, and the label is always the built-in "Index".
    if (d.footerFont) document.getElementById('config-footerFont').value = d.footerFont;
    if (d.numberingStyle) document.getElementById('config-numberingStyle').value = d.numberingStyle;
    if (d.footerPrefix !== undefined) document.getElementById('config-footerPrefix').value = d.footerPrefix;
    if (d.plateColour !== undefined) document.getElementById('config-plateColour').value = d.plateColour;
    if (d.plateOpacity !== undefined) {
      document.getElementById('config-plateOpacity').value = String(d.plateOpacity);
      refreshPlateOpacityLabel();
    }
    if (d.footerLink) document.getElementById('config-footerLink').value = d.footerLink;
    if (d.pageSize) document.getElementById('config-pageSize').value = d.pageSize;
    if (d.headingText !== undefined) document.getElementById('config-headingText').value = d.headingText;
    if (d.frontMatterNumbering) document.getElementById('config-frontMatterNumbering').value = d.frontMatterNumbering;
    if (d.footerOffset !== undefined) document.getElementById('config-footerOffset').value = String(d.footerOffset);
    if (d.alignment) resetGroup('alignment', d.alignment);
    if (d.pageNumberColour) document.getElementById('config-pageNumberColour').value = d.pageNumberColour;
    if (d.indexFontSize) resetGroup('indexFontSize', d.indexFontSize);
    if (d.footerFontSize) resetGroup('footerFontSize', d.footerFontSize);
    if (d.sectionPrefix !== undefined) document.getElementById('config-sectionPrefix').value = d.sectionPrefix;
    if (d.showTableBorders !== undefined) document.getElementById('config-showTableBorders').checked = d.showTableBorders;
    if (d.printableBundle !== undefined) document.getElementById('config-printableBundle').checked = d.printableBundle;
    if (d.ocrAutoDetect !== undefined) document.getElementById('config-ocrAutoDetect').checked = d.ocrAutoDetect;
    for (const key of ['ocrTurnUpright', 'ocrStraighten']) {
      const el = document.getElementById(`config-${key}`);
      if (el && d[key] !== undefined) el.checked = d[key];
    }
    {
      const el = document.getElementById('config-smallerPhotos');
      if (el && d.smallerPhotos !== undefined) el.checked = d.smallerPhotos;
    }
    if (d.pageNumberPerSection !== undefined) document.getElementById('config-pageNumberPerSection').checked = d.pageNumberPerSection;
    if (d.splitBy) resetGroup('splitBy', d.splitBy);
    // d.generateCover from a saved-defaults object or settings code is
    // deliberately ignored: whether a cover is designed is per-bundle state,
    // and applying a remembered true would put a cover on a bundle nobody
    // designed one for.
    if (d.courtName !== undefined) {
      const el = document.getElementById('config-courtName');
      if (el) el.value = d.courtName;
    }
    if (d.matterOf !== undefined) {
      const el = document.getElementById('config-matterOf');
      if (el) el.value = d.matterOf;
    }
    if (d.partyLabel1 !== undefined) {
      const el = document.getElementById('config-partyLabel1');
      if (el) el.value = d.partyLabel1;
    }
    if (d.partyLabel2 !== undefined) {
      const el = document.getElementById('config-partyLabel2');
      if (el) el.value = d.partyLabel2;
    }
    if (d.caseNumberLabel !== undefined) {
      const el = document.getElementById('config-caseNumberLabel');
      if (el) el.value = d.caseNumberLabel;
    }
    if (d.preparedByLabel !== undefined) {
      const el = document.getElementById('config-preparedByLabel');
      if (el) el.value = d.preparedByLabel;
    }
    if (d.partyJoiner !== undefined) {
      const el = document.getElementById('config-partyJoiner');
      if (el) el.value = d.partyJoiner;
    }
    if (d.coverLayout) resetGroup('coverLayout', d.coverLayout);
    if (d.coverCaseLine) resetGroup('coverCaseLine', d.coverCaseLine);
    if (d.coverLabelPlacement) resetGroup('coverLabelPlacement', d.coverLabelPlacement);
    if (d.coverPartyAlign) resetGroup('coverPartyAlign', d.coverPartyAlign);
    if (d.coverCaseAlign) resetGroup('coverCaseAlign', d.coverCaseAlign);
    if (d.coverHeadingAlign) resetGroup('coverHeadingAlign', d.coverHeadingAlign);
    // Values set from code fire no events, so bring the derived controls (party pair, dimmed
    // settings) into step with what was just applied.
    window.refreshAdvancedState?.();
  }

  function loadDefaultConfig() {
    try {
      const stored = localStorage.getItem(DEFAULTS_KEY);
      if (stored) {
        const saved = JSON.parse(stored);
        // A one-time repair: defaults saved by an earlier version's Reset all
        // can hold Footer Position 'right', where the factory value is Centre.
        // A saved 'right' is dropped once; the flag lives in its own key
        // because currentDefaults() rewrites this object without it, and a
        // later deliberate choice of Right must not be undone on every load.
        if (!localStorage.getItem('buntool-footer-centre-repair')) {
          localStorage.setItem('buntool-footer-centre-repair', '1');
          if (saved.alignment === 'right') {
            delete saved.alignment;
            localStorage.setItem(DEFAULTS_KEY, JSON.stringify(saved));
          }
        }
        applyDefaults(saved);
      }
    } catch (_) {
      // Ignore corrupt/missing storage
    }
    refreshAdvancedActionButtons();
  }

  // ── Settings as text ──────────────────────────────────────────────────────
  // BT1. + base64url(JSON of the defaults object). The version prefix is the
  // backwards-compatibility contract: a new format bumps the prefix, and
  // applyDefaults() tolerates unknown or missing keys within a version.
  // BT2. is the same JSON gzipped through the native CompressionStream, the
  // approach Chambers Finder's own save-link uses: a diff is usually well
  // inside the QR-friendly range already, and this shrinks it further. BT1.
  // (plain base64, no compression) stays decodable for any link bookmarked in
  // that form, and is the fallback on a browser without CompressionStream.
  /**
   * Only what DIFFERS from factory goes into the code.
   *
   * The full object is 698 characters, which needs a 93x93-module QR:
   * dense enough that a middling phone camera struggles. Most people
   * change two or three things, so a diff-encoded code is usually under 200
   * and its QR drops to about 65x65, which scans instantly.
   *
   * This is why applySettingsCode() resets to factory FIRST: a partial code
   * describes a complete state, so merging it onto whatever the form already
   * held would leave someone else's leftovers behind.
   */
  function settingsDiff() {
    const now = currentDefaults();
    const out = {};
    for (const [k, v] of Object.entries(now)) {
      if (!(k in FACTORY) || FACTORY[k] !== v) out[k] = v;
    }
    return out;
  }

  async function buildSettingsCode() {
    await window.btSettingsReady;
    return SETTINGS_LIB.encodeSettingsCode(settingsDiff());
  }

  /** Reveals Share/Reset in the Advanced Settings header only once something
   *  actually differs from factory: there is nothing to share or reset otherwise. */
  function refreshAdvancedActionButtons() {
    const diffKeys = Object.keys(settingsDiff());
    const shareBtn = document.getElementById('share-advanced-btn');
    const resetBtn = document.getElementById('reset-advanced-btn');
    if (shareBtn) shareBtn.hidden = diffKeys.length === 0;
    // Reset leaves the coversheet's own text and layout alone, so it is offered only when something it
    // would actually change differs.
    if (resetBtn) resetBtn.hidden = !diffKeys.some((k) => !COVER_KEYS.includes(k));
  }

  /** Applies a settings code: factory first, then what the code carries. Returns how many settings
   *  the code set. Throws SettingsCodeError (with a message for the person) for anything unreadable. */
  async function applySettingsCode(raw) {
    await window.btSettingsReady;
    if (!SETTINGS_LIB) throw new Error('The settings checker could not be loaded.');
    const diff = await SETTINGS_LIB.decodeSettingsCode(raw);
    // Factory first, then the diff: a code describes a COMPLETE state, and
    // merging a partial one onto the current form would silently keep
    // whatever the recipient had set that the sender did not mention.
    applyDefaults(RESET_TO);
    applyDefaults(diff);
    saveDefaultConfig();
    return { count: Object.keys(diff).length, cover: Object.keys(diff).filter((k) => COVER_KEYS.includes(k)) };
  }

  // ── Autosave-on-change ────────────────────────────────────────────────────
  // Nothing on the panel needs a Save press: any change to Advanced Settings
  // persists after a moment's quiet. The cover's fields are hidden inputs that
  // fire no events; the coversheet maker calls scheduleDefaultsSave() itself
  // when it writes them back.
  let _defaultsTimer = null;
  function scheduleDefaultsSave() {
    clearTimeout(_defaultsTimer);
    _defaultsTimer = setTimeout(saveDefaultConfig, 400);
  }
  window.scheduleDefaultsSave = scheduleDefaultsSave;
  {
    const host = document.getElementById('advanced-settings');
    host?.addEventListener('input', scheduleDefaultsSave);
    host?.addEventListener('change', scheduleDefaultsSave);
  }

  // ── Collapsible steps ─────────────────────────────────────────────────────
  // Sync each card's header corners to its body's ACTUAL state on load.
  //
  // The header carries rounded-t-xl only, so while a card is collapsed its
  // square bottom corners overhang the card's own rounded-xl and show as a
  // hairline of card colour under the dark header. The click handler below
  // adds rounded-b-xl when it collapses a card, but a card that starts
  // collapsed in the MARKUP (Advanced Settings) has not been clicked, so it
  // gets the class here.
  //
  // Doing it from the body's state rather than hardcoding the class on that
  // one header keeps any card that starts collapsed correct.
  document.querySelectorAll('.step-collapse').forEach(btn => {
    const body = document.getElementById(btn.dataset.target);
    if (body) {
      btn.closest('.step-header')?.classList.toggle('rounded-b-xl', body.classList.contains('hidden'));
    }
  });

  document.querySelectorAll('.step-collapse').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = document.getElementById(btn.dataset.target);
      if (!body) return;
      const collapsed = body.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Expand this section' : 'Collapse this section');
      btn.querySelector('svg')?.classList.toggle('rotate-180', collapsed);
      btn.closest('.step-header')?.classList.toggle('rounded-b-xl', collapsed);
    });
  });

  // ── Palette (Modern / Classic) ────────────────────────────────────────────
  // Its own storage key, not part of the bundle defaults or settings codes: a
  // colour scheme is a per-user preference, not a bundle setting worth sharing.
  const PALETTE_KEY = 'bundletool_palette';
  function applyPalette(value, persist = true) {
    const palette = value === 'classic' ? 'classic' : 'modern';
    document.documentElement.setAttribute('data-palette', palette);
    if (persist) { try { localStorage.setItem(PALETTE_KEY, palette); } catch (_) {} }
    resetGroup('palette', palette);
    const mode = document.documentElement.getAttribute('data-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = palette === 'classic'
      ? (mode === 'dark' ? '#020617' : '#f5f5f4')
      : (mode === 'dark' ? '#0e1014' : '#f0ebe1');
  }
  document.querySelectorAll('[data-group="palette"]').forEach(btn => {
    btn.addEventListener('click', () => applyPalette(btn.dataset.value));
  });
  // Reflect whatever the pre-paint script chose (visuals only; no persist).
  applyPalette(document.documentElement.getAttribute('data-palette'), false);

  window.saveDefaultConfig = saveDefaultConfig;
  window.hasDefaultConfig = () => { try { return !!localStorage.getItem(DEFAULTS_KEY); } catch (_) { return false; } };
  // The one sanctioned way to set a segmented control from code (bundle reload
  // and snapshot restore use it). Writing the hidden input directly would leave
  // the buttons highlighting the old value while the build silently uses the
  // new one.
  window.setBtnGroup = resetGroup;

  // ── QR ────────────────────────────────────────────────────────────────────
  let _qrLib = null;
  function loadQrLib() {
    if (_qrLib) return Promise.resolve(_qrLib);
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = '/vendor/matrix-render.js';
      el.onload = () => {
        _qrLib = window.qrcode;
        _qrLib ? resolve(_qrLib) : reject(new Error('qrcode global missing'));
      };
      el.onerror = () => reject(new Error('could not load the QR library'));
      document.head.appendChild(el);
    });
  }

  async function showQr() {
    const code = await buildSettingsCode();
    // A #fragment, never a ?query: a fragment is not transmitted to the
    // server, so the settings never leave the device even when the link is
    // opened. Same reason Chambers Finder uses #cfx=.
    const url = `${location.origin}${location.pathname}#s=${encodeURIComponent(code)}`;
    document.getElementById('share-code-link').value = url;

    const host = document.getElementById('share-code-canvas');
    host.innerHTML = '';
    try {
      // Loaded as a SCRIPT TAG, not an import: the vendored file is the
      // library's own UMD build, which sets a global (window.qrcode) rather
      // than exporting a module. A tag also means the ~57 KB is fetched only
      // when someone asks for a QR, which is the first time it can possibly
      // be needed.
      const qrcode = await loadQrLib();
      const qr = qrcode(0, 'L');           // 0 = smallest version that fits
      qr.addData(url);
      qr.make();
      host.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
      const svg = host.querySelector('svg');
      if (svg) { svg.style.width = '100%'; svg.style.height = 'auto'; svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code for these settings'); }
      document.getElementById('share-code-note').textContent =
        `${qr.getModuleCount()}×${qr.getModuleCount()} · ${url.length} characters. Scanning opens BundleTool with these settings ready to save.`;
    } catch (err) {
      // A code too large for any QR version throws here. Say so plainly and
      // leave the link, rather than rendering something unscannable.
      host.innerHTML = '';
      document.getElementById('share-code-note').textContent =
        'These settings are too long for a QR code. Use the link instead.';
    }

    const modal = document.getElementById('share-code-modal');
    modal.classList.remove('hidden');
    // Move focus INTO the modal: left on the QR button behind it, Tab would
    // walk the page underneath and Escape would be the only way a keyboard
    // user knew they were in a dialog. The close button is the right landing
    // spot: it is the safe action, and it is where a screen reader then reads
    // the dialog from.
    // preventScroll, because the modal is already in view and scrolling the
    // page behind it is exactly the jump this is meant to avoid.
    document.getElementById('share-code-modal-close')?.focus({ preventScroll: true });
    const copied = document.getElementById('share-code-copied');
    copied.textContent = '';
    copied.textContent = (await window.cfCopy(url))
      ? 'Link copied to your clipboard.'
      : 'Select the link above to copy it.';
  }

  document.getElementById('share-advanced-btn')?.addEventListener('click', showQr);
  // Focus goes back to the button that opened it, so closing does not dump a
  // keyboard user at the top of the document.
  function closeQr() {
    document.getElementById('share-code-modal')?.classList.add('hidden');
    document.getElementById('share-advanced-btn')?.focus({ preventScroll: true });
  }
  document.getElementById('share-code-modal-close')?.addEventListener('click', closeQr);

  // A scanned link arrives as #s=<code>. It is applied straight away and then AGAIN once the last
  // saved work has been restored (frontend.js calls window.btReapplySettingsLink): the restore and the
  // form draft both write Advanced Settings, and a link the person just opened wins over both. A
  // notice says what happened, since nothing on the page shows that a link changed the settings.
  let incomingSettingsCode = null;
  {
    const m = /^#s=(.+)$/.exec(location.hash || '');
    if (m) {
      try {
        const code = decodeURIComponent(m[1]);
        if (/^BT[12]\./.test(code)) {
          incomingSettingsCode = code;
          history.replaceState(null, '', location.pathname);   // don't re-fire on reload
        }
      } catch (_) { /* a malformed escape: not one of ours */ }
    }
  }
  // The same notice as frontend/modals.js's showPageNotice (this file is a plain script and cannot import it): the
  // code line shows only a code of BundleTool's own shape (frontend/errorCodes.js), and none for a notice that informs.
  function showSettingsNotice({ code, title, message }) {
    const box = document.getElementById('restore-notice');
    if (!box) return;
    const t = document.getElementById('restore-notice-title');
    const msg = document.getElementById('restore-notice-msg');
    const codeLine = document.getElementById('restore-notice-code');
    if (t) t.textContent = title;
    if (msg) msg.textContent = message;
    if (codeLine) {
      const shown = typeof code === 'string' && /^BT-[A-Z]{2,8}-\d{2}$/.test(code) ? code : '';
      codeLine.textContent = shown ? 'Error code ' + shown : '';
      codeLine.classList.toggle('hidden', !shown);
    }
    box.classList.remove('hidden');
  }
  async function applyIncomingSettingsLink(announce) {
    if (!incomingSettingsCode) return;
    try {
      const { count: n, cover } = await applySettingsCode(incomingSettingsCode);
      if (announce) {
        const coverNote = cover.length
          ? ` It also set the coversheet's ${cover.map((k) => ({ courtName: 'court name', matterOf: '"In the matter of" line', partyLabel1: 'first party label', partyLabel2: 'second party label', caseNumberLabel: 'case number label', preparedByLabel: 'prepared by label', partyJoiner: 'party joiner', coverLayout: 'layout', coverCaseLine: 'case number position', coverLabelPlacement: 'party label position', coverPartyAlign: 'party alignment', coverCaseAlign: 'case number alignment', coverHeadingAlign: 'court alignment' }[k])).join(', ')}.`
          : '';
        showSettingsNotice({ code: null, title: 'Settings from a link were applied', message:
          `The link you opened set ${n} setting${n === 1 ? '' : 's'} in Advanced Settings.${coverNote} Use Reset there to go back to the standard ones.` });
        incomingSettingsCode = null;
      }
    } catch (err) {
      incomingSettingsCode = null;
      showSettingsNotice({ code: 'BT-LINK-01', title: 'That settings link could not be used', message:
        (err && err.name === 'SettingsCodeError' ? err.message : 'It could not be read') + ' Nothing was changed.' });
    }
  }
  window.btReapplySettingsLink = () => applyIncomingSettingsLink(true);

  // Saved defaults first, then a settings link on top of them. Both wait for the checker modules.
  window.btSettingsReady.then(() => { loadDefaultConfig(); return applyIncomingSettingsLink(false); });
  updateDocState();
