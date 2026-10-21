'use strict';
/**
 * Data protection for admissions (Oct 2026) — the Digital Personal Data
 * Protection Act, 2023 and its Rules (whose notice, consent, security, breach
 * and erasure duties apply from 13 May 2027).
 *
 *   retention   what is no longer needed goes: an application that did not
 *               lead to admission, once it has been closed for the school's
 *               chosen months; a draft nobody has touched for months;
 *               enquiries; delivery logs. An application on legal hold is
 *               never purged. Money records stay (the law keeps them), but
 *               without the family's details on them.
 *   requests    a family asks to see, correct or erase its information,
 *               withdraws consent, or raises a grievance — the office answers
 *               within the school's time limit (90 days at most).
 *   erasure     the application keeps its numbers, dates and outcome for the
 *               school's statistics; the child's and family's details, the
 *               documents and the free text are gone. Enrolled students are
 *               never erased here — their record lives on as a student's.
 *   access log  every reveal of an Aadhaar number and every export.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, lock } = require('../dbTx');
const AdmissionApplication = require('../../models/AdmissionApplication');
const AdmissionDataRequest = require('../../models/AdmissionDataRequest');
const AdmissionAccessLog = require('../../models/AdmissionAccessLog');
const workflow = require('./workflow');
const events = require('./events');
const formEngine = require('./formEngine');
const fileStore = require('./fileStore');
const { refuse, str, isId } = require('./util');
const { textProblem } = require('../../utils/textRules');

const TA = `"${AdmissionApplication.tableName}"`;
const UNSUCCESSFUL = ['rejected', 'ineligible', 'declined', 'withdrawn', 'cancelled', 'offer_expired'];
const NEVER_ERASE = ['confirmed', 'enrolled'];
const KINDS = ['access', 'correction', 'erasure', 'withdraw_consent', 'grievance'];
const KIND_LABEL = { access: 'A copy of my information', correction: 'Correct my information', erasure: 'Erase my information', withdraw_consent: 'Withdraw my consent', grievance: 'A grievance' };

// ── Erasing one application ──────────────────────────────────────────────────

/**
 * Erase an application's personal data in place. Refused for an enrolled or
 * confirmed admission and for one on legal hold. Idempotent: an application
 * already erased is left as it is.
 */
