# Version-stamped file names

BundleTool serves its scripts and fonts under plain names, such as `public/js/frontend.js`, with `Cache-Control: no-cache`, so a browser checks each file with the server on every visit. A file whose name carries a stamp of its own content, such as `frontend.3fa9c1d2.js`, can instead be cached for a year, because a changed file gets a new name.

This page sets out how to do that for BundleTool, what it is worth and where the traps are. It is a design, not a feature: none of it is built into the tool. It is written for anyone who wants to take it on.

## What it is worth

- **Fewer requests on a repeat visit.** Measured on the live site: about 91 fewer requests, and about 1.3 seconds saved on a 4G connection.
- **Only for a visitor without the offline copy.** With the offline copy installed (`docs/offline-mode.md`), a repeat visit makes no requests for these files at all. In practice, the gain reaches a browser that blocks service workers, a private window, and the first visit after site data is cleared.
- **Files from two versions can never meet in one page.** A page asks for the names it was built with. The offline copy already guarantees this in its own way (`docs/offline-mode.md`, "Reload to continue"), so stamped names would be a second guarantee, not the only one.
- **Preloading becomes worthwhile.** Once a file can be cached for a year, `<link rel="modulepreload">` for the scripts every visit needs pays for itself.

Weigh that against a build step that every change to the tool's scripts then goes through.

## Why renaming the files is not enough

- **The scripts import each other by name.** BundleTool has over a hundred script files that import one another by relative name (`import './state.js'`), and many are loaded on first use with `new URL('./rotate.js', import.meta.url)`. Renaming a file breaks every import that names it unless the importing file is rewritten as well. Rewriting that file changes its own stamp, which means rewriting every file that imports it in turn, and so on up the graph. Where two files import each other, that never settles.
- **A stamp in the query string does not reach past the first file.** `frontend.js?v=3fa9c1` stamps the one address written in the page. A relative import inside that module resolves to the plain name with no query string, so every file below the entry point stays unstamped.
- **Hugo's `fingerprint` renames a file but does not rewrite imports inside other files.** It suits files nothing imports. The shared header, footer, drawer and bug report scripts and styles use it already (`layouts/partials/shared/asset-url.html`) and are served from `/built/` with a year's cache.

## The design

There are two parts, because the page and its workers resolve imports in different ways.

### The page's scripts: an import map

The build copies each script to a stamped name, using a hash of that file's own bytes only, and writes an import map from each plain address to its stamped one:

```html
<script type="importmap">
{ "imports": {
  "/bundletool/js/frontend.js": "/bundletool/js/frontend.3fa9c1d2.js",
  "/bundletool/js/frontend/rotate.js": "/bundletool/js/frontend/rotate.91be04aa.js"
} }
</script>
```

The browser applies the map to every module address after resolving it. That covers static imports, `import()` and `import(new URL('./rotate.js', import.meta.url))` alike. No source file changes, and no file's bytes contain another file's stamp, so files that import each other in a cycle are no problem.

The import map must come before the first module script, and a page has one. Every browser BundleTool supports reads import maps.

### The workers: one bundle each

A worker does not see the page's import map. Each of the four workers in `public/js/workers/` is bundled with esbuild into a single file, and that file is stamped. Two details matter.

