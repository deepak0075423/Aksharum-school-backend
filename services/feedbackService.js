'use strict';
/**
 * Feedback module — shared domain services.
 * ─────────────────────────────────────────
 * Everything that more than one feedback controller needs lives here: the
 * default question set, campaign→assignment generation, the aggregation and
 * privacy rules, role resolution and audit logging.
 *
 * Two invariants are enforced here rather than in the controllers, because
 * every read path must obey them:
 *
 *   • MINIMUM RESPONSES — aggregates for a teacher are withheld until the
 *     campaign's threshold is met (spec §10). `aggregate()` returns a locked
 *     shell instead of the numbers, so a controller cannot forget to check.
 *   • ANONYMITY — nothing in this file ever returns a student reference on a
 *     teacher/principal read path. Respondent identity is reachable only via
 *     FeedbackAssignment.student, which only the admin surfaces query.
 */
const pool = require('../db/pool');

const FeedbackCategory         = require('../models/FeedbackCategory');
const FeedbackQuestion         = require('../models/FeedbackQuestion');
const FeedbackQuestionOption   = require('../models/FeedbackQuestionOption');
const FeedbackCampaign         = require('../models/FeedbackCampaign');
const FeedbackCampaignQuestion = require('../models/FeedbackCampaignQuestion');
const FeedbackAssignment       = require('../models/FeedbackAssignment');
const FeedbackTemplate         = require('../models/FeedbackTemplate');
const FeedbackSettings         = require('../models/FeedbackSettings');
const FeedbackAuditLog         = require('../models/FeedbackAuditLog');