async function eraseApplication(app, { reason = 'retention', by = null } = {}) {
    if (app.erasedAt) return { erased: false, already: true };
    if (NEVER_ERASE.includes(app.status)) refuse('An admitted student\'s application is part of the student record — it is not erased here', 409, { code: 'ENROLLED' });
    if (app.legalHold?.on) refuse(`This application is on legal hold — ${app.legalHold.reason}`, 409, { code: 'LEGAL_HOLD' });
    const files = [];
    await withTransaction(async (q) => {
        await lock(q, `admission-erase:${app._id}`);
        const { rows: [cur] } = await q(`SELECT "_id", "erasedAt", "status", "legalHold" FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [String(app._id)]);
        if (!cur || cur.erasedAt) return;
        if (NEVER_ERASE.includes(cur.status) || cur.legalHold?.on) refuse('The application changed — refresh and try again', 409);
        const { rows: docs } = await q(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [String(app._id)]);
        files.push(...docs.map((d) => d.file).filter(Boolean));
        await q(`DELETE FROM "admissiondocuments" WHERE "application" = $1`, [String(app._id)]);
        await q(`DELETE FROM "admissionattempts" WHERE "application" = $1`, [String(app._id)]);
        await q(`UPDATE "admissionresults" SET "remarks" = '', "updatedAt" = now() WHERE "application" = $1`, [String(app._id)]);
        await q(`UPDATE "admissionevents" SET "message" = CASE WHEN "type" = 'status' THEN split_part("message", ' — ', 1) ELSE 'Details erased' END, "meta" = '{}'::jsonb WHERE "application" = $1`, [String(app._id)]);
        await q(`DELETE FROM "admissionemaillogs" WHERE "application" = $1`, [String(app._id)]);
        await q(`UPDATE "admissionpayments" SET "notes" = '', "updatedAt" = now() WHERE "application" = $1`, [String(app._id)]);
        await q(`UPDATE "admissionlistentries" SET "reason" = CASE WHEN "reason" <> '' THEN 'Details erased' ELSE '' END WHERE "application" = $1`, [String(app._id)]);
        await q(`UPDATE "admissionappeals" SET "reason" = 'Details erased', "decision" = CASE WHEN "decision" <> '' THEN 'Details erased' ELSE '' END, "internalNote" = '', "outcome" = '{}'::jsonb, "updatedAt" = now() WHERE "application" = $1`, [String(app._id)]);
        await q(
            `UPDATE ${TA} SET "data" = '{}'::jsonb, "retiredData" = '{}'::jsonb, "studentName" = 'Erased applicant', "studentDob" = NULL, "studentGender" = '',
                    "guardianName" = '', "guardianEmail" = '', "guardianPhone" = '', "source" = '', "closedReason" = '', "pendingTransition" = NULL,
                    "flags" = '{}'::jsonb, "erasedAt" = now(), "erasureReason" = $2, "updatedAt" = now()
              WHERE "_id" = $1`, [String(app._id), str(reason, 200)]);
    });
    for (const f of files) fileStore.remove(f);
    events.recordQuietly(app.school, { application: app._id, by, type: 'privacy', action: 'erased', message: `Personal data erased — ${reason}` });
    return { erased: true, files: files.length };
}

/** An applicant account with nothing left to it: its sign-in is closed and its details cleared. */
async function retireApplicant(schoolId, userId) {
    const { rows: [left] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TA} WHERE "applicant" = $1 AND "erasedAt" IS NULL`, [String(userId)]);
    if (left.n > 0) return false;
    const { rows: [u] } = await pool.query(`SELECT "email" FROM "users" WHERE "_id" = $1 AND "school" = $2 AND "role" = 'guest'`, [String(userId), String(schoolId)]);
    if (!u) return false;
    await pool.query(`DELETE FROM "admissionotps" WHERE "school" = $1 AND "email" = $2`, [String(schoolId), String(u.email || '').toLowerCase()]);
    const { rowCount } = await pool.query(
        `UPDATE "users" SET "name" = 'Erased applicant', "email" = 'erased+' || "_id"::text || '@invalid.example', "phone" = '', "isActive" = false, "password" = md5(random()::text)
          WHERE "_id" = $1 AND "school" = $2 AND "role" = 'guest' AND "email" NOT LIKE 'erased+%'`, [String(userId), String(schoolId)]);
    await pool.query(`UPDATE "admissionapplicants" SET "phone" = '', "source" = '' WHERE "user" = $1`, [String(userId)]);
    await pool.query(`UPDATE "admissionvisitbookings" SET "name" = 'Erased applicant', "email" = '', "phone" = '', "note" = '', "updatedAt" = now() WHERE "school" = $1 AND "applicant" = $2`, [String(schoolId), String(userId)]);
    return rowCount > 0;
}

// ── Retention ────────────────────────────────────────────────────────────────

/** What a retention run would take, without taking it. */
async function retentionPreview(schoolId, settings) {
    const r = settings.privacy.retention;
    const q = (sql, p) => pool.query(sql, p).then((x) => x.rows[0].n);
    return {
        enabled: r.enabled,
        unsuccessful: await q(`SELECT COUNT(*)::int AS n FROM ${TA} WHERE "school" = $1 AND "status" = ANY($2::text[]) AND "erasedAt" IS NULL
                                AND NOT COALESCE(("legalHold"->>'on')::boolean, false) AND COALESCE("statusChangedAt", "updatedAt") < now() - make_interval(months => $3)`,
        [String(schoolId), UNSUCCESSFUL, r.unsuccessfulMonths]),
        drafts: await q(`SELECT COUNT(*)::int AS n FROM ${TA} a WHERE a."school" = $1 AND a."status" = 'draft' AND COALESCE(a."lastActivityAt", a."updatedAt") < now() - make_interval(days => $2)
                          AND NOT COALESCE((a."legalHold"->>'on')::boolean, false)
                          AND NOT EXISTS (SELECT 1 FROM "admissionpayments" p WHERE p."application" = a."_id")`, [String(schoolId), r.abandonedDraftDays]),
        enquiries: await q(`SELECT COUNT(*)::int AS n FROM "admissionenquiries" WHERE "school" = $1 AND "createdAt" < now() - make_interval(months => $2)`, [String(schoolId), r.enquiryMonths]),
        deliveryLogs: await q(`SELECT COUNT(*)::int AS n FROM "admissionemaillogs" WHERE "school" = $1 AND "createdAt" < now() - make_interval(months => $2)`, [String(schoolId), r.deliveryLogMonths]),
        onHold: await q(`SELECT COUNT(*)::int AS n FROM ${TA} WHERE "school" = $1 AND COALESCE(("legalHold"->>'on')::boolean, false)`, [String(schoolId)]),
        erasedSoFar: await q(`SELECT COUNT(*)::int AS n FROM ${TA} WHERE "school" = $1 AND "erasedAt" IS NOT NULL`, [String(schoolId)]),
        months: r,
    };
}

/** Apply the school's retention periods. Safe to run often and on many servers at once. */
async function runRetention(schoolId, settings, { by = null, limit = 500 } = {}) {
    const r = settings.privacy.retention;
    if (!r.enabled) return { skipped: 'Retention is switched off' };
    const out = { erased: 0, drafts: 0, enquiries: 0, deliveryLogs: 0, accounts: 0, errors: 0 };
    const { rows: old } = await pool.query(
        `SELECT * FROM ${TA} WHERE "school" = $1 AND "status" = ANY($2::text[]) AND "erasedAt" IS NULL
            AND NOT COALESCE(("legalHold"->>'on')::boolean, false) AND COALESCE("statusChangedAt", "updatedAt") < now() - make_interval(months => $3)
          ORDER BY "statusChangedAt" LIMIT $4`, [String(schoolId), UNSUCCESSFUL, r.unsuccessfulMonths, limit]);
    const touched = new Set();
    for (const app of old) {
        try { const x = await eraseApplication(app, { reason: `retention: closed more than ${r.unsuccessfulMonths} months`, by }); if (x.erased) { out.erased += 1; touched.add(String(app.applicant)); } } catch (e) { out.errors += 1; }
    }
    const { rows: drafts } = await pool.query(
        `SELECT a."_id", a."applicant" FROM ${TA} a WHERE a."school" = $1 AND a."status" = 'draft' AND COALESCE(a."lastActivityAt", a."updatedAt") < now() - make_interval(days => $2)
            AND NOT COALESCE((a."legalHold"->>'on')::boolean, false)
            AND NOT EXISTS (SELECT 1 FROM "admissionpayments" p WHERE p."application" = a."_id") LIMIT $3`, [String(schoolId), r.abandonedDraftDays, limit]);
    for (const d of drafts) {
        const { rows: docs } = await pool.query(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [d._id]);
        const del = await pool.query(`DELETE FROM ${TA} WHERE "_id" = $1 AND "status" = 'draft' RETURNING "_id"`, [d._id]).catch(() => ({ rowCount: 0 }));
        if (del.rowCount) {
            out.drafts += 1;
            touched.add(String(d.applicant));
            for (const f of docs) fileStore.remove(f.file);
        }
    }
    out.enquiries = (await pool.query(`DELETE FROM "admissionenquiries" WHERE "school" = $1 AND "createdAt" < now() - make_interval(months => $2)`, [String(schoolId), r.enquiryMonths])).rowCount;
    out.deliveryLogs = (await pool.query(`DELETE FROM "admissionemaillogs" WHERE "school" = $1 AND "createdAt" < now() - make_interval(months => $2)`, [String(schoolId), r.deliveryLogMonths])).rowCount;
    for (const u of touched) { if (await retireApplicant(schoolId, u).catch(() => false)) out.accounts += 1; }
    if (out.erased || out.drafts || out.enquiries || out.deliveryLogs) {
        events.recordQuietly(schoolId, { by, type: 'privacy', action: 'retention', message: `Retention: ${out.erased} application(s) erased, ${out.drafts} old draft(s), ${out.enquiries} enquiry(ies) and ${out.deliveryLogs} delivery log(s) deleted`, meta: out });
    }
    return out;
}

// ── Legal hold ───────────────────────────────────────────────────────────────

async function setLegalHold(req, app, { on, reason }) {
    const why = str(reason, 300);
    if (on && !why) refuse('Say why the application must be kept — a dispute, a court order, an inquiry', 400, { field: 'reason' });
    if (why) { const bad = textProblem(why, 'The reason'); if (bad) refuse(bad, 400, { field: 'reason' }); }
    const hold = on ? { on: true, reason: why, by: String(req.userId), byName: req.user?.name || '', at: new Date() } : null;
    const row = await patch(AdmissionApplication, app._id, { legalHold: hold }, { touch: false });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'privacy', action: on ? 'hold_on' : 'hold_off', message: on ? `Put on legal hold — ${why}` : `Legal hold released${why ? ` — ${why}` : ''}` });
    return row;
}

