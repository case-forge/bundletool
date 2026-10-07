/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 * Part of BundleTool, a fork of BunTool by Tris Sherliker (tris@sherliker.net).
 * Licensed under the Mozilla Public License Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolTutorial.js
 * The on-demand tour, run from the header's question mark.
 *
 * The spotlight is derived from the target's LIVE geometry: a
 * requestAnimationFrame loop reads getBoundingClientRect every frame while
 * the tour is open and rebuilds the clip-path from what it sees. Nothing is
 * precomputed, so scrolling (either direction, any distance), resizing,
 * collapsing a step or the page reflowing all keep the highlight on the
 * element, and Back recomputes exactly like Next because neither computes
 * anything ahead of time. A target measured once, after a fixed delay, would
 * race a smooth scroll that has further to travel. A per-frame rect read of
 * one element takes microseconds; the loop stops when the tour closes.
 *
 * A step whose target is missing from the page gets no spotlight and logs
 * once, so a missing target is never silent.
 */

import { makeFileRow } from './frontend/fileRows.js';

export const STEPS = [
  {
    element: null,
    title: 'Welcome to BundleTool',
    body: 'BundleTool creates PDF bundles for use in court, tribunals, meetings and other legal settings. You give it the files, and the bundle is created automatically.',
  },
  {
    element: null,
    title: 'Your documents stay private',
    body: 'Everything happens on your device, and your documents never leave it.',
  },
  {
    element: 'step-1-info',
    title: 'Step 1: Basic Information',
    body: 'Start with the case reference, the bundle title, the parties and who prepared the bundle. A watermark and a bundle password live in Advanced Settings, under Confidentiality & Security.',
  },
  {
    element: 'file-drop-zone',
    title: 'Step 2: Select Documents',
    body: 'Add PDFs, Word documents or photos of exhibits, by clicking "Add Documents" or dropping files anywhere on the page.',
  },
  {
    element: 'sections-column',
    title: 'Sections',
    body: [
      'Click "Add Section" to divide your bundle into named parts, for example "A: Correspondence" or "B: Witness Statements". You can drag documents between sections, and drag whole sections to reorder them.',
      'Each section header also has a witness statement cover button: it draws a cover page for that section alone, in the same style as the main coversheet.',
      'Export saves your section names as a small file (not the documents themselves). Import it into a similar bundle to rebuild the same shape.',
    ],
  },
  {
    element: 'coversheet-column',
    title: 'Coversheet',
    body: '"Add Coversheet" opens the coversheet maker: fill in the court, the parties and the case subheading and watch the live preview. The reference, title and Prepared By start as Basic Information\'s, and changing them here changes the coversheet only. Or add your own front page, such as a firm letterhead, as a PDF, Word document or photo. A bundle never carries two covers.',
  },
  {
    element: 'file-table',
    title: 'Step 3: Review Table',
    body: [
      'Check names and dates here: click any title or date to edit it, and drag rows to reorder them. The faded rows are examples.',
      [
        'Each row has four buttons: remove, up, down, and the eye, which opens the document.',
        'Page through it, or type a page number.',
        'Turn a sideways scan with Turn left or Turn right, then Turn document.',
        'This page turns just the page shown; Whole document turns them all.',
        'A scanned page is read automatically so its text can be searched; Force OCR reads it again if that went wrong.',
        'A note says when a page looks blank.',
        'Remove this page takes out the page shown, once you confirm it.',
      ].join(' '),
      'Download, at the top of the table, gives back a section, the changed documents or all of them, in one zip.',
    ],
    showPlaceholderRows: true,
    showDownload: true,
  },
  {
    element: 'step-4-choice',
    title: 'Step 4: Create Bundle',
    body: '"Create Bundle" builds the complete PDF with an index, page numbers and bookmarks; "Preview Index" shows just the contents page first. If sections, a coversheet or case details are missing, you are asked once and can continue.',
  },
  {
    // The next three steps open the header menu and spotlight one item each.
    // A target inside a CLOSED menu would be a zero-sized rectangle, a silent
    // miss, so each one asks for the menu to be opened first.
    element: 'autosave-restore-btn',
    openAppsMenu: true,
    title: 'Menu: Rewind',
    body: 'Rewind goes back to an earlier autosave. BundleTool saves to this browser as you work.',
  },
  {
    element: 'finished-bundles-btn',
    openAppsMenu: true,
    title: 'Menu: Bundles',
    body: 'Bundles holds the ones this browser has already made, each with a Split for email option (by size, or by section). To reopen a finished bundle for editing, add its PDF like any other file: BundleTool recognises its own bundles and offers to open or split them.',
  },
  {
    element: 'tutorial-open-btn',
    openAppsMenu: true,
    title: 'Menu: Help',
    body: 'Help runs this tutorial again.',
  },
  {
    element: 'advanced-settings',
    title: 'Advanced Settings',
    body: 'Fonts, page numbering, watermarks, bundle passwords and more live here. You can share your settings with a QR code or link.',
  },
];

