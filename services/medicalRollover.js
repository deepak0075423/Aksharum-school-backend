'use strict';
/**
 * A new academic year in the Medical Room (Oct 2026) — a checklist of what
 * the year end leaves behind, with a button for what is safe to do in bulk:
 *
 *   departed visits never closed   close them (a child still "in the room"
 *                                  from an earlier day is listed, not closed —
 *                                  someone has to say what happened)
 *   requests left open             close them, saying why
 *   medicine plans past their end  mark them completed
 *   plans with no end date         listed: check they continue this year
 *   this year's consent            ask the families who have not given it
 *   care plans due for review,     listed, with the student
 *   rescue medicines expiring,
 *   children off school for long
 *
 * Every bulk action is one audit entry saying how many.
 */
const pool = require('../db/pool');
const audit = require('./medicalAudit');
const R = require('./medicalRules');

const { refuse, todayStr, addDays } = R;
const S = (v) => String(v);
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const localDay = (col) => `(${col} AT TIME ZONE '${R.ZONE}')::date`;
const storedDay = (col) => `(${col} AT TIME ZONE 'UTC')::date`;
const STUDENT = `u."name" AS "studentName", u."_id"::text AS "studentId"`;

async function checklist(req) {
    const p = [S(req.schoolId), todayStr()];
    const consentSvc = require('./medicalConsent');
    const year = await consentSvc.currentYear(req.schoolId);
    const [visits, inRoom, requests, ended, openEnded, care, rescue, exclusions, [consent]] = await Promise.all([
        q(`SELECT v."_id"::text AS "_id", v."number", v."status", v."arrivedAt", ${STUDENT} FROM "medicalvisits" v JOIN "users" u ON u."_id" = v."student"
            WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" IN ('returned','sent_home','referred') AND ${localDay('v."arrivedAt"')} < $2::date
              AND COALESCE(v."followUp"->>'status', '') <> 'pending' ORDER BY v."arrivedAt" LIMIT 500`, p),
        q(`SELECT v."_id"::text AS "_id", v."number", v."status", v."arrivedAt", ${STUDENT} FROM "medicalvisits" v JOIN "users" u ON u."_id" = v."student"
            WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" IN ('in_room','observation','emergency') AND ${localDay('v."arrivedAt"')} < $2::date ORDER BY v."arrivedAt" LIMIT 50`, p),
        q(`SELECT r."_id"::text AS "_id", r."number", r."status", r."createdAt", ${STUDENT} FROM "medicalrequests" r JOIN "users" u ON u."_id" = r."student"
            WHERE r."school" = $1 AND r."status" IN ('requested','accepted','arrived') AND ${localDay('r."createdAt"')} < $2::date ORDER BY r."createdAt" LIMIT 500`, p),
        q(`SELECT m."_id"::text AS "_id", m."medicineName", m."endDate", ${STUDENT} FROM "medicationplans" m JOIN "users" u ON u."_id" = m."student"
            WHERE m."school" = $1 AND m."status" IN ('active','paused') AND m."endDate" IS NOT NULL AND ${storedDay('m."endDate"')} < $2::date ORDER BY m."endDate" LIMIT 500`, p),
        q(`SELECT m."_id"::text AS "_id", m."medicineName", m."startDate", ${STUDENT} FROM "medicationplans" m JOIN "users" u ON u."_id" = m."student"
            WHERE m."school" = $1 AND m."status" = 'active' AND m."endDate" IS NULL ORDER BY u."name" LIMIT 100`, [p[0]]),
        q(`SELECT c."_id"::text AS "_id", c."title", c."reviewDue", ${STUDENT} FROM "medicalcareplans" c JOIN "users" u ON u."_id" = c."student"
            WHERE c."school" = $1 AND c."archivedAt" IS NULL AND c."status" = 'active' AND c."reviewDue" IS NOT NULL AND ${storedDay('c."reviewDue"')} <= $2::date + 30 ORDER BY c."reviewDue" LIMIT 100`, p),
        q(`SELECT m."_id"::text AS "_id", m."name", m."expiresOn", ${STUDENT} FROM "medicalrescuemeds" m JOIN "users" u ON u."_id" = m."student"
            WHERE m."school" = $1 AND m."archivedAt" IS NULL AND m."status" = 'active' AND m."expiresOn" IS NOT NULL AND ${storedDay('m."expiresOn"')} <= $2::date + 60 ORDER BY m."expiresOn" LIMIT 100`, p),
        q(`SELECT x."_id"::text AS "_id", x."label", x."from", ${STUDENT} FROM "medicalexclusions" x JOIN "users" u ON u."_id" = x."student"
            WHERE x."school" = $1 AND x."status" = 'excluded' AND ${storedDay('x."from"')} < $2::date - 30 ORDER BY x."from" LIMIT 100`, p),
        q(`SELECT count(*)::int AS n FROM "users" u LEFT JOIN "medicalconsents" c ON c."student" = u."_id" AND c."school" = $1 AND c."academicYear" IS NOT DISTINCT FROM $2::uuid
            WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE AND (c."_id" IS NULL OR c."status" <> 'given')`, [S(req.schoolId), year?._id || null]),
    ]);
    const step = (key, title, about, rows, action = null, tone = 'amber') => ({ key, title, about, count: rows.length, rows: rows.slice(0, 20), action, tone });
    return {
        year: year ? { _id: year._id, name: year.yearName } : null,
        steps: [
            step('close_visits', 'Visits never closed', 'Children who left the room on an earlier day — returned to class, sent home or referred — with nothing left to do.', visits, 'Close them', 'slate'),
            step('in_room', 'Still "in the room" from an earlier day', 'Someone has to say what happened — open each one.', inRoom, null, 'red'),
            step('close_requests', 'Requests left open', 'Teachers\' requests from earlier days the room never answered.', requests, 'Close them'),
            step('end_plans', 'Medicine plans past their end date', 'Still active or paused after the last day.', ended, 'Mark them completed'),
            step('open_plans', 'Medicine plans with no end date', 'Check with the families that they continue this year.', openEnded, null, 'indigo'),
            { key: 'ask_consent', title: `This year's consent${year ? ` (${year.yearName})` : ''}`, about: 'Students whose families have not given this year\'s medical consent. Families asked in the last week are not asked again.', count: consent?.n || 0, rows: [], action: 'Ask the families', tone: 'indigo' },
            step('care_review', 'Care plans due for review', 'Within the next month, or overdue.', care, null, 'amber'),
            step('rescue_expiring', 'Rescue medicines expiring', 'Within 60 days, or already out of date — ask the families for new ones.', rescue, null, 'red'),
            step('long_exclusions', 'Off school for more than a month', 'Still marked off school — clear them, or check with the family.', exclusions, null, 'amber'),
        ],
    };
}