const ClassSection          = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const TeacherProfile        = require('../models/TeacherProfile');
const AcademicYear          = require('../models/AcademicYear');

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sid   = (v) => (v == null ? '' : String(v._id ?? v));
const round1 = (n) => (n == null ? null : Math.round(Number(n) * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const pct   = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const idSet = (arr) => new Set((arr || []).map(sid).filter(Boolean));

// Designations that unlock the school-wide (principal) analytics view. Mirrors
// the Librarian designation pattern used by the library module — the ERP has no
// principal role on User.
const PRINCIPAL_DESIGNATIONS = ['Principal', 'Vice Principal', 'Headmaster', 'Headmistress'];

// ═════════════════════════════════════════════════════════════════════════════
//  DEFAULTS (spec §7, §8, §13)
// ═════════════════════════════════════════════════════════════════════════════
const DEFAULT_CATEGORIES = [
    { slug: 'teaching_quality',     name: 'Teaching Quality',     description: 'Clarity, pace and delivery of lessons' },
    { slug: 'subject_knowledge',    name: 'Subject Knowledge',    description: 'Command over the subject matter' },
    { slug: 'communication',        name: 'Communication',        description: 'How clearly the teacher communicates' },
    { slug: 'classroom_management', name: 'Classroom Management', description: 'Discipline, fairness and class atmosphere' },
    { slug: 'student_engagement',   name: 'Student Engagement',   description: 'Participation and interest generated' },
    { slug: 'student_support',      name: 'Student Support',      description: 'Doubt clearing and individual help' },
    { slug: 'assessment',           name: 'Assessment',           description: 'Tests, homework and feedback on work' },
    { slug: 'overall',              name: 'Overall',              description: 'Overall evaluation' },
];

// The default 2–3 minute questionnaire. 14 rating questions + 2 option
// questions + 1 optional comment — deliberately short (spec §2).
const DEFAULT_QUESTIONS = [
    // A. Teaching Quality
    { seedKey: 'tq_clear',      category: 'teaching_quality',     text: 'Explains concepts clearly' },
    { seedKey: 'tq_knowledge',  category: 'subject_knowledge',    text: 'Demonstrates good subject knowledge' },
    { seedKey: 'tq_examples',   category: 'teaching_quality',     text: 'Uses practical examples' },
    { seedKey: 'tq_pace',       category: 'teaching_quality',     text: 'Maintains an appropriate teaching pace' },
    // B. Student Support
    { seedKey: 'ss_doubts',     category: 'student_support',      text: 'Clarifies doubts effectively' },
    { seedKey: 'ss_feedback',   category: 'assessment',           text: 'Provides useful feedback on my work' },
    { seedKey: 'ss_help',       category: 'student_support',      text: 'Helps students when needed' },
    // C. Classroom Management
    { seedKey: 'cm_discipline', category: 'classroom_management', text: 'Maintains discipline in class' },
    { seedKey: 'cm_fair',       category: 'classroom_management', text: 'Treats students fairly' },
    { seedKey: 'cm_comfort',    category: 'classroom_management', text: 'Creates a comfortable learning environment' },
    // D. Student Engagement
    { seedKey: 'se_particip',   category: 'student_engagement',   text: 'Encourages participation' },
    { seedKey: 'se_interest',   category: 'student_engagement',   text: 'Makes lessons interesting' },
    { seedKey: 'se_questions',  category: 'communication',        text: 'Encourages students to ask questions' },
    // E. Overall
    { seedKey: 'ov_overall',    category: 'overall',              text: 'Overall teaching quality' },

    // Step 2 — qualitative (spec §8)
    {
        seedKey: 'q_likes', category: 'overall', type: 'checkbox', required: false, includeInScore: false,
        text: 'What do you like about this teacher?',
        help: 'Pick everything that applies',
        options: [
            'Explains concepts clearly', 'Helps students with doubts', 'Makes classes interesting',
            'Uses practical examples', 'Encourages students', 'Maintains discipline',
            'Gives useful feedback', 'Treats students fairly', 'Other',
        ],
    },
    {
        seedKey: 'q_improve', category: 'overall', type: 'checkbox', required: false, includeInScore: false,
        text: 'What can be improved?',
        help: 'Pick everything that applies',
        options: [
            'Explanation of concepts', 'Teaching pace', 'Doubt clarification', 'Communication',
            'Teaching methods', 'Homework/assignments', 'Student interaction',
            'Classroom management', 'Other',
        ],
    },
    {
        seedKey: 'q_comments', category: 'overall', type: 'text', required: false, includeInScore: false,
        text: 'Additional comments',
        help: 'Optional — maximum 1000 characters',
        maxLength: 1000,
    },
];

const DEFAULT_TEMPLATE_NAME = 'Standard Teacher Evaluation';

// ═════════════════════════════════════════════════════════════════════════════
//  AUDIT
// ═════════════════════════════════════════════════════════════════════════════
async function logAudit(req, actionType, entityType, entityId, description, extra = {}) {
    try {
        await FeedbackAuditLog.create({
            school: req.schoolId,
            user:   req.userId,
            role:   req.userRole,
            actionType, entityType, entityId, description,
            campaign:   extra.campaign   || null,
            assignment: extra.assignment || null,
            meta:       extra.meta       || {},
        });
    } catch { /* audit is best-effort; never blocks the action */ }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function getSettings(schoolId) {
    let s = await FeedbackSettings.findOne({ school: schoolId }).lean();
    if (!s) {
        try {
            s = (await FeedbackSettings.create({ school: schoolId })).toObject?.()
                ?? await FeedbackSettings.findOne({ school: schoolId }).lean();
        } catch {
            // Lost a create race with a parallel request — read the winner.
            s = await FeedbackSettings.findOne({ school: schoolId }).lean();
        }
    }
    return s;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROLE RESOLUTION
// ═════════════════════════════════════════════════════════════════════════════
// Feedback recognises four capability levels. `school_admin` is the manager,
// a teacher whose designation is Principal / Vice Principal additionally gets
// the school-wide read-only view, every other teacher sees only their own.
async function isPrincipal(userId) {
    const p = await TeacherProfile.findOne({ user: userId }).select('designation').lean();
    return PRINCIPAL_DESIGNATIONS.includes(p?.designation || '');
}

async function resolveAccess(req) {
    if (req.userRole === 'school_admin') {
        return { canManage: true, canSeeSchoolWide: true, isPrincipal: false };
    }
    if (req.userRole === 'teacher') {
        const principal = await isPrincipal(req.userId);
        return { canManage: false, canSeeSchoolWide: principal, isPrincipal: principal };
    }
    return { canManage: false, canSeeSchoolWide: false, isPrincipal: false };
}

// ═════════════════════════════════════════════════════════════════════════════
//  SEEDING — default categories, question bank and template
// ═════════════════════════════════════════════════════════════════════════════
// Idempotent: matches on (school, slug/seedKey) and only fills the gaps, so it
// is safe to call on every admin visit to the question bank.
async function seedDefaults(schoolId, userId = null) {
    const created = { categories: 0, questions: 0, options: 0, templates: 0 };

    const existingCats = await FeedbackCategory.find({ school: schoolId }).lean();
    const catBySlug = new Map(existingCats.filter((c) => c.slug).map((c) => [c.slug, c]));
    const catByName = new Map(existingCats.map((c) => [c.name.toLowerCase(), c]));

    for (const [i, def] of DEFAULT_CATEGORIES.entries()) {
        if (catBySlug.has(def.slug)) continue;
        const byName = catByName.get(def.name.toLowerCase());
        if (byName) {
            // Same category exists without a slug (hand-made) — adopt it.
            await FeedbackCategory.updateOne({ _id: byName._id }, { $set: { slug: def.slug } });
            catBySlug.set(def.slug, { ...byName, slug: def.slug });
            continue;
        }
        const row = await FeedbackCategory.create({
            school: schoolId, name: def.name, description: def.description,
            slug: def.slug, displayOrder: i, createdBy: userId,
        });
        catBySlug.set(def.slug, row);
        created.categories += 1;
    }

    const existingQs = await FeedbackQuestion.find({ school: schoolId, seedKey: { $ne: '' } }).lean();
    const qBySeed = new Map(existingQs.map((q) => [q.seedKey, q]));

    for (const [i, def] of DEFAULT_QUESTIONS.entries()) {
        if (qBySeed.has(def.seedKey)) continue;
        const cat = catBySlug.get(def.category);
        const q = await FeedbackQuestion.create({
            school:         schoolId,
            category:       cat ? cat._id : null,
            questionText:   def.text,
            questionType:   def.type ?? 'rating_5',
            feedbackType:   'any',
            isRequired:     def.required !== false,
            includeInScore: def.includeInScore !== false && (def.type ?? 'rating_5') !== 'text' && (def.type ?? 'rating_5') !== 'checkbox',
            helpText:       def.help || '',
            maxLength:      def.maxLength || 1000,
            displayOrder:   i,
            seedKey:        def.seedKey,
            createdBy:      userId,
        });
        qBySeed.set(def.seedKey, q);
        created.questions += 1;

        for (const [oi, text] of (def.options || []).entries()) {
            await FeedbackQuestionOption.create({
                school: schoolId, question: q._id, optionText: text,
                optionValue: text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
                allowsFreeText: text === 'Other',
                displayOrder: oi,
            });
            created.options += 1;
        }
    }

    const tpl = await FeedbackTemplate.findOne({ school: schoolId, isDefault: true }).lean();
    if (!tpl) {
        const questions = DEFAULT_QUESTIONS
            .map((d, i) => {
                const q = qBySeed.get(d.seedKey);
                return q ? { question: sid(q._id), displayOrder: i, isRequired: d.required !== false } : null;
            })
            .filter(Boolean);
        try {
            await FeedbackTemplate.create({
                school: schoolId,
                name: DEFAULT_TEMPLATE_NAME,
                description: 'The default 2-minute teacher evaluation: 14 rating questions, likes / improvements and an optional comment.',
                feedbackType: 'student_teacher',
                instructions: 'Your feedback is confidential and helps your teachers improve. Please answer honestly — it takes about two minutes.',
                questions,
                isDefault: true,
                createdBy: userId,
            });
            created.templates += 1;
        } catch { /* name collision — a template already covers this */ }
    }

    return created;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CAMPAIGN QUESTIONNAIRE SNAPSHOT
// ═════════════════════════════════════════════════════════════════════════════
// Copies the chosen bank questions (plus their options) onto the campaign.
// Called on create and whenever a DRAFT campaign's question list is edited.
async function snapshotQuestions(campaign, questionSpecs, { replace = false } = {}) {
    const schoolId = campaign.school;
    const ids = [...new Set((questionSpecs || []).map((q) => sid(q.question ?? q)))].filter(Boolean);
    if (!ids.length) {
        if (replace) await FeedbackCampaignQuestion.deleteMany({ campaign: campaign._id });
        return 0;
    }

    const [questions, options, categories] = await Promise.all([
        FeedbackQuestion.find({ _id: { $in: ids }, school: schoolId }).lean(),
        FeedbackQuestionOption.find({ question: { $in: ids }, isActive: true }).lean(),
        FeedbackCategory.find({ school: schoolId }).lean(),
    ]);
    const qById   = new Map(questions.map((q) => [sid(q._id), q]));
    const catById = new Map(categories.map((c) => [sid(c._id), c]));
    const optsByQ = options.reduce((acc, o) => {
        (acc[sid(o.question)] = acc[sid(o.question)] || []).push(o);
        return acc;
    }, {});

    if (replace) await FeedbackCampaignQuestion.deleteMany({ campaign: campaign._id });

    let order = 0;
    let written = 0;
    for (const spec of (questionSpecs || [])) {
        const qid = sid(spec.question ?? spec);
        const q = qById.get(qid);
        if (!q) continue;                               // silently skip foreign/unknown ids
        const cat = q.category ? catById.get(sid(q.category)) : null;
        const opts = (optsByQ[qid] || [])
            .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
            .map((o) => ({
                _id: sid(o._id), optionText: o.optionText, optionValue: o.optionValue,
                allowsFreeText: !!o.allowsFreeText, displayOrder: o.displayOrder || 0,
            }));
        try {
            await FeedbackCampaignQuestion.create({
                school: schoolId,
                campaign: campaign._id,
                question: q._id,
                category: q.category || null,
                questionText:   q.questionText,
                questionType:   q.questionType,
                categoryName:   cat?.name || '',
                helpText:       q.helpText || '',
                includeInScore: !!q.includeInScore,
                maxLength:      q.maxLength || 1000,
                options:        opts,
                isRequired:     spec.isRequired !== undefined ? !!spec.isRequired : !!q.isRequired,
                displayOrder:   spec.displayOrder !== undefined ? Number(spec.displayOrder) : order,
            });
            written += 1;
        } catch (e) {
            if (e.code !== 11000) throw e;               // duplicate = already snapshotted
        }
        order += 1;
    }
    return written;
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTOMATIC ASSIGNMENT GENERATION (spec §5)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Walks the real ERP relationships — AcademicYear → Class → Section → enrolled
 * students, and Section+Subject → Teacher — and materialises exactly the
 * evaluations each student is entitled to give. A student never sees a teacher
 * who does not teach them, because no row is ever created for one.
 *
 * Idempotent: the unique (campaign, student, teacher, subject) index plus
 * ON CONFLICT DO NOTHING means re-running after a mid-campaign section transfer
 * only tops up the new pairs.
 */
async function generateAssignments(campaign) {
    const schoolId = sid(campaign.school);

    const sectionFilter = { school: schoolId, status: 'active' };
    if (campaign.academicYear) sectionFilter.academicYear = sid(campaign.academicYear);
    if (campaign.targetSections?.length) sectionFilter._id   = { $in: campaign.targetSections.map(sid) };
    else if (campaign.targetClasses?.length) sectionFilter.class = { $in: campaign.targetClasses.map(sid) };

    const sections = await ClassSection.find(sectionFilter)
        .select('_id class enrolledStudents').lean();
    if (!sections.length) return { created: 0, sections: 0, students: 0, pairs: 0 };

    const sectionIds  = sections.map((s) => sid(s._id));
    const links = await SectionSubjectTeacher.find({ section: { $in: sectionIds } })
        .select('section subject teacher').lean();
    if (!links.length) return { created: 0, sections: sections.length, students: 0, pairs: 0 };

    const wantSubjects = idSet(campaign.targetSubjects);
    const wantTeachers = idSet(campaign.targetTeachers);

    const linksBySection = links.reduce((acc, l) => {
        if (wantSubjects.size && !wantSubjects.has(sid(l.subject))) return acc;
        if (wantTeachers.size && !wantTeachers.has(sid(l.teacher))) return acc;
        (acc[sid(l.section)] = acc[sid(l.section)] || []).push(l);
        return acc;
    }, {});

    // Build the full (student × teacher × subject) grid, de-duplicated.
    const rows = [];
    const seen = new Set();
    let studentCount = 0;
    for (const section of sections) {
        const secLinks = linksBySection[sid(section._id)] || [];
        if (!secLinks.length) continue;
        const students = (section.enrolledStudents || []).map(sid).filter(Boolean);
        studentCount += students.length;
        for (const studentId of students) {
            for (const link of secLinks) {
                const teacherId = sid(link.teacher);
                const subjectId = sid(link.subject);
                if (!teacherId || teacherId === studentId) continue;
                const key = `${studentId}|${teacherId}|${subjectId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push({
                    school: schoolId,
                    campaign: sid(campaign._id),
                    student: studentId,
                    respondent: studentId,
                    teacher: teacherId,
                    subject: subjectId || null,
                    class: sid(section.class) || null,
                    section: sid(section._id),
                    isAnonymous: !!campaign.isAnonymous,
                });
            }
        }
    }
    if (!rows.length) return { created: 0, sections: sections.length, students: studentCount, pairs: 0 };

    const created = await bulkInsertAssignments(rows);
    return { created, sections: sections.length, students: studentCount, pairs: rows.length };
}

// A campaign for a large school produces tens of thousands of rows. The ORM's
// insertMany is a create() loop (one INSERT per row), so this one hot path
// drops to a parameterised multi-row INSERT … ON CONFLICT DO NOTHING, batched
// to stay well under Postgres' 65535-parameter ceiling.
async function bulkInsertAssignments(rows) {
    const T = `"${FeedbackAssignment.tableName}"`;
    const cols = ['_id', 'school', 'campaign', 'student', 'respondent', 'teacher', 'subject',
        'class', 'section', 'status', 'isAnonymous', 'assignedAt', 'startedAt', 'submittedAt',
        'overallRating', 'categoryScores', 'hasComment', 'submissionCount', 'createdAt', 'updatedAt'];
    const colSql = cols.map((c) => `"${c}"`).join(', ');
    const BATCH = 500;
    let created = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const params = [];
        const tuples = chunk.map((r) => {
            const now = new Date();
            const vals = [
                require('crypto').randomUUID(), r.school, r.campaign, r.student, r.respondent,
                r.teacher, r.subject, r.class, r.section, 'pending', r.isAnonymous,
                now, null, null, null, JSON.stringify({}), false, 0, now, now,
            ];
            const casts = ['uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid',
                'text', 'boolean', 'timestamptz', 'timestamptz', 'timestamptz',
                'float8', 'jsonb', 'boolean', 'float8', 'timestamptz', 'timestamptz'];
            return `(${vals.map((v, j) => { params.push(v); return `$${params.length}::${casts[j]}`; }).join(', ')})`;
        });
        const { rowCount } = await pool.query(
            `INSERT INTO ${T} (${colSql}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
            params,
        );
        created += rowCount || 0;
    }
    return created;
}

/**
 * Atomically lock an assignment as submitted.
 *
 * The ORM's updateOne is read-then-write, so a filter guard there is not a real
 * compare-and-set: two concurrent submits would both pass it. This is the one
 * place that matters (rule 3/4 — no duplicate, no editing after submit), so the
 * lock is a single conditional UPDATE and the caller writes the answer rows only
 * after winning it.
 *
 * @returns {Promise<boolean>} true if this caller won the lock.
 */
async function lockSubmission(assignmentId, { overallRating, categoryScores, hasComment }) {
    const T = `"${FeedbackAssignment.tableName}"`;
    const { rowCount } = await pool.query(
        `UPDATE ${T}
            SET "status" = 'submitted',
                "submittedAt" = now(),
                "overallRating" = $2::float8,
                "categoryScores" = $3::jsonb,
                "hasComment" = $4::boolean,
                "submissionCount" = COALESCE("submissionCount", 0) + 1,
                "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "status" <> 'submitted'`,
        [String(assignmentId), overallRating, JSON.stringify(categoryScores || {}), !!hasComment],
    );
    return rowCount > 0;
}

// Incremental counter bump on the submit path — one indexed UPDATE instead of
// recounting a campaign's tens of thousands of assignments per submission.
async function incrementCampaignStats(campaignId, { submitted = 0, ratingSum = 0, ratingCount = 0 }) {
    const T = `"${FeedbackCampaign.tableName}"`;
    await pool.query(
        `UPDATE ${T}
            SET "stats" = COALESCE("stats", '{}'::jsonb) || jsonb_build_object(
                    'submitted',   COALESCE(("stats"->>'submitted')::numeric, 0)   + $2::numeric,
                    'ratingSum',   COALESCE(("stats"->>'ratingSum')::numeric, 0)   + $3::numeric,
                    'ratingCount', COALESCE(("stats"->>'ratingCount')::numeric, 0) + $4::numeric
                ),
                "updatedAt" = now()
          WHERE "_id" = $1::uuid`,
        [String(campaignId), submitted, ratingSum || 0, ratingCount],
    );
}

// Full recount — authoritative but O(assignments). Used after generation,
// reopen and admin-triggered refreshes, never on the submit hot path.
async function refreshCampaignStats(campaignId) {
    const [assigned, submittedRows] = await Promise.all([
        FeedbackAssignment.countDocuments({ campaign: campaignId }),
        FeedbackAssignment.find({ campaign: campaignId, status: 'submitted' })
            .select('overallRating').lean(),
    ]);
    const rated = submittedRows.filter((r) => r.overallRating != null);
    const stats = {
        assigned,
        submitted:   submittedRows.length,
        ratingSum:   round2(rated.reduce((s, r) => s + Number(r.overallRating || 0), 0)) || 0,
        ratingCount: rated.length,
    };
    await FeedbackCampaign.updateOne({ _id: campaignId }, { $set: { stats } });
    return stats;
}

function campaignSummary(campaign) {
    const st = campaign.stats || {};
    const assigned  = st.assigned  || 0;
    const submitted = st.submitted || 0;
    return {
        assigned,
        submitted,
        pending:      Math.max(0, assigned - submitted),
        responseRate: pct(submitted, assigned),
        avgRating:    st.ratingCount ? round1(st.ratingSum / st.ratingCount) : null,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  AGGREGATION + PRIVACY GATE (spec §10, §14)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Rolls a set of SUBMITTED assignment rows into the shape every dashboard uses.
 * `minimumResponses` is the privacy floor: below it the numbers are replaced by
 * a locked shell, so no caller can leak a near-identifiable aggregate.
 */
function aggregate(assignments, minimumResponses = 0) {
    const submitted = (assignments || []).filter((a) => a.status === 'submitted');
    const responses = submitted.length;

    if (minimumResponses && responses < minimumResponses) {
        return {
            locked: true,
            responses,
            minimumResponses,
            message: responses === 0
                ? 'No responses yet.'
                : 'Insufficient responses to display aggregated results.',
            averageRating: null,
            categories: [],
        };
    }

    const rated = submitted.filter((a) => a.overallRating != null);
    const catAcc = new Map();  // categoryId → { name, sum, count }
    for (const a of submitted) {
        const scores = a.categoryScores || {};
        for (const [cid, v] of Object.entries(scores)) {
            if (!v || v.count == null) continue;
            const cur = catAcc.get(cid) || { name: v.name || 'Category', sum: 0, count: 0 };
            cur.sum   += Number(v.sum) || 0;
            cur.count += Number(v.count) || 0;
            if (v.name) cur.name = v.name;
            catAcc.set(cid, cur);
        }
    }

    const categories = [...catAcc.entries()]
        .map(([id, v]) => ({ _id: id, name: v.name, average: v.count ? round1(v.sum / v.count) : null, answers: v.count }))
        .sort((a, b) => (b.average ?? 0) - (a.average ?? 0));

    return {
        locked: false,
        responses,
        minimumResponses,
        averageRating: rated.length
            ? round1(rated.reduce((s, a) => s + Number(a.overallRating), 0) / rated.length)
            : null,
        categories,
        // Strengths / improvement areas fall straight out of the category ranking
        // (spec §14) — no AI involved, and the shape an AI pass would later fill.
        strengths:   categories.filter((c) => c.average != null && c.average >= 4).slice(0, 3),
        improvements: [...categories].reverse().filter((c) => c.average != null && c.average < 4).slice(0, 3),
    };
}

// Computes the per-assignment scores written at submit time.
// answers: [{ campaignQuestion, ratingValue, category, categoryName, includeInScore }]
function scoreSubmission(answers) {
    const categoryScores = {};
    let sum = 0;
    let count = 0;
    for (const a of answers) {
        if (!a.includeInScore || a.ratingValue == null) continue;
        sum += Number(a.ratingValue);
        count += 1;
        const cid = a.category ? sid(a.category) : 'uncategorised';
        const cur = categoryScores[cid] || { name: a.categoryName || 'Uncategorised', sum: 0, count: 0, avg: null };
        cur.sum += Number(a.ratingValue);
        cur.count += 1;
        cur.avg = round1(cur.sum / cur.count);
        categoryScores[cid] = cur;
    }
    return { overallRating: count ? round2(sum / count) : null, categoryScores, scoredAnswers: count };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CAMPAIGN WINDOW VALIDATION (rules 7, 8, 9)
// ═════════════════════════════════════════════════════════════════════════════
// Returns null when submissions are allowed, or a user-facing reason string.
function submissionBlockReason(campaign, now = new Date()) {
    if (!campaign) return 'Campaign not found.';
    if (campaign.status === 'draft')     return 'This feedback campaign has not been published yet.';
    if (campaign.status === 'closed')    return 'This feedback campaign has closed.';
    if (campaign.status === 'archived')  return 'This feedback campaign has been archived.';
    if (campaign.status === 'scheduled') return 'This feedback campaign has not started yet.';
    if (campaign.startDate && now < new Date(campaign.startDate)) {
        return 'This feedback campaign has not started yet.';
    }
    if (campaign.endDate && now > endOfDay(campaign.endDate)) {
        return 'The deadline for this feedback has passed.';
    }
    return null;
}

// Campaign end dates are inclusive — a campaign ending "17 Aug" accepts
// submissions until 17 Aug 23:59 local time.
function endOfDay(d) {
    const dt = new Date(d);
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999);
}

async function activeAcademicYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
}

module.exports = {
    // constants
    DEFAULT_CATEGORIES, DEFAULT_QUESTIONS, DEFAULT_TEMPLATE_NAME, PRINCIPAL_DESIGNATIONS,
    // helpers
    sid, round1, round2, pct, idSet, endOfDay,
    // services
    logAudit, getSettings, isPrincipal, resolveAccess, seedDefaults,
    snapshotQuestions, generateAssignments, bulkInsertAssignments,
    lockSubmission, incrementCampaignStats, refreshCampaignStats, campaignSummary,
    aggregate, scoreSubmission, submissionBlockReason, activeAcademicYear,
};