let currentStep = 0;
let placeholderRowsAdded = false;
let downloadShownByTutorial = false;
let appsMenuOpenedByTutorial = false;
let rafId = null;
let missingWarned = null;

// On demand only, from the header's ? button; never run automatically. A tour
// keyed on a localStorage flag would replay at every visit in any browser that
// drops its storage; a button asks nothing and can also RE-run the tour.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tutorial-open-btn')?.addEventListener('click', () => {
    if (document.getElementById('tutorial-backdrop')) return; // already running
    startTutorial();
  });
});

function startTutorial() {
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  buildUI();
  missingWarned = new Set();
  goToStep(0);
  // The one loop that owns the spotlight. Runs for the life of the tour and
  // reads the CURRENT step's CURRENT geometry every frame, and nothing else
  // in this file is allowed to set the clip-path.
  const tick = () => {
    updateSpotlight();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  // Focus goes to Next, stays inside the card, and returns to the menu button when the tour ends.
  window.cfDialog?.activate(document.getElementById('tutorial-card'), {
    opener, fallback: '#drawer-btn', initialFocus: document.getElementById('tut-next'),
  });
  document.addEventListener('keydown', tourKeys, true);
}

// Escape ends the tour (and is not passed on, so it cannot also collapse Advanced Settings);
// the arrow keys step through it.
function tourKeys(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    endTutorial();
  } else if (e.key === 'ArrowRight' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (currentStep < STEPS.length - 1) goToStep(currentStep + 1);
  } else if (e.key === 'ArrowLeft' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (currentStep > 0) goToStep(currentStep - 1);
  }
}

/**
 * The card's colours for the CURRENT theme and palette, read at tour start.
 *
 * A fixed light card would put a glowing white panel over a dimmed dark page,
 * so the card follows the theme. The accent comes from the live
 * --color-accent-500 token, so Modern dark shows Chambers Finder's orange and
 * Classic keeps its own navy accent, without this file knowing either value.
 */
function tutorialTone() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  // A filled button with white text: --orange-fill (4.5:1 on dark), or the accent where the palette has none.
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--orange-fill').trim()
    || styles.getPropertyValue('--color-accent-500').trim() || '#014889';
  return dark ? {
    accent,
    surface: '#1c1f27',
    border: 'rgba(255,255,255,0.12)',
    ink: '#f0ebe3',
    inkDim: 'rgba(240,235,227,0.66)',
    btnBg: 'rgba(255,255,255,0.06)',
    btnBorder: 'rgba(255,255,255,0.14)',
    dotIdle: 'rgba(255,255,255,0.22)',
    shadow: '0 24px 64px rgba(0,0,0,0.6)',
  } : {
    accent,
    surface: '#fff',
    border: '#e2e8f0',
    ink: '#0f172a',
    inkDim: '#475569',
    btnBg: '#f1f5f9',
    btnBorder: '#e2e8f0',
    dotIdle: '#cbd5e1',
    shadow: '0 24px 64px rgba(0,0,0,0.35)',
  };
}

