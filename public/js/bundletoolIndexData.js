/**
 * BunTool
 * Copyright (c) 2025-2026 Tris Sherliker (tris@sherliker.net)
 * Copyright (c) 2026 CaseForge
 * A tool for the creation of legal bundles.
 *
 * Licensed under the Mozilla Public License Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://mozilla.org/MPL/2.0/.
 *
 * bundletoolIndexData.js
 * Formal schema definition and validation for the IndexData structure used
 * throughout the bundle generation pipeline.
 *
 * --------------------------------------------------------------------------
 * OVERVIEW
 * --------------------------------------------------------------------------
 *
 * IndexData carries the documents the user listed in the form from the
 * frontend to the backend. It is immutable for the lifetime of a single bundle
 * generation run (user-controlled input).
 *
 * --------------------------------------------------------------------------
 * DATA STRUCTURE
 * --------------------------------------------------------------------------
 *
 * IndexData is an array of section objects. Every document in the bundle
 * must belong to a section. Unsectioned bundles (or documents outside sections)
 * are placed in a special-cased sectionID="0000".
 *
 * SECTIONS
 * --------
 * Each section object has the following fields:
 *
 *   sectionID    {string}  Internal identifier. A zero-padded 4-digit
 *                          string in the range "0000"–"9999". Used for
 *                          ordering and stable referencing. Not user-facing.
 *                          ID "0000" is reserved for the invisible
 *                          default section (see below).
 *
 *   sectionLabel {string}  User-supplied label, e.g. "A" or "1".
 *                          For display in the index. May be empty.
 *
 *   sectionName  {string}  User-supplied section title, e.g.
 *                          "Important Documents".
 *                          For display in the index. May be empty.
 *
 *   files        {Array}   Ordered array of file entry objects belonging
 *                          to this section. May be empty.
 *
 * FILE ENTRIES
 * ------------
 * Each element of a section's `files` array has the following fields. A file
 * carries no section marker: its position inside a section says which
 * section it belongs to.
 *
 *   filename  {string}       The PDF filename as stored in filesMap.
 *                            Required. Used as a lookup key within
 *                            filesMap.
 *
 *   title     {string}       User-supplied document title. Required.
 *
 *   date      {string|null}  Document date. Either a string in the
 *                            format "YYYY-MM-DD", an empty string "", or
 *                            null.
 *
 *   pageCount {number}       Total number of pages in the PDF. Must be
 *                            a positive integer (≥ 1).
 *
 * ITERATION PATTERN
 * ------------------
 * Consumers of IndexData should iterate using the two-level loop:
 *
 *   for (const section of indexData.sections) {
 *     for (const file of section.files) {
 *       // per-file logic here
 *     }
 *   }
 *
 * --------------------------------------------------------------------------
 * EXAMPLE
 * --------------------------------------------------------------------------
 *
 *   // Explicitly sectioned bundle:
 *   const rawSections = [
 *      {
 *       sectionID:    "0000",
 *       sectionLabel: "",
 *       sectionName:  "",
 *       files:[]
 *     },
 *     {
 *       sectionID:    "0001",
 *       sectionLabel: "A",
 *       sectionName:  "Background Documents",
 *       files: [
 *         { filename: "letter.pdf",  title: "Letter of Claim", date: "2024-03-01", pageCount: 4 },
 *         { filename: "reply.pdf",   title: "Reply",           date: "2024-04-15", pageCount: 2 },
 *       ]
 *     },
 *     {
 *       sectionID:    "0002",
 *       sectionLabel: "B",
 *       sectionName:  "Expert Reports",
 *       files: [
 *         { filename: "expert1.pdf", title: "Expert Report",   date: "2024-06-01", pageCount: 18 },
 *       ]
 *     }
 *   ];
 *
 *   // Unsectioned bundle (invisible default section):
 *   const rawSections = [
 *     {
 *       sectionID:    "0000",
 *       sectionLabel: "",
 *       sectionName:  "",
 *       files: [
 *         { filename: "doc1.pdf", title: "First Document", date: "2024-01-10", pageCount: 5 },
 *         { filename: "doc2.pdf", title: "Second Document", date: null,         pageCount: 3 },
 *       ]
 *     }
 *   ];
 *
 *   const indexData = new IndexData(rawSections);
 *   indexData.validateIndexStructure(); // throws if invalid
 */

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Regex for a valid sectionID: exactly 4 decimal digits, "0000"–"9999". */
const SECTION_ID_PATTERN = /^\d{4}$/;

/**
 * Regex for a valid file date string.
 * Accepts "YYYY-MM-DD". -00-00 accepted for unknown dates.
 */
const DATE_PATTERN = /^\d{4}-(0[0-9]|1[0-2])-(0[0-9]|[12]\d|3[01])$/;

// ---------------------------------------------------------------------------
// IndexData class
// ---------------------------------------------------------------------------

/**
 * Wraps and validates the IndexData structure used throughout the
 * bundle pipeline.
 *
 * Construction does NOT automatically validate. Call validateIndexStructure()
 * explicitly after constructing, or at the entry point of any function that
 * requires a well-formed IndexData.
 */
