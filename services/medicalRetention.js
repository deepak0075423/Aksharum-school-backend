'use strict';
/**
 * Leaving, keeping and erasing (Oct 2026).
 *
 *   leavers    the sweep notes the day a student is first seen to have left
 *              (their account switched off) on their medical profile
 *   due        former students whose record is past the school's
 *              retentionYears and not on legal hold — the list to review
 *   hold       a legal hold (a claim, an inquiry) stops a record being purged
 *   purge      one former student's medical record, after the retention period,
 *              typing their name to confirm: their rows go, their files are
 *              deleted from disk, the stock ledger keeps its quantities without
 *              the name, and the audit trail keeps who did what and when with
 *              the health details removed. A safeguarding record is never purged
 *              with it — the leads keep it under their own rules.
 *   requests   a family asks for a copy, a correction or erasure; the school
 *              answers within 30 days (MedicalDataRequest)
 *
 * Nothing is ever purged by itself.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { withTransaction } = require('../db/pool');
const { insert, patch } = require('../db/patch');
const MedicalDataRequest = require('../models/MedicalDataRequest');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, oneOf, bool, isUuid, instantDayLabel } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

const KIND = { access: 'A copy of the record', correction: 'A correction', erasure: 'Erasure' };
// Rows about the student that go with the record (the student column, the table).
const PURGED = [
    'medicalvisits', 'medicalincidents', 'medicalfirstaids', 'medicationdoses', 'medicationplans', 'medicalallergies', 'medicalconditions',
    'medicalvaccinations', 'medicalcheckups', 'medicaldocuments', 'medicalrequests', 'medicalchangerequests', 'medicalrescuemeds',
    'medicalcareplans', 'medicalrestrictions', 'medicalexclusions', 'medicalconsents', 'medicalurgentnotices', 'medicalprofiles',
];

/** The sweep: stamp the day a student is first seen to have left. */
async function stampLeavers(schoolId) {
    // A leaver with medical data and no profile gets one, to carry the date (and any hold).
    const bare = await run(
        `SELECT u."_id"::text AS "_id" FROM "users" u
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" = false
            AND NOT EXISTS (SELECT 1 FROM "medicalprofiles" mp WHERE mp."student" = u."_id" AND mp."school" = u."school")
            AND (EXISTS (SELECT 1 FROM "medicalvisits" v WHERE v."student" = u."_id") OR EXISTS (SELECT 1 FROM "medicalallergies" a WHERE a."student" = u."_id")
                 OR EXISTS (SELECT 1 FROM "medicalconditions" c WHERE c."student" = u."_id") OR EXISTS (SELECT 1 FROM "medicaldocuments" d WHERE d."student" = u."_id"))
          LIMIT 200`,
        [S(schoolId)],
    );
    for (const b of bare) {
        try { await insert(require('../models/MedicalProfile'), { school: schoolId, student: b._id, leftOn: new Date() }); } catch { /* made a moment ago */ }
    }
    await pool.query(
        `UPDATE "medicalprofiles" mp SET "leftOn" = now(), "updatedAt" = now()
           FROM "users" u WHERE u."_id" = mp."student" AND mp."school" = $1 AND u."isActive" = false AND mp."leftOn" IS NULL`,
        [S(schoolId)],
    );
    // A student who comes back is not a leaver any more.
    await pool.query(
        `UPDATE "medicalprofiles" mp SET "leftOn" = NULL, "updatedAt" = now()
           FROM "users" u WHERE u."_id" = mp."student" AND mp."school" = $1 AND u."isActive" IS NOT FALSE AND mp."leftOn" IS NOT NULL`,
        [S(schoolId)],
    );
}

// A leaver not yet stamped counts from today: the retention period can only be longer, never shorter.
const LEFT = `COALESCE(mp."leftOn", now())`;

/** Former students: those past the retention period, and those still within it. */
async function due(req) {
    const s = await settingsSvc.get(req.schoolId);
    const years = Number(s.retentionYears) || 8;
    const rows = await run(
        `SELECT u."_id"::text AS "_id", u."name", sp."admissionNumber", ${LEFT} AS "leftOn",
                COALESCE(mp."legalHold", false) AS "legalHold", mp."legalHoldReason",
                (${LEFT} < now() - make_interval(years => $2::int)) AS "pastRetention",
                (SELECT count(*) FROM "medicalvisits" v WHERE v."student" = u."_id")::int AS "visits",
                (SELECT count(*) FROM "medicaldocuments" d WHERE d."student" = u."_id")::int AS "documents"
           FROM "users" u LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "medicalprofiles" mp ON mp."student" = u."_id" AND mp."school" = u."school"
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" = false
            AND (mp."_id" IS NOT NULL OR EXISTS (SELECT 1 FROM "medicalvisits" v WHERE v."student" = u."_id")
                 OR EXISTS (SELECT 1 FROM "medicalallergies" a WHERE a."student" = u."_id"))
          ORDER BY ${LEFT} ASC LIMIT 500`,
        [S(req.schoolId), years],
    );
    return { years, rows };
}

