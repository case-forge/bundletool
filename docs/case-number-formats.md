# UK court and tribunal case number formats

What the cover page's case number field has to hold. Checked on 27 September 2026 against the pages named in each row. Lengths count every character, hyphens and slashes included.

| Court or tribunal | Format | Example | Length | Source |
| --- | --- | --- | --- | --- |
| Family Court (all family case types) | Two letters for the court, two digits for the year, one letter for the case type, five digits in a sequence that starts at 00001 each year | `BM14C01234` | 10 | [Rainscourt: what does my divorce case number mean](https://www.rainscourt.com/whatdoesmydivorcecasenumbermean/) |
| Family Court, London courts | The court letters are `ZC` (Central), `ZE` (East London) or `ZW` (West London); `FD` is the Family Division in London | `ZC26C00123` | 10 | same |
| Online divorce and dissolution, from 1 April 2022 | A 16-digit reference, used from the start of the case to the end. The guidance shows it with an optional hyphen and no spaces | `1234567891011121` or `-123456789101112` | 16 to 17 | [MyHMCTS: submit a sole divorce application](https://gov.uk/government/publications/myhmcts-how-to-apply-online-for-a-divorce-or-dissolution/submit-a-sole-divorce-application-under-new-law) |
| Online divorce, written in four groups | The same 16 digits with a hyphen between each group of four (a formatting choice, not a rule in the guidance): three hyphens | `1234-5678-9012-3456` | 19 | derived from the row above |
| King's Bench Division (High Court) | Two letters, the year, six digits | `KB-2024-017278` | 14 | [GOV.UK: case references used by the Royal Courts of Justice and Rolls Building](https://www.gov.uk/guidance/case-references-used-by-the-royal-courts-of-justice-and-rolls-building) |
| Business and Property Courts (Chancery, Business List and the others) | A two-letter prefix, the year, six digits | `BL-2020-000000` | 14 | same |
| Administrative Court | Prefix, year, a three-letter region code, six digits | `AC-2025-LON-010279` | 18 | same |
| Court of Appeal, Civil Division | A letter, the year, four digits | `A1/2011/1234` | 12 | same |
| Court of Appeal, Criminal Division | The year and five digits, with a letter suffix | `2011 01234 A` | 12 | same |
| Central London County Court | Letters, four digits, letters, three digits | `CL1399AA999` | 11 | same |
| Chancery, older forms still in use | Several, including a number and year | `1234 of 2011`, `CH/2010/0123` | 12 to 14 | same |
| Intellectual Property Enterprise Court | Prefix, year, letters, four digits | `IP14MO1234` | 10 | same |
| Employment Tribunal, England and Wales | Seven digits, a slash and the year; since summer 2024 nearly all new cases start with 6 | `6000124/2025`, `3200670/2024` | 12 | [Judiciary: how should I communicate with Employment Tribunals](https://www.judiciary.uk/courts-and-tribunals/tribunals/employment-tribunal/employment-tribunal-england-wales/how-should-i-communicate-with-employment-tribunals/); [GOV.UK employment tribunal decision](https://gov.uk/employment-tribunal-decisions/m-n-wan-v-j-w-y-lam-3200670-slash-2024) |
| Upper Tribunal, Immigration and Asylum Chamber | `UI`, the year, six digits (the CE-File reference) | `UI-2023-002023` | 14 | [Upper Tribunal decisions](https://tribunalsdecisions.service.gov.uk/utiac/ui-2023-002023) |

## What follows for the cover page

- The longest single reference found in the sources is the online divorce number written in four groups, 19 characters, and the Administrative Court reference, 18. A reference of about 20 characters, such as `00000-0000000000-000`, is in the same range.
- Two numbers joined for linked proceedings (for example `ZC26C00123 and ZC26C00456`, or two 19-character numbers with ` and ` between them) come to at most about 45 characters. No source in the list above sets a convention for how joined numbers are written, so the cover treats the field as free text.
- The cover's Court Reference field takes up to 60 characters: room for two of the longest single references and a joining word, with margin. The build still draws a longer value from an imported settings file: it wraps at spaces on its own line, and one unbroken reference is never split.
- The case number shares the court's line while the court keeps at least 140 points. Measured on A4 with the real fonts, the court keeps 293 points (serif) and 260 points (sans) beside a 20-character number, and 177 points (serif) and 150 points (sans) beside two joined 19-character numbers (43 characters, with `CASE NO:` in front), so those all stay on the court's line. A 60-character value leaves 62 points (serif) and 39 points (sans), so it drops to its own line, where it wraps at spaces if it is wider than the page. `tests/coverPolish.test.mjs` measures every combination of design, position, typeface and page size.
