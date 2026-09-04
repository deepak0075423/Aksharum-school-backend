'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback — administration & school-wide analytics.
//
//  Two audiences share this controller:
//    • school_admin — full configuration + analytics + exports
//    • principal    — a teacher whose designation is Principal / Vice Principal:
//                     read-only school-wide analytics and reports. The routes
//                     gate this (adminGuard vs analyticsGuard); every handler
//                     here additionally scopes on req.schoolId so a caller can
//                     never reach another school's data.
//
//  Anonymity is preserved on every path in this file: no handler returns the
//  pairing of a student with the content of their feedback. The admin sees who
//  has SUBMITTED (needed to chase pending responses) but never what they said.
// ─────────────────────────────────────────────────────────────────────────────
const XLSX = require('xlsx');

const FeedbackCampaign         = require('../models/FeedbackCampaign');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const FeedbackCategory         = require('../models/FeedbackCategory');
const FeedbackQuestion         = require('../models/FeedbackQuestion');
const FeedbackQuestionOption   = require('../models/FeedbackQuestionOption');
const FeedbackAssignment       = require('../models/FeedbackAssignment');
const FeedbackResponse         = require('../models/FeedbackResponse');
const FeedbackSelectedOption   = require('../models/FeedbackSelectedOption');
const FeedbackSettings         = require('../models/FeedbackSettings');
const FeedbackTemplate         = require('../models/FeedbackTemplate');
const FeedbackAuditLog         = require('../models/FeedbackAuditLog');

const User                  = require('../models/User');
const Subject               = require('../models/Subject');
const Class                 = require('../models/Class');
const ClassSection          = require('../models/ClassSection');
const AcademicYear          = require('../models/AcademicYear');
const TeacherProfile        = require('../models/TeacherProfile');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

const fb = require('../services/feedbackService');
const { notify, schoolAdminIds } = require('../services/notifyService');
const { buildFeedbackReportPDF } = require('../utils/feedbackReportPdf');

const ok   = (res, data) => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e) => {
    console.error('[feedback:admin]', e);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
const sid = fb.sid;

const str  = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bool = (v, dflt = false) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 'true' || v === 1 || v === '1');
const int  = (v, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : dflt;
};
const idList = (v) => (Array.isArray(v) ? v : [])
    .map((x) => sid(x)).filter((x) => /^[0-9a-f-]{36}$/i.test(x));

const paginate = (req, dfltLimit = 20) => {
    const page  = Math.max(1, int(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, int(req.query.limit, dfltLimit)));
    return { page, limit, skip: (page - 1) * limit };
};

