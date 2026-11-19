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
const DocumentRead       = require('../models/DocumentRead');
const DocumentReminder   = require('../models/DocumentReminder');
const StudentEnrollment  = require('../models/StudentEnrollment');
const pool               = require('../db/pool');
const { notify, withParents } = require('../services/notifyService');
const access             = require('../services/documentAccess');
const { isUuid }         = access;

/** The marking form's own line for what the named questions leave over. */
const OTHER_MARKS = 'Other marks';
const like = (term) => `%${String(term).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

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
 *
 * WHO IS ON IT is read from where each student sat in the document's own
 * academic year (StudentEnrollment) — `place` below. It used to be the
 * profile's current-section pointer, which moves when the year rolls over: the
 * day a school promoted its students, every class assignment of the year
 * before showed nobody, and the marks with them. A student with no enrolment
 * row for that year is placed by the pointer when the pointer rests in it; a
 * document filed under no year is judged by the pointer alone.
 *
 * Anyone who handed work in stays, wherever they are placed now — labelled
 * with their own year when it is not the document's.
 *
 * `only` narrows it to some sections: what a teacher who did not set the work
 * may see of it is their own classes, not the whole school's submissions.
 */
function rosterCte({ docId, school, sections, dueDate, year = null, only = null }) {
    const params = [docId, school];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    const Y = year ? `${add(String(year))}::uuid` : null;

    const place = Y ? `
      place AS (
        SELECT e."student", e."section", e."class", e."rollNumber"
          FROM ${qt(StudentEnrollment)} e
         WHERE e."school" = $2::uuid AND e."academicYear" = ${Y}
        UNION ALL
        SELECT sp."user", sp."currentSection", s0."class", sp."rollNumber"
          FROM ${qt(StudentProfile)} sp
          JOIN ${qt(ClassSection)} s0 ON s0."_id" = sp."currentSection"
          JOIN ${qt(Class)} c0        ON c0."_id" = s0."class"
         WHERE sp."school" = $2::uuid AND c0."academicYear" = ${Y}
           AND NOT EXISTS (SELECT 1 FROM ${qt(StudentEnrollment)} e
                            WHERE e."student" = sp."user" AND e."academicYear" = ${Y})
      )` : `
      place AS (
        SELECT sp."user" AS "student", sp."currentSection" AS "section", s0."class", sp."rollNumber"
          FROM ${qt(StudentProfile)} sp
          LEFT JOIN ${qt(ClassSection)} s0 ON s0."_id" = sp."currentSection"
         WHERE sp."school" = $2::uuid
      )`;

    let scope;
    if (sections === null) {
        // The whole school — as it stood in the document's own academic year.
        scope = 'pl."student" IS NOT NULL';
    } else if (!sections.length) {
        // Nobody — a teacher-only document, or a target with nothing selected.
        scope = 'false';
    } else {
        scope = `pl."section" = ANY(${add(sections)}::uuid[])`;
    }
    const mine = only ? ` AND COALESCE(pl."section", sp."currentSection")::text = ANY(${add(only)}::text[])` : '';
    const dueParam = `${add(dueDate || null)}::timestamptz`;

    const sql = `${place},
      roster AS (
        SELECT u."_id"            AS "studentId",
               u."name",
               u."profileImage",
               COALESCE(NULLIF(pl."rollNumber", ''), sp."rollNumber") AS "rollNumber",
               COALESCE(pl."section", sp."currentSection")            AS "currentSection",
               c."className",
               s."sectionName",
               ${Y ? `CASE WHEN pl."student" IS NULL AND c."_id" IS NOT NULL THEN ay."yearName" END` : 'NULL::text'} AS "otherYear",
               sub."_id"           AS "submissionId",
               sub."submittedAt",
               sub."marks",
               sub."feedback",
               sub."files"         AS "submissionFiles",
               sub."questionScores",
               sub."reviewedAt",
               rd."readAt",
               CASE
                 WHEN sub."status" IN ('submitted', 'late') THEN sub."status"
                 WHEN ${dueParam} IS NOT NULL AND now() > ${dueParam} THEN 'missed'
                 ELSE 'pending'
               END AS "state"
          FROM ${qt(StudentProfile)} sp
          JOIN ${qt(User)} u ON u."_id" = sp."user" AND u."role" = 'student'
          LEFT JOIN place pl                ON pl."student" = u."_id"
          LEFT JOIN ${qt(ClassSection)} s   ON s."_id" = COALESCE(pl."section", sp."currentSection")
          LEFT JOIN ${qt(Class)} c          ON c."_id" = COALESCE(pl."class", s."class")
          LEFT JOIN ${qt(AcademicYear)} ay  ON ay."_id" = c."academicYear"
          LEFT JOIN ${qt(AssignmentSubmission)} sub
                 ON sub."document" = $1::uuid AND sub."student" = u."_id"
          LEFT JOIN ${qt(DocumentRead)} rd
                 ON rd."document" = $1::uuid AND rd."user" = u."_id"
         WHERE sp."school" = $2::uuid
           AND (((${scope}) AND COALESCE(u."isActive", true)) OR sub."_id" IS NOT NULL)${mine}
      )`;
    return { sql, params };
}

/** Submitted, however late. The tiles group them; the row still says which. */
const HANDED_IN = `"state" IN ('submitted', 'late')`;

/** "Class 6 - B", or "Class 6 - B (2025-26)" for a section of another year. */
const SECTION_LABEL = (empty) => `coalesce("className" || ' - ' || "sectionName" || coalesce(' (' || "otherYear" || ')', ''), '${empty}')`;

// ── Loading the document ─────────────────────────────────────────────────────

async function loadDoc(req, res) {
    const doc = isUuid(req.params.id)
        ? await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean()
        : null;
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
 * Reading someone else's assignment shows the students of the teacher's own
 * sections and nobody else's work (`req.rosterOnly`): a school-wide assignment
 * used to hand every teacher every student's submission, marks and feedback.
 *
 * Mounted as route middleware rather than folded into loadDoc, so the admin
 * routes are untouched and a teacher route can never forget the check.
 */
exports.teacherDocumentAccess = (mode = 'read') => async (req, res, next) => {
    try {
        const doc = isUuid(req.params.id)
            ? await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean()
            : null;
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        if (String(doc.uploadedBy) === String(req.userId)) return next();
        if (mode === 'own') {
            return res.status(403).json({
                success: false,
                message: 'Only the teacher who set this can do that',
            });
        }
        if (!(await access.teacherCanRead(doc, req.userId, req.schoolId))) {
            return res.status(403).json({ success: false, message: 'This document was not shared with you' });
        }
        req.rosterOnly = (await access.teacherReach(req.userId, req.schoolId)).sections;
        return next();
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

/** The header strip: what this document is, in one object both tabs read. */
async function header(doc, req) {
    const [uploader, sections, classes, year, people, readers] = await Promise.all([
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
        // How many people have opened it — the sharer's own opening left out.
        pool.query(
            `SELECT count(*)::int AS n FROM ${qt(DocumentRead)} WHERE "document" = $1 AND "user" <> $2`,
            [String(doc._id), String(doc.uploadedBy)],
        ).then((r) => r.rows[0]?.n || 0).catch(() => 0),
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
        // Made but not shared: nobody it is aimed at can see it yet.
        : doc.isDraft ? 'draft'
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
        // The ids as well as the names: the phone's edit form opens from this
        // payload, and a field it is not given is a field it would blank.
        targetClasses:  (doc.targetClasses  || []).map(String),
        targetSections: (doc.targetSections || []).map(String),
        targetUsers:    (doc.targetUsers    || []).map(String),
        sharedWith: where,
        academicYearName: year,
        files: access.publicFiles(doc.files),
        currentVersion: doc.currentVersion || 1,
        isArchived: !!doc.isArchived,
        isDraft: !!doc.isDraft,
        // The last "remind everyone", and when the next may go (null: now).
        remindedAt: doc.lastReminderAt || null,
        remindAgainAt: remindAllAgainAt(doc.lastReminderAt),
        status,
        readCount: readers,
        lastReminderAt: doc.lastReminderAt || null,
        // Whether the reader may change this. An admin always may; a teacher
        // only their own — the routes enforce it, and the page needs to know so
        // it does not offer buttons that will be refused.
        // "Admin" is the route as much as the role: a teacher whose designation
        // administers Documents arrives on /api/admin and may do all of it.
        canManage: (req ? isAdmin(req) : false) || String(doc.uploadedBy) === String(req?.userId),
        uploadedBy: uploader
            ? { _id: uploader._id, name: uploader.name, role: uploader.role, photo: uploader.profileImage }
            : null,
    };
}

/**
 * Five equal bands across the total, the way a mark sheet is read.
 *
 * The bands are continuous — each takes everything above the one before it up
 * to its own top — so no mark can fall between two of them. They used to be
 * whole-number ranges ("0–10", "11–20"): a 10.5 was counted in neither, and a
 * paper out of 3 produced bands that read "2–1". Anything above the total
 * (marks recorded before a total was lowered) lands in the last band rather
 * than nowhere.
 */
function scoreBands(totalMarks) {
    const total = Number(totalMarks) > 0 ? Number(totalMarks) : 100;
    const step  = total / 5;
    const whole = Number.isInteger(step);
    const fmt   = (n) => String(Math.round(n * 10) / 10);
    return Array.from({ length: 5 }, (_, i) => {
        const lo = +(i * step).toFixed(6);
        const hi = +((i + 1) * step).toFixed(6);
        return {
            lo, hi, first: i === 0, last: i === 4,
            // Whole steps keep the familiar "11–20"; a fractional step says
            // where each band starts and ends.
            label: i === 0 ? `0–${fmt(hi)}` : whole ? `${lo + 1}–${hi}` : `${fmt(lo)}–${fmt(hi)}`,
        };
    });
}

const bandCaseSql = (bands) => bands
    .map((b, i) => {
        const range = b.first ? `"marks" <= ${b.hi}` : b.last ? `"marks" > ${b.lo}` : `"marks" > ${b.lo} AND "marks" <= ${b.hi}`;
        return `count(*) FILTER (WHERE "marks" IS NOT NULL AND ${range})::int AS "b${i}"`;
    })
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
            year: doc.academicYear || null, only: req.rosterOnly || null,
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

        if (isUuid(q.section)) { rowParams.push(String(q.section)); where.push(`"currentSection" = $${rowParams.length}::uuid`); }
        if (String(q.search || '').trim()) {
            rowParams.push(like(q.search));
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

        // When each student on this page was last reminded, so their bell can
        // wait out its ten minutes instead of being pressed and refused.
        const pageIds = rows.rows.map((r) => String(r.studentId));
        const reminded = pageIds.length
            ? Object.fromEntries((await pool.query(
                `SELECT "student", "sentAt" FROM ${qt(DocumentReminder)}
                  WHERE "document" = $1 AND "student" = ANY($2::uuid[])`,
                [String(doc._id), pageIds],
            )).rows.map((r) => [String(r.student), r.sentAt]))
            : {};
        const withReminder = (r) => {
            const sentAt = reminded[String(r.studentId)] || null;
            return { ...shapeStudent(r), remindedAt: sentAt, remindAgainAt: remindOneAgainAt(sentAt) };
        };

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
                    students: rows.rows.map(withReminder),
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
    const files = access.publicFiles(r.submissionFiles);
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
        // When they opened the assignment, if they have.
        readAt: r.readAt || null,
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
            year: doc.academicYear || null, only: req.rosterOnly || null,
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
            // The assignment before this one, for the "vs last assignment" line:
            // set by the same person to exactly the same classes or sections.
            // It used to be any earlier assignment in the school with the same
            // KIND of audience, so a teacher's page compared their class with
            // another teacher's — and named that work and its average.
            pool.query(
                `SELECT d."_id", d."title", d."totalMarks",
                        avg(sub."marks")::float AS "average"
                   FROM ${qt(Document)} d
                   JOIN ${qt(AssignmentSubmission)} sub ON sub."document" = d."_id" AND sub."marks" IS NOT NULL
                  WHERE d."school" = $1 AND d."_id" <> $2
                    AND COALESCE(d."isAssignment", false)
                    AND NOT COALESCE(d."isArchived", false)
                    AND d."targetType" = $3
                    AND d."createdAt" < $4
                    AND d."uploadedBy" = $5
                    AND ${access.ARR('d."targetClasses"')}  @> $6::jsonb AND ${access.ARR('d."targetClasses"')}  <@ $6::jsonb
                    AND ${access.ARR('d."targetSections"')} @> $7::jsonb AND ${access.ARR('d."targetSections"')} <@ $7::jsonb
                  GROUP BY d."_id", d."title", d."totalMarks", d."createdAt"
                  ORDER BY d."createdAt" DESC
                  LIMIT 1`,
                [String(doc.school), String(doc._id), doc.targetType, doc.createdAt, String(doc.uploadedBy),
                    JSON.stringify((doc.targetClasses || []).map(String)),
                    JSON.stringify((doc.targetSections || []).map(String))],
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

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Award marks and write feedback against one student.
 *
 * Addressed by student rather than by submission id: the admin is marking a
 * name on a roster, and half the roster has no submission row at all. When the
 * assignment defines questions the total is computed from the per-question
 * scores rather than typed twice — two numbers that must agree are one number
 * with extra chances to be wrong.
 *
 * What the numbers may be:
 *   • never below zero, never above the question's own maximum, and never more
 *     in all than the assignment is out of — a refusal, not a silent trim;
 *   • when every question has a maximum and they add up to less than the
 *     total, the rest can be awarded as "Other marks" (presentation, neatness)
 *     — there used to be no way to give those marks at all.
 *
 * A student who handed nothing in through the app can still be marked — work
 * done on paper, or a zero for work never done. That writes a row with no
 * files and no hand-in time; the roster still says they did not submit.
 */
exports.reviewSubmission = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        if (!doc.isAssignment) {
            return res.status(400).json({ success: false, message: 'This document is not an assignment' });
        }
        const bad = (message, status = 400) => res.status(status).json({ success: false, message });

        const studentId = req.params.studentId;
        if (!isUuid(studentId)) return bad('That student could not be found', 404);
        const sub = await AssignmentSubmission.findOne({ document: doc._id, student: studentId });
        if (!sub && !(await access.studentsReached(doc._id, [studentId])).length) {
            return bad('This student is not on this assignment', 404);
        }

        const before = {
            marks: sub?.marks ?? null,
            feedback: sub?.feedback || '',
        };
        const next = { marks: before.marks, feedback: before.feedback, questionScores: sub?.questionScores || [] };

        const total  = Number(doc.totalMarks) > 0 ? Number(doc.totalMarks) : null;
        const num    = (raw) => (raw === '' || raw == null ? null : Number(raw));
        const scores = Array.isArray(req.body.questionScores) ? req.body.questionScores : null;
        const questions = doc.questions || [];

        // Set with no "Out of", it is marked in words only (Nov 2026): the
        // person who set it chose no marks, so nobody may give any. An empty
        // marks field is not a mark, and marks already on the row stay as
        // they are — this refuses new ones, it does not erase old ones.
        if (total == null) {
            const giving = num(req.body.marks) != null
                || (scores || []).some((q) => num(q?.score) != null);
            if (giving) return bad('This assignment was set without marks — give feedback only');
        } else if (scores && questions.length) {
            const byLabel = Object.fromEntries(scores.map((q) => [String(q?.label ?? ''), q?.score]));
            const out = [];
            for (const q of questions) {
                const n   = num(byLabel[q.label]);
                const max = Number(q.maxMarks) > 0 ? Number(q.maxMarks) : null;
                if (n != null && (Number.isNaN(n) || n < 0)) return bad(`${q.label}: marks must be zero or more`);
                if (n != null && max != null && n > max)     return bad(`${q.label} is out of ${max}`);
                out.push({ label: q.label, score: n });
            }

            // What the named questions leave over, when they say how much each
            // is worth and that comes to less than the paper is out of.
            const named = questions.reduce((a, q) => a + (Number(q.maxMarks) > 0 ? Number(q.maxMarks) : 0), 0);
            const room  = total != null && questions.every((q) => Number(q.maxMarks) > 0) ? round2(total - named) : 0;
            const other = num(byLabel[OTHER_MARKS]);
            if (other != null) {
                if (Number.isNaN(other) || other < 0) return bad(`${OTHER_MARKS} must be zero or more`);
                if (!(room > 0))                      return bad(`The questions already add up to the total — there are no ${OTHER_MARKS.toLowerCase()} to give`);
                if (other > room)                     return bad(`${OTHER_MARKS} is out of ${room}`);
                out.push({ label: OTHER_MARKS, score: other });
            }

            const awarded = out.filter((q) => q.score != null);
            const sum = awarded.length ? round2(awarded.reduce((n, q) => n + q.score, 0)) : null;
            if (sum != null && total != null && sum > total) {
                return bad(`These add up to ${sum}, more than the total of ${total}`);
            }
            next.questionScores = out;
            next.marks = sum;
        } else if (req.body.marks !== undefined) {
            const n = num(req.body.marks);
            if (n != null && (Number.isNaN(n) || n < 0)) return bad('Marks must be a number, zero or more');
            if (n != null && total != null && n > total) return bad(`Marks cannot exceed ${total}`);
            next.marks = n;
            next.questionScores = [];
        }
        if (req.body.feedback !== undefined) next.feedback = String(req.body.feedback).trim().slice(0, 2000);

        const reviewed = next.marks != null || !!next.feedback;
        if (!sub && !reviewed) return bad(total == null ? 'Write some feedback to record' : 'Enter marks or feedback to record');

        let saved;
        if (sub) {
            sub.marks = next.marks;
            sub.feedback = next.feedback;
            sub.questionScores = next.questionScores;
            // Cleared again: nothing has been marked, so nothing says it was.
            sub.reviewedBy = reviewed ? req.userId : null;
            sub.reviewedAt = reviewed ? new Date() : null;
            await sub.save();
            saved = sub;
        } else {
            saved = await AssignmentSubmission.create({
                document: doc._id, school: doc.school, student: studentId,
                files: [], status: 'pending', submittedAt: null,
                marks: next.marks, feedback: next.feedback, questionScores: next.questionScores,
                reviewedBy: req.userId, reviewedAt: new Date(),
            });
        }

        // Told only when there is something new to read: taking a mark back
        // off, or saving the form unchanged, is not news. The student's
        // parents hear it too, under that child.
        const changed = next.marks !== before.marks || next.feedback !== before.feedback;
        if (reviewed && changed) {
            const score = next.marks != null ? ` — ${next.marks}${total ? `/${total}` : ''}` : '';
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: next.marks != null ? '📝 Assignment marked' : '💬 Feedback on an assignment',
                body: next.marks != null
                    ? `"${doc.title}" has been marked${score}.`
                    : `There is feedback on "${doc.title}".`,
                recipients: await withParents([studentId]),
                about: [studentId],
                link: { type: 'documents.item', entityId: doc._id },
            });
        }

        const out = typeof saved.toObject === 'function' ? saved.toObject() : saved;
        res.json({ success: true, data: { ...out, files: access.publicFiles(out.files) } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// How often a reminder may go: to everyone outstanding once an hour, to one
// named student once in ten minutes. Both limits are facts in the database —
// the document's own `lastReminderAt`, and a DocumentReminder row per student
// — claimed in one statement each, so every server process reads the same
// answer and two presses at once cannot both get through. (The per-student one
// used to be a list in this process's memory.)
const REMIND_ALL_EVERY = 60 * 60 * 1000;
const REMIND_ONE_MINUTES = 10;
const clock = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

/**
 * When the next reminder may go, for the page to hold its buttons until then
 * (Nov 2026): it used to offer them freely and only refuse once pressed. Null
 * when it may go now.
 */
const remindAllAgainAt = (last) => {
    const at = last ? new Date(last).getTime() + REMIND_ALL_EVERY : 0;
    return at > Date.now() ? new Date(at) : null;
};
const remindOneAgainAt = (sent) => {
    const at = sent ? new Date(sent).getTime() + REMIND_ONE_MINUTES * 60 * 1000 : 0;
    return at > Date.now() ? new Date(at) : null;
};

/** Nudge everyone the assignment is still waiting on — and their parents. */
exports.remindPending = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        const bad = (message, status = 400, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
        if (!doc.isAssignment)    return bad('This document is not an assignment');
        // A reminder asks for something. Neither of these can be answered.
        if (doc.isDraft)          return bad('This is still a draft — share it before sending a reminder');
        if (doc.isArchived)       return bad('This assignment is archived — restore it before sending a reminder');
        if (!doc.allowSubmission) return bad('Submissions are closed on this assignment, so there is nothing a reminder could ask for');

        // A named few, or everyone still outstanding.
        const named = Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(String).filter(isUuid) : [];
        const only  = named.length ? named : null;
        if (Array.isArray(req.body?.studentIds) && req.body.studentIds.length && !only) {
            return bad('Those students could not be found');
        }

        const now = Date.now();
        if (!only) {
            // Claimed before anything is sent: the hour starts now or not at all.
            const claim = await pool.query(
                `UPDATE ${qt(Document)} SET "lastReminderAt" = now()
                  WHERE "_id" = $1
                    AND ("lastReminderAt" IS NULL OR "lastReminderAt" < now() - interval '${REMIND_ALL_EVERY / 60000} minutes')`,
                [String(doc._id)],
            );
            if (!claim.rowCount) {
                const last = (await Document.findById(doc._id).select('lastReminderAt').lean())?.lastReminderAt || doc.lastReminderAt;
                return res.status(429).json({
                    success: false, code: 'REMINDED_RECENTLY',
                    message: `A reminder already went to everyone at ${clock(last)}. `
                        + `The next one can go after ${clock(new Date(last).getTime() + REMIND_ALL_EVERY)}.`,
                    remindAgainAt: remindAllAgainAt(last),
                });
            }
        }
        // Nothing went out after all: the hour is given back.
        const release = () => (only ? null : Document.updateOne({ _id: doc._id }, { lastReminderAt: doc.lastReminderAt || null }));

        const sections = await audienceSections(doc);
        const { sql: cte, params } = rosterCte({
            docId: String(doc._id), school: String(doc.school), sections, dueDate: doc.dueDate,
            year: doc.academicYear || null,
        });
        const extra = only ? [only] : [];
        const pick  = only ? ` AND "studentId" = ANY($${params.length + 1}::uuid[])` : '';

        // Still owed: nothing handed in, and nothing marked on paper either.
        const { rows } = await pool.query(
            `WITH ${cte} SELECT "studentId" FROM roster WHERE NOT (${HANDED_IN}) AND "marks" IS NULL${pick}`,
            [...params, ...extra],
        );
        let students = rows.map((r) => String(r.studentId));
        if (only && students.length) {
            // Each named student is claimed in the same statement that decides
            // whether their ten minutes are up; the ones that come back are
            // the ones to send to.
            const claimed = await pool.query(
                `INSERT INTO ${qt(DocumentReminder)} ("_id", "document", "student", "school", "sentAt", "createdAt", "updatedAt")
                 SELECT gen_random_uuid(), $1::uuid, s::uuid, $2::uuid, now(), now(), now()
                   FROM unnest($3::text[]) s
                 ON CONFLICT ("document", "student") DO UPDATE
                    SET "sentAt" = now(), "updatedAt" = now()
                  WHERE ${qt(DocumentReminder)}."sentAt" < now() - interval '${REMIND_ONE_MINUTES} minutes'
                 RETURNING "student"`,
                [String(doc._id), String(doc.school), students],
            );
            const fresh = claimed.rows.map((r) => String(r.student));
            if (!fresh.length) {
                return bad('A reminder was sent a few minutes ago — give it a little time', 429, 'REMINDED_RECENTLY');
            }
            students = fresh;
        }
        if (!students.length) {
            await release();
            return res.json({ success: true, sent: 0, message: 'Everyone has already submitted' });
        }
        if (!only) {
            // Everyone just reminded has been reminded: each one's own bell
            // waits out the same ten minutes a single reminder starts, rather
            // than offering a second nudge a minute after the first.
            await pool.query(
                `INSERT INTO ${qt(DocumentReminder)} ("_id", "document", "student", "school", "sentAt", "createdAt", "updatedAt")
                 SELECT gen_random_uuid(), $1::uuid, s::uuid, $2::uuid, now(), now(), now()
                   FROM unnest($3::text[]) s
                 ON CONFLICT ("document", "student") DO UPDATE SET "sentAt" = now(), "updatedAt" = now()`,
                [String(doc._id), String(doc.school), students],
            );
        }

        const due  = doc.dueDate ? new Date(doc.dueDate) : null;
        const day  = due ? due.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        // "It was due" only once it has been — this said so about next week.
        const when = !due ? '.' : due.getTime() < now ? ` — it was due ${day}.` : ` — it is due ${day}.`;
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '⏰ Assignment still to submit',
            body: `"${doc.title}" has not been handed in yet${when}`,
            recipients: await withParents(students),
            about: students,
            link: { type: 'documents.item', entityId: doc._id },
        });

        // When this button may be pressed again, for the page to hold it.
        const at = new Date();
        res.json({ success: true, sent: students.length, remindAgainAt: only ? remindOneAgainAt(at) : remindAllAgainAt(at) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * A second copy of a document, ready to be edited into next week's.
 *
 * The file metadata is copied, not the files: both rows point at the same
 * bytes on disk, and a file is only removed once nothing names it. The copy
 * starts unarchived, at version 1, with no submissions and no due date — a
 * date carried over from the original would be in the past on arrival.
 *
 * It is filed under THIS year and aimed at this year's rows of the same
 * classes and sections. It used to keep the original's year and ids, so a copy
 * made after a rollover sat in last year, out of every default view, with a
 * roster of nobody.
 *
 * And it starts as a DRAFT: nobody it is aimed at sees it, or hears of it,
 * until whoever copied it has made it this week's and shared it. A copy used
 * to land on the class's shelf as it was made — "… (copy)", no due date.
 */
exports.duplicate = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;

        const yearId = await access.currentYearId(req.schoolId);
        let classes  = (doc.targetClasses  || []).map(String);
        let sections = (doc.targetSections || []).map(String);

        if (yearId) {
            if (classes.length) {
                classes = (await pool.query(
                    `SELECT DISTINCT c2."_id"
                       FROM ${qt(Class)} c1
                       JOIN ${qt(Class)} c2 ON c2."school" = c1."school" AND c2."classNumber" = c1."classNumber"
                                           AND c2."academicYear" = $2
                      WHERE c1."_id"::text = ANY($1::text[]) AND c1."school" = $3`,
                    [classes, String(yearId), String(req.schoolId)],
                )).rows.map((r) => String(r._id));
            }
            if (sections.length) {
                sections = (await pool.query(
                    `SELECT DISTINCT s2."_id"
                       FROM ${qt(ClassSection)} s1
                       JOIN ${qt(Class)} c1        ON c1."_id" = s1."class"
                       JOIN ${qt(Class)} c2        ON c2."school" = c1."school" AND c2."classNumber" = c1."classNumber"
                                                  AND c2."academicYear" = $2
                       JOIN ${qt(ClassSection)} s2 ON s2."class" = c2."_id" AND s2."sectionName" = s1."sectionName"
                      WHERE s1."_id"::text = ANY($1::text[]) AND s1."school" = $3`,
                    [sections, String(yearId), String(req.schoolId)],
                )).rows.map((r) => String(r._id));
            }
        }
        // A teacher's copy goes only where they may share this year.
        if (!isAdmin(req) && doc.targetType === 'class_sections') {
            const mine = (await access.teacherReach(req.userId, req.schoolId)).postable;
            sections = sections.filter((id) => mine.includes(id));
        }
        if ((doc.targetType === 'class' && !classes.length) || (doc.targetType === 'class_sections' && !sections.length)) {
            return res.status(400).json({
                success: false,
                message: 'None of the classes this was shared with exist in the current academic year — share it again as a new document instead',
            });
        }

        const { _id, createdAt, updatedAt, lastReminderAt, ...rest } = doc;
        const copy = await Document.create({
            ...rest,
            title: `${doc.title} (copy)`.slice(0, 160),
            uploadedBy: req.userId,
            uploaderRole: req.userRole === 'teacher' ? 'teacher' : 'school_admin',
            academicYear: yearId,
            targetClasses: classes,
            targetSections: sections,
            currentVersion: 1,
            isArchived: false,
            isDraft: true,
            dueDate: null,
        });
        const out = typeof copy.toObject === 'function' ? copy.toObject() : copy;
        res.status(201).json({ success: true, data: { ...out, files: access.publicFiles(out.files) } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Who has opened it — for the person who shared it.
 *
 * The read marks have been kept since Nov 2026 and only ever told a reader
 * what THEY had not opened; the sharer could not see whether a notice had
 * been read by anyone.
 */
exports.getReaders = async (req, res) => {
    try {
        const doc = await loadDoc(req, res);
        if (!doc) return;
        const { rows } = await pool.query(
            `SELECT u."_id", u."name", u."role", u."profileImage", r."readAt",
                    c."className" || ' - ' || s."sectionName" AS "section"
               FROM ${qt(DocumentRead)} r
               JOIN ${qt(User)} u ON u."_id" = r."user"
               LEFT JOIN ${qt(StudentProfile)} sp ON sp."user" = u."_id" AND u."role" = 'student'
               LEFT JOIN ${qt(ClassSection)} s    ON s."_id" = sp."currentSection"
               LEFT JOIN ${qt(Class)} c           ON c."_id" = s."class"
              WHERE r."document" = $1 AND r."user" <> $2
              ORDER BY r."readAt" DESC
              LIMIT 1000`,
            [String(doc._id), String(doc.uploadedBy)],
        );
        res.json({
            success: true,
            data: {
                total: rows.length,
                readers: rows.map((r) => ({
                    _id: r._id, name: r.name, role: r.role, photo: r.profileImage || '',
                    section: r.section || '', readAt: r.readAt,
                })),
            },
        });
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

const STAFF_ROLES = ['school_admin', 'teacher'];
const MAX_COMMENT = 2000;

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
        if (String(req.query.search || '').trim()) {
            params.push(like(req.query.search));
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
        // A parent reads the thread and writes nothing in it — not even under
        // a comment they wrote before it went read-only for them.
        const reader = req.userRole === 'parent';
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
                files: access.publicFiles(r.files),
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
                canEdit: mine && !reader,
                canDelete: (mine && !reader) || admin,
                canPin: pins && !r.parent,
                // Staff-only is the author's call, or an admin's, and only on
                // what staff wrote — a student's own comment is never hidden
                // from the student who wrote it.
                canHide: !r.parent && STAFF_ROLES.includes(r.authorRole) && (mine || admin),
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
    const bad = (message, status = 400) => {
        // A refused comment takes its attachments with it.
        access.discardUploads(req);
        return res.status(status).json({ success: false, message });
    };
    try {
        const doc = await loadDoc(req, res);
        if (!doc) { access.discardUploads(req); return; }

        // Words only (Nov 2026): no route takes a file with a comment any more,
        // so a comment is its text and nothing else.
        const body  = String(req.body?.body || '').trim();
        const files = [];
        if (!body) return bad('Write something first');
        if (body.length > MAX_COMMENT) return bad(`A comment can be up to ${MAX_COMMENT.toLocaleString('en-IN')} characters`);

        // `answered` is the comment actually being replied to; `root` is the
        // thread it sits in. Only one level: a reply to a reply joins the same
        // thread rather than starting a third tier nobody can read on a phone.
        let answered = null;
        let root = null;
        if (req.body.parent) {
            answered = isUuid(req.body.parent)
                ? await DocumentComment.findOne({ _id: req.body.parent, document: doc._id }).lean() : null;
            if (!answered || (!isStaff(req) && answered.visibility === 'staff')) {
                return bad('The comment being replied to is gone', 404);
            }
            root = answered.parent ? await DocumentComment.findById(answered.parent).lean() : answered;
            if (!root) return bad('The comment being replied to is gone', 404);
        }

        // A reply lives where its thread lives: inside a staff-only thread it
        // is staff-only whatever the composer was left on. It used to take the
        // composer's default — "Visible to All" — and reach the class as a
        // comment with no beginning.
        const visibility = root?.visibility === 'staff' ? 'staff'
            : (isStaff(req) && req.body.visibility === 'staff' ? 'staff' : 'all');

        const comment = await DocumentComment.create({
            document:   doc._id,
            school:     req.schoolId,
            author:     req.userId,
            authorRole: req.userRole,
            body,
            files,
            parent: root ? root._id : null,
            visibility,
        });

        const link = { type: 'documents.item', entityId: doc._id };
        const from = { school: req.schoolId, sender: req.userId, senderRole: req.userRole };

        if (root) {
            // The person answered, and whoever started the thread — never a
            // comment on a school-wide document to its 900 readers. Someone
            // who cannot see a staff-only reply is not told there is one.
            const told = [answered, root]
                .filter((c) => c && !c.isDeleted && String(c.author) !== String(req.userId))
                .filter((c) => visibility !== 'staff' || STAFF_ROLES.includes(c.authorRole))
                .map((c) => String(c.author));
            if (told.length) {
                notify({
                    ...from,
                    title: '💬 Reply to your comment',
                    body: `Your comment on "${doc.title}" has a reply.`,
                    recipients: [...new Set(told)],
                    link,
                });
            }
        } else if (!isStaff(req) && doc.uploadedBy) {
            // A question from a student reaches the person who shared the
            // document — nobody used to hear it had been asked.
            notify({
                ...from,
                title: '❓ Question on a document',
                body: `A ${req.userRole === 'parent' ? 'parent' : 'student'} has asked something on "${doc.title}".`,
                recipients: [doc.uploadedBy],
                link,
            });
        }

        const out = typeof comment.toObject === 'function' ? comment.toObject() : comment;
        res.status(201).json({ success: true, data: { ...out, files: access.publicFiles(out.files) } });
    } catch (e) {
        access.discardUploads(req);
        res.status(500).json({ success: false, message: e.message });
    }
};

/**
 * Edit your own words; pin a comment if you are an admin or shared the
 * document; keep a staff comment among staff if it is yours or you are an
 * admin.
 */
exports.updateComment = async (req, res) => {
    try {
        const c = isUuid(req.params.commentId)
            ? await DocumentComment.findOne({ _id: req.params.commentId, school: req.schoolId }) : null;
        if (!c || c.isDeleted) return res.status(404).json({ success: false, message: 'This comment was deleted' });
        const bad = (message, status = 403) => res.status(status).json({ success: false, message });

        if (req.body.isPinned !== undefined) {
            const doc = await Document.findOne({ _id: c.document, school: req.schoolId }).select('uploadedBy').lean();
            if (!canPinOn(req, doc)) return bad('Only the school office or the teacher who shared this document can do that');
            if (c.parent) return bad('Only the first comment of a thread can be pinned', 400);
        }
        if (req.body.visibility !== undefined) {
            // The sharing teacher could flip ANY comment to staff-only — a
            // student's question vanished from the student who asked it.
            if (!STAFF_ROLES.includes(c.authorRole)) {
                return bad('A student’s comment cannot be hidden from them — delete it if it should not be there');
            }
            if (!isAdmin(req) && String(c.author) !== String(req.userId)) {
                return bad('Only the person who wrote this, or the school office, can change who sees it');
            }
            if (c.parent) return bad('A reply is seen by whoever sees the comment it answers', 400);
        }

        if (req.body.body !== undefined) {
            if (String(c.author) !== String(req.userId)) return bad('You can only edit your own comment');
            const body = String(req.body.body).trim();
            if (!body && !c.files?.length) return bad('A comment cannot be emptied — delete it instead', 400);
            if (body.length > MAX_COMMENT) return bad(`A comment can be up to ${MAX_COMMENT.toLocaleString('en-IN')} characters`, 400);
            c.body = body;
            c.isEdited = true;
        }
        if (req.body.isPinned !== undefined) c.isPinned = !!req.body.isPinned;
        let moved = false;
        if (req.body.visibility !== undefined) {
            const to = req.body.visibility === 'staff' ? 'staff' : 'all';
            moved = to !== c.visibility;
            c.visibility = to;
        }

        await c.save();
        // The replies go where their thread goes.
        if (moved) {
            await pool.query(
                `UPDATE ${qt(DocumentComment)} SET "visibility" = $2, "updatedAt" = now() WHERE "parent" = $1`,
                [String(c._id), c.visibility],
            );
        }
        const out = typeof c.toObject === 'function' ? c.toObject() : c;
        res.json({ success: true, data: { ...out, files: access.publicFiles(out.files) } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteComment = async (req, res) => {
    try {
        const c = isUuid(req.params.commentId)
            ? await DocumentComment.findOne({ _id: req.params.commentId, school: req.schoolId }).lean() : null;
        const admin = isAdmin(req);
        if (!c || (c.isDeleted && !admin)) return res.status(404).json({ success: false, message: 'This comment was already deleted' });
        const mine = String(c.author) === String(req.userId);
        if (!mine && !admin) {
            return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
        }

        const T = qt(DocumentComment);
        // Attachments leave the disk with the words they were attached to.
        const gone = access.namesOf(c.files);
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
            const { rows } = await pool.query(
                `DELETE FROM ${T} WHERE "parent" = $1 RETURNING "files"`, [String(c._id)],
            );
            deletedReplies = rows.length;
            for (const r of rows) gone.push(...access.namesOf(r.files));
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
        access.removeUnreferenced(gone);
        res.json({ success: true, deletedReplies, kept });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleLike = async (req, res) => {
    try {
        if (!isUuid(req.params.commentId)) return res.status(404).json({ success: false, message: 'Comment not found' });
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
