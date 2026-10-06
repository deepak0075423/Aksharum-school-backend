'use strict';
/**
 * The Medical Room in Student Analytics (Oct 2026): how often a student has
 * been to the room this academic year, against the school's average — a child
 * who keeps coming back is worth a conversation. Counts, months and the
 * reasons only; never the notes. Built only for a reader who is medical staff
 * (the school admin, or a nurse): a teacher opening the same analytics page
 * gets no Medical Room tab. Each opening is recorded in the medical audit.
 */
const pool = require('../db/pool');
const R = require('./medicalRules');

const S = (v) => String(v);

async function isStaff(req) {
    if (req.userRole === 'school_admin') return true;
    try { return (await require('./medicalNotify').staffIds(req.schoolId)).includes(S(req.userId)); } catch { return false; }
}

async function blockFor(req, studentId, activeYear) {
    const from = activeYear?.startDate ? new Date(activeYear.startDate) : new Date(Date.now() - 365 * 86400000);
    const to = activeYear?.endDate ? new Date(new Date(activeYear.endDate).getTime() + 86400000) : new Date();
    const p = [S(req.schoolId), S(studentId), from, to];
    const [[sum], byMonth, reasons, [avg]] = await Promise.all([
        pool.query(`SELECT count(*)::int AS visits,
                           count(*) FILTER (WHERE "status" = 'sent_home')::int AS "sentHome",
                           count(*) FILTER (WHERE "status" = 'referred')::int AS referred,
                           max("arrivedAt") AS "lastVisitAt",
                           (SELECT count(*)::int FROM "medicalincidents" i WHERE i."school" = $1 AND i."student" = $2 AND i."archivedAt" IS NULL AND i."occurredAt" >= $3 AND i."occurredAt" < $4) AS incidents
                      FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "arrivedAt" >= $3 AND "arrivedAt" < $4`, p).then((r) => r.rows),
        pool.query(`SELECT to_char(("arrivedAt" AT TIME ZONE '${R.ZONE}'), 'YYYY-MM') AS month, count(*)::int AS visits
                      FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "arrivedAt" >= $3 AND "arrivedAt" < $4
                     GROUP BY 1 ORDER BY 1`, p).then((r) => r.rows),
        pool.query(`SELECT "reason", count(*)::int AS n FROM "medicalvisits"
                     WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "arrivedAt" >= $3 AND "arrivedAt" < $4
                     GROUP BY "reason" ORDER BY n DESC, "reason" LIMIT 6`, p).then((r) => r.rows),
        pool.query(`SELECT (SELECT count(*) FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "arrivedAt" >= $2 AND "arrivedAt" < $3)::float8
                           / NULLIF((SELECT count(*) FROM "users" WHERE "school" = $1 AND "role" = 'student' AND "isActive" IS NOT FALSE), 0) AS average`,
        [S(req.schoolId), from, to]).then((r) => r.rows),
    ]);
    require('./medicalAudit').viewed(req, { entity: 'analytics', student: studentId, summary: 'Saw the Medical Room figures in Student Analytics' });
    const average = avg?.average ? Math.round(avg.average * 10) / 10 : 0;
    return {
        summary: { ...sum, schoolAverage: average, aboveAverage: average > 0 && sum.visits >= Math.max(3, average * 3) },
        byMonth, reasons,
        link: `/admin/medical/students/${studentId}`,
    };
}

module.exports = { isStaff, blockFor };
