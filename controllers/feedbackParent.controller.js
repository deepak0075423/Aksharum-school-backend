'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher Feedback — a parent's view of their children's feedback PROGRESS.
//
//  A parent can see which campaigns are open for each child, which of the
//  child's teachers are still to do, and when the window closes — so they can
//  nudge. They can never see what the child answered: this controller does not
//  read FeedbackResponse or FeedbackSelectedOption at all, and it strips the
//  per-assignment rating the assignment row carries. The same line the admin's
//  tracking tab draws — who has responded, never what they said.
// ─────────────────────────────────────────────────────────────────────────────
const FeedbackAssignment = require('../models/FeedbackAssignment');
const FeedbackCampaign   = require('../models/FeedbackCampaign');
const StudentProfile     = require('../models/StudentProfile');
const User               = require('../models/User');
const Subject            = require('../models/Subject');

const fb = require('../services/feedbackService');

const ok   = (res, data) => res.json({ success: true, data });
const fail = (res, e) => {
    console.error('[feedback:parent]', e);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
const sid = fb.sid;

/**
 * Where an assignment stands, in the words a parent needs.
 *
 *   done     — submitted
 *   todo     — not submitted, and the child can still do it today
 *   upcoming — the campaign has not opened yet
 *   missed   — not submitted, and the window has closed
 */
function stateOf(a, c, now) {
    if (a.status === 'submitted') return 'done';
    if (!c) return 'missed';
    if (['closed', 'archived'].includes(c.status)) return 'missed';
    if (c.status === 'scheduled' || (c.startDate && now < new Date(c.startDate))) return 'upcoming';
    if (c.endDate && now > fb.endOfDay(c.endDate)) return 'missed';
    return c.status === 'active' ? 'todo' : 'missed';
}

exports.getChildrenFeedback = async (req, res) => {
    try {
        const school = req.schoolId;

        // A parent's children are the student profiles that name them — the
        // same link every other parent screen uses.
        const profiles = await StudentProfile.find({ parent: req.userId, school }).select('user').lean();
        const childIds = [...new Set(profiles.map((p) => sid(p.user)).filter(Boolean))];
        if (!childIds.length) return ok(res, { children: [] });

        const [kids, assignments] = await Promise.all([
            User.find({ _id: { $in: childIds }, school }).select('name profileImage').lean(),
            // Explicit column list: no overallRating, no categoryScores, no
            // hasComment. Nothing about the content of a submission is loaded.
            FeedbackAssignment.find({ student: { $in: childIds } })
                .select('student teacher subject section campaign status submittedAt').lean(),
        ]);

        const campaignIds = [...new Set(assignments.map((a) => sid(a.campaign)))];
        const teacherIds  = [...new Set(assignments.map((a) => sid(a.teacher)).filter(Boolean))];
        const subjectIds  = [...new Set(assignments.map((a) => sid(a.subject)).filter(Boolean))];
        const sectionIds  = [...new Set(assignments.map((a) => sid(a.section)).filter(Boolean))];

        const [campaigns, teachers, subjects, labels] = await Promise.all([
            campaignIds.length
                ? FeedbackCampaign.find({ _id: { $in: campaignIds }, school, status: { $ne: 'draft' } })
                    .select('name term status startDate endDate isAnonymous').lean()
                : [],
            teacherIds.length ? User.find({ _id: { $in: teacherIds } }).select('name').lean() : [],
            subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
            fb.sectionLabels(sectionIds),
        ]);
        const cMap = new Map(campaigns.map((c) => [sid(c._id), c]));
        const tMap = new Map(teachers.map((t) => [sid(t._id), t.name]));
        const sMap = new Map(subjects.map((x) => [sid(x._id), x.subjectName]));
        const secMap = new Map([...labels.entries()].map(([id, v]) => [id, v.label]));

        const now = new Date();
        const children = childIds
            .map((childId) => {
                const kid = kids.find((k) => sid(k._id) === childId);
                if (!kid) return null;

                const mine = assignments.filter((a) => sid(a.student) === childId && cMap.has(sid(a.campaign)));
                const byCampaign = new Map();
                for (const a of mine) {
                    const k = sid(a.campaign);
                    if (!byCampaign.has(k)) byCampaign.set(k, []);
                    byCampaign.get(k).push(a);
                }

                let className = '';
                const rows = [...byCampaign.entries()].map(([cid, list]) => {
                    const c = cMap.get(cid);
                    const items = list.map((a) => {
                        if (!className && secMap.get(sid(a.section))) className = secMap.get(sid(a.section));
                        return {
                            _id: sid(a._id),
                            teacher: tMap.get(sid(a.teacher)) || 'Teacher',
                            subject: sMap.get(sid(a.subject)) || '',
                            state: stateOf(a, c, now),
                            submittedAt: a.status === 'submitted' ? a.submittedAt : null,
                        };
                    }).sort((x, y) => ['todo', 'upcoming', 'missed', 'done'].indexOf(x.state)
                        - ['todo', 'upcoming', 'missed', 'done'].indexOf(y.state) || x.subject.localeCompare(y.subject));
                    const count = (st) => items.filter((i) => i.state === st).length;
                    const open = items.some((i) => i.state === 'todo');
                    return {
                        _id: cid,
                        name: c.name,
                        term: c.term || '',
                        status: c.status,
                        startDate: c.startDate,
                        endDate: c.endDate,
                        isAnonymous: !!c.isAnonymous,
                        phase: open ? 'open' : items.some((i) => i.state === 'upcoming') ? 'upcoming' : 'finished',
                        total: items.length,
                        done: count('done'),
                        todo: count('todo'),
                        missed: count('missed'),
                        upcoming: count('upcoming'),
                        items,
                    };
                }).sort((a, b) => ['open', 'upcoming', 'finished'].indexOf(a.phase) - ['open', 'upcoming', 'finished'].indexOf(b.phase)
                    || new Date(b.startDate) - new Date(a.startDate));

                const openRows = rows.filter((r) => r.phase === 'open');
                const soonest = openRows
                    .map((r) => r.endDate).filter(Boolean)
                    .sort((a, b) => new Date(a) - new Date(b))[0] || null;

                return {
                    _id: childId,
                    name: kid.name,
                    photo: kid.profileImage || '',
                    className,
                    summary: {
                        openCampaigns: openRows.length,
                        todo: rows.reduce((n, r) => n + r.todo, 0),
                        done: rows.reduce((n, r) => n + r.done, 0),
                        missed: rows.reduce((n, r) => n + r.missed, 0),
                        nextDeadline: soonest,
                    },
                    campaigns: rows,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.summary.todo - a.summary.todo || a.name.localeCompare(b.name));

        ok(res, { children });
    } catch (e) { fail(res, e); }
};
