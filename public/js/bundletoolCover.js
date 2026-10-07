/**
 * BundleTool
 * Copyright (c) 2026 CaseForge
 *
 * bundletoolCover.js
 * The automatically generated cover page.
 *
 * LICENCE NOTE. This file carries no MPL-2.0 header, unlike most of
 * public/js/. That is deliberate: none of its code comes from BunTool, which
 * has no cover-page feature. The layout follows CaseForge's own Python command
 * line bundle tool (its draw_case_heading() and build_cover_pdf()), which the
 * page-number footer's plate geometry also follows. MPL-2.0 is file-level
 * copyleft, so a file that contains no covered code does not become covered by
 * sitting beside ones that do. Every file that carries the notice keeps it
 * (tests/policy.test.mjs enforces that), and the credit to BunTool stays in
 * the page footer.
 *
 * ONE DOOR TO THE COVER. The coversheet maker (frontend/coverEditor.js) is the
 * only way a cover is configured: confirming a design there sets
 * `pageOptions.generateCover` and this module draws it at build time from the
 * confirmed fields. A generated cover only ever draws what the user typed, so
 * there is no separate automatic cover. Generating with no cover chosen warns
 * and continues rather than blocking.
 *
 * PRECEDENCE. An uploaded coversheet wins. If the user has supplied their own
 * first page, that is the cover and nothing is generated: the failure this
 * avoids is a bundle with two cover pages, which is worse than either choice.
 * processTheBundle() resolves this once, into `pageOptions.coverSource`, and
 * everything downstream reads that.
 *
 * WHY pdf-lib AND NOT jsPDF. The index is drawn with jsPDF, so using it here
 * would match. pdf-lib is already the engine for every other page in the
 * bundle and runs under Node, so this page can be rendered and measured in the
 * test suite instead of inspected by eye.
 *
 * TWO LAYOUTS, `cover.layout`: `'classic'` (the default) or `'grid'` (a
 * selectable alternative). Both are drawn by layoutCover() below, sharing
 * every helper and every field except the layout-specific geometry itself.
 *
 * GEOMETRY. The classic layout follows the Python tool's draw_case_heading():
 * a "BETWEEN: / applicant / -and- / respondent" block, then the title between
 * two ruled lines. The `'grid'` alternative is a plain four-corner grid,
 * closer to a title page than a pleading:
 *   top:    the court and the case number (on the court's line or on its
 *           own, see LAYOUT SETTINGS below), then the "In the Matter Of"
 *           lines (see MULTIPLE LINES below), for the common children-matter
 *           case of "THE CHILDREN ACT 1989" and the child's name needing
 *           separate lines.
 *   middle: applicants aligned to the left margin and respondents to the
 *           right, each with its role label in the same column; there is no
 *           "BETWEEN:" and no joining word.
 *   title:  the bundle title (coverTitle()) centred beneath the parties at
 *           the title size, between the same two rules as the classic layout,
 *           with the free text beneath it.
 *   bottom: "Prepared by: <author>" fixed to the foot, bottom-right.
 * Neither layout draws FL401/C100 recitals or a children block: they need
 * structured fields (statute flags, a list of children with dates of birth)
 * this app has no model for, and free-text stand-ins would put unchecked
 * recitals on the front of a court bundle. Use `matterOf` for the statute and
 * child-name lines instead.
 *
 * NO DUPLICATION, BOTH LAYOUTS. `heading.projectName` (the "Parties" field,
 * the case name in free text) is not drawn on the cover: it repeats the
 * parties band that both layouts have (the classic BETWEEN/-and- block and
 * the grid's middle band). It is still collected and still reaches the PDF's
 * Subject metadata (bundletoolMeta.js).
 *
 * MULTIPLE LINES, BOTH LAYOUTS. `cover.matterOf`, `cover.applicantName` and
 * `cover.respondentName` are textareas: one line per `\n`, capped at 4
 * parties a side, and both layouts cope with whatever they hold. Classic
 * stacks the parties in one column; the grid draws them in its two
 * independent columns. The cap is enforced in layoutCover() below, on the
 * DRAWING side, not left to the textarea alone, because a manifest import or
 * a settings code can hand this module a value the UI never validated.
 *
 * LAYOUT SETTINGS, both designs. There are two designs; every other variation
 * is a setting:
 *   `cover.caseNumberLine`     'court' puts the case number on the court's line, at the right (the court
 *                              wraps narrower so they never meet); 'own' puts it on a line of its own between
 *                              the court and the "In the matter of" lines. A case number too long to leave the
 *                              court 140pt drops to its own line by itself.
 *   `cover.partyLabelPlacement` 'below' puts each role label under its name, aligned as the name is (so centred
 *                              names get a centred label); 'inline' puts it on the name's first line at the far
 *                              side of the column, with the name wrapped narrower by the label's width.
 *   `cover.caseNumberAlign`    left, centre or right (default right) for the case number when it has a line
 *                              of its own; dimmed when it shares the court's line.
 *   `cover.headingAlign`       left, centre or right (default left) for the court and the "In the matter of"
 *                              lines. With the case number on the court's line the court is aligned inside the
 *                              column left of the case number (see courtAndCase()).
 *   `cover.partyAlign`         left, centre or right, for the stacked design's party names (and its
 *                              partyJoiner, "-and-" by default). The two-column design keeps applicants left
 *                              and respondents right, so it ignores this one.
 *   `cover.titleLines`         'single' (default) or 'double': one rule above and below the title, or two thin
 *                              rules each. See TITLE_RULE_TEXT_GAP for how the text is centred between them.
 *
 * Three more settings are freely overridable prefixes or joining words, not toggles, on the same footing
 * as the party labels: `cover.caseNumberLabel` ("CASE NO:" by default), `cover.preparedByLabel`
 * ("Prepared by:" by default) and `cover.partyJoiner` ("-and-" by default, following the judiciary.uk
 * directions templates: "-and-" is the standard civil and family joiner, "-v-" a common alternative;
 * criminal matters use "R v [Defendant]" instead of a BETWEEN heading, which this tool never draws). All
 * three tell "key absent" (the stored default) apart from "key present and blank" (no prefix, no label or
 * no joining word at all): see where layoutCover() reads them.
 *
 * DEFAULTS: the default cover is the compact one: the stacked design, the case number on the court's line,
 * each role label on its name's line, names centred, headings left. A cover that stored one of these keeps
 * it; only a missing value takes the default.
 * When a side has more than one person (up to four) each label is numbered: 1ST APPLICANT, 2ND APPLICANT.
 *
 * FITTING. Long names wrap, and wrapping can push the content past the page.
 * The gaps are scaled down in fixed steps until it fits above the page-number
 * footer's zone; the text is never scaled, because a cover page in a smaller
 * typeface than the rest of the bundle looks like a mistake.
 */

