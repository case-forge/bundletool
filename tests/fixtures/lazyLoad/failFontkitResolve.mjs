/**
 * A Node loader hook, registered only by fontkitSignalRace.test.mjs (module.register() scopes a hook to
 * the registering process, and node --test gives every matched test FILE its own process, so this never
 * reaches any other test file's run). Redirects every resolution of
 * /vendor/pdf-lib-fontkit.js, including lazyImport()'s own cache-busted retry (the same path with a
 * ?cfRetry=... query), to a file that does not exist, so the real bundletoolPdfLib.js code under test
 * fails for a genuine reason (ENOENT) rather than a fixture standing in for it.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/vendor/pdf-lib-fontkit.js')) {
    return nextResolve('/vendor/this-definitely-does-not-exist.js', context);
  }
  return nextResolve(specifier, context);
}
