# BundleTool

Court-ready PDF bundles, built on your own device. BundleTool takes PDFs, photos and Word documents and produces one bundle with an automatic index, hyperlinked page numbers, PDF bookmarks, sections, a cover page and consistent numbering. Nothing is uploaded: everything happens in the browser. A command line build uses the same engine to make a bundle from a manifest and a folder of PDFs.

The live tool is at https://caseforge.uk/bundletool/. BundleTool is made by [CaseForge](https://caseforge.uk/).

## BunTool, with thanks

BundleTool is a fork of **[BunTool](https://buntool.co.uk)**, written by Tris Sherliker ([TrisSherliker/buntool-website-git](https://github.com/TrisSherliker/buntool-website-git)) and published under the **Mozilla Public License 2.0**. Most of what is good here starts with his work. The bundle engine, the index, the hyperlinked page numbers, the bookmarks, sections with their own numbering, the review table and the tutorial are his, and he chose to publish them so that others could build on them. This repository exists because he did.

This is an independent fork. Tris Sherliker has not reviewed or endorsed it, and anything wrong here is ours, not his. If you want BunTool as he made it, it is at https://buntool.co.uk.

The licence and copyright notices in the files he wrote stay intact. Files carried over from BunTool, and modifications to them, stay under the MPL-2.0 as the licence requires, and CaseForge publishes the files it wrote for this fork under the MPL-2.0 as well, so all of this repository's own code is under one licence (`LICENSE`). `NOTICE` lists every third party component this repository ships, inside the vendored libraries and outside them, with its licence, and `THIRD-PARTY-LICENSES/` holds the full text of each. The name BunTool and its trade mark are not licensed to us, which is why this tool has a different name.

## What is different from BunTool, and why

BunTool's own roadmap is the yardstick, so the changes are grouped against it. Each line says what changed and why. Where one of his roadmap items is only part done here, the line says so.

### Roadmap items ticked off

- **Host dependencies directly.** Every library is self-hosted and served from the same origin, with no CDN fallback. A bundle tool handles confidential documents, and every third party request tells that third party that someone is making a bundle. `tests/policy.test.mjs` fails if a CDN address returns.
- **Move off the logging endpoint.** Nothing is logged anywhere. A person who wants to report a problem copies the details from the error box and sends them, and that is the only thing that leaves the device.
- **Clean up console messages of user data.** No console message carries a document name, title or date, so nothing about a client's papers is left in the console of a shared machine. `tests/policy.test.mjs` enforces it.
- **Sanitise imported strings.** Text that comes back from a reopened bundle's metadata, a saved copy or a manifest is treated as data. A section id must be exactly four digits or a fresh one is made (`public/js/frontend/sectionId.js`), and other imported text is set through the DOM, not interpolated into HTML.
- **Review date parsing.** A relative word in a filename ("today", "next Friday") gives no date. Only a match that names a real calendar date is trusted, every match in the name is tried rather than only the first, and an ambiguous date such as 03/04/2026 is read day-first, as a court in England and Wales would read it.
- **Password-protected PDFs.** BundleTool asks for the password and decrypts the file on the device. A wrong password keeps the dialog open with an error, and Skip leaves the file out.
- **A test suite.** The suite runs on every push in CI. It does not gate a deployment: that is up to the host.
- **Skip the leave-page prompt where it is not needed.** Leaving the page asks first only while a save is pending.
- **Coversheet creator.** A cover page maker with a live preview, two layouts (classic and grid), party labels and case number placement, in the browser and in the command line build. An uploaded cover still wins over a generated one.
- **Witness statement coversheet.** A button on each section header adds a cover-style page with its own title, built by the same code as the bundle cover.
- **OCR.** A scanned page whose own text layer is short is recognised on the device and given an invisible text layer, so it becomes selectable and searchable without changing how it looks. It is on by default (`ocr.mode`, "auto"), there is a per-document force-OCR override and it works in English only. It uses [tesseract-wasm](https://github.com/robertknight/tesseract-wasm) (BSD-2-Clause) and its engine is loaded only when a scanned page needs it. The command line build runs the same engine, through its own documented Node entry point, as an optional dependency: present by default, but a build still completes without it, just without a text layer for the pages that needed one.
- **Word documents.** A .docx is converted to PDF pages in the browser. The conversion is for content, not for exact Word layout, so look at the converted pages before relying on them. The command line build does not accept Word files.
- **Image handling.** JPEG, PNG, WEBP, AVIF, GIF, BMP and TIFF photos, and HEIC where the browser can decode it, each become one page. A file is recognised by its contents, never its name.

Part done:

- **Caching.** The shared page chrome is fingerprinted and cached for a year. BundleTool's own scripts and its fonts have fixed names, so they are revalidated on every visit (`no-cache`). Caching them for longer would need a build step that fingerprints them, which this repository does not have.

### Beyond the roadmap

- **A document window.** The eye on a Review Table row opens the document: page through it, turn it, and read its text again with Force OCR. A note says when the page shown looks blank.
- **Download from the Review Table.** One button gives back the documents as BundleTool holds them, after conversion, turning and OCR: a section, the ones BundleTool changed, or all of them, as one zip in bundle order.
- **A command line build.** `bundletool` makes a bundle from a JSON manifest and a folder of PDFs, with no browser. It has fixed exit codes, a JSON mode, a JSON Schema for the manifest and built-in help.
- **Settings by link or QR code.** Advanced Settings can be shared as a link or a QR code. A code is decoded strictly and checked before anything is applied.
- **Split a bundle for email.** A finished bundle can be cut into parts small enough to send, at document boundaries, with sizes measured rather than estimated.
- **Works offline.** After one visit the tool and its Guide work with the network off. A service worker holds only the tool's own files and checks each against a hash. OCR is the exception: its English language data (about 4 MB) is not part of the offline copy, so OCR needs a connection.
- **Saved copies.** BunTool already autosaved to the browser. Here each document is stored once however many saved copies refer to it, each tab keeps its own history, a build that never finished is noticed on the next load and the documents put back, and there is a visible Delete all saved copies button.
- **A strict Content-Security-Policy.** Only this site's own scripts run, with no inline script and no object or frame from elsewhere. Style attributes are still allowed (`style-src 'unsafe-inline'`).

### Housekeeping

- **A static Hugo site, not Astro and Tailwind.** The stylesheet is a frozen Tailwind capture patched by hand, with no framework build to run. BunTool's own site has a landing page, news and terms around the tool; only the tool and its Guide are here, and his terms were written for his hosted service, so they do not apply to this one.
- **pdf-lib instead of mupdf.** mupdf is AGPL-3.0 and `@cantoo/pdf-lib` is MIT, so no AGPL component ships in this repository. That was a licensing choice for how CaseForge wants to distribute the tool, not a view on mupdf or on BunTool using it.
- **Unapplied redaction warning.** BunTool added this first: a PDF that still carries `/Redact` annotations has had nothing redacted, because the text underneath is still in the file. The check here is modelled on his and reads the annotation through pdf-lib too (`public/js/bundletoolPdfSafety.js`).
- **Files named `bundletool*`, not `buntool*`.** The saved copies database keeps its `buntool` name so that anyone's existing saved bundles survive.
- **Fewer font files.** Only the faces a code path loads ship (Regular and Bold of each family). Each family's licence is recorded in `NOTICE`, and `tests/fonts.test.mjs` fails if one changes.

## Quick start

Node 22 or later, and Hugo (extended, 0.165 or later) for the site.

```sh
npm ci                 # the pinned dev dependencies
npm test               # the whole test suite
hugo server            # the site, at http://localhost:1313/bundletool/
npm run build          # the site into dist/, then the offline service worker
node scripts/build-cli.mjs --help   # the command line build
```

The site must be served from the root of its own host (it imports shared files by root-absolute paths such as `/vendor/`). `hugo.toml` has the base URL to set, and `docs/deploying.md` lists the response headers a host must send.

## What is where

| Path | What it holds |
| --- | --- |
| `public/` | The tool: the bundle engine (`js/`), fonts, images and the web app manifest, published under `/bundletool/`. |
| `layouts/`, `content/`, `assets/` | The page and the Guide, and the stylesheet. |
| `static/` | The shared scripts, styles, libraries and mark the page loads (`js/shared/`, `css/shared/`, `vendor/`, `img/`). |
| `scripts/` | The command line build, the Node shim it shares with the tests, the vendor and offline builds. |
| `tests/` | The test suite. |
| `examples/`, `manifest.schema.json` | An example manifest and its JSON Schema. |
| `docs/` | Offline mode and deployment. |

## Command line

`scripts/build-cli.mjs` builds the same bundle as the browser from a JSON manifest and a folder of PDFs: no browser, no server. It needs Node 22 or later (CI runs the suite on Node 24) and the repository's `npm install`. It registers the small Node shim it needs itself, so no flags are required.

A plain `npm install` installs `@napi-rs/canvas` and `tesseract-wasm` (OCR's own dependencies, about 38 MB with the platform-specific native binary) as `optionalDependencies`: present by default, but not required by the core CLI. `npm install --omit=optional` skips them; the CLI still builds every bundle, just without a searchable text layer for any page that would otherwise be OCR'd (`ocr_unavailable`, a warning, never a failure). With `ocr.mode` at its default, "auto", every build pays the cost of checking each page's own text layer (pdf.js, no canvas involved) even when nothing needs OCR: about 0.05s and 40 MB extra on a text-only file, a fixed cost rather than one that grows with the number of pages OCR'd.

A page is rasterised for OCR at up to 25 million pixels (comfortably covering A3 at 300 DPI), scaled down to fit when a page's own size would exceed that, and given `ocr_failed` rather than rasterised at all if even the scaled-down resolution would fall below 72 DPI. This ceiling is well under the 100-million-pixel limit the browser's photo-embedding path uses: the CLI runs unattended, often in a container with fixed memory of its own, so the bound is sized for that rather than for one browser tab.

Separately, `maxImageSize` (90 million pixels, passed straight to pdf.js) caps a single embedded image, which pdf.js decodes before any of the raster cap's own code runs. A page can be a normal size while carrying one enormous image: without the cap, a 97 KB PDF holding one 10000x10000 image takes 1.73 GB peak RSS and 2.3s inside the OCR call. 90 million pixels comfortably clears a real A3 page at 600 DPI (about 69.6 million pixels) while staying under that attack shape. When pdf.js drops an image over the limit, the CLI sees it directly: `getDocument({ ..., verbosity: 1 })` makes pdf.js log the drop, and the CLI watches for that log during each page's render to give that page a real `ocr_failed` ("an image on this page is too large to read safely") instead of a silent empty success.

This caps ONE image at a time, not a page's total: four separate images, each under the cap, can still add up to more than the single-image case above (four 8000x8000 images on one page peak at 1.62 GB together). Nothing sums the declared size of every image on a page (including nested Form XObjects) before rendering, so this cap alone does not bound a page with several large images.

Peak memory for a scanned PDF (every page needing OCR) is roughly 0.5 to 0.7 GB (it varies by machine), plus about two and a half times the size of the input file, plus a little under 2 MB a page; for example, about 1.3 GB for a 175 MB, 100-page scan. These figures come from synthetic scans of 10 and 100 pages, padded to sizes up to 190 MB, built through the command line.

**Turning and straightening scanned pages.** Two settings, `ocr.turnUpright` and `ocr.straighten`, both off by default in the browser and here, change scanned pages as OCR reads them (`public/js/bundletoolOcrReorient.js`). Only a page with no visible text of its own is ever changed. Turning sets the page's /Rotate to the quarter turn the reader found (only when the engine and the page's lines agree), so nothing is redrawn and the text layer turns with the page; with turning off, the browser's document window notes such a page instead ("This page looks sideways"). Straightening wraps the page's content in a rotation about its centre (q, cm, the content, Q) for a tilt up to 10 degrees either way: the scan is not redrawn or re-encoded and the page keeps its size, so the corners turned past its edges are cut off. Measured on the OCR benchmark's A4 witness statement pages, that is 1.9% of the page area at 2 degrees, 4.4% at 5 and 8.0% at 10, all of it scan margin: none of the printed text moves off the page up to 10 degrees, while from about 10.25 degrees the running header and footer start to (0.5% of the text at 15 degrees, 1.4% at 20). A page with links, form fields or comments is left tilted, because they would no longer line up with it (`ocr_not_straightened`). In the browser's document window a straightened page can be put back as scanned, exactly: the two marked streams the straightening added are taken out, so the scan is drawn by its own content again, and the text layer is turned back to lie along the tilted print; later readings leave that page as scanned.

```sh
node scripts/build-cli.mjs [--json] <manifest.json> <docs-dir> <output.pdf>
node scripts/build-cli.mjs --config-keys | --schema | --version
node scripts/build-cli.mjs --help [topic]
```

Installed from the package it is the `bundletool` command (`bin` in `package.json`).

**Smaller photos.** `pageOptions.smallerPhotos`, on by default in the browser and here, re-encodes each picture of a document BundleTool made from a picture (`public/js/bundletoolSmallerPhotos.js`): at most 2,000 pixels on its long edge, as a JPEG at quality 85, never enlarged, and only when that comes out smaller (a PNG takes whichever is smaller of that and the same picture lossless at the smaller size: a diagram stays lossless, and a phone screenshot of messages, which would grow either way, is left as it is). The picture keeps its name and its rectangle on the page, so the page looks the same, and the text layer OCR read from the full picture (in the browser when the photo was added, here just before) is page content that still lies over the same words. A PDF added as a PDF is never touched. In the browser this happens while the bundle is built, on a copy: the Review Table keeps the full picture. Here it needs `@napi-rs/canvas`; without it the pictures stay as they are, with a `photo_not_smaller` warning for each.

**Progress.** Without `--json`, the command line says what it is doing: each scanned page as it is read (`scan.pdf: reading text, page 3 of 13`), each picture made smaller with its size before and after, then the build's own stages.

**The manifest** is the file the browser's "Export manifest" writes, and `manifest.schema.json` (JSON Schema, `schemaVersion` 1) describes it: `config` holds settings as flat `group.field` keys, `sections` holds section names and file names, and `examples/family-c100-fl401-manifest.json` is a working one. Every file name is a plain name of a file inside `<docs-dir>`; a name with a folder in front of it, or a link that leads outside the folder, is refused. The real page count of each PDF is read from the file, whatever the manifest says.

**The cover** follows the browser's rule. A top-level `"coversheet": "cover.pdf"` names a PDF in `<docs-dir>` whose first page is the cover, and wins. Otherwise `pageOptions.generateCover: true` draws the cover maker's page from the `cover.*` fields. Otherwise there is no cover.

**Inputs.** A source file is read by its bytes, never its name. PDFs are used as they are (an encrypted or unreadable one is refused). A JPEG or PNG photo becomes one page of the bundle's page size, on the browser's rules: a 36 point margin, fitted inside at its own proportions and never enlarged, the picture's bytes embedded untouched, and an EXIF rotation applied by a transform (all eight orientations) instead of redrawing pixels. One difference follows from having no canvas: a picture over 4,200 pixels on its longest edge is embedded whole instead of being scaled to 4,000. With `pageOptions.smallerPhotos` on (the default), each picture then goes into the bundle at most 2,000 pixels on its long edge, after OCR has read the full picture (see Smaller photos below). Every other type the browser opens (Word documents, WEBP, AVIF, GIF, BMP, TIFF, HEIC, old Office files) needs a canvas or a page to convert, so the CLI refuses it with `unsupported_input_type`, names the type and says to convert it to a PDF first. The browser's limits hold: 200 MB per file (`file_too_large`), 450 MB for the documents together (`bundle_too_large`), 100 million pixels for a photo and 40 million for a PNG (`image_too_large`), and a damaged picture is `invalid_image`. A file entry may carry `"rotate": 90`, `180` or `270`, a clockwise turn added to the rotation each page already has, as Turn document does in the browser (`invalid_rotation` for anything else). The browser's add-time warnings (unapplied redactions, the large bundle notice) are not repeated here.

### Built-in help

`bundletool` documents itself, so a person or a program needs no other file to use it. `bundletool --help` prints a short overview: what the tool does, its options, the inputs it accepts, the exit codes, and examples. `bundletool --help <topic>` gives the detail (`manifest`, `settings`, `inputs`, `errors`, `examples`, `schema`). `bundletool --schema` prints the JSON Schema, and `bundletool --json --help [topic]` returns the same content as one JSON object. The help is generated from the tool's own tables (`scripts/cli-docs.mjs`), and `node scripts/sync-cli-docs.mjs` keeps the generated tables below equal to it; the suite fails when a README table, a setting, an error code or an example is out of date. Help can be asked for as `--help`, `-h`, `-help`, `-?`, `/?`, `--usage` or the word `help` (`help <topic>` works too); a mistyped option such as `--hewlp` is refused with the nearest real option named.

### The contract

<!-- cli-docs:exit-codes -->
| Exit code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | The input was fine and the build or the write failed (an unexpected fault). |
| 2 | The command line was wrong. |
| 3 | The input was rejected: the request or manifest, a file it names, or a place to write. |
<!-- /cli-docs:exit-codes -->

**Settings.** The manifest's `config` object carries flat `group.field` keys, for example `heading.bundleTitle`. `bundletool --config-keys` prints every key this version knows with its default (`--json --config-keys` gives the same as an object under `configKeys`); a key it does not know is ignored with an `unknown_config_key` warning that names the nearest known keys. The ones a court bundle usually needs:

| Key | What it sets |
| --- | --- |
| `heading.bundleTitle`, `heading.projectName`, `heading.claimNumber`, `heading.author` | The index heading: bundle title, the matter (Re: ...), the case number, and who prepared it |
| `pageOptions.generateCover` | `true` draws a cover page from the `cover.*` keys below; a top-level `"coversheet": "file.pdf"` uses your own cover instead |
| `cover.courtName`, `cover.applicantName`, `cover.respondentName` | The court line and the two parties on a generated cover |
| `cover.partyLabel1`, `cover.partyLabel2` | The party labels (default Applicant, Respondent); a side with more than one person is numbered, 1ST APPLICANT, 2ND APPLICANT |
| `cover.layout` | `classic` (parties stacked in one column, title between two rules) or `grid` (two columns, applicants left and respondents right, title between the same two rules) |
| `cover.caseNumberLine` | `court` puts the case number on the court's line, `own` puts it on a line of its own beneath the court |
| `cover.caseNumberAlign` | `left`, `centre` or `right` (default `right`) for the case number when it has a line of its own |
| `cover.headingAlign` | `left` (default), `centre` or `right` for the court and the "In the matter of" lines; beside the case number the court keeps to the space left of it |
| `cover.partyLabelPlacement` | `inline` (default) puts each label on the name's line at the far side, `below` puts it under the name |
| `cover.titleLines` | `single` (default) or `double`: one rule above and one below the title, or two thin rules each |
| `cover.partyAlign` | `left`, `centre` or `right` for the names of the stacked design (the two-column design ignores it) |
| `cover.claimNumber`, `cover.bundleTitle`, `cover.author` | Cover-only overrides of the heading values; `null` follows the heading |
| `pageNumbering.numberingStyle`, `pageNumbering.alignment`, `pageNumbering.pageNumberPerSection` | Page number style, position, and restarting per section |
| `pageOptions.pageSize`, `pageOptions.printableBundle`, `pageOptions.watermark` | A4 or Letter, the printable variant, and a watermark |

Every setting, with its allowed values and default (also `bundletool --help settings`):

<!-- cli-docs:settings -->
| Setting | Allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `heading.claimNumber` | text | `""` | The case or claim number, printed at the top right of every index page (and on the cover unless cover.claimNumber says otherwise). |
| `heading.bundleTitle` | text | `"Bundle"` | The bundle title, printed as the index heading unless index.headingText is set. |
| `heading.projectName` | text | `""` | The matter, for example "Re: X (A Child)", printed above the index heading. |
| `heading.author` | text | `""` | The PDF Author and the cover's "Prepared by" line: who is responsible for the content. |
| `heading.fontSize` | one of small, medium, large | `"medium"` | Size of the index heading text. |
| `pageNumbering.footerFont` | one of serif, traditional, sansSerif, monospaced, times, helvetica, courier | `"helvetica"` | Font of the page numbers in the footer. |
| `pageNumbering.footerFontSize` | one of small, medium, large | `"medium"` | Size of the page numbers. |
| `pageNumbering.alignment` | one of left, centre, right | `"centre"` | Where the page number sits along the footer. |
| `pageNumbering.numberingStyle` | one of PageX, PageXofY, X, XslashY, XofY, None | `"PageX"` | The wording of the page number: PageX is "Page 3", PageXofY "Page 3 of 40", X "3", XslashY "3/40", XofY "3 of 40", None prints no number. |
| `pageNumbering.footerPrefix` | text | `""` | Text printed before the page number, for example a reference. Blank prints none. |
| `pageNumbering.pageNumberColour` | colour #rrggbb | `"#000000"` | Colour of the page number, #rrggbb (the old names black, red and blue are still read). |
| `pageNumbering.pageNumberPerSection` | true or false | `false` | true restarts the page numbers at 1 in each section. |
| `pageNumbering.plateColour` | colour #rrggbb | `"#f4f4f4"` | Colour of the plate behind the page number, #rrggbb. |
| `pageNumbering.plateOpacity` | number 0 to 100 | `100` | Opacity of that plate, 0 to 100 (0 removes it). |
| `pageNumbering.footerLink` | one of index, top, none | `"index"` | Where clicking the footer goes: the index, the first page (top) or nowhere. |
| `pageNumbering.frontMatterNumbering` | one of continuous, roman, skip | `"continuous"` | How the cover and index pages are numbered: continuous with the rest, in roman numerals (i, ii) or not at all (skip). |
| `pageNumbering.footerOffset` | number -30 to 60 | `0` | Moves the footer up (positive) or down (negative) by this many points, -30 to 60. |
| `index.fontFace` | one of serif, traditional, sansSerif, monospaced, times, helvetica, courier | `"serif"` | Font of the index table. |
| `index.fontSize` | one of small, medium, large | `"medium"` | Size of the index table text. |
| `index.dateStyle` | one of YYYY-MM-DD, DD-MM-YYYY, MM/DD/YYYY, DD Mon. YYYY, DD Month YYYY, Mon DD, YYYY, Mon. DD, YYYY, Month DD, YYYY, None | `"YYYY-MM-DD"` | How document dates are written in the index (None leaves them out). |
| `index.dateInputOrder` | one of UK, US | `"UK"` | Browser only: how an ambiguous date in a file name (both numbers 12 or under, for example 03-04-2026) is read when documents are added, UK day-first or US month-first. A day over 12 is never ambiguous either way. The CLI takes each document's date from the manifest as given; it never parses file names itself. |
| `index.outlineItemStyle` | one of plain, withPage, withDate, withDateandPage | `"withPage"` | What each bookmark in the PDF outline shows: the title alone, with the page, with the date, or both. |
| `index.showTableBorders` | true or false | `true` | true draws grid lines in the index table. |
| `index.justTheIndex` | true or false | `false` | Not for manifests: the page drives this internally for its own Preview Index button, but the CLI builds through a separate path that never reads it, so setting it here has no effect. |
| `index.sectionPrefix` | one of "", Section, Part | `""` | A word before each section letter in the index: Section, Part, or blank for none. |
| `index.indexBookmarkLabel` | text | `""` | The label of the outline bookmark that jumps to the index. Blank means "Index". |
| `index.headingText` | text | `""` | The heading on the index page. Blank reuses heading.bundleTitle. |
| `pageOptions.pageSize` | one of a4, letter, legal | `"a4"` | The size of the pages the tool draws (index, cover). Pages copied from your own documents keep their own size. |
| `pageOptions.printableBundle` | true or false | `false` | true adds a page marked "This page is intentionally left blank" after any document with an odd number of pages, so double-sided printing starts each document on a fresh sheet. |
| `pageOptions.coversheet` | true or false | `false` | Set by the tool from the cover source. Leave it alone. |
| `pageOptions.generateCover` | true or false | `false` | true draws a cover page from the cover.* settings and puts it in front of the index. A "coversheet" file in the manifest wins over it. |
| `pageOptions.coverSource` | one of uploaded, generated, none | `"none"` | Set by the tool: uploaded, generated or none. Leave it alone. |
| `pageOptions.watermark` | true or false | `false` | true draws a diagonal watermark across every page. |
| `pageOptions.watermarkText` | text | `""` | The watermark wording. Blank draws CONFIDENTIAL. |
| `pageOptions.watermarkColour` | colour #rrggbb | `"#999999"` | Watermark colour, #rrggbb. |
| `pageOptions.watermarkOpacity` | number 0 to 100 | `28` | Watermark opacity, 0 to 100. |
| `pageOptions.smallerPhotos` | true or false | `true` | true (the default) puts each JPEG or PNG the tool turned into a page into the bundle at most 2000 pixels on its long edge, as a JPEG at quality 85, after OCR has read the full picture; the page looks the same and the file is much smaller. A PDF is never changed. false keeps the pictures as they are. Needs @napi-rs/canvas; without it the pictures stay as they are (photo_not_smaller). |
| `cover.courtName` | text | `""` | The court line at the top of a generated cover. |
| `cover.matterOf` | text | `""` | The subheading lines under the court, one per newline (for example the statute). |
| `cover.applicantName` | text | `""` | The applicants, one per line, up to 4. |
| `cover.respondentName` | text | `""` | The respondents, one per line, up to 4. |
| `cover.partyLabel1` | text | `""` | The label for the first side. Blank means Applicant. |
| `cover.partyLabel2` | text | `""` | The label for the second side. Blank means Respondent. |
| `cover.extraText` | text | `""` | Extra lines under the cover title, one per newline. |
| `cover.claimNumber` | text or null | `null` | The cover's own case number. null follows heading.claimNumber; a string, even an empty one, is what the cover shows. |
| `cover.bundleTitle` | text or null | `null` | The cover's own title. null follows heading.bundleTitle. |
| `cover.author` | text or null | `null` | The cover's own "Prepared by". null follows heading.author. |
| `cover.layout` | one of classic, grid | `"classic"` | The cover design: classic (parties stacked, title between rules) or grid (applicants left, respondents right). |
| `cover.caseNumberLine` | one of court, own | `"court"` | court puts the case number on the court's line; own gives it a line of its own under the court. |
| `cover.partyLabelPlacement` | one of below, inline | `"inline"` | below puts each party label under the name; inline puts it on the name's line. |
| `cover.partyAlign` | one of left, centre, right | `"centre"` | Where the party names sit in the classic design. |
| `cover.caseNumberAlign` | one of left, centre, right | `"right"` | Where the case number sits when it has its own line. |
| `cover.headingAlign` | one of left, centre, right | `"left"` | Where the court and subheading lines sit. |
| `cover.titleLines` | text | `"single"` | How many rules sit above and below the bundle title on the cover: single, or double (two thin rules a small distance apart). Either way the text is equidistant from the nearest rule. |
| `cover.caseNumberLabel` | text | `"CASE NO:"` | The prefix printed before the case number, "CASE NO:" by default. Set to "CLAIM NO:", "ORDER NO:", any other wording, or "" for no prefix at all. |
| `cover.preparedByLabel` | text | `"Prepared by:"` | The label printed before who prepared the bundle, "Prepared by:" by default. Set to "Compiled by:", "On behalf of:", any other wording, or "" for no label at all. Kept to 40 characters: unlike the case number label, this line never wraps. |
| `cover.partyJoiner` | text | `"-and-"` | The word joining the two parties on the classic design, "-and-" by default. Set to "-v-", any other wording, or "" for no joining word at all, just the gap. Kept to 40 characters. |
| `ocr.autoDetect` | true or false | `true` | Not for manifests: this is the browser's own auto-OCR toggle. The command line's equivalent is ocr.mode. |
| `ocr.mode` | one of auto, off | `"auto"` | auto (the default) OCRs a page only if its own text layer is too short to search, the same check and threshold the browser uses; off skips the check for every file (a file's own "forceOcr" still overrides off for that one file). Needs @napi-rs/canvas and tesseract-wasm on this machine; if either is not available, the bundle still builds, just without a text layer for the pages that needed OCR (ocr_unavailable). |
| `ocr.turnUpright` | true or false | `false` | true turns a scanned page OCR reads on its side or upside down to show upright, by setting its /Rotate (lossless; the text layer turns with it). Only pages OCR reads that have no text of their own, and only when the engine and the page's lines agree which way up it is. Off by default. |
| `ocr.straighten` | true or false | `false` | true turns a scanned page OCR finds tilted (up to 10 degrees) level, by wrapping its content in a rotation about the page's centre: the scan is not redrawn, the page keeps its size and its outer corners are trimmed. The text layer is drawn level over it. A page with links, form fields or comments is left as scanned (ocr_not_straightened). Only pages OCR reads that have no text of their own. Off by default. |
<!-- /cli-docs:settings -->

Each section's `sectionID` is optional (numbered by position when left out) and, when given, is four digits.

With `--json`, stdout holds exactly one JSON object, on success and on failure, and nothing else: the engine's own progress lines are silenced and its warnings are collected into `warnings`. Without it, progress is written for people and a failure is one line on stderr.

```json
{"ok":true,"tool":"bundletool","cliVersion":"1.0.0","schemaVersion":1,"output":"/path/out.pdf","bytes":455380,
 "files":7,"sections":4,"coverSource":"none","pages":{"total":15,"cover":0,"index":1,"source":14},"warnings":[]}
{"ok":false,"tool":"bundletool","cliVersion":"1.0.0","error":{"code":"file_not_found","message":"...","details":{"file":"a.pdf"}},"warnings":[]}
```

`error.code` is a stable lower case string:

<!-- cli-docs:errors -->
| Error code | Exit | Meaning |
| --- | --- | --- |
| `usage_missing_arguments` | 2 | A required argument is missing. |
| `usage_too_many_arguments` | 2 | More arguments were given than the tool takes. |
| `usage_unknown_option` | 2 | An option the tool does not have (a typo is never taken for a file name). |
| `usage_bad_option` | 2 | An option was given without a value, or with a value it does not take. |
| `usage_unknown_topic` | 2 | `--help` was asked for a topic the tool does not have. |
| `manifest_not_found` | 3 | The manifest file could not be read. |
| `manifest_too_large` | 3 | The manifest is over 5 MB. |
| `invalid_json` | 3 | The manifest is not valid JSON. |
| `invalid_manifest` | 3 | The manifest is not shaped like a manifest (no sections, a wrong type, a bad sectionID, too many sections or files). |
| `unknown_key` | 3 | The manifest has a key at the top level, in a section or in a file entry that this version does not know. |
| `unsupported_schema_version` | 3 | schemaVersion is present and is not 1. |
| `invalid_config` | 3 | A setting has a value the engine refuses (a value not in its allowed list, an opacity out of range). |
| `docs_dir_not_found` | 3 | The documents directory does not exist. |
| `output_dir_missing` | 3 | The folder the output file would go in does not exist. |
| `output_overwrites_input` | 3 | The output path is one of the source documents. |
| `output_exists` | 3 | The output file already exists; pass --force to overwrite it. |
| `invalid_filename` | 3 | A filename is not a plain file name: it has a folder in front of it, or an odd character. |
| `file_not_found` | 3 | A file the manifest names is not in the documents directory. |
| `file_unreadable` | 3 | A file exists but could not be read. |
| `path_outside_docs` | 3 | A file resolves, through a symbolic link, to somewhere outside the documents directory. |
| `invalid_pdf` | 3 | A file is not a readable PDF (damaged, truncated or not a PDF at all). |
| `encrypted_pdf` | 3 | A PDF is password protected. |
| `unsupported_input_type` | 3 | A file is a type the CLI does not convert (Word, TIFF, WEBP, HEIC, GIF, BMP and others). Convert it to PDF first. |
| `invalid_image` | 3 | A JPEG or PNG is damaged or cannot be read. |
| `image_too_large` | 3 | A picture has more pixels than the limit (100 million for a JPEG, 40 million for a PNG). |
| `file_too_large` | 3 | A file is over 200 MB. |
| `bundle_too_large` | 3 | The documents together are over 450 MB. |
| `invalid_rotation` | 3 | A file's rotate is not 90, 180 or 270. |
| `invalid_cover` | 3 | The supplied coversheet is not a usable PDF (no pages, encrypted, oversize). |
| `build_failed` | 1 | The bundle could not be built, though the input was accepted. |
| `output_write_failed` | 1 | The finished bundle could not be written. |
| `internal_error` | 1 | An unexpected fault in the tool itself (no stack trace is printed). |
<!-- /cli-docs:errors -->

Warnings are `{code, message}` in `warnings`:

<!-- cli-docs:warnings -->
| Warning code | Meaning |
| --- | --- |
| `unknown_config_key` | A config key this version does not know was ignored; the message names the nearest known keys. |
| `engine_warning` | The PDF engine warned about something (for example a document it repaired). |
| `over_pd27a_page_limit` | The bundle is over 350 pages. Family Procedure Rules Practice Direction 27A limits an e-bundle to that by default; the build still finishes. |
| `ocr_failed` | OCR raised a real error, on a specific page (names the file and page) or while setting up for the whole document (names the file, no page); the affected page or document has no searchable text layer, the build still finishes. |
| `ocr_not_straightened` | ocr.straighten is on and a tilted scanned page has links, form fields or comments, which do not move with the page's content, so it was left tilted as scanned (names the file and page); its text layer is still added. |
| `ocr_unavailable` | OCR was needed (or forced) but the engine cannot load on this machine (@napi-rs/canvas or tesseract-wasm missing, or no prebuilt binary for this platform); the build still finishes, without a text layer for the pages that needed it. |
| `photo_not_smaller` | pageOptions.smallerPhotos is on but @napi-rs/canvas cannot load on this machine, so a JPEG or PNG went into the bundle at its own size (names the file); the build still finishes. |
<!-- /cli-docs:warnings -->

**Stability.** Within a major version of `cliVersion` these do not change: the three arguments, the four exit codes, the meaning of `--json` and `--version`, the field names and types in the success object, every error code listed above and its exit code, the manifest keys and their meaning, which input types are accepted (PDF, JPEG, PNG; more may be added in a minor version, none removed), the browser's limits above (they may only rise), and the cover rule. New optional manifest keys, new fields in the JSON, new warning codes and new error codes may appear in a minor version, so a caller matches on the codes it knows and treats the rest by exit code. Unknown keys at the top level, in a section or in a file entry are refused (`unknown_key`) so a misspelt key is never silently ignored; inside `config` they are a warning.

`npm test` runs the CLI as a child process (`tests/bundletoolCli.test.mjs`), including the refusals above.

## Troubleshooting

Every error the browser tool shows carries a short code after its message, such as `Error code BT-ADD-12`, and the report that Report this bug fills in opens with the same code. The code says where the error was raised: each one belongs to exactly one place in the source, and a code never changes meaning once it is given out. The registry is `public/js/frontend/errorCodes.js`; a code that is no longer raised is retired there, not reused. A code is a fixed string: it never carries a file name or anything else from a document. Notices that only inform (the large-bundle warning, "Your last session is back", a settings link that was applied) carry no code.

An error that nothing else caught raises the "Something went wrong on this page" notice with `BT-PAGE-01`.

The command line does not use these codes. It has its own fixed exit codes (0 done, 1 an unexpected fault, 2 a wrong command line, 3 rejected input) and lower case `error.code` strings, listed under The contract above.

`tests/errorCodes.test.mjs` fails when a notice has no code, when a code is raised in two places, when a code is not in the registry or a registered one is raised nowhere, and when this table differs from the registry (`node --import ./tests/register-hooks.mjs tests/errorCodes.test.mjs --print-table` prints it).

<!-- error-codes -->
| Code | Meaning |
| --- | --- |
| `BT-ADD-01` | An unexpected fault while adding documents chosen with Add Documents or dropped on the page. |
| `BT-ADD-02` | An unexpected fault while adding documents to the section picked in "Add files to which section?". |
| `BT-ADD-03` | An unexpected fault while adding documents to a new section made from "Add files to which section?". |
| `BT-ADD-04` | Every document chosen is already in the bundle, so none was added again. |
| `BT-ADD-05` | More files were chosen at once than BundleTool adds in one go, so none was added. |
| `BT-ADD-06` | The documents would take the bundle over the most documents one bundle holds, so none was added. |
| `BT-ADD-07` | The documents together are over the size limit for one bundle, so none was added. |
| `BT-ADD-08` | A folder was dropped: a page cannot read a folder, so it was left out. |
| `BT-ADD-09` | A Word document is damaged inside, so it was not added. |
| `BT-ADD-10` | A Word document could not be converted to PDF pages, so it was not added. |
| `BT-ADD-11` | A password-protected PDF was unlocked but could not be fully decrypted, so it was not added. |
| `BT-ADD-12` | A file is not a readable PDF, so it was not added. |
| `BT-ADD-13` | A PDF has no pages, so it was not added. |
| `BT-ADD-14` | A PDF has more pages than one document may have, so it was not added. |
| `BT-ADD-15` | A PDF has pages far larger than any paper size, so it was not added. |
| `BT-ADD-16` | A PDF would take the bundle over its page limit, so it was not added. |
| `BT-ADD-17` | Several files could not be added; the notice lists each with its reason. |
| `BT-ADD-18` | Some files could not be added, and the bundle is also very large. |
| `BT-ADD-19` | Some of the documents chosen were already in the bundle and were not added again. |
| `BT-ADD-20` | A file is empty (0 bytes), so it was refused. |
| `BT-ADD-21` | A file is over the size limit for one document, so it was refused. |
| `BT-ADD-22` | The browser could not read a file, so it was refused. |
| `BT-ADD-23` | A zip or Word file is damaged, so it was refused. |
| `BT-ADD-24` | A file is not a type BundleTool reads, so it was refused without being opened. |
| `BT-ADD-25` | A Word document has too many parts to convert safely, so it was refused. |
| `BT-ADD-26` | A Word document unpacks to more than BundleTool can convert, so it was refused. |
| `BT-ADD-27` | The text of a Word document is too long to convert, so it was refused. |
| `BT-ADD-28` | A picture inside a Word document is too large in bytes, so the document was refused. |
| `BT-ADD-29` | A Word document has too many pages to convert in a browser tab, so it was refused. |
| `BT-ADD-30` | A picture inside a Word document has too many pixels to draw, so the document was refused. |
| `BT-PHOTO-01` | This browser cannot open HEIC photos, so the photo was left out. |
| `BT-PHOTO-02` | A file is not a type of photo BundleTool reads, so it was left out. |
| `BT-PHOTO-03` | A photo has too many pixels to draw, so it was left out. |
| `BT-PHOTO-04` | A photo is damaged or cut short, so it was left out. |
| `BT-PHOTO-05` | A photo could not be converted to a PDF page for another reason. |
| `BT-MAN-01` | A section layout chosen with "import" is not a valid manifest. |
| `BT-MAN-02` | A section layout could not be imported, so the bundle was left as it was. |
| `BT-MAN-03` | A section layout was imported, but some documents it names were not found. |
| `BT-MAN-04` | The documents a manifest names would take the bundle over its page limit, so nothing was imported. |
| `BT-MAN-05` | A manifest was imported, but one document it names was not among the dropped files or could not be used. |
| `BT-MAN-06` | A manifest was imported, but several documents it names were not among the dropped files or could not be used. |
| `BT-MAN-07` | A dropped manifest could not be imported. |
| `BT-MAN-08` | A section layout or manifest has more sections than a bundle holds, so none of it was imported. |
| `BT-BUILD-01` | Create Bundle was pressed with no documents in the Review Table. |
| `BT-BUILD-02` | The Review Table could not be turned into an index (its structure did not check out). |
| `BT-BUILD-03` | Creating the bundle took longer than four minutes and was stopped. |
| `BT-BUILD-04` | The browser ran out of memory while creating the bundle. |
| `BT-BUILD-05` | A part of BundleTool could not be loaded while creating the bundle (a connection problem). |
| `BT-BUILD-06` | Creating the bundle failed for another reason. |
| `BT-BUILD-07` | The preview of a finished bundle or index could not draw a page as a picture (the PDF itself is unchanged). |
| `BT-INDEX-01` | Preview Index was pressed with no documents in the Review Table. |
| `BT-INDEX-02` | Building the index preview took too long and was stopped. |
| `BT-INDEX-03` | A part of BundleTool could not be loaded while building the index preview (a connection problem). |
| `BT-INDEX-04` | Building the index preview failed for another reason. |
| `BT-OPEN-01` | A PDF opened for editing holds no BundleTool data, so it is not a BundleTool bundle. |
| `BT-OPEN-02` | A bundle opened for editing is password-protected. |
| `BT-OPEN-03` | A bundle opened for editing could not be read as a PDF. |
| `BT-OPEN-04` | Opening a bundle for editing failed for another reason. |
| `BT-OPEN-05` | A bundle whose documents were to be added holds no BundleTool data after all, so nothing was added. |
| `BT-OPEN-06` | A bundle whose documents were to be added could not be read. |
| `BT-OPEN-07` | Splitting a bundle into its documents failed for another reason. |
| `BT-OPEN-08` | Documents taken from a reopened bundle carry redaction markers that were never applied. |
| `BT-OPEN-09` | A bundle opened for editing has more sections than a bundle holds, so it was not opened. |
| `BT-COVER-01` | A Word document chosen as the coversheet is damaged inside. |
| `BT-COVER-02` | A Word document chosen as the coversheet could not be converted. |
| `BT-COVER-03` | A password-protected coversheet was unlocked but could not be used. |
| `BT-COVER-04` | A PDF chosen as the coversheet cannot be used as one (its first page is unsafe or unusable). |
| `BT-COVER-05` | A file chosen as the coversheet could not be read as a PDF. |
| `BT-COVER-06` | The coversheet maker could not build the coversheet PDF. |
| `BT-COVER-07` | A witness statement cover page could not be drawn. |
| `BT-COVER-08` | The coversheet maker could not draw its preview (the coversheet itself still works). |
| `BT-VIEW-01` | The document window could not read the document it was opened for. |
| `BT-VIEW-02` | A turn waiting in the document window could not be written before Force OCR. |
| `BT-VIEW-03` | The document window could not remove a page. |
| `BT-VIEW-04` | Turn document could not write the turn into the document. |
| `BT-VIEW-05` | Put back as scanned could not undo the straightening of a page. |
| `BT-VIEW-06` | The document window could not draw the page (turning and reading still work). |
| `BT-OCR-01` | An image on some pages is too large to read, so those pages have no searchable text. |
| `BT-OCR-02` | Force OCR could not read the text in a document, which was left as it was. |
| `BT-DL-01` | The Download button could not gather the documents. |
| `BT-SPLIT-01` | The part size for Split for email is under 1 MB. |
| `BT-SPLIT-02` | Split for email could not split the bundle. |
| `BT-SPLIT-03` | Split for email could not put the parts into one zip. |
| `BT-SAVE-01` | This browser has no room left to keep a copy of the work. |
| `BT-SAVE-02` | This browser refused to keep a copy of the work. |
| `BT-SAVE-03` | Delete all saved copies could not delete what this browser holds. |
| `BT-RESTORE-01` | The last build never finished, and no saved copy of its documents was found. |
| `BT-RESTORE-02` | The last build never finished; the documents saved just before it were put back. |
| `BT-LINK-01` | A settings link or QR code could not be used, so nothing was changed. |
| `BT-PAGE-01` | Something failed on the page that no other check caught. |
<!-- /error-codes -->

## Privacy

BundleTool runs entirely in the browser. Documents are **never uploaded** to
any server: all processing happens locally on the device. That property comes
from BunTool and is worth preserving in any change to the engine.

## Architecture

How the code is organised inside `public/js/` (the PDF engine and shared
primitives, the backend and frontend modules, the worker threads, the cover
page, why the `buntool*` storage keys keep their names, how autosave writes,
and the accent colour system) is in `ARCHITECTURE.md`, not here: that detail is
for someone changing the code, not for someone using the tool.

## Tests

```sh
npm ci
npm test
```

Node's built-in runner, no browser required. `tests/register-hooks.mjs` loads `scripts/node-compat.mjs`, whose resolver hook maps the root-absolute `/vendor/...` and `/js/shared/...` imports onto `static/`, so the tests import `public/js/*.js` directly, byte for byte as it ships. The tests that read PDF text or pixels skip themselves where `pdftotext` and `pdftoppm` (poppler) are not installed. CI runs the same command.

## Bundled fonts and their licences

All typefaces ship with the app under `public/fonts/` and are self-hosted:
nothing is fetched from Google Fonts or any other font CDN at runtime, so no
request leaves the browser to render a bundle. Each family carries its own
licence file alongside the font binaries.

Version and licence below are read from the shipped files, not inferred from
the directory name. `NOTICE` has the full detail for each family.

| Family | Version | Directory | Licence |
| --- | --- | --- | --- |
| Plus Jakarta Sans | 2.071 | `sans/` | SIL Open Font License 1.1 (`OFL.txt`) |
| Noto Serif | 2.015 | `serif/` | SIL Open Font License 1.1 (`OFL.txt`) |
| EB Garamond | 1.001 | `trad/` | SIL Open Font License 1.1 (`OFL.txt`) |
| Charis SIL | 4.104 | `timesalt/` | **SIL Open Font License 1.0**, not 1.1 (`SIL Open Font License.txt`) |
| Liberation Sans | 2.1.5 | `arialalt/liberation-sans/` | SIL Open Font License 1.1 (`OFL.txt`) |
| Ubuntu Mono | 0.80 | `mono/` | **Ubuntu Font Licence 1.0** (`UFL.txt`, not OFL) |

The "Arial style" option is Liberation Sans.

Only the files a code path loads ship: Regular and Bold of each family (`FONT_SETTINGS` in
`bundletoolFontSettings.js` has no other face). Italics, variable fonts, other weights and
Noto Sans, which no option offers, are not included, although the `README.txt` inside a family
folder, as the font's publisher wrote it, still lists them. A new face needs a row in
`FONT_SETTINGS`, or nothing will fetch it.

All are permissive and redistributable, which is what allows them to be
embedded in generated bundles. Fonts are embedded IN FULL rather than subset,
so no font is modified and none of the reserved-font-name clauses is engaged.
This is a maintainer concern, not a setting: a solicitor choosing a typeface
for a court bundle does not need to reason about font licensing, and the claim
is only meaningful to someone who can verify it.

**Adding or updating a font means updating `tests/fonts.test.mjs` as well.** It
fingerprints every licence file and pins each family's version, so a font that
arrives under different terms fails the build instead of shipping quietly.

The page-number footer picks from the same list, through
`pageNumbering.footerFont`, and defaults to Liberation Sans. The setting is
always honoured: a setting that is accepted, stored and read back but does
nothing would be worse than either having it or not.

What makes a free choice of footer font safe is that the label is measured with
the font it is drawn in: the same font object gives the plate its width, the
baseline its ink band, and the page its glyphs. `tests/footer.test.mjs` renders
every selectable footer font and measures the centring off the pixels.