export class IndexData {
  /**
   * @param {Array<Object>} sections - Array of section objects as described
   *   in the module-level documentation above.
   */
  constructor(sections) {
    /**
     * The ordered array of section objects.
     * Each section has: sectionID, sectionLabel, sectionName, files[].
     * @type {Array<Object>}
     */
    this.sections = sections;
  }

  // -------------------------------------------------------------------------
  // Computed properties
  // -------------------------------------------------------------------------

  /**
   * Total number of file entries across all sections.
   * @returns {number}
   */
  get totalFileCount() {
    return this.sections.reduce((sum, section) => sum + section.files.length, 0);
  }

  /**
   * Total number of sections.
   * @returns {number}
   */
  get totalSectionCount() {
    return this.sections.length;
  }

  /**
   * Sum of pageCount values across all files in all sections.
   * @returns {number}
   */
  get totalPageCount() {
    return this.sections.reduce(
      (sum, section) => sum + section.files.reduce((s, f) => s + (f.pageCount || 0), 0),
      0
    );
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validates the IndexData structure against the schema defined in this
   * module. Throws a descriptive Error on the first violation found.
   *
   * Validation checks, in order:
   *
   *   TOP LEVEL
   *   - sections is a non-empty array
   *
   *   SECTION LEVEL (for each section)
   *   - sectionID is a string matching /^\d{4}$/ ("0000"–"9999")
   *   - sectionID values are unique across all sections
   *   - sectionLabel is a string (may be empty)
   *   - sectionName is a string (may be empty)
   *   - files is an array (may be empty)
   *
   *   FILE LEVEL (for each file within a section)
   *   - filename is a non-empty string
   *   - title is a string (may be empty)
   *   - date is a "YYYY-MM-DD" string (month/day may be "00" for unknown), "", or null
   *   - pageCount is a positive integer (≥ 1)
   *
   * @throws {Error} If any validation rule is violated. The message includes
   *   the section index and/or file index to help locate the bad entry.
   */
  validateIndexStructure() {
    // --- Top level ---

    if (!Array.isArray(this.sections) || this.sections.length === 0) {
      throw new Error(
        'IndexData.sections must be a non-empty array. ' +
        'Even unsectioned bundles must have at least the default section (sectionID "0000").'
      );
    }

    // --- Section level ---

    const seenIDs = new Set();

    for (let si = 0; si < this.sections.length; si++) {
      const section = this.sections[si];
      const sectionRef = `Section at index ${si}`;

      // sectionID: must be a 4-digit string
      if (typeof section.sectionID !== 'string' || !SECTION_ID_PATTERN.test(section.sectionID)) {
        throw new Error(
          `${sectionRef}: sectionID must be a 4-digit zero-padded string ("0000"–"9999"), ` +
          `got: ${JSON.stringify(section.sectionID)}`
        );
      }

      // sectionID: must be unique
      if (seenIDs.has(section.sectionID)) {
        throw new Error(
          `${sectionRef}: duplicate sectionID "${section.sectionID}". ` +
          'Each section must have a unique sectionID.'
        );
      }
      seenIDs.add(section.sectionID);

      // sectionLabel: must be a string (empty is valid for default section)
      if (typeof section.sectionLabel !== 'string') {
        throw new Error(
          `${sectionRef} (sectionID "${section.sectionID}"): ` +
          `sectionLabel must be a string, got: ${typeof section.sectionLabel}`
        );
      }

      // sectionName: must be a string (empty is valid for default section)
      if (typeof section.sectionName !== 'string') {
        throw new Error(
          `${sectionRef} (sectionID "${section.sectionID}"): ` +
          `sectionName must be a string, got: ${typeof section.sectionName}`
        );
      }

      // files: must be an array
      if (!Array.isArray(section.files)) {
        throw new Error(
          `${sectionRef} (sectionID "${section.sectionID}"): ` +
          `files must be an array, got: ${typeof section.files}`
        );
      }

      // --- File level ---

      for (let fi = 0; fi < section.files.length; fi++) {
        const file = section.files[fi];
        const fileRef = `Section "${section.sectionID}", file at index ${fi}`;

        // filename: non-empty string
        if (typeof file.filename !== 'string' || file.filename.trim() === '') {
          throw new Error(
            `${fileRef}: filename must be a non-empty string, ` +
            `got: ${JSON.stringify(file.filename)}`
          );
        }

        // title: non-empty string
        if (typeof file.title !== 'string' || file.title.trim() === '') {
          throw new Error(
            `${fileRef} ("${file.filename}"): title must be a non-empty string, ` +
            `got: ${typeof file.title}`
          );
        }

        // date: "YYYY-MM-DD", "", or null
        if (file.date !== null && file.date !== '') {
          if (typeof file.date !== 'string' || !DATE_PATTERN.test(file.date)) {
            throw new Error(
              `${fileRef} ("${file.filename}"): date must be a "YYYY-MM-DD" string ` +
              `(month/day may be "00" for unknown), empty string, or null. Got: ${JSON.stringify(file.date)}`
            );
          }
        }

        // pageCount: positive integer
        if (
          typeof file.pageCount !== 'number' ||
          !Number.isInteger(file.pageCount) ||
          file.pageCount < 1
        ) {
          throw new Error(
            `${fileRef} ("${file.filename}"): pageCount must be a positive integer (≥ 1), ` +
            `got: ${JSON.stringify(file.pageCount)}`
          );
        }
      }
    }
  }
}
