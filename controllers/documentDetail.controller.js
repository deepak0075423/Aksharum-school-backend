'use strict';
/**
 * One document, opened.
 *
 * The list page (document.controller.js) answers "what is on the shelf". This
 * answers "what happened to this one" — who it reached, who has handed work
 * back, how they did, and the conversation hanging off it. Four tabs on the
 * screen, three reads behind them: the assignment payload, the analytics
 * payload, and the comment thread.
 *
 * Everything countable is counted in Postgres against a roster CTE built once
 * and reused. A roster is "every student this document actually reaches", and
 * it is derived the same way the student's own list derives visibility (see
 * canStudentViewDocument) — if the two disagreed, the admin would be told 40
 * students have it while 44 could see it.
 */

const Document           = require('../models/Document');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const DocumentComment    = require('../models/DocumentComment');
const Class              = require('../models/Class');
const ClassSection       = require('../models/ClassSection');
const AcademicYear       = require('../models/AcademicYear');
const StudentProfile     = require('../models/StudentProfile');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const User               = require('../models/User');
const pool               = require('../db/pool');
const { notify }         = require('../services/notifyService');

const qt = (Model) => `"${Model.tableName}"`;

// ── The audience ─────────────────────────────────────────────────────────────

/**
 * The sections a document reaches, or `null` for "every student in the school".
 *
 * Matched on (class number, section name) rather than on the stored ids,
 * because a class row exists once per academic year: "Class 9 - A" is four rows
 * in a school with four years on record, and a document targeted at one of them
 * is visible to a student sitting in another. That is what the student's own
 * list does, so the roster has to do it too. Narrowed to the document's own
 * academic year when it carries one.
 */
async function audienceSections(doc) {
    const school = String(doc.school);
    const year   = doc.academicYear ? String(doc.academicYear) : null;
    const yearSql = year ? ' AND c."academicYear" = $2::uuid' : '';
    const yearArg = year ? [year] : [];

    if (doc.targetType === 'whole_school') return null;
    if (doc.targetType === 'all_teachers' || doc.targetType === 'specific_teachers') return [];

    if (doc.targetType === 'class') {
        const ids = (doc.targetClasses || []).map(String);
        if (!ids.length) return [];
        const { rows } = await pool.query(
            `SELECT s."_id"
               FROM ${qt(ClassSection)} s
               JOIN ${qt(Class)} c ON c."_id" = s."class"
              WHERE s."school" = $1${yearSql}
                AND c."classNumber" IN (
                  SELECT c2."classNumber" FROM ${qt(Class)} c2 WHERE c2."_id" = ANY($${yearArg.length + 2}::uuid[])
                )`,
            [school, ...yearArg, ids],
        );
        return rows.map((r) => r._id);
    }

    if (doc.targetType === 'class_sections') {
        const ids = (doc.targetSections || []).map(String);
        if (!ids.length) return [];
        const { rows } = await pool.query(
            `SELECT s."_id"
               FROM ${qt(ClassSection)} s
               JOIN ${qt(Class)} c ON c."_id" = s."class"
              WHERE s."school" = $1${yearSql}
                AND (c."classNumber", s."sectionName") IN (
                  SELECT c2."classNumber", s2."sectionName"
                    FROM ${qt(ClassSection)} s2
                    JOIN ${qt(Class)} c2 ON c2."_id" = s2."class"
                   WHERE s2."_id" = ANY($${yearArg.length + 2}::uuid[])
                )`,
            [school, ...yearArg, ids],
        );
        return rows.map((r) => r._id);
    }
    return [];
}

/**
 * The roster, as a CTE every read below opens with.
 *
 * One row per student the document reaches, carrying their submission when
 * there is one and a derived `state` when there is not. `state` is the whole
 * point: "pending" and "not submitted" are the same absence of a row, and only
 * the due date tells them apart.
 */
function rosterCte({ docId, school, sections, dueDate, year = null }) {
    const params = [docId, school];
    // The year a student's section belongs to, when it is NOT the document's
    // own year — "2025-26" for someone not yet moved up. Such a student is
    // kept only if they already handed work in; their section is never one of
    // the section filter's choices, and their label carries the year.
    let otherYear = 'NULL::text';
    let yearParam = null;
    if (year) {
        params.push(String(year));
        yearParam = `$${params.length}::uuid`;
        otherYear = `CASE WHEN c."_id" IS NOT NULL AND c."academicYear" IS DISTINCT FROM ${yearParam} THEN ay."yearName" END`;
    }
    let scope;
    if (sections === null) {
        // The whole school — as it stands in the document's own academic year.
        // A student still placed in an earlier year's section (not yet moved
        // up, or gone) is not part of a year they are not in; without this the
        // section filter listed "Class 6 - A" once per year. Anyone who has
        // already handed work in stays, wherever they are placed.
        scope = yearParam
            ? `u."role" = 'student' AND (c."academicYear" = ${yearParam} OR sub."_id" IS NOT NULL)`
            : `u."role" = 'student'`;
    } else if (!sections.length) {
        // Nobody — a teacher-only document, or a target with nothing selected.
        scope = 'false';
    } else {
        params.push(sections);
        scope = `sp."currentSection" = ANY($${params.length}::uuid[])`;
    }
    params.push(dueDate || null);
    const dueParam = `$${params.length}::timestamptz`;

    const sql = `
      roster AS (
        SELECT u."_id"            AS "studentId",
               u."name",
               u."profileImage",
               sp."rollNumber",
               sp."currentSection",
               c."className",
               s."sectionName",
               ${otherYear}        AS "otherYear",
               sub."_id"           AS "submissionId",
               sub."submittedAt",
               sub."marks",
               sub."feedback",
               sub."files"         AS "submissionFiles",
               sub."questionScores",
               sub."reviewedAt",
               CASE
                 WHEN sub."status" IN ('submitted', 'late') THEN sub."status"
                 WHEN ${dueParam} IS NOT NULL AND now() > ${dueParam} THEN 'missed'
                 ELSE 'pending'
               END AS "state"
          FROM ${qt(StudentProfile)} sp
          JOIN ${qt(User)} u ON u."_id" = sp."user" AND COALESCE(u."isActive", true)
          LEFT JOIN ${qt(ClassSection)} s ON s."_id" = sp."currentSection"
          LEFT JOIN ${qt(Class)} c        ON c."_id" = s."class"
          LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = c."academicYear"
          LEFT JOIN ${qt(AssignmentSubmission)} sub
                 ON sub."document" = $1::uuid AND sub."student" = u."_id"
         WHERE sp."school" = $2::uuid AND ${scope}
      )`;
    return { sql, params };
}

