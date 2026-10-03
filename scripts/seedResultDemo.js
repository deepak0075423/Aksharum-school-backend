'use strict';
/**
 * Demo data for Results & Assessments — every admin screen with something real on it.
 *
 *   node scripts/seedResultDemo.js            # (re)build "Result Demo School"
 *   node scripts/seedResultDemo.js --clear    # remove it and everything it holds
 *
 * It creates its own school, "Result Demo School", with an admin
 * (admin@resultdemo.test / ResultDemo@123), ten teachers, three classes in seven
 * sections and about 170 students, then walks formal exams through every step
 * of their life so each tab, tile and state of the board has rows behind it:
 *
 *   Unit Test 1          published for six sections; withdrawn and reopened in one
 *   Mid Term Examination one of each — published, ready to publish, waiting for the
 *                        class teacher, waiting with NO class teacher, marks half
 *                        in, rejected, and marks due for a subject nobody teaches
 *   Unit Test 2          two drafts whose exam is already over
 *   Final Examination    seven drafts, still to come — set to promote who passes
 *   last year's Final    published, then archived
 *   class tests          approved, waiting for the class teacher, a draft, rejected
 *   Unit Test 3          under way this week, a paper a day with times — today's among them
 *   parents              one with a child in 6-A; one with children in 6-A and 8-B —
 *                        and a third child at "Result Demo Junior School", a second
 *                        school this builds, where the same person is a parent too
 *
 * Nothing here writes an exam's state directly. Every exam is created, opened,
 * marked, validated, published, rejected, reopened and archived through
 * services/resultExams — the same calls the screens make — so what the board
 * shows is what the rules produce, not numbers arranged to look right. Marks
 * are generated from a fixed seed, so two runs give the same school.
 *
 * Nothing it writes touches any other school.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db/orm');
const { query, end } = require('../db/pool');

for (const file of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
    if (file.endsWith('.js')) require(path.join(__dirname, '..', 'models', file));
}
const exams = require('../services/resultExams');
const M = (n) => db.model(n);
const has = (k) => process.argv.includes(`--${k}`);

const NAME = 'Result Demo School';
// A second, small school where one of the parents has another child — one
// person, a parent post at each school, on the same address.
const JUNIOR = 'Result Demo Junior School';
const DOMAIN = 'resultdemo.test';
const PASSWORD = 'ResultDemo@123';

/* ── a fixed seed, so the same marks come out every run ───────────────────── */
let seed = 20261001;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
/** Roughly normal: three uniforms summed have a standard deviation of a half, so doubling gives one. */
const bell = (mean, sd) => mean + (rnd() + rnd() + rnd() - 1.5) * 2 * sd;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const iso = (d) => d.toISOString().slice(0, 10);
/** n days from today, as a calendar day. */
const rel = (n) => { const d = new Date(); return day(d.getFullYear(), d.getMonth() + 1, d.getDate() + n); };

const FIRST = ['Aarav', 'Aditi', 'Aisha', 'Akash', 'Ananya', 'Arjun', 'Bhavya', 'Diya', 'Dhruv', 'Esha', 'Farhan', 'Gauri',
    'Harsh', 'Ishaan', 'Isha', 'Jatin', 'Kabir', 'Kavya', 'Krish', 'Lavanya', 'Manav', 'Meera', 'Mohit', 'Naina', 'Neha',
    'Nikhil', 'Pooja', 'Pranav', 'Priya', 'Rahul', 'Riya', 'Rohan', 'Saanvi', 'Sahil', 'Sara', 'Shreya', 'Siddharth', 'Sneha',
    'Tanvi', 'Tara', 'Uday', 'Varun', 'Vihaan', 'Yash', 'Zara', 'Zoya'];