- **esbuild does not rewrite `new URL(...)` worker addresses.** It rewrites `import()`, but `new URL('./workers/bundletoolBuildWorker.js', import.meta.url)` passes through unchanged. Replace each such address with a lookup in a table that esbuild's `define` writes into every file it builds, during the same pass that stamps that file:

  ```js
  // An esbuild plugin: a worker address becomes a lookup; a worker that starts a copy of itself needs none.
  function workerAddresses(selfName, workerNames) {
    const re = (name) => new RegExp(`new URL\\(\\s*(['"])\\.{0,2}/?workers/${name}\\.js\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`, 'g');
    return {
      name: 'worker-addresses',
      setup(build) {
        build.onLoad({ filter: /\.js$/ }, async (args) => {
          let text = await fs.promises.readFile(args.path, 'utf8');
          const before = text;
          if (selfName) text = text.replace(re(selfName), 'new URL(import.meta.url)');
          for (const name of workerNames) {
            if (name !== selfName) text = text.replace(re(name), `new URL(__WORKER_URLS__.${name}, location.origin)`);
          }
          return text === before ? null : { contents: text, loader: 'js' };
        });
      },
    };
  }

  // Each worker is built in turn, with the stamped addresses of those already built:
  // define: { __WORKER_URLS__: JSON.stringify(stampedWorkerAddresses) }
  ```

- **Never write one file's stamp into another file's bytes.** A worker that starts a copy of itself would need its own stamp inside itself, which cannot be computed. `new URL(import.meta.url)` is that worker's own address, stamped or not, and needs no lookup.

The libraries' own workers (pdf.js and the text-reading engine) are shared files under `/vendor/`, which are cached on their own terms.

### Fonts

`public/js/bundletoolFontSettings.js` works out where the fonts live from its own address: `computeBasePrefix()` cuts it at `/js/`. A bundled file's address has no `/js/` in it. Stamped fonts take the same lookup-table approach as the workers, falling back to the plain path when the table is absent, which is how the command line and the tests run.

## The traps

1. **Response headers merge, they do not override.** On Cloudflare Pages, two `_headers` rules that match the same address join their values with a comma: a narrower rule does not replace a wider one. A `max-age=31536000` rule for `/bundletool/fonts/*` next to the `no-cache` rule for `/bundletool/*` produces `no-cache, max-age=31536000`. Put stamped files under an address that no `no-cache` rule matches, as `/built/` is.
2. **The Content Security Policy needs the import map's hash.** An import map has to be written into the page, because browsers do not load one from a separate file. `script-src` then needs its SHA-256 hash, which changes with every build, so the build writes it into `static/_headers`.
3. **The retry asks for the plain name.** When a file fails to load, `static/js/shared/lazy-load.js` retries once with `?cfRetry=` added to the address. An import map matches whole addresses, so the retry asks for the plain file. Either keep publishing the plain files beside the stamped ones, or have the retry look the address up in the map first.
4. **Only the current deploy's files exist.** Cloudflare Pages serves one deploy at a time. A page left open across a deploy asks for stamps that are gone, the load fails and the page shows "This page needs reloading to continue.", which is the right outcome (`docs/offline-mode.md`).
5. **The offline copy lists files by name.** `scripts/build-offline.mjs` names every file the offline copy stores and checks each against a hash, so it reads the stamped names from the build's list rather than the source folders.
6. **Checks that find files by name need telling.** A test that searches the repository for a word, such as a retired font's name, also finds it in the bundled output under a stamped name. The link check and the missing-file check see generated names too. Leave the build output out of all three. It is generated on every build and never committed.
7. **The command line and the tests stay on the plain source.** They run `public/js/` directly in Node. Only the browser gets stamped files.
8. **Check the output before publishing it.** After the build, every address in every built file must name a file the build wrote; otherwise a missed rewrite ships as a failed load the first time someone uses that feature. Strip comments before scanning, because a JSDoc type such as `import('./bundletoolOcr.js').OcrWord` looks like an import to a text search.
9. **Bundling the page's scripts misses the first-use loads.** If esbuild bundles the page's scripts instead of an import map naming them, every `new URL('./x.js', import.meta.url)` load is left pointing at a plain file the bundle does not contain, because esbuild follows `import()` but not that form. The output check in trap 8 catches it. The import map has no such gap.

## Measuring it

Measure a repeat visit with the offline copy switched off (`?nosw=1`, see `docs/offline-mode.md`) on a throttled 4G connection, before and after: count the requests and time how long the tool takes to be ready to use.
