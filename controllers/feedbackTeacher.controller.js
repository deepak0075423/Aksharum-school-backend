'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback — the teacher's own view (spec §14, §15).
//
//  PRIVACY: this controller only ever reads its own teacher id (req.userId) and
//  never selects a student column. Every figure is withheld below the
//  campaign's minimum-response floor — the campaign total, each category, each
//  question, each subject / section slice — and slices are additionally
//  protected against subtraction (fb.suppressComplements). Raw comments are
//  gated on the school setting too. A teacher therefore cannot: see another
//  teacher's numbers, see who said what, or recover a small group's average by
//  taking one visible figure away from another.
// ─────────────────────────────────────────────────────────────────────────────
const FeedbackCampaign       = require('../models/FeedbackCampaign');
const FeedbackAssignment     = require('../models/FeedbackAssignment');
const FeedbackResponse       = require('../models/FeedbackResponse');
const FeedbackSelectedOption = require('../models/FeedbackSelectedOption');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const Subject                = require('../models/Subject');

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

const shapeCampaign = (c) => ({
    _id: sid(c._id), name: c.name, term: c.term, status: c.status,
    startDate: c.startDate, endDate: c.endDate, isAnonymous: !!c.isAnonymous,
    minimumResponses: c.minimumResponses,
});

/**
 * Group assignments by a key, gate each group by the floor, then protect the
 * groups against subtraction from the total. The same function feeds the
 * breakdown tables and decides which filtered trend points may be shown, so the
 * two screens can never disagree about what is visible.
 */