// ═════════════════════════════════════════════════════════════════════════════
//  META — dropdown sources for every admin screen
// ═════════════════════════════════════════════════════════════════════════════
exports.getMeta = async (req, res) => {
    try {
        const school = req.schoolId;
        const activeYear = await fb.activeAcademicYear(school);

        const [years, classes, sections, subjects, teachers, profiles, templates] = await Promise.all([
            AcademicYear.find({ school }).select('yearName status startDate').sort({ startDate: -1 }).lean(),
            Class.find({ school, status: 'active' }).select('className classNumber academicYear').sort({ classNumber: 1 }).lean(),
            ClassSection.find({ school, status: 'active' }).select('sectionName class academicYear').lean(),
            // Per-year subjects — narrowed to the active year after the await,
            // or this picker would list every name once per academic year.
            Subject.find({ school }).select('subjectName subjectCode academicYear').sort({ subjectName: 1 }).lean(),
            User.find({ school, role: 'teacher', isActive: true }).select('name email').sort({ name: 1 }).lean(),
            TeacherProfile.find({ school }).select('user department designation employeeId').lean(),
            FeedbackTemplate.find({ school, status: 'active' }).select('name description isDefault questions').sort({ name: 1 }).lean(),
        ]);

        const profByUser = new Map(profiles.map((p) => [sid(p.user), p]));
        const departments = [...new Set(profiles.map((p) => (p.department || '').trim()).filter(Boolean))].sort();

        ok(res, {
            activeYear: activeYear ? { _id: sid(activeYear._id), yearName: activeYear.yearName } : null,
            academicYears: years.map((y) => ({ _id: sid(y._id), yearName: y.yearName, status: y.status })),
            classes: classes.map((c) => ({ _id: sid(c._id), className: c.className, classNumber: c.classNumber, academicYear: sid(c.academicYear) })),
            sections: sections.map((s) => ({ _id: sid(s._id), sectionName: s.sectionName, class: sid(s.class), academicYear: sid(s.academicYear) })),
            // Carries its year, exactly as classes and sections above do, so the
            // picker can narrow by year rather than listing one name per year.
            subjects: subjects.map((s) => ({ _id: sid(s._id), subjectName: s.subjectName, subjectCode: s.subjectCode || '', academicYear: sid(s.academicYear) })),
            teachers: teachers.map((t) => ({
                _id: sid(t._id), name: t.name, email: t.email,
                department: profByUser.get(sid(t._id))?.department || '',
                designation: profByUser.get(sid(t._id))?.designation || '',
            })),
            departments,
            templates: templates.map((t) => ({
                _id: sid(t._id), name: t.name, description: t.description,
                isDefault: !!t.isDefault, questionCount: (t.questions || []).length,
            })),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
const SETTING_FIELDS = [
    'defaultAnonymous', 'defaultMinimumResponses', 'defaultCampaignDays',
    'teacherCanSeeComments', 'teacherCanSeeTrends', 'publishToTeachersOnClose',
    'notifyOnCampaignStart', 'notifyReminders', 'reminderIntervalDays',
    'notifyBeforeClose', 'closingSoonDays', 'notifyOnSubmission',
    'emailNotifications', 'autoActivateScheduled', 'autoCloseExpired',
];

exports.getSettings = async (req, res) => {
    try { ok(res, await fb.getSettings(req.schoolId)); } catch (e) { fail(res, e); }
};

exports.updateSettings = async (req, res) => {
    try {
        await fb.getSettings(req.schoolId);                       // ensure the row exists
        const $set = { updatedBy: req.userId };
        for (const f of SETTING_FIELDS) {
            if (req.body[f] === undefined) continue;
            if (['defaultMinimumResponses', 'defaultCampaignDays', 'reminderIntervalDays', 'closingSoonDays'].includes(f)) {
                $set[f] = Math.max(f === 'defaultMinimumResponses' ? 1 : 0, int(req.body[f], 1));
            } else {
                $set[f] = bool(req.body[f]);
            }
        }
        await FeedbackSettings.updateOne({ school: req.schoolId }, { $set });
        await fb.logAudit(req, 'update', 'Settings', null, 'Updated feedback settings', { meta: $set });
        ok(res, await fb.getSettings(req.schoolId));
    } catch (e) { fail(res, e); }
};

// One-touch bootstrap: default categories + question bank + template.
exports.seedDefaults = async (req, res) => {
    try {
        const created = await fb.seedDefaults(req.schoolId, req.userId);
        await fb.logAudit(req, 'seed', 'Question', null, 'Seeded default feedback configuration', { meta: created });
        ok(res, created);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CATEGORIES (spec §13)
// ═════════════════════════════════════════════════════════════════════════════
exports.getCategories = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.status) filter.status = str(req.query.status, 20);
        const rows = await FeedbackCategory.find(filter).sort({ displayOrder: 1, name: 1 }).lean();

        // Usage count decides whether a category may be deleted (rule 14).
        const counts = await FeedbackQuestion.find({ school: req.schoolId, status: { $ne: 'archived' } })
            .select('category').lean();
        const used = counts.reduce((acc, q) => {
            const k = sid(q.category);
            if (k) acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {});
        ok(res, rows.map((c) => ({ ...c, questionCount: used[sid(c._id)] || 0 })));
    } catch (e) { fail(res, e); }
};

exports.createCategory = async (req, res) => {
    try {
        const name = str(req.body.name, 120);
        if (!name) return bad(res, 'Category name is required.');
        const row = await FeedbackCategory.create({
            school: req.schoolId, name,
            description: str(req.body.description, 500),
            displayOrder: int(req.body.displayOrder, 0),
            createdBy: req.userId,
        });
        await fb.logAudit(req, 'create', 'Category', row._id, `Created category "${name}"`);
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists.', 409);
        fail(res, e);
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const row = await FeedbackCategory.findOne({ _id: req.params.id, school: req.schoolId });
        if (!row) return bad(res, 'Category not found.', 404);
        const $set = {};
        if (req.body.name !== undefined)         $set.name = str(req.body.name, 120);
        if (req.body.description !== undefined)  $set.description = str(req.body.description, 500);
        if (req.body.displayOrder !== undefined) $set.displayOrder = int(req.body.displayOrder, 0);
        if (req.body.status !== undefined && ['active', 'inactive', 'archived'].includes(req.body.status)) {
            $set.status = req.body.status;
        }
        if ($set.name === '') return bad(res, 'Category name is required.');
        await FeedbackCategory.updateOne({ _id: row._id }, { $set });
        await fb.logAudit(req, 'update', 'Category', row._id, `Updated category "${$set.name || row.name}"`);
        ok(res, await FeedbackCategory.findById(row._id).lean());
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists.', 409);
        fail(res, e);
    }
};

// Deletion is only allowed while nothing references the category; otherwise the
// caller is steered to archiving, so historical feedback stays readable.
exports.deleteCategory = async (req, res) => {
    try {
        const row = await FeedbackCategory.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Category not found.', 404);
        const [inBank, inHistory] = await Promise.all([
            FeedbackQuestion.countDocuments({ category: row._id }),
            FeedbackResponse.countDocuments({ category: row._id }),
        ]);
        if (inHistory > 0) {
            return bad(res, 'This category is used by existing feedback and cannot be deleted. Set it to Archived instead.', 409);
        }
        if (inBank > 0) {
            return bad(res, `This category is used by ${inBank} question(s). Move or delete them first, or archive the category.`, 409);
        }
        await FeedbackCategory.deleteOne({ _id: row._id });
        await fb.logAudit(req, 'delete', 'Category', row._id, `Deleted category "${row.name}"`);
        ok(res, { _id: sid(row._id), deleted: true });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  QUESTION BANK (spec §12)
// ═════════════════════════════════════════════════════════════════════════════
const QUESTION_TYPES = ['rating_5', 'yes_no', 'multiple_choice', 'checkbox', 'text', 'emoji_5'];
const OPTION_TYPES   = ['multiple_choice', 'checkbox'];

exports.getQuestions = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.status)       filter.status = str(req.query.status, 20);
        else                        filter.status = { $ne: 'archived' };
        if (req.query.category)     filter.category = str(req.query.category, 40);
        if (req.query.questionType) filter.questionType = str(req.query.questionType, 30);
        if (req.query.search)       filter.questionText = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const { page, limit, skip } = paginate(req, 100);
        const [rows, total, categories] = await Promise.all([
            FeedbackQuestion.find(filter).sort({ displayOrder: 1, createdAt: 1 })
                .skip(skip).limit(limit).lean(),
            FeedbackQuestion.countDocuments(filter),
            FeedbackCategory.find({ school: req.schoolId }).select('name').lean(),
        ]);
        const catMap = new Map(categories.map((c) => [sid(c._id), c.name]));

        const optionRows = await FeedbackQuestionOption.find({ question: { $in: rows.map((r) => r._id) } })
            .sort({ displayOrder: 1 }).lean();
        const optsByQ = optionRows.reduce((acc, o) => {
            (acc[sid(o.question)] = acc[sid(o.question)] || []).push(o);
            return acc;
        }, {});

        ok(res, {
            data: rows.map((q) => ({
                ...q,
                categoryName: catMap.get(sid(q.category)) || '',
                options: optsByQ[sid(q._id)] || [],
            })),
            page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (e) { fail(res, e); }
};

exports.createQuestion = async (req, res) => {
    try {
        const questionText = str(req.body.questionText, 500);
        if (!questionText) return bad(res, 'Question text is required.');
        const questionType = QUESTION_TYPES.includes(req.body.questionType) ? req.body.questionType : 'rating_5';

        const options = Array.isArray(req.body.options) ? req.body.options : [];
        if (OPTION_TYPES.includes(questionType) && options.filter((o) => str(o.optionText ?? o, 200)).length < 2) {
            return bad(res, 'Choice questions need at least two options.');
        }

        let category = str(req.body.category, 40) || null;
        if (category) {
            const exists = await FeedbackCategory.countDocuments({ _id: category, school: req.schoolId });
            if (!exists) return bad(res, 'Category not found.');
        }

        const q = await FeedbackQuestion.create({
            school: req.schoolId,
            category,
            questionText,
            questionType,
            feedbackType: ['student_teacher', 'parent_teacher', 'any'].includes(req.body.feedbackType) ? req.body.feedbackType : 'any',
            isRequired: bool(req.body.isRequired, true),
            includeInScore: bool(req.body.includeInScore, !['text', 'checkbox', 'multiple_choice'].includes(questionType)),
            helpText: str(req.body.helpText, 300),
            maxLength: Math.min(2000, Math.max(50, int(req.body.maxLength, 1000))),
            displayOrder: int(req.body.displayOrder, 0),
            createdBy: req.userId,
        });

        await saveOptions(req.schoolId, q._id, options);
        await fb.logAudit(req, 'create', 'Question', q._id, `Created question "${questionText.slice(0, 60)}"`);
        ok(res, q);
    } catch (e) { fail(res, e); }
};

async function saveOptions(schoolId, questionId, options) {
    await FeedbackQuestionOption.deleteMany({ question: questionId });
    let i = 0;
    for (const raw of options || []) {
        const optionText = str(raw.optionText ?? raw, 200);
        if (!optionText) continue;
        await FeedbackQuestionOption.create({
            school: schoolId,
            question: questionId,
            optionText,
            optionValue: str(raw.optionValue, 80) || optionText.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
            allowsFreeText: bool(raw.allowsFreeText, /^other$/i.test(optionText)),
            displayOrder: i,
        });
        i += 1;
    }
    return i;
}

exports.updateQuestion = async (req, res) => {
    try {
        const q = await FeedbackQuestion.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!q) return bad(res, 'Question not found.', 404);

        // A question already answered by students keeps its type and options —
        // changing them would silently reinterpret stored answers. Wording,
        // ordering and status stay editable (rule 15).
        const answered = await FeedbackResponse.countDocuments({ question: q._id });

        const $set = {};
        if (req.body.questionText !== undefined) {
            const t = str(req.body.questionText, 500);
            if (!t) return bad(res, 'Question text is required.');
            $set.questionText = t;
        }
        if (req.body.helpText !== undefined)     $set.helpText = str(req.body.helpText, 300);
        if (req.body.displayOrder !== undefined) $set.displayOrder = int(req.body.displayOrder, 0);
        if (req.body.isRequired !== undefined)   $set.isRequired = bool(req.body.isRequired, true);
        if (req.body.status !== undefined && ['active', 'inactive', 'archived'].includes(req.body.status)) {
            $set.status = req.body.status;
        }
        if (req.body.category !== undefined) {
            const category = str(req.body.category, 40) || null;
            if (category) {
                const exists = await FeedbackCategory.countDocuments({ _id: category, school: req.schoolId });
                if (!exists) return bad(res, 'Category not found.');
            }
            $set.category = category;
        }

        if (!answered) {
            if (req.body.questionType !== undefined && QUESTION_TYPES.includes(req.body.questionType)) {
                $set.questionType = req.body.questionType;
            }
            if (req.body.includeInScore !== undefined) $set.includeInScore = bool(req.body.includeInScore, true);
            if (req.body.maxLength !== undefined)      $set.maxLength = Math.min(2000, Math.max(50, int(req.body.maxLength, 1000)));
            if (Array.isArray(req.body.options)) {
                const type = $set.questionType || q.questionType;
                if (OPTION_TYPES.includes(type) && req.body.options.filter((o) => str(o.optionText ?? o, 200)).length < 2) {
                    return bad(res, 'Choice questions need at least two options.');
                }
                await saveOptions(req.schoolId, q._id, req.body.options);
            }
        } else if (req.body.questionType !== undefined && req.body.questionType !== q.questionType) {
            return bad(res, 'This question already has responses — its type cannot be changed. Archive it and add a new one instead.', 409);
        }

        await FeedbackQuestion.updateOne({ _id: q._id }, { $set });
        await fb.logAudit(req, 'update', 'Question', q._id, `Updated question "${(($set.questionText || q.questionText)).slice(0, 60)}"`);
        ok(res, await FeedbackQuestion.findById(q._id).lean());
    } catch (e) { fail(res, e); }
};

// Soft delete once the question has any history (rule 15).
exports.deleteQuestion = async (req, res) => {
    try {
        const q = await FeedbackQuestion.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!q) return bad(res, 'Question not found.', 404);

        const [answered, inCampaign] = await Promise.all([
            FeedbackResponse.countDocuments({ question: q._id }),
            FeedbackCampaignQuestion.countDocuments({ question: q._id }),
        ]);
        if (answered || inCampaign) {
            await FeedbackQuestion.updateOne({ _id: q._id }, { $set: { status: 'archived' } });
            await fb.logAudit(req, 'archive', 'Question', q._id, 'Archived question (in use by existing feedback)');
            return ok(res, { _id: sid(q._id), archived: true, deleted: false, message: 'This question is used by existing feedback, so it was archived instead of deleted.' });
        }
        await FeedbackQuestionOption.deleteMany({ question: q._id });
        await FeedbackQuestion.deleteOne({ _id: q._id });
        await fb.logAudit(req, 'delete', 'Question', q._id, 'Deleted unused question');
        ok(res, { _id: sid(q._id), deleted: true });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  TEMPLATES
// ═════════════════════════════════════════════════════════════════════════════
exports.getTemplates = async (req, res) => {
    try {
        const rows = await FeedbackTemplate.find({ school: req.schoolId }).sort({ isDefault: -1, name: 1 }).lean();
        ok(res, rows.map((t) => ({ ...t, questionCount: (t.questions || []).length })));
    } catch (e) { fail(res, e); }
};

exports.createTemplate = async (req, res) => {
    try {
        const name = str(req.body.name, 150);
        if (!name) return bad(res, 'Template name is required.');
        const questionIds = idList((req.body.questions || []).map((q) => q.question ?? q));
        if (!questionIds.length) return bad(res, 'Pick at least one question.');

        const valid = await FeedbackQuestion.find({ _id: { $in: questionIds }, school: req.schoolId }).select('_id').lean();
        const validSet = new Set(valid.map((v) => sid(v._id)));

        const row = await FeedbackTemplate.create({
            school: req.schoolId, name,
            description: str(req.body.description, 500),
            instructions: str(req.body.instructions, 1000),
            feedbackType: ['student_teacher', 'parent_teacher'].includes(req.body.feedbackType) ? req.body.feedbackType : 'student_teacher',
            questions: questionIds.filter((q) => validSet.has(q)).map((q, i) => ({ question: q, displayOrder: i, isRequired: true })),
            createdBy: req.userId,
        });
        await fb.logAudit(req, 'create', 'Template', row._id, `Created template "${name}"`);
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A template with this name already exists.', 409);
        fail(res, e);
    }
};

exports.updateTemplate = async (req, res) => {
    try {
        const row = await FeedbackTemplate.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Template not found.', 404);
        const $set = {};
        if (req.body.name !== undefined) {
            const n = str(req.body.name, 150);
            if (!n) return bad(res, 'Template name is required.');
            $set.name = n;
        }
        if (req.body.description !== undefined)  $set.description = str(req.body.description, 500);
        if (req.body.instructions !== undefined) $set.instructions = str(req.body.instructions, 1000);
        if (req.body.status !== undefined && ['active', 'inactive'].includes(req.body.status)) $set.status = req.body.status;
        if (Array.isArray(req.body.questions)) {
            const ids = idList(req.body.questions.map((q) => q.question ?? q));
            const valid = await FeedbackQuestion.find({ _id: { $in: ids }, school: req.schoolId }).select('_id').lean();
            const validSet = new Set(valid.map((v) => sid(v._id)));
            $set.questions = ids.filter((q) => validSet.has(q)).map((q, i) => ({ question: q, displayOrder: i, isRequired: true }));
        }
        await FeedbackTemplate.updateOne({ _id: row._id }, { $set });
        await fb.logAudit(req, 'update', 'Template', row._id, `Updated template "${$set.name || row.name}"`);
        ok(res, await FeedbackTemplate.findById(row._id).lean());
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A template with this name already exists.', 409);
        fail(res, e);
    }
};

exports.deleteTemplate = async (req, res) => {
    try {
        const row = await FeedbackTemplate.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Template not found.', 404);
        if (row.isDefault) return bad(res, 'The default template cannot be deleted.', 409);
        await FeedbackTemplate.deleteOne({ _id: row._id });
        await fb.logAudit(req, 'delete', 'Template', row._id, `Deleted template "${row.name}"`);
        ok(res, { _id: sid(row._id), deleted: true });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CAMPAIGNS (spec §4)
// ═════════════════════════════════════════════════════════════════════════════
exports.getCampaigns = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.status)       filter.status = str(req.query.status, 20);
        else if (!bool(req.query.includeArchived)) filter.status = { $ne: 'archived' };
        if (req.query.academicYear) filter.academicYear = str(req.query.academicYear, 40);
        if (req.query.search)       filter.name = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const { page, limit, skip } = paginate(req);
        const [rows, total] = await Promise.all([
            FeedbackCampaign.find(filter).sort({ startDate: -1, createdAt: -1 })
                .skip(skip).limit(limit)
                .populate('academicYear', 'yearName')
                .populate('createdBy', 'name').lean(),
            FeedbackCampaign.countDocuments(filter),
        ]);

        const qCounts = await FeedbackCampaignQuestion.find({ campaign: { $in: rows.map((r) => r._id) } })
            .select('campaign').lean();
        const qByCampaign = qCounts.reduce((acc, q) => {
            acc[sid(q.campaign)] = (acc[sid(q.campaign)] || 0) + 1;
            return acc;
        }, {});

        ok(res, {
            data: rows.map((c) => ({
                ...c,
                ...fb.campaignSummary(c),
                questionCount: qByCampaign[sid(c._id)] || 0,
            })),
            page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (e) { fail(res, e); }
};

exports.getCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('academicYear', 'yearName')
            .populate('createdBy', 'name').lean();
        if (!c) return bad(res, 'Campaign not found.', 404);

        const questions = await FeedbackCampaignQuestion.find({ campaign: c._id })
            .sort({ displayOrder: 1 }).lean();

        ok(res, {
            ...c,
            ...fb.campaignSummary(c),
            questions: questions.map((q) => ({
                _id: sid(q._id), question: sid(q.question), questionText: q.questionText,
                questionType: q.questionType, categoryName: q.categoryName,
                isRequired: q.isRequired, displayOrder: q.displayOrder,
                options: q.options || [],
            })),
        });
    } catch (e) { fail(res, e); }
};

function readCampaignBody(req, settings) {
    const start = req.body.startDate ? new Date(req.body.startDate) : null;
    const end   = req.body.endDate   ? new Date(req.body.endDate)   : null;
    return {
        name:         str(req.body.name, 150),
        academicYear: str(req.body.academicYear, 40) || null,
        term:         str(req.body.term, 60),
        feedbackType: ['student_teacher', 'parent_teacher'].includes(req.body.feedbackType) ? req.body.feedbackType : 'student_teacher',
        description:  str(req.body.description, 1000),
        instructions: str(req.body.instructions, 2000),
        startDate:    start,
        endDate:      end,
        isAnonymous:  bool(req.body.isAnonymous, settings?.defaultAnonymous ?? true),
        minimumResponses: Math.max(1, int(req.body.minimumResponses, settings?.defaultMinimumResponses ?? 5)),
        targetClasses:  idList(req.body.targetClasses),
        targetSections: idList(req.body.targetSections),
        targetSubjects: idList(req.body.targetSubjects),
        targetTeachers: idList(req.body.targetTeachers),
        allowResubmission: bool(req.body.allowResubmission, false),
        reminderEnabled:   bool(req.body.reminderEnabled, true),
        reminderIntervalDays: Math.max(1, int(req.body.reminderIntervalDays, settings?.reminderIntervalDays ?? 3)),
    };
}

function validateCampaign(body) {
    if (!body.name) return 'Campaign name is required.';
    if (!body.startDate || Number.isNaN(body.startDate.getTime())) return 'A valid start date is required.';
    if (!body.endDate   || Number.isNaN(body.endDate.getTime()))   return 'A valid end date is required.';
    if (body.endDate < body.startDate) return 'The end date cannot be before the start date.';
    if (body.feedbackType === 'parent_teacher') {
        return 'Parent → Teacher feedback is not enabled yet. Use Student → Teacher.';
    }
    return null;
}

exports.createCampaign = async (req, res) => {
    try {
        const settings = await fb.getSettings(req.schoolId);
        const body = readCampaignBody(req, settings);
        const err  = validateCampaign(body);
        if (err) return bad(res, err);

        if (!body.academicYear) {
            const y = await fb.activeAcademicYear(req.schoolId);
            body.academicYear = y ? sid(y._id) : null;
        }

        // Question list: explicit ids, or everything on a template.
        let questionSpecs = (req.body.questions || []).map((q, i) => ({
            question: sid(q.question ?? q), displayOrder: i,
            isRequired: q.isRequired === undefined ? undefined : bool(q.isRequired, true),
        })).filter((q) => q.question);

        if (!questionSpecs.length && req.body.template) {
            const tpl = await FeedbackTemplate.findOne({ _id: str(req.body.template, 40), school: req.schoolId }).lean();
            if (!tpl) return bad(res, 'Template not found.');
            questionSpecs = (tpl.questions || []).map((q, i) => ({ question: sid(q.question), displayOrder: i, isRequired: q.isRequired !== false }));
            if (!body.instructions && tpl.instructions) body.instructions = tpl.instructions;
        }
        if (!questionSpecs.length) return bad(res, 'A campaign needs at least one question. Pick a template or choose questions.');

        const campaign = await FeedbackCampaign.create({
            school: req.schoolId, ...body, status: 'draft', createdBy: req.userId,
        });
        const written = await fb.snapshotQuestions(campaign, questionSpecs);
        if (!written) {
            await FeedbackCampaign.deleteOne({ _id: campaign._id });
            return bad(res, 'None of the selected questions could be found.');
        }

        await fb.logAudit(req, 'create', 'Campaign', campaign._id, `Created campaign "${body.name}"`, { campaign: campaign._id });
        ok(res, campaign);
    } catch (e) { fail(res, e); }
};

exports.updateCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (['closed', 'archived'].includes(c.status)) {
            return bad(res, 'A closed or archived campaign can no longer be edited.', 409);
        }

        const settings = await fb.getSettings(req.schoolId);
        const body = readCampaignBody(req, settings);
        const err  = validateCampaign(body);
        if (err) return bad(res, err);

        // Once live, only the safe knobs move — retargeting a running campaign
        // would orphan submissions already collected.
        const live = c.status === 'active';
        const $set = live
            ? {
                name: body.name, description: body.description, instructions: body.instructions,
                endDate: body.endDate, minimumResponses: body.minimumResponses,
                reminderEnabled: body.reminderEnabled, reminderIntervalDays: body.reminderIntervalDays,
                allowResubmission: body.allowResubmission,
            }
            : body;

        await FeedbackCampaign.updateOne({ _id: c._id }, { $set });

        if (!live && Array.isArray(req.body.questions)) {
            const specs = req.body.questions.map((q, i) => ({
                question: sid(q.question ?? q), displayOrder: i,
                isRequired: q.isRequired === undefined ? undefined : bool(q.isRequired, true),
            })).filter((q) => q.question);
            if (specs.length) {
                await fb.snapshotQuestions({ ...c, ...$set, _id: c._id, school: c.school }, specs, { replace: true });
            }
        }

        await fb.logAudit(req, 'update', 'Campaign', c._id, `Updated campaign "${body.name}"`, { campaign: c._id });
        ok(res, await FeedbackCampaign.findById(c._id).lean());
    } catch (e) { fail(res, e); }
};

exports.duplicateCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);

        const questions = await FeedbackCampaignQuestion.find({ campaign: c._id }).sort({ displayOrder: 1 }).lean();
        const copy = await FeedbackCampaign.create({
            school: c.school,
            name: str(req.body.name, 150) || `${c.name} (Copy)`,
            academicYear: c.academicYear, term: c.term, feedbackType: c.feedbackType,
            description: c.description, instructions: c.instructions,
            startDate: c.startDate, endDate: c.endDate,
            isAnonymous: c.isAnonymous, minimumResponses: c.minimumResponses,
            targetClasses: c.targetClasses, targetSections: c.targetSections,
            targetSubjects: c.targetSubjects, targetTeachers: c.targetTeachers,
            allowResubmission: c.allowResubmission,
            reminderEnabled: c.reminderEnabled, reminderIntervalDays: c.reminderIntervalDays,
            status: 'draft', createdBy: req.userId,
        });
        await fb.snapshotQuestions(copy, questions.map((q, i) => ({ question: q.question, displayOrder: i, isRequired: q.isRequired })));
        await fb.logAudit(req, 'duplicate', 'Campaign', copy._id, `Duplicated campaign "${c.name}"`, { campaign: copy._id });
        ok(res, copy);
    } catch (e) { fail(res, e); }
};

// Activating is what materialises the assignments and notifies students.
exports.activateCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (['closed', 'archived'].includes(c.status)) return bad(res, 'This campaign has already been closed.', 409);
        if (c.status === 'active') return bad(res, 'This campaign is already active.', 409);

        const questionCount = await FeedbackCampaignQuestion.countDocuments({ campaign: c._id });
        if (!questionCount) return bad(res, 'Add at least one question before activating.', 409);

        const now = new Date();
        const scheduled = new Date(c.startDate) > now;
        const status = scheduled ? 'scheduled' : 'active';

        const gen = await fb.generateAssignments(c);
        if (!gen.created && !gen.pairs) {
            return bad(res, 'No students match this campaign. Check the target classes, sections and subject–teacher allocations.', 409);
        }

        await FeedbackCampaign.updateOne({ _id: c._id }, {
            $set: { status, activatedAt: scheduled ? null : now },
        });
        await fb.refreshCampaignStats(c._id);
        await fb.logAudit(req, 'activate', 'Campaign', c._id,
            `${scheduled ? 'Scheduled' : 'Activated'} campaign "${c.name}" — ${gen.created} assignment(s) created`,
            { campaign: c._id, meta: gen });

        if (!scheduled) await announceCampaign(c, req);

        ok(res, { _id: sid(c._id), status, ...gen });
    } catch (e) { fail(res, e); }
};

