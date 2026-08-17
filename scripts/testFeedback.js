'use strict';
/**
 * Feedback module — end-to-end business-rule tests.
 *
 *   node scripts/testFeedback.js
 *
 * Builds a throwaway school (year → class → section → students, subjects,
 * teachers, subject–teacher links), mounts the real auth + feedback routers on
 * an ephemeral port, drives the whole workflow over HTTP as each role, then
 * deletes everything it created.
 *
 * No test framework needed — the repo has none, and adding one for this would
 * be a bigger change than the tests themselves.
 */
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const connectDB = require('../config/db');

const School = require('../models/School');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Class = require('../models/Class');
const ClassSection = require('../models/ClassSection');
const Subject = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');

const FeedbackCampaign = require('../models/FeedbackCampaign');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const FeedbackCategory = require('../models/FeedbackCategory');
const FeedbackQuestion = require('../models/FeedbackQuestion');
const FeedbackQuestionOption = require('../models/FeedbackQuestionOption');
const FeedbackAssignment = require('../models/FeedbackAssignment');
const FeedbackResponse = require('../models/FeedbackResponse');
const FeedbackSelectedOption = require('../models/FeedbackSelectedOption');
const FeedbackTemplate = require('../models/FeedbackTemplate');
const FeedbackSettings = require('../models/FeedbackSettings');
const FeedbackAuditLog = require('../models/FeedbackAuditLog');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const results = [];