/** A former student's profile row (made when there is none, to carry the hold). */
async function profileRow(schoolId, studentId) {
    const [mp] = await run(`SELECT "_id" FROM "medicalprofiles" WHERE "school" = $1 AND "student" = $2 LIMIT 1`, [S(schoolId), S(studentId)]);
    if (mp) return S(mp._id);
    const row = await insert(require('../models/MedicalProfile'), { school: schoolId, student: studentId });
    return S(row._id);
}

async function hold(req, studentId, body = {}) {
    const student = await access.assertStudent(req.schoolId, studentId);
    const on = bool(body.on);
    const reason = str(body.reason, 300);
    if (on && !reason) refuse('Say why the record is held');
    const id = await profileRow(req.schoolId, student._id);
    await patch(require('../models/MedicalProfile'), id, { legalHold: on, legalHoldReason: on ? reason : '' }, { where: { school: req.schoolId } });
    audit.log(req, { action: on ? 'legal_hold' : 'legal_hold_lifted', entity: 'profile', student: student._id, summary: on ? `Legal hold: ${reason}` : 'Legal hold lifted' });
    return { legalHold: on };
}

/**
 * Purge one former student's medical record. body: { confirmName, reason }.
 * Refused while the student is at school, before the retention period ends,
 * or under a legal hold.
 */
async function purge(req, studentId, body = {}) {
    if (!isUuid(studentId)) notFound('Student');
    const [u] = await run(
        `SELECT u."_id"::text AS "_id", u."name", u."isActive", sp."admissionNumber", ${LEFT} AS "leftOn", COALESCE(mp."legalHold", false) AS "legalHold"
           FROM "users" u LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "medicalprofiles" mp ON mp."student" = u."_id" AND mp."school" = u."school"
          WHERE u."_id" = $1 AND u."school" = $2 AND u."role" = 'student'`,
        [S(studentId), S(req.schoolId)],
    );
    if (!u) notFound('Student');
    if (u.isActive !== false) refuse('This student is still at the school — a current record is never purged');
    if (u.legalHold) refuse('The record is on legal hold — lift the hold first');
    const s = await settingsSvc.get(req.schoolId);
    const years = Number(s.retentionYears) || 8;
    if (new Date(u.leftOn) > new Date(Date.now() - years * 365.25 * 86400000)) refuse(`The school keeps a former student's record for ${years} years — this one may be purged from ${instantDayLabel(new Date(new Date(u.leftOn).getTime() + years * 365.25 * 86400000))}`);
    if (str(body.confirmName, 120).toLowerCase() !== String(u.name).trim().toLowerCase()) refuse('Type the student\'s name exactly to confirm');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the record is being purged');

    const files = (await run(`SELECT "storedName" FROM "medicaldocuments" WHERE "school" = $1 AND "student" = $2`, [S(req.schoolId), S(studentId)])).map((r) => r.storedName).filter(Boolean);
    const counts = {};
    await withTransaction(async (q) => {
        for (const t of PURGED) {
            const { rowCount } = await q(`DELETE FROM "${t}" WHERE "school" = $1::uuid AND "student" = $2::uuid`, [S(req.schoolId), S(studentId)]);
            if (rowCount) counts[t] = rowCount;
        }
        // The stock ledger keeps its quantities, without the name.
        await q(`UPDATE "medicalstockmoves" SET "student" = NULL WHERE "school" = $1::uuid AND "student" = $2::uuid`, [S(req.schoolId), S(studentId)]);
        // A family's earlier requests stay as proof they were answered — without the link.
        await q(`UPDATE "medicaldatarequests" SET "student" = NULL WHERE "school" = $1::uuid AND "student" = $2::uuid`, [S(req.schoolId), S(studentId)]);
        // The trail keeps who did what, and when; not what the record said.
        await q(`UPDATE "medicalauditlogs" SET "summary" = '[removed under the retention policy]', "changes" = '[]'::jsonb, "student" = NULL
                  WHERE "school" = $1::uuid AND "student" = $2::uuid AND "entity" <> 'safeguarding'`, [S(req.schoolId), S(studentId)]);
    });
    let removed = 0;
    for (const f of files) {
        try { await fs.promises.unlink(path.join(__dirname, '..', 'uploads', 'medical-docs', path.basename(f))); removed += 1; } catch { /* already gone */ }
    }
    const total = Object.values(counts).reduce((n, c) => n + c, 0);
    audit.log(req, { action: 'purged', entity: 'profile', entityId: studentId, summary: `Medical record purged under the retention policy — ${u.name}${u.admissionNumber ? ` (${u.admissionNumber})` : ''}, left ${instantDayLabel(u.leftOn)}: ${total} rows, ${removed} files. Reason: ${reason}` });
    return { purged: total, files: removed, tables: counts };
}