// Fan the "feedback is open" notification out to exactly the students who were
// given something to answer — never the whole school.
async function announceCampaign(campaign, req = null) {
    try {
        const settings = await fb.getSettings(campaign.school);
        if (!settings?.notifyOnCampaignStart) return 0;
        const rows = await FeedbackAssignment.find({ campaign: campaign._id, status: { $ne: 'submitted' } })
            .select('student').lean();
        const students = [...new Set(rows.map((r) => sid(r.student)))];
        if (!students.length) return 0;
        notify({
            school: campaign.school,
            sender: req?.userId || campaign.createdBy,
            senderRole: req?.userRole || 'school_admin',
            title: 'Teacher feedback is now available',
            body: `${campaign.name} is open until ${new Date(campaign.endDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. It takes about two minutes — please share your feedback.`,
            recipients: students,
            email: !!settings.emailNotifications,
            includeSender: true,
            link: { type: 'feedback.pending', entityId: campaign._id },
        });
        return students.length;
    } catch (e) {
        console.error('[feedback] announce failed:', e.message);
        return 0;
    }
}

exports.closeCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (['closed', 'archived'].includes(c.status)) return bad(res, 'This campaign is already closed.', 409);

        // Closing never deletes anything (rule 16) — outstanding assignments are
        // simply marked expired so they leave the students' pending lists.
        await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { status: 'closed', closedAt: new Date() } });
        await FeedbackAssignment.updateMany(
            { campaign: c._id, status: { $in: ['pending', 'in_progress'] } },
            { $set: { status: 'expired' } },
        );
        await fb.refreshCampaignStats(c._id);
        await fb.logAudit(req, 'close', 'Campaign', c._id, `Closed campaign "${c.name}"`, { campaign: c._id });
        ok(res, { _id: sid(c._id), status: 'closed' });
    } catch (e) { fail(res, e); }
};

