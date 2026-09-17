'use strict';
/**
 * Student attendance corrections — the pieces the student, parent and teacher
 * sides share: who reviews a register, and how a request is shown to the
 * student it belongs to (and their parents).
 */
const ClassSection          = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');
const { lowStatus }         = require('./studentAttendance');

const low = (s) => (s == null ? null : String(s).toLowerCase());

/**
 * Everyone who reviews a register's corrections: the class and vice class
 * teacher, and for a subject register that subject's teachers in the section.
 */
async function reviewersOf(sectionId, subjectId) {
    const section = await ClassSection.findById(sectionId).select('classTeacher substituteTeacher').lean();
    const ids = [section?.classTeacher, section?.substituteTeacher].filter(Boolean).map(String);
    if (subjectId) {
        const links = await SectionSubjectTeacher.find({ section: sectionId, subject: subjectId }).select('teacher').lean();
        links.forEach((l) => ids.push(String(l.teacher)));
    }
    return [...new Set(ids)];
}

/** A correction as its student (or their parent) sees it: the register, the trail, the files. */
async function forStudent(rows) {
    const subjectIds = [...new Set(rows.map((r) => r.subject).filter(Boolean).map(String))];
    const names = subjectIds.length
        ? new Map((await Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean()).map((x) => [String(x._id), x.subjectName]))
        : new Map();
    return rows.map((r) => {
        const history = Array.isArray(r.history) ? r.history : [];
        const last = history[history.length - 1];
        return {
            _id: r._id,
            date: r.date,
            subject: r.subject ? { _id: r.subject, name: names.get(String(r.subject)) || 'Subject' } : null,
            currentStatus: low(r.currentStatus) === 'not marked' ? 'unmarked' : lowStatus(r.currentStatus),
            requestedStatus: lowStatus(r.requestedStatus),
            reason: r.reason,
            status: low(r.status),
            source: r.source || 'student',
            teacherRemarks: r.teacherRemarks || '',
            attachments: Array.isArray(r.attachments) ? r.attachments : [],
            // Who asked what, not internal ids.
            history: history.map((h) => ({ event: h.event, at: h.at, byName: h.byName, role: h.role, message: h.message || '', attachments: h.attachments || [] })),
            awaitingReply: low(r.status) === 'pending' && last?.event === 'info_requested',
            createdAt: r.createdAt,
            updatedAt: r.updatedAt || r.reviewedAt || null,
            reviewedAt: r.reviewedAt,
        };
    });
}

module.exports = { reviewersOf, forStudent };