// ── The access log ───────────────────────────────────────────────────────────

function logAccess(req, { application = null, action, field = '', detail = '' }) {
    AdmissionAccessLog.create({
        school: req.schoolId, application, user: req.userId || null, userName: req.user?.name || '', role: req.userRole || '',
        action, field: str(field, 60), detail: str(detail, 300),
    }).catch((e) => console.error('[admission privacy] access log:', e.message));
}

/** An Aadhaar number of an application, in full — for an administrator, logged. */
async function reveal(req, app, field) {
    if (app.erasedAt) refuse('This application\'s personal data has been erased', 409);
    const schema = await require('./applications').schemaOf(app);
    const f = formEngine.allFields(schema).find((x) => x.key === String(field || ''));
    if (!f || !formEngine.isAadhaarField(f)) refuse('Only an Aadhaar number is masked', 400, { field: 'field' });
    const value = app.data?.[f.key] ?? '';
    logAccess(req, { application: app._id, action: 'reveal', field: f.key, detail: f.label || f.key });
    return { field: f.key, value };
}

async function accessLog(req, { page = 1, limit = 50 } = {}) {
    const p = Math.max(1, Math.round(Number(page)) || 1);
    const l = Math.min(200, Math.max(1, Math.round(Number(limit)) || 50));
    const { rows } = await pool.query(
        `SELECT g."_id", g."action", g."field", g."detail", g."userName", g."role", g."createdAt", g."application", a."applicationNumber", a."studentName"
           FROM "admissionaccesslogs" g LEFT JOIN ${TA} a ON a."_id" = g."application"
          WHERE g."school" = $1 ORDER BY g."createdAt" DESC LIMIT $2 OFFSET $3`, [String(req.schoolId), l, (p - 1) * l]);
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionaccesslogs" WHERE "school" = $1`, [String(req.schoolId)]);
    return { rows, total: n.n, page: p, pages: Math.max(1, Math.ceil(n.n / l)) };
}