let tone = null;

function buildUI() {
  tone = tutorialTone();
  const backdrop = document.createElement('div');
  backdrop.id = 'tutorial-backdrop';
  backdrop.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:10000',
    'background:rgba(0,0,0,0.55)', 'pointer-events:auto',
  ].join(';');
  backdrop.setAttribute('aria-hidden', 'true');

  const card = document.createElement('div');
  card.id = 'tutorial-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tut-title');
  card.setAttribute('aria-describedby', 'tut-body');
  card.style.cssText = [
    'position:fixed', 'z-index:10001',
    'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
    'width:min(500px,calc(100vw - 24px))',
    `background:${tone.surface}`, 'border-radius:16px',
    `box-shadow:${tone.shadow}`,
    `border:1px solid ${tone.border}`,
    'font-family:inherit',
  ].join(';');
  card.innerHTML = `
    <div style="padding:20px 22px 18px;">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px;">
        <div style="flex:1;min-width:0;">
          <div id="tut-counter" style="font-size:var(--fs-caption);color:${tone.inkDim};margin-bottom:3px;font-weight:500;"></div>
          <h3 id="tut-title" style="margin:0;font-size:var(--fs-heading);font-weight:700;color:${tone.ink};line-height:1.3;"></h3>
        </div>
        <button id="tut-skip" style="flex-shrink:0;padding:7px 14px;background:transparent;border:none;border-radius:8px;font-size:var(--fs-label);font-weight:600;color:${tone.inkDim};cursor:pointer;white-space:nowrap;line-height:1;">
          Skip tutorial
        </button>
      </div>
      <p id="tut-body" style="margin:0 0 16px;font-size:var(--fs-body);color:${tone.inkDim};line-height:1.65;"></p>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div id="tut-dots" style="display:flex;gap:5px;flex-shrink:0;"></div>
        <div style="display:flex;gap:8px;">
          <button id="tut-prev" style="padding:8px 16px;background:transparent;border:none;border-radius:8px;font-size:var(--fs-body);font-weight:500;color:${tone.inkDim};cursor:pointer;display:none;">
            Back
          </button>
          <button id="tut-next" style="padding:8px 22px;background:${tone.accent};border:none;border-radius:8px;font-size:var(--fs-body);font-weight:700;color:#fff;cursor:pointer;">
            Next
          </button>
        </div>
      </div>
    </div>`;

  // A screen reader hears each step announced (the visible title and text change under a focused
  // button, which would otherwise say nothing).
  const announce = document.createElement('div');
  announce.id = 'tut-announce';
  announce.setAttribute('aria-live', 'polite');
  announce.setAttribute('aria-atomic', 'true');
  announce.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
  card.appendChild(announce);

  document.body.appendChild(backdrop);
  document.body.appendChild(card);

  document.getElementById('tut-skip').addEventListener('click', endTutorial);
  document.getElementById('tut-prev').addEventListener('click', () => goToStep(currentStep - 1));
  document.getElementById('tut-next').addEventListener('click', () => {
    if (currentStep === STEPS.length - 1) endTutorial();
    else goToStep(currentStep + 1);
  });
}