async function act(req, key) {
    const today = todayStr();
    const by = { at: new Date(), by: S(req.userId), byName: req.user?.name || '', note: 'Closed at the start of the new year' };
    let n = 0; let summary = '';
    if (key === 'close_visits') {
        const { rowCount } = await pool.query(
            `UPDATE "medicalvisits" SET "status" = 'closed', "closedAt" = now(), "closedBy" = $3, "updatedAt" = now(),
                    "history" = COALESCE("history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object('status', 'closed') || $4::jsonb)
              WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" IN ('returned','sent_home','referred') AND ${localDay('"arrivedAt"')} < $2::date
                AND COALESCE("followUp"->>'status', '') <> 'pending'`,
            [S(req.schoolId), today, S(req.userId), JSON.stringify(by)]);
        n = rowCount; summary = `${n} visit${n === 1 ? '' : 's'} closed at the start of the year`;
    } else if (key === 'close_requests') {
        const { rowCount } = await pool.query(
            `UPDATE "medicalrequests" SET "status" = 'cancelled', "cancelledAt" = now(), "cancelReason" = 'Closed at the start of the new year', "updatedAt" = now(),
                    "history" = COALESCE("history", '[]'::jsonb) || jsonb_build_array(jsonb_build_object('status', 'cancelled') || $3::jsonb)
              WHERE "school" = $1 AND "status" IN ('requested','accepted','arrived') AND ${localDay('"createdAt"')} < $2::date`,
            [S(req.schoolId), today, JSON.stringify(by)]);
        n = rowCount; summary = `${n} old request${n === 1 ? '' : 's'} closed at the start of the year`;
    } else if (key === 'end_plans') {
        const { rowCount } = await pool.query(
            `UPDATE "medicationplans" SET "status" = 'completed', "statusNote" = 'Ended — past its end date (new year)', "updatedAt" = now()
              WHERE "school" = $1 AND "status" IN ('active','paused') AND "endDate" IS NOT NULL AND ${storedDay('"endDate"')} < $2::date`,
            [S(req.schoolId), today]);
        n = rowCount; summary = `${n} medicine plan${n === 1 ? '' : 's'} past the end date marked completed`;
    } else if (key === 'ask_consent') {
        await require('./medicalConsent').request(req, {});
        return { done: true, message: 'The families without this year\'s consent have been asked' };
    } else refuse('Unknown step', 404, 'MEDICAL_NOT_FOUND');
    audit.log(req, { action: 'year_start', entity: 'rollover', summary });
    return { done: true, count: n, message: summary };
}

module.exports = { checklist, act };