// ── A family's own information ───────────────────────────────────────────────

/** Everything held about the signed-in applicant at this school, as one JSON document. */
async function exportMine(req) {
    const uid = String(req.userId);
    const { rows: [user] } = await pool.query(`SELECT "name", "email", "phone", "createdAt" FROM "users" WHERE "_id" = $1`, [uid]);
    const { rows: [profile] } = await pool.query(`SELECT "phone", "verifiedAt", "consentAt", "consentVersion", "source", "lastLoginAt" FROM "admissionapplicants" WHERE "user" = $1`, [uid]);
    const { rows: apps } = await pool.query(`SELECT * FROM ${TA} WHERE "school" = $1 AND "applicant" = $2 ORDER BY "createdAt"`, [String(req.schoolId), uid]);
    const out = [];
    for (const a of apps) {
        const schema = await require('./applications').schemaOf(a);
        const q = (sql) => pool.query(sql, [String(a._id)]).then((r) => r.rows);
        out.push({
            applicationNumber: a.applicationNumber || '(draft)', status: workflow.STATUSES[a.status]?.label || a.status, createdAt: a.createdAt, submittedAt: a.submittedAt,
            answers: formEngine.answerRows(schema, a.data, { includeSensitive: true, maskIds: false }),
            documents: await q(`SELECT "docKey", "originalName", "status", "createdAt" FROM "admissiondocuments" WHERE "application" = $1 AND "current"`),
            payments: await q(`SELECT "receiptNumber", "kind", "amount", "mode", "status", "paidAt" FROM "admissionpayments" WHERE "application" = $1`),
            offers: await q(`SELECT "offerNumber", "status", "issuedAt", "respondBy", "feeAmount" FROM "admissionoffers" WHERE "application" = $1`),
            exams: await q(`SELECT e."name", c."rollNumber", c."status", r."total", r."grade", r."status" AS "resultStatus" FROM "admissioncandidates" c JOIN "admissionexams" e ON e."_id" = c."exam"
                             LEFT JOIN "admissionresults" r ON r."exam" = c."exam" AND r."application" = c."application" AND r."status" = 'published' WHERE c."application" = $1`),
            appeals: await q(`SELECT "number", "kind", "status", "reason", "decision", "createdAt", "decidedAt" FROM "admissionappeals" WHERE "application" = $1 ORDER BY "createdAt"`),
            history: (await events.timeline(a.school, a._id, { applicantView: true })).map((e) => ({ when: e.createdAt, what: e.message })),
            erased: !!a.erasedAt,
        });
    }
    const { rows: requests } = await pool.query(`SELECT "number", "kind", "status", "details", "response", "createdAt", "handledAt" FROM "admissiondatarequests" WHERE "school" = $1 AND "applicant" = $2 ORDER BY "createdAt"`, [String(req.schoolId), uid]);
    const { rows: visits } = await pool.query(
        `SELECT s."title", s."startsAt", b."people", b."note", b."status", b."createdAt" FROM "admissionvisitbookings" b JOIN "admissionvisitslots" s ON s."_id" = b."slot"
          WHERE b."school" = $1 AND b."applicant" = $2 ORDER BY b."createdAt"`, [String(req.schoolId), uid]);
    return {
        generatedAt: new Date(), school: req.portal?.school?.name || '',
        account: { name: user?.name, email: user?.email, phone: user?.phone || profile?.phone || '', createdAt: user?.createdAt, verifiedAt: profile?.verifiedAt, lastSignIn: profile?.lastLoginAt },
        consent: { privacyNoticeVersion: profile?.consentVersion || 0, agreedAt: profile?.consentAt || null },
        applications: out, requests, visits,
    };
}