exports.archiveCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (c.status === 'active') return bad(res, 'Close the campaign before archiving it.', 409);
        await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { status: 'archived' } });
        await fb.logAudit(req, 'archive', 'Campaign', c._id, `Archived campaign "${c.name}"`, { campaign: c._id });
        ok(res, { _id: sid(c._id), status: 'archived' });
    } catch (e) { fail(res, e); }
};

// Only drafts are ever destroyed; anything that collected a response is kept.
exports.deleteCampaign = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (c.status !== 'draft') {
            return bad(res, 'Only draft campaigns can be deleted. Close or archive this one instead.', 409);
        }
        const submitted = await FeedbackAssignment.countDocuments({ campaign: c._id, status: 'submitted' });
        if (submitted) return bad(res, 'This campaign already has responses and cannot be deleted.', 409);

        await FeedbackCampaignQuestion.deleteMany({ campaign: c._id });
        await FeedbackAssignment.deleteMany({ campaign: c._id });
        await FeedbackCampaign.deleteOne({ _id: c._id });
        await fb.logAudit(req, 'delete', 'Campaign', c._id, `Deleted draft campaign "${c.name}"`);
        ok(res, { _id: sid(c._id), deleted: true });
    } catch (e) { fail(res, e); }
};

// Top up assignments after a mid-campaign transfer / new allocation.
exports.syncAssignments = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (!['draft', 'scheduled', 'active'].includes(c.status)) {
            return bad(res, 'Assignments can only be regenerated for a campaign that is still open.', 409);
        }
        const gen = await fb.generateAssignments(c);
        await fb.refreshCampaignStats(c._id);
        await fb.logAudit(req, 'sync', 'Campaign', c._id, `Regenerated assignments — ${gen.created} new`, { campaign: c._id, meta: gen });
        ok(res, gen);
    } catch (e) { fail(res, e); }
};

