/**
 * Shared call counter for flaky.mjs. Its own specifier never changes between a lazyImport() attempt and
 * its cache-busted retry (only flaky.mjs's specifier gains a query string), so this one module instance
 * is reused across both, which is how the retry is told apart from a second, unrelated import.
 */
let callCount = 0;

export function nextCallFails() {
  callCount++;
  return callCount === 1;
}

export function resetFlaky() {
  callCount = 0;
}