import { PDFDocument, rgb, getFontkit } from './bundletoolPdfLib.js';
import { getFontSettings } from './bundletoolFontSettings.js';
import { normaliseFontKey } from './bundletoolConfig.js';
import { pageDimensions } from './bundletoolPageSize.js';

/** A4, the default. layoutCover() resolves the ACTUAL size from
 *  `pageOptions.pageSize` and shadows these, so the layout maths below reads
 *  the page it is drawing on rather than assuming A4. Exported because the
 *  tests and the coversheet editor's aspect ratio both reference them. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 60;
export const FONT_SIZE = 10;
export const TITLE_FONT_SIZE = 14;
export const RULE_WIDTH = 1.5;
export const LINE_GAP = 15;          // wrap_text()'s per-line step in the CLI
export const TITLE_LINE_GAP = 20;
/**
 * The title's rules. Two of them always frame the title, on both designs, whatever its length or wrapping: one
 * above and one below, or with cover.titleLines 'double' two thin ones each. The gap between a rule and the
 * ink of the text is one constant, TITLE_RULE_TEXT_GAP, and it is the same above and below: measured from the
 * near edge of the rule to the top of the capitals (the font's real cap height at the title size) above, and
 * from the baseline to the near edge of the rule below. The title is drawn in capitals, so the baseline is
 * the bottom of the ink; a comma or a Q dipping under it is not counted. With a double line the gap is
 * measured from the inner rule of each pair.
 */
