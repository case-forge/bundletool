/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * emailSplit.js
 * The "Split for email" modal: settings in, measured parts out.
 *
 * Entry points hand a finished bundle's bytes to openEmailSplit(): the
 * bundle-ready overlay (bundleUI.js) and each row of the Recent bundles
 * modal (frontend.js). The engine is bundletoolSplit.js; this file only
 * collects the settings, shows progress, and hands the parts back as
 * downloads: <bundle>-part-1-of-3.pdf when split by size, and
 * "<Bundle title> - A Applications.pdf" when split by section, singly or
 * together in one zip.
 */
import { triggerDownload } from './bundleUI.js';
import { showErrorModal } from './modals.js';
import { zipStore } from '../bundletoolZip.js';
import { lazyImport } from '/js/shared/lazy-load.js';

let _bytes = null;
let _filename = '';
let _parts = null;
let _mode = 'size';
let _openId = 0;
let _running = false;
let _onCancel = null;

const $ = (id) => document.getElementById(id);

function mb(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Text safe to put in a file name: no path or reserved characters, one space at a time, no trailing dot. */
export function fileSafe(text, max = 80) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[ .]+$/, '');
}

/**
 * A section-split part is named "<Bundle title> - A Applications.pdf" (the cover and index
 * "<Bundle title> - Cover and index.pdf", a section that was cut by size "... - Part 1 of 2.pdf");
 * a size-split part keeps "<file>-part-N-of-M.pdf".
 */
function partFilename(base, part) {
  const stem = base.replace(/\.pdf$/i, '');
  const sectionTag = [part.sectionLabel, part.sectionName].filter(Boolean).join(' ').trim();
  if (part.kind || sectionTag) {
    const title = fileSafe(part.bundleTitle || stem, 100) || 'Bundle';
    const what = part.kind === 'front' ? 'Cover and index'
      : fileSafe(sectionTag) || (part.kind === 'whole' ? 'Whole bundle' : `Section ${part.partNumber}`);
    const sub = part.subPartCount > 1 ? ` - Part ${part.subPart} of ${part.subPartCount}` : '';
    return `${title} - ${what}${sub}.pdf`;
  }
  return `${stem}-part-${part.partNumber}-of-${part.partCount}.pdf`;
}

/**
 * A filename for every part, all different: two sections whose labels and names come out the same
 * once punctuation is dropped would otherwise download over each other (and could not share a zip),
 * so a repeat gets its part number added.
 */
