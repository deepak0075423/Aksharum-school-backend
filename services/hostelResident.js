'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Who may live in the hostel, and in which bed.
//
//  A resident is a student or a member of staff. The hostel tables keep calling
//  the column `student` — every query, index and report already reads it — and
//  three small facts sit beside it:
//
//    HostelBed.occupantType         student | teacher | both   who the bed is for
//    HostelAllocation.residentType  student | teacher          who holds it
//    HostelFeePlan.appliesTo        student | teacher | both   whose bills it makes
//
//  All three were added to live tables, so rows older than them carry NULL.
//  NULL always means 'student' — that is what every such row was — and nothing
//  outside this file should compare the raw column.
//
//  The kind of a PERSON is always read from their account, never from a flag a
//  request sent: a teacher's id posted as a student is still a teacher.
// ─────────────────────────────────────────────────────────────────────────────
const User             = require('../models/User');
const StudentProfile   = require('../models/StudentProfile');
const TeacherProfile   = require('../models/TeacherProfile');
const HostelAllocation = require('../models/HostelAllocation');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');

const OCCUPANT_TYPES = ['student', 'teacher', 'both'];
const KIND_LABEL = { student: 'student', teacher: 'teacher' };

/** 'student' | 'teacher' | 'both' — with NULL and anything unknown as 'student'. */
const occupantOf = (row) => (['teacher', 'both'].includes(row?.occupantType) ? row.occupantType : 'student');
/** A plan's audience, same rule. */
const planAudience = (plan) => (['teacher', 'both'].includes(plan?.appliesTo) ? plan.appliesTo : 'student');
/** 'student' | 'teacher' for an allocation or invoice row. */
const residentKind = (row) => (row?.residentType === 'teacher' ? 'teacher' : 'student');
/** May a resident of `kind` be given this bed? */
const bedFits = (bed, kind) => { const o = occupantOf(bed); return o === 'both' || o === kind; };
/** Does this plan bill a resident of `kind`? */
const planCovers = (plan, kind) => { const a = planAudience(plan); return a === 'both' || a === kind; };
/** A value posted by a form, or null when it is not one of the three. */
const cleanOccupant = (v) => (OCCUPANT_TYPES.includes(v) ? v : null);

/**
 * The account behind a resident id: the user, which kind they are, and the
 * gender on their profile (students and staff keep it in different tables).
 * Null when the id is not a student or teacher of this school.
 */
async function residentAccount(schoolId, userId) {
    if (!userId) return null;
    const user = await User.findOne({ _id: userId, school: schoolId, role: { $in: ['student', 'teacher'] } }).lean();
    if (!user) return null;
    const kind = user.role === 'teacher' ? 'teacher' : 'student';
    const profile = kind === 'teacher'
        ? await TeacherProfile.findOne({ user: userId }).select('gender employeeId designation department').lean()
        : await StudentProfile.findOne({ user: userId, school: schoolId }).select('gender').lean();
    return { user, kind, profile: profile || null };
}

/** The kind of each account in `ids`, in one query: { [id]: 'student' | 'teacher' }. */
async function kindsOf(schoolId, ids) {
    const want = [...new Set((ids || []).filter(Boolean).map(String))];
    if (!want.length) return {};
    const rows = await User.find({ _id: { $in: want }, school: schoolId }).select('role').lean();
    return Object.fromEntries(rows.map((u) => [String(u._id), u.role === 'teacher' ? 'teacher' : 'student']));
}

/**
 * Whether a member of staff has any reason to open "My Hostel": a bed that is
 * theirs or being held for them, or a hostel bill in their name (someone who
 * has moved out may still owe, or want a receipt).
 */
async function staffHasHostel(schoolId, userId) {
    const [bed, bill] = await Promise.all([
        HostelAllocation.exists({ school: schoolId, student: userId, status: { $in: ['pending', 'active'] } }),
        HostelFeeInvoice.exists({ school: schoolId, student: userId }),
    ]);
    return !!(bed || bill);
}

module.exports = {
    OCCUPANT_TYPES, KIND_LABEL, occupantOf, planAudience, residentKind, bedFits, planCovers, cleanOccupant,
    residentAccount, kindsOf, staffHasHostel,
};