function goToStep(index) {
  currentStep = index;
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  document.getElementById('tut-counter').textContent = `${index + 1} of ${STEPS.length}`;
  document.getElementById('tut-title').textContent = step.title;
  const bodyEl = document.getElementById('tut-body');
  const paras = Array.isArray(step.body) ? step.body : [step.body];
  bodyEl.innerHTML = paras.map((p, i) =>
    `<span style="${i > 0 ? 'display:block;margin-top:10px;' : ''}">${p}</span>`
  ).join('');
  document.getElementById('tut-next').textContent = isLast ? 'Finish' : 'Next';
  const announce = document.getElementById('tut-announce');
  if (announce) announce.textContent = `Step ${index + 1} of ${STEPS.length}. ${step.title}. ${bodyEl.textContent}`;
  document.getElementById('tut-prev').style.display = index === 0 ? 'none' : '';

  const dots = document.getElementById('tut-dots');
  dots.innerHTML = STEPS.map((_, i) => {
    const active = i === index;
    return `<div style="width:${active ? 18 : 6}px;height:6px;border-radius:3px;background:${active ? tone.accent : tone.dotIdle};transition:width 0.2s,background 0.2s;"></div>`;
  }).join('');

  clearPlaceholderRows();
  if (step.showPlaceholderRows) injectPlaceholderRows();
  hideDownloadDemo();
  if (step.showDownload) showDownloadDemo();

  // Close unconditionally first, the same contract as the placeholder rows
  // above: whichever step is being left gives up its demo state before
  // the new step decides whether it needs one.
  closeAppsMenuDemo();

  const reveal = () => {
    if (step.openAppsMenu) openAppsMenuDemo();
    // Bring the target into view. Only the scroll is requested here; the
    // spotlight itself follows the element frame by frame, so there is no
    // position to get wrong while the scroll is still travelling. Demo
    // state above is applied first so a target inside a just-opened drawer
    // already has real geometry to scroll to.
    if (step.element) scrollTargetIntoClearView(document.getElementById(step.element));
  };

  if (step.openAppsMenu) {
    // The click that landed on Next/Back is still bubbling past this point
    // up to the header's own "click outside closes the menu" listener (static/js/shared/drawer.js) on
    // document. Opening synchronously here means that same click closes it
    // again before a frame ever paints; one task later, that bubble has
    // finished and the menu stays open.
    setTimeout(reveal, 0);
  } else {
    reveal();
  }
}

/**
 * Scrolls the target into the part of the window the tutorial card does not
 * cover: centred there if it fits, otherwise its top edge just under the top of
 * the window. Plain "centre it" would put a tall target (the review table,
 * the sections column on a phone) half behind the card, which is fixed to the
 * bottom of the window.
 */
function scrollTargetIntoClearView(el) {
  if (!el) return;
  const card = document.getElementById('tutorial-card');
  const clearBottom = card ? card.getBoundingClientRect().top - 12 : window.innerHeight;
  const margin = 12;
  const rect = el.getBoundingClientRect();
  const room = clearBottom - margin;
  const wantedTop = rect.height >= room ? margin : margin + (room - rect.height) / 2;
  window.scrollBy({ top: rect.top - wantedTop, behavior: 'smooth' });
}

/**
 * Reads the current step's target where it is RIGHT NOW and clips the
 * backdrop around it. Called every animation frame while the tour is open.
 */
function updateSpotlight() {
  const backdrop = document.getElementById('tutorial-backdrop');
  if (!backdrop) return;
  const step = STEPS[currentStep];
  const el = step.element ? document.getElementById(step.element) : null;
  if (!el) {
    if (step.element && !missingWarned.has(step.element)) {
      missingWarned.add(step.element);
      console.warn(`[tutorial] step target #${step.element} is not on the page; no spotlight`);
    }
    if (backdrop.style.clipPath) backdrop.style.clipPath = '';
    return;
  }
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const t = Math.max(0, rect.top - pad);
  const l = Math.max(0, rect.left - pad);
  const b = Math.min(window.innerHeight, rect.bottom + pad);
  const r = Math.min(window.innerWidth, rect.right + pad);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const clip = `polygon(0px 0px,0px ${h}px,${l}px ${h}px,${l}px ${t}px,${r}px ${t}px,${r}px ${b}px,${l}px ${b}px,${l}px ${h}px,${w}px ${h}px,${w}px 0px)`;
  if (backdrop.style.clipPath !== clip) backdrop.style.clipPath = clip;
}