export function partFilenames(base, parts) {
  const seen = new Set();
  return parts.map((part) => {
    let name = partFilename(base, part);
    if (seen.has(name.toLowerCase())) name = name.replace(/\.pdf$/i, ` - part ${part.partNumber}.pdf`);
    seen.add(name.toLowerCase());
    return name;
  });
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Section names come out of the PDF's own metadata, so they are text, never markup. */
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function showForm() {
  $('email-split-form')?.classList.remove('hidden');
  $('email-split-progress')?.classList.add('hidden');
  $('email-split-results')?.classList.add('hidden');
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {Object} [opts]
 * @param {() => void} [opts.onCancel] - run once, when the modal closes with
 *   no parts produced (Cancel/close, or Escape). Every caller opens this
 *   modal by hiding whatever screen was showing the finished bundle first
 *   (the bundle-preview modal, the "Bundle ready!" overlay, or the Recent
 *   bundles list). Without this, cancelling would leave nothing visible at
 *   all, which reads as the bundle having been lost although it is still in
 *   memory. Each caller's onCancel re-shows exactly the screen it hid.
 */
export function openEmailSplit(bytes, filename, opts = {}) {
  _bytes = bytes;
  _filename = filename || 'bundle.pdf';
  _parts = null;
  _onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
  const source = $('email-split-source');
  if (source) source.textContent = `${_filename} · ${mb(bytes.length)}`;
  showForm();
  resetChoices();
  $('email-split-modal')?.classList.remove('hidden');
  inspectSections(bytes, ++_openId);
}

/** The form as it opens: the Advanced Settings default (size unless set to section), part covers on, section choice waiting on the bundle's own index. */
function resetChoices() {
  const size = document.querySelector('input[name="email-split-by"][value="size"]');
  const section = document.querySelector('input[name="email-split-by"][value="section"]');
  if (section) section.disabled = false;
  // Advanced Settings > Split for Email > Default Split. Only a starting choice: the person can switch
  // here, and inspectSections() puts it back to size when the PDF records no sections.
  const wantSection = document.getElementById('config-splitBy')?.value === 'section';
  if (wantSection && section) section.checked = true;
  else if (size) size.checked = true;
  const cover = document.querySelector('input[name="email-split-labelling"][value="cover"]');
  if (cover) cover.checked = true;
  const own = document.querySelector('input[name="email-split-labelling"][value="own"]');
  if (own) own.disabled = false;
  showBy(wantSection ? 'section' : 'size');
  const note = $('email-split-sections-note');
  if (note) note.textContent = '';
}

/** Reads the sections the bundle records, so the dialog can say what a split by section would give. */
async function inspectSections(bytes, id) {
  const note = $('email-split-sections-note');
  const section = document.querySelector('input[name="email-split-by"][value="section"]');
  try {
    const { inspectBundleForSplit } = await lazyImport(new URL('../bundletoolSplit.js', import.meta.url));
    const info = await inspectBundleForSplit(bytes);
    if (id !== _openId) return;
    if (info.sections.length === 0) {
      if (section) section.disabled = true;
      const bySize = document.querySelector('input[name="email-split-by"][value="size"]');
      if (bySize) bySize.checked = true;
      showBy('size');
      // An index of their own is drawn from the bundle's own record of its documents: without it, only a cover or nothing.
      const own = document.querySelector('input[name="email-split-labelling"][value="own"]');
      if (own) {
        own.disabled = true;
        if (own.checked) { const cover = document.querySelector('input[name="email-split-labelling"][value="cover"]'); if (cover) cover.checked = true; }
      }
      if (note) note.textContent = 'This PDF does not record its sections, so it can only be split by size, and its parts cannot have an index of their own.';
      return;
    }
    const names = info.sections.map((sec) => [sec.label, sec.name].filter(Boolean).join(' ') || 'Untitled').join(', ');
    if (note) note.textContent = `${info.sections.length} ${info.sections.length === 1 ? 'section' : 'sections'}: ${names}. The cover and index come as a part of their own.`;
  } catch {
    // Unreadable here means unreadable to the split too, which will say so; leave the choice as it is.
  }
}

/** Shows the hints and options that belong to a way of splitting. */
function showBy(by) {
  const bySection = by === 'section';
  $('email-split-how-options')?.classList.toggle('hidden', bySection);
  $('email-split-target-hint-size')?.classList.toggle('hidden', bySection);
  $('email-split-target-hint-section')?.classList.toggle('hidden', !bySection);
  $('email-split-general-hint-size')?.classList.toggle('hidden', bySection);
  $('email-split-general-hint-section')?.classList.toggle('hidden', !bySection);
}

function closeModal() {
  if (_running) return; // a split in flight finishes or fails; no half-state
  $('email-split-modal')?.classList.add('hidden');
  _bytes = null;
  _parts = null;
  const onCancel = _onCancel;
  _onCancel = null;
  // Restores whatever screen the caller hid to open this modal, whether the
  // close happens from Cancel, the X, or after downloading parts: there is
  // no case where leaving nothing visible underneath is correct.
  onCancel?.();
}

async function runSplit() {
  if (!_bytes || _running) return;
  const targetMb = Number($('email-split-target')?.value);
  if (!Number.isFinite(targetMb) || targetMb < 1) {
    showErrorModal({ code: 'BT-SPLIT-01', title: 'Split target too small', message: 'The part size needs to be at least 1 MB.' });
    return;
  }
  const splitBySection = document.querySelector('input[name="email-split-by"]:checked')?.value === 'section';
  const mode = splitBySection ? 'section'
    : document.querySelector('input[name="email-split-mode"]:checked')?.value === 'fill' ? 'fill' : 'even';
  const labelling = document.querySelector('input[name="email-split-labelling"]:checked')?.value || 'cover';

  const progress = $('email-split-progress');
  $('email-split-form')?.classList.add('hidden');
  progress?.classList.remove('hidden');
  _running = true;
  try {
    const { splitForEmail } = await lazyImport(new URL('../bundletoolSplit.js', import.meta.url));
    const parts = await splitForEmail(_bytes, {
      // Decimal megabytes on purpose: the ceiling this is measured against is
      // a decimal 25,000,000 bytes, so MiB here would waste real headroom.
      targetBytes: Math.round(targetMb * 1_000_000),
      mode,
      partCover: labelling !== 'seamless',
      labelling,
      onProgress: (label) => { if (progress) progress.textContent = label; },
    });
    _parts = parts;
    _mode = splitBySection ? 'section' : 'size';
    renderResults(parts);
  } catch (error) {
    showForm();
    showErrorModal({ code: 'BT-SPLIT-02', title: 'Could not split the bundle', message: 'Something went wrong while splitting the bundle.', error });
  } finally {
    _running = false;
    progress?.classList.add('hidden');
  }
}

function partTitle(p) {
  if (p.kind === 'front') return 'Cover and index';
  if (p.kind === 'section' || p.kind === 'whole') {
    const tag = [p.sectionLabel, p.sectionName].filter(Boolean).join(' ') || `Section ${p.partNumber}`;
    return p.subPartCount > 1 ? `${tag} (part ${p.subPart} of ${p.subPartCount})` : tag;
  }
  return `Part ${p.partNumber} of ${p.partCount}`;
}

function renderResults(parts) {
  const list = $('email-split-results-list');
  if (!list) return;
  const names = partFilenames(_filename, parts);
  const single = parts.length === 1 && !parts[0].oversize;
  $('email-split-download-all')?.classList.toggle('hidden', single);
  $('email-split-download-zip')?.classList.toggle('hidden', single);
  if (single) {
    list.innerHTML = _mode === 'section'
      ? `<p class="text-sm text-gray-700 dark:text-slate-300">This bundle has a single section and nothing ahead of it, so there is nothing to split by section.</p>`
      : `<p class="text-sm text-gray-700 dark:text-slate-300">This bundle already fits in one email at that size (${mb(parts[0].bytes.length)}), so there is nothing to split. You can lower the part size, or just attach the bundle as it is.</p>`;
  } else {
    list.innerHTML = parts.map((p, i) => `
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg border ${p.oversize ? 'border-amber-400 dark:border-amber-600' : 'border-gray-200 dark:border-slate-600'} text-xs">
        <div class="flex-1 min-w-0">
          <span class="font-medium text-gray-800 dark:text-slate-200 block">${esc(partTitle(p))} · ${mb(p.bytes.length)}</span>
          <span class="block text-gray-600 dark:text-slate-400">${esc(p.pagesLabel ? p.pagesLabel.replace(/ of \d+$/, '') : `pages ${p.fromPage}-${p.toPage}`)}${p.own ? esc(`; ${p.documents} ${p.documents === 1 ? 'document' : 'documents'}, its own index, numbered from 1`) : ''}</span>
          <span class="split-part-name block text-gray-600 dark:text-slate-400">${esc(names[i])}</span>
          ${p.oversize ? '<span class="text-amber-700 dark:text-amber-400">This part is over the target size, so it may bounce. Consider compressing its documents or lowering the part size.</span>' : ''}
        </div>
        <button type="button" data-part="${i}" class="email-split-download shrink-0 px-3 py-1.5 text-xs font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition" aria-label="Download ${esc(names[i])}">
          Download
        </button>
      </div>`).join('');
    list.querySelectorAll('.email-split-download').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.part);
        const p = _parts?.[i];
        if (p) triggerDownload(p.bytes, names[i]);
      });
    });
  }
  $('email-split-results')?.classList.remove('hidden');
}

