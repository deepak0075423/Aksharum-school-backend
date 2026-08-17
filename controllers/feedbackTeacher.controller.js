'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback — the teacher's own view (spec §14, §15).
//
//  PRIVACY: this controller only ever reads its own teacher id (req.userId) and
//  never selects a student column. Aggregates are withheld until the campaign's
//  minimum-response threshold is met, and raw comments are additionally gated on
//  the school setting. A teacher therefore cannot: see another teacher's
//  numbers, see who said what, or infer an individual from a two-response
//  average.
// ─────────────────────────────────────────────────────────────────────────────
const FeedbackCampaign       = require('../models/FeedbackCampaign');
const FeedbackAssignment     = require('../models/FeedbackAssignment');
const FeedbackResponse       = require('../models/FeedbackResponse');
const FeedbackSelectedOption = require('../models/FeedbackSelectedOption');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const Subject                = require('../models/Subject');
const ClassSection           = require('../models/ClassSection');

const fb = require('../services/feedbackService');

const ok   = (res, data) => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e) => {
    console.error('[feedback:teacher]', e);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
const sid = fb.sid;

// Campaigns whose results this teacher is allowed to look at. When the school
// holds results back until closure, running campaigns are simply not listed.
async function visibleCampaigns(schoolId, settings) {
    const filter = { school: schoolId, status: { $in: ['active', 'closed', 'archived'] } };
    if (settings?.publishToTeachersOnClose) filter.status = { $in: ['closed', 'archived'] };
    return FeedbackCampaign.find(filter)
        .select('name term academicYear startDate endDate status isAnonymous minimumResponses')
        .sort({ startDate: -1 }).lean();
}

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
exports.getDashboard = async (req, res) => {
    try {
        const settings  = await fb.getSettings(req.schoolId);
        const campaigns = await visibleCampaigns(req.schoolId, settings);
        if (!campaigns.length) {
            return ok(res, { campaigns: [], campaign: null, summary: null, categories: [], comments: [], options: null });
        }

        const wanted = req.query.campaignId
            ? campaigns.find((c) => sid(c._id) === String(req.query.campaignId))
            : campaigns[0];
        if (!wanted) return bad(res, 'Campaign not found.', 404);

        const assignments = await FeedbackAssignment.find({ campaign: wanted._id, teacher: req.userId })
            .select('status overallRating categoryScores subject section hasComment').lean();

        const agg = fb.aggregate(assignments, wanted.minimumResponses);
        const summary = {
            assigned:     assignments.length,
            responses:    agg.responses,
            responseRate: fb.pct(agg.responses, assignments.length),
            averageRating: agg.locked ? null : agg.averageRating,
            locked:       agg.locked,
            minimumResponses: wanted.minimumResponses,
            message:      agg.message || null,
        };

        // Everything below the fold is withheld while the aggregate is locked.
        let comments = [];
        let options  = null;
        let questionBreakdown = [];
        if (!agg.locked) {
            const [rawComments, picks, cqs, responses] = await Promise.all([
                settings?.teacherCanSeeComments
                    ? FeedbackResponse.find({ campaign: wanted._id, teacher: req.userId, questionType: 'text' })
                        .select('textResponse createdAt').sort({ createdAt: -1 }).limit(100).lean()
                    : [],
                FeedbackSelectedOption.find({ campaign: wanted._id, teacher: req.userId })
                    .select('campaignQuestion optionText').lean(),
                FeedbackCampaignQuestion.find({ campaign: wanted._id })
                    .select('questionText questionType displayOrder includeInScore').sort({ displayOrder: 1 }).lean(),
                FeedbackResponse.find({ campaign: wanted._id, teacher: req.userId, includeInScore: true })
                    .select('campaignQuestion ratingValue').lean(),
            ]);

            // Comments are returned as bare text with no ordering tie to the
            // assignment list — nothing here can be walked back to a student.
            comments = rawComments
                .filter((c) => (c.textResponse || '').trim())
                .map((c) => ({ text: c.textResponse }));

            const cqById = new Map(cqs.map((q) => [sid(q._id), q]));
            const optionTally = {};
            for (const p of picks) {
                const q = cqById.get(sid(p.campaignQuestion));
                if (!q) continue;
                const bucket = (optionTally[q.questionText] = optionTally[q.questionText] || {});
                bucket[p.optionText] = (bucket[p.optionText] || 0) + 1;
            }
            options = Object.entries(optionTally).map(([question, tally]) => ({
                question,
                options: Object.entries(tally)
                    .map(([label, count]) => ({ label, count, percent: fb.pct(count, agg.responses) }))
                    .sort((a, b) => b.count - a.count),
            }));

            const perQ = {};
            for (const r of responses) {
                if (r.ratingValue == null) continue;
                const k = sid(r.campaignQuestion);
                const cur = perQ[k] || { sum: 0, count: 0 };
                cur.sum += Number(r.ratingValue); cur.count += 1;
                perQ[k] = cur;
            }
            questionBreakdown = cqs
                .filter((q) => perQ[sid(q._id)])
                .map((q) => ({
                    question: q.questionText,
                    average: fb.round1(perQ[sid(q._id)].sum / perQ[sid(q._id)].count),
                    answers: perQ[sid(q._id)].count,
                }));
        }

        ok(res, {
            campaigns: campaigns.map((c) => ({
                _id: sid(c._id), name: c.name, term: c.term, status: c.status,
                startDate: c.startDate, endDate: c.endDate,
            })),
            campaign: {
                _id: sid(wanted._id), name: wanted.name, term: wanted.term, status: wanted.status,
                startDate: wanted.startDate, endDate: wanted.endDate, isAnonymous: !!wanted.isAnonymous,
            },
            summary,
            categories:  agg.categories,
            strengths:   agg.strengths || [],
            improvements: agg.improvements || [],
            questionBreakdown,
            comments,
            options,
            settings: {
                canSeeComments: !!settings?.teacherCanSeeComments,
                canSeeTrends:   !!settings?.teacherCanSeeTrends,
            },
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  TRENDS (spec §15)
// ═════════════════════════════════════════════════════════════════════════════
exports.getTrends = async (req, res) => {
    try {
        const settings = await fb.getSettings(req.schoolId);
        if (!settings?.teacherCanSeeTrends) {
            return ok(res, { points: [], categories: [], disabled: true });
        }

        let campaigns = await visibleCampaigns(req.schoolId, settings);
        if (req.query.academicYear) {
            campaigns = campaigns.filter((c) => sid(c.academicYear) === String(req.query.academicYear));
        }
        if (!campaigns.length) return ok(res, { points: [], categories: [] });

        const filter = { campaign: { $in: campaigns.map((c) => c._id) }, teacher: req.userId };
        if (req.query.subject) filter.subject = req.query.subject;
        if (req.query.section) filter.section = req.query.section;
        if (req.query.class)   filter.class   = req.query.class;

        const assignments = await FeedbackAssignment.find(filter)
            .select('campaign status overallRating categoryScores').lean();

        const byCampaign = assignments.reduce((acc, a) => {
            (acc[sid(a.campaign)] = acc[sid(a.campaign)] || []).push(a);
            return acc;
        }, {});

        // Chronological, oldest first — a trend line reads left to right.
        const ordered = [...campaigns].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        const points = ordered.map((c) => {
            const agg = fb.aggregate(byCampaign[sid(c._id)] || [], c.minimumResponses);
            return {
                campaignId: sid(c._id),
                label: c.term || c.name,
                name: c.name,
                date: c.startDate,
                rating: agg.locked ? null : agg.averageRating,
                responses: agg.responses,
                locked: agg.locked,
            };
        });

        // Category movement across the same campaigns.
        const catNames = new Map();
        const series = {};
        for (const c of ordered) {
            const agg = fb.aggregate(byCampaign[sid(c._id)] || [], c.minimumResponses);
            if (agg.locked) continue;
            for (const cat of agg.categories) {
                catNames.set(cat._id, cat.name);
                (series[cat._id] = series[cat._id] || []).push({ label: c.term || c.name, value: cat.average });
            }
        }

        ok(res, {
            points,
            categories: [...catNames.entries()].map(([id, name]) => ({ _id: id, name, points: series[id] || [] })),
            filters: await filterOptions(req),
        });
    } catch (e) { fail(res, e); }
};

// Only the subjects / sections this teacher was actually evaluated on — the
// filter dropdowns cannot be used to enumerate the rest of the school.
async function filterOptions(req) {
    const rows = await FeedbackAssignment.find({ teacher: req.userId })
        .select('subject section class').lean();
    const subjectIds = [...new Set(rows.map((r) => sid(r.subject)).filter(Boolean))];
    const sectionIds = [...new Set(rows.map((r) => sid(r.section)).filter(Boolean))];
    const [subjects, sections] = await Promise.all([
        subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
        sectionIds.length ? ClassSection.find({ _id: { $in: sectionIds } })
            .select('sectionName class').populate('class', 'className').lean() : [],
    ]);
    return {
        subjects: subjects.map((s) => ({ _id: sid(s._id), name: s.subjectName })),
        sections: sections.map((s) => ({ _id: sid(s._id), name: `${s.class?.className || ''} ${s.sectionName}`.trim() })),
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  MY FEEDBACK — subject-wise / class-wise cut of the teacher's own results
// ═════════════════════════════════════════════════════════════════════════════
exports.getBreakdown = async (req, res) => {
    try {
        const settings  = await fb.getSettings(req.schoolId);
        const campaigns = await visibleCampaigns(req.schoolId, settings);
        if (!campaigns.length) return ok(res, { bySubject: [], bySection: [], campaign: null });

        const wanted = req.query.campaignId
            ? campaigns.find((c) => sid(c._id) === String(req.query.campaignId))
            : campaigns[0];
        if (!wanted) return bad(res, 'Campaign not found.', 404);

        const assignments = await FeedbackAssignment.find({ campaign: wanted._id, teacher: req.userId })
            .select('status overallRating categoryScores subject section class').lean();

        const subjectIds = [...new Set(assignments.map((a) => sid(a.subject)).filter(Boolean))];
        const sectionIds = [...new Set(assignments.map((a) => sid(a.section)).filter(Boolean))];
        const [subjects, sections] = await Promise.all([
            subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
            sectionIds.length ? ClassSection.find({ _id: { $in: sectionIds } })
                .select('sectionName class').populate('class', 'className').lean() : [],
        ]);
        const subjMap = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
        const secMap  = new Map(sections.map((s) => [sid(s._id), `${s.class?.className || ''} ${s.sectionName}`.trim()]));

        // Each slice carries the SAME minimum-response floor, so slicing a
        // cohort thin can never be used to isolate one respondent.
        const group = (keyOf, nameOf) => {
            const buckets = {};
            for (const a of assignments) {
                const k = keyOf(a);
                if (!k) continue;
                (buckets[k] = buckets[k] || []).push(a);
            }
            return Object.entries(buckets).map(([k, rows]) => {
                const agg = fb.aggregate(rows, wanted.minimumResponses);
                return {
                    _id: k,
                    name: nameOf(k),
                    assigned: rows.length,
                    responses: agg.responses,
                    responseRate: fb.pct(agg.responses, rows.length),
                    rating: agg.locked ? null : agg.averageRating,
                    locked: agg.locked,
                };
            }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
        };

        ok(res, {
            campaign: { _id: sid(wanted._id), name: wanted.name, term: wanted.term, status: wanted.status },
            campaigns: campaigns.map((c) => ({ _id: sid(c._id), name: c.name, term: c.term, status: c.status })),
            bySubject: group((a) => sid(a.subject), (k) => subjMap.get(k) || 'Subject'),
            bySection: group((a) => sid(a.section), (k) => secMap.get(k) || 'Section'),
        });
    } catch (e) { fail(res, e); }
};