const LAST = ['Agarwal', 'Bansal', 'Bose', 'Chopra', 'Das', 'Gupta', 'Iyer', 'Jain', 'Joshi', 'Kapoor', 'Khan', 'Kumar',
    'Malhotra', 'Mehta', 'Menon', 'Nair', 'Patel', 'Pillai', 'Rao', 'Reddy', 'Roy', 'Sen', 'Sethi', 'Shah', 'Sharma', 'Singh',
    'Thomas', 'Verma'];
const TEACHERS = ['Anita Deshmukh', 'Rajesh Kulkarni', 'Sunita Rao', 'Vikram Bhatia', 'Meenakshi Iyer', 'Imran Qureshi',
    'Pallavi Joshi', 'Suresh Menon', 'Kavita Sharma', 'Deepak Nair'];
const SUBJECTS = [
    ['English', 'ENG', 100, 33], ['Mathematics', 'MAT', 100, 33], ['Science', 'SCI', 100, 33],
    ['Social Science', 'SST', 100, 33], ['Hindi', 'HIN', 100, 33], ['Computer Science', 'CSC', 50, 17],
];

async function clear() {
    const { rows } = await query('SELECT "_id", "name" FROM "schools" WHERE "name" = ANY($1)', [[NAME, JUNIOR]]);
    for (const { _id, name } of rows) {
        const S = [String(_id)];
        // Three of these tables carry no school column: clear them through their parent.
        await query('DELETE FROM "exammarkssheets" WHERE "exam" IN (SELECT "_id" FROM "formalexams" WHERE "school" = $1)', S);
        await query('DELETE FROM "sectionsubjectteachers" WHERE "section" IN (SELECT "_id" FROM "classsections" WHERE "school" = $1)', S);
        await query('DELETE FROM "classsubjects" WHERE "class" IN (SELECT "_id" FROM "classes" WHERE "school" = $1)', S);
        for (const t of ['formalresults', 'formalexams', 'classtests', 'studentpromotionhistories', 'notificationreceipts', 'notifications',
            'parentprofiles', 'studentprofiles', 'teacherprofiles', 'classsections', 'classes', 'subjects', 'academicyears', 'users']) {
            await query(`DELETE FROM "${t}" WHERE "school" = $1`, S).catch(() => {});
        }
        await query('DELETE FROM "schools" WHERE "_id" = $1', S);
        console.log(`  removed ${name} (${S[0]})`);
    }
}

