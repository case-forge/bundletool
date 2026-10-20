/**
 * Filename date parsing, and the UK reading.
 *
 * The parser sees the raw name: prettifying the title collapses the dashes
 * to spaces, and the date regexes require [-._] separators, so a prettified
 * "Position Statement 02-04-2026.pdf" would give NO date. And an ambiguous
 * slash date is read day-first: this is a tool for England and Wales, so
 * 03/04/2026 is 3 April, not 4 March.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFromFilename } from '../public/js/frontend/utils.js';
import { formatDate, createTocEntries } from '../public/js/bundletoolToc.js';
import { default as Config } from '../public/js/bundletoolConfig.js';
import * as chrono from '/vendor/chrono-node.js';

test('a day-first dashed date in the filename is found', async () => {
  const { date, name } = await parseDateFromFilename('Position Statement 02-04-2026', chrono);
  assert.equal(date, '2026-04-02');
  assert.equal(name, 'Position Statement');
});

test('a year-first date is found', async () => {
  const { date } = await parseDateFromFilename('Witness Statement 2026-03-12', chrono);
  assert.equal(date, '2026-03-12');
});

test('a written-out date falls through to chrono', async () => {
  const { date, name } = await parseDateFromFilename('Claim Form 2 June 2026', chrono);
  assert.equal(date, '2026-06-02');
  assert.equal(name, 'Claim Form');
});

test('an ambiguous slash date is read day-first, as a UK court would', async () => {
  const { date } = await parseDateFromFilename('Order 03/04/2026', chrono);
  assert.equal(date, '2026-04-03');
});

test('an ambiguous slash date is read month-first when dateInputOrder is US', async () => {
  const { date } = await parseDateFromFilename('Order 03/04/2026', chrono, 'US');
  assert.equal(date, '2026-03-04');
});

test('a date with a day over 12 is unambiguous either way, and US does not change it', async () => {
  const uk = await parseDateFromFilename('Letter 13-04-2026', chrono, 'UK');
  const us = await parseDateFromFilename('Letter 13-04-2026', chrono, 'US');
  assert.equal(uk.date, '2026-04-13');
  assert.equal(us.date, '2026-04-13', '13 can only ever be a day, under either reading');
});

test('a year-first date is unaffected by dateInputOrder, under either setting', async () => {
  const uk = await parseDateFromFilename('Witness Statement 2026-03-12', chrono, 'UK');
  const us = await parseDateFromFilename('Witness Statement 2026-03-12', chrono, 'US');
  assert.equal(uk.date, '2026-03-12');
  assert.equal(us.date, '2026-03-12');
});

test('a two-digit year is read the same way as a four-digit one, under either dateInputOrder', async () => {
  // Falls through to chrono (the regexes above only match a 4-digit year), so this checks that
  // chrono's own two preset locales agree with the regex path for the 4-digit case.
  const uk = await parseDateFromFilename('Order 03-04-26', chrono, 'UK');
  const us = await parseDateFromFilename('Order 03-04-26', chrono, 'US');
  assert.equal(uk.date, '2026-04-03');
  assert.equal(us.date, '2026-03-04');
});

test('a filename with two date-shaped matches uses the first one, under either dateInputOrder', async () => {
  const uk = await parseDateFromFilename('Letter 03-04-2026 reply 05-06-2026', chrono, 'UK');
  const us = await parseDateFromFilename('Letter 03-04-2026 reply 05-06-2026', chrono, 'US');
  assert.equal(uk.date, '2026-04-03');
  assert.equal(us.date, '2026-03-04');
});

test('dateInputOrder defaults to UK when omitted', async () => {
  const { date } = await parseDateFromFilename('Order 03/04/2026', chrono);
  assert.equal(date, '2026-04-03');
});

test('no date means no date, and the name survives untouched', async () => {
  const { date, name } = await parseDateFromFilename('Skeleton Argument', chrono);
  assert.equal(date, null);
  assert.equal(name, 'Skeleton Argument');
});

/**
 * A relative phrase ("today", "next Friday") reads as a confident date to chrono, but the date
 * it names depends on the moment the file happened to be added, not on anything written in the
 * filename. Reopen the same bundle a year later and it would guess a different day for the same
 * document. isCertain('day'/'month'/'year') does not catch this: chrono marks "today" itself as
 * certain, since once resolved there is no ambiguity about which day it names. Rather than let a
 * clock-dependent guess reach a court document's index unchecked, these fall through to no date,
 * the same as an unrecognisable filename, so the field stays blank for a person to fill in.
 */
