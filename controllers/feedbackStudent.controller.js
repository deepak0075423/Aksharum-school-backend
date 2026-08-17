'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback — student (respondent) controller.
//
//  SECURITY MODEL: every relationship is derived server-side. The client sends
//  an assignment id and a list of answers, nothing else — student, teacher,
//  subject and campaign all come from the stored assignment row, which is
//  re-checked against req.userId on every call. A student cannot address a
//  teacher they were not assigned, cannot reach another student's assignment
//  (404, not 403 — no existence oracle), and cannot resubmit a locked one.
// ─────────────────────────────────────────────────────────────────────────────
const FeedbackCampaign         = require('../models/FeedbackCampaign');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const FeedbackAssignment       = require('../models/FeedbackAssignment');
const FeedbackResponse         = require('../models/FeedbackResponse');
const FeedbackSelectedOption   = require('../models/FeedbackSelectedOption');
const User                     = require('../models/User');
const Subject                  = require('../models/Subject');
const ClassSection             = require('../models/ClassSection');
const TeacherProfile           = require('../models/TeacherProfile');

const fb = require('../services/feedbackService');
const { notify } = require('../services/notifyService');

const ok   = (res, data) => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e) => {
    console.error('[feedback:student]', e);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

const sid = fb.sid;

// ── shared shaping ───────────────────────────────────────────────────────────
function shapeCard(a, campaignsById) {
    const c = campaignsById.get(sid(a.campaign)) || {};
    return {
        _id:         sid(a._id),
        status:      a.status,
        teacher:     { _id: sid(a.teacher), name: a.teacherName || '', designation: a.teacherDesignation || '' },
        subject:     a.subjectName || '',
        className:   a.className   || '',
        sectionName: a.sectionName || '',
        campaign:    { _id: sid(a.campaign), name: c.name || '', endDate: c.endDate || null, isAnonymous: !!c.isAnonymous, term: c.term || '' },
        deadline:    c.endDate || null,
        submittedAt: a.submittedAt || null,
        overallRating: a.status === 'submitted' ? a.overallRating : null,
    };
}

// Decorates raw assignment rows with the display names their cards need, using
// four bounded lookups instead of a populate per row (avoids the N+1 in §27).
async function decorate(rows) {
    const teacherIds = [...new Set(rows.map((r) => sid(r.teacher)).filter(Boolean))];
    const subjectIds = [...new Set(rows.map((r) => sid(r.subject)).filter(Boolean))];
    const sectionIds = [...new Set(rows.map((r) => sid(r.section)).filter(Boolean))];

    const [teachers, subjects, sections] = await Promise.all([
        teacherIds.length ? User.find({ _id: { $in: teacherIds } }).select('name profileImage').lean() : [],
        subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
        sectionIds.length ? ClassSection.find({ _id: { $in: sectionIds } })
            .select('sectionName class').populate('class', 'className').lean() : [],
    ]);

    const tMap = new Map(teachers.map((t) => [sid(t._id), t]));
    const sMap = new Map(subjects.map((s) => [sid(s._id), s]));
    const secMap = new Map(sections.map((s) => [sid(s._id), s]));

    for (const r of rows) {
        r.teacherName = tMap.get(sid(r.teacher))?.name || 'Teacher';
        r.subjectName = sMap.get(sid(r.subject))?.subjectName || '';
        const sec = secMap.get(sid(r.section));
        r.sectionName = sec?.sectionName || '';
        r.className   = sec?.class?.className || '';
    }
    return rows;
}

async function loadCampaigns(rows) {
    const ids = [...new Set(rows.map((r) => sid(r.campaign)).filter(Boolean))];
    if (!ids.length) return new Map();
    const list = await FeedbackCampaign.find({ _id: { $in: ids } })
        .select('name endDate startDate isAnonymous status term instructions minimumResponses').lean();
    return new Map(list.map((c) => [sid(c._id), c]));
}

// ═════════════════════════════════════════════════════════════════════════════
//  LISTS
// ═════════════════════════════════════════════════════════════════════════════

// Pending = not yet submitted, on a campaign that is currently accepting input.
exports.getPending = async (req, res) => {
    try {
        const rows = await FeedbackAssignment.find({
            student: req.userId,
            status:  { $in: ['pending', 'in_progress'] },
        }).sort({ assignedAt: -1 }).lean();

        const campaigns = await loadCampaigns(rows);
        const now = new Date();
        const open = rows.filter((r) => {
            const c = campaigns.get(sid(r.campaign));
            return c && !fb.submissionBlockReason(c, now);
        });
        await decorate(open);
        ok(res, open.map((r) => shapeCard(r, campaigns)));
    } catch (e) { fail(res, e); }
};

exports.getCompleted = async (req, res) => {
    try {
        const rows = await FeedbackAssignment.find({ student: req.userId, status: 'submitted' })
            .sort({ submittedAt: -1 }).limit(200).lean();
        const campaigns = await loadCampaigns(rows);
        await decorate(rows);
        ok(res, rows.map((r) => shapeCard(r, campaigns)));
    } catch (e) { fail(res, e); }
};

// Small header for the student dashboard / mobile tile.
exports.getSummary = async (req, res) => {
    try {
        const rows = await FeedbackAssignment.find({ student: req.userId })
            .select('status campaign').lean();
        const campaigns = await loadCampaigns(rows);
        const now = new Date();
        let pending = 0, completed = 0, nextDeadline = null;
        for (const r of rows) {
            if (r.status === 'submitted') { completed += 1; continue; }
            const c = campaigns.get(sid(r.campaign));
            if (!c || fb.submissionBlockReason(c, now)) continue;
            pending += 1;
            if (c.endDate && (!nextDeadline || new Date(c.endDate) < new Date(nextDeadline))) nextDeadline = c.endDate;
        }
        ok(res, { pending, completed, total: pending + completed, nextDeadline });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  FORM
// ═════════════════════════════════════════════════════════════════════════════
// Ownership is the filter, not a check after the fact: the query itself is
// scoped to req.userId, so a guessed id simply returns nothing (IDOR-proof).
async function loadOwnAssignment(req) {
    return FeedbackAssignment.findOne({ _id: req.params.id, student: req.userId }).lean();
}

exports.getForm = async (req, res) => {
    try {
        const a = await loadOwnAssignment(req);
        if (!a) return bad(res, 'Feedback assignment not found.', 404);

        const campaign = await FeedbackCampaign.findById(a.campaign).lean();
        const blocked  = fb.submissionBlockReason(campaign);
        if (a.status === 'submitted') return bad(res, 'You have already submitted this feedback.', 409);
        if (blocked) return bad(res, blocked, 409);

        const questions = await FeedbackCampaignQuestion.find({ campaign: a.campaign })
            .sort({ displayOrder: 1 }).lean();
        await decorate([a]);

        const profile = await TeacherProfile.findOne({ user: a.teacher }).select('designation').lean();

        // First open marks the assignment in_progress — used by the admin
        // response funnel and nothing else.
        if (a.status === 'pending') {
            await FeedbackAssignment.updateOne(
                { _id: a._id, status: 'pending' },
                { $set: { status: 'in_progress', startedAt: new Date() } },
            );
        }

        ok(res, {
            assignment: {
                _id: sid(a._id),
                status: a.status === 'pending' ? 'in_progress' : a.status,
                teacher: { name: a.teacherName, designation: profile?.designation || 'Teacher' },
                subject: a.subjectName,
                className: a.className,
                sectionName: a.sectionName,
            },
            campaign: {
                _id: sid(campaign._id),
                name: campaign.name,
                term: campaign.term,
                instructions: campaign.instructions,
                isAnonymous: !!campaign.isAnonymous,
                endDate: campaign.endDate,
            },
            // The form is entirely question-bank driven — the client renders
            // whatever comes back here and hardcodes nothing (spec §7).
            questions: questions.map((q) => ({
                _id: sid(q._id),
                questionText: q.questionText,
                questionType: q.questionType,
                categoryName: q.categoryName,
                helpText: q.helpText,
                isRequired: q.isRequired,
                maxLength: q.maxLength,
                displayOrder: q.displayOrder,
                options: (q.options || []).map((o) => ({
                    _id: o._id, optionText: o.optionText, allowsFreeText: !!o.allowsFreeText,
                })),
            })),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  SUBMIT (rules 3, 4, 7–11)
// ═════════════════════════════════════════════════════════════════════════════
const RATING_TYPES = ['rating_5', 'emoji_5'];

exports.submit = async (req, res) => {
    try {
        const a = await loadOwnAssignment(req);
        if (!a) return bad(res, 'Feedback assignment not found.', 404);
        if (a.status === 'submitted') return bad(res, 'You have already submitted this feedback.', 409);

        const campaign = await FeedbackCampaign.findById(a.campaign).lean();
        const blocked  = fb.submissionBlockReason(campaign);
        if (blocked) return bad(res, blocked, 409);

        const questions = await FeedbackCampaignQuestion.find({ campaign: a.campaign })
            .sort({ displayOrder: 1 }).lean();
        if (!questions.length) return bad(res, 'This campaign has no questions configured.', 409);

        const qById = new Map(questions.map((q) => [sid(q._id), q]));
        const incoming = Array.isArray(req.body?.answers) ? req.body.answers : [];
        const byQuestion = new Map();
        for (const raw of incoming) {
            const qid = sid(raw?.campaignQuestion);
            if (qById.has(qid)) byQuestion.set(qid, raw);   // unknown ids are dropped, not trusted
        }

        // ── Validate ────────────────────────────────────────────────────────
        const prepared = [];
        for (const q of questions) {
            const qid = sid(q._id);
            const raw = byQuestion.get(qid) || {};
            const label = q.questionText;

            if (RATING_TYPES.includes(q.questionType)) {
                const v = raw.ratingValue == null || raw.ratingValue === '' ? null : Number(raw.ratingValue);
                if (v == null) {
                    if (q.isRequired) return bad(res, `Please rate: "${label}".`);
                } else if (!Number.isInteger(v) || v < 1 || v > 5) {
                    return bad(res, `Invalid rating for "${label}" — pick a value from 1 to 5.`);
                }
                prepared.push({ q, ratingValue: v, textResponse: '', options: [] });
                continue;
            }

            if (q.questionType === 'yes_no') {
                const t = String(raw.textResponse ?? '').trim().toLowerCase();
                if (!t) {
                    if (q.isRequired) return bad(res, `Please answer: "${label}".`);
                    prepared.push({ q, ratingValue: null, textResponse: '', options: [] });
                    continue;
                }
                if (!['yes', 'no'].includes(t)) return bad(res, `Invalid answer for "${label}".`);
                // Mapped onto the 1–5 scale so yes/no questions can still carry
                // a category score when the school marks them scored.
                prepared.push({ q, ratingValue: t === 'yes' ? 5 : 1, textResponse: t, options: [] });
                continue;
            }

            if (q.questionType === 'text') {
                const t = String(raw.textResponse ?? '').trim();
                const max = q.maxLength || 1000;
                if (!t && q.isRequired) return bad(res, `Please answer: "${label}".`);
                if (t.length > max) return bad(res, `"${label}" must be ${max} characters or fewer.`);
                prepared.push({ q, ratingValue: null, textResponse: t, options: [] });
                continue;
            }

            // multiple_choice / checkbox
            const allowed = new Map((q.options || []).map((o) => [String(o._id), o]));
            let picked = Array.isArray(raw.optionIds) ? raw.optionIds.map(String) : [];
            picked = [...new Set(picked)].filter((id) => allowed.has(id));   // drop anything not in the snapshot
            if (q.questionType === 'multiple_choice' && picked.length > 1) picked = picked.slice(0, 1);
            if (!picked.length && q.isRequired) return bad(res, `Please choose an option for "${label}".`);

            const otherText = String(raw.otherText ?? '').trim().slice(0, 200);
            prepared.push({
                q, ratingValue: null, textResponse: otherText,
                options: picked.map((id) => allowed.get(id)),
            });
        }

        // ── Persist ─────────────────────────────────────────────────────────
        // The lock is taken FIRST, as a single conditional UPDATE. Winning it is
        // what authorises the answer rows, so two racing submits can never both
        // write a set of responses and double-count the teacher's average. The
        // authoritative score lives on the assignment row and is written by the
        // lock itself, so analytics is correct even if a later insert fails.
        const { overallRating, categoryScores } = fb.scoreSubmission(prepared.map((p) => ({
            ratingValue: p.ratingValue,
            includeInScore: p.q.includeInScore,
            category: p.q.category,
            categoryName: p.q.categoryName,
        })));
        const hasComment = prepared.some((p) => p.q.questionType === 'text' && p.textResponse);

        const won = await fb.lockSubmission(a._id, { overallRating, categoryScores, hasComment });
        if (!won) return bad(res, 'You have already submitted this feedback.', 409);

        for (const p of prepared) {
            const isEmpty = p.ratingValue == null && !p.textResponse && !p.options.length;
            if (isEmpty) continue;                       // skip blanks on optional questions
            const response = await FeedbackResponse.create({
                school:     a.school,
                campaign:   a.campaign,
                assignment: a._id,
                teacher:    a.teacher,
                subject:    a.subject,
                campaignQuestion: p.q._id,
                question:   p.q.question,
                category:   p.q.category,
                questionType: p.q.questionType,
                ratingValue: p.ratingValue,
                textResponse: p.textResponse,
                includeInScore: !!p.q.includeInScore,
            });
            for (const o of p.options) {
                await FeedbackSelectedOption.create({
                    school:   a.school,
                    campaign: a.campaign,
                    response: response._id,
                    assignment: a._id,
                    teacher:  a.teacher,
                    campaignQuestion: p.q._id,
                    option:   String(o._id),
                    optionText: o.optionText,
                    optionValue: o.optionValue || '',
                });
            }
        }

        await fb.incrementCampaignStats(a.campaign, {
            submitted: 1,
            ratingSum: overallRating || 0,
            ratingCount: overallRating == null ? 0 : 1,
        });
        await fb.logAudit(req, 'submit', 'Assignment', a._id, 'Feedback submitted', {
            campaign: a.campaign, assignment: a._id,
            meta: { anonymous: !!a.isAnonymous, teacher: sid(a.teacher) },
        });

        const settings = await fb.getSettings(a.school);
        if (settings?.notifyOnSubmission) {
            notify({
                school: a.school, sender: req.userId, senderRole: req.userRole,
                title: 'Feedback submitted',
                body:  `Your feedback for ${campaign.name} has been submitted successfully. Thank you!`,
                recipients: [req.userId], includeSender: true,
            });
        }

        ok(res, { _id: sid(a._id), status: 'submitted', submittedAt: new Date(), message: 'Feedback submitted successfully.' });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  COMPLETED DETAIL — a student may re-read their own submission (read-only)
// ═════════════════════════════════════════════════════════════════════════════
exports.getSubmission = async (req, res) => {
    try {
        const a = await loadOwnAssignment(req);
        if (!a) return bad(res, 'Feedback assignment not found.', 404);
        if (a.status !== 'submitted') return bad(res, 'This feedback has not been submitted yet.', 409);

        const [campaign, questions, responses] = await Promise.all([
            FeedbackCampaign.findById(a.campaign).select('name term isAnonymous endDate').lean(),
            FeedbackCampaignQuestion.find({ campaign: a.campaign }).sort({ displayOrder: 1 }).lean(),
            FeedbackResponse.find({ assignment: a._id }).lean(),
        ]);
        const selected = await FeedbackSelectedOption.find({ assignment: a._id }).lean();

        const respByQ = new Map(responses.map((r) => [sid(r.campaignQuestion), r]));
        const optsByQ = selected.reduce((acc, s) => {
            (acc[sid(s.campaignQuestion)] = acc[sid(s.campaignQuestion)] || []).push(s.optionText);
            return acc;
        }, {});
        await decorate([a]);

        ok(res, {
            assignment: {
                _id: sid(a._id),
                submittedAt: a.submittedAt,
                overallRating: a.overallRating,
                teacher: { name: a.teacherName },
                subject: a.subjectName,
                className: a.className,
                sectionName: a.sectionName,
            },
            campaign,
            answers: questions.map((q) => {
                const r = respByQ.get(sid(q._id));
                return {
                    _id: sid(q._id),
                    questionText: q.questionText,
                    questionType: q.questionType,
                    categoryName: q.categoryName,
                    ratingValue: r?.ratingValue ?? null,
                    textResponse: r?.textResponse || '',
                    selectedOptions: optsByQ[sid(q._id)] || [],
                };
            }),
        });
    } catch (e) { fail(res, e); }
};
