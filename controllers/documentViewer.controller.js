'use strict';
/**
 * The shelf as everyone who is not an administrator sees it.
 *
 * Students, parents and teachers read the same documents through three
 * different questions — "what has been set for me", "what has been set for my
 * children", "what have I shared and what has been shared with me" — so the
 * shaping is one function and only the visibility rule differs.
 *
 * The parent case is the reason this file exists. A parent can have more than
 * one child, and their documents are not the same: a school-wide notice reaches
 * both, a class assignment reaches one. The old endpoint read
 * `parent.children[0]` and nothing else, so a second child's work was invisible
 * and nothing on the page said a second child existed. Every document now
 * carries `forChildren`, and each child's own submission travels with it.
 */

const Document           = require('../models/Document');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const DocumentCategory   = require('../models/DocumentCategory');
const DocumentRead       = require('../models/DocumentRead');
const StudentProfile     = require('../models/StudentProfile');
const ParentProfile      = require('../models/ParentProfile');
const ClassSection       = require('../models/ClassSection');
const Class              = require('../models/Class');
const AcademicYear       = require('../models/AcademicYear');
const User               = require('../models/User');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const pool               = require('../db/pool');
const { yearOrderSql } = require('../utils/listOrder');
const access             = require('../services/documentAccess');
const { isUuid, placeCte, REACH } = access;

const qt = (Model) => `"${Model.tableName}"`;
const ids = (list) => (list || []).map(String).filter(Boolean);

// ── Where one student sits ───────────────────────────────────────────────────

/**
 * Where a student sits today, in words — "Class 9 - A" under the page title.
 *
 * Only the label. Whether a document reaches a student is decided by where
 * they sat in THAT DOCUMENT'S academic year (services/documentAccess), which
 * this pointer cannot answer once a year has rolled over.
 */
async function reachOf(studentUserId) {
    const profile = await StudentProfile.findOne({ user: studentUserId }).lean();
    if (!profile?.currentSection) return { label: '', sectionId: null };
    const { rows } = await pool.query(
        `SELECT c."className" || ' - ' || s."sectionName" AS "label"
           FROM ${qt(ClassSection)} s JOIN ${qt(Class)} c ON c."_id" = s."class"
          WHERE s."_id" = $1`,
        [String(profile.currentSection)],
    );
    return { label: rows[0]?.label || '', sectionId: String(profile.currentSection) };
}

/**
 * The lateral join that says which of the students in `place` a row reaches,
 * as `reach.ids`. Goes after SELECT(…), which names the document `d` and its
 * year `ay`.
 */
const REACH_JOIN = `
    LEFT JOIN LATERAL (SELECT ${REACH} AS ids) reach ON true`;

// ── Reading the shelf ────────────────────────────────────────────────────────

/**
 * `reader` is the placeholder holding whoever is asking (`$4::uuid`), so each
 * row can say whether that person has opened it yet.
 */
const SELECT = (extra = '', reader = null) => `
  SELECT d."_id", d."title", d."description", d."category", d."docType", d."subject",
         d."targetType", d."targetClasses", d."targetSections", d."targetUsers",
         d."isAssignment", d."assignmentType", d."dueDate", d."allowSubmission",
         d."totalMarks", d."files", d."createdAt", d."updatedAt", d."academicYear", d."isArchived",
         u."_id" AS "uploaderId", u."name" AS "uploaderName",
         u."role" AS "uploaderRole", u."profileImage" AS "uploaderPhoto",
         ay."yearName" AS "academicYearName",
         cls.labels AS "classLabels", sec.labels AS "sectionLabels",
         ${reader ? 'rd."readAt"' : 'NULL::timestamptz'} AS "readAt"${extra}
    FROM ${qt(Document)} d
    LEFT JOIN ${qt(User)} u          ON u."_id"  = d."uploadedBy"
    ${reader ? `LEFT JOIN ${qt(DocumentRead)} rd ON rd."document" = d."_id" AND rd."user" = ${reader}` : ''}
    LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = d."academicYear"
    LEFT JOIN LATERAL (
      SELECT array_agg(x.label ORDER BY x.ord) AS labels FROM (
        SELECT c."classNumber" AS ord, c."className" AS label
          FROM jsonb_array_elements_text(COALESCE(d."targetClasses", '[]'::jsonb)) t(id)
          JOIN ${qt(Class)} c ON c."_id" = t.id::uuid) x) cls ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(x.label ORDER BY x.ord) AS labels FROM (
        SELECT c."classNumber" AS ord, c."className" || ' - ' || s."sectionName" AS label
          FROM jsonb_array_elements_text(COALESCE(d."targetSections", '[]'::jsonb)) t(id)
          JOIN ${qt(ClassSection)} s ON s."_id" = t.id::uuid
          JOIN ${qt(Class)} c        ON c."_id" = s."class") x) sec ON true`;

