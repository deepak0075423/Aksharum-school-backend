'use strict';
/**
 * Class tests — a subject teacher's own short tests, approved by the class
 * teacher before students see them.
 *
 *   DRAFT ──submit──▶ SUBMITTED ──approve──▶ FINAL_APPROVED
 *                          │ reject
 *                          ▼
 *                      REJECTED ──reopen (by its teacher)──▶ REOPENED ──submit──▶ SUBMITTED
 *
 * Marks are written while a test is a draft or being corrected, by the teacher
 * who set it, for the students on the section's roll, never above the maximum,
 * and a test goes for approval with no student left blank — rules the old form
 * enforced in the browser, when at all.
 *
 * Each step tells whoever has the next one: submitting tells the class teacher,
 * approving tells the teacher and the students, rejecting tells the teacher
 * why. None of them used to say anything, so a submitted test waited until the
 * class teacher happened to open the page. And a test whose section has nobody
 * else to approve it — no class teacher, or the class teacher set it — is
 * approved as it is submitted: it could otherwise never leave "waiting".
 *
 * An approved test is not final for ever: its teacher can reopen it to correct
 * a mark. Students stop seeing it until it is approved again.
 */
const ClassTest       = require('../models/ClassTest');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const { rosterOf, dayOf, gradeFor, familyOf, takersOf, rollFor, trail } = require('../services/resultExams');
const { patch } = require('../db/patch');
const resultSettings        = require('../services/resultSettings');
const { childrenOf }        = require('../services/parentChildren');
const { notify }            = require('../services/notifyService');
const ClassSection    = require('../models/ClassSection');
const Class           = require('../models/Class');
const User            = require('../models/User');

/** A mark's grade — the exams' rule, on the school's scale: a pass never gets a failing grade, a fail always does. */
const gradeOf = (value, max, pass, scale) => gradeFor(value, max, value >= pass, false, scale);

/** The students a test is for: the section's roll — or, for an elective, its roster. */
async function rollOfTest(test) {
    const [roster, takers] = await Promise.all([rosterOf(test.section), takersOf(test.section, [test.subject])]);
    return rollFor(roster, takers, test.subject);
}

/** Was this test approved before (and so seen by families) — from its history. */
const wasApproved = (test) => (test.auditLog || []).some((a) => a.action === 'APPROVED' || a.action === 'OFFICE_APPROVED');

/** The people who may approve a section's tests: its class teacher and vice class teacher. */
async function validatorsOf(sectionId) {
    const sec = await ClassSection.findById(sectionId).select('classTeacher substituteTeacher class sectionName').lean();
    return {
        ids: [...new Set([sec?.classTeacher, sec?.substituteTeacher].filter(Boolean).map(String))],
        section: sec,
    };
}

/** "Class 6 – A", for a notice. */
async function whereOf(section) {
    const cls = section?.class ? await Class.findById(section.class).select('className').lean() : null;
    return [cls?.className, section?.sectionName].filter(Boolean).join(' – ');
}

/** A notice never makes a step fail. */
function tell(req, test, { title, body, recipients, type }) {
    try {
        if (!recipients?.length) return;
        notify({
            school: test.school, sender: req.userId, senderRole: req.userRole || 'teacher',
            title, body, recipients, link: { type, entityId: test._id },
        });
    } catch (e) { console.error('[class-tests] notice failed:', e.message); }
}

/**
 * Approved: the students who sat it — and their parents — can see their marks.
 * Approved again after a correction, they are told it was corrected.
 */
function announceMarks(req, test, { again = false } = {}) {
    const students = (test.marks || []).map((m) => String(m.student)).filter(Boolean);
    if (!students.length) return;
    familyOf(test.school, students).then((recipients) => tell(req, test, again ? {
        title: `📝 Class test marks corrected: ${test.title}`,
        body: `The marks for "${test.title}" have been corrected and are back under Results → Class Tests.`,
        recipients, type: 'results.tests',
    } : {
        title: `📝 Class test marks: ${test.title}`,
        body: `The marks for "${test.title}" are out. Open Results → Class Tests to see them.`,
        recipients, type: 'results.tests',
    })).catch(() => {});
}

