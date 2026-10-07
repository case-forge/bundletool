/**
 * The three cover fields that follow Basic Information until the coversheet is
 * changed on its own: Case Reference, Bundle Title and Prepared By.
 *
 * Basic Information fills the coversheet: change the bundle title there and the
 * cover says the same. But a coversheet edit stays on the coversheet:
 * a cover title different from the bundle title, or a different
 * "Prepared by", is fine and must not change Basic Information. So the cover keeps
 * an override of its own for each field. No override (null) means "follow Basic
 * Information"; an override, even an empty one, is what the cover shows whatever
 * Basic Information says afterwards.
 *
 * The overrides live in hidden inputs (data-override="1" marks a real one), so the
 * autosave, the form draft and a reopened bundle can carry them like any field.
 */
export const COVER_FOLLOW = [
  { ce: 'ce-claimNumber', basic: 'config-claimNumber', own: 'config-coverClaimNumber', key: 'claimNumber' },
  { ce: 'ce-bundleTitle', basic: 'config-bundleTitle', own: 'config-coverBundleTitle', key: 'bundleTitle' },
  { ce: 'ce-author',      basic: 'config-author',      own: 'config-coverAuthor',      key: 'author' },
];

/** The override, or null when the cover follows Basic Information. */
export function getCoverOverride(id) {
  const el = document.getElementById(id);
  return el && el.dataset.override === '1' ? el.value : null;
}

/** Sets an override, or clears it with null/undefined. */
export function setCoverOverride(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === null || value === undefined) {
    el.value = '';
    delete el.dataset.override;
  } else {
    el.value = String(value);
    el.dataset.override = '1';
  }
}

/** Every cover field back to following Basic Information. */
export function clearCoverOverrides() {
  for (const f of COVER_FOLLOW) setCoverOverride(f.own, null);
}
