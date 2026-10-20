/**
 * The shipped fonts, and the licences they are shipped under.
 *
 * Licences are not retroactive: a font already held under the OFL stays under
 * the OFL whatever its project does next. The risk this file exists to catch is
 * the other one: someone drops a newer build of a family into public/fonts and
 * the terms that arrive with it are not the terms that were reviewed. That is a
 * quiet change: the fonts render identically, nothing fails, and the NOTICE
 * describes a licence the repository does not ship.
 *
 * So the licence file of every family is fingerprinted here, along with the
 * family name and version recorded in the binaries themselves. Replacing a
 * font without also updating this file fails the build. Updating this file is
 * a deliberate act with a diff someone has to read.
 *
 * The fingerprint covers the licence file byte for byte, including whitespace.
 * A licence differing only in line endings is still a different document to
 * quote in court, and a change that small is exactly the kind that arrives
 * unnoticed. There is a negative control at the bottom of this file proving
 * the check actually trips; without it this is a test that can only pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, getFontkit } from '../public/js/bundletoolPdfLib.js';
import { FOOTER_FONT_URL, footerFontUrl, applyPageNumbering } from '../public/js/bundletoolPages.js';
import { FONT_SETTINGS, getFontSettings } from '../public/js/bundletoolFontSettings.js';
import Config, { validFonts, normaliseFontKey } from '../public/js/bundletoolConfig.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontsRoot = path.join(repoRoot, 'public', 'fonts');

/** SHA-256 of a file, as hex. The whole check rests on this one function. */
function fingerprint(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Family name and version string as recorded inside a font binary. */
async function identify(file) {
  const fontkit = await getFontkit();
  let font = fontkit.create(fs.readFileSync(file));
  if (font.fonts) font = font.fonts[0];            // a collection
  const version = font.name?.records?.version;
  return {
    family: font.familyName,
    version: String(typeof version === 'string' ? version : version?.en ?? '').trim(),
  };
}

/**
 * One row per shipped family:
 *   [directory, licence file, sha256 of it, family name, version, licence name]
 *
 * `version` is the version string in the font's own name table, which is the
 * only version this repository can state from evidence rather than from where
 * the file was downloaded.
 *
 * Not shipped: TeX Gyre Heros ("Arial style" is Liberation Sans, and
 * `validFonts` does not accept it, so no stored configuration can name it) and
 * Noto Sans (no font option or code path names it), nor any font file that no
 * code path can load: italics, variable fonts and the weights other than
 * Regular and Bold. `every shipped family is pinned` below fails if a family
 * directory appears without a row in this table.
 */
const FAMILIES = [
  ['arialalt/liberation-sans', 'OFL.txt',
   '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b',
   'LiberationSans-Regular.ttf', 'Liberation Sans', 'Version 2.1.5',
   'SIL Open Font License 1.1'],

  ['mono', 'UFL.txt',
   '0cebe8aa1ba75c4fdf57946d6109ed0a8ce12ae6bb420bad4e4f302c5c147d78',
   'UbuntuMono-Regular.ttf', 'Ubuntu Mono', 'Version 0.80',
   'Ubuntu Font Licence 1.0'],

  ['sans', 'OFL.txt',
   'e305459e0dab960db8295955f5abc813efb09d4fea89138572b593bee53d015c',
   'static/PlusJakartaSans-Regular.ttf', 'Plus Jakarta Sans',
   'Version 2.071;gftools[0.9.30]', 'SIL Open Font License 1.1'],

  ['serif', 'OFL.txt',
   'be2f3f8727ac2e18b714ad1c4336d4ddb3f3adbeb9a7f70bfab74d21f4d2b3fb',
   'NotoSerif-Regular.ttf', 'Noto Serif', 'Version 2.015',
   'SIL Open Font License 1.1'],

  // Charis SIL 4.104 predates OFL 1.1 and ships OFL version 1.0, as its own
  // licence file shows.
  ['timesalt', 'SIL Open Font License.txt',
   '1fdae11f176078f424bb7271481ff51a0bde203e055bd7152dc7c038f3ffc46a',
   'CharisSILR.ttf', 'Charis SIL', 'Version 4.104',
   'SIL Open Font License 1.0'],

  ['trad', 'OFL.txt',
   '1a9c0a1be6d76607dffdc1c98d377a51e98663fa5c848f11691e187215319afd',
   'static/EBGaramond-Regular.ttf', 'EB Garamond', 'Version 1.001',
   'SIL Open Font License 1.1'],
];

test('every shipped family is pinned', () => {
  const onDisk = fs.readdirSync(fontsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => (e.name === 'arialalt'
      ? fs.readdirSync(path.join(fontsRoot, e.name)).map((n) => `arialalt/${n}`)
      : [e.name]))
    .sort();
  assert.deepEqual(onDisk, FAMILIES.map((f) => f[0]).sort(),
    'a family was added or removed without updating this file');
});

for (const [dir, licence, sha, sample, family, version, licenceName] of FAMILIES) {
  test(`${dir}: licence file is unchanged (${licenceName})`, () => {
    const file = path.join(fontsRoot, dir, licence);
    assert.ok(fs.existsSync(file), `${dir} ships no ${licence}`);
    assert.equal(fingerprint(file), sha,
      `the licence file shipped with ${dir} has changed. If a font was updated, confirm what `
      + 'licence the new files are under, update NOTICE, and only then update this hash.');
  });

  test(`${dir}: the binaries are still ${family} ${version}`, async () => {
    const file = path.join(fontsRoot, dir, sample);
    assert.ok(fs.existsSync(file), `${dir} is missing ${sample}`);
    const got = await identify(file);
    assert.equal(got.family, family, `${dir} contains a different family`);
    assert.equal(got.version, version,
      `${dir} was updated to ${got.version}; check the licence that came with it`);
  });
}

test('no font ships a GPL licence', () => {
  // Liberation Sans 1.x is GPLv2 with a font-embedding exception, and comes
  // with COPYING (the GPL text) and License.txt (Red Hat's EULA). The 2.x line,
  // which ships here as 2.1.5, is OFL 1.1. No shipped font may carry a GPL
  // licence.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(ttf|otf|woff2?|ttc)$/i.test(e.name)) continue;
      const text = fs.readFileSync(p, 'latin1');
      if (/GNU GENERAL PUBLIC LICENSE|GNU General Public License/.test(text)) {
        offenders.push(path.relative(repoRoot, p));
      }
    }
  };
  walk(fontsRoot);
  assert.deepEqual(offenders, [], 'a GPL-licensed font is shipped');
});

