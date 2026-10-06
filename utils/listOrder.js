'use strict';
/**
 * The order classes, sections and academic years are listed in — in every
 * list and every dropdown (Oct 2026):
 *
 *   classes   by class number, then name: Class 1, Class 2 … Class 10, and
 *             Class V before Class X, which an A–Z of the names would not give
 *   sections  A–Z, a number counted as a number: A, B, C … and A2 before A10
 *   years     A–Z by name: 2024-25, 2025-26, 2026-27
 *
 * The same order three ways: comparators for lists built in code, SQL for
 * queries that write their own ORDER BY, and the models' default order
 * (models/Class, ClassSection, AcademicYear — db/model.js `defaultOrder`),
 * which every find() without a sort of its own now returns.
 *
 * A list's order is for reading. "The current year" or "the year before" is
 * a question about dates, answered by `newestYear` / `previousYear` — never
 * by a position in a list.
 */

const natural = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
const num  = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? Infinity : Number(v));
const time = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isNaN(t) ? 0 : t; };

const byClass   = (a, b) => (num(a?.classNumber) - num(b?.classNumber) || 0) || natural(a?.className, b?.className);
const bySection = (a, b) => natural(a?.sectionName, b?.sectionName);
const byYear    = (a, b) => natural(a?.yearName, b?.yearName) || time(a?.startDate) - time(b?.startDate);

/** The year that starts last — "the newest", whatever order the list is in. */
const newestYear = (years = []) => years.reduce((best, y) => (!best || time(y.startDate) > time(best.startDate) ? y : best), null);
/** The year that ended before `year` began, nearest to it. */
const previousYear = (years = [], year) => (year
    ? years.filter((y) => time(y.startDate) < time(year.startDate)).reduce((best, y) => (!best || time(y.startDate) > time(best.startDate) ? y : best), null)
    : null);

// ── SQL ──────────────────────────────────────────────────────────────────────
// `col` is the column as the query names it, e.g. 'c."className"'. Natural
// order without depending on the server's collation or ICU: the text with its
// digits taken out, then those digits as a number, then the text itself.
const naturalSql = (col) => `lower(regexp_replace(${col}, '[0-9]+', '', 'g')), NULLIF(regexp_replace(${col}, '[^0-9]', '', 'g'), '')::numeric NULLS FIRST, lower(${col})`;
const classOrderSql   = (alias = '') => `${alias ? `${alias}.` : ''}"classNumber" NULLS LAST, ${naturalSql(`${alias ? `${alias}.` : ''}"className"`)}`;
const sectionOrderSql = (alias = '') => naturalSql(`${alias ? `${alias}.` : ''}"sectionName"`);
const yearOrderSql    = (alias = '') => `${naturalSql(`${alias ? `${alias}.` : ''}"yearName"`)}, ${alias ? `${alias}.` : ''}"startDate"`;

module.exports = {
    natural, byClass, bySection, byYear, newestYear, previousYear,
    naturalSql, classOrderSql, sectionOrderSql, yearOrderSql,
};