function check(name, condition, detail = '') {
    if (condition) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { results.push(`\n▸ ${title}`); }

const TAG = `fbtest_${Date.now()}`;
const ids = { users: [], subjects: [], links: [] };
let BASE = '';

const sid = (v) => String(v?._id ?? v);
const token = (user) => jwt.sign(
    { userId: sid(user), role: user.role, schoolId: sid(user.school) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
);

async function call(method, path, { as, body, raw } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(as ? { Authorization: `Bearer ${token(as)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON (binary export) */ }
    return { status: res.status, body: json, data: json?.data };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const PUT = (p, o) => call('PUT', p, o);
const DEL = (p, o) => call('DELETE', p, o);

// ── fixture ──────────────────────────────────────────────────────────────────
async function makeUser(name, role, schoolId, extra = {}) {
    const u = await User.create({
        name,
        email: `${TAG}_${name.toLowerCase().replace(/\s+/g, '')}@example.test`,
        password: await bcrypt.hash('Passw0rd123', 4),
        role,
        school: schoolId,
        isFirstLogin: false,      // otherwise requirePasswordReset blocks every call
        isActive: true,
        ...extra,
    });
    ids.users.push(sid(u._id));
    return { ...u.toObject?.() ?? u, _id: u._id, role, school: schoolId };
}

async function buildFixture() {
    const school = await School.create({
        name: `${TAG} High School`,
        board: 'CBSE',
        modules: { feedback: true },
    });
    const schoolId = sid(school._id);

    const year = await AcademicYear.create({
        school: schoolId, yearName: `${TAG}-2026`, status: 'active',
        startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'),
    });
    const klass = await Class.create({
        school: schoolId, academicYear: sid(year._id), classNumber: 8, className: 'Class 8',
    });

    const students = [];
    for (let i = 1; i <= 7; i += 1) students.push(await makeUser(`Student${TAG}${i}`, 'student', schoolId));
    const outsider = await makeUser(`Outsider${TAG}`, 'student', schoolId);

    const section = await ClassSection.create({
        school: schoolId, class: sid(klass._id), academicYear: sid(year._id),
        sectionName: 'A', maxStudents: 40, status: 'active',
        enrolledStudents: students.map((s) => sid(s._id)),
    });

    const maths = await Subject.create({ school: schoolId, subjectName: `Maths ${TAG}` });
    const science = await Subject.create({ school: schoolId, subjectName: `Science ${TAG}` });
    ids.subjects.push(sid(maths._id), sid(science._id));

    const tMaths = await makeUser(`TeacherMaths${TAG}`, 'teacher', schoolId);
    const tScience = await makeUser(`TeacherScience${TAG}`, 'teacher', schoolId);
    const tStranger = await makeUser(`TeacherStranger${TAG}`, 'teacher', schoolId);
    const principal = await makeUser(`Principal${TAG}`, 'teacher', schoolId);
    const admin = await makeUser(`Admin${TAG}`, 'school_admin', schoolId);

    await TeacherProfile.create({ user: sid(principal._id), school: schoolId, designation: 'Principal', department: 'Administration' });
    await TeacherProfile.create({ user: sid(tMaths._id), school: schoolId, designation: 'Teacher', department: 'Mathematics' });
    await TeacherProfile.create({ user: sid(tScience._id), school: schoolId, designation: 'Teacher', department: 'Science' });
    await TeacherProfile.create({ user: sid(tStranger._id), school: schoolId, designation: 'Teacher', department: 'Arts' });

    for (const s of students) {
        await StudentProfile.create({
            user: sid(s._id), school: schoolId,
            currentClass: sid(klass._id), currentSection: sid(section._id),
        });
    }
    await StudentProfile.create({ user: sid(outsider._id), school: schoolId });

    const l1 = await SectionSubjectTeacher.create({ section: sid(section._id), subject: sid(maths._id), teacher: sid(tMaths._id) });
    const l2 = await SectionSubjectTeacher.create({ section: sid(section._id), subject: sid(science._id), teacher: sid(tScience._id) });
    ids.links.push(sid(l1._id), sid(l2._id));

    // A second school, to prove cross-school isolation.
    const otherSchool = await School.create({ name: `${TAG} Other School`, board: 'CBSE', modules: { feedback: true } });
    const otherAdmin = await makeUser(`OtherAdmin${TAG}`, 'school_admin', sid(otherSchool._id));

    // A school with the module switched OFF.
    const offSchool = await School.create({ name: `${TAG} Off School`, board: 'CBSE', modules: { feedback: false } });
    const offAdmin = await makeUser(`OffAdmin${TAG}`, 'school_admin', sid(offSchool._id));

    return {
        school, schoolId, year, klass, section, maths, science,
        students, outsider, tMaths, tScience, tStranger, principal, admin,
        otherSchool, otherAdmin, offSchool, offAdmin,
    };
}

async function cleanup(f) {
    const schoolIds = [f.schoolId, sid(f.otherSchool._id), sid(f.offSchool._id)];
    const campaigns = await FeedbackCampaign.find({ school: { $in: schoolIds } }).select('_id').lean();
    const campaignIds = campaigns.map((c) => sid(c._id));

    if (campaignIds.length) {
        await FeedbackSelectedOption.deleteMany({ campaign: { $in: campaignIds } });
        await FeedbackResponse.deleteMany({ campaign: { $in: campaignIds } });
        await FeedbackAssignment.deleteMany({ campaign: { $in: campaignIds } });
        await FeedbackCampaignQuestion.deleteMany({ campaign: { $in: campaignIds } });
    }
    for (const s of schoolIds) {
        await FeedbackCampaign.deleteMany({ school: s });
        await FeedbackAuditLog.deleteMany({ school: s });
        await FeedbackTemplate.deleteMany({ school: s });
        await FeedbackSettings.deleteMany({ school: s });
        const qs = await FeedbackQuestion.find({ school: s }).select('_id').lean();
        if (qs.length) await FeedbackQuestionOption.deleteMany({ question: { $in: qs.map((q) => sid(q._id)) } });
        await FeedbackQuestion.deleteMany({ school: s });
        await FeedbackCategory.deleteMany({ school: s });
        await StudentProfile.deleteMany({ school: s });
        await TeacherProfile.deleteMany({ school: s });
    }
    for (const id of ids.links) await SectionSubjectTeacher.deleteMany({ _id: id });
    await ClassSection.deleteMany({ _id: sid(f.section._id) });
    for (const id of ids.subjects) await Subject.deleteMany({ _id: id });
    await Class.deleteMany({ _id: sid(f.klass._id) });
    await AcademicYear.deleteMany({ _id: sid(f.year._id) });
    for (const id of ids.users) await User.deleteMany({ _id: id });
    for (const s of schoolIds) await School.deleteMany({ _id: s });
}

// ── the run ──────────────────────────────────────────────────────────────────
(async () => {
    await connectDB();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/auth', require('../routes/api/auth'));
    app.use('/api/feedback', require('../routes/api/feedback'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api`;

    let f;
    try {
        f = await buildFixture();
        const { admin, principal, tMaths, tScience, tStranger, students, outsider } = f;

        // ══ SETUP ════════════════════════════════════════════════════════════
        section('Setup: seeding, categories & question bank');

        const seeded = await POST('/feedback/settings/seed', { as: admin });
        check('Admin can seed the default configuration', seeded.status === 200 && seeded.data.categories === 8,
            `status ${seeded.status}, categories ${seeded.data?.categories}`);

        const reseed = await POST('/feedback/settings/seed', { as: admin });
        check('Seeding is idempotent (second run adds nothing)',
            reseed.status === 200 && reseed.data.categories === 0 && reseed.data.questions === 0);

        const cats = await GET('/feedback/categories', { as: admin });
        check('Default categories are created', cats.status === 200 && cats.data.length >= 8);

        const qs = await GET('/feedback/questions?limit=100', { as: admin });
        check('Default question bank is created (14 rating + 3 qualitative)',
            qs.status === 200 && qs.data.data.length === 17, `got ${qs.data?.data?.length}`);
        check('Choice questions carry their options',
            (qs.data.data.find((q) => q.questionType === 'checkbox')?.options || []).length === 9);

        const tpls = await GET('/feedback/templates', { as: admin });
        check('A default template is created', tpls.status === 200 && tpls.data.some((t) => t.isDefault));
        const templateId = tpls.data.find((t) => t.isDefault)._id;

        // ══ MODULE FLAG + RBAC ═══════════════════════════════════════════════
        section('Module flag & role-based access control');

        const off = await GET('/feedback/dashboard', { as: f.offAdmin });
        check('Module flag off → 403 MODULE_DISABLED',
            off.status === 403 && off.body.code === 'MODULE_DISABLED', `status ${off.status}`);

        const noAuth = await GET('/feedback/dashboard');
        check('No token → 401', noAuth.status === 401);

        const studentOnAdmin = await GET('/feedback/campaigns', { as: students[0] });
        check('Student cannot list campaigns (admin surface)', studentOnAdmin.status === 403);

        const teacherOnAdmin = await GET('/feedback/campaigns', { as: tMaths });
        check('Teacher cannot list campaigns (admin surface)', teacherOnAdmin.status === 403);

        const teacherOnDash = await GET('/feedback/dashboard', { as: tMaths });
        check('Plain teacher cannot reach the school-wide dashboard', teacherOnDash.status === 403);

        const principalOnDash = await GET('/feedback/dashboard', { as: principal });
        check('Principal CAN reach the school-wide dashboard', principalOnDash.status === 200,
            `status ${principalOnDash.status}`);

        const principalWrite = await POST('/feedback/settings/seed', { as: principal });
        check('Principal cannot write configuration (read-only)', principalWrite.status === 403);

        const studentOnTeacher = await GET('/feedback/teacher/dashboard', { as: students[0] });
        check('Student cannot reach the teacher dashboard', studentOnTeacher.status === 403);

        // ══ CAMPAIGN LIFECYCLE ═══════════════════════════════════════════════
        section('Campaign creation & validation');

        const noName = await POST('/feedback/campaigns', { as: admin, body: { startDate: '2026-08-01', endDate: '2026-08-20', template: templateId } });
        check('Campaign without a name is rejected', noName.status === 400);

        const badDates = await POST('/feedback/campaigns', {
            as: admin,
            body: { name: 'Bad dates', startDate: '2026-08-20', endDate: '2026-08-01', template: templateId },
        });
        check('End date before start date is rejected', badDates.status === 400);

        const parentType = await POST('/feedback/campaigns', {
            as: admin,
            body: { name: 'Parent feedback', feedbackType: 'parent_teacher', startDate: '2026-08-01', endDate: '2026-08-20', template: templateId },
        });
        check('Parent → Teacher type is refused until implemented', parentType.status === 400);

        const today = new Date();
        const iso = (d) => d.toISOString().slice(0, 10);
        const created = await POST('/feedback/campaigns', {
            as: admin,
            body: {
                name: `${TAG} Term 1 Feedback`, term: 'Term 1',
                startDate: iso(new Date(today.getTime() - 86400000)),
                endDate: iso(new Date(today.getTime() + 7 * 86400000)),
                isAnonymous: true, minimumResponses: 5, template: templateId,
            },
        });
        check('Campaign is created as a draft', created.status === 200 && created.data.status === 'draft');
        const campaignId = created.data._id;

        const detail = await GET(`/feedback/campaigns/${campaignId}`, { as: admin });
        check('Questionnaire is snapshotted onto the campaign', detail.data.questions.length === 17,
            `got ${detail.data?.questions?.length}`);

        const crossSchool = await GET(`/feedback/campaigns/${campaignId}`, { as: f.otherAdmin });
        check('Another school\'s admin cannot read the campaign', crossSchool.status === 404);

        // ── assignment generation ────────────────────────────────────────────
        section('Automatic assignment generation');

        const activated = await POST(`/feedback/campaigns/${campaignId}/activate`, { as: admin });
        check('Campaign activates', activated.status === 200 && activated.data.status === 'active',
            `status ${activated.status} ${activated.body?.message || ''}`);
        check('7 students × 2 teachers = 14 assignments generated', activated.data.created === 14,
            `got ${activated.data?.created}`);

        const resync = await POST(`/feedback/campaigns/${campaignId}/sync`, { as: admin });
        check('Re-syncing creates no duplicates', resync.data.created === 0, `got ${resync.data?.created}`);

        const strangerRows = await FeedbackAssignment.countDocuments({ campaign: campaignId, teacher: sid(tStranger._id) });
        check('A teacher who teaches nobody gets no assignments', strangerRows === 0);

        const outsiderRows = await FeedbackAssignment.countDocuments({ campaign: campaignId, student: sid(outsider._id) });
        check('A student in no section gets no assignments', outsiderRows === 0);

        // ══ STUDENT WORKFLOW ═════════════════════════════════════════════════
        section('Student workflow');

        const pending = await GET('/feedback/student/pending', { as: students[0] });
        check('Student sees exactly their two assigned teachers', pending.status === 200 && pending.data.length === 2,
            `got ${pending.data?.length}`);
        const teacherNames = pending.data.map((r) => r.teacher.name);
        check('Student sees the teachers who actually teach them',
            teacherNames.includes(tMaths.name) && teacherNames.includes(tScience.name));
        check('Student does NOT see an unrelated teacher', !teacherNames.includes(tStranger.name));

        const outsiderPending = await GET('/feedback/student/pending', { as: outsider });
        check('Unenrolled student has nothing pending', outsiderPending.data.length === 0);

        const assignmentId = pending.data.find((r) => r.teacher.name === tMaths.name)._id;
        const foreignId = (await GET('/feedback/student/pending', { as: students[1] })).data[0]._id;

        const idor = await GET(`/feedback/student/assignments/${foreignId}`, { as: students[0] });
        check('IDOR: another student\'s assignment is not reachable', idor.status === 404);

        const idorSubmit = await POST(`/feedback/student/assignments/${foreignId}/submit`, {
            as: students[0], body: { answers: [] },
        });
        check('IDOR: cannot submit into another student\'s assignment', idorSubmit.status === 404);

        const form = await GET(`/feedback/student/assignments/${assignmentId}`, { as: students[0] });
        check('Student can open the form', form.status === 200 && form.data.questions.length === 17);
        check('Form carries the teacher/subject context', !!form.data.assignment.teacher.name && !!form.data.assignment.subject);
        check('Opening the form marks it in progress', form.data.assignment.status === 'in_progress');

        const questions = form.data.questions;
        const ratingQs = questions.filter((q) => q.questionType === 'rating_5');
        const textQ = questions.find((q) => q.questionType === 'text');
        const likeQ = questions.find((q) => q.questionType === 'checkbox');

        const answersAt = (score) => [
            ...ratingQs.map((q) => ({ campaignQuestion: q._id, ratingValue: score })),
            { campaignQuestion: likeQ._id, optionIds: [likeQ.options[0]._id] },
            { campaignQuestion: textQ._id, textResponse: 'Very helpful in class.' },
        ];

        const missing = await POST(`/feedback/student/assignments/${assignmentId}/submit`, {
            as: students[0], body: { answers: answersAt(4).slice(1) },
        });
        check('Required rating question must be answered', missing.status === 400 && /Please rate/i.test(missing.body.message),
            missing.body?.message);

        const outOfRange = await POST(`/feedback/student/assignments/${assignmentId}/submit`, {
            as: students[0],
            body: { answers: answersAt(4).map((a, i) => (i === 0 ? { ...a, ratingValue: 9 } : a)) },
        });
        check('Rating outside 1–5 is rejected', outOfRange.status === 400 && /1 to 5/.test(outOfRange.body.message));

        const longText = await POST(`/feedback/student/assignments/${assignmentId}/submit`, {
            as: students[0],
            body: { answers: [...answersAt(4).filter((a) => a.campaignQuestion !== textQ._id),
                { campaignQuestion: textQ._id, textResponse: 'x'.repeat(1001) }] },
        });
        check('Comment longer than 1000 characters is rejected', longText.status === 400);

        const submitted = await POST(`/feedback/student/assignments/${assignmentId}/submit`, {
            as: students[0], body: { answers: answersAt(5) },
        });
        check('Student can submit valid feedback', submitted.status === 200 && submitted.data.status === 'submitted',
            submitted.body?.message);

        const twice = await POST(`/feedback/student/assignments/${assignmentId}/submit`, {
            as: students[0], body: { answers: answersAt(3) },
        });
        check('Duplicate submission is refused (feedback is locked)', twice.status === 409);

        const reopenForm = await GET(`/feedback/student/assignments/${assignmentId}`, { as: students[0] });
        check('Submitted feedback can no longer be edited', reopenForm.status === 409);

        const mine = await GET(`/feedback/student/assignments/${assignmentId}/submission`, { as: students[0] });
        check('Student can re-read their own submission', mine.status === 200 && mine.data.answers.length === 17);

        const notMine = await GET(`/feedback/student/assignments/${foreignId}/submission`, { as: students[0] });
        check('Cannot read another student\'s submission', notMine.status === 404);

        const listAfter = await GET('/feedback/student/pending', { as: students[0] });
        check('Submitted item leaves the pending list', listAfter.data.length === 1);
        const done = await GET('/feedback/student/completed', { as: students[0] });
        check('Submitted item appears in completed', done.data.length === 1);

        // Ownership cannot be forged: the payload's extra fields are ignored.
        // Deliberately routed at the SCIENCE assignment so the two teachers end
        // up on opposite sides of the 5-response threshold below.
        const s1Science = (await GET('/feedback/student/pending', { as: students[1] }))
            .data.find((r) => r.teacher.name === tScience.name)._id;
        const forged = await POST(`/feedback/student/assignments/${s1Science}/submit`, {
            as: students[1],
            body: {
                student: sid(students[0]._id), teacher: sid(tStranger._id), campaign: 'x',
                answers: answersAt(4),
            },
        });
        const forgedRow = await FeedbackAssignment.findOne({ campaign: campaignId, student: sid(students[1]._id), status: 'submitted' }).lean();
        check('Client-sent student/teacher/campaign fields are ignored',
            forged.status === 200 && sid(forgedRow.student) === sid(students[1]._id) && sid(forgedRow.teacher) !== sid(tStranger._id));

        // ══ PRIVACY THRESHOLD ════════════════════════════════════════════════
        section('Minimum-response threshold & anonymity');

        const lockedDash = await GET('/feedback/teacher/dashboard', { as: tMaths });
        check('Below the threshold the teacher aggregate is locked',
            lockedDash.status === 200 && lockedDash.data.summary.locked === true);
        check('Locked aggregate hides the rating', lockedDash.data.summary.averageRating === null);
        check('Locked aggregate explains why',
            /Insufficient responses/i.test(lockedDash.data.summary.message || ''), lockedDash.data.summary.message);
        check('Locked aggregate exposes no categories or comments',
            lockedDash.data.categories.length === 0 && lockedDash.data.comments.length === 0);

        // Bring Maths up to the 5-response threshold.
        for (let i = 2; i <= 5; i += 1) {
            const p = await GET('/feedback/student/pending', { as: students[i] });
            const a = p.data.find((r) => r.teacher.name === tMaths.name);
            const fm = await GET(`/feedback/student/assignments/${a._id}`, { as: students[i] });
            const rq = fm.data.questions.filter((q) => q.questionType === 'rating_5');
            const tq = fm.data.questions.find((q) => q.questionType === 'text');
            const lq = fm.data.questions.find((q) => q.questionType === 'checkbox');
            await POST(`/feedback/student/assignments/${a._id}/submit`, {
                as: students[i],
                body: {
                    answers: [
                        ...rq.map((q) => ({ campaignQuestion: q._id, ratingValue: 4 })),
                        { campaignQuestion: lq._id, optionIds: [lq.options[0]._id, lq.options[1]._id] },
                        { campaignQuestion: tq._id, textResponse: `Comment from student ${i}` },
                    ],
                },
            });
        }

        const openDash = await GET('/feedback/teacher/dashboard', { as: tMaths });
        check('At the threshold the aggregate unlocks',
            openDash.data.summary.locked === false && openDash.data.summary.responses === 5,
            `responses ${openDash.data?.summary?.responses}`);
        check('Overall rating is computed (4×4 + 1×5 = 4.2)',
            openDash.data.summary.averageRating === 4.2, `got ${openDash.data.summary.averageRating}`);
        check('Category scores are returned', openDash.data.categories.length >= 5);
        check('Strengths / improvement areas are derived', Array.isArray(openDash.data.strengths));

        const dashJson = JSON.stringify(openDash.data);
        const leaked = students.filter((s) => dashJson.includes(s.name) || dashJson.includes(sid(s._id)));
        check('Teacher payload leaks no student name or id', leaked.length === 0,
            leaked.map((s) => s.name).join(', '));
        check('Comments are returned as bare text only',
            openDash.data.comments.every((c) => Object.keys(c).length === 1 && 'text' in c));

        const scienceDash = await GET('/feedback/teacher/dashboard', { as: tScience });
        check('A teacher sees only their OWN responses',
            scienceDash.data.summary.responses === 1, `got ${scienceDash.data?.summary?.responses}`);
        check('Another teacher\'s unlocked numbers are not visible to them',
            scienceDash.data.summary.locked === true && scienceDash.data.summary.averageRating === null);

        // ══ CAMPAIGN WINDOW RULES ════════════════════════════════════════════
        section('Campaign window rules');

        const future = await POST('/feedback/campaigns', {
            as: admin,
            body: {
                name: `${TAG} Future`, startDate: iso(new Date(today.getTime() + 10 * 86400000)),
                endDate: iso(new Date(today.getTime() + 20 * 86400000)), template: templateId, minimumResponses: 1,
            },
        });
        const futureAct = await POST(`/feedback/campaigns/${future.data._id}/activate`, { as: admin });
        check('A future campaign activates as "scheduled"', futureAct.data.status === 'scheduled');
        const futurePending = await GET('/feedback/student/pending', { as: students[6] });
        check('A scheduled campaign shows nothing to students yet',
            futurePending.data.every((r) => r.campaign._id !== future.data._id));
        const futureRow = await FeedbackAssignment.findOne({ campaign: future.data._id, student: sid(students[6]._id) }).lean();
        const futureSubmit = await POST(`/feedback/student/assignments/${sid(futureRow._id)}/submit`, {
            as: students[6], body: { answers: [] },
        });
        check('A future campaign refuses submissions',
            futureSubmit.status === 409 && /not started/i.test(futureSubmit.body.message), futureSubmit.body?.message);

        // Force the live campaign's end date into the past.
        await FeedbackCampaign.updateOne({ _id: campaignId }, { $set: { endDate: new Date(today.getTime() - 2 * 86400000) } });
        const expiredPending = await GET('/feedback/student/pending', { as: students[6] });
        check('An expired campaign drops out of the pending list', expiredPending.data.length === 0);
        const expiredRow = await FeedbackAssignment.findOne({ campaign: campaignId, student: sid(students[6]._id) }).lean();
        const expiredSubmit = await POST(`/feedback/student/assignments/${sid(expiredRow._id)}/submit`, {
            as: students[6], body: { answers: answersAt(4) },
        });
        check('An expired campaign refuses submissions',
            expiredSubmit.status === 409 && /deadline/i.test(expiredSubmit.body.message), expiredSubmit.body?.message);
        await FeedbackCampaign.updateOne({ _id: campaignId }, { $set: { endDate: new Date(today.getTime() + 7 * 86400000) } });

        // ══ ADMIN & PRINCIPAL ANALYTICS ══════════════════════════════════════
        section('Admin & principal analytics');

        const adminDash = await GET('/feedback/dashboard', { as: admin });
        check('Admin dashboard returns the KPI cards',
            adminDash.status === 200 && adminDash.data.cards.totalResponses === 6,
            `responses ${adminDash.data?.cards?.totalResponses}`);
        check('Admin teacher table carries a locked flag per teacher',
            adminDash.data.teachers.some((t) => t.locked === true) && adminDash.data.teachers.some((t) => t.locked === false));
        const lockedTeacher = adminDash.data.teachers.find((t) => t.locked);
        check('Locked teachers expose no rating to the admin either', lockedTeacher.rating === null);
        check('Departments roll up', adminDash.data.departments.length >= 2);

        const princDash = await GET('/feedback/dashboard', { as: principal });
        check('Principal sees the same school-wide payload',
            princDash.status === 200 && princDash.data.cards.totalResponses === 6);
        check('Principal is flagged as read-only',
            princDash.data.access.isPrincipal === true && princDash.data.access.canManage === false);

        const teacherDetail = await GET(`/feedback/teachers/${sid(tMaths._id)}`, { as: principal });
        check('Principal can drill into a teacher', teacherDetail.status === 200 && teacherDetail.data.summary.responses === 5);
        const detailJson = JSON.stringify(teacherDetail.data);
        check('Teacher drill-down leaks no student identity',
            !students.some((s) => detailJson.includes(s.name) || detailJson.includes(sid(s._id))));

        const otherTeacher = await GET(`/feedback/teachers/${sid(tMaths._id)}`, { as: tScience });
        check('A plain teacher cannot drill into another teacher', otherTeacher.status === 403);

        const tracking = await GET(`/feedback/campaigns/${campaignId}/assignments?limit=50`, { as: admin });
        check('Admin can track who has submitted', tracking.status === 200 && tracking.data.data.length === 14);
        check('Anonymous campaign hides per-student ratings from the tracker',
            tracking.data.isAnonymous === true && tracking.data.data.every((r) => r.overallRating === null));
        check('Tracker still shows submission status for chasing',
            tracking.data.data.filter((r) => r.status === 'submitted').length === 6);

        const page1 = await GET(`/feedback/campaigns/${campaignId}/assignments?limit=5&page=1`, { as: admin });
        const page2 = await GET(`/feedback/campaigns/${campaignId}/assignments?limit=5&page=2`, { as: admin });
        check('Pagination works', page1.data.data.length === 5 && page2.data.data.length === 5
            && page1.data.pages === 3 && page1.data.data[0]._id !== page2.data.data[0]._id);

        const filtered = await GET(`/feedback/campaigns/${campaignId}/assignments?status=submitted`, { as: admin });
        check('Assignment filtering works', filtered.data.data.every((r) => r.status === 'submitted'));

        // ══ REPORTS & EXPORTS ════════════════════════════════════════════════
        section('Reports & exports');

        const rep = await GET('/feedback/reports?type=teacher&format=json', { as: admin });
        check('Teacher report builds', rep.status === 200 && rep.data.rows.length >= 2);
        const mathsRow = rep.data.rows.find((r) => r.teacher === tMaths.name);
        const scienceRow = rep.data.rows.find((r) => r.teacher === tScience.name);
        check('Report shows the unlocked teacher\'s rating', mathsRow.avgRating === 4.2, `got ${mathsRow?.avgRating}`);
        check('Report withholds the locked teacher\'s rating',
            scienceRow.avgRating === null && scienceRow.note === 'Insufficient responses');

        const byTeacher = await GET(`/feedback/reports?type=teacher&format=json&teacher=${sid(tMaths._id)}`, { as: admin });
        check('Report filtering by teacher works', byTeacher.data.rows.length === 1 && byTeacher.data.rows[0].teacher === tMaths.name);

        const bySubject = await GET(`/feedback/reports?type=subject&format=json&subject=${sid(f.maths._id)}`, { as: admin });
        check('Report filtering by subject works', bySubject.data.rows.length === 1);

        const noMatch = await GET('/feedback/reports?type=teacher&format=json&dateFrom=2099-01-01', { as: admin });
        check('A filter that matches nothing returns an empty report', noMatch.data.rows.length === 0);

        for (const t of ['campaign', 'class', 'subject', 'department', 'response_rate', 'trend']) {
            const r = await GET(`/feedback/reports?type=${t}&format=json`, { as: admin });
            check(`Report type "${t}" builds`, r.status === 200 && Array.isArray(r.data.rows));
        }

        const csv = await GET('/feedback/reports?type=teacher&format=csv', { as: admin, raw: true });
        check('CSV export downloads', csv.status === 200 && csv.text.split('\n').length >= 3);
        check('CSV export respects the privacy rule', csv.text.includes('Insufficient responses'));
        check('CSV export contains no student name', !students.some((s) => csv.text.includes(s.name)));

        const xlsx = await GET('/feedback/reports?type=teacher&format=xlsx', { as: admin, raw: true });
        check('Excel export downloads',
            xlsx.status === 200 && /spreadsheetml/.test(xlsx.headers.get('content-type') || ''));

        const pdf = await GET('/feedback/reports?type=teacher&format=pdf', { as: admin, raw: true });
        check('PDF export downloads', pdf.status === 200 && /application\/pdf/.test(pdf.headers.get('content-type') || ''));

        const studentExport = await GET('/feedback/reports?type=teacher&format=csv', { as: students[0], raw: true });
        check('Student cannot export a report', studentExport.status === 403);

        const princExport = await GET('/feedback/reports?type=teacher&format=json', { as: principal });
        check('Principal can export reports', princExport.status === 200);

        // ══ HISTORY PRESERVATION ═════════════════════════════════════════════
        section('Historical integrity');

        const usedQuestion = qs.data.data.find((q) => q.questionType === 'rating_5');
        const delUsed = await DEL(`/feedback/questions/${usedQuestion._id}`, { as: admin });
        check('A question with responses is archived, not deleted',
            delUsed.status === 200 && delUsed.data.archived === true && delUsed.data.deleted === false);
        const stillThere = await FeedbackQuestion.findById(usedQuestion._id).lean();
        check('The archived question row still exists', !!stillThere && stillThere.status === 'archived');

        const typeChange = await PUT(`/feedback/questions/${usedQuestion._id}`, {
            as: admin, body: { questionType: 'text' },
        });
        check('An answered question cannot change type', typeChange.status === 409);

        const reword = await PUT(`/feedback/questions/${usedQuestion._id}`, {
            as: admin, body: { questionText: 'Reworded after the fact' },
        });
        check('An answered question can still be reworded', reword.status === 200);
        const snapshot = await FeedbackCampaignQuestion.findOne({ campaign: campaignId, question: usedQuestion._id }).lean();
        check('Rewording does NOT rewrite the campaign snapshot',
            snapshot.questionText === usedQuestion.questionText, `snapshot now "${snapshot.questionText}"`);

        const usedCat = cats.data.find((c) => c.slug === 'teaching_quality');
        const delCat = await DEL(`/feedback/categories/${usedCat._id}`, { as: admin });
        check('A category used by feedback cannot be deleted', delCat.status === 409);

        const stillReadable = await GET(`/feedback/student/assignments/${assignmentId}/submission`, { as: students[0] });
        check('Historical feedback stays readable after archiving',
            stillReadable.status === 200 && stillReadable.data.answers.length === 17);

        // ══ CLOSING & DELETION ═══════════════════════════════════════════════
        section('Closing, deletion & audit');

        const delActive = await DEL(`/feedback/campaigns/${campaignId}`, { as: admin });
        check('An active campaign cannot be deleted', delActive.status === 409);

        const beforeClose = await FeedbackResponse.countDocuments({ campaign: campaignId });
        const closed = await POST(`/feedback/campaigns/${campaignId}/close`, { as: admin });
        check('Campaign closes', closed.status === 200 && closed.data.status === 'closed');
        const afterClose = await FeedbackResponse.countDocuments({ campaign: campaignId });
        check('Closing deletes nothing', beforeClose > 0 && afterClose === beforeClose);
        const expiredCount = await FeedbackAssignment.countDocuments({ campaign: campaignId, status: 'expired' });
        check('Outstanding assignments become expired', expiredCount === 8, `got ${expiredCount}`);

        const closedSubmitRow = await FeedbackAssignment.findOne({ campaign: campaignId, status: 'expired' }).lean();
        const closedSubmit = await POST(`/feedback/student/assignments/${sid(closedSubmitRow._id)}/submit`, {
            as: { _id: closedSubmitRow.student, role: 'student', school: f.schoolId }, body: { answers: answersAt(4) },
        });
        check('A closed campaign refuses submissions', closedSubmit.status === 409);

        const closedResults = await GET('/feedback/teacher/dashboard', { as: tMaths });
        check('Results survive closure', closedResults.data.summary.responses === 5);

        const draftDel = await DEL(`/feedback/campaigns/${future.data._id}`, { as: admin });
        check('A scheduled campaign cannot be deleted either', draftDel.status === 409);

        const draft = await POST('/feedback/campaigns', {
            as: admin,
            body: { name: `${TAG} Throwaway`, startDate: iso(today), endDate: iso(new Date(today.getTime() + 86400000)), template: templateId },
        });
        const draftGone = await DEL(`/feedback/campaigns/${draft.data._id}`, { as: admin });
        check('A draft campaign CAN be deleted', draftGone.status === 200 && draftGone.data.deleted === true);

        const audit = await GET('/feedback/audit?limit=50', { as: admin });
        const actions = new Set(audit.data.data.map((a) => a.actionType));
        check('Audit log records the lifecycle',
            ['create', 'activate', 'close', 'submit', 'export', 'archive'].every((a) => actions.has(a)),
            [...actions].join(', '));

        const studentAudit = await GET('/feedback/audit', { as: students[0] });
        check('Students cannot read the audit log', studentAudit.status === 403);

        // ══ SETTINGS ═════════════════════════════════════════════════════════
        section('Settings');

        const setHide = await PUT('/feedback/settings', { as: admin, body: { teacherCanSeeComments: false } });
        check('Settings save', setHide.status === 200 && setHide.data.teacherCanSeeComments === false);
        const hiddenComments = await GET('/feedback/teacher/dashboard', { as: tMaths });
        check('Turning comments off hides them from teachers',
            hiddenComments.data.comments.length === 0 && hiddenComments.data.summary.averageRating === 4.2);
        await PUT('/feedback/settings', { as: admin, body: { teacherCanSeeComments: true } });

        const setTrends = await PUT('/feedback/settings', { as: admin, body: { teacherCanSeeTrends: false } });
        const noTrends = await GET('/feedback/teacher/trends', { as: tMaths });
        check('Turning trends off hides them from teachers',
            setTrends.status === 200 && noTrends.data.disabled === true && noTrends.data.points.length === 0);
    } catch (e) {
        failed += 1;
        results.push(`\n  💥 Test run threw: ${e.stack || e.message}`);
    } finally {
        if (f) { try { await cleanup(f); } catch (e) { console.error('cleanup failed:', e.message); } }
        server.close();
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  FEEDBACK MODULE — END-TO-END TESTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
})();
