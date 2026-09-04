'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  What one student's dashboard is made of.
//
//  A student sees these figures about themselves and a parent sees them about
//  their child, so they live here rather than in either controller — the same
//  numbers, computed once, with the publish and visibility rules in one place.
//
//  Every function returns null (or an empty array) when there is nothing to
//  report. That is deliberately distinct from zero: "the section marked no
//  attendance this month" and "the student attended none of it" are different
//  answers, and a dashboard that conflates them lies to a parent.
//
//  Attendance sessions are stored at UTC midnight of the LOCAL calendar day
//  they belong to (see attendance.controller — every write is
//  `new Date(dateStr + 'T00:00:00.000Z')`), so every window here is built and
//  compared in UTC.
// ─────────────────────────────────────────────────────────────────────────────
const Attendance       = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const AptitudeExam     = require('../models/AptitudeExam');
const FormalExam       = require('../models/FormalExam');
const FormalResult     = require('../models/FormalResult');

/** Late still counts as attended — the same rule the section reports use. */
const ATTENDED = ['Present', 'Late'];

const tally = (records) => {
    const present = records.filter((r) => ATTENDED.includes(r.status)).length;
    return {
        total:      records.length,
        present,
        absent:     records.length - present,
        percentage: records.length ? Math.round((present / records.length) * 100) : 0,
    };
};

/**
 * This student's attendance records for a section between two UTC instants,
 * as `[{ date, status }]` ordered oldest first.
 */
async function recordsBetween(sectionId, studentId, from, to) {
    const sessions = await Attendance.find({
        section: sectionId, date: { $gte: from, $lt: to },
    }).select('_id date').lean();
    if (!sessions.length) return [];

    const dateBySession = new Map(sessions.map((s) => [String(s._id), s.date]));
    const records = await AttendanceRecord.find({
        attendance: { $in: sessions.map((s) => s._id) }, student: studentId,
    }).select('attendance status').lean();

    return records
        .map((r) => ({ date: dateBySession.get(String(r.attendance)), status: r.status }))
        .filter((r) => r.date)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** One calendar month, or null when nothing was marked for this student in it. */
async function monthAttendance(sectionId, studentId, year, month) {
    if (!sectionId) return null;
    const records = await recordsBetween(
        sectionId, studentId,
        new Date(Date.UTC(year, month, 1)),
        new Date(Date.UTC(year, month + 1, 1)),
    );
    return records.length ? tally(records) : null;
}

/**
 * Attendance bucketed into weeks, newest last.
 *
 * Weekly rather than daily because a single student is present or absent on a
 * given day — a daily line is a square wave between 0% and 100% and says
 * nothing. A week is the smallest window in which "how are they doing" has an
 * answer. Weeks nobody marked are returned with `marked: false` so the chart
 * can leave a gap instead of drawing a drop to zero.
 */
async function attendanceWeeks(sectionId, studentId, weeks = 8) {
    if (!sectionId) return [];

    // Monday of the current week, in UTC, from the local calendar date.
    const n = new Date();
    const today = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
    const dow = (today.getUTCDay() + 6) % 7;               // Mon = 0
    const thisMonday = new Date(today);
    thisMonday.setUTCDate(today.getUTCDate() - dow);

    const from = new Date(thisMonday);
    from.setUTCDate(thisMonday.getUTCDate() - 7 * (weeks - 1));
    const to = new Date(thisMonday);
    to.setUTCDate(thisMonday.getUTCDate() + 7);

    const records = await recordsBetween(sectionId, studentId, from, to);

    const buckets = [];
    for (let i = 0; i < weeks; i += 1) {
        const start = new Date(from);
        start.setUTCDate(from.getUTCDate() + 7 * i);
        const end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 7);

        const inWeek = records.filter((r) => {
            const d = new Date(r.date);
            return d >= start && d < end;
        });
        buckets.push({
            weekStart: start.toISOString().slice(0, 10),
            ...tally(inWeek),
            marked: inWeek.length > 0,
        });
    }
    return buckets;
}

/** Published aptitude exams still ahead of this student's section. */
async function upcomingExams(schoolId, sectionId, limit = 3) {
    if (!sectionId) return [];
    return AptitudeExam.find({
        school: schoolId, section: sectionId,
        status: 'published', examDate: { $gte: new Date(Date.now() - 86400000) },
    }).select('title examDate startTime duration').sort({ examDate: 1 }).limit(limit).lean()
        .catch(() => []);
}

/**
 * Published formal results, oldest first, plus the subject breakdown of the
 * most recent one.
 *
 * Only FINAL_APPROVED exams past their publish date are readable — the same two
 * conditions studentGetResults enforces, kept here so no dashboard can show a
 * mark the results page would still be hiding.
 */
async function performance(schoolId, sectionId, studentId) {
    if (!sectionId) return null;

    const exams = await FormalExam.find({
        section: sectionId, school: schoolId, status: 'FINAL_APPROVED',
    }).select('title examType startDate publishDate').lean();
    if (!exams.length) return null;

    const byId    = new Map(exams.map((e) => [String(e._id), e]));
    const results = await FormalResult.find({
        student: studentId, exam: { $in: exams.map((e) => e._id) },
    }).populate('subjects.subject', 'subjectName').lean();

    const now = new Date();
    const rows = results
        .map((r) => ({ r, e: byId.get(String(r.exam)) }))
        .filter(({ e }) => e && (!e.publishDate || now >= new Date(e.publishDate)))
        .sort((a, b) => new Date(a.e.startDate) - new Date(b.e.startDate));
    if (!rows.length) return null;

    const trend = rows.map(({ r, e }) => ({
        examId:     r.exam,
        title:      e.title,
        examType:   e.examType,
        date:       e.startDate,
        percentage: Math.round(r.percentage || 0),
        grade:      r.grade || '',
    }));

    const last = rows[rows.length - 1];
    const subjects = (last.r.subjects || [])
        .filter((sub) => !sub.isAbsent && sub.maxMarks > 0)
        .map((sub) => ({
            name:          sub.subject?.subjectName || 'Subject',
            marksObtained: sub.marksObtained,
            maxMarks:      sub.maxMarks,
            percentage:    Math.round((sub.marksObtained / sub.maxMarks) * 100),
            grade:         sub.grade || '',
            isPassed:      !!sub.isPassed,
        }))
        .sort((a, b) => b.percentage - a.percentage);

    return {
        trend,
        subjects,
        latest: {
            title:      last.e.title,
            percentage: Math.round(last.r.percentage || 0),
            grade:      last.r.grade || '',
            rank:       last.r.rank || 0,
            resultId:   last.r._id,
        },
    };
}

/**
 * Everything one dashboard needs about one student, gathered in parallel.
 * Each piece degrades to null/[] on its own so a single failure cannot take
 * the screen down with it.
 */
async function studentSnapshot({ schoolId, sectionId, studentId }) {
    const now = new Date();
    const [month, prev, weeks, exams, marks] = await Promise.all([
        monthAttendance(sectionId, studentId, now.getFullYear(), now.getMonth()).catch(() => null),
        monthAttendance(sectionId, studentId, now.getFullYear(), now.getMonth() - 1).catch(() => null),
        attendanceWeeks(sectionId, studentId).catch(() => []),
        upcomingExams(schoolId, sectionId).catch(() => []),
        performance(schoolId, sectionId, studentId).catch(() => null),
    ]);
    return { attendance: month, attendancePrev: prev, attendanceWeeks: weeks, upcomingExams: exams, performance: marks };
}

module.exports = {
    monthAttendance, attendanceWeeks, upcomingExams, performance, studentSnapshot,
};