for (const filename of ['today', 'Order yesterday', 'Statement from last week', 'tomorrow', 'Hearing next Friday', 'this Friday', 'Draft in 3 days']) {
  test(`a relative date ("${filename}") is never guessed, it is left for the person to fill in`, async () => {
    const { date } = await parseDateFromFilename(filename, chrono);
    assert.equal(date, null, `${filename} should not silently resolve against whenever the file was added`);
  });
}

test('a day and month with no year is also left blank, not silently assigned the current year', async () => {
  // Chrono fills a missing year in from the reference date, which is exactly the same "the
  // guess depends on when this ran" problem as a relative phrase, just less obviously so.
  const { date } = await parseDateFromFilename('15 September', chrono);
  assert.equal(date, null);
});

test('a month and year with no day is still trusted: nothing here depends on the current date', async () => {
  const { date, name } = await parseDateFromFilename('Report September 2026', chrono);
  assert.equal(date, '2026-09-01');
  assert.equal(name, 'Report');
});

test('a real written-out date survives being next to a relative word elsewhere in the filename', async () => {
  const { date } = await parseDateFromFilename('Statement today, dated 2 June 2026', chrono);
  assert.equal(date, '2026-06-02');
});

/**
 * entry.date reaches formatDate() from a user-editable field, so it is not
 * guaranteed to be valid YYYY-MM-DD. Anything else is shown as it is rather
 * than crashing (d.padStart on undefined).
 */
test('a malformed date does not crash formatDate, it is shown as-is', () => {
  assert.equal(formatDate('not-a-date', 'DD Mon. YYYY'), 'not-a-date');
  assert.equal(formatDate('2026', 'DD Mon. YYYY'), '2026');
  assert.equal(formatDate('2026-13-40', 'DD Mon. YYYY'), '2026-13-40');
});

test('a valid date still formats normally', () => {
  assert.equal(formatDate('2026-04-02', 'DD Mon. YYYY'), '02 Apr 2026');
  assert.equal(formatDate('2026-04-02', 'YYYY-MM-DD'), '2026-04-02');
});

test('empty date stays empty', () => {
  assert.equal(formatDate('', 'DD Mon. YYYY'), '');
  assert.equal(formatDate(null, 'DD Mon. YYYY'), '');
});

/**
 * createTocEntries() keeps a running total of page counts, so a missing or
 * NaN pageCount on one file, used as it is, would turn every page number for
 * every file AFTER it in the whole bundle into NaN (NaN + n is always NaN),
 * with no error anywhere.
 */
test('a file with no page count does not wreck every page number after it', async () => {
  const config = new Config();
  const indexData = {
    sections: [{
      sectionID: '0000',
      files: [
        { filename: 'a.pdf', title: 'A', date: '', pageCount: 3 },
        { filename: 'b.pdf', title: 'B', date: '', pageCount: undefined },
        { filename: 'c.pdf', title: 'C', date: '', pageCount: 2 },
      ],
    }],
  };
  const [toc] = await createTocEntries(indexData, config);
  const [a, b, c] = toc.entries;

  assert.equal(a.beginsOnPdfPage, 1);
  assert.equal(b.beginsOnPdfPage, 4, 'a is 3 pages, so b must start on page 4, not NaN');
  assert.equal(b.pageCount, 0, 'an invalid page count is coerced to 0, not left as undefined/NaN');
  assert.equal(b.recovered, true, 'an unknown page count must be flagged, not silently accepted');
  assert.equal(c.beginsOnPdfPage, 4, 'b contributed 0 pages, so c starts where b did');
});

test('January is abbreviated like every other month, with no full stop', () => {
  assert.equal(formatDate('2026-01-15', 'DD Mon. YYYY'), '15 Jan 2026');
  assert.equal(formatDate('2026-01-15', 'Mon DD, YYYY'), 'Jan 15, 2026');
});