// Admin-triggered "nudge the stragglers".
exports.sendReminders = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);
        if (c.status !== 'active') return bad(res, 'Reminders can only be sent for an active campaign.', 409);
        const sent = await remindPending(c, req);
        await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { lastReminderAt: new Date() } });
        await fb.logAudit(req, 'remind', 'Campaign', c._id, `Sent reminders to ${sent} student(s)`, { campaign: c._id });
        ok(res, { reminded: sent });
    } catch (e) { fail(res, e); }
};

async function remindPending(campaign, req = null) {
    const rows = await FeedbackAssignment.find({ campaign: campaign._id, status: { $in: ['pending', 'in_progress'] } })
        .select('student').lean();
    const students = [...new Set(rows.map((r) => sid(r.student)))];
    if (!students.length) return 0;
    const settings = await fb.getSettings(campaign.school);
    notify({
        school: campaign.school,
        sender: req?.userId || campaign.createdBy,
        senderRole: req?.userRole || 'school_admin',
        title: 'You have pending teacher feedback',
        body: `${campaign.name} closes on ${new Date(campaign.endDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. Please take two minutes to complete it.`,
        recipients: students,
        email: !!settings?.emailNotifications,
        includeSender: true,
        link: { type: 'feedback.pending', entityId: campaign._id },
    });
    return students.length;
}

// Reopen one submission for a correction (spec §11 — admin-controlled).
exports.reopenAssignment = async (req, res) => {
    try {
        const a = await FeedbackAssignment.findOne({ _id: req.params.assignmentId, school: req.schoolId }).lean();
        if (!a) return bad(res, 'Assignment not found.', 404);
        if (a.status !== 'submitted') return bad(res, 'This feedback has not been submitted.', 409);

        const c = await FeedbackCampaign.findById(a.campaign).lean();
        if (!c?.allowResubmission) return bad(res, 'Resubmission is not enabled for this campaign.', 409);
        const blocked = fb.submissionBlockReason(c);
        if (blocked) return bad(res, blocked, 409);

        // The previous answers are removed so the new submission is the record;
        // the audit log keeps the fact that a reopen happened.
        const responses = await FeedbackResponse.find({ assignment: a._id }).select('_id').lean();
        await FeedbackSelectedOption.deleteMany({ assignment: a._id });
        if (responses.length) await FeedbackResponse.deleteMany({ assignment: a._id });
        await FeedbackAssignment.updateOne({ _id: a._id }, {
            $set: { status: 'pending', submittedAt: null, overallRating: null, categoryScores: {}, hasComment: false },
        });
        await fb.refreshCampaignStats(a.campaign);
        await fb.logAudit(req, 'reopen', 'Assignment', a._id, 'Reopened a submitted feedback for resubmission', {
            campaign: a.campaign, assignment: a._id, meta: { reason: str(req.body.reason, 300) },
        });
        ok(res, { _id: sid(a._id), status: 'pending' });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CAMPAIGN ANALYTICS + RESPONSE TRACKING
// ═════════════════════════════════════════════════════════════════════════════
exports.getCampaignAnalytics = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);

        const assignments = await FeedbackAssignment.find({ campaign: c._id })
            .select('teacher subject class section status overallRating categoryScores').lean();

        const [teachers, subjects, sections, classes] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher' }).select('name').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
            ClassSection.find({ school: req.schoolId }).select('sectionName class').lean(),
            Class.find({ school: req.schoolId }).select('className').lean(),
        ]);
        const tMap = new Map(teachers.map((t) => [sid(t._id), t.name]));
        const sMap = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
        const cMap = new Map(classes.map((c2) => [sid(c2._id), c2.className]));
        const secMap = new Map(sections.map((s) => [sid(s._id), `${cMap.get(sid(s.class)) || ''} ${s.sectionName}`.trim()]));

        const groupBy = (keyOf, nameOf) => {
            const buckets = {};
            for (const a of assignments) {
                const k = keyOf(a);
                if (!k) continue;
                (buckets[k] = buckets[k] || []).push(a);
            }
            return Object.entries(buckets).map(([k, rows]) => {
                const agg = fb.aggregate(rows, c.minimumResponses);
                return {
                    _id: k, name: nameOf(k),
                    assigned: rows.length,
                    responses: agg.responses,
                    responseRate: fb.pct(agg.responses, rows.length),
                    rating: agg.locked ? null : agg.averageRating,
                    locked: agg.locked,
                };
            }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
        };

        const overall = fb.aggregate(assignments, 0);   // school level — no gate needed
        ok(res, {
            campaign: { ...c, ...fb.campaignSummary(c) },
            overall: {
                assigned: assignments.length,
                responses: overall.responses,
                responseRate: fb.pct(overall.responses, assignments.length),
                averageRating: overall.averageRating,
                categories: overall.categories,
            },
            byTeacher: groupBy((a) => sid(a.teacher), (k) => tMap.get(k) || 'Teacher'),
            bySubject: groupBy((a) => sid(a.subject), (k) => sMap.get(k) || 'Subject'),
            byClass:   groupBy((a) => sid(a.class),   (k) => cMap.get(k) || 'Class'),
            bySection: groupBy((a) => sid(a.section), (k) => secMap.get(k) || 'Section'),
        });
    } catch (e) { fail(res, e); }
};