async function main() {
    await db.connect();
    await clear();
    if (has('clear')) { console.log('done (cleared)'); return; }

    const password = await bcrypt.hash(PASSWORD, 10);
    const school = await M('School').create({
        name: NAME, code: 'RDS', email: `office@${DOMAIN}`, city: 'Pune', state: 'Maharashtra', board: 'CBSE', isActive: true,
        modules: { result: true, attendance: true, notification: true, timetable: true, holiday: true, document: true },
    });
    const S = String(school._id);
    console.log(`school: ${NAME} (${S})`);

    const person = (role, name, n) => M('User').create({
        school: S, role, name, password, isActive: true, isFirstLogin: false,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${n === undefined ? '' : `.${n}`}@${DOMAIN}`,
    });
    const admin = await M('User').create({ school: S, role: 'school_admin', name: 'Admin Deepak', email: `admin@${DOMAIN}`, password, isActive: true, isFirstLogin: false });
    const ctx = { schoolId: S, userId: String(admin._id), userRole: 'school_admin' };
    const as = (teacher) => ({ schoolId: S, userId: String(teacher._id), userRole: 'teacher' });

    /* ── years, teachers ──────────────────────────────────────────────────── */
    const last = await M('AcademicYear').create({ school: S, yearName: '2025-26', startDate: day(2025, 4, 1), endDate: day(2026, 3, 31), status: 'inactive' });
    const year = await M('AcademicYear').create({ school: S, yearName: '2026-27', startDate: day(2026, 4, 1), endDate: day(2027, 3, 31), status: 'active' });

    const teachers = [];
    for (const [i, name] of TEACHERS.entries()) {
        const u = await person('teacher', name);
        await M('TeacherProfile').create({
            user: u._id, school: S, employeeId: `RDS-T${String(i + 1).padStart(2, '0')}`, department: 'Academics',
            designation: 'Teacher', staffType: 'teaching', gender: i % 2 ? 'male' : 'female', joiningDate: day(2021 + (i % 4), 6, 1 + i),
        });
        teachers.push(u);
    }

    /* ── one year's structure: subjects, classes, sections, students ──────── */
    let admission = 0;
    async function build(y, layout, studentsPer) {
        const subjects = [];
        for (const [subjectName, code] of SUBJECTS) {
            subjects.push(await M('Subject').create({ school: S, academicYear: y._id, subjectName, subjectCode: code, type: 'theory' }));
        }
        const sections = [];
        for (const [classNumber, names] of layout) {
            const cls = await M('Class').create({ school: S, academicYear: y._id, classNumber, className: `Class ${classNumber}`, status: 'active', createdBy: admin._id });
            for (const sub of subjects) await M('ClassSubject').create({ class: cls._id, subject: sub._id });
            for (const sectionName of names) {
                const ids = [];
                const count = studentsPer + Math.floor(rnd() * 5);
                const section = await M('ClassSection').create({ school: S, class: cls._id, academicYear: y._id, sectionName, maxStudents: 40, status: 'active' });
                for (let r = 1; r <= count; r += 1) {
                    admission += 1;
                    const name = `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`;
                    const u = await person('student', name, admission);
                    await M('StudentProfile').create({
                        user: u._id, school: S, currentClass: cls._id, currentSection: section._id, rollNumber: String(r),
                        admissionNumber: `RDS-${String(admission).padStart(4, '0')}`, gender: r % 2 ? 'Male' : 'Female',
                    });
                    // How this student tends to do, held across every exam and subject.
                    ids.push({ id: String(u._id), ability: clamp(bell(66, 15), 22, 97) });
                }
                await M('ClassSection').updateOne({ _id: section._id }, { $set: { enrolledStudents: ids.map((s) => s.id), currentCount: ids.length } });
                sections.push({ doc: section, cls, name: `${cls.className} – ${sectionName}`, students: ids, classNumber, sectionName });
            }
        }
        return { subjects, sections };
    }

    const now = await build(year, [[6, ['A', 'B']], [7, ['A', 'B']], [8, ['A', 'B', 'C']]], 22);
    const before = await build(last, [[6, ['A', 'B']]], 20);
    const sec = (key, from = now) => from.sections.find((s) => `${s.classNumber}${s.sectionName}` === key);

    // Who teaches what, where. Every section has a class teacher and a teacher
    // for every subject — except the two gaps the board exists to point out:
    // 7-B has no class teacher, and nobody teaches Computer Science in 8-C.
    const teaching = new Map();     // `${sectionId}:${subjectId}` → teacher
    async function staff({ sections, subjects }) {
        for (const [i, s] of sections.entries()) {
            const classTeacher = `${s.classNumber}${s.sectionName}` === '7B' && s.doc.academicYear === year._id ? null : teachers[i % teachers.length];
            if (classTeacher) await M('ClassSection').updateOne({ _id: s.doc._id }, { $set: { classTeacher: classTeacher._id } });
            s.classTeacher = classTeacher;
            for (const [j, sub] of subjects.entries()) {
                if (`${s.classNumber}${s.sectionName}` === '8C' && sub.subjectCode === 'CSC') continue;
                const teacher = teachers[(j * 2 + s.classNumber) % teachers.length];
                await M('SectionSubjectTeacher').create({ section: s.doc._id, subject: sub._id, teacher: teacher._id });
                teaching.set(`${s.doc._id}:${sub._id}`, teacher);
            }
        }
    }
    await staff(now);
    await staff(before);
    console.log(`  ${teachers.length} teachers, ${now.sections.length + before.sections.length} sections, ${admission} students`);

    /* ── exams ────────────────────────────────────────────────────────────── */
    const config = (subjects, scale = 1, dates = []) => subjects.map((s, i) => {
        const [, , max, pass] = SUBJECTS.find((x) => x[1] === s.subjectCode);
        // Every paper starts at 9:30; a full paper runs three hours, a short one ninety minutes.
        return {
            subject: String(s._id), maxMarks: Math.round(max * scale), passingMarks: Math.round(pass * scale),
            examDate: dates[i] ? iso(dates[i]) : null,
            ...(dates[i] ? { startTime: '09:30', endTime: Math.round(max * scale) >= 100 ? '12:30' : '11:00' } : null),
        };
    });
    // `options` are the Create Exam form's: code, description, includeInOverall, allowGraceMarks + grace…
    async function create(title, examType, sections, start, end, { from = now, scale = 1, publishDate, ...options } = {}) {
        const papers = from.subjects.map((_, i) => new Date(Math.min(end.getTime(), start.getTime() + i * 864e5)));
        const made = await exams.createExams(ctx, {
            title, examType, sectionIds: sections.map((s) => String(s.doc._id)), startDate: iso(start), endDate: iso(end),
            publishDate: publishDate ? iso(publishDate) : null, subjects: config(from.subjects, scale, papers), ...options,
        });
        return new Map(made.map((e) => [String(e.section), e]));
    }

    /** One subject's sheet, entered by whoever teaches it there (the office where nobody does). */
    async function enter(exam, section, subject, { submit = true, upTo } = {}) {
        const cfg = exam.subjects.find((s) => String(s.subject) === String(subject._id));
        const roll = upTo ? section.students.slice(0, upTo) : section.students;
        const entries = roll.map((st) => {
            if (rnd() < 0.03) return { student: st.id, isAbsent: true };
            const pct = clamp(bell(st.ability, 11) + (subject.subjectCode === 'MAT' ? -5 : subject.subjectCode === 'CSC' ? 6 : 0), 4, 99);
            return { student: st.id, marksObtained: Math.round((pct / 100) * cfg.maxMarks) };
        });
        const teacher = teaching.get(`${section.doc._id}:${subject._id}`);
        const live = await exams.load(ctx, exam._id);
        await exams.saveMarks(teacher ? as(teacher) : ctx, live, String(subject._id), entries, { submit, admin: !teacher });
    }
    const enterAll = async (exam, section, subjects) => { for (const sub of subjects) await enter(exam, section, sub); };
    const validate = (exam, section) => (section.classTeacher
        ? exams.validateExam(as(section.classTeacher), exam._id)
        : exams.validateExam(ctx, exam._id, { admin: true }));
    /** Published "then": the service stamps now; a demo reads better with the date it would have had. */
    async function publish(exam, when) {
        await exams.publishExam(ctx, exam._id);
        if (when) await query('UPDATE "formalexams" SET "finalApprovedAt" = $1 WHERE "_id" = $2', [when, String(exam._id)]);
    }
    async function finish(exam, section, subjects, when) {
        await exams.openMarksEntry(ctx, exam._id);
        await enterAll(exam, section, subjects);
        await validate(exam, section);
        await publish(exam, when);
    }

    // Unit Test 1 — July: published everywhere, then withdrawn in 8-C to correct a paper.
    const ut1 = await create('Unit Test 1', 'UNIT_TEST', now.sections, day(2026, 7, 13), day(2026, 7, 18),
        { scale: 0.5, code: 'UT1-2026', includeInOverall: true });
    for (const s of now.sections) await finish(ut1.get(String(s.doc._id)), s, now.subjects, new Date(2026, 6, 27, 11, 30));
    await exams.reopenExam(ctx, ut1.get(String(sec('8C').doc._id))._id, { reason: 'Science paper re-marked after a totalling error' });

    // Mid Term — September: one section at each step.
    // Counts towards the overall result, and carries a borderline student over by up to 3 marks in one subject.
    const mid = await create('Mid Term Examination', 'MID_TERM', now.sections, day(2026, 9, 14), day(2026, 9, 24), {
        code: 'MT2026', description: 'Chapters 1 to 6 in every subject. Calculators are not allowed.',
        includeInOverall: true, allowGraceMarks: true, grace: { perSubject: 3, maxSubjects: 1 },
    });
    const m = (key) => mid.get(String(sec(key).doc._id));
    await finish(m('6A'), sec('6A'), now.subjects, new Date(2026, 8, 30, 16, 10));                    // published
    await exams.openMarksEntry(ctx, m('6B')._id); await enterAll(m('6B'), sec('6B'), now.subjects);
    await validate(m('6B'), sec('6B'));                                                               // ready to publish
    await exams.openMarksEntry(ctx, m('7A')._id); await enterAll(m('7A'), sec('7A'), now.subjects);   // waiting for the class teacher
    await exams.openMarksEntry(ctx, m('7B')._id); await enterAll(m('7B'), sec('7B'), now.subjects);   // …and there is none
    await exams.openMarksEntry(ctx, m('8A')._id);
    for (const sub of now.subjects.slice(0, 3)) await enter(m('8A'), sec('8A'), sub);                 // three sheets in
    await enter(m('8A'), sec('8A'), now.subjects[3], { submit: false, upTo: 14 });                    // one half typed
    await exams.openMarksEntry(ctx, m('8B')._id); await enterAll(m('8B'), sec('8B'), now.subjects);
    await exams.rejectExam(as(sec('8B').classTeacher), m('8B')._id, 'Hindi marks are entered out of 50, not 100', { admin: false });
    await exams.openMarksEntry(ctx, m('8C')._id);
    for (const sub of now.subjects.filter((s) => s.subjectCode !== 'CSC')) await enter(m('8C'), sec('8C'), sub);   // Computer Science has no teacher

    // Unit Test 2 — just over, never opened.
    await create('Unit Test 2', 'UNIT_TEST', [sec('6A'), sec('6B')], rel(-9), rel(-4), { scale: 0.5, code: 'UT2-2026' });

    // Unit Test 3 — under way this week: a paper a day, one of them today.
    await create('Unit Test 3', 'UNIT_TEST', now.sections, rel(-2), rel(3), {
        scale: 0.5, code: 'UT3-2026', description: 'Chapters 7 to 9 in every subject. Bring your own geometry box; calculators are not allowed.',
    });

    // Final Examination — next March, results on a set day.
    await create('Final Examination', 'FINAL', now.sections, day(2027, 3, 1), day(2027, 3, 12),
        { publishDate: day(2027, 3, 25), code: 'FE2027', includeInOverall: true, promoteOnPass: true, promoteSection: 'same' });

    // Last year's final — published, then put away.
    const old = await create('Final Examination', 'FINAL', before.sections, day(2026, 3, 2), day(2026, 3, 13), { from: before, code: 'FE2026' });
    for (const s of before.sections) {
        const exam = old.get(String(s.doc._id));
        await finish(exam, s, before.subjects, new Date(2026, 2, 24, 10, 0));
        await exams.archiveExam(ctx, exam._id);
    }

    /* ── class tests: one in each state ───────────────────────────────────── */
    // Written as rows, the way the teacher's screen leaves them: there is no
    // service for class tests, only their handlers.
    const subj = (code) => now.subjects.find((x) => x.subjectCode === code);
    async function classTest(section, subject, title, { daysAgo, max = 20, pass = 8, status, topic = '', reason = '' }) {
        const teacher = teaching.get(`${section.doc._id}:${subject._id}`) || admin;
        const marks = status === 'DRAFT' ? [] : section.students.map((st) => {
            if (rnd() < 0.04) return { student: st.id, marksObtained: null, isAbsent: true, remarks: '', grade: '' };
            const m = Math.round((clamp(bell(st.ability, 12), 5, 100) / 100) * max);
            return { student: st.id, marksObtained: m, isAbsent: false, remarks: '', grade: exams.calcGrade((m / max) * 100) };
        });
        const scored = marks.filter((m) => !m.isAbsent).map((m) => m.marksObtained);
        const classStats = scored.length ? {
            average: Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100,
            highest: Math.max(...scored), lowest: Math.min(...scored),
            passPercent: Math.round((scored.filter((m) => m >= pass).length / scored.length) * 100),
        } : { average: null, highest: null, lowest: null, passPercent: null };
        const approved = status === 'FINAL_APPROVED';
        await M('ClassTest').create({
            school: S, section: section.doc._id, subject: subject._id, academicYear: section.doc.academicYear,
            title, topic, testDate: rel(-daysAgo), maxMarks: max, passingMarks: pass, status, rejectionReason: reason, marks, classStats,
            createdBy: teacher._id, approvedBy: approved ? (section.classTeacher?._id || admin._id) : null, approvedAt: approved ? rel(-daysAgo + 3) : null,
            auditLog: [{ action: 'CREATED', by: teacher._id }],
        });
    }
    await classTest(sec('6A'), subj('MAT'), 'Fractions quiz', { daysAgo: 40, status: 'FINAL_APPROVED', topic: 'Fractions' });
    await classTest(sec('6A'), subj('SCI'), 'Plants and their parts', { daysAgo: 30, status: 'FINAL_APPROVED', max: 25, pass: 10, topic: 'Plant life' });
    await classTest(sec('6A'), subj('ENG'), 'Grammar check', { daysAgo: 6, status: 'SUBMITTED', topic: 'Tenses' });
    await classTest(sec('6A'), subj('MAT'), 'Decimals quiz', { daysAgo: 1, status: 'DRAFT', topic: 'Decimals' });
    await classTest(sec('8B'), subj('MAT'), 'Algebra quiz', { daysAgo: 20, status: 'FINAL_APPROVED', topic: 'Linear equations' });
    await classTest(sec('8B'), subj('HIN'), 'Vyakaran test', { daysAgo: 12, status: 'REJECTED', reason: 'Marks for roll 5 to 9 look swapped' });

    /* ── parents: one child in 6-A; and two children, in 6-A and 8-B ─────── */
    async function parentOf(name, relationship, kids) {
        const u = await person('parent', name);
        await M('ParentProfile').create({ user: u._id, school: S, relationship, children: kids });
        await M('StudentProfile').updateMany({ user: { $in: kids } }, { $set: { parent: u._id } });
        return u;
    }
    await parentOf('Ramesh Patel', 'Father', [sec('6A').students[2].id]);
    await parentOf('Sunanda Rao', 'Mother', [sec('6A').students[4].id, sec('8B').students[1].id]);

    /* ── the junior school: the same parent, another child ────────────────── */
    const junior = await M('School').create({
        name: JUNIOR, code: 'RDJ', email: `junior@${DOMAIN}`, city: 'Pune', state: 'Maharashtra', board: 'CBSE', isActive: true,
        modules: { result: true, attendance: true, notification: true, timetable: true, holiday: true },
    });
    const J = String(junior._id);
    const jAdmin = await M('User').create({ school: J, role: 'school_admin', name: 'Junior Office', email: `admin.junior@${DOMAIN}`, password, isActive: true, isFirstLogin: false });
    const jYear = await M('AcademicYear').create({ school: J, yearName: '2026-27', startDate: day(2026, 4, 1), endDate: day(2027, 3, 31), status: 'active' });
    const jClass = await M('Class').create({ school: J, academicYear: jYear._id, classNumber: 3, className: 'Class 3', status: 'active', createdBy: jAdmin._id });
    const jTeacher = await M('User').create({ school: J, role: 'teacher', name: 'Lata Kelkar', email: `lata.kelkar@${DOMAIN}`, password, isActive: true, isFirstLogin: false });
    const jSection = await M('ClassSection').create({ school: J, class: jClass._id, academicYear: jYear._id, sectionName: 'A', maxStudents: 30, status: 'active', classTeacher: jTeacher._id });
    const jSubjects = [];
    for (const [subjectName, code] of [['English', 'ENG'], ['Mathematics', 'MAT'], ['Environmental Studies', 'EVS']]) {
        const sub = await M('Subject').create({ school: J, academicYear: jYear._id, subjectName, subjectCode: code, type: 'theory' });
        await M('ClassSubject').create({ class: jClass._id, subject: sub._id });
        await M('SectionSubjectTeacher').create({ section: jSection._id, subject: sub._id, teacher: jTeacher._id });
        jSubjects.push(sub);
    }
    const jKids = [];
    for (const [i, name] of ['Meera Rao', 'Kabir Shah', 'Tara Joshi', 'Yash Nair', 'Zoya Khan', 'Rohan Sen'].entries()) {
        const u = await M('User').create({ school: J, role: 'student', name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.j${i + 1}@${DOMAIN}`, password, isActive: true, isFirstLogin: false });
        await M('StudentProfile').create({ user: u._id, school: J, currentClass: jClass._id, currentSection: jSection._id, rollNumber: String(i + 1), admissionNumber: `RDJ-${String(i + 1).padStart(4, '0')}` });
        jKids.push(String(u._id));
    }
    await M('ClassSection').updateOne({ _id: jSection._id }, { $set: { enrolledStudents: jKids, currentCount: jKids.length } });
    // Sunanda Rao's post at this school: the same address, so the same person.
    const sunandaThere = await M('User').create({ school: J, role: 'parent', name: 'Sunanda Rao', email: `sunanda.rao@${DOMAIN}`, password, isActive: true, isFirstLogin: false });
    await M('ParentProfile').create({ user: sunandaThere._id, school: J, relationship: 'Mother', children: [jKids[0]] });
    await M('StudentProfile').updateOne({ user: jKids[0] }, { $set: { parent: sunandaThere._id } });
    // Its own exam, next week, with times.
    await exams.createExams({ schoolId: J, userId: String(jAdmin._id), userRole: 'school_admin' }, {
        title: 'Term 1 Assessment', examType: 'MID_TERM', code: 'T1-JR', sectionIds: [String(jSection._id)],
        startDate: iso(rel(4)), endDate: iso(rel(6)), description: 'Short written papers. Children should carry a water bottle and their own pencils.',
        subjects: jSubjects.map((sub, i) => ({ subject: String(sub._id), maxMarks: 50, passingMarks: 17, examDate: iso(rel(4 + i)), startTime: '10:00', endTime: '11:30' })),
    });

    // Let the notices the steps above queued be written before the pool closes.
    await new Promise((r) => setTimeout(r, 1500));

    const { rows } = await query(
        `SELECT "status", ("archivedAt" IS NOT NULL) AS "archived", count(*)::int AS "n"
           FROM "formalexams" WHERE "school" = $1 GROUP BY 1, 2 ORDER BY 2, 1`, [S]);
    console.log('  exams:', rows.map((r) => `${r.n} ${r.status}${r.archived ? ' (archived)' : ''}`).join(', '));
    console.log(`\nSign in as  admin@${DOMAIN}  /  ${PASSWORD}`);
    console.log(`Teachers:   ${TEACHERS[0].toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN} (and the other nine), same password`);
    console.log(`Parents:    ramesh.patel@${DOMAIN} (one child), sunanda.rao@${DOMAIN} (two children here, a third at ${JUNIOR}), same password`);
    const kid = await M('User').findById(sec('6A').students[4].id).select('email').lean();
    console.log(`Students:   e.g. ${kid?.email} (6-A, a child of the second parent), same password`);
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(async () => { await end().catch(() => {}); process.exit(); });
