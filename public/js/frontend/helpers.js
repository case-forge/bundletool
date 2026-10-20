/** Tiny DOM-query helpers used across multiple frontend submodules. */

export function getDefaultSection0000() {
  return document.getElementById('tbody-section-0000');
}

export function getAllSectionTbodys() {
  return Array.from(document.querySelectorAll('.section-tbody'));
}

export function getAllFileRows() {
  return Array.from(document.querySelectorAll('.section-tbody tr.file-row'));
}

export function pulseStep2() {
  const step2 = document.getElementById('file-drop-zone');
  if (!step2) return;
  step2.scrollIntoView({ behavior: 'smooth', block: 'center' });
  step2.classList.add('pulse-ring');
  setTimeout(() => step2.classList.remove('pulse-ring'), 1500);
}