test('every font a code path names is actually on disk', () => {
  const referenced = new Set([FOOTER_FONT_URL]);
  for (const settings of Object.values(FONT_SETTINGS)) {
    for (const face of ['regular', 'bold']) {
      if (settings[face]?.url) referenced.add(settings[face].url);
    }
  }
  const missing = [...referenced].filter(
    (url) => !fs.existsSync(path.join(repoRoot, 'public', url)),
  );
  assert.deepEqual(missing, [], 'a code path names a font file that is not shipped');
});

test('every font the user can pick, for either use, resolves to a shipped file', () => {
  // validFonts is the set the config layer accepts. Both the index and the
  // footer select from it, so every member has to land on a file that exists,
  // whether through FONT_SETTINGS or through the fallback.
  const missing = [];
  for (const key of validFonts) {
    for (const url of [footerFontUrl(key), getFontSettings(normaliseFontKey(key)).regular.url,
                       getFontSettings(normaliseFontKey(key)).bold.url]) {
      if (!fs.existsSync(path.join(repoRoot, 'public', url))) missing.push(`${key} -> ${url}`);
    }
  }
  assert.deepEqual(missing, []);
});

// ── A family that is not shipped ─────────────────────────────────────────────

test('TeX Gyre Heros is not in the shipped fonts', () => {
  assert.equal(fs.existsSync(path.join(fontsRoot, 'arialalt', 'texgyreheros')), false,
    'TeX Gyre Heros is on disk; if that is intended, give it a row in FAMILIES');
});

test('no source file names TeX Gyre Heros', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|astro|css|html|json)$/i.test(e.name)) continue;
      // bundletoolConfig.js names it once, in RETIRED_FONTS, on purpose: that
      // map keeps a stored configuration that names it from failing.
      const src = fs.readFileSync(p, 'utf8');
      if (!/texgyre/i.test(src)) continue;
      if (path.basename(p) === 'bundletoolConfig.js') continue;
      offenders.push(path.relative(repoRoot, p));
    }
  };
  walk(path.join(repoRoot, 'layouts'));
  walk(path.join(repoRoot, 'assets'));
  walk(path.join(repoRoot, 'public'));
  assert.deepEqual(offenders, []);
});

test('a stored configuration naming TeX Gyre Heros still loads, in Liberation Sans', () => {
  // The failure this prevents: setting a <select> to a value it has no option
  // for yields '', which reaches validateOptions() as `Invalid index font:`
  // with nothing after the colon, and the bundle never builds.
  assert.equal(normaliseFontKey('texgyreheros'), 'helvetica');
  assert.equal(normaliseFontKey('texGyreHeros'), 'helvetica');
  assert.equal(normaliseFontKey(''), 'helvetica');
  assert.equal(normaliseFontKey(undefined), 'helvetica');
  assert.equal(normaliseFontKey('serif'), 'serif', 'a valid key must pass through untouched');

  const config = new Config();
  config.updateOptions({
    index: { fontFace: 'texgyreheros' },
    pageNumbering: { footerFont: 'texgyreheros' },
  });
  config.validateStructure();
  config.validateOptions();                       // would throw without the coercion
  assert.equal(config.getOption('index.fontFace'), 'helvetica');
  assert.equal(config.getOption('pageNumbering.footerFont'), 'helvetica');
  assert.equal(footerFontUrl('texgyreheros'), FOOTER_FONT_URL);
});

