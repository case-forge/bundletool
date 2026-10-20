/**
 * Pure string and date utilities: no DOM, no imports, no side effects.
 * `chrono` is passed in from outside since it's lazy-loaded.
 */

/**
 * "YYYY-MM-DD" when the three parts name a real calendar day, else null. Date silently rolls an
 * impossible day over ("30-02-2026" becomes 2 March), and a wrong date in an index is worse than
 * none, so an impossible match is treated as no date found.
 */
function realCalendarDate(year, month, day) {
  const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().split('T')[0];
  return iso === `${year}-${month}-${day}` ? iso : null;
}

/**
 * @param {string} filename
 * @param {import('chrono-node')} chrono
 * @param {'UK'|'US'} [dateInputOrder] - which reading wins for a genuinely ambiguous slash/dash
 *   date (both numbers 12 or under, so either could be the day or the month). A number over 12 is
 *   never ambiguous either way and is unaffected by this. Default 'UK' (day-first), matching
 *   Config's own default, so a caller that omits this reads filenames day-first.
 */
export async function parseDateFromFilename(filename, chrono, dateInputOrder = 'UK') {
  let matchedDate = null;
  let filenameWithoutDate = filename;

  // A numeric date in the name beats a written-out one, on purpose: people put the numeric date
  // at the end of a document's name to say when it was made, while a written-out date in the title
  // ("Statement re the events of 3 April 2026") is usually the evidence, report or event it is about.
  // The numeric formats are therefore tried first, and chrono's written-date reading is only the fallback.
  const yearFirstDateRegex = /(?<!\d)[\[\(]{0,1}(1\d{3}|20\d{2})[-._]?(0[1-9]|1[0-2])[-._]?(0[1-9]|[12][0-9]|3[01])[\]\)]{0,1}(?!\d)/;
  const yearLastDateRegex  = /(?<!\d)[\[\(]{0,1}(0[1-9]|[12][0-9]|3[01])[-._]?(0[1-9]|1[0-2])[-._]?(1\d{3}|20\d{2})[\]\)]{0,1}(?!\d)/;

  const yearFirstMatch = filename.match(yearFirstDateRegex);
  if (yearFirstMatch) {
    // Year-first is never ambiguous: the regex itself fixes month-then-day in this order, the
    // same under every reading, so dateInputOrder has no bearing here.
    const [fullMatch, year, month, day] = yearFirstMatch;
    const isoDate = realCalendarDate(year, month, day);
    if (isoDate) {
      filenameWithoutDate = filenameWithoutDate.replace(fullMatch, '').replace(/^[\s-_]+|[\s-_]+$/g, '');
      return { date: isoDate, name: filenameWithoutDate };
    }
  }

  const yearLastMatch = filename.match(yearLastDateRegex);
  if (yearLastMatch) {
    let [fullMatch, day, month, year] = yearLastMatch;
    // Genuinely ambiguous only when BOTH groups could be either role (both <= 12): the regex's
    // own ranges already mean a day over 12 can only ever be a day, under either reading, so this
    // swap never fires for those: "13-04-2026" reads as 13 April regardless of dateInputOrder.
    if (dateInputOrder === 'US' && Number(day) <= 12 && Number(month) <= 12) {
      [day, month] = [month, day];
    }
    const isoDate = realCalendarDate(year, month, day);
    if (isoDate) {
      filenameWithoutDate = filenameWithoutDate.replace(fullMatch, '').replace(/^[\s-_]+|[\s-_]+$/g, '');
      return { date: isoDate, name: filenameWithoutDate };
    }
  }

  // No logging in here: this runs once per added document and the only thing
  // it could log is the document's own name, which has no business in the
  // console of a shared machine.
  // en.GB reads an ambiguous slash date day-first; chrono's own plain (unlocalised) parser reads
  // the same shape month-first out of the box, so dateInputOrder picks between the two presets
  // chrono itself ships, rather than this file reimplementing either reading. Both presets agree
  // on a genuinely unambiguous date (a two-digit year included), so this only changes anything
  // for the truly ambiguous case. The same parser is used for BOTH the parse and the
  // isDateFixed() stability check below: re-reading "03/04/2026" as GB never agrees with how it
  // was first read as US, so checking with a different parser would reject every genuine
  // US-ordered match.
  const chronoParser = chrono ? (dateInputOrder === 'US' ? chrono : (chrono.en?.GB ?? chrono)) : null;
  const chronoParsedResult = chronoParser ? chronoParser.parse(filename) : [];
  // The first match is not necessarily a usable one: "Statement today, dated 2 June 2026" matches
  // "today" first and the real date second, so every match is tried in order, not just the
  // first, and the first one that names a real calendar date (not a clock-dependent guess) wins.
  const fixedMatch = chronoParsedResult.find((result) => isDateFixed(result, chronoParser));
  if (fixedMatch) {
    const parsedDate = fixedMatch.start.date();
    matchedDate = parsedDate.toISOString().split('T')[0];
    const matchedInputText = fixedMatch.text;
    filenameWithoutDate = filenameWithoutDate.replace(matchedInputText, '').replace(/^[\s-_]+|[\s-_]+$/g, '');
    return { date: matchedDate, name: filenameWithoutDate };
  }

  return { date: null, name: filenameWithoutDate };
}

