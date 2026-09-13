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
const StudentProfile     = require('../models/StudentProfile');
const ParentProfile      = require('../models/ParentProfile');
const ClassSection       = require('../models/ClassSection');
const Class              = require('../models/Class');
const AcademicYear       = require('../models/AcademicYear');
const User               = require('../models/User');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const pool               = require('../db/pool');

const qt = (Model) => `"${Model.tableName}"`;
const ids = (list) => (list || []).map(String).filter(Boolean);

// ── Where one student sits ───────────────────────────────────────────────────

/**
 * The classes and sections a document may be addressed to for this student to
 * see it.
 *
 * Expanded across academic years on (class number, section name) rather than
 * matched on the stored ids: a class row exists once per year, so a document
 * filed against last year's "Class 9 - A" is still this year's Class 9 - A to
 * everyone reading it. This is the same rule the admin roster uses, so the two
 * always agree about who a document reached.
 */
async function reachOf(studentUserId, schoolId) {
    const profile = await StudentProfile.findOne({ user: studentUserId }).lean();
    const empty = { classes: [], sections: [], label: '', sectionId: null };
    if (!profile?.currentSection) return empty;

    const { rows } = await pool.query(
        `WITH me AS (
           SELECT c."classNumber", s."sectionName", c."className"
             FROM ${qt(ClassSection)} s
             JOIN ${qt(Class)} c ON c."_id" = s."class"
            WHERE s."_id" = $1
         )
         SELECT
           (SELECT array_agg(c2."_id")
              FROM ${qt(Class)} c2, me
             WHERE c2."school" = $2 AND c2."classNumber" = me."classNumber")        AS "classes",
           (SELECT array_agg(s2."_id")
              FROM ${qt(ClassSection)} s2
              JOIN ${qt(Class)} c3 ON c3."_id" = s2."class", me
             WHERE s2."school" = $2
               AND c3."classNumber" = me."classNumber"
               AND s2."sectionName" = me."sectionName")                             AS "sections",
           (SELECT me."className" || ' - ' || me."sectionName" FROM me)             AS "label"`,
        [String(profile.currentSection), String(schoolId)],
    );
    const r = rows[0] || {};
    return {
        classes:  ids(r.classes),
        sections: ids(r.sections),
        label:    r.label || '',
        sectionId: String(profile.currentSection),
    };
}

// ── Reading the shelf ────────────────────────────────────────────────────────

const SELECT = (extra = '') => `
  SELECT d."_id", d."title", d."description", d."category", d."docType", d."subject",
         d."targetType", d."targetClasses", d."targetSections", d."targetUsers",
         d."isAssignment", d."assignmentType", d."dueDate", d."allowSubmission",
         d."totalMarks", d."files", d."createdAt", d."updatedAt", d."academicYear",
         u."_id" AS "uploaderId", u."name" AS "uploaderName",
         u."role" AS "uploaderRole", u."profileImage" AS "uploaderPhoto",
         ay."yearName" AS "academicYearName",
         cls.labels AS "classLabels", sec.labels AS "sectionLabels"${extra}
    FROM ${qt(Document)} d
    LEFT JOIN ${qt(User)} u          ON u."_id"  = d."uploadedBy"
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
    const files = Array.isArray(r.files) ? r.files : [];
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
    if (submission?.status === 'submitted' || submission?.status === 'late') {
        return submission.marks != null ? 'marked' : submission.status;
    }
    if (doc.dueDate && Date.now() > new Date(doc.dueDate).getTime()) return 'missed';
    return 'pending';
}

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
          WHERE "school" = $1 ORDER BY "startDate" DESC NULLS LAST`,
        [String(schoolId)],
    );
    return rows.map((r) => ({ _id: r._id, name: r.yearName, status: r.status }));
}