// Submission tracking for chasing pending responses. Returns WHO has responded,
// never WHAT they said — the two are never joined on any admin endpoint.
exports.getCampaignAssignments = async (req, res) => {
    try {
        const c = await FeedbackCampaign.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Campaign not found.', 404);

        const filter = { campaign: c._id };
        if (req.query.status)  filter.status  = str(req.query.status, 20);
        if (req.query.teacher) filter.teacher = str(req.query.teacher, 40);
        if (req.query.section) filter.section = str(req.query.section, 40);

        const { page, limit, skip } = paginate(req, 50);
        const [rows, total] = await Promise.all([
            FeedbackAssignment.find(filter).sort({ status: 1, assignedAt: -1 }).skip(skip).limit(limit)
                .populate('student', 'name email')
                .populate('teacher', 'name')
                .populate('subject', 'subjectName')
                .populate('section', 'sectionName').lean(),
            FeedbackAssignment.countDocuments(filter),
        ]);

        ok(res, {
            data: rows.map((a) => ({
                _id: sid(a._id),
                student: { _id: sid(a.student?._id), name: a.student?.name || '' },
                teacher: a.teacher?.name || '',
                subject: a.subject?.subjectName || '',
                section: a.section?.sectionName || '',
                status: a.status,
                submittedAt: a.submittedAt,
                // Deliberately omitted for anonymous campaigns: the rating this
                // particular student gave. Response content is never keyed to a
                // named student on any endpoint.
                overallRating: c.isAnonymous ? null : a.overallRating,
            })),
            isAnonymous: !!c.isAnonymous,
            page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD (spec §16 admin / §17 principal)
// ═════════════════════════════════════════════════════════════════════════════
exports.getDashboard = async (req, res) => {
    try {
        const school = req.schoolId;
        const access = await fb.resolveAccess(req);

        const campaigns = await FeedbackCampaign.find({ school, status: { $ne: 'archived' } })
            .select('name term status startDate endDate stats minimumResponses isAnonymous')
            .sort({ startDate: -1 }).lean();

        const activeCampaigns = campaigns.filter((c) => c.status === 'active');
        const focus = req.query.campaignId
            ? campaigns.find((c) => sid(c._id) === String(req.query.campaignId))
            : (activeCampaigns[0] || campaigns.find((c) => c.status === 'closed') || campaigns[0]);

        const totals = campaigns.reduce((acc, c) => {
            const s = fb.campaignSummary(c);
            acc.assigned  += s.assigned;
            acc.submitted += s.submitted;
            acc.ratingSum   += (c.stats?.ratingSum   || 0);
            acc.ratingCount += (c.stats?.ratingCount || 0);
            return acc;
        }, { assigned: 0, submitted: 0, ratingSum: 0, ratingCount: 0 });

        let teacherRows = [];
        let departments = [];
        let categories  = [];
        let trend       = [];

        if (focus) {
            const assignments = await FeedbackAssignment.find({ campaign: focus._id })
                .select('teacher status overallRating categoryScores subject').lean();

            const [teachers, profiles, subjects] = await Promise.all([
                User.find({ school, role: 'teacher' }).select('name email').lean(),
                TeacherProfile.find({ school }).select('user department designation').lean(),
                Subject.find({ school }).select('subjectName').lean(),
            ]);
            const tMap = new Map(teachers.map((t) => [sid(t._id), t]));
            const pMap = new Map(profiles.map((p) => [sid(p.user), p]));
            const sMap = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));

            const byTeacher = {};
            for (const a of assignments) {
                (byTeacher[sid(a.teacher)] = byTeacher[sid(a.teacher)] || []).push(a);
            }

            // Previous campaign averages give each teacher a trend arrow (§16).
            const prevCampaign = campaigns
                .filter((c) => sid(c._id) !== sid(focus._id) && new Date(c.startDate) < new Date(focus.startDate))
                .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];
            let prevByTeacher = {};
            if (prevCampaign) {
                const prev = await FeedbackAssignment.find({ campaign: prevCampaign._id, status: 'submitted' })
                    .select('teacher overallRating').lean();
                const acc = {};
                for (const p of prev) {
                    if (p.overallRating == null) continue;
                    const k = sid(p.teacher);
                    acc[k] = acc[k] || { sum: 0, n: 0 };
                    acc[k].sum += Number(p.overallRating); acc[k].n += 1;
                }
                prevByTeacher = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, fb.round1(v.sum / v.n)]));
            }

            teacherRows = Object.entries(byTeacher).map(([tid, rows]) => {
                const agg = fb.aggregate(rows, focus.minimumResponses);
                const prev = prevByTeacher[tid] ?? null;
                const subjectNames = [...new Set(rows.map((r) => sMap.get(sid(r.subject))).filter(Boolean))];
                return {
                    _id: tid,
                    name: tMap.get(tid)?.name || 'Teacher',
                    department: pMap.get(tid)?.department || '',
                    designation: pMap.get(tid)?.designation || '',
                    subjects: subjectNames,
                    assigned: rows.length,
                    responses: agg.responses,
                    responseRate: fb.pct(agg.responses, rows.length),
                    rating: agg.locked ? null : agg.averageRating,
                    locked: agg.locked,
                    previousRating: prev,
                    trend: (!agg.locked && agg.averageRating != null && prev != null)
                        ? fb.round1(agg.averageRating - prev) : null,
                    status: agg.locked ? 'insufficient' : (agg.averageRating >= 4 ? 'good' : agg.averageRating >= 3 ? 'average' : 'attention'),
                };
            }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

            const deptAcc = {};
            for (const t of teacherRows) {
                const key = t.department || 'Unassigned';
                const d = deptAcc[key] = deptAcc[key] || { name: key, teachers: 0, rated: 0, sum: 0, responses: 0, assigned: 0 };
                d.teachers += 1;
                d.responses += t.responses;
                d.assigned  += t.assigned;
                if (t.rating != null) { d.sum += t.rating; d.rated += 1; }
            }
            departments = Object.values(deptAcc).map((d) => ({
                name: d.name, teachers: d.teachers, responses: d.responses,
                responseRate: fb.pct(d.responses, d.assigned),
                rating: d.rated ? fb.round1(d.sum / d.rated) : null,
                evaluated: d.rated,
            })).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

            categories = fb.aggregate(assignments, 0).categories;

            trend = [...campaigns]
                .filter((c) => (c.stats?.ratingCount || 0) > 0)
                .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
                .slice(-8)
                .map((c) => ({
                    label: c.term || c.name,
                    name: c.name,
                    rating: fb.round1(c.stats.ratingSum / c.stats.ratingCount),
                    responses: c.stats.submitted || 0,
                }));
        }

        ok(res, {
            access: { canManage: access.canManage, isPrincipal: access.isPrincipal },
            cards: {
                totalCampaigns:   campaigns.length,
                activeCampaigns:  activeCampaigns.length,
                teachersEvaluated: teacherRows.filter((t) => t.responses > 0).length,
                totalResponses:   totals.submitted,
                pendingResponses: Math.max(0, totals.assigned - totals.submitted),
                responseRate:     fb.pct(totals.submitted, totals.assigned),
                averageRating:    totals.ratingCount ? fb.round1(totals.ratingSum / totals.ratingCount) : null,
            },
            campaigns: campaigns.map((c) => ({
                _id: sid(c._id), name: c.name, term: c.term, status: c.status,
                startDate: c.startDate, endDate: c.endDate, ...fb.campaignSummary(c),
            })),
            campaign: focus ? { _id: sid(focus._id), name: focus.name, term: focus.term, status: focus.status, minimumResponses: focus.minimumResponses } : null,
            teachers: teacherRows,
            departments,
            categories,
            trend,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  TEACHER DRILL-DOWN (admin / principal)
// ═════════════════════════════════════════════════════════════════════════════
exports.getTeacherAnalytics = async (req, res) => {
    try {
        const teacherId = str(req.params.id, 40);
        const teacher = await User.findOne({ _id: teacherId, school: req.schoolId, role: 'teacher' })
            .select('name email').lean();
        if (!teacher) return bad(res, 'Teacher not found.', 404);

        const profile = await TeacherProfile.findOne({ user: teacherId }).select('department designation employeeId').lean();

        const campaignFilter = { school: req.schoolId, status: { $in: ['active', 'closed', 'archived'] } };
        if (req.query.academicYear) campaignFilter.academicYear = str(req.query.academicYear, 40);
        const campaigns = await FeedbackCampaign.find(campaignFilter)
            .select('name term startDate status minimumResponses').sort({ startDate: -1 }).lean();
        if (!campaigns.length) return ok(res, { teacher, profile, campaigns: [], summary: null, categories: [], trend: [] });

        const focus = req.query.campaignId
            ? campaigns.find((c) => sid(c._id) === String(req.query.campaignId))
            : campaigns[0];
        if (!focus) return bad(res, 'Campaign not found.', 404);

        const [focusRows, allRows] = await Promise.all([
            FeedbackAssignment.find({ campaign: focus._id, teacher: teacherId })
                .select('status overallRating categoryScores subject section').lean(),
            FeedbackAssignment.find({ campaign: { $in: campaigns.map((c) => c._id) }, teacher: teacherId })
                .select('campaign status overallRating').lean(),
        ]);

        const agg = fb.aggregate(focusRows, focus.minimumResponses);

        // Comments and option tallies use the same privacy gate as the teacher's
        // own dashboard — an admin reading them still cannot attribute them.
        let comments = [];
        let options  = [];
        if (!agg.locked) {
            const [rawComments, picks, cqs] = await Promise.all([
                FeedbackResponse.find({ campaign: focus._id, teacher: teacherId, questionType: 'text' })
                    .select('textResponse').limit(200).lean(),
                FeedbackSelectedOption.find({ campaign: focus._id, teacher: teacherId })
                    .select('campaignQuestion optionText').lean(),
                FeedbackCampaignQuestion.find({ campaign: focus._id }).select('questionText').lean(),
            ]);
            comments = rawComments.filter((c) => (c.textResponse || '').trim()).map((c) => ({ text: c.textResponse }));
            const cqMap = new Map(cqs.map((q) => [sid(q._id), q.questionText]));
            const tally = {};
            for (const p of picks) {
                const label = cqMap.get(sid(p.campaignQuestion)) || 'Options';
                const b = tally[label] = tally[label] || {};
                b[p.optionText] = (b[p.optionText] || 0) + 1;
            }
            options = Object.entries(tally).map(([question, t]) => ({
                question,
                options: Object.entries(t).map(([label, count]) => ({ label, count, percent: fb.pct(count, agg.responses) }))
                    .sort((a, b) => b.count - a.count),
            }));
        }

        const byCampaign = allRows.reduce((acc, r) => {
            (acc[sid(r.campaign)] = acc[sid(r.campaign)] || []).push(r);
            return acc;
        }, {});
        const trend = [...campaigns]
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
            .map((c) => {
                const a = fb.aggregate(byCampaign[sid(c._id)] || [], c.minimumResponses);
                return { label: c.term || c.name, rating: a.locked ? null : a.averageRating, responses: a.responses, locked: a.locked };
            });

        ok(res, {
            teacher: { _id: sid(teacher._id), name: teacher.name, email: teacher.email },
            profile: { department: profile?.department || '', designation: profile?.designation || '', employeeId: profile?.employeeId || '' },
            campaigns: campaigns.map((c) => ({ _id: sid(c._id), name: c.name, term: c.term, status: c.status })),
            campaign: { _id: sid(focus._id), name: focus.name, term: focus.term, minimumResponses: focus.minimumResponses },
            summary: {
                assigned: focusRows.length,
                responses: agg.responses,
                responseRate: fb.pct(agg.responses, focusRows.length),
                averageRating: agg.locked ? null : agg.averageRating,
                locked: agg.locked,
                message: agg.message || null,
                minimumResponses: focus.minimumResponses,
            },
            categories: agg.categories,
            strengths: agg.strengths || [],
            improvements: agg.improvements || [],
            comments,
            options,
            trend,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  REPORTS + EXPORTS (spec §18)
// ═════════════════════════════════════════════════════════════════════════════
const REPORT_TYPES = ['teacher', 'campaign', 'class', 'subject', 'department', 'response_rate', 'trend'];

async function buildReport(req) {
    const school = req.schoolId;
    const type = REPORT_TYPES.includes(req.query.type) ? req.query.type : 'teacher';

    const campaignFilter = { school };
    if (req.query.campaign)     campaignFilter._id = str(req.query.campaign, 40);
    if (req.query.academicYear) campaignFilter.academicYear = str(req.query.academicYear, 40);
    if (req.query.term)         campaignFilter.term = str(req.query.term, 60);
    if (req.query.dateFrom || req.query.dateTo) {
        campaignFilter.startDate = {};
        if (req.query.dateFrom) campaignFilter.startDate.$gte = new Date(req.query.dateFrom);
        if (req.query.dateTo)   campaignFilter.startDate.$lte = new Date(req.query.dateTo);
    }
    const campaigns = await FeedbackCampaign.find(campaignFilter)
        .select('name term status startDate endDate stats minimumResponses isAnonymous')
        .sort({ startDate: -1 }).lean();

    if (!campaigns.length) {
        return { type, title: reportTitle(type), columns: reportColumns(type), rows: [], meta: { campaigns: 0 } };
    }

    const campaignById = new Map(campaigns.map((c) => [sid(c._id), c]));
    const aFilter = { campaign: { $in: campaigns.map((c) => c._id) } };
    if (req.query.teacher) aFilter.teacher = str(req.query.teacher, 40);
    if (req.query.subject) aFilter.subject = str(req.query.subject, 40);
    if (req.query.class)   aFilter.class   = str(req.query.class, 40);
    if (req.query.section) aFilter.section = str(req.query.section, 40);

    const assignments = await FeedbackAssignment.find(aFilter)
        .select('campaign teacher subject class section status overallRating categoryScores').lean();

    const [teachers, profiles, subjects, classes, sections] = await Promise.all([
        User.find({ school, role: 'teacher' }).select('name email').lean(),
        TeacherProfile.find({ school }).select('user department employeeId').lean(),
        Subject.find({ school }).select('subjectName').lean(),
        Class.find({ school }).select('className').lean(),
        ClassSection.find({ school }).select('sectionName class').lean(),
    ]);
    const tMap = new Map(teachers.map((t) => [sid(t._id), t]));
    const pMap = new Map(profiles.map((p) => [sid(p.user), p]));
    const sMap = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
    const cMap = new Map(classes.map((c) => [sid(c._id), c.className]));
    const secMap = new Map(sections.map((s) => [sid(s._id), `${cMap.get(sid(s.class)) || ''} ${s.sectionName}`.trim()]));

    // Every grouped row is gated by the STRICTEST minimum-response threshold of
    // the campaigns feeding it, so an export can never reveal what the UI hides.
    const minOf = (rows) => rows.reduce((m, r) => Math.max(m, campaignById.get(sid(r.campaign))?.minimumResponses || 0), 0);

    const group = (keyOf, shape) => {
        const buckets = {};
        for (const a of assignments) {
            const k = keyOf(a);
            if (!k) continue;
            (buckets[k] = buckets[k] || []).push(a);
        }
        return Object.entries(buckets).map(([k, rows]) => {
            const agg = fb.aggregate(rows, minOf(rows));
            return shape(k, rows, agg);
        });
    };

    const base = (rows, agg) => ({
        assigned: rows.length,
        responses: agg.responses,
        responseRate: fb.pct(agg.responses, rows.length),
        avgRating: agg.locked ? null : agg.averageRating,
        note: agg.locked ? 'Insufficient responses' : '',
    });

    let rows = [];
    if (type === 'teacher') {
        rows = group((a) => sid(a.teacher), (k, r, agg) => ({
            teacher: tMap.get(k)?.name || 'Teacher',
            employeeId: pMap.get(k)?.employeeId || '',
            department: pMap.get(k)?.department || '',
            subjects: [...new Set(r.map((x) => sMap.get(sid(x.subject))).filter(Boolean))].join(', '),
            ...base(r, agg),
        })).sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1));
    } else if (type === 'campaign') {
        rows = campaigns.map((c) => {
            const r = assignments.filter((a) => sid(a.campaign) === sid(c._id));
            const agg = fb.aggregate(r, 0);
            return {
                campaign: c.name, term: c.term || '', status: c.status,
                startDate: c.startDate ? new Date(c.startDate).toISOString().slice(0, 10) : '',
                endDate:   c.endDate   ? new Date(c.endDate).toISOString().slice(0, 10)   : '',
                anonymous: c.isAnonymous ? 'Yes' : 'No',
                ...base(r, agg), note: '',
            };
        });
    } else if (type === 'class') {
        rows = group((a) => sid(a.class), (k, r, agg) => ({ class: cMap.get(k) || 'Class', ...base(r, agg) }))
            .sort((a, b) => String(a.class).localeCompare(String(b.class), undefined, { numeric: true }));
    } else if (type === 'subject') {
        rows = group((a) => sid(a.subject), (k, r, agg) => ({ subject: sMap.get(k) || 'Subject', ...base(r, agg) }))
            .sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1));
    } else if (type === 'department') {
        rows = group((a) => pMap.get(sid(a.teacher))?.department || 'Unassigned',
            (k, r, agg) => ({
                department: k,
                teachers: new Set(r.map((x) => sid(x.teacher))).size,
                ...base(r, agg),
            })).sort((a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1));
    } else if (type === 'response_rate') {
        rows = group((a) => sid(a.section), (k, r, agg) => ({
            section: secMap.get(k) || 'Section',
            assigned: r.length,
            responses: agg.responses,
            pending: r.length - agg.responses,
            responseRate: fb.pct(agg.responses, r.length),
        })).sort((a, b) => b.responseRate - a.responseRate);
    } else if (type === 'trend') {
        rows = [...campaigns].sort((a, b) => new Date(a.startDate) - new Date(b.startDate)).map((c) => {
            const r = assignments.filter((a) => sid(a.campaign) === sid(c._id));
            const agg = fb.aggregate(r, 0);
            return {
                campaign: c.name, term: c.term || '',
                period: c.startDate ? new Date(c.startDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '',
                responses: agg.responses,
                avgRating: agg.averageRating,
                responseRate: fb.pct(agg.responses, r.length),
            };
        });
    }

    return {
        type,
        title: reportTitle(type),
        columns: reportColumns(type),
        rows,
        meta: {
            campaigns: campaigns.length,
            campaignNames: campaigns.map((c) => c.name),
            generatedAt: new Date(),
            totalAssignments: assignments.length,
        },
    };
}

function reportTitle(type) {
    return {
        teacher: 'Teacher Feedback Report',
        campaign: 'Campaign Report',
        class: 'Class-wise Report',
        subject: 'Subject-wise Report',
        department: 'Department-wise Report',
        response_rate: 'Response Rate Report',
        trend: 'Rating Trend Report',
    }[type] || 'Feedback Report';
}

function reportColumns(type) {
    const common = [
        { key: 'assigned', label: 'Assigned' },
        { key: 'responses', label: 'Responses' },
        { key: 'responseRate', label: 'Response %' },
        { key: 'avgRating', label: 'Avg Rating' },
        { key: 'note', label: 'Note' },
    ];
    switch (type) {
        case 'teacher': return [
            { key: 'teacher', label: 'Teacher' }, { key: 'employeeId', label: 'Employee ID' },
            { key: 'department', label: 'Department' }, { key: 'subjects', label: 'Subjects' }, ...common];
        case 'campaign': return [
            { key: 'campaign', label: 'Campaign' }, { key: 'term', label: 'Term' }, { key: 'status', label: 'Status' },
            { key: 'startDate', label: 'Start' }, { key: 'endDate', label: 'End' },
            { key: 'anonymous', label: 'Anonymous' }, ...common];
        case 'class':   return [{ key: 'class', label: 'Class' }, ...common];
        case 'subject': return [{ key: 'subject', label: 'Subject' }, ...common];
        case 'department': return [{ key: 'department', label: 'Department' }, { key: 'teachers', label: 'Teachers' }, ...common];
        case 'response_rate': return [
            { key: 'section', label: 'Class / Section' }, { key: 'assigned', label: 'Assigned' },
            { key: 'responses', label: 'Responses' }, { key: 'pending', label: 'Pending' },
            { key: 'responseRate', label: 'Response %' }];
        case 'trend': return [
            { key: 'campaign', label: 'Campaign' }, { key: 'term', label: 'Term' }, { key: 'period', label: 'Period' },
            { key: 'responses', label: 'Responses' }, { key: 'avgRating', label: 'Avg Rating' },
            { key: 'responseRate', label: 'Response %' }];
        default: return common;
    }
}

exports.getReport = async (req, res) => {
    try {
        const report = await buildReport(req);
        const format = String(req.query.format || 'json').toLowerCase();

        if (format === 'json') return ok(res, report);

        await fb.logAudit(req, 'export', 'Report', null,
            `Exported ${report.title} as ${format.toUpperCase()}`, { meta: { type: report.type, format, rows: report.rows.length } });

        const filename = `feedback_${report.type}_report_${new Date().toISOString().slice(0, 10)}`;
        const flat = report.rows.map((r) => {
            const out = {};
            for (const col of report.columns) out[col.label] = r[col.key] ?? '';
            return out;
        });

        if (format === 'csv') {
            const esc = (v) => {
                const s = String(v ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = report.columns.map((c) => esc(c.label)).join(',');
            const body = flat.map((r) => report.columns.map((c) => esc(r[c.label])).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            return res.send(`${header}\n${body}`);
        }

        if (format === 'pdf') {
            const School = require('../models/School');
            const school = await School.findById(req.schoolId).lean();
            return buildFeedbackReportPDF(res, { report, school, filename: `${filename}.pdf` });
        }

        // xlsx (default binary format)
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(flat.length ? flat : [Object.fromEntries(report.columns.map((c) => [c.label, '']))]);
        XLSX.utils.book_append_sheet(wb, ws, report.title.slice(0, 30));
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.send(buf);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  AUDIT LOG
// ═════════════════════════════════════════════════════════════════════════════
exports.getAuditLog = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.entityType) filter.entityType = str(req.query.entityType, 40);
        if (req.query.actionType) filter.actionType = str(req.query.actionType, 40);
        if (req.query.campaign)   filter.campaign = str(req.query.campaign, 40);

        const { page, limit, skip } = paginate(req, 30);
        const [rows, total] = await Promise.all([
            FeedbackAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
                .populate('user', 'name').lean(),
            FeedbackAuditLog.countDocuments(filter),
        ]);
        ok(res, { data: rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  SCHEDULED LIFECYCLE — called by the background worker in server.js
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Runs the campaign clock for one school-agnostic sweep:
 *   • scheduled campaigns whose start date has arrived  → active (+ announce)
 *   • active campaigns past their end date              → closed
 *   • reminder nudges on the configured cadence
 *   • a "closes soon" nudge inside the configured window
 * Safe to call repeatedly; every step is idempotent by date/state.
 */
async function runCampaignSchedule() {
    const now = new Date();
    const result = { activated: 0, closed: 0, reminded: 0, closingSoon: 0 };

    const due = await FeedbackCampaign.find({ status: 'scheduled', startDate: { $lte: now } }).lean();
    for (const c of due) {
        const settings = await fb.getSettings(c.school);
        if (settings && settings.autoActivateScheduled === false) continue;
        await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { status: 'active', activatedAt: now } });
        await announceCampaign(c);
        result.activated += 1;
    }

    const expired = await FeedbackCampaign.find({ status: 'active' }).lean();
    for (const c of expired) {
        const settings = await fb.getSettings(c.school);
        const past = c.endDate && now > fb.endOfDay(c.endDate);

        if (past) {
            if (settings && settings.autoCloseExpired === false) continue;
            await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { status: 'closed', closedAt: now } });
            await FeedbackAssignment.updateMany(
                { campaign: c._id, status: { $in: ['pending', 'in_progress'] } },
                { $set: { status: 'expired' } },
            );
            await fb.refreshCampaignStats(c._id);
            result.closed += 1;
            continue;
        }

        if (!c.reminderEnabled || !settings?.notifyReminders) continue;

        const days = Math.max(1, c.reminderIntervalDays || settings.reminderIntervalDays || 3);
        const lastAt = c.lastReminderAt ? new Date(c.lastReminderAt) : new Date(c.activatedAt || c.startDate);
        const nextDue = new Date(lastAt.getTime() + days * 86400000);

        const daysLeft = Math.ceil((fb.endOfDay(c.endDate) - now) / 86400000);
        const closingSoon = settings.notifyBeforeClose && daysLeft > 0 && daysLeft <= (settings.closingSoonDays || 2);

        if (now >= nextDue || closingSoon) {
            const pending = await FeedbackAssignment.find({ campaign: c._id, status: { $in: ['pending', 'in_progress'] } })
                .select('student').lean();
            const students = [...new Set(pending.map((r) => sid(r.student)))];
            if (students.length) {
                notify({
                    school: c.school, sender: c.createdBy, senderRole: 'school_admin',
                    title: closingSoon ? 'Teacher feedback closes soon' : 'You have pending teacher feedback',
                    body: closingSoon
                        ? `${c.name} closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Please complete your pending feedback.`
                        : `You still have pending feedback in ${c.name}. It takes about two minutes.`,
                    recipients: students,
                    email: !!settings.emailNotifications,
                    includeSender: true,
                    link: { type: 'feedback.pending', entityId: c._id },
                });
                if (closingSoon) result.closingSoon += students.length;
                else result.reminded += students.length;
            }
            await FeedbackCampaign.updateOne({ _id: c._id }, { $set: { lastReminderAt: now } });
        }
    }
    return result;
}

exports.runCampaignSchedule = runCampaignSchedule;
exports.announceCampaign = announceCampaign;
exports._internal = { buildReport, remindPending, schoolAdminIds, SectionSubjectTeacher };
