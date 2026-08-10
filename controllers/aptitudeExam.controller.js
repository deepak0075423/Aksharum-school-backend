'use strict';
const AptitudeExam     = require('../models/AptitudeExam');
const AptitudeQuestion = require('../models/AptitudeQuestion');
const ExamAttempt      = require('../models/ExamAttempt');
const AcademicYear     = require('../models/AcademicYear');
const ClassSection     = require('../models/ClassSection');
const StudentProfile   = require('../models/StudentProfile');
const ParentProfile    = require('../models/ParentProfile');

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function scoreAttempt(questions, answers) {
    let score = 0;
    const ansMap = Object.fromEntries((answers || []).map(a => [a.question.toString(), a.selectedOptions || []]));
    for (const q of questions) {
        const selected = ansMap[q._id.toString()] || [];
        const correct  = q.correctAnswers || [];
        const isCorrect = selected.length === correct.length &&
            correct.every(c => selected.includes(c)) &&
            selected.every(s => correct.includes(s));
        if (isCorrect) score += q.marks;
    }
    return score;
}

async function getActiveYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
}

// ── Admin ─────────────────────────────────────────────────────────────────────

exports.getAdminExams = async (req, res) => {
    try {
        const { status, sectionId, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (status)    filter.status  = status;
        if (sectionId) filter.section = sectionId;

        const [exams, total] = await Promise.all([
            AptitudeExam.find(filter)
                .populate('section',     'sectionName')
                .populate('subject',     'subjectName')
                .populate('createdBy',   'name')
                .populate('academicYear','yearName')
                .sort({ examDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            AptitudeExam.countDocuments(filter),
        ]);
        res.json({ success: true, data: exams, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Exams CRUD ───────────────────────────────────────────────────────

// Sections the teacher owns (class teacher / substitute) or teaches via timetable,
// plus subjects and the active academic year — feeds the create/edit exam form.
exports.getExamMeta = async (req, res) => {
    try {
        const Timetable      = require('../models/Timetable');
        const TimetableEntry = require('../models/TimetableEntry');
        const Subject        = require('../models/Subject');

        const [ownSections, timetableIds, subjects, academicYear] = await Promise.all([
            ClassSection.find({
                school: req.schoolId, status: 'active',
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            }).populate('class', 'name className').lean(),
            TimetableEntry.find({ teacher: req.userId }).distinct('timetable'),
            Subject.find({ school: req.schoolId }).sort('subjectName').lean(),
            getActiveYear(req.schoolId),
        ]);

        const timetables = await Timetable.find({ _id: { $in: timetableIds } }).select('section').lean();
        const sectionIds = timetables.map(t => t.section).filter(Boolean);
        const taughtSections = await ClassSection.find({
            _id: { $in: sectionIds }, school: req.schoolId, status: 'active',
        }).populate('class', 'name className').lean();

        const map = {};
        [...ownSections, ...taughtSections].forEach(s => { map[s._id.toString()] = s; });

        res.json({ success: true, data: { sections: Object.values(map), subjects, academicYear } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getTeacherExams = async (req, res) => {
    try {
        const { status } = req.query;
        const section = await ClassSection.findOne({
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            school: req.schoolId,
        }).lean();

        const orConds = [{ createdBy: req.userId }];
        if (section) orConds.push({ section: section._id });

        const filter = { school: req.schoolId, $or: orConds };
        if (status) filter.status = status;

        const exams = await AptitudeExam.find(filter)
            .populate('section',     'sectionName')
            .populate('subject',     'subjectName')
            .populate('academicYear','yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const qCounts = await AptitudeQuestion.aggregate([
            { $match: { exam: { $in: examIds } } },
            { $group: { _id: '$exam', count: { $sum: 1 } } },
        ]);
        const qMap = Object.fromEntries(qCounts.map(q => [q._id.toString(), q.count]));
        const data = exams.map(e => ({ ...e, questionCount: qMap[e._id.toString()] || 0 }));

        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createExam = async (req, res) => {
    try {
        const { sectionId, subjectId, title, examDate, startTime, duration, totalQuestions, totalMarks, maxViolations } = req.body;
        if (!sectionId || !title || !examDate || !startTime || !duration || !totalQuestions || !totalMarks)
            return res.status(400).json({ success: false, message: 'sectionId, title, examDate, startTime, duration, totalQuestions and totalMarks are required' });

        const ay = await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const exam = await AptitudeExam.create({
            school: req.schoolId, section: sectionId, academicYear: ay._id,
            subject: subjectId || null, createdBy: req.userId,
            title: title.trim(), examDate: new Date(examDate), startTime,
            duration: +duration, totalQuestions: +totalQuestions, totalMarks: +totalMarks,
            maxViolations: +maxViolations || 3,
        });
        res.status(201).json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getExamDetail = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('section',     'sectionName')
            .populate('subject',     'subjectName')
            .populate('academicYear','yearName')
            .populate('createdBy',   'name')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const qCount = await AptitudeQuestion.countDocuments({ exam: exam._id });
        res.json({ success: true, data: { ...exam, questionCount: qCount } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft exams can be edited' });

        const { title, examDate, startTime, duration, totalQuestions, totalMarks, maxViolations, subjectId } = req.body;
        if (title)          exam.title          = title.trim();
        if (examDate)       exam.examDate       = new Date(examDate);
        if (startTime)      exam.startTime      = startTime;
        if (duration)       exam.duration       = +duration;
        if (totalQuestions) exam.totalQuestions = +totalQuestions;
        if (totalMarks)     exam.totalMarks     = +totalMarks;
        if (maxViolations)  exam.maxViolations  = +maxViolations;
        if (subjectId !== undefined) exam.subject = subjectId || null;
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft exams can be deleted' });
        await Promise.all([
            AptitudeExam.deleteOne({ _id: exam._id }),
            AptitudeQuestion.deleteMany({ exam: exam._id }),
            ExamAttempt.deleteMany({ exam: exam._id }),
        ]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.publishExam = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft exams can be published' });

        const qCount = await AptitudeQuestion.countDocuments({ exam: exam._id });
        if (qCount < exam.totalQuestions)
            return res.status(400).json({ success: false, message: `Exam has ${qCount} questions but requires ${exam.totalQuestions}` });

        exam.status = 'published';
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Questions ────────────────────────────────────────────────────────

exports.getQuestions = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        const questions = await AptitudeQuestion.find({ exam: exam._id }).sort({ order: 1 }).lean();
        res.json({ success: true, data: questions });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.addQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Cannot add questions to a published exam' });

        const { questionText, questionType, options, correctAnswers, marks } = req.body;
        if (!questionText || !questionType || !correctAnswers?.length || !marks)
            return res.status(400).json({ success: false, message: 'questionText, questionType, correctAnswers and marks are required' });

        const lastQ = await AptitudeQuestion.findOne({ exam: exam._id }).sort({ order: -1 }).lean();
        const order = (lastQ?.order || 0) + 1;

        const q = await AptitudeQuestion.create({
            exam: exam._id, school: req.schoolId,
            questionText: questionText.trim(), questionType,
            options: options || [], correctAnswers, marks: +marks, order,
        });
        res.status(201).json({ success: true, data: q });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Cannot edit questions of a published exam' });

        const { questionText, questionType, options, correctAnswers, marks } = req.body;
        const update = {};
        if (questionText   !== undefined) update.questionText   = questionText.trim();
        if (questionType   !== undefined) update.questionType   = questionType;
        if (options        !== undefined) update.options        = options;
        if (correctAnswers !== undefined) update.correctAnswers = correctAnswers;
        if (marks          !== undefined) update.marks          = +marks;

        const q = await AptitudeQuestion.findOneAndUpdate(
            { _id: req.params.qid, exam: exam._id },
            update,
            { new: true }
        ).lean();
        if (!q) return res.status(404).json({ success: false, message: 'Question not found' });
        res.json({ success: true, data: q });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteQuestion = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'draft') return res.status(400).json({ success: false, message: 'Cannot delete questions of a published exam' });

        const q = await AptitudeQuestion.findOneAndDelete({ _id: req.params.qid, exam: exam._id });
        if (!q) return res.status(404).json({ success: false, message: 'Question not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Submissions & Analytics ─────────────────────────────────────────

exports.getSubmissions = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const [questions, allAttempts] = await Promise.all([
            AptitudeQuestion.find({ exam: exam._id }).lean(),
            ExamAttempt.find({ exam: exam._id }).populate('student', 'name rollNumber email').lean(),
        ]);

        const data = allAttempts.map(a => ({
            _id:           a._id,
            student:       a.student,
            status:        a.status,
            startedAt:     a.startedAt,
            submittedAt:   a.submittedAt,
            violationCount:a.violationCount,
            score: ['submitted','auto_submitted'].includes(a.status) ? scoreAttempt(questions, a.answers) : null,
        }));

        res.json({ success: true, data, totalMarks: exam.totalMarks });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStudentResponse = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const attempt   = await ExamAttempt.findOne({ exam: exam._id, student: req.params.studentId }).lean();
        if (!attempt)   return res.status(404).json({ success: false, message: 'No attempt found' });

        const questions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        const score     = scoreAttempt(questions, attempt.answers || []);

        res.json({ success: true, data: { attempt, questions, score, totalMarks: exam.totalMarks } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getAnalytics = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const [attempts, questions] = await Promise.all([
            ExamAttempt.find({ exam: exam._id }).lean(),
            AptitudeQuestion.find({ exam: exam._id }).lean(),
        ]);

        const submitted = attempts.filter(a => ['submitted','auto_submitted'].includes(a.status));
        const scores    = submitted.map(a => scoreAttempt(questions, a.answers));
        const avg       = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
        const highest   = scores.length ? Math.max(...scores) : 0;
        const lowest    = scores.length ? Math.min(...scores) : 0;
        const passed    = scores.filter(s => s >= exam.totalMarks * 0.4).length;

        const qStats = questions.map(q => {
            let correct = 0;
            for (const a of submitted) {
                const ans = (a.answers || []).find(x => x.question.toString() === q._id.toString());
                const sel = ans?.selectedOptions || [];
                const cor = q.correctAnswers || [];
                if (sel.length === cor.length && cor.every(c => sel.includes(c)) && sel.every(s => cor.includes(s)))
                    correct++;
            }
            return { question: q._id, questionText: q.questionText, attemptedBy: submitted.length, correctCount: correct };
        });

        res.json({
            success: true,
            data: {
                totalStudents: attempts.length,
                submitted: submitted.length,
                notStarted: attempts.filter(a => a.status === 'not_started').length,
                avgScore: Math.round(avg * 100) / 100,
                highest, lowest, passed,
                questionStats: qStats,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Two-Step Result Approval ─────────────────────────────────────────

exports.getResultApproval = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('subjectTeacherApprovedBy', 'name')
            .populate('resultApprovedBy', 'name')
            .lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.subjectApproveResults = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId, createdBy: req.userId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.status !== 'completed') return res.status(400).json({ success: false, message: 'Exam must be completed first' });

        exam.subjectTeacherApprovalStatus = 'approved';
        exam.subjectTeacherApprovedBy     = req.userId;
        exam.subjectTeacherApprovedAt     = new Date();
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.approveResults = async (req, res) => {
    try {
        const { action, reason, resultPublishDate } = req.body;
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId });
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.subjectTeacherApprovalStatus !== 'approved')
            return res.status(400).json({ success: false, message: 'Subject teacher must approve first' });

        exam.resultApprovedBy = req.userId;
        exam.resultApprovedAt = new Date();
        if (action === 'approve') {
            exam.resultApprovalStatus = 'approved';
            if (resultPublishDate) exam.resultPublishDate = new Date(resultPublishDate);
        } else {
            exam.resultApprovalStatus  = 'rejected';
            exam.resultRejectionReason = reason || '';
        }
        await exam.save();
        res.json({ success: true, data: exam });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Exams ────────────────────────────────────────────────────────────

exports.getStudentExams = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const exams = await AptitudeExam.find({
            school: req.schoolId, section: profile.currentSection, status: 'published',
        })
            .populate('subject',     'subjectName')
            .populate('academicYear','yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const attempts = await ExamAttempt.find({ student: req.userId, exam: { $in: examIds } })
            .select('exam status submittedAt')
            .lean();
        const attemptMap = Object.fromEntries(attempts.map(a => [a.exam.toString(), a]));

        const now  = new Date();
        const data = exams.map(e => {
            const attempt   = attemptMap[e._id.toString()];
            const examStart = new Date(`${e.examDate.toISOString().slice(0,10)}T${e.startTime}:00`);
            const examEnd   = new Date(examStart.getTime() + e.duration * 60 * 1000);
            return { ...e, attempt: attempt || null, canAttempt: now >= examStart && now <= examEnd };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getAttemptExam = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.status(400).json({ success: false, message: 'Not enrolled in a section' });

        const exam = await AptitudeExam.findOne({
            _id: req.params.id, school: req.schoolId, section: profile.currentSection, status: 'published',
        }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

        const now       = new Date();
        const examStart = new Date(`${exam.examDate.toISOString().slice(0,10)}T${exam.startTime}:00`);
        const examEnd   = new Date(examStart.getTime() + exam.duration * 60 * 1000);

        let attempt = await ExamAttempt.findOne({ exam: exam._id, student: req.userId });

        if (attempt && ['submitted','auto_submitted'].includes(attempt.status))
            return res.status(400).json({ success: false, message: 'Exam already submitted' });

        if (now > examEnd && !attempt)
            return res.status(400).json({ success: false, message: 'Exam time has ended' });

        if (!attempt) {
            if (now < examStart) return res.status(400).json({ success: false, message: 'Exam has not started yet' });

            const questions    = await AptitudeQuestion.find({ exam: exam._id }).lean();
            const shuffledQs   = shuffle(questions);
            const questionOrder = shuffledQs.map(q => q._id);
            const optionOrders  = shuffledQs.map(q => ({
                question: q._id,
                options:  shuffle(q.options || []),
            }));
            const serverEndTime = new Date(Math.min(
                now.getTime() + exam.duration * 60 * 1000,
                examEnd.getTime()
            ));
            attempt = await ExamAttempt.create({
                exam: exam._id, student: req.userId, school: req.schoolId,
                section: profile.currentSection,
                questionOrder, optionOrders, answers: [],
                startedAt: now, serverEndTime, status: 'in_progress',
            });
        }

        const qMap = {};
        const allQuestions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        allQuestions.forEach(q => { qMap[q._id.toString()] = q; });

        const shuffledQuestions = attempt.questionOrder.map(qid => {
            const q       = qMap[qid.toString()];
            if (!q) return null;
            const optOrder = attempt.optionOrders.find(o => o.question.toString() === qid.toString());
            return {
                _id:          q._id,
                questionText: q.questionText,
                questionType: q.questionType,
                marks:        q.marks,
                options:      optOrder ? optOrder.options : q.options,
            };
        }).filter(Boolean);

        res.json({
            success: true,
            data: {
                exam:          { _id: exam._id, title: exam.title, totalMarks: exam.totalMarks, duration: exam.duration, maxViolations: exam.maxViolations },
                questions:     shuffledQuestions,
                savedAnswers:  attempt.answers || [],
                startedAt:     attempt.startedAt,
                serverEndTime: attempt.serverEndTime,
                violationCount:attempt.violationCount,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.saveAnswer = async (req, res) => {
    try {
        const { questionId, selectedOptions } = req.body;
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt found' });

        if (new Date() > attempt.serverEndTime) {
            attempt.status      = 'auto_submitted';
            attempt.submittedAt = attempt.serverEndTime;
            await attempt.save();
            return res.status(400).json({ success: false, message: 'Time ended — auto submitted' });
        }

        const idx = attempt.answers.findIndex(a => a.question.toString() === questionId);
        if (idx >= 0) {
            attempt.answers[idx].selectedOptions = selectedOptions;
            attempt.answers[idx].savedAt         = new Date();
        } else {
            attempt.answers.push({ question: questionId, selectedOptions, savedAt: new Date() });
        }
        attempt.markModified('answers');
        await attempt.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.logViolation = async (req, res) => {
    try {
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt' });

        const exam = await AptitudeExam.findById(req.params.id).lean();
        attempt.violationCount += 1;
        const autoSubmit = attempt.violationCount >= (exam?.maxViolations || 3);
        if (autoSubmit) {
            attempt.status      = 'auto_submitted';
            attempt.submittedAt = new Date();
        }
        await attempt.save();
        res.json({ success: true, violationCount: attempt.violationCount, autoSubmitted: autoSubmit });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.submitExam = async (req, res) => {
    try {
        const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.userId, status: 'in_progress' });
        if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt or already submitted' });

        attempt.status      = 'submitted';
        attempt.submittedAt = new Date();
        await attempt.save();

        // Mark exam completed if all enrolled students submitted
        const exam    = await AptitudeExam.findById(req.params.id).lean();
        const section = await ClassSection.findById(exam?.section).lean();
        const total   = (section?.enrolledStudents || []).length;
        const done    = await ExamAttempt.countDocuments({ exam: exam._id, status: { $in: ['submitted','auto_submitted'] } });
        if (total > 0 && done >= total) {
            await AptitudeExam.updateOne({ _id: exam._id }, { status: 'completed' });
        }

        res.json({ success: true, message: 'Exam submitted successfully' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStudentResult = async (req, res) => {
    try {
        const exam = await AptitudeExam.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });
        if (exam.resultApprovalStatus !== 'approved')
            return res.status(403).json({ success: false, message: 'Results not yet published' });
        if (exam.resultPublishDate && new Date() < new Date(exam.resultPublishDate))
            return res.status(403).json({ success: false, message: 'Results not yet published' });

        const attempt = await ExamAttempt.findOne({ exam: exam._id, student: req.userId }).lean();
        if (!attempt) return res.status(404).json({ success: false, message: 'No attempt found' });

        const questions = await AptitudeQuestion.find({ exam: exam._id }).lean();
        const score     = scoreAttempt(questions, attempt.answers || []);

        const ansMap = Object.fromEntries((attempt.answers || []).map(a => [a.question.toString(), a.selectedOptions || []]));
        const result = questions.map(q => {
            const selected  = ansMap[q._id.toString()] || [];
            const correct   = q.correctAnswers || [];
            const isCorrect = selected.length === correct.length &&
                correct.every(c => selected.includes(c)) && selected.every(s => correct.includes(s));
            return { ...q, selected, isCorrect, earnedMarks: isCorrect ? q.marks : 0 };
        });

        res.json({
            success: true,
            data: {
                exam:        { title: exam.title, totalMarks: exam.totalMarks },
                score,
                percentage:  Math.round((score / exam.totalMarks) * 100),
                passed:      score >= exam.totalMarks * 0.4,
                submittedAt: attempt.submittedAt,
                questions:   result,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: view child's aptitude exam results ────────────────────────────────
exports.getParentExamResults = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.json({ success: true, data: [] });

        const profile = await StudentProfile.findOne({ user: childId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const exams = await AptitudeExam.find({
            school: req.schoolId, section: profile.currentSection,
            status: 'published', resultApprovalStatus: 'approved',
        })
            .populate('subject',      'subjectName')
            .populate('academicYear', 'yearName')
            .sort({ examDate: -1 })
            .lean();

        const examIds = exams.map(e => e._id);
        const [attempts, questions] = await Promise.all([
            ExamAttempt.find({ student: childId, exam: { $in: examIds }, status: { $in: ['submitted', 'auto_submitted'] } })
                .select('exam answers submittedAt status')
                .lean(),
            AptitudeQuestion.find({ exam: { $in: examIds } }).lean(),
        ]);
        const qByExam = {};
        questions.forEach(q => {
            const k = q.exam.toString();
            (qByExam[k] = qByExam[k] || []).push(q);
        });
        const attemptMap = {};
        for (const a of attempts) {
            const k = a.exam.toString();
            const score = scoreAttempt(qByExam[k] || [], a.answers || []);
            attemptMap[k] = { _id: a._id, submittedAt: a.submittedAt, status: a.status, score };
        }

        const data = exams.map(e => {
            const a = attemptMap[e._id.toString()] || null;
            return {
                ...e,
                attempt: a && {
                    ...a,
                    percentage: e.totalMarks ? Math.round((a.score / e.totalMarks) * 100) : 0,
                    passed:     a.score >= e.totalMarks * 0.4,
                },
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
