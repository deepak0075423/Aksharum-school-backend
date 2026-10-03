'use strict';
/**
 * Marks filled in elsewhere — an Excel sheet or a CSV, a row per student —
 * read into rows the marks grid can match to its roll (Oct 2026).
 *
 * Only reading happens here. The grid matches each row to a student (by
 * admission number, then roll number, then name), fills the boxes, and the
 * teacher reviews and saves the sheet exactly as if every mark had been typed —
 * so every rule a typed mark meets, an imported one meets too.
 *
 * Headers are matched loosely ("Adm. No", "Admission Number", "admno" are one
 * column), as are absences: a mark of AB, A or Absent, or a Y in an Absent
 * column. The first sheet of a workbook is read.
 *
 * A column about the paper rather than the student — "Max Marks", "Total
 * Marks", "Pass Marks" — is never the marks column: a sheet laid out "Max
 * Marks | Marks Obtained" used to fill every student with the maximum. Every
 * column comes back by its header too (`cells`), so a paper in parts can take
 * its Theory and Practical marks from their own columns.
 */
const XLSX = require('xlsx');

class ImportError extends Error {
    constructor(message) { super(message); this.status = 400; }
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMNS = {
    admission: ['admissionno', 'admissionnumber', 'admno', 'admission', 'admnno', 'scholarno', 'enrolmentno', 'enrollmentno'],
    roll: ['rollno', 'rollnumber', 'roll', 'rno'],
    name: ['student', 'studentname', 'name', 'fullname'],
    marks: ['marks', 'mark', 'marksobtained', 'obtainedmarks', 'score', 'obtained'],
    absent: ['absent', 'ab', 'isabsent'],
    remarks: ['remarks', 'remark', 'comment', 'comments', 'note'],
    grade: ['grade', 'grades', 'gradeobtained'],
};
/** Words that make a "…marks" header describe the paper, not the student's mark. */
const ABOUT_THE_PAPER = /(max|maximum|total|full|pass|passing|minimum|min|percent|weight|outofmarks)/;
const columnOf = (header) => {
    const k = squash(header);
    if (!k) return null;
    for (const [col, names] of Object.entries(COLUMNS)) if (names.includes(k)) return col;
    // "Marks (out of 100)", "Maths marks" — a marks column by its word, unless
    // the header is about the paper ("Max Marks", "Total Marks", "Pass Marks").
    if (/marks?|score/.test(k) && !ABOUT_THE_PAPER.test(k)) return 'marks';
    return null;
};
const ABSENT = new Set(['ab', 'a', 'abs', 'absent']);
const YES = new Set(['y', 'yes', 'true', '1', 'ab', 'absent', 'x']);

/**
 * The rows of the first sheet: [{ line, admission, roll, name, marks, absent, remarks, grade, cells }].
 * `marks` is the cell as written (the grid checks it); `cells` every cell by its
 * squashed header; `line` is the spreadsheet's own row number, for "row 7
 * matched nobody". Also `headers`: [{ key, label }] in the sheet's order.
 */
function readSheet(buffer) {
    if (!buffer || !buffer.length) throw new ImportError('The file is empty');
    let wb;
    try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: false }); } catch { throw new ImportError('The file could not be read — save it as .xlsx or .csv and try again'); }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new ImportError('The file has no sheet in it');
    // Blank rows kept, so a row's place in the list is its place in the sheet.
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
    const first = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
    // The header row: the first with something to match a student by, and
    // something more — a marks column, a grade, or a part's own column.
    const at = grid.findIndex((r) => {
        const cols = r.map(columnOf);
        const named = cols.includes('admission') || cols.includes('roll') || cols.includes('name');
        const more = r.filter((h) => squash(h)).length >= 2;
        return named && more;
    });
    if (at < 0) throw new ImportError('No header row found — the sheet needs an Admission No, Roll No or Student column, and a Marks column');
    const cols = grid[at].map(columnOf);
    const keys = grid[at].map(squash);
    // The first marks column, by exact name over a loose match.
    const marksAt = (() => {
        const exact = keys.findIndex((k) => COLUMNS.marks.includes(k));
        return exact >= 0 ? exact : cols.indexOf('marks');
    })();
    const take = (row, col) => {
        const i = col === 'marks' ? marksAt : cols.indexOf(col);
        return i < 0 ? '' : String(row[i] ?? '').trim();
    };
    const rows = [];
    grid.slice(at + 1).forEach((r, i) => {
        const cells = {};
        keys.forEach((k, j) => { if (k) cells[k] = String(r[j] ?? '').trim(); });
        const row = {
            line: first + at + i + 2,
            admission: take(r, 'admission'), roll: take(r, 'roll'), name: take(r, 'name'),
            marks: take(r, 'marks'), remarks: take(r, 'remarks').slice(0, 300), grade: take(r, 'grade').slice(0, 6),
            absent: YES.has(take(r, 'absent').toLowerCase()),
            cells,
        };
        if (ABSENT.has(row.marks.toLowerCase())) { row.absent = true; row.marks = ''; }
        if (!row.admission && !row.roll && !row.name) return;   // a blank row
        // A "Total" or "Average" line under the students names nobody.
        if (!row.admission && !row.roll && /^(grand\s*)?(total|average|avg|class average|highest|lowest)$/i.test(row.name)) return;
        rows.push(row);
    });
    if (!rows.length) throw new ImportError('The sheet has a header but no students under it');
    if (rows.length > 500) throw new ImportError('More than 500 rows — a marks sheet is one section\'s students');
    return { rows, headers: grid[at].map((h, j) => ({ key: keys[j], label: String(h || '').trim() })).filter((h) => h.key) };
}

/** The rows alone (what the endpoint has always answered with). */
const readRows = (buffer) => readSheet(buffer).rows;

module.exports = { readRows, readSheet, ImportError, columnOf, squash };
