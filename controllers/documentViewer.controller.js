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
const yearScope = require('../services/yearScope');
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
         d."isDraft", d."questions",
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
        // Their own copy, not shared yet (only its maker ever gets one here).
        isDraft: !!r.isDraft,
        // The question breakdown travels with the row: the teacher's edit form
        // opens from it, and a field a row leaves out is one a save would blank.
        questions: Array.isArray(r.questions) ? r.questions : [],
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
        `SELECT "_id", "yearName", ${yearScope.yearStatus()} AS "status" FROM ${qt(AcademicYear)}
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

// ── One shelf, a page at a time ──────────────────────────────────────────────
//
// A reader's shelf used to travel whole: every document of the year, each with
// its files and the class names behind its audience, and the browser did the
// tabs, the search and the counting. Now it is read in two steps.
//
//   1. THE WHOLE SHELF, LIGHT — one narrow row per document (LIGHT below): what
//      the tabs, the search, the sort and the figures are worked out from. The
//      figures describe the whole shelf, so this step cannot be paged away.
//   2. THE PAGE, IN FULL — only the rows being shown are read with their files
//      and audience labels (fullByIds).
//
// `page` / `limit` ask for a page. A caller that sends neither — a phone app
// installed before this — still gets the whole shelf, as it always did.

const LIGHT = (extra = '', reader = null) => `
  SELECT d."_id", d."title", d."description", d."category", d."docType",
         d."isAssignment", d."dueDate", d."allowSubmission", d."createdAt",
         d."uploadedBy" AS "uploaderId", u."name" AS "uploaderName",
         ${reader ? 'rd."readAt"' : 'NULL::timestamptz'} AS "readAt"${extra}
    FROM ${qt(Document)} d
    LEFT JOIN ${qt(User)} u          ON u."_id"  = d."uploadedBy"
    ${reader ? `LEFT JOIN ${qt(DocumentRead)} rd ON rd."document" = d."_id" AND rd."user" = ${reader}` : ''}
    LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = d."academicYear"`;

/** The rows of one page, in full, keyed by id. */
async function fullByIds(docIds, readerId, schoolId) {
    if (!docIds.length) return {};
    const { rows } = await pool.query(
        `${SELECT('', '$2::uuid')} WHERE d."_id" = ANY($1::uuid[]) AND d."school" = $3`,
        [docIds.map(String), String(readerId), String(schoolId)],
    );
    return Object.fromEntries(rows.map((r) => [String(r._id), r]));
}

const TAB_TYPES = { notices: ['notice', 'circular'], study: ['study_material'] };

/**
 * The filter bar, applied to light rows — the same rules the pages used to
 * apply in the browser. The assignments tab is the flag rather than the type:
 * study material students still hand in is an assignment to whoever must do it.
 */
function narrow(list, q, stateOf_ = (d) => d.state) {
    const term = String(q.search || '').trim().toLowerCase();
    return list.filter((d) => {
        if (q.tab === 'assignments' && !d.isAssignment) return false;
        if (TAB_TYPES[q.tab] && !TAB_TYPES[q.tab].includes(d.docType)) return false;
        if (q.category && d.category !== q.category) return false;
        if (q.state && stateOf_(d) !== q.state) return false;
        if (term && !`${d.title} ${d.description || ''} ${d.category || ''} ${d.uploaderName || ''}`
            .toLowerCase().includes(term)) return false;
        return true;
    });
}

function order(list, sort) {
    const byDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
    return [...list].sort((a, b) => {
        switch (sort) {
            case 'oldest': return -byDate(a, b);
            case 'title':  return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
            // No due date sorts last — a notice is not "due immediately".
            case 'due': {
                const av = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
                const bv = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
                return (av === bv ? 0 : av < bv ? -1 : 1) || byDate(a, b);
            }
            default: return byDate(a, b);
        }
    });
}

/** The page asked for — or everything, for a caller that asked for no page. */
function pageOf(list, q) {
    const paged = q.page !== undefined || q.limit !== undefined;
    if (!paged) return { rows: list, meta: { total: list.length, page: 1, pages: 1, limit: list.length } };
    const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit) || 30)));
    const pages = Math.max(1, Math.ceil(list.length / limit));
    const page  = Math.min(pages, Math.max(1, Math.floor(Number(q.page) || 1)));
    return { rows: list.slice((page - 1) * limit, page * limit), meta: { total: list.length, page, pages, limit } };
}

const tabCountsOf = (list) => ({
    all:         list.length,
    assignments: list.filter((d) => d.isAssignment).length,
    notices:     list.filter((d) => TAB_TYPES.notices.includes(d.docType)).length,
    study:       list.filter((d) => TAB_TYPES.study.includes(d.docType)).length,
});

/** What "mark all as read" acts on: everything unread under the filters, not one page of it. */
const unreadIdsOf = (list) => list.filter((d) => !d.isRead).map((d) => d._id).slice(0, 2000);

const lightRow = (r) => ({
    _id: r._id, title: r.title, description: r.description || '', category: r.category || '',
    docType: r.docType || 'other', isAssignment: !!r.isAssignment, dueDate: r.dueDate,
    allowSubmission: !!r.allowSubmission, createdAt: r.createdAt,
    uploaderId: r.uploaderId, uploaderName: r.uploaderName || '', isRead: !!r.readAt,
});

// ── Student ──────────────────────────────────────────────────────────────────

exports.studentGetDocuments = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const me     = String(req.userId);
        const [reach, years, categories] = await Promise.all([
            reachOf(me), yearsOf(school), categoriesOf(school),
        ]);

        const params = [school, [me], me];
        const year   = yearClause(req, years, params);
        const { rows } = await pool.query(
            `WITH ${placeCte('$2')}
             ${LIGHT('', '$3::uuid')}
             ${REACH_JOIN}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)
                AND NOT COALESCE(d."isDraft", false)${year}
                AND cardinality(reach.ids) > 0`,
            params,
        );

        const withState = async (list) => {
            const subs = await AssignmentSubmission.find({
                student: me, document: { $in: list.filter((d) => d.isAssignment).map((d) => d._id) },
            }).lean();
            const byDoc = Object.fromEntries(subs.map((s) => [String(s.document), s]));
            return list.map((d) => {
                const sub = byDoc[String(d._id)] || null;
                return { ...d, sub, state: stateOf(d, sub) };
            });
        };
        const shelf = await withState(rows.map(lightRow));
        const shape = (full) => (i) => ({ ...shapeDoc(full[String(i._id)]), mySubmission: shapeSub(i.sub), state: i.state });

        const filtered = order(narrow(shelf, req.query), req.query.sort);
        const { rows: slice, meta } = pageOf(filtered, req.query);
        const full = await fullByIds(slice.map((i) => i._id), me, school);

        // One document asked for by name — a notification's — whatever year it
        // is filed under and whatever the filters are showing.
        let focused = null;
        if (isUuid(req.query.focus)) {
            let item = shelf.find((i) => String(i._id) === req.query.focus);
            if (!item) {
                const f = await fullByIds([req.query.focus], me, school);
                const r = f[req.query.focus];
                if (r && !r.isArchived && (await access.studentsReached(r._id, [me])).length) {
                    [item] = await withState([{ ...lightRow(r), isAssignment: !!r.isAssignment }]);
                }
            }
            if (item) focused = shape(await fullByIds([item._id], me, school))(item);
        }

        res.json({
            success: true,
            data: slice.map(shape(full)),
            ...meta,
            focused,
            who: { label: reach.label },
            counts: countsOf(shelf),
            unreadIds: unreadIdsOf(filtered),
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
 * `child` narrows the list to one of them; the figures for each child travel
 * with every answer, so the switch at the top of the page carries its numbers
 * without asking again.
 */
exports.parentGetDocuments = async (req, res) => {
    try {
        const school   = String(req.schoolId);
        const me       = String(req.userId);
        // Both links a parent can be joined to a child by, re-read as students
        // of this school (services/parentChildren) — the profile's own list
        // alone missed a child linked from the student's side.
        const childIds = await access.childIds(me, school);

        const [years, categories] = await Promise.all([yearsOf(school), categoriesOf(school)]);

        if (!childIds.length) {
            return res.json({
                success: true, data: [], total: 0, page: 1, pages: 1, limit: 0, focused: null,
                children: [], counts: countsOf([]), perChild: {}, unreadIds: [],
                categories, years, year: req.query.year || null,
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

        const params = [school, childIds, me];
        const year   = yearClause(req, years, params);

        // One read for all of them: each row says which children it reaches.
        const { rows } = await pool.query(
            `WITH ${placeCte('$2')}
             ${LIGHT(', reach.ids AS "reaches"', '$3::uuid')}
             ${REACH_JOIN}
              WHERE d."school" = $1 AND NOT COALESCE(d."isArchived", false)
                AND NOT COALESCE(d."isDraft", false)${year}
                AND cardinality(reach.ids) > 0`,
            params,
        );

        // Every child's standing on every assignment on the shelf.
        const perChildOf = async (list) => {
            const subs = await AssignmentSubmission.find({
                student: { $in: childIds },
                document: { $in: list.filter((d) => d.isAssignment).map((d) => d._id) },
            }).lean();
            const subFor = {};
            for (const s of subs) (subFor[String(s.document)] ||= {})[String(s.student)] = s;
            return list.map((d) => {
                const forChildren = childIds.filter((id) => (d.reaches || []).includes(id));
                // One entry per child the document actually reaches, so the page
                // can say "Aarav submitted, Diya has not" without asking again.
                const perChild = Object.fromEntries(forChildren.map((id) => {
                    const sub = subFor[String(d._id)]?.[id] || null;
                    return [id, {
                        state: stateOf(d, sub),
                        submittedAt: sub?.submittedAt || null,
                        marks: sub?.marks ?? null,
                        feedback: sub?.feedback || '',
                    }];
                }));
                return { ...d, forChildren, perChild };
            });
        };
        const shelf = await perChildOf(rows.map((r) => ({ ...lightRow(r), reaches: r.reaches || [] })));
        const shape = (full) => (i) => ({ ...shapeDoc(full[String(i._id)]), forChildren: i.forChildren, perChild: i.perChild });

        // One child's shelf, or everyone's. Across all of them there is no
        // single state, so a document stands where its most urgent child does —
        // which is what a parent pressing "Still to do" is asking.
        const child  = childIds.includes(String(req.query.child || '')) ? String(req.query.child) : '';
        const scoped = child ? shelf.filter((d) => d.forChildren.includes(child)) : shelf;
        const stand  = (d) => (child ? d.perChild[child]?.state : worstState(d.perChild));

        const filtered = order(narrow(scoped, req.query, stand), req.query.sort);
        const { rows: slice, meta } = pageOf(filtered, req.query);
        const full = await fullByIds(slice.map((i) => i._id), me, school);

        let focused = null;
        if (isUuid(req.query.focus)) {
            let item = shelf.find((i) => String(i._id) === req.query.focus);
            if (!item) {
                const f = await fullByIds([req.query.focus], me, school);
                const r = f[req.query.focus];
                const reached = r && !r.isArchived ? await access.studentsReached(r._id, childIds) : [];
                if (reached.length) [item] = await perChildOf([{ ...lightRow(r), reaches: reached }]);
            }
            if (item) focused = shape(await fullByIds([item._id], me, school))(item);
        }

        res.json({
            success: true,
            data: slice.map(shape(full)),
            ...meta,
            focused,
            children,
            counts: countsOf(shelf, (d) => ({ state: worstState(d.perChild) })),
            // Per child, so the switch can carry a number without the page
            // recounting the whole shelf on every render.
            perChild: Object.fromEntries(children.map((c) => {
                const mine = shelf.filter((d) => d.forChildren.includes(String(c._id)));
                return [c._id, countsOf(mine, (d) => d.perChild[String(c._id)])];
            })),
            unreadIds: unreadIdsOf(filtered),
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

/**
 * Two halves of one shelf: `scope=shared` is what reached this teacher,
 * `scope=mine` what they shared. Without it both come back together, as they
 * always did.
 */
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

        const SUBS = `
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
             ) sub ON true`;

        const { rows } = await pool.query(
            `${LIGHT(`,
         COALESCE(d."isArchived", false) AS "isArchived",
         COALESCE(sub."n", 0)::int      AS "submissionCount",
         COALESCE(sub."marked", 0)::int AS "markedCount"`, '$2::uuid')}
             ${SUBS}
              -- Their own stay on their shelf when the office puts them away,
              -- marked as archived; everyone else's leave it.
              WHERE d."school" = $1
                AND (NOT COALESCE(d."isArchived", false) OR d."uploadedBy" = $2::uuid)
                AND (NOT COALESCE(d."isDraft", false)    OR d."uploadedBy" = $2::uuid)${year}
                AND ( d."uploadedBy" = $2::uuid
                   OR d."targetType" IN ('all_teachers', 'whole_school')
                   OR (d."targetType" = 'specific_teachers' AND d."targetUsers"    ? $5)
                   OR (d."targetType" = 'class_sections'    AND d."targetSections" ?| $3::text[])
                   -- A document set for a whole class is also for the people who
                   -- teach it; the old filter left that case out entirely.
                   OR (d."targetType" = 'class'             AND d."targetClasses"  ?| $4::text[]) )`,
            params,
        );

        const shelf = rows.map((r) => {
            const mine = String(r.uploaderId) === me;
            return {
                ...lightRow(r),
                mine,
                // Their own upload is never "unread".
                isRead: !!r.readAt || mine,
                submissionCount: r.submissionCount || 0,
                markedCount: r.markedCount || 0,
            };
        });
        const shape = (full) => (i) => ({
            ...shapeDoc(full[String(i._id)]),
            mine: i.mine, isRead: i.isRead,
            submissionCount: i.submissionCount, markedCount: i.markedCount,
        });

        const scope  = ['mine', 'shared'].includes(req.query.scope) ? req.query.scope : '';
        const scoped = scope ? shelf.filter((d) => (scope === 'mine' ? d.mine : !d.mine)) : shelf;
        const filtered = order(narrow(scoped, req.query), req.query.sort);
        const { rows: slice, meta } = pageOf(filtered, req.query);
        const full = await fullByIds(slice.map((i) => i._id), me, school);

        // One document by name — "edit this one" from its own page — whatever
        // year it is filed under. Only ever one of their own, or one on the shelf.
        let focused = null;
        if (isUuid(req.query.focus)) {
            let item = shelf.find((i) => String(i._id) === req.query.focus);
            if (!item) {
                const hit = await pool.query(
                    `${LIGHT(`,
         COALESCE(d."isArchived", false) AS "isArchived",
         COALESCE(sub."n", 0)::int      AS "submissionCount",
         COALESCE(sub."marked", 0)::int AS "markedCount"`, '$2::uuid')}
                     ${SUBS}
                      WHERE d."school" = $1 AND d."_id" = $3::uuid AND d."uploadedBy" = $2::uuid`,
                    [school, me, req.query.focus],
                );
                const r = hit.rows[0];
                if (r) item = { ...lightRow(r), mine: true, isRead: true, submissionCount: r.submissionCount || 0, markedCount: r.markedCount || 0 };
            }
            if (item) focused = shape(await fullByIds([item._id], me, school))(item);
        }

        const mineAll = shelf.filter((d) => d.mine);
        res.json({
            success: true,
            data: slice.map(shape(full)),
            ...meta,
            focused,
            sections: reach.list,
            counts: {
                ...countsOf(shelf),
                mine: mineAll.length,
                shared: shelf.length - mineAll.length,
                unread: shelf.filter((d) => !d.isRead).length,
                // Work waiting on this teacher: their own assignments with
                // something handed in that nobody has looked at.
                toMark: mineAll.reduce((n, d) => n + Math.max(0, d.submissionCount - d.markedCount), 0),
            },
            // The tab strip follows the half of the shelf on screen.
            tabCounts: tabCountsOf(scoped),
            unreadIds: unreadIdsOf(filtered),
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

// ── A parent reading and joining the discussion ──────────────────────────────

/**
 * Route middleware: the document must reach one of this parent's own children.
 * Parents could read a document and had no way to ask about it; they see what
 * a student sees — never a comment the staff kept among themselves.
 */
exports.parentDocumentAccess = async (req, res, next) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!doc || doc.isArchived) return res.status(404).json({ success: false, message: 'Document not found' });
        const kids = await access.childIds(req.userId, req.schoolId);
        if ((await access.studentsReached(doc._id, kids)).length) return next();
        return res.status(403).json({ success: false, message: 'This document was not shared with your child' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};
