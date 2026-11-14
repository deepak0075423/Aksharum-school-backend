'use strict';
/**
 * A student's roll number as SQL, for a known section or academic year.
 *
 * Roll numbers belong to a section, and so to one academic year: they live on
 * the student's row for that year (StudentEnrollment). StudentProfile.rollNumber
 * only mirrors the ACTIVE year's, so a screen about a particular section or
 * year — an exam, a report card, an attendance register — must not read it:
 * last year's report card would print this year's roll.
 *
 * Each helper falls back to `fallback` (usually the profile's column) only when
 * the student has no row for that section/year at all — data older than the
 * year-by-year rows. A row whose roll is '' means "no roll that year" and is
 * shown as such.
 */
const T = '"studentenrollments"';

/** The roll `student` holds in `section` (both SQL expressions). */
const rollInSection = (student, section, fallback = `''`) =>
    `COALESCE((SELECT se."rollNumber" FROM ${T} se WHERE se."student" = ${student} AND se."section" = ${section} LIMIT 1), ${fallback})`;

/** The roll `student` holds in academic year `year` (both SQL expressions). */
const rollInYear = (student, year, fallback = `''`) =>
    `COALESCE((SELECT se."rollNumber" FROM ${T} se WHERE se."student" = ${student} AND se."academicYear" = ${year} LIMIT 1), ${fallback})`;

/** The same as an ORDER BY key: numeric part first, blanks last. */
const rollOrder = (expr) => `NULLIF(regexp_replace(COALESCE(${expr}, ''), '\\D', '', 'g'), '')::numeric NULLS LAST`;

module.exports = { rollInSection, rollInYear, rollOrder };