function slicesBy(assignments, keyOf, nameOf, minimum) {
    const buckets = {};
    for (const a of assignments) {
        const k = keyOf(a);
        if (!k) continue;
        (buckets[k] = buckets[k] || []).push(a);
    }
    const slices = Object.entries(buckets).map(([k, rows]) => {
        const agg = fb.aggregate(rows, minimum);
        return {
            _id: k,
            name: nameOf ? nameOf(k) : k,
            assigned: rows.length,
            responses: agg.responses,
            responseRate: fb.pct(agg.responses, rows.length),
            rating: agg.locked ? null : agg.averageRating,
            locked: agg.locked,
        };
    });
    const total = assignments.filter((a) => a.status === 'submitted').length;
    fb.suppressComplements(slices, total, minimum);
    return slices.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
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

        // The campaign before this one, for the "since last time" comparison.
        const previousCampaign = campaigns
            .filter((c) => new Date(c.startDate) < new Date(wanted.startDate))
            .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0] || null;

        const [assignments, previousRows] = await Promise.all([
            FeedbackAssignment.find({ campaign: wanted._id, teacher: req.userId })
                .select('status overallRating categoryScores subject section hasComment').lean(),
            previousCampaign
                ? FeedbackAssignment.find({ campaign: previousCampaign._id, teacher: req.userId })
                    .select('status overallRating categoryScores').lean()
                : [],
        ]);

        const agg = fb.aggregate(assignments, wanted.minimumResponses);
        const prevAgg = previousCampaign ? fb.aggregate(previousRows, previousCampaign.minimumResponses) : null;
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
                    .select('questionText questionType displayOrder includeInScore categoryName').sort({ displayOrder: 1 }).lean(),
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
            // A student answers a question once, so `answers` is a head count —
            // and an optional question answered by two students is those two
            // students' rating. The floor applies per question.
            questionBreakdown = cqs
                .filter((q) => perQ[sid(q._id)])
                .map((q) => {
                    const { sum, count } = perQ[sid(q._id)];
                    const withheld = count < wanted.minimumResponses;
                    return {
                        question: q.questionText,
                        category: q.categoryName || '',
                        average: withheld ? null : fb.round1(sum / count),
                        answers: count,
                        withheld,
                    };
                });
        }

        ok(res, {
            campaigns: campaigns.map(shapeCampaign),
            campaign: shapeCampaign(wanted),
            summary,
            previous: previousCampaign ? {
                _id: sid(previousCampaign._id), name: previousCampaign.name, term: previousCampaign.term,
                averageRating: prevAgg.locked ? null : prevAgg.averageRating,
                responses: prevAgg.responses,
            } : null,
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
const TREND_DIMENSIONS = ['subject', 'section', 'class'];

exports.getTrends = async (req, res) => {
    try {
        const settings = await fb.getSettings(req.schoolId);
        if (!settings?.teacherCanSeeTrends) {
            return ok(res, { points: [], categories: [], disabled: true });
        }

        // One slice at a time. Two filters together are an intersection, and
        // intersections combined with the single-dimension views are exactly how
        // a small group gets isolated.
        const given = TREND_DIMENSIONS.filter((d) => req.query[d]);
        if (given.length > 1) return bad(res, 'Filter by one of subject, section or class at a time.');
        const dim = given[0] || null;
        const key = dim ? String(req.query[dim]) : null;

        let campaigns = await visibleCampaigns(req.schoolId, settings);
        if (req.query.academicYear) {
            campaigns = campaigns.filter((c) => sid(c.academicYear) === String(req.query.academicYear));
        }
        if (!campaigns.length) return ok(res, { points: [], categories: [], filters: await filterOptions(req), dimension: dim });

        // Always the teacher's WHOLE result set: a filtered point is shown only if
        // its slice survives protection within its own campaign's partition.
        const assignments = await FeedbackAssignment.find({
            campaign: { $in: campaigns.map((c) => c._id) }, teacher: req.userId,
        }).select('campaign status overallRating categoryScores subject section class').lean();

        const byCampaign = assignments.reduce((acc, a) => {
            (acc[sid(a.campaign)] = acc[sid(a.campaign)] || []).push(a);
            return acc;
        }, {});

        // Chronological, oldest first — a trend line reads left to right.
        const ordered = [...campaigns].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        const catNames = new Map();
        const series = {};

        const points = ordered.map((c) => {
            const rows = byCampaign[sid(c._id)] || [];
            const min = c.minimumResponses;
            let chosen = rows;
            let protectedHidden = false;

            if (dim) {
                chosen = rows.filter((r) => sid(r[dim]) === key);
                const slice = slicesBy(rows, (r) => sid(r[dim]), null, min).find((x) => x._id === key);
                protectedHidden = !!slice?.protectsOthers;
            }

            const agg = fb.aggregate(chosen, min);
            const locked = agg.locked || protectedHidden;
            if (!locked) {
                for (const cat of agg.categories) {
                    if (cat.average == null) continue;
                    catNames.set(cat._id, cat.name);
                    (series[cat._id] = series[cat._id] || []).push({ label: c.term || c.name, value: cat.average });
                }
            }
            return {
                campaignId: sid(c._id),
                label: c.term || c.name,
                name: c.name,
                date: c.startDate,
                status: c.status,
                rating: locked ? null : agg.averageRating,
                responses: agg.responses,
                assigned: chosen.length,
                minimumResponses: min,
                locked,
                reason: agg.locked ? (agg.responses === 0 ? 'none' : 'floor') : protectedHidden ? 'protect' : null,
            };
        }).filter((p) => p.assigned > 0);

        ok(res, {
            dimension: dim,
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
    const [subjects, labels] = await Promise.all([
        subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
        fb.sectionLabels(sectionIds),
    ]);
    return {
        subjects: subjects.map((s) => ({ _id: sid(s._id), name: s.subjectName })),
        sections: [...labels.entries()].map(([id, v]) => ({ _id: id, name: v.label })),
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  BREAKDOWN — subject-wise / section-wise cut of the teacher's own results
// ═════════════════════════════════════════════════════════════════════════════
exports.getBreakdown = async (req, res) => {
    try {
        const settings  = await fb.getSettings(req.schoolId);
        const campaigns = await visibleCampaigns(req.schoolId, settings);
        if (!campaigns.length) return ok(res, { bySubject: [], bySection: [], campaign: null, campaigns: [] });

        const wanted = req.query.campaignId
            ? campaigns.find((c) => sid(c._id) === String(req.query.campaignId))
            : campaigns[0];
        if (!wanted) return bad(res, 'Campaign not found.', 404);

        const assignments = await FeedbackAssignment.find({ campaign: wanted._id, teacher: req.userId })
            .select('status overallRating categoryScores subject section class').lean();

        const subjectIds = [...new Set(assignments.map((a) => sid(a.subject)).filter(Boolean))];
        const sectionIds = [...new Set(assignments.map((a) => sid(a.section)).filter(Boolean))];
        const [subjects, labels] = await Promise.all([
            subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
            fb.sectionLabels(sectionIds),
        ]);
        const subjMap = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
        const secMap  = new Map([...labels.entries()].map(([id, v]) => [id, v.label]));

        const overall = fb.aggregate(assignments, wanted.minimumResponses);
        ok(res, {
            campaign: shapeCampaign(wanted),
            campaigns: campaigns.map(shapeCampaign),
            summary: {
                assigned: assignments.length,
                responses: overall.responses,
                responseRate: fb.pct(overall.responses, assignments.length),
                averageRating: overall.locked ? null : overall.averageRating,
                locked: overall.locked,
                minimumResponses: wanted.minimumResponses,
            },
            bySubject: slicesBy(assignments, (a) => sid(a.subject), (k) => subjMap.get(k) || 'Subject', wanted.minimumResponses),
            bySection: slicesBy(assignments, (a) => sid(a.section), (k) => secMap.get(k) || 'Section', wanted.minimumResponses),
        });
    } catch (e) { fail(res, e); }
};

exports._internal = { slicesBy };