/* ── A family's requests ──────────────────────────────────────────────────── */

async function request(req, body = {}) {
    const child = await access.familyChild(req, body.child);
    const kind = oneOf(body.kind, KIND, null);
    if (!kind) refuse('Choose what you are asking for');
    const details = str(body.details, 2000);
    if (kind !== 'access' && details.length < 10) refuse(kind === 'correction' ? 'Say what is wrong and what it should say' : 'Say what you would like erased, and why');
    const card = await access.studentCard(req.schoolId, child);
    const row = await insert(MedicalDataRequest, {
        school: req.schoolId, student: child, studentName: card?.name || '', kind, details, requestedBy: req.userId, requestedByName: who(req),
        dueOn: new Date(Date.now() + 30 * 86400000), status: 'open',
    });
    audit.log(req, { action: 'data_request', entity: 'data_request', entityId: row._id, student: child, summary: `${who(req)} asked for: ${KIND[kind].toLowerCase()}` });
    tell.toStaff(req, { title: `Data request — ${KIND[kind]}`, body: `${who(req)} sent a request about ${card?.name || 'their child'}'s medical record (${KIND[kind].toLowerCase()}). It must be answered by ${instantDayLabel(row.dueOn)}.`, setting: 'staffParentUpdates' });
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function familyRequests(req, childId) {
    const child = await access.familyChild(req, childId);
    return run(`SELECT "_id"::text AS "_id", "kind", "details", "status", "response", "respondedAt", "dueOn", "createdAt" FROM "medicaldatarequests"
                 WHERE "school" = $1 AND "student" = $2 ORDER BY "createdAt" DESC LIMIT 20`, [S(req.schoolId), S(child)])
        .then((rows) => rows.map((r) => ({ ...r, kindLabel: KIND[r.kind] })));
}

async function requests(req, { status = 'open' } = {}) {
    const st = ['open', 'done', 'refused', 'all'].includes(status) ? status : 'open';
    const rows = await run(
        `SELECT r.*, r."_id"::text AS "_id", r."student"::text AS "student" FROM "medicaldatarequests" r
          WHERE r."school" = $1 ${st === 'all' ? '' : 'AND r."status" = $2'} ORDER BY r."dueOn" ASC LIMIT 200`,
        st === 'all' ? [S(req.schoolId)] : [S(req.schoolId), st],
    );
    return rows.map((r) => ({ ...r, kindLabel: KIND[r.kind], overdue: r.status === 'open' && new Date(r.dueOn) < new Date() }));
}

/** body: { status: done | refused, response } */
async function respond(req, id, body = {}) {
    if (!isUuid(id)) notFound('Request');
    const r = await MedicalDataRequest.findOne({ _id: id, school: req.schoolId }).lean();
    if (!r) notFound('Request');
    if (r.status !== 'open') refuse('This request has been answered');
    const status = oneOf(body.status, { done: 1, refused: 1 }, null);
    if (!status) refuse('Say whether it was done or refused');
    const response = str(body.response, 2000);
    if (!response) refuse(status === 'refused' ? 'Say why it is refused' : 'Say what was done');
    const row = await patch(MedicalDataRequest, id, { status, response, respondedBy: req.userId, respondedByName: who(req), respondedAt: new Date() }, { where: { school: req.schoolId, status: 'open' } });
    if (!row) refuse('Someone answered it a moment ago', 409, 'MEDICAL_STALE');
    audit.log(req, { action: `data_request_${status}`, entity: 'data_request', entityId: id, student: r.student, summary: `${KIND[r.kind]} — ${status}: ${response.slice(0, 200)}` });
    if (r.student) {
        tell.toParents(req, r.student, { title: `Your request about ${r.studentName}'s medical record`, body: `${KIND[r.kind]}: ${status === 'done' ? 'done' : 'not possible'}. ${response}`, tab: 'overview' });
    }
    return row;
}

module.exports = { KIND, PURGED, stampLeavers, due, hold, purge, request, familyRequests, requests, respond };