/** Who a document went to, said the way a reader would say it. */
function sharedWith(r) {
    switch (r.targetType) {
        case 'whole_school':      return { icon: 'school', label: 'Whole School' };
        case 'all_teachers':      return { icon: 'users',  label: 'All Teachers' };
        case 'specific_teachers': return { icon: 'user',   label: 'Selected teachers' };
        case 'class':             return { icon: 'layers', label: (r.classLabels || []).join(', ') || 'A class' };
        case 'class_sections':    return { icon: 'layers', label: (r.sectionLabels || []).join(', ') || 'A section' };
        default:                  return { icon: 'files',  label: r.targetType || '—' };
    }
}

function shapeDoc(r) {
    const files = access.publicFiles(r.files);
    return {
        _id: r._id,
        title: r.title,
        description: r.description || '',
        category: r.category || '',
        docType: r.docType || 'other',
        subject: r.subject || '',
        targetType: r.targetType,
        // The ids as well as the sentence: the sentence is for reading, and the
        // teacher's edit form needs the ids to tick the sections back on. Left
        // out, the form opened with nothing selected and then refused to save.
        targetSections: ids(r.targetSections),
        targetClasses:  ids(r.targetClasses),
        sharedWith: sharedWith(r),
        isAssignment: !!r.isAssignment,
        assignmentType: r.assignmentType || null,
        allowSubmission: !!r.allowSubmission,
        dueDate: r.dueDate,
        totalMarks: r.totalMarks ?? null,
        files,
        fileCount: files.length,
        fileSize: files.reduce((n, f) => n + (Number(f.fileSize) || 0), 0),
        // Opened by whoever is asking. Their own upload is never "unread".
        isRead: !!r.readAt,
        isArchived: !!r.isArchived,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        academicYear: r.academicYear,
        academicYearName: r.academicYearName || null,
        uploadedBy: r.uploaderId
            ? { _id: r.uploaderId, name: r.uploaderName, role: r.uploaderRole, photo: r.uploaderPhoto }
            : null,
    };
}

/**
 * Where one assignment stands for one person.
 *
 * `pending` and `missed` are the same absence of a submission — only the due
 * date tells them apart, and that difference is the whole reason a student
 * opens this page.
 */
function stateOf(doc, submission) {
    if (!doc.isAssignment) return null;
    // Marked, whether or not anything was handed in through the app — work
    // done on paper can be marked too.
    if (submission?.marks != null) return 'marked';
    if (submission?.status === 'submitted' || submission?.status === 'late') return submission.status;
    // Nothing handed in and nothing can be: not "to do" and not "missed",
    // neither of which the student could act on.
    if (!doc.allowSubmission) return 'closed';
    if (doc.dueDate && Date.now() > new Date(doc.dueDate).getTime()) return 'missed';
    return 'pending';
}

/** A submission as its owner (or their parent) reads it. */
const shapeSub = (sub, withFiles = true) => (sub ? {
    _id: sub._id, status: sub.status, submittedAt: sub.submittedAt,
    marks: sub.marks ?? null, feedback: sub.feedback || '', reviewedAt: sub.reviewedAt || null,
    questionScores: Array.isArray(sub.questionScores) ? sub.questionScores : [],
    ...(withFiles ? { files: access.publicFiles(sub.files) } : {}),
} : null);

/** The school's filing labels, for the category dropdown. */
async function categoriesOf(schoolId) {
    const { rows } = await pool.query(
        `SELECT DISTINCT "name" FROM ${qt(DocumentCategory)}
          WHERE "school" = $1 AND COALESCE("isActive", true) ORDER BY "name"`,
        [String(schoolId)],
    );
    return rows.map((r) => r.name);
}