// The example rows are built by the same function as a real row, so they have
// the same columns, spacing and mobile card layout, and follow the theme. They
// carry `tutorial-row` instead of `file-row` so nothing that counts, saves or
// builds from the real rows (autosave, sorting, the build itself) can see them,
// and they are inert so they cannot be clicked or dragged. When the table is
// empty it is normally hidden behind the "Drag here" panel; for this step the
// page's own doc-state observer (updateDocState in bundletoolPage.js) shows the
// table while the rows are there and hides it again when they go.

function injectPlaceholderRows() {
  const tbody = document.getElementById('tbody-section-0000');
  if (!tbody) return;
  const rows = [
    { filename: 'claim-form-N1.pdf',           title: 'Claim Form (N1)',               date: '2024-01-15', pages: 4 },
    { filename: 'defence-2024-02-01.pdf',      title: 'Defence',                       date: '2024-02-01', pages: 7 },
    { filename: 'witness-statement-jones.pdf', title: 'Witness Statement of Mr Jones', date: '2024-03-20', pages: 12 },
  ];
  for (const r of rows) {
    const tr = makeFileRow(r.filename, {});
    tr.classList.remove('file-row', 'transition');
    tr.classList.add('tutorial-row');
    tr.dataset.tutorialPlaceholder = 'true';
    delete tr.dataset.filename;
    tr.draggable = false;
    tr.inert = true;
    tr.setAttribute('aria-hidden', 'true');
    tr.querySelector('.title-input').value = r.title;
    tr.querySelector('.date-input').value = r.date;
    tr.querySelector('.pages-cell').textContent = String(r.pages);
    tbody.appendChild(tr);
  }
  placeholderRowsAdded = true;
}

function clearPlaceholderRows() {
  if (!placeholderRowsAdded) return;
  document.querySelectorAll('[data-tutorial-placeholder]').forEach(r => r.remove());
  placeholderRowsAdded = false;
}

// The Review Table's Download button is hidden until there is a document, and the example rows are not documents, so
// the Review Table step shows it itself while it is on screen, inert like the rows. The data attribute keeps
// reviewTableHeader.js from hiding it again when the example rows go in.
function showDownloadDemo() {
  const btn = document.getElementById('download-docs-btn');
  if (!btn || !btn.hidden) return;
  btn.dataset.tutorialDemo = 'true';
  btn.inert = true;
  btn.hidden = false;
  downloadShownByTutorial = true;
}

function hideDownloadDemo() {
  if (!downloadShownByTutorial) return;
  const btn = document.getElementById('download-docs-btn');
  if (btn) {
    delete btn.dataset.tutorialDemo;
    btn.inert = false;
    btn.hidden = !document.querySelector('.section-tbody tr.file-row');
  }
  downloadShownByTutorial = false;
}

// Opens and closes the header menu (the shared drawer: #drawer-btn and
// #drawer-panel, hidden through the `hidden` attribute), so a step that points
// at a menu item has a real, measurable target instead of one inside a closed
// menu.
function openAppsMenuDemo() {
  const btn = document.getElementById('drawer-btn');
  const menu = document.getElementById('drawer-panel');
  if (!btn || !menu) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  appsMenuOpenedByTutorial = true;
}

function closeAppsMenuDemo() {
  if (!appsMenuOpenedByTutorial) return;
  const menu = document.getElementById('drawer-panel');
  if (menu) menu.hidden = true;
  document.getElementById('drawer-btn')?.setAttribute('aria-expanded', 'false');
  appsMenuOpenedByTutorial = false;
}

function endTutorial() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  clearPlaceholderRows();
  hideDownloadDemo();
  closeAppsMenuDemo();
  document.removeEventListener('keydown', tourKeys, true);
  const card = document.getElementById('tutorial-card');
  if (card) window.cfDialog?.deactivate(card);   // while it is still in the page, so focus can go back
  document.getElementById('tutorial-backdrop')?.remove();
  card?.remove();
}
