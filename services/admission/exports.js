'use strict';
/**
 * Spreadsheets of admission data — the applications list as filtered on the
 * screen, with each application's answers in columns. Sensitive answers are
 * included only for admission administrators; everyone else gets the column
 * with "(restricted)".
 */
const XLSX = require('xlsx');
const pool = require('../../db/pool');
const formEngine = require('./formEngine');
const workflow = require('./workflow');
const fmt = require('./format');

const BASE_COLUMNS = [
    ['applicationNumber', 'Application no.'], ['studentName', 'Student'], ['studentDob', 'Date of birth'], ['studentGender', 'Gender'],
    ['className', 'Class'], ['roundName', 'Round'], ['statusLabel', 'Status'], ['submittedAt', 'Submitted'],
    ['guardianName', 'Contact'], ['guardianPhone', 'Contact mobile'], ['guardianEmail', 'Contact email'], ['applicantEmail', 'Account email'],
    ['docStatus', 'Documents'], ['applicationFeeStatus', 'Application fee'], ['admissionFeeStatus', 'Admission fee'],
    ['offerStatus', 'Offer'], ['admissionNumber', 'Admission no.'], ['assignedName', 'Assigned to'], ['source', 'Source'],
];

/** Rows for the spreadsheet: the base columns, then every answer column the versions have. */
async function rowsFor(apps, { includeSensitive = false, withAnswers = true } = {}) {
    const versionIds = [...new Set(apps.map((a) => a.formVersion).filter(Boolean).map(String))];
    const { rows: versions } = versionIds.length
        ? await pool.query(`SELECT "_id", "schema" FROM "admissionformversions" WHERE "_id" = ANY($1::uuid[])`, [versionIds])
        : { rows: [] };
    const schemaOf = new Map(versions.map((v) => [String(v._id), v.schema]));
    const answerCols = new Map();   // key → label (first seen)
    if (withAnswers) {
        for (const v of versions) for (const f of formEngine.allFields(v.schema)) if (!['info', 'file'].includes(f.type) && !answerCols.has(f.key)) answerCols.set(f.key, f.label || f.key);
    }
    const header = [...BASE_COLUMNS.map(([, l]) => l), ...[...answerCols.values()]];
    const body = apps.map((a) => {
        const base = BASE_COLUMNS.map(([k]) => {
            if (k === 'statusLabel') return workflow.STATUSES[a.status]?.label || a.status;
            if (k === 'submittedAt') return a.submittedAt ? fmt.fmtDateTime(a.submittedAt) : '';
            if (k === 'studentDob') return a.studentDob ? new Date(a.studentDob).toISOString().slice(0, 10) : '';
            return a[k] ?? '';
        });
        const schema = schemaOf.get(String(a.formVersion)) || { sections: [] };
        const fields = new Map(formEngine.allFields(schema).map((f) => [f.key, f]));
        const answers = [...answerCols.keys()].map((key) => {
            const f = fields.get(key);
            const v = a.data?.[key];
            if (v === undefined || !f) return '';
            if (f.sensitive && !includeSensitive) return '(restricted)';
            // An export never carries a whole Aadhaar number.
            if (formEngine.isAadhaarField(f)) return formEngine.maskAadhaar(v);
            if (Array.isArray(v)) return v.join(', ');
            if (typeof v === 'boolean') return v ? 'Yes' : 'No';
            return String(v);
        });
        return [...base, ...answers];
    });
    return { header, body };
}

function workbook(sheetName, header, body) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    ws['!cols'] = header.map((h, i) => ({ wch: Math.min(40, Math.max(10, String(h).length + 2, ...body.slice(0, 200).map((r) => String(r[i] ?? '').length + 1))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    return wb;
}

/** Send a sheet as .xlsx or .csv. Cells starting with = + - @ are prefixed so a spreadsheet never runs them. */
function send(res, { filename, sheet, header, body, format = 'xlsx' }) {
    const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const cleanBody = body.map((r) => r.map(safeCell));
    const wb = workbook(sheet, header, cleanBody);
    if (format === 'csv') {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(`﻿${csv}`);
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(buf);
}

module.exports = { rowsFor, send, workbook, BASE_COLUMNS };
