'use strict';
/**
 * Every class test in the school, for the office (Oct 2026). Class tests are a
 * teacher's own — set, marked and approved within the section — and until now
 * the office could not see one: not to answer a parent, not to see which
 * section had nobody to approve its tests, not to chase marks never submitted.
 *
 * One SQL read: the list under the chosen tab, a count under every tab, and
 * the options of the filters.
 */
const pool = require('../db/pool');
const ClassTest = require('../models/ClassTest');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const Subject = require('../models/Subject');
const User = require('../models/User');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const { isUuid } = require('../db/schema');
const { TEST_LABELS } = require('./resultTeacher');

const t = (M) => `"${M.tableName}"`;
const T = { tests: t(ClassTest), sections: t(ClassSection), classes: t(Class), years: t(AcademicYear), subjects: t(Subject), users: t(User), sst: t(SectionSubjectTeacher) };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

/** The tabs: what a test is waiting for. */
const TABS = {
    all: null,
    waiting: `ct."status" = 'SUBMITTED'`,
    approved: `ct."status" = 'FINAL_APPROVED'`,
    open: `ct."status" IN ('DRAFT', 'REOPENED')`,
    rejected: `ct."status" = 'REJECTED'`,
};

async function list(schoolId, q = {}) {
    const params = [String(schoolId)];
    const $ = (v) => { params.push(v); return `$${params.length}`; };
    const w = ['ct."school" = $1::uuid'];
    const year = String(q.academicYear || '');
    if (isUuid(year)) w.push(`ct."academicYear" = ${$(year)}::uuid`);
    if (q.classNumber !== undefined && q.classNumber !== '' && Number.isFinite(Number(q.classNumber))) w.push(`c."classNumber" = ${$(Number(q.classNumber))}`);
    if (isUuid(String(q.sectionId || ''))) w.push(`ct."section" = ${$(String(q.sectionId))}::uuid`);
    if (isUuid(String(q.subject || ''))) w.push(`ct."subject" = ${$(String(q.subject))}::uuid`);
    const s = String(q.search || '').trim();
    if (s) {
        const like = $(`%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
        w.push(`(ct."title" ILIKE ${like} OR ct."topic" ILIKE ${like} OR u."name" ILIKE ${like} OR sub."subjectName" ILIKE ${like}
                 OR concat_ws(' ', c."className", sec."sectionName") ILIKE ${like})`);
    }
    const FROM = `
          FROM ${T.tests} ct
          LEFT JOIN ${T.sections} sec ON sec."_id" = ct."section"
          LEFT JOIN ${T.classes} c ON c."_id" = sec."class"
          LEFT JOIN ${T.years} y ON y."_id" = ct."academicYear"
          LEFT JOIN ${T.subjects} sub ON sub."_id" = ct."subject"
          LEFT JOIN ${T.users} u ON u."_id" = ct."createdBy"
          LEFT JOIN ${T.users} ap ON ap."_id" = ct."approvedBy"`;
    const tab = Object.prototype.hasOwnProperty.call(TABS, q.tab) ? q.tab : 'all';
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const base = w.join(' AND ');

    const [{ rows: counts }, { rows: [{ n: total }] }] = await Promise.all([
        pool.query(`SELECT ct."status", count(*)::int AS "n" ${FROM} WHERE ${base} GROUP BY 1`, params),
        pool.query(`SELECT count(*)::int AS "n" ${FROM} WHERE ${base}${TABS[tab] ? ` AND ${TABS[tab]}` : ''}`, params),
    ]);
    const pages = Math.max(1, Math.ceil(num(total) / limit));
    const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
    const { rows } = await pool.query(`
        SELECT ct."_id", ct."title", ct."topic", ct."testDate", ct."maxMarks", ct."passingMarks", ct."status", ct."rejectionReason",
               ct."classStats", ct."approvedAt", ct."updatedAt", ct."section" AS "sectionId",
               -- Approved once (and reopened since): on record, so never deleted.
               EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('ct."auditLog"')}) a WHERE a->>'action' IN ('APPROVED', 'OFFICE_APPROVED')) AS "everApproved",
               -- Who else teaches this subject here: whom the test can be handed to.
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('_id', tu."_id", 'name', tu."name") ORDER BY tu."name"), '[]'::jsonb)
                  FROM ${T.sst} st JOIN ${T.users} tu ON tu."_id" = st."teacher" AND tu."isActive" IS NOT FALSE
                 WHERE st."section" = ct."section" AND st."subject" = ct."subject" AND st."teacher" IS DISTINCT FROM ct."createdBy") AS "others",
               sec."sectionName", c."className", c."classNumber", y."yearName", sub."subjectName", u."name" AS "setBy", ap."name" AS "approvedByName",
               (sec."classTeacher" IS NOT NULL OR sec."substituteTeacher" IS NOT NULL) AS "hasValidator",
               (SELECT count(*)::int FROM jsonb_array_elements(${jarr('ct."marks"')}) m
                 WHERE (m->>'isAbsent') = 'true' OR (m->>'marksObtained') IS NOT NULL) AS "entered",
               (SELECT count(*)::int FROM ${T.users} st WHERE st."role" = 'student' AND st."isActive" IS NOT FALSE
                   AND st."_id"::text IN (SELECT v FROM jsonb_array_elements_text(${jarr('sec."enrolledStudents"')}) v)) AS "roll"
        ${FROM}
         WHERE ${base}${TABS[tab] ? ` AND ${TABS[tab]}` : ''}
         ORDER BY (ct."status" = 'SUBMITTED') DESC, ct."testDate" DESC, ct."createdAt" DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);

    const by = Object.fromEntries(counts.map((r) => [r.status, num(r.n)]));
    const sum = (...k) => k.reduce((n, x) => n + (by[x] || 0), 0);
    const [{ rows: years }, { rows: classes }, { rows: subjects }] = await Promise.all([
        pool.query(`SELECT "_id", "yearName", "status" FROM ${T.years} WHERE "school" = $1::uuid ORDER BY "startDate" DESC NULLS LAST`, [String(schoolId)]),
        pool.query(`SELECT c."classNumber", min(c."className") AS "className" FROM ${T.classes} c WHERE c."school" = $1::uuid AND c."classNumber" IS NOT NULL GROUP BY 1 ORDER BY 1`, [String(schoolId)]),
        pool.query(`SELECT DISTINCT ON (lower(sub."subjectName")) sub."_id", sub."subjectName" FROM ${T.tests} ct JOIN ${T.subjects} sub ON sub."_id" = ct."subject"
                     WHERE ct."school" = $1::uuid ORDER BY lower(sub."subjectName"), sub."_id"`, [String(schoolId)]),
    ]);
    return {
        data: rows.map((r) => {
            const stats = r.classStats || {};
            return {
                _id: r._id, title: r.title, topic: r.topic || '', testDate: r.testDate,
                maxMarks: num(r.maxMarks), passingMarks: num(r.passingMarks),
                status: r.status, statusLabel: TEST_LABELS[r.status] || r.status, rejectionReason: r.rejectionReason || '',
                className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '', sectionId: r.sectionId,
                subjectName: r.subjectName || 'Subject', setBy: r.setBy || '', approvedBy: r.approvedByName || '', approvedAt: r.approvedAt || null,
                entered: num(r.entered), roll: num(r.roll), hasValidator: !!r.hasValidator,
                average: stats.average ?? null, passPercent: stats.passPercent ?? null,
                others: Array.isArray(r.others) ? r.others : [],
                can: {
                    review: r.status === 'SUBMITTED',
                    // To another teacher of the subject here — a teacher who left, or is away.
                    handOver: Array.isArray(r.others) && r.others.length > 0,
                    // A test set by mistake, never approved.
                    delete: r.status !== 'FINAL_APPROVED' && !r.everApproved,
                },
            };
        }),
        page, pages, total: num(total), limit,
        tabs: { all: sum('DRAFT', 'SUBMITTED', 'FINAL_APPROVED', 'REJECTED', 'REOPENED'), waiting: sum('SUBMITTED'), approved: sum('FINAL_APPROVED'), open: sum('DRAFT', 'REOPENED'), rejected: sum('REJECTED') },
        filters: {
            years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })),
            classes: classes.map((c) => ({ classNumber: num(c.classNumber), className: c.className })),
            subjects: subjects.map((x) => ({ _id: x._id, subjectName: x.subjectName })),
        },
    };
}

module.exports = { list, TABS };