function computeStats(marks, maxMarks, passingMarks) {
    const scored = marks.filter(m => !m.isAbsent && m.marksObtained !== null).map(m => m.marksObtained);
    if (!scored.length) return { average: null, highest: null, lowest: null, passPercent: null };
    const passed  = scored.filter(s => s >= passingMarks).length;
    return {
        average:     Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100,
        highest:     Math.max(...scored),
        lowest:      Math.min(...scored),
        passPercent: Math.round((passed / scored.length) * 100),
    };
}

// ── Teacher: Class Tests ──────────────────────────────────────────────────────

exports.teacherGetClassTests = async (req, res) => {
    try {
        const { status } = req.query;
        const filter = { school: req.schoolId, createdBy: req.userId };
        // A string, or nothing: `?status[$ne]=…` arrives as an object, and an
        // object here would be read as a query operator.
        if (typeof status === 'string' && status) filter.status = status;

        const tests = await ClassTest.find(filter)
            .populate('section', 'sectionName')
            .populate('subject', 'subjectName name')
            .sort({ testDate: -1 })
            .lean();
        res.json({ success: true, data: tests });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherCreateClassTest = async (req, res) => {
    try {
        const bad = (message) => res.status(400).json({ success: false, message });
        const { sectionId, subjectId, testDate, topic, description } = req.body || {};
        const title = String(req.body?.title || '').trim();
        if (!title) return bad('Give the test a name');
        if (title.length > 120) return bad('The name is too long (120 characters at most)');
        const max = Number(req.body?.maxMarks);
        const pass = Number(req.body?.passingMarks);
        if (!Number.isFinite(max) || max < 1 || max > 1000) return bad('Maximum marks must be between 1 and 1000');
        if (!Number.isFinite(pass) || pass < 0) return bad('Pass marks cannot be blank or negative');
        if (pass > max) return bad(`Pass marks cannot be more than the maximum (${max})`);
        const day = dayOf(testDate);
        if (!day) return bad('Choose the day of the test');

        // The section must be this school's, and the subject one this teacher
        // teaches there: the form used to accept any pair it was sent.
        const section = await ClassSection.findOne({ _id: sectionId, school: req.schoolId }).select('academicYear').lean();
        if (!section) return bad('Choose one of your sections');
        const teaches = await SectionSubjectTeacher.findOne({ teacher: req.userId, section: section._id, subject: subjectId }).select('_id').lean();
        if (!teaches) return res.status(403).json({ success: false, message: 'You can set a test only in a subject you teach in that section' });

        const test = await ClassTest.create({
            school: req.schoolId, section: section._id, subject: subjectId,
            // The section's own year — not "whichever is active", which filed a
            // test set for another year under the wrong one.
            academicYear: section.academicYear, title, testDate: day,
            maxMarks: max, passingMarks: pass,
            topic: String(topic || '').trim().slice(0, 200), description: String(description || '').trim().slice(0, 1000),
            createdBy: req.userId,
            auditLog: [{ action: 'CREATED', by: req.userId }],
        });
        res.status(201).json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Correct a test's details while it is still its teacher's to change (a draft,
 * or reopened): the name, the day, the topic — and the marks it is out of,
 * as long as nobody already has more than the new maximum. A typo used to
 * mean deleting the test and setting it again.
 */
exports.teacherUpdateClassTest = async (req, res) => {
    try {
        const bad = (message) => res.status(400).json({ success: false, message });
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (!['DRAFT', 'REOPENED'].includes(test.status)) return bad('A test can be changed only while it is a draft or reopened for correction');

        const b = req.body || {};
        const title = b.title !== undefined ? String(b.title || '').trim() : test.title;
        if (!title) return bad('Give the test a name');
        if (title.length > 120) return bad('The name is too long (120 characters at most)');
        const max = b.maxMarks !== undefined ? Number(b.maxMarks) : Number(test.maxMarks);
        const pass = b.passingMarks !== undefined ? Number(b.passingMarks) : Number(test.passingMarks);
        if (!Number.isFinite(max) || max < 1 || max > 1000) return bad('Maximum marks must be between 1 and 1000');
        if (!Number.isFinite(pass) || pass < 0) return bad('Pass marks cannot be blank or negative');
        if (pass > max) return bad(`Pass marks cannot be more than the maximum (${max})`);
        const day = b.testDate !== undefined ? dayOf(b.testDate) : test.testDate;
        if (!day) return bad('Choose the day of the test');

        const scored = (test.marks || []).filter((m) => !m.isAbsent && m.marksObtained !== null && m.marksObtained !== undefined);
        const top = scored.length ? Math.max(...scored.map((m) => Number(m.marksObtained))) : 0;
        if (top > max) return bad(`A student already has ${top} marks — the maximum cannot be less than that`);

        test.title = title;
        test.testDate = day;
        test.maxMarks = max;
        test.passingMarks = pass;
        if (b.topic !== undefined) test.topic = String(b.topic || '').trim().slice(0, 200);
        if (b.description !== undefined) test.description = String(b.description || '').trim().slice(0, 1000);
        // The marks already entered are graded against the new figures.
        const scale = await resultSettings.scaleOf(req.schoolId);
        test.marks = (test.marks || []).map((m) => ({
            ...m,
            grade: m.isAbsent || m.marksObtained === null || m.marksObtained === undefined ? '' : gradeOf(Number(m.marksObtained), max, pass, scale),
        }));
        test.classStats = computeStats(test.marks, max, pass);
        test.auditLog.push({ action: 'UPDATED', by: req.userId });
        await test.save();
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** A draft test nobody has entered marks for can go; anything else stays on record. */
exports.teacherDeleteClassTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status !== 'DRAFT') return res.status(400).json({ success: false, message: 'Only a draft test can be deleted' });
        await ClassTest.deleteOne({ _id: test._id });
        trail({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole || 'teacher' }, 'CLASS_TEST_DELETED', 'ClassTest', test._id,
            `Deleted the draft class test "${test.title}"`, { testDate: test.testDate });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetTestMarks = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId })
            .populate('section', 'sectionName enrolledStudents')
            .populate('subject', 'subjectName name')
            .lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });

        // The test's own roll — active students, an elective's roster — with
        // roll numbers from the student profile (the account row has none).
        const roll = await rollOfTest({ section: test.section?._id || test.section, subject: test.subject?._id || test.subject });
        const [users, profiles] = await Promise.all([
            User.find({ _id: { $in: roll } }).select('name email').lean(),
            require('../models/StudentProfile').find({ user: { $in: roll } }).select('user rollNumber').lean(),
        ]);
        const rollNo = new Map(profiles.map((p) => [String(p.user), p.rollNumber || '']));
        const students = users.map((u) => ({ ...u, rollNumber: rollNo.get(String(u._id)) || '' }));

        const marksMap = Object.fromEntries((test.marks || []).map(m => [m.student.toString(), m]));
        const entries  = students.map(s => ({
            ...s, ...(marksMap[s._id.toString()] || { marksObtained: null, isAbsent: false, remarks: '', grade: '' }),
        }));

        res.json({ success: true, data: { test, entries } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherSaveTestMarks = async (req, res) => {
    try {
        const { submit } = req.body || {};
        const marks = req.body?.marks ?? req.body?.entries;
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (!['DRAFT', 'REOPENED'].includes(test.status)) {
            return res.status(400).json({ success: false, message: {
                SUBMITTED: 'These marks are with the class teacher for approval',
                FINAL_APPROVED: 'This test is approved and its marks can no longer change',
                REJECTED: 'These marks were rejected — reopen the test to correct them',
            }[test.status] || 'These marks can no longer change' });
        }

        // Only students on the test's roll (an elective's roster, else the
        // section's), once each; a blank is kept blank rather than read as a zero.
        const onRoll = new Set(await rollOfTest(test));
        const max = Number(test.maxMarks);
        const scale = await resultSettings.scaleOf(req.schoolId);
        const seen = new Set();
        const processed = [];
        for (const m of Array.isArray(marks) ? marks : []) {
            const sid = String(m?.student?._id ?? m?.student ?? '');
            if (!onRoll.has(sid) || seen.has(sid)) continue;
            seen.add(sid);
            const absent = !!m.isAbsent;
            let value = null;
            if (!absent && m.marksObtained !== null && m.marksObtained !== undefined && m.marksObtained !== '') {
                value = Number(m.marksObtained);
                if (!Number.isFinite(value)) return res.status(400).json({ success: false, message: 'Marks must be a number' });
                if (value < 0) return res.status(400).json({ success: false, message: 'Marks cannot be negative' });
                if (value > max) return res.status(400).json({ success: false, message: `Marks cannot be more than the maximum (${max})` });
                value = Math.round(value * 100) / 100;
            }
            processed.push({
                student: sid, marksObtained: value, isAbsent: absent, remarks: String(m.remarks || '').trim().slice(0, 300),
                grade: absent || value === null ? '' : gradeOf(value, max, Number(test.passingMarks), scale),
            });
        }
        if (submit) {
            const done = new Set(processed.filter((e) => e.isAbsent || e.marksObtained !== null).map((e) => e.student));
            const missing = [...onRoll].filter((id) => !done.has(id)).length;
            if (missing) {
                return res.status(400).json({ success: false, code: 'MARKS_INCOMPLETE', missing,
                    message: `Enter marks or mark absent for every student before submitting — ${missing} ${missing === 1 ? 'is' : 'are'} still blank` });
            }
        }

        test.marks     = processed;
        test.classStats = computeStats(processed, test.maxMarks, test.passingMarks);
        let autoApproved = false;
        if (submit) {
            // Who approves it? Its class teacher or vice class teacher. With
            // neither, it would wait for ever — nobody else can approve a class
            // test — so it is approved as it goes in. And when the teacher who
            // set it IS one of them, their submission is their approval: they
            // could only have clicked Approve on it themselves.
            const { ids, section } = await validatorsOf(test.section);
            const others = ids.filter((id) => id !== String(req.userId));
            test.auditLog.push({ action: 'SUBMITTED', by: req.userId });
            const again = wasApproved(test);
            if (!ids.length || ids.includes(String(req.userId))) {
                autoApproved = true;
                test.$again = again;
                test.status     = 'FINAL_APPROVED';
                test.approvedBy = req.userId;
                test.approvedAt = new Date();
                test.rejectionReason = '';
                test.auditLog.push({ action: 'APPROVED', by: req.userId, notes: ids.length ? 'Set by the section\'s class teacher — approved on submission' : 'No class teacher — approved on submission' });
            } else {
                test.status = 'SUBMITTED';
            }
            await test.save();
            if (autoApproved) announceMarks(req, test, { again: !!test.$again });
            else {
                tell(req, test, {
                    title: `✅ Class test to approve: ${test.title}`,
                    body: `${req.user?.name || 'A teacher'} has submitted the marks of "${test.title}" for ${await whereOf(section) || 'your class'}. Review and approve them so students can see their marks.`,
                    recipients: others, type: 'results.validate',
                });
            }
        } else {
            test.auditLog.push({ action: 'SAVED', by: req.userId });
            await test.save();
        }
        res.json({ success: true, data: test, autoApproved });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherReopenTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        // Rejected marks come back to be corrected; approved ones can be
        // reopened too — a wrong mark found after approval had no way back.
        if (!['REJECTED', 'FINAL_APPROVED'].includes(test.status)) {
            return res.status(400).json({ success: false, message: 'Only a rejected or an approved test can be reopened' });
        }
        const approvedBefore = test.status === 'FINAL_APPROVED';
        // Claimed: a reopen and an approval landing together cannot both win.
        const row = await patch(ClassTest, test._id, {
            status: 'REOPENED', ...(approvedBefore ? { approvedBy: null, approvedAt: null } : {}),
        }, {
            where: { status: test.status },
            push: { auditLog: { action: 'REOPENED', by: String(req.userId), at: new Date(), notes: approvedBefore ? 'Approved marks reopened for correction' : '' } },
        });
        if (!row) return res.status(409).json({ success: false, message: 'This test has moved on since you opened it — reload it' });
        // Families had these marks; they vanish from their page while corrected — say so.
        if (approvedBefore) {
            const students = (test.marks || []).map((m) => String(m.student)).filter(Boolean);
            familyOf(test.school, students).then((recipients) => tell(req, test, {
                title: `📝 Class test being corrected: ${test.title}`,
                body: `The marks for "${test.title}" are being corrected by the teacher and will be back once they are approved again.`,
                recipients, type: 'results.tests',
            })).catch(() => {});
        }
        res.json({ success: true, data: row });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Class Test Validation (class teacher) ───────────────────────────

exports.teacherGetClassTestValidation = async (req, res) => {
    try {
        const mySections = await ClassSection.find({
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            school: req.schoolId,
        }).lean();
        if (!mySections.length) return res.json({ success: true, data: [] });

        const sectionIds = mySections.map(s => s._id);
        // SUBMITTED only: a reopened test is being corrected by its teacher,
        // and used to sit here where it could be approved mid-correction.
        const tests = await ClassTest.find({
            section: { $in: sectionIds },
            school:  req.schoolId,
            status:  'SUBMITTED',
        })
            .populate('subject',  'subjectName name')
            .populate('section',  'sectionName')
            .populate('createdBy','name')
            .sort({ testDate: -1 })
            .lean();
        res.json({ success: true, data: tests });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetClassTestValidationDetail = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('subject',   'subjectName name')
            .populate('section',   'sectionName')
            .populate('createdBy', 'name')
            .lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });

        // Every student's marks are on it: it is the class teacher's to read,
        // and its own teacher's — it used to open for any teacher of the school
        // who had its id.
        const mine = String(test.createdBy?._id || test.createdBy) === String(req.userId);
        const reviewer = mine ? null : await ClassSection.findOne({
            _id: test.section?._id || test.section,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        }).select('_id').lean();
        if (!mine && !reviewer) return res.status(403).json({ success: false, message: 'Only the class teacher can review these marks' });

        const students = await User.find({ _id: { $in: test.marks.map(m => m.student) } })
            .select('name rollNumber').lean();
        const studentMap = Object.fromEntries(students.map(s => [s._id.toString(), s]));
        const marks = test.marks.map(m => ({ ...m, studentInfo: studentMap[m.student.toString()] }));

        res.json({ success: true, data: { ...test, marks } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherApproveClassTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status !== 'SUBMITTED')
            return res.status(400).json({ success: false, message: test.status === 'FINAL_APPROVED' ? 'This test is already approved' : 'Only submitted marks can be approved' });

        // The office approves any school's test (adminApproveClassTest).
        if (!req.office) {
            const section = await ClassSection.findOne({
                _id: test.section,
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            });
            if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can approve' });
        }

        const again = wasApproved(test);
        const row = await patch(ClassTest, test._id, { status: 'FINAL_APPROVED', approvedBy: req.userId, approvedAt: new Date() }, {
            where: { status: 'SUBMITTED' },
            push: { auditLog: { action: req.office ? 'OFFICE_APPROVED' : 'APPROVED', by: String(req.userId), at: new Date(), notes: req.body?.notes || '' } },
        });
        if (!row) return res.status(409).json({ success: false, message: 'This test has moved on since you opened it — reload it' });
        Object.assign(test, row);
        if (String(test.createdBy) !== String(req.userId)) {
            tell(req, test, {
                title: `✅ Class test approved: ${test.title}`,
                body: `The marks of "${test.title}" have been approved${req.office ? ' by the school office' : ''}. Students can now see them.`,
                recipients: [String(test.createdBy)], type: 'results.tests',
            });
        }
        announceMarks(req, test, { again });
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherRejectClassTest = async (req, res) => {
    try {
        const reason = String(req.body?.reason || req.body?.remarks || '').trim();
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status !== 'SUBMITTED')
            return res.status(400).json({ success: false, message: 'Only submitted marks can be rejected' });
        if (!reason) return res.status(400).json({ success: false, message: 'Say why the marks are being rejected — the teacher will see it' });

        if (!req.office) {
            const section = await ClassSection.findOne({
                _id: test.section,
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            });
            if (!section) return res.status(403).json({ success: false, message: 'Only class teacher can reject' });
        }

        const row = await patch(ClassTest, test._id, { status: 'REJECTED', rejectionReason: reason.slice(0, 500) }, {
            where: { status: 'SUBMITTED' },
            push: { auditLog: { action: req.office ? 'OFFICE_REJECTED' : 'REJECTED', by: String(req.userId), at: new Date(), notes: reason } },
        });
        if (!row) return res.status(409).json({ success: false, message: 'This test has moved on since you opened it — reload it' });
        Object.assign(test, row);
        if (String(test.createdBy) !== String(req.userId)) {
            tell(req, test, {
                title: `❌ Class test sent back: ${test.title}`,
                body: `${req.office ? 'The school office' : 'The class teacher'} sent back the marks of "${test.title}". Reopen the test, correct them and submit again.\nReason: ${test.rejectionReason}`,
                recipients: [String(test.createdBy)], type: 'results.tests',
            });
        }
        res.json({ success: true, data: test });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── The office: every class test ──────────────────────────────────────────────

/** GET /admin/results/class-tests — every class test in the school, by tab and filter. */
exports.adminListClassTests = async (req, res) => {
    try {
        res.json({ success: true, ...(await require('../services/classTestBoard').list(req.schoolId, req.query || {})) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
/** GET /admin/results/class-tests/:id/sheet — one test as the marks grid, to read and approve. */
exports.adminClassTestSheet = async (req, res) => {
    try {
        const data = await require('../services/resultTeacher').testSheet(req.schoolId, req.userId, req.params.id, { office: true });
        if (!data) return res.status(404).json({ success: false, message: 'Test not found' });
        res.json({ success: true, data });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};
/** The office approves, or sends back, a test waiting for its class teacher. */
exports.adminApproveClassTest = (req, res) => { req.office = true; return exports.teacherApproveClassTest(req, res); };
exports.adminRejectClassTest = (req, res) => { req.office = true; return exports.teacherRejectClassTest(req, res); };

/**
 * POST /admin/results/class-tests/:id/hand-over { teacherId } — a test belongs
 * to the teacher who set it, and only they can enter, submit or correct its
 * marks: one who left (or changed subjects) stranded every test they had not
 * finished. The office hands it to another teacher of the subject there.
 */
exports.adminHandOverClassTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        const to = String(req.body?.teacherId || '');
        if (to === String(test.createdBy)) return res.status(400).json({ success: false, message: 'The test is already this teacher\'s' });
        const teaches = await SectionSubjectTeacher.findOne({ teacher: to, section: test.section, subject: test.subject }).select('_id').lean();
        if (!teaches) return res.status(400).json({ success: false, message: 'Choose a teacher who teaches this subject in this section' });
        const [from, them] = await Promise.all([
            User.findById(test.createdBy).select('name').lean(), User.findOne({ _id: to, school: req.schoolId }).select('name').lean(),
        ]);
        if (!them) return res.status(404).json({ success: false, message: 'Teacher not found' });
        const row = await patch(ClassTest, test._id, { createdBy: to }, {
            where: { createdBy: String(test.createdBy) },
            push: { auditLog: { action: 'HANDED_OVER', by: String(req.userId), at: new Date(), notes: `From ${from?.name || 'its teacher'} to ${them.name}` } },
        });
        if (!row) return res.status(409).json({ success: false, message: 'This test has changed hands since you opened it — reload it' });
        trail({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole }, 'CLASS_TEST_HANDED_OVER', 'ClassTest', test._id,
            `Handed "${test.title}" from ${from?.name || 'its teacher'} to ${them.name}`);
        tell(req, test, {
            title: `📝 Class test handed to you: ${test.title}`,
            body: `The school office has handed you the class test "${test.title}". Its marks are yours to enter and submit now.`,
            recipients: [to], type: 'results.tests',
        });
        res.json({ success: true, data: row });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** DELETE /admin/results/class-tests/:id — a test set by mistake, before it was ever approved. */
exports.adminDeleteClassTest = async (req, res) => {
    try {
        const test = await ClassTest.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!test) return res.status(404).json({ success: false, message: 'Test not found' });
        if (test.status === 'FINAL_APPROVED' || wasApproved(test)) {
            return res.status(400).json({ success: false, message: 'A test whose marks were approved stays on record — its teacher can reopen it to correct them' });
        }
        await ClassTest.deleteOne({ _id: test._id });
        trail({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole }, 'CLASS_TEST_DELETED', 'ClassTest', test._id,
            `Deleted the class test "${test.title}"`, { status: test.status, testDate: test.testDate });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Class Test Results ───────────────────────────────────────────────

/**
 * The approved tests a student's page lists — the ones they have a mark in,
 * whichever section that was, and their current section's — in the shape the
 * phone app reads. These used to read the current section alone, so a student
 * promoted on a final's result day lost every test of the year before.
 * services/resultFamily.classTests decides which (the web page reads it too).
 */
async function testsFor(schoolId, studentId) {
    const family = require('../services/resultFamily');
    const ids = (await family.classTests(schoolId, studentId)).map((t) => String(t._id));
    if (!ids.length) return [];
    return ClassTest.find({ _id: { $in: ids }, school: schoolId, status: 'FINAL_APPROVED' })
        .populate('subject', 'subjectName name')
        .sort({ testDate: -1 })
        .lean();
}

exports.studentGetClassTests = async (req, res) => {
    try {
        const tests = await testsFor(req.schoolId, req.userId);

        const data = tests.map(t => {
            const myEntry = (t.marks || []).find(m => String(m.student) === String(req.userId));
            return {
                _id:          t._id,
                title:        t.title,
                subject:      t.subject,
                testDate:     t.testDate,
                maxMarks:     t.maxMarks,
                passingMarks: t.passingMarks,
                myEntry:      myEntry ? {
                    marksObtained: myEntry.marksObtained,
                    isAbsent:      myEntry.isAbsent,
                    grade:         myEntry.grade,
                    remarks:       myEntry.remarks,
                } : null,
                classStats: t.classStats,
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: view child's class tests ─────────────────────────────────────────
exports.parentGetClassTests = async (req, res) => {
    try {
        // The child asked about (?childId=, one of their own) or the first.
        const kids    = (await childrenOf(req.userId, req.schoolId)).map((k) => String(k._id));
        const wanted  = String(req.query?.childId || '');
        const childId = kids.includes(wanted) ? wanted : kids[0];
        if (!childId) return res.json({ success: true, data: [] });

        const tests = await testsFor(req.schoolId, childId);

        const data = tests.map(t => {
            const entry = (t.marks || []).find(m => String(m.student) === String(childId));
            return {
                _id:          t._id,
                title:        t.title,
                subject:      t.subject,
                testDate:     t.testDate,
                maxMarks:     t.maxMarks,
                passingMarks: t.passingMarks,
                myEntry:      entry ? {
                    marksObtained: entry.marksObtained,
                    isAbsent:      entry.isAbsent,
                    grade:         entry.grade,
                    remarks:       entry.remarks,
                } : null,
                classStats: t.classStats,
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