/**
 * The academic years on record, newest first, and which one is active.
 *
 * Every viewer defaults to the active year: a shelf that shows four years of
 * notices at once is a shelf nobody reads to the bottom of.
 */
async function yearsOf(schoolId) {
    const { rows } = await pool.query(
        `SELECT "_id", "yearName", "status" FROM ${qt(AcademicYear)}
          WHERE "school" = $1 ORDER BY ${yearOrderSql()}`,
        [String(schoolId)],
    );
    return rows.map((r) => ({ _id: r._id, name: r.yearName, status: r.status }));
}

/** `?year=all` reads everything; anything else is one year, defaulting to the active one. */
function yearClause(req, years, params) {
    if (req.query.year === 'all') return '';
    const wanted = req.query.year
        ? (isUuid(req.query.year) ? years.find((y) => String(y._id) === String(req.query.year)) : null)
        : years.find((y) => y.status === 'active');
    if (!wanted) return '';
    params.push(String(wanted._id));
    // Documents filed before the year column existed carry none; they would
    // otherwise vanish from every viewer at once.
    return ` AND (d."academicYear" = $${params.length}::uuid OR d."academicYear" IS NULL)`;
}

// ── Student ──────────────────────────────────────────────────────────────────

exports.studentGetDocuments = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const [reach, years, categories] = await Promise.all([
            reachOf(req.userId), yearsOf(school), categoriesOf(school),
        ]);

        const params = [school, [String(req.userId)], String(req.userId)];
        const year   = yearClause(req, years, params);

        const { rows } = await pool.query(
            `WITH ${placeCte('$2')}
             ${SELECT('', '$3::uuid')}
             ${REACH_JOIN}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)${year}
                AND cardinality(reach.ids) > 0
              ORDER BY d."createdAt" DESC`,
            params,
        );

        const docs = rows.map(shapeDoc);
        const subs = await AssignmentSubmission.find({
            student: req.userId,
            document: { $in: docs.filter((d) => d.isAssignment).map((d) => d._id) },
        }).lean();
        const byDoc = Object.fromEntries(subs.map((s) => [String(s.document), s]));

        const data = docs.map((d) => {
            const sub = byDoc[String(d._id)] || null;
            return { ...d, mySubmission: shapeSub(sub), state: stateOf(d, sub) };
        });

        res.json({
            success: true,
            data,
            who: { label: reach.label },
            counts: countsOf(data),
            categories,
            years,
            year: req.query.year || null,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** The tab strip's figures, over whatever the viewer can see. */
function countsOf(docs, pick = (d) => d) {
    const state = (d) => pick(d)?.state;
    return {
        all:         docs.length,
        assignments: docs.filter((d) => d.isAssignment).length,
        notices:     docs.filter((d) => ['notice', 'circular'].includes(d.docType)).length,
        study:       docs.filter((d) => d.docType === 'study_material').length,
        pending:     docs.filter((d) => state(d) === 'pending').length,
        missed:      docs.filter((d) => state(d) === 'missed').length,
        submitted:   docs.filter((d) => ['submitted', 'late', 'marked'].includes(state(d))).length,
        marked:      docs.filter((d) => state(d) === 'marked').length,
        unread:      docs.filter((d) => !d.isRead).length,
    };
}

// ── Parent ───────────────────────────────────────────────────────────────────

/**
 * Every child's documents, in one read, each tagged with whose it is.
 *
 * The alternative — one request per child — makes the switch at the top of the
 * page a network round trip, and a parent comparing two children's homework
 * flips between them constantly.
 */
exports.parentGetDocuments = async (req, res) => {
    try {
        const school   = String(req.schoolId);
        // Both links a parent can be joined to a child by, re-read as students
        // of this school (services/parentChildren) — the profile's own list
        // alone missed a child linked from the student's side.
        const childIds = await access.childIds(req.userId, school);

        const [years, categories] = await Promise.all([yearsOf(school), categoriesOf(school)]);

        if (!childIds.length) {
            return res.json({
                success: true,
                data: [],
                children: [],
                counts: countsOf([]),
                perChild: {},
                categories,
                years,
                year: req.query.year || null,
            });
        }

        // Who they are, and where each one sits today.
        const people = await pool.query(
            `SELECT u."_id", u."name", u."profileImage",
                    c."className" || ' - ' || s."sectionName" AS "className",
                    sp."rollNumber"
               FROM ${qt(User)} u
               LEFT JOIN ${qt(StudentProfile)} sp ON sp."user" = u."_id"
               LEFT JOIN ${qt(ClassSection)} s    ON s."_id"   = sp."currentSection"
               LEFT JOIN ${qt(Class)} c           ON c."_id"   = s."class"
              WHERE u."_id" = ANY($1::uuid[])
              ORDER BY u."name"`,
            [childIds],
        );
        const children = people.rows.map((r) => ({
            _id: r._id,
            name: r.name,
            photo: r.profileImage || '',
            className: r.className || '',
            rollNumber: r.rollNumber || '',
        }));

        const params = [school, childIds, String(req.userId)];
        const year   = yearClause(req, years, params);

        // One read for all of them: each row says which children it reaches.
        const { rows } = await pool.query(
            `WITH ${placeCte('$2')}
             ${SELECT(', reach.ids AS "reaches"', '$3::uuid')}
             ${REACH_JOIN}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)${year}
                AND cardinality(reach.ids) > 0
              ORDER BY d."createdAt" DESC`,
            params,
        );

        const docs = rows.map((r) => ({ raw: r, doc: shapeDoc(r) }));

        // Every child's submission against every assignment on the shelf.
        const subs = await AssignmentSubmission.find({
            student: { $in: childIds },
            document: { $in: docs.filter((d) => d.doc.isAssignment).map((d) => d.doc._id) },
        }).lean();
        const subFor = {};
        for (const s of subs) (subFor[String(s.document)] ||= {})[String(s.student)] = s;

        const data = docs.map(({ raw, doc }) => {
            const forChildren = childIds.filter((id) => (raw.reaches || []).includes(id));
            // One entry per child the document actually reaches, so the page can
            // say "Aarav submitted, Diya has not" without asking again.
            const perChild = Object.fromEntries(forChildren.map((id) => {
                const sub = subFor[String(doc._id)]?.[id] || null;
                return [id, {
                    state: stateOf(doc, sub),
                    submittedAt: sub?.submittedAt || null,
                    marks: sub?.marks ?? null,
                    feedback: sub?.feedback || '',
                }];
            }));
            return { ...doc, forChildren, perChild };
        });

        res.json({
            success: true,
            data,
            children,
            // Across all the children at once there is no single state, so a
            // document counts as still-to-do if ANY of them still owes it —
            // which is what a parent scanning the tile is asking.
            counts: countsOf(data, (d) => ({ state: worstState(d.perChild) })),
            // Per child, so the switch can carry a number without the page
            // recounting the whole shelf on every render.
            perChild: Object.fromEntries(children.map((c) => {
                const mine = data.filter((d) => d.forChildren.includes(String(c._id)));
                return [c._id, countsOf(mine, (d) => d.perChild[String(c._id)])];
            })),
            categories,
            years,
            year: req.query.year || null,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** The most urgent thing any child still owes on one document. */
const STATE_RANK = { missed: 5, pending: 4, submitted: 3, late: 3, marked: 2, closed: 1 };

function worstState(perChild) {
    let best = null;
    for (const v of Object.values(perChild || {})) {
        if (!v?.state) continue;
        if (!best || STATE_RANK[v.state] > STATE_RANK[best]) best = v.state;
    }
    return best;
}

// ── Teacher ──────────────────────────────────────────────────────────────────

// The sections a teacher stands in front of — services/documentAccess, where
// the route guards and the file rule read the same answer.
const teacherReach = access.teacherReach;

exports.teacherReach = teacherReach;

exports.teacherGetDocuments = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const me     = String(req.userId);
        const [reach, years, categories] = await Promise.all([
            teacherReach(me, school), yearsOf(school), categoriesOf(school),
        ]);

        // `me` twice on purpose: Postgres infers ONE type per placeholder, and
        // this id is compared as a uuid in one arm and as a jsonb key — which is
        // text — in another. Sharing a placeholder makes the second arm fail
        // with "operator does not exist: jsonb ? uuid".
        const params = [school, me, reach.sections, reach.classes, me];
        const year   = yearClause(req, years, params);

        const { rows } = await pool.query(
            `${SELECT(`,
         COALESCE(sub."n", 0)::int   AS "submissionCount",
         COALESCE(sub."marked", 0)::int AS "markedCount"`, '$2::uuid')}
             LEFT JOIN LATERAL (
               -- Handed in, and of those the ones that have been looked at:
               -- given marks, or — where the assignment has no marks to give
               -- — given feedback. Counting marks alone left every unmarked
               -- kind of work "to mark" for ever.
               SELECT count(*) FILTER (WHERE a."status" IN ('submitted', 'late'))::int AS "n",
                      count(*) FILTER (WHERE a."status" IN ('submitted', 'late')
                                         AND (a."marks" IS NOT NULL OR a."reviewedAt" IS NOT NULL))::int AS "marked"
                 FROM ${qt(AssignmentSubmission)} a
                WHERE a."document" = d."_id"
             ) sub ON true
              -- Their own stay on their shelf when the office puts them away,
              -- marked as archived; everyone else's leave it.
              WHERE d."school" = $1
                AND (NOT COALESCE(d."isArchived", false) OR d."uploadedBy" = $2::uuid)${year}
                AND ( d."uploadedBy" = $2::uuid
                   OR d."targetType" IN ('all_teachers', 'whole_school')
                   OR (d."targetType" = 'specific_teachers' AND d."targetUsers"    ? $5)
                   OR (d."targetType" = 'class_sections'    AND d."targetSections" ?| $3::text[])
                   -- A document set for a whole class is also for the people who
                   -- teach it; the old filter left that case out entirely.
                   OR (d."targetType" = 'class'             AND d."targetClasses"  ?| $4::text[]) )
              ORDER BY d."createdAt" DESC`,
            params,
        );

        const data = rows.map((r) => ({
            ...shapeDoc(r),
            mine: String(r.uploaderId) === me,
            isRead: !!r.readAt || String(r.uploaderId) === me,
            submissionCount: r.submissionCount || 0,
            markedCount: r.markedCount || 0,
        }));

        const mine = data.filter((d) => d.mine);
        res.json({
            success: true,
            data,
            sections: reach.list,
            counts: {
                ...countsOf(data),
                mine: mine.length,
                shared: data.length - mine.length,
                unread: data.filter((d) => !d.isRead).length,
                // Work waiting on this teacher: their own assignments with
                // something handed in that nobody has marked.
                toMark: mine.reduce((n, d) => n + Math.max(0, d.submissionCount - d.markedCount), 0),
            },
            categories,
            years,
            year: req.query.year || null,
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Read marks ───────────────────────────────────────────────────────────────

/**
 * "I have opened these."
 *
 * One call for one document or for the whole shelf — the list posts the ids it
 * is showing. Written as a single INSERT … WHERE NOT EXISTS so opening the same
 * notice twice, or from two tabs at once, leaves one row. Ids from another
 * school are dropped by the join rather than refused: there is nothing to tell
 * the caller about a document they cannot see.
 */
exports.markRead = async (req, res) => {
    try {
        const wanted = ids(req.params.id ? [req.params.id] : req.body?.ids)
            .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
            .slice(0, 2000);
        if (!wanted.length) return res.json({ success: true, marked: 0 });

        const { rowCount } = await pool.query(
            `INSERT INTO ${qt(DocumentRead)} ("_id", "document", "user", "school", "readAt", "createdAt", "updatedAt")
             SELECT gen_random_uuid(), d."_id", $2::uuid, d."school", now(), now(), now()
               FROM ${qt(Document)} d
              WHERE d."_id" = ANY($1::uuid[]) AND d."school" = $3
                AND NOT EXISTS (
                  SELECT 1 FROM ${qt(DocumentRead)} r
                   WHERE r."document" = d."_id" AND r."user" = $2::uuid)
             ON CONFLICT DO NOTHING`,
            [wanted, String(req.userId), String(req.schoolId)],
        );
        res.json({ success: true, marked: rowCount });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── A student reading the discussion ─────────────────────────────────────────

/**
 * Route middleware: the document must be one this student can see.
 *
 * The same reach the list is built from, so a document that is on a student's
 * shelf can always be opened and one that is not never can — whatever id is
 * put in the address.
 */
exports.studentDocumentAccess = async (req, res, next) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!doc || doc.isArchived) return res.status(404).json({ success: false, message: 'Document not found' });
        if ((await access.studentsReached(doc._id, [req.userId])).length) return next();
        return res.status(403).json({ success: false, message: 'This document was not shared with you' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};
