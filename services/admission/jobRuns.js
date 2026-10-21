'use strict';
/**
 * Records of the admission background jobs (Oct 2026), and the health card
 * built from them: when each job last ran and last worked, and what the
 * school's own delivery, storage, payments, CAPTCHA and virus scanning look
 * like right now. A job that has not run when it should is shown as late —
 * nothing here guesses that it is fine.
 */
const os = require('os');
const pool = require('../../db/pool');
const { buildInsert } = require('../dbTx');
const AdmissionJobRun = require('../../models/AdmissionJobRun');

const HOST = `${os.hostname()}#${process.pid}`;
// How often each job is meant to run, in minutes — beyond twice this it is late.
const EVERY = { 'sweep.minute': 1, 'sweep.reminders': 10, 'exports.worker': 1 };
const LABEL = { 'sweep.minute': 'Exams, lists and offers (every minute)', 'sweep.reminders': 'Reminders and retention (every 10 minutes)', 'exports.worker': 'Exports (every minute)' };

/** Run `fn` as job `job`, keeping a record of it. Never throws: the record says what went wrong. */
async function record(job, fn) {
    const startedAt = new Date();
    let ok = false; let result = {}; let error = '';
    try {
        result = (await fn()) || {};
        ok = true;
    } catch (e) {
        error = String(e?.message || e).slice(0, 500);
    }
    try {
        const { sql, params } = buildInsert(AdmissionJobRun, { job, host: HOST, startedAt, finishedAt: new Date(), ok, result, error });
        await pool.query(sql, params);
    } catch { /* the table may not exist yet on a first boot */ }
    if (!ok) console.error(`[Admission] ${job}: ${error}`);
    return result;
}

/** Seven days of records are plenty for "when did it last work". */
async function prune() {
    await pool.query(`DELETE FROM "admissionjobruns" WHERE "startedAt" < now() - interval '7 days'`).catch(() => {});
}

async function jobs() {
    const { rows } = await pool.query(
        `SELECT j."job",
                (SELECT MAX("startedAt") FROM "admissionjobruns" WHERE "job" = j."job") AS "lastRunAt",
                (SELECT MAX("startedAt") FROM "admissionjobruns" WHERE "job" = j."job" AND "ok") AS "lastOkAt",
                (SELECT "error" FROM "admissionjobruns" WHERE "job" = j."job" AND NOT "ok" ORDER BY "startedAt" DESC LIMIT 1) AS "lastError",
                (SELECT MAX("startedAt") FROM "admissionjobruns" WHERE "job" = j."job" AND NOT "ok") AS "lastFailAt",
                (SELECT COUNT(*)::int FROM "admissionjobruns" WHERE "job" = j."job" AND NOT "ok" AND "startedAt" > now() - interval '24 hours') AS "failures24h"
           FROM (SELECT unnest($1::text[]) AS "job") j`, [Object.keys(EVERY)]).catch(() => ({ rows: [] }));
    const now = Date.now();
    // The jobs serve every school: a school's office sees when one failed, never the error
    // text (it may name another school's data) — that stays in the server log.
    return rows.map(({ lastError, ...r }) => ({
        ...r, label: LABEL[r.job] || r.job, failedRecently: !!lastError && r.failures24h > 0,
        late: !r.lastOkAt || now - new Date(r.lastOkAt).getTime() > 2 * EVERY[r.job] * 60000 + 60000,
    }));
}

/** The health card for one school. */
async function health(schoolId) {
    const s = String(schoolId);
    const [jobList, mail, exportsQ, scanning] = await Promise.all([
        jobs(),
        pool.query(
            `SELECT COUNT(*) FILTER (WHERE "status" = 'sent')::int AS sent, COUNT(*) FILTER (WHERE "status" = 'failed')::int AS failed,
                    COUNT(*) FILTER (WHERE "status" = 'suppressed')::int AS suppressed
               FROM "admissionemaillogs" WHERE "school" = $1 AND "createdAt" > now() - interval '24 hours'`, [s]).then((r) => r.rows[0]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE "status" = 'queued')::int AS queued, COUNT(*) FILTER (WHERE "status" = 'running')::int AS running,
                           COUNT(*) FILTER (WHERE "status" = 'failed' AND "createdAt" > now() - interval '24 hours')::int AS failed
                      FROM "admissionexports" WHERE "school" = $1`, [s]).then((r) => r.rows[0]).catch(() => ({ queued: 0, running: 0, failed: 0 })),
        require('./virusScan').status(),
    ]);
    const { rows: [school] } = await pool.query(`SELECT "paymentGateway" FROM "schools" WHERE "_id" = $1`, [s]);
    const gateway = require('../paymentGateway').publicGateway(school?.paymentGateway, 'admission');
    const mailer = require('./mailer');
    const fileStore = require('./fileStore');
    const captcha = require('./captcha').config();
    return {
        checkedAt: new Date(),
        jobs: jobList,
        email: { driver: mailer.driver ? mailer.driver() : 'smtp', ...mail },
        storage: { driver: fileStore.driver() },
        payments: { online: !!gateway.enabled },
        captcha: { on: captcha.ready, provider: captcha.ready ? captcha.provider : null },
        scanning,
        exports: exportsQ,
    };
}

module.exports = { record, prune, jobs, health, HOST };