// ── Requests ─────────────────────────────────────────────────────────────────

async function nextRequestNumber(schoolId) {
    const y = new Date().getFullYear();
    const { rows: [r] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissiondatarequests" WHERE "school" = $1 AND "createdAt" >= make_date($2, 1, 1)`, [String(schoolId), y]);
    return `DPR${y}${String(r.n + 1).padStart(4, '0')}`;
}

async function createRequest(req, input = {}) {
    const kind = KINDS.includes(input.kind) ? input.kind : null;
    if (!kind) refuse('Choose what you are asking for');
    const details = str(input.details, 2000);
    if (['correction', 'grievance'].includes(kind) && details.length < 10) refuse('Tell the school what needs to change or what went wrong', 400, { field: 'details' });
    if (details) { const bad = textProblem(details, 'Your message'); if (bad) refuse(bad, 400, { field: 'details' }); }
    let application = null;
    if (input.application) {
        if (!isId(String(input.application))) refuse('Application not found', 404);
        const { rows: [a] } = await pool.query(`SELECT "_id" FROM ${TA} WHERE "_id" = $1 AND "school" = $2 AND "applicant" = $3`, [String(input.application), String(req.schoolId), String(req.userId)]);
        if (!a) refuse('Application not found', 404);
        application = a._id;
    }
    const { rows: [open] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissiondatarequests" WHERE "school" = $1 AND "applicant" = $2 AND "status" IN ('open', 'in_progress')`, [String(req.schoolId), String(req.userId)]);
    if (open.n >= 5) refuse('You have five requests waiting already — the school will answer them first', 429);
    const settings = req.portal?.settings || await require('./settings').getSettings(req.schoolId);
    const days = settings.privacy?.requestDays || 30;
    const row = await AdmissionDataRequest.create({
        school: req.schoolId, applicant: req.userId, application, number: await nextRequestNumber(req.schoolId), kind, details,
        dueAt: new Date(Date.now() + days * 86400000), applicantName: req.user?.name || '', applicantEmail: req.user?.email || '',
    });
    // Withdrawing consent stops the processing now: every open application is withdrawn.
    if (kind === 'withdraw_consent') {
        const apps = require('./applications');
        const { rows } = await pool.query(`SELECT * FROM ${TA} WHERE "school" = $1 AND "applicant" = $2 AND "status" NOT IN ('draft', 'confirmed', 'enrolled') AND "erasedAt" IS NULL`, [String(req.schoolId), String(req.userId)]);
        for (const a of rows) {
            if (workflow.isClosed(a.status)) continue;
            await apps.move(req, a, 'withdrawn', { system: true, actorIsApplicant: true, reason: 'Consent withdrawn by the family' }).catch(() => {});
        }
    }
    const admins = await require('../designationService').moduleAdminIds(req.schoolId, 'admission').catch(() => []);
    if (admins.length) {
        require('../notifyService').notify({
            school: req.schoolId, sender: admins[0], senderRole: 'system', recipients: admins, includeSender: true,
            title: `Privacy request ${row.number}: ${KIND_LABEL[kind]}`, body: `From ${req.user?.name || 'an applicant'} — answer by ${row.dueAt.toLocaleDateString('en-IN')}.`,
            link: { type: 'admission.privacy' },
        });
    }
    require('./notify').toApplicantUser(req.schoolId, req.userId, 'data_request_received', { request_number: row.number, request_kind: KIND_LABEL[kind], due_date: row.dueAt.toLocaleDateString('en-IN') });
    return row.toObject ? row.toObject() : row;
}

async function myRequests(req) {
    const { rows } = await pool.query(
        `SELECT "_id", "number", "kind", "details", "status", "response", "dueAt", "handledAt", "createdAt", "application" FROM "admissiondatarequests"
          WHERE "school" = $1 AND "applicant" = $2 ORDER BY "createdAt" DESC`, [String(req.schoolId), String(req.userId)]);
    return rows.map((r) => ({ ...r, kindLabel: KIND_LABEL[r.kind] }));
}

async function officeRequests(req, { status = '' } = {}) {
    const params = [String(req.schoolId)];
    let extra = '';
    if (status === 'waiting') extra = ` AND r."status" IN ('open', 'in_progress')`;
    else if (['open', 'in_progress', 'done', 'declined'].includes(status)) { params.push(status); extra = ` AND r."status" = $2`; }
    const { rows } = await pool.query(
        `SELECT r.*, a."applicationNumber", a."studentName", a."status" AS "applicationStatus", u."name" AS "handledByName"
           FROM "admissiondatarequests" r LEFT JOIN ${TA} a ON a."_id" = r."application" LEFT JOIN "users" u ON u."_id" = r."handledBy"
          WHERE r."school" = $1${extra} ORDER BY (r."status" IN ('open', 'in_progress')) DESC, r."dueAt" ASC, r."createdAt" DESC LIMIT 300`, params);
    const { rows: [c] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE "status" IN ('open', 'in_progress'))::int AS waiting,
                COUNT(*) FILTER (WHERE "status" IN ('open', 'in_progress') AND "dueAt" < now())::int AS overdue
           FROM "admissiondatarequests" WHERE "school" = $1`, [String(req.schoolId)]);
    return { rows: rows.map((r) => ({ ...r, kindLabel: KIND_LABEL[r.kind], overdue: ['open', 'in_progress'].includes(r.status) && r.dueAt && new Date(r.dueAt) < new Date() })), counts: c };
}

async function answerRequest(req, id, input = {}) {
    if (!isId(String(id || ''))) refuse('Request not found', 404);
    const { rows: [r] } = await pool.query(`SELECT * FROM "admissiondatarequests" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!r) refuse('Request not found', 404);
    const status = ['open', 'in_progress', 'done', 'declined'].includes(input.status) ? input.status : r.status;
    const response = input.response !== undefined ? str(input.response, 2000) : r.response;
    if (['done', 'declined'].includes(status) && !response) refuse('Write the answer the family will see', 400, { field: 'response' });
    for (const [label, v] of [['The answer', response], ['The note', input.internalNote]]) { if (v) { const bad = textProblem(str(v, 2000), label); if (bad) refuse(bad, 400); } }
    const set = { status, response, internalNote: input.internalNote !== undefined ? str(input.internalNote, 2000) : r.internalNote };
    if (['done', 'declined'].includes(status) && !['done', 'declined'].includes(r.status)) { set.handledBy = req.userId; set.handledAt = new Date(); }
    const row = await patch(AdmissionDataRequest, r._id, set);
    if (['done', 'declined'].includes(status) && !['done', 'declined'].includes(r.status)) {
        require('./notify').toApplicantUser(req.schoolId, r.applicant, 'data_request_closed', { request_number: r.number, request_kind: KIND_LABEL[r.kind], request_outcome: status === 'done' ? 'completed' : 'declined', remarks: response });
    }
    events.recordQuietly(req.schoolId, { application: r.application, by: req, type: 'privacy', action: `request_${status}`, message: `Privacy request ${r.number} (${KIND_LABEL[r.kind]}) — ${status.replace('_', ' ')}` });
    return row;
}

/** Erase what an erasure (or withdrawn-consent) request asks: every application of that applicant that may be erased. */
async function eraseForRequest(req, id) {
    if (!isId(String(id || ''))) refuse('Request not found', 404);
    const { rows: [r] } = await pool.query(`SELECT * FROM "admissiondatarequests" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!r) refuse('Request not found', 404);
    if (!['erasure', 'withdraw_consent'].includes(r.kind)) refuse('Only an erasure or a withdrawal of consent erases information', 409);
    const { rows: apps } = await pool.query(`SELECT * FROM ${TA} WHERE "school" = $1 AND "applicant" = $2 AND "erasedAt" IS NULL`, [String(req.schoolId), String(r.applicant)]);
    const out = { erased: 0, kept: [] };
    for (const a of apps) {
        if (NEVER_ERASE.includes(a.status)) { out.kept.push({ applicationNumber: a.applicationNumber, why: 'admitted — part of the student record' }); continue; }
        if (a.legalHold?.on) { out.kept.push({ applicationNumber: a.applicationNumber, why: `on legal hold — ${a.legalHold.reason}` }); continue; }
        if (!workflow.isClosed(a.status) && a.status !== 'draft') {
            await require('./applications').move(req, a, 'withdrawn', { system: true, reason: `Erasure request ${r.number}` }).catch(() => {});
        }
        const { rows: [fresh] } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = $1`, [String(a._id)]);
        try { const x = await eraseApplication(fresh, { reason: `request ${r.number}`, by: req }); if (x.erased) out.erased += 1; } catch (e) { out.kept.push({ applicationNumber: a.applicationNumber, why: e.message }); }
    }
    await retireApplicant(req.schoolId, r.applicant).catch(() => false);
    return out;
}

module.exports = {
    UNSUCCESSFUL, KINDS, KIND_LABEL,
    eraseApplication, retireApplicant, retentionPreview, runRetention, setLegalHold, logAccess, reveal, accessLog,
    exportMine, createRequest, myRequests, officeRequests, answerRequest, eraseForRequest,
};