export const TITLE_RULE_TEXT_GAP = 14;
export const DOUBLE_RULE_WIDTH = 0.75;
export const DOUBLE_RULE_SEP = 2.5;   // clear space between the two thin rules of a pair
/** Fallback cap height, as a fraction of the size, for a font that does not report one. */
const CAP_HEIGHT_FALLBACK = 0.7;

/**
 * "Prepared by" sits at this baseline, and no flowed content is allowed below
 * it. The page-number footer's plate starts 8pt up and is at most about 47pt
 * tall at the largest footer size, with 4pt of blanking above that: so the
 * highest the footer can reach is roughly 51pt. 70 clears it; 96 is where the
 * flowed content above has to stop so it does not collide with this line.
 */
export const PREPARED_BY_Y = 70;
export const CONTENT_FLOOR = 96;

/** Gap scales tried in order until the content fits. Text size never changes. */
const GAP_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3];

const BLACK = rgb(0, 0, 0);

/**
 * Flattens a Config into the plain dictionary this module reads.
 *
 * Same shape as flattenFooterConfig()/flattenConfig() elsewhere, and for the
 * same reason: one list, so a worker path and a direct path cannot drift.
 *
 * @param {Object} config
 * @returns {Object}
 */
export function flattenCoverConfig(config) {
  const keys = [
    'heading.claimNumber', 'heading.bundleTitle', 'heading.projectName',
    'heading.author',
    'index.fontFace',
    'cover.courtName', 'cover.matterOf', 'cover.applicantName', 'cover.respondentName',
    'cover.partyLabel1', 'cover.partyLabel2', 'cover.layout',
    'cover.caseNumberLine', 'cover.partyLabelPlacement', 'cover.partyAlign',
    'cover.caseNumberAlign', 'cover.headingAlign', 'cover.titleLines', 'cover.caseNumberLabel', 'cover.preparedByLabel',
    'cover.partyJoiner',
    'cover.extraText', 'cover.claimNumber', 'cover.bundleTitle', 'cover.author',
    'pageOptions.pageSize',
  ];
  const out = {};
  for (const key of keys) out[key] = config.getOption(key);
  return out;
}

/**
 * Which cover page a build gets.
 *
 * Kept out of processTheBundle() so it can be tested: bundletoolMain.js pulls
 * in the jsPDF index path, which imports a vendored ESM module by URL and cannot be
 * imported under Node at all, so nothing inside that file is reachable from the test
 * suite. This rule is the one thing in it worth asserting.
 *
 * `generateCover` must be explicitly true: covers are opt-in through the
 * maker, so silence means none.
 *
 * @param {{hasUploadedCover: boolean, generateCover: boolean}} opts
 * @returns {'uploaded'|'generated'|'none'}
 */
export function resolveCoverSource({ hasUploadedCover, generateCover }) {
  if (hasUploadedCover) return 'uploaded';   // the user's own page always wins
  return generateCover === true ? 'generated' : 'none';
}

const text = (cv, key) => String(cv[key] ?? '').trim();

/**
 * A cover field that may be overridden: the cover's own value when it has one (even an
 * empty one, so the cover can leave a line out that Basic Information fills), else the
 * Basic Information value. null or undefined means no override.
 */
const pick = (cv, own, basic) => (cv[own] === null || cv[own] === undefined ? text(cv, basic) : text(cv, own));

/**
 * The title that sits between the two rules.
 *
 * @param {Object} cv - flat config values
 * @returns {string}
 */
export function coverTitle(cv) {
  return (pick(cv, 'cover.bundleTitle', 'heading.bundleTitle') || 'BUNDLE').toUpperCase();
}

/**
 * Greedy word wrap against the font the line is actually drawn in.
 *
 * A word longer than the line is left to overflow rather than broken: a case
 * number or a hyphenless surname split across two lines is harder to read than
 * one that runs slightly wide, and this is a cover page, not body text.
 *
 * @param {string} value
 * @param {Object} font - an embedded pdf-lib font
 * @param {number} size
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapText(value, font, size, maxWidth) {
  const words = String(value ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
    else { lines.push(current); current = word; }
  }
  lines.push(current);
  return lines;
}

/**
 * Lays the cover out, optionally drawing it.
 *
 * Called first with `page` null to find out how far down the content reaches,
 * then again with a page once a gap scale that fits has been chosen. One
 * function does both so the measured layout and the drawn layout cannot differ.
 *
 * @param {Object} cv - flat config values
 * @param {{regular: Object, bold: Object}} fonts
 * @param {number} gapScale
 * @param {Object|null} page - a pdf-lib page, or null to measure only
 * @returns {number} the baseline the last flowed line was placed on
 */