/** Submitted, however late. The tiles group them; the row still says which. */
const HANDED_IN = `"state" IN ('submitted', 'late')`;

/** "Class 6 - B", or "Class 6 - B (2025-26)" for a section of another year. */
const SECTION_LABEL = (empty) => `coalesce("className" || ' - ' || "sectionName" || coalesce(' (' || "otherYear" || ')', ''), '${empty}')`;

// ── Loading the document ─────────────────────────────────────────────────────

async function loadDoc(req, res) {
    const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean();
    if (!doc) {
        res.status(404).json({ success: false, message: 'Document not found' });
        return null;
    }
    return doc;
}

/**
 * The same four tabs, opened by a teacher.
 *
 * A teacher may READ any document that reaches them — their own uploads, a
 * staff notice, work set for a class they teach — and may only WRITE against
 * the ones they set. Marking someone else's assignment, reminding someone
 * else's class or deleting someone else's copy are all the owner's to do.
 *
 * Mounted as route middleware rather than folded into loadDoc, so the admin
 * routes are untouched and a teacher route can never forget the check.
 */
exports.teacherDocumentAccess = (mode = 'read') => async (req, res, next) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        if (String(doc.uploadedBy) === String(req.userId)) return next();
        if (mode === 'own') {
            return res.status(403).json({
                success: false,
                message: 'Only the teacher who set this can do that',
            });
        }

        if (['all_teachers', 'whole_school'].includes(doc.targetType)) return next();
        if (doc.targetType === 'specific_teachers'
            && (doc.targetUsers || []).map(String).includes(String(req.userId))) return next();

        const mine = await SectionSubjectTeacher.find({ teacher: req.userId }).distinct('section');
        const asClassTeacher = await ClassSection.find({
            school: req.schoolId,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        }).distinct('_id');
        const sections = [...mine, ...asClassTeacher].map(String);

        if (doc.targetType === 'class_sections'
            && (doc.targetSections || []).map(String).some((s) => sections.includes(s))) return next();

        if (doc.targetType === 'class' && sections.length) {
            const classes = (await ClassSection.find({ _id: { $in: sections } }).distinct('class')).map(String);
            if ((doc.targetClasses || []).map(String).some((c) => classes.includes(c))) return next();
        }

        return res.status(403).json({ success: false, message: 'This document was not shared with you' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

/** The header strip: what this document is, in one object both tabs read. */
async function header(doc, req) {
    const [uploader, sections, classes, year, people] = await Promise.all([
        doc.uploadedBy ? User.findById(doc.uploadedBy).select('name role profileImage').lean() : null,
        (doc.targetSections || []).length
            ? pool.query(
                `SELECT c."className" || ' - ' || s."sectionName" AS label
                   FROM ${qt(ClassSection)} s JOIN ${qt(Class)} c ON c."_id" = s."class"
                  WHERE s."_id" = ANY($1::uuid[]) ORDER BY c."classNumber", s."sectionName"`,
                [(doc.targetSections || []).map(String)],
            ).then((r) => r.rows.map((x) => x.label))
            : [],
        (doc.targetClasses || []).length
            ? pool.query(
                `SELECT "className" AS label FROM ${qt(Class)}
                  WHERE "_id" = ANY($1::uuid[]) ORDER BY "classNumber"`,
                [(doc.targetClasses || []).map(String)],
            ).then((r) => r.rows.map((x) => x.label))
            : [],
        doc.academicYear
            ? pool.query(`SELECT "yearName" FROM "academicyears" WHERE "_id" = $1`, [String(doc.academicYear)])
                .then((r) => r.rows[0]?.yearName || null)
            : null,
        doc.targetType === 'specific_teachers' && (doc.targetUsers || []).length
            ? pool.query(
                `SELECT "name" AS label FROM ${qt(User)} WHERE "_id" = ANY($1::uuid[]) ORDER BY lower("name")`,
                [(doc.targetUsers || []).map(String)],
            ).then((r) => r.rows.map((x) => x.label))
            : [],
    ]);

    const where = doc.targetType === 'whole_school' ? ['Whole School']
        : doc.targetType === 'all_teachers'         ? ['All Teachers']
        : doc.targetType === 'class_sections'       ? sections
        : doc.targetType === 'class'                ? classes
        : doc.targetType === 'specific_teachers'    ? people
        : [];

    const due  = doc.dueDate ? new Date(doc.dueDate) : null;
    // "Active" while it is still open to work, "Overdue" once the date has
    // passed and "Archived" once it is off the shelf. A plain document with no
    // due date is simply Active — there is nothing for it to be late for.
    const status = doc.isArchived ? 'archived'
        : (doc.isAssignment && due && Date.now() > due.getTime()) ? 'overdue'
        : 'active';

    return {
        _id: doc._id,
        title: doc.title,
        description: doc.description || '',
        docType: doc.docType || 'other',
        category: doc.category || '',
        subject: doc.subject || '',
        isAssignment: !!doc.isAssignment,
        assignmentType: doc.assignmentType || null,
        allowSubmission: !!doc.allowSubmission,
        marksEnabled: !!doc.marksEnabled,
        totalMarks: doc.totalMarks ?? null,
        questions: doc.questions || [],
        dueDate: doc.dueDate || null,
        assignedOn: doc.createdAt,
        updatedAt: doc.updatedAt,
        targetType: doc.targetType,
        sharedWith: where,
        academicYearName: year,
        files: doc.files || [],
        currentVersion: doc.currentVersion || 1,
        isArchived: !!doc.isArchived,
        status,
        // Whether the reader may change this. An admin always may; a teacher
        // only their own — the routes enforce it, and the page needs to know so
        // it does not offer buttons that will be refused.
        canManage: req?.userRole === 'school_admin' || String(doc.uploadedBy) === String(req?.userId),
        uploadedBy: uploader
            ? { _id: uploader._id, name: uploader.name, role: uploader.role, photo: uploader.profileImage }
            : null,
    };
}

/** Five equal bands across the total, the way a mark sheet is read. */
function scoreBands(totalMarks) {
    const total = Number(totalMarks) > 0 ? Number(totalMarks) : 100;
    const step  = total / 5;
    return Array.from({ length: 5 }, (_, i) => {
        const lo = Math.round(i * step);
        const hi = Math.round((i + 1) * step);
        return { lo: i === 0 ? 0 : lo + 1, hi, label: `${i === 0 ? 0 : lo + 1}–${hi}` };
    });
}

const bandCaseSql = (bands) => bands
    .map((b, i) => `count(*) FILTER (WHERE "marks" IS NOT NULL AND "marks" >= ${b.lo} AND "marks" <= ${b.hi})::int AS "b${i}"`)
    .join(',\n               ');

// ── Tab 1 & 2: the assignment ────────────────────────────────────────────────

const ROSTER_SORTS = {
    roll:      `"rollNumber" NULLS LAST, "name"`,
    name:      `lower("name")`,
    name_z:    `lower("name") DESC`,
    marks:     `"marks" DESC NULLS LAST, lower("name")`,
    marks_low: `"marks" ASC NULLS LAST, lower("name")`,
    recent:    `"submittedAt" DESC NULLS LAST, lower("name")`,
};

exports.getAssignment = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;

        const head = await header(doc, req);

        // A document nobody submits against has no roster to speak of — the
        // page still opens, on its Overview and Comments tabs alone.
        if (!doc.isAssignment) {
            return res.json({ success: true, data: { document: head, roster: null } });
        }

        const sections = await audienceSections(doc);
        const { sql: cte, params: base } = rosterCte({
            docId: String(doc._id), school: String(doc.school), sections, dueDate: doc.dueDate,
            year: doc.academicYear || null,
        });

        const bands = scoreBands(doc.totalMarks);

        // The page's own filters, applied to the roster rather than to the
        // submissions — a student who has not submitted has no submission row
        // to filter, and is exactly who the admin is usually looking for.
        const q = req.query;
        const rowParams = [...base];
        const where = [];
        if (q.status === 'submitted') where.push(HANDED_IN);
        else if (q.status === 'late')    where.push(`"state" = 'late'`);
        else if (q.status === 'pending') where.push(`"state" = 'pending'`);
        else if (q.status === 'missed')  where.push(`"state" = 'missed'`);
        else if (q.status === 'graded')  where.push('"marks" IS NOT NULL');
        else if (q.status === 'ungraded') where.push(`${HANDED_IN} AND "marks" IS NULL`);

        if (q.section) { rowParams.push(String(q.section)); where.push(`"currentSection" = $${rowParams.length}::uuid`); }
        if (q.search) {
            rowParams.push(`%${String(q.search).trim()}%`);
            where.push(`("name" ILIKE $${rowParams.length} OR "rollNumber" ILIKE $${rowParams.length})`);
        }
        const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const page  = Math.max(1, Math.floor(Number(q.page) || 1));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit) || 10)));
        const order = ROSTER_SORTS[q.sort] || ROSTER_SORTS.roll;

        const [stats, bySection, rows, count] = await Promise.all([
            // The four tiles, the three score figures and the histogram, over
            // the WHOLE roster — the tiles describe the assignment, and must
            // not move when the admin filters the table under them.
            pool.query(
                `WITH ${cte}
                 SELECT count(*)::int                                    AS "total",
                        count(*) FILTER (WHERE ${HANDED_IN})::int         AS "submitted",
                        count(*) FILTER (WHERE "state" = 'late')::int     AS "late",
                        count(*) FILTER (WHERE "state" = 'pending')::int  AS "pending",
                        count(*) FILTER (WHERE "state" = 'missed')::int   AS "missed",
                        count("marks")::int                              AS "graded",
                        avg("marks")::float                              AS "average",
                        max("marks")::float                              AS "highest",
                        min("marks")::float                              AS "lowest",
                        ${bandCaseSql(bands)}
                   FROM roster`,
                base,
            ),
            pool.query(
                `WITH ${cte}
                 SELECT "currentSection" AS "_id",
                        coalesce("className" || ' - ' || "sectionName", 'No section') AS "label",
                        count(*)::int                            AS "total",
                        count(*) FILTER (WHERE ${HANDED_IN})::int AS "submitted",
                        avg("marks")::float                      AS "average"
                   FROM roster
                  -- The section filter offers the document's own year only.
                  WHERE "otherYear" IS NULL
                  GROUP BY 1, 2
                  ORDER BY 2`,
                base,
            ),
            pool.query(
                `WITH ${cte}
                 SELECT * FROM roster ${filter}
                  ORDER BY ${order}
                  LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
                rowParams,
            ),
            pool.query(`WITH ${cte} SELECT count(*)::int AS n FROM roster ${filter}`, rowParams),
        ]);

        const s = stats.rows[0] || {};
        const total = s.total || 0;
        const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
        const shown = count.rows[0]?.n || 0;

        res.json({
            success: true,
            data: {
                document: head,
                roster: {
                    counts: {
                        total,
                        submitted: s.submitted || 0,
                        late:      s.late || 0,
                        pending:   s.pending || 0,
                        missed:    s.missed || 0,
                        graded:    s.graded || 0,
                    },
                    percent: {
                        submitted: pct(s.submitted || 0),
                        pending:   pct(s.pending || 0),
                        missed:    pct(s.missed || 0),
                        total:     total ? 100 : 0,
                    },
                    scores: {
                        average: s.average == null ? null : Math.round(s.average * 10) / 10,
                        highest: s.highest ?? null,
                        lowest:  s.lowest ?? null,
                        outOf:   doc.totalMarks ?? null,
                    },
                    distribution: bands.map((b, i) => ({ label: b.label, count: s[`b${i}`] || 0 })),
                    sections: bySection.rows.map((r) => ({
                        _id: r._id,
                        label: r.label,
                        total: r.total,
                        submitted: r.submitted,
                        average: r.average == null ? null : Math.round(r.average * 10) / 10,
                    })),
                    students: rows.rows.map(shapeStudent),
                    page,
                    limit,
                    shown,
                    pages: Math.max(1, Math.ceil(shown / limit)),
                },
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

function shapeStudent(r) {
    const files = Array.isArray(r.submissionFiles) ? r.submissionFiles : [];
    return {
        _id: r.studentId,
        name: r.name,
        photo: r.profileImage || '',
        rollNumber: r.rollNumber || '',
        section: r.currentSection,
        sectionLabel: r.className && r.sectionName
            ? `${r.className} - ${r.sectionName}${r.otherYear ? ` (${r.otherYear})` : ''}` : '',
        state: r.state,
        submissionId: r.submissionId,
        submittedAt: r.submittedAt,
        marks: r.marks,
        feedback: r.feedback || '',
        questionScores: Array.isArray(r.questionScores) ? r.questionScores : [],
        reviewedAt: r.reviewedAt,
        files,
        fileCount: files.length,
    };
}

// ── Tab 3: analytics ─────────────────────────────────────────────────────────

exports.getAssignmentAnalytics = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        if (!doc.isAssignment) {
            return res.status(400).json({ success: false, message: 'Only an assignment has analytics' });
        }

        const sections = await audienceSections(doc);
        const { sql: cte, params: base } = rosterCte({
            docId: String(doc._id), school: String(doc.school), sections, dueDate: doc.dueDate,
            year: doc.academicYear || null,
        });
        const outOf = Number(doc.totalMarks) > 0 ? Number(doc.totalMarks) : null;

        const [trend, bySection, byQuestion, ranked, prev] = await Promise.all([
            // One row per day something came in, cumulated in the browser — the
            // days with nothing are filled there too, so the line has no gaps.
            pool.query(
                `WITH ${cte}
                 SELECT date_trunc('day', "submittedAt")::date AS "day", count(*)::int AS "n"
                   FROM roster
                  WHERE "submittedAt" IS NOT NULL
                  GROUP BY 1 ORDER BY 1`,
                base,
            ),
            pool.query(
                `WITH ${cte}
                 SELECT ${SECTION_LABEL('No section')} AS "label",
                        count(*)::int                            AS "total",
                        count(*) FILTER (WHERE ${HANDED_IN})::int AS "submitted",
                        avg("marks")::float                      AS "average"
                   FROM roster
                  GROUP BY 1 ORDER BY 1`,
                base,
            ),
            // Per-question averages, read out of the jsonb the marking form
            // writes. Empty for an assignment that is marked as one number,
            // which is most of them — the panel says so rather than drawing an
            // empty chart.
            pool.query(
                `WITH ${cte}
                 SELECT q."label",
                        avg(q."score")::float AS "average",
                        count(q."score")::int AS "marked"
                   FROM roster r,
                        LATERAL jsonb_to_recordset(coalesce(r."questionScores", '[]'::jsonb))
                                AS q("label" text, "score" numeric)
                  WHERE q."score" IS NOT NULL
                  GROUP BY q."label"
                  ORDER BY q."label"`,
                base,
            ),
            pool.query(
                `WITH ${cte}
                 SELECT "studentId", "name", "profileImage", "rollNumber", "marks", "state",
                        ${SECTION_LABEL('')} AS "sectionLabel"
                   FROM roster`,
                base,
            ),
            // The assignment before this one, for the "vs last assignment" line.
            // Matched on the same target so the comparison is between two pieces
            // of work set to roughly the same people.
            pool.query(
                `SELECT d."_id", d."title", d."totalMarks",
                        avg(sub."marks")::float AS "average"
                   FROM ${qt(Document)} d
                   JOIN ${qt(AssignmentSubmission)} sub ON sub."document" = d."_id" AND sub."marks" IS NOT NULL
                  WHERE d."school" = $1 AND d."_id" <> $2
                    AND COALESCE(d."isAssignment", false)
                    AND d."targetType" = $3
                    AND d."createdAt" < $4
                  GROUP BY d."_id", d."title", d."totalMarks"
                  ORDER BY d."createdAt" DESC
                  LIMIT 1`,
                [String(doc.school), String(doc._id), doc.targetType, doc.createdAt],
            ),
        ]);

        const all      = ranked.rows;
        const graded   = all.filter((r) => r.marks != null).sort((a, b) => b.marks - a.marks);
        const person   = (r) => ({
            _id: r.studentId, name: r.name, photo: r.profileImage || '',
            rollNumber: r.rollNumber || '', section: r.sectionLabel,
            marks: r.marks, state: r.state,
        });

        // Everyone the assignment is still waiting on, worst first: never handed
        // in, then handed in and marked lowest.
        const attention = [
            ...all.filter((r) => r.state === 'missed'),
            ...all.filter((r) => r.state === 'pending'),
            ...graded.slice().reverse().filter((r) => outOf && r.marks / outOf < 0.4),
        ].slice(0, 10).map(person);

        const submitted = all.filter((r) => r.state === 'submitted' || r.state === 'late').length;
        const average   = graded.length ? graded.reduce((n, r) => n + r.marks, 0) / graded.length : null;

        const prevRow = prev.rows[0] || null;
        const asPct   = (avg, out) => (avg != null && out ? (avg / out) * 100 : null);
        const nowPct  = asPct(average, outOf);
        const prevPct = asPct(prevRow?.average, prevRow?.totalMarks);
        const change  = nowPct != null && prevPct ? Math.round(nowPct - prevPct) : null;

        const questions = (doc.questions || []).map((q) => {
            const hit = byQuestion.rows.find((r) => r.label === q.label);
            const max = Number(q.maxMarks) > 0 ? Number(q.maxMarks) : null;
            return {
                label: q.label,
                maxMarks: max,
                average: hit?.average == null ? null : Math.round(hit.average * 10) / 10,
                percent: hit?.average != null && max ? Math.round((hit.average / max) * 100) : null,
                marked: hit?.marked || 0,
            };
        });

        res.json({
            success: true,
            data: {
                document: await header(doc, req),
                trend: trend.rows.map((r) => ({ day: r.day, count: r.n })),
                sections: bySection.rows.map((r) => ({
                    label: r.label,
                    total: r.total,
                    submitted: r.submitted,
                    average: r.average == null ? null : Math.round(r.average * 10) / 10,
                    percent: r.average != null && outOf ? Math.round((r.average / outOf) * 100) : null,
                })),
                questions,
                top: graded.slice(0, 5).map(person),
                bottom: graded.length ? person(graded[graded.length - 1]) : null,
                attention,
                comparison: prevRow
                    ? { title: prevRow.title, percent: prevPct == null ? null : Math.round(prevPct), change }
                    : null,
                summary: {
                    total: all.length,
                    submitted,
                    graded: graded.length,
                    average: average == null ? null : Math.round(average * 10) / 10,
                    outOf,
                    averagePercent: nowPct == null ? null : Math.round(nowPct),
                },
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Marking ──────────────────────────────────────────────────────────────────

/**
 * Award marks and write feedback against one student's submission.
 *
 * Addressed by student rather than by submission id: the admin is marking a
 * name on a roster, and half the roster has no submission row at all. When the
 * assignment defines questions the total is computed from the per-question
 * scores rather than typed twice — two numbers that must agree are one number
 * with extra chances to be wrong.
 */
exports.reviewSubmission = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        if (!doc.isAssignment) {
            return res.status(400).json({ success: false, message: 'This document is not an assignment' });
        }

        const studentId = req.params.studentId;
        const sub = await AssignmentSubmission.findOne({ document: doc._id, student: studentId });
        if (!sub) {
            return res.status(404).json({ success: false, message: 'This student has not submitted anything to mark' });
        }

        const { feedback } = req.body;
        const scores = Array.isArray(req.body.questionScores) ? req.body.questionScores : null;

        if (scores && (doc.questions || []).length) {
            const byLabel = Object.fromEntries(scores.map((q) => [q.label, q.score]));
            sub.questionScores = doc.questions.map((q) => {
                const raw = byLabel[q.label];
                const n   = raw === '' || raw == null ? null : Number(raw);
                const max = Number(q.maxMarks) > 0 ? Number(q.maxMarks) : null;
                return {
                    label: q.label,
                    score: n == null || Number.isNaN(n) ? null : (max ? Math.min(n, max) : n),
                };
            });
            const awarded = sub.questionScores.filter((q) => q.score != null);
            sub.marks = awarded.length ? awarded.reduce((n, q) => n + q.score, 0) : null;
        } else if (req.body.marks !== undefined) {
            const n = req.body.marks === '' || req.body.marks === null ? null : Number(req.body.marks);
            if (n != null && Number.isNaN(n)) {
                return res.status(400).json({ success: false, message: 'Marks must be a number' });
            }
            if (n != null && doc.totalMarks && n > doc.totalMarks) {
                return res.status(400).json({ success: false, message: `Marks cannot exceed ${doc.totalMarks}` });
            }
            sub.marks = n;
        }

        if (feedback !== undefined) sub.feedback = String(feedback);
        sub.reviewedBy = req.userId;
        sub.reviewedAt = new Date();
        await sub.save();

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📝 Your assignment has been marked',
            body: `"${doc.title}" has been marked${sub.marks != null ? ` — ${sub.marks}${doc.totalMarks ? `/${doc.totalMarks}` : ''}` : ''}.`,
            recipients: [studentId],
            link: { type: 'documents.item', entityId: doc._id },
        });

        res.json({ success: true, data: sub });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** Nudge everyone the assignment is still waiting on. */
exports.remindPending = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        if (!doc.isAssignment) {
            return res.status(400).json({ success: false, message: 'This document is not an assignment' });
        }

        const sections = await audienceSections(doc);
        const { sql: cte, params } = rosterCte({
            docId: String(doc._id), school: String(doc.school), sections, dueDate: doc.dueDate,
            year: doc.academicYear || null,
        });

        // A named few, or everyone still outstanding.
        const only = Array.isArray(req.body?.studentIds) && req.body.studentIds.length
            ? req.body.studentIds.map(String)
            : null;
        const extra = only ? [only] : [];
        const pick  = only ? ` AND "studentId" = ANY($${params.length + 1}::uuid[])` : '';

        const { rows } = await pool.query(
            `WITH ${cte} SELECT "studentId" FROM roster WHERE NOT (${HANDED_IN})${pick}`,
            [...params, ...extra],
        );
        if (!rows.length) {
            return res.json({ success: true, sent: 0, message: 'Everyone has already submitted' });
        }

        const due = doc.dueDate ? new Date(doc.dueDate) : null;
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '⏰ Assignment still to submit',
            body: `"${doc.title}" is still waiting on your submission`
                + (due ? ` — it was due ${due.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.` : '.'),
            recipients: rows.map((r) => r.studentId),
            link: { type: 'documents.item', entityId: doc._id },
        });

        res.json({ success: true, sent: rows.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * A second copy of a document, ready to be edited into next week's.
 *
 * The file metadata is copied, not the files: both rows point at the same bytes
 * on disk, which is safe because deleting a document has never unlinked them.
 * The copy starts unarchived, at version 1, with no submissions and no due date
 * — a date carried over from the original would be in the past on arrival.
 */
exports.duplicate = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;

        const { _id, createdAt, updatedAt, ...rest } = doc;
        const copy = await Document.create({
            ...rest,
            title: `${doc.title} (copy)`.slice(0, 200),
            uploadedBy: req.userId,
            uploaderRole: req.userRole === 'teacher' ? 'teacher' : 'school_admin',
            currentVersion: 1,
            isArchived: false,
            dueDate: null,
        });
        res.status(201).json({ success: true, data: copy });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Tab 4: comments ──────────────────────────────────────────────────────────

/** Staff read every comment; a student or parent only the ones marked for all. */
const isStaff = (req) => ['school_admin', 'teacher'].includes(req.userRole);

/**
 * The school's administrators — a school admin, or a teacher reaching the
 * document through the /admin routes, which already demand admin access to the
 * Documents module. Only they can delete somebody else's comment. Teachers and
 * students edit and delete their own words, and nobody else's (user's rule,
 * Nov 2026).
 */
const isAdmin = (req) => req.userRole === 'school_admin'
    || String(req.baseUrl || '').startsWith('/api/admin');

/**
 * Pinning lifts a comment to the top without changing or removing a word of
 * it, so the teacher who shared the document can do it as well as an admin.
 */
const canPinOn = (req, doc) => isAdmin(req)
    || (doc && String(doc.uploadedBy) === String(req.userId));

const buildFiles = (files) => (files || []).map((f) => ({
    originalName: f.originalname,
    storedName:   f.filename,
    filePath:     f.path,
    mimeType:     f.mimetype,
    fileSize:     f.size,
}));

/**
 * The thread, assembled.
 *
 * Read flat and nested here rather than in the browser, so the pinned-first
 * ordering and the reply grouping are decided once. Pinned comments lead, then
 * newest or oldest first; replies always follow their parent oldest-first,
 * because a reply chain read newest-first is a conversation played backwards.
 */
exports.listComments = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;

        const dir = req.query.order === 'oldest' ? 'ASC' : 'DESC';
        const params = [String(doc._id)];
        const where  = ['c."document" = $1'];

        // A note between the staff about a struggling class is not published
        // to that class — and it must not show up in their counts either.
        if (!isStaff(req)) where.push(`COALESCE(c."visibility", 'all') = 'all'`);

        if (req.query.author === 'students') where.push(`c."authorRole" IN ('student', 'parent')`);
        if (req.query.author === 'staff')    where.push(`c."authorRole" IN ('school_admin', 'teacher')`);
        if (req.query.author === 'pinned')   where.push('COALESCE(c."isPinned", false)');
        if (req.query.search) {
            params.push(`%${String(req.query.search).trim()}%`);
            where.push(`c."body" ILIKE $${params.length}`);
        }
        // Under a filter a deleted comment matches nothing of its own; the
        // replies it held are shown by themselves instead.
        if (req.query.author || req.query.search) where.push('NOT COALESCE(c."isDeleted", false)');

        const { rows } = await pool.query(
            `SELECT c."_id", c."body", c."files", c."parent", c."isPinned", c."visibility",
                    c."likes", c."isEdited", c."isDeleted", c."authorRole", c."createdAt", c."updatedAt",
                    u."_id" AS "authorId", u."name" AS "authorName", u."profileImage" AS "authorPhoto"
               FROM ${qt(DocumentComment)} c
               LEFT JOIN ${qt(User)} u ON u."_id" = c."author"
              WHERE ${where.join(' AND ')}
              ORDER BY COALESCE(c."isPinned", false) DESC, c."createdAt" ${dir}`,
            params,
        );

        const me = String(req.userId);
        const admin = isAdmin(req);
        const pins  = canPinOn(req, doc);
        const shape = (r) => {
            const mine = String(r.authorId) === me;
            // Deleted by its author, kept only for the replies under it.
            if (r.isDeleted) {
                return {
                    _id: r._id, deleted: true, body: '', files: [], parent: r.parent,
                    isPinned: false, visibility: r.visibility || 'all', isEdited: false,
                    createdAt: r.createdAt, likes: 0, likedByMe: false, mine: false,
                    canEdit: false, canDelete: admin, canPin: false,
                    author: { _id: null, name: '', role: '', photo: '' },
                };
            }
            return {
                _id: r._id,
                body: r.body || '',
                files: Array.isArray(r.files) ? r.files : [],
                parent: r.parent,
                isPinned: !!r.isPinned,
                visibility: r.visibility || 'all',
                isEdited: !!r.isEdited,
                createdAt: r.createdAt,
                likes: (r.likes || []).length,
                likedByMe: (r.likes || []).map(String).includes(me),
                mine,
                // What this reader may do with it — the same rules updateComment
                // and deleteComment enforce, so the page offers only what works:
                // your own words to edit or delete; anyone's to delete if you
                // are an admin; pinning for an admin or the sharing teacher.
                canEdit: mine,
                canDelete: mine || admin,
                canPin: pins && !r.parent,
                author: r.authorId
                    ? { _id: r.authorId, name: r.authorName, role: r.authorRole, photo: r.authorPhoto }
                    : { _id: null, name: 'Removed account', role: r.authorRole, photo: '' },
            };
        };

        const all     = rows.map(shape);
        const byId    = Object.fromEntries(all.map((c) => [String(c._id), c]));
        const replies = all.filter((c) => c.parent && byId[String(c.parent)]);
        // A reply whose parent fell outside the filter is promoted rather than
        // dropped — a search for a word that only appears in the reply must
        // still show it.
        let roots     = all.filter((c) => !c.parent || !byId[String(c.parent)]);

        for (const r of roots) r.replies = [];
        for (const r of replies) byId[String(r.parent)].replies.push(r);
        for (const r of roots) r.replies.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        // A deleted comment with nothing left under it for this reader (its
        // replies were staff-only, say) has nothing to hold together.
        roots = roots.filter((r) => !r.deleted || r.replies.length);

        const live = all.filter((c) => !c.deleted);
        const isStudent = (c) => c.author.role === 'student' || c.author.role === 'parent';
        res.json({
            success: true,
            data: {
                threads: roots,
                summary: {
                    total:    live.length,
                    queries:  live.filter(isStudent).length,
                    replies:  live.filter((c) => !isStudent(c) && c.parent).length,
                    pinned:   live.filter((c) => c.isPinned).length,
                },
                // The rail's timeline: the most recent activity, whatever it was on.
                recent: [...live]
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .slice(0, 6)
                    .map((c) => ({
                        _id: c._id, at: c.createdAt,
                        who: c.author.name, role: c.author.role,
                        what: c.parent ? 'Reply added' : 'Comment added',
                    })),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.addComment = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;

        const body  = String(req.body.body || '').trim();
        const files = buildFiles(req.files);
        if (!body && !files.length) {
            return res.status(400).json({ success: false, message: 'Write something, or attach a file' });
        }

        let parent = null;
        if (req.body.parent) {
            const p = await DocumentComment.findOne({ _id: req.body.parent, document: doc._id }).lean();
            if (!p || (!isStaff(req) && p.visibility === 'staff')) return res.status(404).json({ success: false, message: 'The comment being replied to is gone' });
            // Only one level: a reply to a reply joins the same thread rather
            // than starting a third tier nobody can read on a phone.
            parent = p.parent || p._id;
        }

        const comment = await DocumentComment.create({
            document:   doc._id,
            school:     req.schoolId,
            author:     req.userId,
            authorRole: req.userRole,
            body,
            files,
            parent,
            // Only staff can keep a comment among staff.
            visibility: isStaff(req) && req.body.visibility === 'staff' ? 'staff' : 'all',
        });

        // Only the person actually being answered is told. A comment on a
        // document shared with the whole school is not an event 900 people need
        // in their inbox.
        if (parent) {
            const p = await DocumentComment.findById(parent).lean();
            if (p && !p.isDeleted && String(p.author) !== String(req.userId)) {
                notify({
                    school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                    title: '💬 Reply on an assignment',
                    body: `Your comment on "${doc.title}" has a reply.`,
                    recipients: [p.author],
                    link: { type: 'documents.item', entityId: doc._id },
                });
            }
        }

        res.status(201).json({ success: true, data: comment });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** Edit your own words; pin a comment if you are an admin or shared the document. */
exports.updateComment = async (req, res) => {
    try {
        const c = await DocumentComment.findOne({ _id: req.params.commentId, school: req.schoolId });
        if (!c || c.isDeleted) return res.status(404).json({ success: false, message: 'This comment was deleted' });
        if (req.body.isPinned !== undefined || req.body.visibility !== undefined) {
            const doc = await Document.findOne({ _id: c.document, school: req.schoolId }).select('uploadedBy').lean();
            if (!canPinOn(req, doc)) {
                return res.status(403).json({ success: false, message: 'Only the school office or the teacher who shared this document can do that' });
            }
        }

        if (req.body.body !== undefined) {
            if (String(c.author) !== String(req.userId)) {
                return res.status(403).json({ success: false, message: 'You can only edit your own comment' });
            }
            const body = String(req.body.body).trim();
            if (!body && !c.files?.length) {
                return res.status(400).json({ success: false, message: 'A comment cannot be emptied — delete it instead' });
            }
            c.body = body;
            c.isEdited = true;
        }
        if (req.body.isPinned   !== undefined) c.isPinned   = !!req.body.isPinned;
        if (req.body.visibility !== undefined) c.visibility = req.body.visibility === 'staff' ? 'staff' : 'all';

        await c.save();
        res.json({ success: true, data: c });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteComment = async (req, res) => {
    try {
        const c = await DocumentComment.findOne({ _id: req.params.commentId, school: req.schoolId }).lean();
        const admin = isAdmin(req);
        if (!c || (c.isDeleted && !admin)) return res.status(404).json({ success: false, message: 'This comment was already deleted' });
        const mine = String(c.author) === String(req.userId);
        if (!mine && !admin) {
            return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
        }

        const T = qt(DocumentComment);
        let kept = false;
        let deletedReplies = 0;
        if (!admin && !c.parent) {
            // Your own comment, but the replies under it may be other people's —
            // and you may delete only your own words. When anyone else has
            // replied, the comment is emptied to "This comment was deleted" and
            // their replies stay under it.
            const { rows: [o] } = await pool.query(
                `SELECT count(*)::int AS n FROM ${T} WHERE "parent" = $1 AND "author" <> $2::uuid`,
                [String(c._id), String(req.userId)],
            );
            if (o.n > 0) {
                await pool.query(
                    `UPDATE ${T} SET "isDeleted" = true, "body" = '', "files" = '[]'::jsonb,
                            "isPinned" = false, "likes" = '[]'::jsonb, "updatedAt" = now()
                      WHERE "_id" = $1`,
                    [String(c._id)],
                );
                kept = true;
            }
        }
        if (!kept) {
            await DocumentComment.deleteOne({ _id: c._id });
            // Replies go with the comment they answer — left behind they read
            // as answers to nothing. (For anyone but an admin they are all the
            // author's own by now: other people's replies kept the row above.)
            ({ rowCount: deletedReplies } = await pool.query(
                `DELETE FROM ${T} WHERE "parent" = $1`, [String(c._id)],
            ));
        }
        // The last reply under a deleted comment takes the empty shell with it.
        if (c.parent) {
            await pool.query(
                `DELETE FROM ${T} p
                  WHERE p."_id" = $1 AND COALESCE(p."isDeleted", false)
                    AND NOT EXISTS (SELECT 1 FROM ${T} r WHERE r."parent" = p."_id")`,
                [String(c.parent)],
            );
        }
        res.json({ success: true, deletedReplies, kept });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleLike = async (req, res) => {
    try {
        // One statement, so two people liking at once cannot each overwrite the
        // other's array with a copy read a moment earlier.
        const { rows } = await pool.query(
            `UPDATE ${qt(DocumentComment)}
                SET "likes" = CASE
                      WHEN "likes" @> to_jsonb($2::text) THEN "likes" - $2::text
                      ELSE COALESCE("likes", '[]'::jsonb) || to_jsonb($2::text)
                    END
              WHERE "_id" = $1 AND "school" = $3
                AND ($4::boolean OR COALESCE("visibility", 'all') = 'all')
                AND NOT COALESCE("isDeleted", false)
          RETURNING "likes"`,
            [req.params.commentId, String(req.userId), String(req.schoolId), isStaff(req)],
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'Comment not found' });

        const likes = rows[0].likes || [];
        res.json({ success: true, likes: likes.length, likedByMe: likes.map(String).includes(String(req.userId)) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