/** `?year=all` reads everything; anything else is one year, defaulting to the active one. */
function yearClause(req, years, params) {
    if (req.query.year === 'all') return '';
    const wanted = req.query.year
        ? years.find((y) => String(y._id) === String(req.query.year))
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
            reachOf(req.userId, school), yearsOf(school), categoriesOf(school),
        ]);

        const params = [school, reach.classes, reach.sections];
        const year   = yearClause(req, years, params);

        const { rows } = await pool.query(
            `${SELECT()}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)${year}
                AND ( d."targetType" = 'whole_school'
                   OR (d."targetType" = 'class'          AND d."targetClasses"  ?| $2::text[])
                   OR (d."targetType" = 'class_sections' AND d."targetSections" ?| $3::text[]) )
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
            return {
                ...d,
                mySubmission: sub && {
                    _id: sub._id, status: sub.status, submittedAt: sub.submittedAt,
                    marks: sub.marks, feedback: sub.feedback,
                    files: sub.files || [], reviewedAt: sub.reviewedAt,
                },
                state: stateOf(d, sub),
            };
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
        const school  = String(req.schoolId);
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childIds = ids(parent?.children?.length ? parent.children : [parent?.student]);

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

        // Who they are, and where each one sits.
        const [people, reaches] = await Promise.all([
            pool.query(
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
            ),
            Promise.all(childIds.map((id) => reachOf(id, school))),
        ]);

        const reachOfChild = Object.fromEntries(childIds.map((id, i) => [id, reaches[i]]));
        const children = people.rows.map((r) => ({
            _id: r._id,
            name: r.name,
            photo: r.profileImage || '',
            className: r.className || reachOfChild[String(r._id)]?.label || '',
            rollNumber: r.rollNumber || '',
        }));

        // The union of every child's reach — one query rather than one per child.
        const allClasses  = [...new Set(reaches.flatMap((r) => r.classes))];
        const allSections = [...new Set(reaches.flatMap((r) => r.sections))];

        const params = [school, allClasses, allSections];
        const year   = yearClause(req, years, params);

        const { rows } = await pool.query(
            `${SELECT()}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)${year}
                AND ( d."targetType" = 'whole_school'
                   OR (d."targetType" = 'class'          AND d."targetClasses"  ?| $2::text[])
                   OR (d."targetType" = 'class_sections' AND d."targetSections" ?| $3::text[]) )
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

        const reaches_ = (raw, reach) => {
            if (raw.targetType === 'whole_school') return true;
            if (raw.targetType === 'class')          return ids(raw.targetClasses).some((c) => reach.classes.includes(c));
            if (raw.targetType === 'class_sections') return ids(raw.targetSections).some((s) => reach.sections.includes(s));
            return false;
        };

        const data = docs.map(({ raw, doc }) => {
            const forChildren = childIds.filter((id) => reaches_(raw, reachOfChild[id]));
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
const STATE_RANK = { missed: 4, pending: 3, submitted: 2, late: 2, marked: 1 };

function worstState(perChild) {
    let best = null;
    for (const v of Object.values(perChild || {})) {
        if (!v?.state) continue;
        if (!best || STATE_RANK[v.state] > STATE_RANK[best]) best = v.state;
    }
    return best;
}

// ── Teacher ──────────────────────────────────────────────────────────────────

/**
 * The sections a teacher stands in front of.
 *
 * Two different answers come out of this, and conflating them is a bug either
 * way:
 *
 *   • `sections` / `classes` — everything, across every year on record. This is
 *     what decides whether a teacher may READ a document, and a document filed
 *     under last year is still theirs to open.
 *   • `postable` / `list` — only this year's, one row per section. A class row
 *     exists once per academic year, so a teacher of "Class 9 - A" holds four
 *     of them; offering all four in a picker asks them to choose between four
 *     chips with the same name, and sharing to a closed year reaches nobody.
 *
 * With no year marked active the two collapse — a school still setting itself
 * up must not be locked out of sharing.
 */
async function teacherReach(teacherId, schoolId) {
    const { rows } = await pool.query(
        `SELECT DISTINCT s."_id" AS "section", s."class",
                c."className" || ' - ' || s."sectionName" AS "label",
                c."classNumber", s."sectionName",
                (ay."status" = 'active') AS "current"
           FROM ${qt(ClassSection)} s
           JOIN ${qt(Class)} c            ON c."_id"  = s."class"
           LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = c."academicYear"
          WHERE s."school" = $1
            AND ( s."classTeacher" = $2
               OR s."substituteTeacher" = $2
               OR s."_id" IN (SELECT "section" FROM ${qt(SectionSubjectTeacher)} WHERE "teacher" = $2) )
          ORDER BY c."classNumber", "label"`,
        [String(schoolId), String(teacherId)],
    );

    const current = rows.filter((r) => r.current);
    // One chip per section name even so: two rows of the same year would be a
    // data fault, and a duplicate chip is unpickable either way.
    const pick = [];
    const seen = new Set();
    for (const r of (current.length ? current : rows)) {
        if (seen.has(r.label)) continue;
        seen.add(r.label);
        pick.push(r);
    }

    return {
        sections: ids(rows.map((r) => r.section)),
        classes:  [...new Set(ids(rows.map((r) => r.class)))],
        postable: ids(pick.map((r) => r.section)),
        list:     pick.map((r) => ({ _id: r.section, label: r.label })),
    };
}

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
         COALESCE(sub."marked", 0)::int AS "markedCount"`)}
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS "n",
                      count(*) FILTER (WHERE a."marks" IS NOT NULL)::int AS "marked"
                 FROM ${qt(AssignmentSubmission)} a
                WHERE a."document" = d."_id"
             ) sub ON true
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)${year}
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
