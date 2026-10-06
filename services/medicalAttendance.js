'use strict';
/**
 * The Medical Room and the attendance register (Oct 2026).
 *
 *   Sent home       When the school asks for it (settings.attendanceOnSentHome
 *                   = 'half_day'), a child sent home — or taken to hospital —
 *                   who was marked present on today's register becomes
 *                   Half-Day, with the reason as the remark. A correction the
 *                   same day (the visit moved back) puts the mark back, unless
 *                   someone has changed it since. Only a day register is
 *                   touched: a school that takes attendance per subject keeps
 *                   its registers as the teachers mark them. A child not yet
 *                   marked is left for the teacher.
 *   Off sick        A family's "unwell" report tells the class teachers (that
 *                   the child is away, never why) and, when today's mark is
 *                   already on the register, notes it as the remark.
 *
 * Every mark goes through the one register writer (services/attendanceMarks),
 * so the register, its notices and its history stay one thing.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const MedicalVisit = require('../models/MedicalVisit');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const R = require('./medicalRules');

const S = (v) => String(v);
const LEFT = ['sent_home', 'referred'];
const hhmm = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: R.ZONE });

/** Today's mark on a section's day register, or null. */
async function dayMark(sectionId, date, studentId) {
    const { rows } = await pool.query(
        `SELECT r."status", r."remarks" FROM "attendancerecords" r JOIN "attendances" a ON a."_id" = r."attendance"
          WHERE a."section" = $1 AND a."date" = $2 AND a."subject" IS NULL AND r."student" = $3 LIMIT 1`,
        // The register's day is stored as UTC midnight (services/attendanceMarks) — compared as that instant,
        // never through the session's time zone.
        [S(sectionId), new Date(`${date}T00:00:00.000Z`), S(studentId)]);
    return rows[0] || null;
}

const actorOf = (req) => ({ userId: S(req.userId), role: req.userRole, name: req.user?.name || 'Medical Room' });

async function afterStatus(req, visit, from) {
    const to = visit.status;
    const leaving = LEFT.includes(to) && !LEFT.includes(from || '') && !['returned', 'closed'].includes(from || '');
    const backAgain = LEFT.includes(from || '') && !LEFT.includes(to) && to !== 'closed';
    if (!leaving && !backAgain) return null;
    const s = await settingsSvc.get(req.schoolId);
    const { registrationMode } = require('./studentAttendance');
    const { saveSectionMarks } = require('./attendanceMarks');
    if (leaving) {
        if (s.attendanceOnSentHome !== 'half_day') return null;
        if ((await registrationMode(req.schoolId)) !== 'day') return { skipped: 'subject registers' };
        const card = await access.studentCard(req.schoolId, visit.student);
        if (!card?.sectionId) return { skipped: 'no section' };
        const date = R.todayStr();
        const mark = await dayMark(card.sectionId, date, visit.student);
        if (!mark || !['Present', 'Late'].includes(mark.status)) return { skipped: 'not marked present yet' };
        const remark = `${to === 'referred' ? 'Taken to hospital' : 'Sent home'} from the Medical Room at ${hhmm(visit.departedAt || new Date())} (${visit.number})`;
        await saveSectionMarks({
            schoolId: S(req.schoolId), sectionId: card.sectionId, date, actor: actorOf(req), note: remark,
            records: [{ studentId: S(visit.student), status: 'Half-Day', remarks: remark }],
        });
        await patch(MedicalVisit, visit._id, { attendanceMark: { date, section: card.sectionId, was: mark.status, wasRemarks: mark.remarks || '', set: 'Half-Day', at: new Date() } }, { touch: false });
        require('./medicalAudit').log(req, { action: 'attendance_marked', entity: 'visit', entityId: visit._id, student: visit.student, summary: `${card.name}: today's attendance ${mark.status} → Half-Day (${remark})` });
        return { marked: 'Half-Day' };
    }
    // Moved back the same day: undo what the room did, if nobody has changed it since.
    const m = visit.attendanceMark;
    if (!m || m.date !== R.todayStr()) return null;
    const now = await dayMark(m.section, m.date, visit.student);
    if (!now || now.status !== m.set) return { skipped: 'changed since' };
    await saveSectionMarks({
        schoolId: S(req.schoolId), sectionId: m.section, date: m.date, actor: actorOf(req), note: 'The Medical Room corrected the visit',
        records: [{ studentId: S(visit.student), status: m.was, remarks: m.wasRemarks || '' }],
    });
    await patch(MedicalVisit, visit._id, { attendanceMark: null }, { touch: false });
    require('./medicalAudit').log(req, { action: 'attendance_restored', entity: 'visit', entityId: visit._id, student: visit.student, summary: `Today's attendance put back to ${m.was} — the visit was corrected` });
    return { restored: m.was };
}

/** A family's "unwell" report: the class teachers hear the child is away; today's mark carries the remark. */
async function onIllnessReport(req, report) {
    const card = await access.studentCard(req.schoolId, report.student);
    if (!card?.sectionId) return;
    const { rows } = await pool.query(`SELECT "classTeacher"::text AS a, "substituteTeacher"::text AS b FROM "classsections" WHERE "_id" = $1`, [card.sectionId]);
    const to = [rows[0]?.a, rows[0]?.b].filter(Boolean);
    const from = R.dayStr(report.from); const back = report.to ? R.dayStr(report.to) : '';
    if (to.length) {
        require('./medicalNotify').send(req, {
            to, title: `Off sick — ${card.name}`,
            body: `${card.name}'s family says ${card.name.split(' ')[0]} is unwell and away from ${R.dayLabel(from)}${back ? ` until ${R.dayLabel(back)}` : ''}.`,
            link: { type: 'medical.mine' },
        });
    }
    // Only today's register, only a mark already made — a remark never decides a mark.
    const today = R.todayStr();
    if (from > today || (back && back < today)) return;
    if ((await require('./studentAttendance').registrationMode(req.schoolId)) !== 'day') return;
    const mark = await dayMark(card.sectionId, today, report.student);
    if (!mark || mark.remarks) return;
    await require('./attendanceMarks').saveSectionMarks({
        schoolId: S(req.schoolId), sectionId: card.sectionId, date: today, actor: actorOf(req),
        records: [{ studentId: S(report.student), status: mark.status, remarks: 'Unwell — told by the family' }],
    });
}

module.exports = { afterStatus, onIllnessReport, dayMark };
