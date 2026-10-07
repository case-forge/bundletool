/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * documentDownload.js
 * The Review Table's Download button: a picker in the shape of "Add files to which section?" (each section by its
 * label and name, "Not in a section" when some documents are in none, "Only documents BundleTool changed" when there
 * are any, and "All documents"), then the documents as BundleTool holds them, after conversion, turning and OCR. One
 * document comes down as that PDF; more than one as a zip (the same writer as the email split's parts), each file
 * numbered by its place in the bundle, "01 - <title>.pdf". "All documents" and the changed documents come with a
 * folder for each section ("A - <section name>/"), and "Not in a section/" when needed. A zip is named after the
 * bundle title when there is one.
 *
 * Loaded on first use (reviewTableHeader.js imports it lazily).
 */
import { state } from './state.js';
import { triggerDownload, showProcessingOverlay, hideProcessingOverlay } from './bundleUI.js';
import { showErrorModal } from './modals.js';
import { fileSafe } from './emailSplit.js';
import { prettifyTitle, stripDoubleChars } from './utils.js';
import { zipStore } from '../bundletoolZip.js';

const NOT_IN_A_SECTION = 'Not in a section';
const ALL_DOCUMENTS = 'All documents';
const CHANGED_DOCUMENTS = 'Only documents BundleTool changed';

/**
 * Whether the bytes BundleTool holds for a document differ from the file the person added: converted from a Word
 * document or a photo, given an OCR text layer, or turned or with a page removed in the document window.
 */
export function changedByBundleTool(info) {
  return Boolean(info && (info.convertedFromDocx || info.convertedFromImage || info.ocrApplied || info.pagesChanged));
}

const heldChanged = (filename) => changedByBundleTool(state.frontendInputData[filename]);

/**
 * The Review Table's documents, in bundle order: one group for each section, and one group (`section: null`) for the
 * documents in no section. While the bundle has no sections every document is in that one group.
 * @returns {Array<{section: {label: string, name: string}|null, files: string[]}>} files are state.filesMap keys
 */
export function readGroups(doc = document, sectioned = state.isSectioned) {
  const groups = [];
  let loose = null;
  for (const tbody of Array.from(doc.querySelectorAll('.section-tbody'))) {
    const files = Array.from(tbody.querySelectorAll('tr.file-row')).map((row) => row.dataset.filename).filter(Boolean);
    const header = sectioned ? tbody.querySelector('.section-header-row') : null;
    if (header) {
      const labelEl = header.querySelector('.section-label-input');
      groups.push({
        section: {
          label: labelEl?.value.trim() || labelEl?.placeholder || '',
          name: header.querySelector('.section-name-input')?.value.trim() || '',
        },
        files,
      });
    } else {
      if (!loose) groups.push(loose = { section: null, files: [] });
      loose.files.push(...files);
    }
  }
  return groups;
}

/** How a section is named in the picker, as in "Add files to which section?". */
function sectionTitle({ label, name }) {
  return label && name ? `${label}: ${name}` : (name || label || '(unnamed)');
}

/**
 * The picker's choices, in order: each section that holds a document, "Not in a section" when the bundle has
 * sections and some documents are in none of them, "Only documents BundleTool changed" when any document is one, and
 * "All documents".
 * @param {{isChanged?: (filename: string) => boolean}} [opts]
 * @returns {Array<{kind: 'section'|'loose'|'changed'|'all', index?: number, label: string}>}
 */
export function downloadChoices(groups, { isChanged = heldChanged } = {}) {
  const choices = [];
  groups.forEach((g, index) => {
    if (g.section && g.files.length) choices.push({ kind: 'section', index, label: sectionTitle(g.section) });
  });
  const looseIndex = groups.findIndex((g) => !g.section && g.files.length);
  if (looseIndex !== -1 && groups.some((g) => g.section)) choices.push({ kind: 'loose', index: looseIndex, label: NOT_IN_A_SECTION });
  if (groups.some((g) => g.files.some(isChanged))) choices.push({ kind: 'changed', label: CHANGED_DOCUMENTS });
  if (groups.some((g) => g.files.length)) choices.push({ kind: 'all', label: ALL_DOCUMENTS });
  return choices;
}

/** A section's folder (and zip) name: "A - Applications". */
function folderName(group) {
  if (!group.section) return NOT_IN_A_SECTION;
  const { label, name } = group.section;
  return fileSafe(label && name ? `${label} - ${name}` : (label || name)) || 'Section';
}

/** The index title of a document, as its file name will carry it. */
export function documentTitle(filename) {
  return state.frontendInputData[filename]?.title?.trim() || stripDoubleChars(prettifyTitle(filename));
}

/** A document's part of a file name: its title, never ending in a second ".pdf". */
function documentName(filename, titleOf) {
  return fileSafe(String(titleOf(filename) ?? '').replace(/\.pdf$/i, '')) || fileSafe(filename.replace(/\.[^.]*$/, '')) || 'Document';
}

/** `name`, or "name (2)" and so on when a name is taken already: two sections can be called the same. */
function unique(name, used) {
  let out = name;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${name} (${n})`;
  used.add(out.toLowerCase());
  return out;
}

/**
 * What a choice downloads: every file with the path it takes, and the download's own name. A document keeps its
 * place in its section as its number, so a changed document has the same name it has among all of them.
 * @param {{kind: string, index?: number}} choice  one of downloadChoices()
 * @param {ReturnType<typeof readGroups>} groups
 * @param {{bundleTitle?: string, titleOf?: (filename: string) => string, isChanged?: (filename: string) => boolean}} [opts]
 * @returns {{zip: boolean, name: string, files: Array<{filename: string, path: string}>}}
 */
export function downloadPlan(choice, groups, { bundleTitle = '', titleOf = documentTitle, isChanged = heldChanged } = {}) {
  const whole = choice.kind === 'all' || choice.kind === 'changed';
  const wanted = choice.kind === 'changed' ? isChanged : () => true;
  // Folders are named over every section with documents, so a folder is called the same whichever choice made it.
  const picked = whole ? groups.filter((g) => g.files.length) : [groups[choice.index]];
  const withFolders = whole && groups.some((g) => g.section);
  const folders = new Set();
  const files = [];
  for (const group of picked) {
    const folder = withFolders ? unique(folderName(group), folders) : '';
    const width = Math.max(2, String(group.files.length).length);
    group.files.forEach((filename, i) => {
      if (!wanted(filename)) return;
      const name = `${String(i + 1).padStart(width, '0')} - ${documentName(filename, titleOf)}.pdf`;
      files.push({ filename, path: folder ? `${folder}/${name}` : name });
    });
  }
  if (files.length === 1) return { zip: false, name: `${documentName(files[0].filename, titleOf)}.pdf`, files };
  const what = choice.kind === 'all' ? ALL_DOCUMENTS : choice.kind === 'changed' ? 'Changed documents' : folderName(groups[choice.index]);
  const title = fileSafe(bundleTitle, 100);
  return { zip: true, name: `${title ? `${title} - ` : ''}${what}.zip`, files };
}

/**
 * The bytes of a plan, read from the files BundleTool holds: the PDF itself, or the zip.
 * @returns {Promise<{name: string, bytes: Uint8Array, type: string}>}
 */
export async function downloadBytes(plan, filesMap = state.filesMap) {
  const entries = [];
  for (const f of plan.files) {
    const file = filesMap.get(f.filename);
    if (file) entries.push({ name: f.path, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  if (!entries.length) throw new Error('None of these documents is held any more');
  if (!plan.zip) return { name: plan.name, bytes: entries[0].bytes, type: 'application/pdf' };
  return { name: plan.name, bytes: zipStore(entries), type: 'application/zip' };
}

async function download(choice, groups) {
  const bundleTitle = document.getElementById('config-bundleTitle')?.value ?? '';
  showProcessingOverlay('Preparing the download…');
  try {
    const out = await downloadBytes(downloadPlan(choice, groups, { bundleTitle }));
    triggerDownload(out.bytes, out.name, out.type);
  } catch (error) {
    showErrorModal({
      code: 'BT-DL-01',
      title: 'Could not download the documents',
      message: 'The documents could not be gathered for download. Nothing in the bundle has changed.',
      error,
    });
  } finally {
    hideProcessingOverlay();
  }
}

let wired = false;

/** Opens the picker. Section labels and names are untrusted text, so each choice is set as text, never markup. */
export function openDownloadPicker() {
  const popover = document.getElementById('download-picker-popover');
  const list = document.getElementById('download-picker-list');
  if (!popover || !list) return;
  if (!wired) {
    wired = true;
    document.getElementById('download-picker-cancel')?.addEventListener('click', () => popover.classList.add('hidden'));
  }
  const groups = readGroups();
  list.replaceChildren();
  for (const choice of downloadChoices(groups)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'w-full text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bt-hover-line bt-hover-tint transition text-sm font-medium bt-ink';
    button.textContent = choice.label;
    button.addEventListener('click', () => {
      popover.classList.add('hidden');
      download(choice, groups);
    });
    list.appendChild(button);
  }
  popover.classList.remove('hidden');
}