test('a whole bundle configuration that names TeX Gyre Heros renders', async () => {
  // Not just the config object: the page-numbering path has to fetch a font and
  // draw with it. This is the end of the load path the test above starts.
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  const bytes = await applyPageNumbering(await doc.save(), {
    'pageNumbering.footerPrefix': 'Bundle',
    'pageNumbering.alignment': 'centre',
    'pageNumbering.numberingStyle': 'PageX',
    'pageNumbering.footerFont': 'texgyreheros',
    'pageNumbering.footerFontSize': 'medium',
    'pageNumbering.pageNumberColour': 'black',
    'pageNumbering.pageNumberPerSection': false,
  }, [], null);
  assert.ok(bytes.length > 0);
  const reread = await PDFDocument.load(bytes);
  assert.equal(reread.getPageCount(), 1);
});

test('no external font host is referenced anywhere in the site', () => {
  // Self-hosted only. A stylesheet or a preconnect to a font CDN discloses every
  // visitor's IP and user agent to that host on every page load.
  const HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fonts\.bunny\.net|cdnfonts\.com|fontawesome/i;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'fonts') continue;
        walk(p);
        continue;
      }
      if (!/\.(js|mjs|astro|css|html|json|md)$/i.test(e.name)) continue;
      if (HOSTS.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(repoRoot, p));
    }
  };
  walk(path.join(repoRoot, 'layouts'));
  walk(path.join(repoRoot, 'assets'));
  walk(path.join(repoRoot, 'public'));
  assert.deepEqual(offenders, []);
});

test('the default footer font is Liberation Sans and its metrics are pinned', async () => {
  // Liberation Sans is metric-compatible with Arial, and it is both the default
  // footer font and what an unrecognised font key falls back to. The footer's
  // geometry is derived from these widths: for THIS font; every other
  // selectable font gets its own geometry from its own metrics, which is what
  // the measured tests in footer.test.mjs check. A replacement here that is not
  // metric-compatible would move the plate and the label without failing
  // anything else, so the widths themselves are pinned. Measured at 18pt, the
  // medium footer size.
  assert.equal(FOOTER_FONT_URL, '/fonts/arialalt/liberation-sans/LiberationSans-Regular.ttf');

  const doc = await PDFDocument.create();
  doc.registerFontkit(await getFontkit());
  const font = await doc.embedFont(
    fs.readFileSync(path.join(repoRoot, 'public', FOOTER_FONT_URL)),
  );

  // Liberation Sans 1.x gives exactly these widths too: that is what
  // "metric-compatible" has to mean here, not similar but identical.
  const expected = [
    ['Bundle Page 1', 118.09863281249999],
    ['Bundle Page 999', 138.1201171875],
    ['Bundle Page 1000', 148.130859375],
    ['Page 1 of 1234', 122.10644531249999],
  ];
  for (const [text, width] of expected) {
    assert.equal(font.widthOfTextAtSize(text, 18), width,
      `"${text}" does not measure as Arial does: the font is not metric-compatible`);
  }
});

// ── The negative control ─────────────────────────────────────────────────────

test('NEGATIVE CONTROL: an altered licence file really does fail the check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletool-licence-'));
  try {
    const [, licence, sha] = FAMILIES[0];
    const original = fs.readFileSync(path.join(fontsRoot, FAMILIES[0][0], licence));

    // 1. The same bytes must reproduce the pinned hash, or the control below
    //    proves nothing about the real check.
    const copy = path.join(dir, 'copy.txt');
    fs.writeFileSync(copy, original);
    assert.equal(fingerprint(copy), sha, 'control setup failed: an unmodified copy did not match');

    // 2. One character changed anywhere in the text.
    const edited = path.join(dir, 'edited.txt');
    fs.writeFileSync(edited, Buffer.concat([original.subarray(0, 40), Buffer.from('X'), original.subarray(41)]));
    assert.notEqual(fingerprint(edited), sha, 'a one-character edit went undetected');

    // 3. A whitespace-only change: the kind a text editor makes by accident.
    const respaced = path.join(dir, 'respaced.txt');
    fs.writeFileSync(respaced, Buffer.from(original.toString('latin1').replace(/\n/g, '\r\n'), 'latin1'));
    assert.notEqual(fingerprint(respaced), sha, 'a line-ending change went undetected');

    // 4. The realistic one: a different VERSION of the same licence. OFL 1.0 and
    //    OFL 1.1 are both in this repository, so this swap uses real files.
    const ofl10 = path.join(fontsRoot, 'timesalt', 'SIL Open Font License.txt');
    const ofl11 = path.join(fontsRoot, 'serif', 'OFL.txt');
    assert.notEqual(fingerprint(ofl10), fingerprint(ofl11),
      'OFL 1.0 and OFL 1.1 must not fingerprint alike, or a version swap would pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: the version check really does read the binary', async () => {
  // If identify() silently returned undefined for everything, every version
  // assertion above would be comparing undefined to undefined and passing.
  const a = await identify(path.join(fontsRoot, 'arialalt/liberation-sans/LiberationSans-Regular.ttf'));
  const b = await identify(path.join(fontsRoot, 'timesalt/CharisSILR.ttf'));
  assert.ok(a.family && a.version, 'identify() read nothing out of the font');
  assert.notEqual(a.family, b.family, 'identify() is not distinguishing between fonts');
  assert.notEqual(a.version, b.version);
});
