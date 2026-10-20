# BundleTool: browser modules

Everything in this directory is served to the browser **unbundled**: Hugo
publishes `public/` under `/bundletool/` (READMEs excluded), so these files are the shipped
artefacts, not build inputs. A syntax error here will not fail the site build; the
test suite (`npm test`) imports the modules, which is what catches one.

BundleTool is a fork of [BunTool](https://github.com/TrisSherliker/buntool-website-git)
by Tris Sherliker, licensed under the Mozilla Public License 2.0. Files carried
over from BunTool keep their per-file MPL notices; MPL-2.0 section 3.4 requires
it, and `tests/policy.test.mjs` enforces it.

## Layout

| File | Purpose |
| --- | --- |
| `bundletoolPdfLib.js` | The only place the PDF engine (@cantoo/pdf-lib) and fontkit are imported, and the only place a version is pinned. |
| `bundletoolPdfLoad.js` | Bytes → document. Refuses encrypted PDFs; recovers and discloses damaged ones. |
| `bundletoolMain.js` | Orchestrates a bundle build, stage by stage. |
| `bundletoolConfig.js` | Config structure and validation. |
| `bundletoolIndexData.js` | The index data model passed from the frontend. |
| `bundletoolToc.js` | Draws the index pages (jsPDF + autotable). |
| `bundletoolMerge.js` | Merges source documents, one at a time. |
| `bundletoolPages.js` | Upload validation, coversheets, page numbering. |
| `bundletoolFooter.js` | The footer itself: blanking rectangle, plate, text, index link, rotation. |
| `bundletoolOutline.js` | Bookmarks, built from the PDF specification. |
| `bundletoolLinks.js` | Link annotations. |
| `bundletoolMeta.js` | Hyperlinks, bookmarks and metadata in one parse. |
| `bundletoolRestore.js` | Opening a bundle back up and splitting it. |
| `bundletoolSplitOwn.js`, `bundletoolSplitLinks.js` | Email split parts with an index and page numbers of their own, and the link handling both kinds of part share. |
| `bundletoolAutosave.js` | Local IndexedDB autosave of work in progress. |
| `bundletoolFontSettings.js` | Font tables for the index. |
| `bundletoolTheme.js` | Light/dark/auto theme. |
| `bundletoolTutorial.js` | The on-demand tour. |
| `bundletoolVersion.js` | The version, edited by hand (there is no generator). |
| `frontend.js`, `frontend/` | The page's own UI logic. |
| `workers/` | One worker per heavy stage, terminated after use so its heap is freed. |

## Two things not to change without reading first

- **The `/BundleIndex` metadata key** (`bundletoolMeta.js`). "Load from bundle
  PDF" finds a bundle by it. Renaming it orphans every bundle already produced.
- **The `buntool*` storage keys.** The source files are named `bundletool*`,
  but the localStorage and IndexedDB keys keep their `buntool` names, because
  they name data already in users' browsers.