export function setup() {
  $('email-split-close')?.addEventListener('click', closeModal);
  $('email-split-cancel')?.addEventListener('click', closeModal);
  $('email-split-run')?.addEventListener('click', runSplit);
  $('email-split-again')?.addEventListener('click', showForm);
  $('email-split-download-all')?.addEventListener('click', () => {
    if (!_parts) return;
    const names = partFilenames(_filename, _parts);
    _parts.forEach((p, i) => triggerDownload(p.bytes, names[i]));
  });
  $('email-split-download-zip')?.addEventListener('click', () => {
    if (!_parts) return;
    try {
      const names = partFilenames(_filename, _parts);
      const zip = zipStore(_parts.map((p, i) => ({ name: names[i], bytes: p.bytes })));
      triggerDownload(zip, `${_filename.replace(/\.pdf$/i, '')} - parts.zip`, 'application/zip');
    } catch (error) {
      showErrorModal({ code: 'BT-SPLIT-03', title: 'Could not make the zip', message: 'The parts could not be gathered into one zip. Download them one at a time instead.', error });
    }
  });

  // Slider and number stay one control: move either, the other follows.
  const slider = $('email-split-target-slider');
  const number = $('email-split-target');
  slider?.addEventListener('input', () => { if (number) number.value = slider.value; });
  number?.addEventListener('input', () => {
    const v = Number(number.value);
    if (slider && Number.isFinite(v)) slider.value = String(Math.min(25, Math.max(1, Math.round(v))));
  });

  // "How to split" (even/fill) only means anything when splitting by size, and the size hint swaps
  // to say what the same number means once a section, not the size, decides where the cuts fall.
  // Parts split by section default to seamless, so their footers read exactly as in the whole bundle.
  document.querySelectorAll('input[name="email-split-by"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      showBy(radio.value);
      const wanted = document.querySelector(`input[name="email-split-labelling"][value="${radio.value === 'section' ? 'seamless' : 'cover'}"]`);
      // Only the cover and seamless styles follow the way of splitting; a chosen index of their own stays chosen.
      if (wanted && !document.querySelector('input[name="email-split-labelling"][value="own"]:checked')) wanted.checked = true;
    });
  });
}