/**
 * True when a chrono match names a real calendar date, false when it only reads that way
 * because of WHEN the file happened to be added. "today", "yesterday", "next Friday" and a
 * bare day and month with no year (which chrono fills in from the current year) all parse to a
 * confident-looking date, but it is the browser's clock speaking, not the filename: reopen the
 * bundle in a year and the same file would guess a different day. chrono-node's own
 * isCertain('day'/'month'/'year') does not catch this: chrono marks "today" itself as certain,
 * since once resolved there is no ambiguity about *which* day it names.
 *
 * The one general test that does catch it: re-parse the same text against a reference date far
 * from the real one. A date actually written in the filename ("15-09-2026") comes out the same
 * either way. A date only implied by the browser's clock changes with it, and is rejected here
 * rather than guessed at.
 *
 * @param {object} result - one of the first parse's own matches
 * @param {object} parser - the SAME parser (chrono.en.GB, or base chrono under US ordering) that
 *   produced `result`. Re-parsing with a different locale than the one that produced the result
 *   does not test stability, it tests whether the two locales agree, which an ambiguous date
 *   under US ordering never does against GB, so every genuine match would fail.
 */
function isDateFixed(result, parser) {
  const distantRef = new Date(Date.UTC(1970, 0, 1));
  const distant = parser.parse(result.text, distantRef);
  if (distant.length === 0) return false;
  return distant[0].start.date().getTime() === result.start.date().getTime();
}

export function prettifyTitle(title) {
  title = title.replace(/\.[a-zA-Z0-9]{1,4}$/, '');
  title = title.replace(/_+/g, ' ');
  title = title.replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Z}]/gu, '');
  title = stripDoubleChars(title);
  return title.trim();
}

export function stripDoubleChars(str) {
  str = str.replace(/[_\s\-.,\\/]+/g, ' ');
  return str.trim();
}

export function stripUnsuitableChars(input) {
  return input
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Z}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * stripUnsuitableChars(), run per line rather than over the whole value.
 * For fields where a newline is structure, not incidental whitespace: the
 * coversheet maker's Additional Lines, In the Matter Of, and the multi-name
 * Applicant/Respondent boxes.
 */
export function stripMultiline(input) {
  return String(input ?? '').split('\n').map(stripUnsuitableChars).join('\n');
}

/**
 * The watermark follows its text field: any non-empty text turns it on, and
 * there is no separate checkbox.
 */
export function isWatermarkText(text) {
  return String(text ?? '').trim() !== '';
}

/**
 * Reconciles a stored `{watermark, watermarkText}` pair, as an autosave
 * snapshot or a bundle with a separate `watermark` flag carries it, into the
 * text alone. No `watermark` at all means the text alone decides, so the text
 * is trusted as it is. `watermark` true with blank text restores as the
 * default word, so a bundle saved watermarked stays watermarked. `watermark`
 * false discards any leftover text, which would otherwise turn the marking on,
 * since the text's presence IS the toggle.
 */
export function reconcileWatermark(watermark, text) {
  if (watermark === undefined) return String(text ?? '');
  if (!watermark) return '';
  return String(text ?? '').trim() || 'CONFIDENTIAL';
}

/**
 * The footer colour is a colour picker. The three named presets a stored
 * setting may hold ("black", "red", "blue") still draw correctly at build
 * time (see bundletoolPages.js's own colourMap), but a plain
 * `<input type="color">` rejects a non-hex value outright rather than showing
 * it. This converts a name to its exact hex equivalent, so a restored bundle
 * or autosave snapshot both displays correctly AND draws the same colour,
 * rather than silently falling back to the picker's own default.
 */
export function pageNumberColourToHex(value) {
  const legacy = { black: '#120513', red: '#de081a', blue: '#1538df' };
  const v = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  return legacy[v] || '#000000';
}

export function uniqueFilename(name, filesMap) {
  if (!filesMap.has(name)) return name;
  const dot  = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (filesMap.has(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}

/**
 * A stored date style the settings list does not offer ("Mon. DD, YYYY"), mapped
 * to the one it does ("Mon DD, YYYY"), so a saved setting in that form still
 * selects an option. (The style labelled "DD Mon YYYY" keeps the stored value
 * "DD Mon. YYYY".)
 */
export function currentDateStyle(value) {
  return value === 'Mon. DD, YYYY' ? 'Mon DD, YYYY' : value;
}