export function layoutCover(cv, fonts, gapScale, page = null) {
  const { regular, bold } = fonts;
  // The page this cover is actually being drawn on.
  const [PAGE_WIDTH, PAGE_HEIGHT] = pageDimensions(cv['pageOptions.pageSize']);
  const usable = PAGE_WIDTH - 2 * MARGIN;
  let y = PAGE_HEIGHT - MARGIN;
  // Two designs: 'classic' (parties stacked in one column between "BETWEEN:" and the ruled title) and 'grid'
  // (parties in two columns). Both rule the title. Anything else, including a stored config with no layout field,
  // falls back to 'classic'.
  const isGrid = cv['cover.layout'] === 'grid';
  // Settings shared by both designs (see LAYOUT SETTINGS in the file header).
  const caseOwnLine = cv['cover.caseNumberLine'] === 'own';
  const labelInline = cv['cover.partyLabelPlacement'] === 'inline';
  const alignOf = (value, fallback) => (['left', 'right', 'centre'].includes(value) ? value : fallback);
  // Where the court and the "In the matter of" lines sit (left by default), and where the case number sits when it
  // has a line of its own (right by default, where it sits on the court's line).
  const headingAlign = alignOf(cv['cover.headingAlign'], 'left');
  const caseAlign = alignOf(cv['cover.caseNumberAlign'], 'right');
  const partyAlign = ['left', 'right'].includes(cv['cover.partyAlign']) ? cv['cover.partyAlign'] : 'centre';

  const gap = (points) => { y -= points * gapScale; };

  /** Draws one line inside [x0, x1] (the full margin-to-margin width by default). */
  const draw = (value, { font = bold, size = FONT_SIZE, align = 'left', colour = BLACK, at = null, x0 = MARGIN, x1 = PAGE_WIDTH - MARGIN } = {}) => {
    if (!page || !value) return;
    const width = font.widthOfTextAtSize(value, size);
    let x = x0;
    if (align === 'centre') x = x0 + (x1 - x0 - width) / 2;
    else if (align === 'right') x = x1 - width;
    page.drawText(value, { x, y: at ?? y, size, font, color: colour });
  };

  const rule = (at = y, thickness = RULE_WIDTH) => {
    if (!page) return;
    page.drawLine({
      start: { x: MARGIN, y: at },
      end: { x: PAGE_WIDTH - MARGIN, y: at },
      thickness,
      color: BLACK,
    });
  };

  /** The height of the capitals at `size`, from the font's own metrics when it has them. */
  const capHeightOf = (font, size) => {
    const f = font.embedder?.font;
    const cap = f && Number.isFinite(f.capHeight) && f.capHeight > 0 && f.unitsPerEm ? (f.capHeight / f.unitsPerEm) * size : 0;
    return cap || CAP_HEIGHT_FALLBACK * size;
  };

  /**
   * The title framed by its rules, on both designs. y comes in as the centre of the outer upper rule and goes
   * out as the centre of the outer lower rule. The text is set so the gap above it equals the gap below it
   * (see TITLE_RULE_TEXT_GAP); that gap is not scaled with the other gaps, so the two can never differ.
   */
  const titleBlock = () => {
    const double = cv['cover.titleLines'] === 'double';
    const thickness = double ? DOUBLE_RULE_WIDTH : RULE_WIDTH;
    const step = thickness + DOUBLE_RULE_SEP;
    const lines = wrapText(title, bold, TITLE_FONT_SIZE, usable);
    rule(y, thickness);
    let inner = y;
    if (double) { inner = y - step; rule(inner, thickness); }
    y = inner - thickness / 2 - TITLE_RULE_TEXT_GAP - capHeightOf(bold, TITLE_FONT_SIZE);
    drawLines(lines, { size: TITLE_FONT_SIZE, align: 'centre', lineGap: TITLE_LINE_GAP });
    inner = y - TITLE_RULE_TEXT_GAP - thickness / 2;
    rule(inner, thickness);
    y = inner;
    if (double) { y = inner - step; rule(y, thickness); }
  };

  /**
   * A block of already-wrapped lines; advances y by the line gap between
   * lines only.
   */
  const drawLines = (lines, { font = bold, size = FONT_SIZE, align = 'left', colour = BLACK, lineGap = LINE_GAP, x0, x1 } = {}) => {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) y -= lineGap;
      draw(lines[i], { font, size, align, colour, x0, x1 });
    }
    return lines.length;
  };

  /**
   * A block of wrapped lines; advances y by the line gap between lines only.
   * maxWidth defaults to the full margin-to-margin width.
   */
  const block = (value, { font = bold, size = FONT_SIZE, align = 'left', colour = BLACK, lineGap = LINE_GAP, maxWidth = usable, x0, x1 } = {}) =>
    drawLines(wrapText(value, font, size, maxWidth), { font, size, align, colour, lineGap, x0, x1 });

  /** Splits a multi-line field into trimmed, non-empty lines, capped at n. */
  const linesOf = (value, cap = Infinity) =>
    String(value ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, cap);

  const court = text(cv, 'cover.courtName');
  const matterOfRaw = linesOf(cv['cover.matterOf']);
  const matterOfLines = matterOfRaw.flatMap((line) => wrapText(line, bold, FONT_SIZE, usable));
  const caseNumber = pick(cv, 'cover.claimNumber', 'heading.claimNumber');
  // Freely overridable, the same way the party labels are. "CASE NO:" is the stored default;
  // a firm can set it to "CLAIM NO:", "ORDER NO:", their own wording, or clear it for no
  // prefix at all, and the number then stands on its own with nothing before it.
  // Absent from cv (a caller that never passed it through flattenCoverConfig) it defaults to
  // "CASE NO:", the same as the setting's own stored default; an explicit empty string is a
  // real, different choice (no prefix), never folded into that default. "Key not present"
  // and "key present and blank" must be told apart here, because blank is meaningful.
  const caseNumberLabel = cv['cover.caseNumberLabel'] === undefined ? 'CASE NO:' : String(cv['cover.caseNumberLabel']).trim();
  // Up to 4 names a side: a hard cap here, not just a UI hint, because this module also
  // receives values from a settings code or an imported manifest that never passed through the textarea. The
  // cap counts PARTIES, not wrapped display lines: a long name wrapping to two lines is still one applicant.
  const applicants = linesOf(cv['cover.applicantName'], 4);
  const respondents = linesOf(cv['cover.respondentName'], 4);
  // The role labels. Not every matter is Applicant v Respondent (civil work says Claimant and Defendant), so
  // the pair is a setting with the family-court wording as its default. Drawn in caps, matching the filed
  // house style. When a side has more than one person each is numbered ("1ST APPLICANT", "2ND APPLICANT").
  const partyLabel1 = (text(cv, 'cover.partyLabel1') || 'Applicant').toUpperCase();
  const partyLabel2 = (text(cv, 'cover.partyLabel2') || 'Respondent').toUpperCase();
  const preparedBy = pick(cv, 'cover.author', 'heading.author');
  // Same rule as caseNumberLabel just above: "key not present" defaults to "Prepared by:", the
  // stored default; "key present and blank" is a real, different choice (no label at all).
  // Unlike the case number, "Prepared by" is never wrapped: it is one fixed line above the
  // footer (see below), not a block() call that can drop the number to its own line when it
  // will not fit. Clamped to 40 characters here, not just by the HTML field's maxlength, so a
  // manifest or a settings link cannot ask for a label the UI would never let anyone type: 40
  // characters holds with an author value up to 63 characters in the tightest combination
  // (two columns, A4, sans).
  const preparedByLabel = (cv['cover.preparedByLabel'] === undefined ? 'Prepared by:' : String(cv['cover.preparedByLabel']).trim()).slice(0, 40);
  // Same rule again: "key not present" defaults to "-and-", the stored default; "key present and
  // blank" is a real, different choice (just the gap between the two party stacks, no word in
  // it). Drawn alone on its own line at the classic design's full margin-to-margin width, never
  // concatenated with another value, so 40 characters (the same clamp preparedByLabel uses)
  // leaves generous headroom well inside the page even at the widest character.
  const partyJoiner = (cv['cover.partyJoiner'] === undefined ? '-and-' : String(cv['cover.partyJoiner']).trim()).slice(0, 40);
  const title = coverTitle(cv);

  const ordinal = (n) => `${n}${['TH', 'ST', 'ND', 'RD'][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
  const labelFor = (base, index, count) => (count > 1 ? `${ordinal(index + 1)} ${base}` : base);
  const LABEL_GAP = 14;
  const PARTY_GAP = 26;
  const CASE_GAP = 24;
  const SHARE_MIN_COURT = 140;

  /**
   * One side's parties, drawn inside the column [x0, x1] and aligned left, centre or right in it. The label goes
   * either under each name (aligned like the name) or on the name's first line at the far side of the column;
   * names are wrapped narrower by the label's width so a name and its label can never touch. Leaves y on the last
   * baseline used; the caller adds the gap that follows.
   */
  const partyStack = (parties, base, { x0, x1, align }) => {
    parties.forEach((name, i) => {
      if (i > 0) gap(PARTY_GAP);
      const label = labelFor(base, i, parties.length);
      if (labelInline) {
        const labelW = bold.widthOfTextAtSize(label, FONT_SIZE);
        // A centred name keeps the same room on both sides so it stays centred; otherwise the label takes the
        // side the name is not aligned to.
        const reserve = (labelW + LABEL_GAP) * (align === 'centre' ? 2 : 1);
        const lines = wrapText(name, bold, FONT_SIZE, Math.max(60, x1 - x0 - reserve));
        draw(label, { align: align === 'right' ? 'left' : 'right', x0, x1 });
        drawLines(lines, { align, x0, x1 });
      } else {
        drawLines(wrapText(name, bold, FONT_SIZE, x1 - x0), { align, x0, x1 });
        gap(20);
        draw(label, { align, x0, x1 });
      }
    });
  };

  /**
   * The court, and the case number either on the court's line or on a line of its own beneath it.
   *
   * Sharing the line: the case number sits at the right margin and the court takes the column to its left, wrapped
   * to (usable width - case number width - 24pt gap) and aligned left, centre or right INSIDE that column, so the
   * two never meet whatever the alignment. If that column would be narrower than SHARE_MIN_COURT (140pt) the case
   * number drops to its own line instead. On its own line the case number is aligned by cover.caseNumberAlign
   * across the whole width.
   */
  const courtAndCase = () => {
    const caseText = caseNumber ? (caseNumberLabel ? `${caseNumberLabel} ${caseNumber}` : caseNumber) : '';
    if (!court && !caseText) return false;
    const caseW = caseText ? bold.widthOfTextAtSize(caseText, FONT_SIZE) : 0;
    const courtW = usable - caseW - CASE_GAP;
    const shares = Boolean(court) && caseText && !caseOwnLine && courtW >= SHARE_MIN_COURT;
    // On a line of its own the case number wraps at spaces if it is wider than the page (two joined numbers
    // can be), and one unbroken reference is never split.
    if (!court) {
      block(caseText, { align: caseAlign });
    } else if (shares) {
      draw(caseText, { align: 'right' });
      block(court, { align: headingAlign, maxWidth: courtW, x0: MARGIN, x1: MARGIN + courtW });
    } else {
      block(court, { align: headingAlign });
      if (caseText) { gap(20); block(caseText, { align: caseAlign }); }
    }
    return true;
  };

  if (isGrid) {
    // ── GRID: court and case number top-left, the two sides in two columns, the ruled title centred beneath them,
    // "Prepared by" bottom-right on the foot. ───────────────────────────────

    if (courtAndCase()) gap(24);
    // In the Matter Of: one line per line the user typed, each wrapped if too long on its own.
    for (const line of matterOfLines) {
      draw(line, { align: headingAlign });
      gap(18);
    }
    if (court || caseNumber || matterOfLines.length) gap(16);

    // Two independent columns from the same top, each its own stack (one applicant, two respondents is normal).
    // The applicants keep to the left edge and the respondents to the right.
    if (applicants.length || respondents.length) {
      const colW = usable / 2 - 10;
      const top = y;
      let bottomLeft = top;
      let bottomRight = top;
      if (applicants.length) {
        partyStack(applicants, partyLabel1, { x0: MARGIN, x1: MARGIN + colW, align: 'left' });
        bottomLeft = y;
      }
      y = top;
      if (respondents.length) {
        partyStack(respondents, partyLabel2, { x0: PAGE_WIDTH - MARGIN - colW, x1: PAGE_WIDTH - MARGIN, align: 'right' });
        bottomRight = y;
      }
      y = Math.min(bottomLeft, bottomRight);
      gap(40);
    }

    // The title, centred beneath the parties at the title size, framed by its two rules like the stacked design.
    titleBlock();
    gap(30);

    // Free text from the coversheet maker, one block per line the user typed, beneath the title.
    const extraText = text(cv, 'cover.extraText');
    if (extraText) {
      for (const line of extraText.split('\n').map((l) => l.trim()).filter(Boolean)) {
        block(line, { font: regular, size: FONT_SIZE, align: 'centre' });
        gap(20);
      }
    }

    const contentBottom = y;

    // "Prepared by" fixed to the foot of the page above the page-number footer's zone, bottom-right.
    if (preparedBy) {
      const preparedText = preparedByLabel ? `${preparedByLabel} ${preparedBy}` : preparedBy;
      draw(preparedText, { font: regular, size: 9, align: 'right', at: PREPARED_BY_Y });
    }

    return contentBottom;
  }

  // ── CLASSIC: court and case number, "BETWEEN:", the parties stacked in one column (aligned left, centre or
  // right) joined by "-and-", the title ruled above and below, "Prepared by" fixed to the foot, bottom-left. ──

  if (courtAndCase()) gap(matterOfLines.length ? 18 : 40);

  // The statute/matter-of lines beneath the court, one per line typed. Optional: a bundle with none omits it, and
  // the gap above stays at 40.
  for (let i = 0; i < matterOfLines.length; i++) {
    draw(matterOfLines[i], { align: headingAlign });
    gap(i < matterOfLines.length - 1 ? 18 : 40);
  }

  // The parties beneath a "BETWEEN:" heading, joined by partyJoiner ("-and-" by default) when
  // both are present. Each side is independently optional: a solicitor may only know one side yet.
  if (applicants.length || respondents.length) {
    draw('BETWEEN:', { align: 'left' });
    gap(40);
    const region = { x0: MARGIN, x1: PAGE_WIDTH - MARGIN, align: partyAlign };
    if (applicants.length) {
      partyStack(applicants, partyLabel1, region);
      gap(applicants.length && respondents.length ? 30 : 40);
    }
    if (applicants.length && respondents.length) {
      if (partyJoiner) draw(partyJoiner, { align: partyAlign });
      gap(50);
    }
    if (respondents.length) {
      partyStack(respondents, partyLabel2, region);
      gap(40);
    }
  }

  // The title, ruled above and below.
  titleBlock();

  // Free text from the coversheet maker, one block per line the user typed.
  const extraText = text(cv, 'cover.extraText');
  if (extraText) {
    for (const line of extraText.split('\n').map((l) => l.trim()).filter(Boolean)) {
      gap(20);
      block(line, { font: regular, size: FONT_SIZE, align: 'centre' });
    }
  }

  const contentBottom = y;

  // Fixed to the foot of the page, above the page-number footer's zone. Bottom-LEFT here, unlike grid's bottom-right.
  if (preparedBy) {
    const preparedText = preparedByLabel ? `${preparedByLabel} ${preparedBy}` : preparedBy;
    draw(preparedText, { font: regular, size: 9, align: 'left', at: PREPARED_BY_Y });
  }

  return contentBottom;
}

/**
 * Fetches and embeds one font file.
 *
 * NOT subsetted, despite the file-size case for it. pdf-lib embeds the entire
 * font file by default, and a cover page draws a few dozen glyphs from a font
 * that can be 400 KB on disk, but with subset:true most glyphs are missing
 * from the rendered page: only a handful of letters (E, L, R and a few others)
 * paint, and every other character comes out as blank advance width. The
 * fault lies in the way fontkit and pdf-lib subset a font, not in this file's
 * layout (layoutCover()'s measure and draw passes are not involved: draw()
 * only calls page.drawText on the real page). subset:false costs roughly
 * another 500 KB across the two embedded faces (regular and bold), which is
 * worth it for a correct cover page in a bundle that is typically many times
 * that size already.
 */
async function embed(doc, url) {
  // The fetch itself, not its resolved value, is cached: two overlapping calls for the same
  // url (two covers drawn without waiting on each other) must share one ArrayBuffer instance,
  // or cachedFontkit's identity-keyed cache below misses for the second and reparses, giving
  // two covers that should be identical a one-byte-deep difference somewhere in a serialised
  // font object.
  let pending = faceBytes.get(url);
  if (!pending) {
    pending = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`font fetch failed: ${url} (${r.status})`);
      return r.arrayBuffer();
    });
    faceBytes.set(url, pending);
  }
  return doc.embedFont(await pending, { subset: false });
}

/**
 * The cover is drawn again on every keystroke in the cover maker, and fetching and parsing the two font files
 * on every draw would be most of the cost (the parse above all). Each face's bytes are kept once per page load,
 * and fontkit is wrapped so the same bytes give the same parsed font: the output PDF is byte for byte the same as
 * without the cache, and only the repeated work is saved. The wrapper only remembers a whole buffer it has seen
 * before; anything else goes straight to fontkit.
 */
const faceBytes = new Map();
const parsedFaces = new WeakMap();
// Built once fontkit itself has loaded, then memoised the same way: every caller after the first gets
// the same wrapper object, not a second one closing over a second copy of parsedFaces. Cleared on
// rejection, for the same reason as getFontkit() itself: a later draw gets a fresh attempt, not a
// standing failure for the rest of the page's life.
let _cachedFontkitPromise = null;
function getCachedFontkit() {
  if (!_cachedFontkitPromise) {
    const p = getFontkit().then((fontkit) => ({
      ...fontkit,
      create(data, ...rest) {
        const whole = rest.length === 0 && data && data.buffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
        if (!whole) return fontkit.create(data, ...rest);
        let font = parsedFaces.get(data.buffer);
        if (!font) { font = fontkit.create(data); parsedFaces.set(data.buffer, font); }
        return font;
      },
    }));
    p.catch(() => { if (_cachedFontkitPromise === p) _cachedFontkitPromise = null; });
    _cachedFontkitPromise = p;
  }
  return _cachedFontkitPromise;
}

/**
 * Renders the cover page.
 *
 * Uses the index font, so the cover and the index in front of the same bundle
 * are set in the same typeface.
 *
 * @param {Object} cv - flat config values, from flattenCoverConfig()
 * @returns {Promise<Uint8Array>} a one-page PDF at the configured page size
 */
export async function makeCoverPdf(cv) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(await getCachedFontkit());

  // Sequential, not Promise.all: pdf-lib assigns each embedded font's internal object number in
  // embedding order, and the two calls' relative finishing order is not stable (a fresh network
  // fetch and an already-cached lookup do not race the same way twice). In parallel, two draws of
  // the same cover could give an identical rendered page but a differently ordered PDF object
  // table, with the fetched bytes, the fonts and the drawn content all otherwise identical.
  const settings = getFontSettings(normaliseFontKey(cv['index.fontFace']));
  const regular = await embed(doc, settings.regular.url);
  const bold = await embed(doc, settings.bold.url);
  const fonts = { regular, bold };

  let chosen = GAP_SCALES[GAP_SCALES.length - 1];
  for (const scale of GAP_SCALES) {
    if (layoutCover(cv, fonts, scale, null) >= CONTENT_FLOOR) { chosen = scale; break; }
  }

  const page = doc.addPage(pageDimensions(cv['pageOptions.pageSize']));
  layoutCover(cv, fonts, chosen, page);
  return doc.save();
}