test('the older date style "Mon. DD, YYYY" still formats and validates', async () => {
  const { validDateStyles } = await import('../public/js/bundletoolConfig.js');
  assert.equal(formatDate('2026-04-02', 'Mon. DD, YYYY'), 'Apr 02, 2026');
  assert.ok(validDateStyles.includes('Mon. DD, YYYY'));
});

test('every date style the settings list offers is one the build accepts', async () => {
  const { validDateStyles } = await import('../public/js/bundletoolConfig.js');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="config-dateStyle"[\s\S]*?<\/select>/)[0];
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 7);
  for (const v of values) assert.ok(validDateStyles.includes(v), `"${v}" is offered but rejected by the build`);
});

test('every date reading order the settings list offers is one the build accepts, UK is the default', async () => {
  const { validDateInputOrder } = await import('../public/js/bundletoolConfig.js');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../layouts/partials/bundletool.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="config-dateInputOrder"[\s\S]*?<\/select>/)[0];
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values.sort(), [...validDateInputOrder].sort());
  const defaultOption = select.match(/<option value="([^"]+)" selected>/);
  assert.equal(defaultOption[1], 'UK');
});

test('an invalid dateInputOrder is rejected by the build, not silently accepted', async () => {
  const config = new Config();
  config.updateOptions({ index: { dateInputOrder: 'FR' } });
  assert.throws(() => config.validateOptions(), /Invalid date input order/);
});

// A numeric date wins over a written-out one in the same name, whichever comes first. The numeric
// date is when the document was made; a written date in the title is what the document is about.
test('a numeric date beats a written-out date in the same name, in either order', async () => {
  const a = await parseDateFromFilename('Witness Statement re incident of 3 April 2026 dated 12-05-2026', chrono);
  assert.equal(a.date, '2026-05-12');
  const b = await parseDateFromFilename('Report 12-05-2026 on the 3 April 2026 incident', chrono);
  assert.equal(b.date, '2026-05-12');
  const c = await parseDateFromFilename('Letter 3 April 2026 and 2026-05-12', chrono);
  assert.equal(c.date, '2026-05-12');
});

test('with no numeric date, the written-out date is still read', async () => {
  assert.equal((await parseDateFromFilename('Witness Statement re incident of 3 April 2026', chrono)).date, '2026-04-03');
});

// An incident report about an event on a written-out date, dated numerically at the end. Legal documents
// carry the document's date numerically and the event's date in words, so the numeric one wins.
// (No weekday in the name: the date reading is of the date, not "Thursday".)
test('an incident report about an event in words is dated by the numeric date at the end', async () => {
  const { date, name } = await parseDateFromFilename('Incident Report re sixth January 2025 - 20-01-2025', chrono);
  assert.equal(date, '2025-01-20');
  assert.ok(name.includes('sixth January 2025'), 'the written event date stays in the name');
  const spelledMonth = await parseDateFromFilename('Incident Report re 6 January 2025 20-01-2025', chrono);
  assert.equal(spelledMonth.date, '2025-01-20');
});

test('an impossible calendar date in a filename is no date, not a rolled-over one', async () => {
  for (const name of ['Letter 30-02-2026', 'Letter 31-04-2026', 'Letter 29-02-2026', 'Letter 2026-02-30']) {
    const { date, name: rest } = await parseDateFromFilename(name, chrono);
    assert.equal(date, null, name);
    assert.equal(rest, name, 'the name is left whole');
  }
});

test('a real leap day and month-end are still read', async () => {
  assert.equal((await parseDateFromFilename('Letter 29-02-2028', chrono)).date, '2028-02-29');
  assert.equal((await parseDateFromFilename('Letter 30-04-2026', chrono)).date, '2026-04-30');
});

// Not only the dashed numeric paths: a slash date and a written date that do not exist come out as no date
// too (chrono rejects them itself; pinned here so a library change that starts rolling them over fails).
test('an impossible slash date or written date in a filename is no date either', async () => {
  for (const name of ['Letter 30/02/2026', 'Letter 31/04/2026', 'Letter 31 April 2026', 'Letter 29 February 2026', 'Letter 30 Feb 2026']) {
    const { date, name: rest } = await parseDateFromFilename(name, chrono);
    assert.equal(date, null, name);
    assert.equal(rest, name);
  }
  assert.equal((await parseDateFromFilename('Letter 29 February 2028', chrono)).date, '2028-02-29', 'a real leap day is still read');
});
