# Offline mode

BundleTool opens and works with the network switched off, after one visit. Everything it does already happens in the browser, so offline mode is a matter of keeping the tool's own files where the browser can find them without a connection.

## What works offline

The app and its Guide, adding PDFs, Word documents, photos and TIFFs, sections, the cover maker, the document window, Download, Advanced Settings, Preview Index, Create Bundle, Save, Rewind and saved copies, the tutorial and the share QR code. Every font family in Advanced Settings works. Reload, closing and reopening the tab, and opening from an installed icon all work: the manifest lets the browser offer to install it.

Anything that leaves the tool needs a connection: the links to the CaseForge Contact and Privacy pages.

## How it works

`scripts/build-offline.mjs` runs after `hugo`. It reads the built pages, follows everything they load (stylesheets, scripts, and from each script its imports, workers, libraries and the fonts it names), hashes every file, and writes `dist/bundletool/sw.js` from `scripts/offline/sw.template.js`. The list comes from the built files, so a new script, library or icon is picked up with no list to keep in step, and a deploy that changes any file changes the worker, so browsers install the new version.

```sh
hugo --gc
OFFLINE_TOOLS=bundletool OFFLINE_STRICT=1 node scripts/build-offline.mjs dist
```

The worker's scope is `/bundletool/`. It answers only `GET` requests to this site's own origin for files it lists, and navigations to the tool's pages. Every file is fetched straight from the server at install and must match the SHA-256 the build listed, so a stale copy from an edge cache or a half-deployed site is refused. The fonts other than the default index and footer fonts are stored on first use and when the browser is idle. The install set has a 15 MB budget in the tests.

The worker stores only the tool's own files. It never sees a document, contacts no other origin, and sends nothing anywhere.

## Turning it off

1. **One browser:** open the tool with `?nosw=1`. The worker and its caches are removed, the choice is remembered in that browser, and the tool loads from the network. `?nosw=0` turns it back on.
2. **Everyone, on the next deploy:** set `[params.offline] enabled = false` in `hugo.toml`. The pages stop registering and Hugo publishes a stand-in worker that deletes the old worker and its caches in every browser that has it.
3. **A build without the offline step:** if `build-offline.mjs` is not run, the stand-in ships, so a forgotten step is safe, not stale.

## Under `hugo server`

Nothing registers, so live reload is untouched. To try offline mode locally, build as above and serve `dist/` over `localhost` or `127.0.0.1` (service workers need a secure context).

## Known limits

- Word conversion renders in a hidden frame that asks for the page's stylesheets; offline those requests fail, which puts a few `ERR_INTERNET_DISCONNECTED` lines in the console. The converted PDF is identical.
- A new version is applied when the person presses Reload or closes every tab.
- An address typed without the trailing slash (`/bundletool`) is outside the worker's scope: online, the host redirects it; offline, the browser's own offline page shows.
- Browsers may evict caches under storage pressure; the tool then needs the network once more.
