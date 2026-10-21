'use strict';
/**
 * Exports prepared in the background (Oct 2026). The office asks; a worker —
 * on whichever server claims it first (FOR UPDATE SKIP LOCKED) — builds the
 * spreadsheet with the same filters and the same cell-safety as the direct
 * download, and stores it privately (services/admission/fileStore). It can be
 * downloaded for a day, by the school's admission administrators, and every
 * download is logged; then the file is deleted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const pool = require('../../db/pool');
const { buildInsert } = require('../dbTx');
const AdmissionExport = require('../../models/AdmissionExport');
const exportsSvc = require('./exports');
const fileStore = require('./fileStore');
const workflow = require('./workflow');
const events = require('./events');
const { refuse, isId } = require('./util');

const KEEP_HOURS = 24;
const APP_KEYS = ['q', 'status', 'stage', 'view', 'round', 'class', 'academicYear', 'assignedTo', 'docStatus', 'fee', 'duplicates', 'pending', 'from', 'to', 'source', 'sort', 'answers'];
const PAY_KEYS = ['kind', 'status'];

function cleanParams(kind, input = {}) {
    const keys = kind === 'applications' ? APP_KEYS : PAY_KEYS;
    const out = {};
    for (const k of keys) {
        const v = input[k];
        if (v === undefined || v === null || v === '') continue;
        out[k] = String(v).slice(0, 200);
    }
    return out;
}

async function queue(req, input = {}) {
    const kind = ['applications', 'payments'].includes(input.kind) ? input.kind : null;
    if (!kind) refuse('Choose what to export');
    const format = input.format === 'csv' ? 'csv' : 'xlsx';
    const { rows: [busy] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionexports" WHERE "school" = $1 AND "status" IN ('queued', 'running')`, [String(req.schoolId)]);
    if (busy.n >= 3) refuse('Three exports are already being prepared — wait for one to finish', 429);
    const { sql, params } = buildInsert(AdmissionExport, { school: req.schoolId, kind, format, params: cleanParams(kind, input.params || {}), status: 'queued', requestedBy: req.userId });
    const { rows: [row] } = await pool.query(sql, params);
    events.recordQuietly(req.schoolId, { by: req, type: 'export', action: 'queued', message: `${kind === 'applications' ? 'Applications' : 'Payments'} export asked for (${format.toUpperCase()})` });
    setImmediate(() => { runQueued().catch((e) => console.error('[Admission] export:', e.message)); });
    return row;
}

/** The sheet for one export. */
async function build(job) {
    const p = job.params || {};
    if (job.kind === 'applications') {
        const { listFilters, LIST_SELECT, LIST_FROM, SORTS } = require('../../controllers/admissionApplications.controller').listQuery;
        const f = listFilters({ query: p, schoolId: job.school });
        const { rows } = await pool.query(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE ${f.where} ORDER BY ${SORTS[p.sort] || SORTS.submitted} LIMIT 100000`, f.params);
        const { header, body } = await exportsSvc.rowsFor(rows.map((r) => ({ ...r, statusLabel: workflow.STATUSES[r.status]?.label })), { includeSensitive: true, withAnswers: p.answers !== '0' });
        return { sheet: 'Applications', header, body, n: rows.length };
    }
    const params = [String(job.school)];
    let where = `p."school" = $1`;
    if (['application_fee', 'admission_fee'].includes(p.kind)) { params.push(p.kind); where += ` AND p."kind" = $${params.length}`; }
    if (['paid', 'void', 'failed'].includes(p.status)) { params.push(p.status); where += ` AND p."status" = $${params.length}`; } else where += ` AND p."status" IN ('paid', 'void')`;
    const { rows } = await pool.query(
        `SELECT p."receiptNumber", a."applicationNumber", a."studentName", p."kind", p."amount", p."mode", p."reference", p."status", p."paidAt", p."voidReason",
                (SELECT COALESCE(SUM(r."amount"), 0)::float8 FROM "admissionrefunds" r WHERE r."payment" = p."_id" AND r."status" IN ('pending', 'processed')) AS "refunded"
           FROM "admissionpayments" p JOIN "admissionapplications" a ON a."_id" = p."application" WHERE ${where} ORDER BY p."paidAt" DESC NULLS LAST LIMIT 100000`, params);
    const header = ['Receipt', 'Application', 'Student', 'For', 'Amount', 'Refunded', 'Mode', 'Reference', 'Status', 'Paid on', 'Cancelled because'];
    const body = rows.map((r) => [r.receiptNumber, r.applicationNumber, r.studentName, r.kind === 'admission_fee' ? 'Admission fee' : 'Application fee', Number(r.amount), Number(r.refunded),
        r.mode, r.reference, r.status, r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 10) : '', r.voidReason || '']);
    return { sheet: 'Payments', header, body, n: rows.length };
}

/** Claim and prepare queued exports, one at a time. */
async function runQueued(limit = 3) {
    let done = 0;
    for (let i = 0; i < limit; i += 1) {
        const { rows: [job] } = await pool.query(
            `UPDATE "admissionexports" SET "status" = 'running', "startedAt" = now(), "updatedAt" = now()
              WHERE "_id" = (SELECT "_id" FROM "admissionexports" WHERE "status" = 'queued' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
        if (!job) break;
        const tmp = path.join(os.tmpdir(), `adm-export-${crypto.randomUUID()}.${job.format}`);
        try {
            const { sheet, header, body, n } = await build(job);
            const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
            const wb = exportsSvc.workbook(sheet, header, body.map((r) => r.map(safeCell)));
            if (job.format === 'csv') await fs.promises.writeFile(tmp, `﻿${XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])}`);
            else await fs.promises.writeFile(tmp, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
            const key = `exports/${job.school}/${job._id}.${job.format}`;
            await fileStore.save(tmp, key, job.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            await pool.query(
                `UPDATE "admissionexports" SET "status" = 'ready', "file" = $2, "rows" = $3, "finishedAt" = now(), "expiresAt" = now() + make_interval(hours => $4), "updatedAt" = now() WHERE "_id" = $1`,
                [job._id, key, n, KEEP_HOURS]);
            done += 1;
        } catch (e) {
            await pool.query(`UPDATE "admissionexports" SET "status" = 'failed', "error" = $2, "finishedAt" = now(), "updatedAt" = now() WHERE "_id" = $1`, [job._id, String(e.message || e).slice(0, 300)]);
        } finally {
            fs.promises.unlink(tmp).catch(() => {});
        }
    }
    return done;
}

/** The worker's turn: anything left running by a server that stopped goes back in the queue; old files go. */
async function sweep() {
    await pool.query(`UPDATE "admissionexports" SET "status" = 'queued', "startedAt" = NULL, "updatedAt" = now() WHERE "status" = 'running' AND "startedAt" < now() - interval '30 minutes'`);
    const prepared = await runQueued();
    const { rows } = await pool.query(`UPDATE "admissionexports" SET "status" = 'expired', "updatedAt" = now() WHERE "status" = 'ready' AND "expiresAt" < now() RETURNING "file"`);
    for (const r of rows) if (r.file) fileStore.remove(r.file);
    return { prepared, expired: rows.length };
}

async function list(schoolId) {
    const { rows } = await pool.query(
        `SELECT x."_id", x."kind", x."format", x."params", x."status", x."rows", x."error", x."createdAt", x."finishedAt", x."expiresAt", u."name" AS "requestedByName"
           FROM "admissionexports" x LEFT JOIN "users" u ON u."_id" = x."requestedBy" WHERE x."school" = $1 ORDER BY x."createdAt" DESC LIMIT 30`, [String(schoolId)]);
    return rows;
}

/** Stream a ready export to the office, and log that personal data left the system. */
async function download(req, res, id) {
    if (!isId(String(id || ''))) refuse('Export not found', 404);
    const { rows: [x] } = await pool.query(`SELECT * FROM "admissionexports" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!x) refuse('Export not found', 404);
    if (x.status === 'expired' || (x.expiresAt && new Date(x.expiresAt) < new Date())) refuse('This export has expired — prepare it again', 410);
    if (x.status !== 'ready') refuse('This export is not ready', 409);
    require('./privacy').logAccess(req, { action: 'export', detail: `${x.kind} export downloaded (${x.rows} rows, prepared ${new Date(x.finishedAt).toISOString().slice(0, 16)})` });
    const name = `${x.kind}-${new Date(x.createdAt).toISOString().slice(0, 10)}.${x.format}`;
    res.setHeader('Content-Type', x.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await fileStore.pipeTo(res, x.file);
}

module.exports = { queue, runQueued, sweep, list, download, build, cleanParams };
