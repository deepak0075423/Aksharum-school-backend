'use strict';

const Document             = require('../models/Document');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const StudentProfile       = require('../models/StudentProfile');
const ParentProfile        = require('../models/ParentProfile');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const SectionSubjectTeacher= require('../models/SectionSubjectTeacher');
const DocumentCategory     = require('../models/DocumentCategory');
const AcademicYear         = require('../models/AcademicYear');
const DocumentComment      = require('../models/DocumentComment');
const User                 = require('../models/User');
const pool                 = require('../db/pool');

/** Table name, quoted — the raw-SQL reads below take their names from the models. */
const qt = (Model) => `"${Model.tableName}"`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFileObjects(files) {
    return (files || []).map(f => ({
        originalName: f.originalname,
        storedName:   f.filename,
        filePath:     f.path,
        mimeType:     f.mimetype,
        fileSize:     f.size,
    }));
}

async function canStudentViewDocument(doc, studentId, schoolId) {
    const { targetType, targetSections, targetClasses, targetUsers } = doc;

    if (targetType === 'whole_school') return true;
    if (targetType === 'all_teachers') return false;
    if (targetType === 'specific_teachers') return false;

    const profile = await StudentProfile.findOne({ user: studentId }).lean();
    if (!profile?.currentSection) return false;

    const sectionId = profile.currentSection.toString();

    if (targetType === 'class_sections') {
        const studentSec = await ClassSection.findById(sectionId).lean();
        if (!studentSec) return false;
        const studentClass = await Class.findById(studentSec.class).lean();
        if (!studentClass) return false;
        const sameClasses = await Class.find({ school: schoolId, classNumber: studentClass.classNumber }).distinct('_id');
        const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: studentSec.sectionName, school: schoolId }).distinct('_id');
        const sameSectionStrs = sameSections.map(id => id.toString());
        return (targetSections || []).some(id => sameSectionStrs.includes(id.toString()));
    }
    if (targetType === 'class') {
        const section = await ClassSection.findById(sectionId).lean();
        if (!section?.class) return false;
        const classDoc = await Class.findById(section.class).lean();
        if (!classDoc) return false;
        const allClassIds = await Class.find({ school: classDoc.school, classNumber: classDoc.classNumber }).distinct('_id');
        const allClassStrs = allClassIds.map(id => id.toString());
        return (targetClasses || []).some(id => allClassStrs.includes(id.toString()));
    }
    return false;
}

// ── Admin: Documents ──────────────────────────────────────────────────────────
//
// The landing page reads the whole shelf: four figures over the school, a set
// of filters that have to be answered from every row rather than the current
// page, and a list that joins the uploader and whoever each document was
// shared with. All of that is counted in Postgres.
//
// It is written as SQL rather than through the ORM because the ORM's populate
// runs its $lookup in JavaScript (see db/aggregate.js) — resolving the class
// and section names behind `targetClasses`/`targetSections` that way pulls both
// tables into the process for every page of twenty rows.

/** Shared-with labels for one row, as an array Postgres builds in the join. */
const SHARED_LABELS = `
  LEFT JOIN LATERAL (
    SELECT array_agg(x.label ORDER BY x.ord, x.label) AS labels
      FROM (
        SELECT c."classNumber" AS ord, c."className" AS label
          FROM jsonb_array_elements_text(COALESCE(d."targetClasses", '[]'::jsonb)) t(id)
          JOIN ${qt(Class)} c ON c."_id" = t.id::uuid
      ) x
  ) cls ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(x.label ORDER BY x.ord, x.label) AS labels
      FROM (
        SELECT c."classNumber" AS ord,
               c."className" || ' - ' || s."sectionName" AS label
          FROM jsonb_array_elements_text(COALESCE(d."targetSections", '[]'::jsonb)) t(id)
          JOIN ${qt(ClassSection)} s ON s."_id" = t.id::uuid
          JOIN ${qt(Class)} c        ON c."_id" = s."class"
      ) x
  ) sec ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(u2."name" ORDER BY u2."name") AS labels
      FROM jsonb_array_elements_text(COALESCE(d."targetUsers", '[]'::jsonb)) t(id)
      JOIN ${qt(User)} u2 ON u2."_id" = t.id::uuid
  ) usr ON true`;

const LIST_SORTS = {
    newest:  'd."createdAt" DESC NULLS LAST',
    oldest:  'd."createdAt" ASC NULLS LAST',
    title:   'lower(d."title") ASC',
    title_z: 'lower(d."title") DESC',
    type:    'd."docType" ASC, d."createdAt" DESC',
    due:     'd."dueDate" ASC NULLS LAST, d."createdAt" DESC',
};

/** The tab strip: a fixed taxonomy, so the same tabs mean the same thing everywhere. */
const TAB_TYPES = {
    assignments: ['assignment'],
    notices:     ['notice', 'circular'],
    study:       ['study_material'],
};

/** Which target types count as "shared with a class" / "shared with teachers". */
const CLASS_TARGETS   = ['class', 'class_sections'];
const TEACHER_TARGETS = ['all_teachers', 'specific_teachers'];

/**
 * Everything the admin's filter bar can narrow the list by, as a WHERE clause.
 * Shared by the list and its total so the two can never disagree.
 */
function listWhere(req) {
    const params = [String(req.schoolId)];
    const where  = ['d."school" = $1'];
    const q      = req.query;

    // Archived is a state, not a kind: it is its own view rather than a filter
    // layered on top of the tabs, and nothing archived shows in the other four.
    where.push(`COALESCE(d."isArchived", false) = ${q.tab === 'archived' ? 'true' : 'false'}`);

    const types = TAB_TYPES[q.tab];
    if (types) { params.push(types); where.push(`d."docType" = ANY($${params.length}::text[])`); }

    if (q.category)     { params.push(String(q.category));     where.push(`d."category" = $${params.length}`); }
    if (q.docType)      { params.push(String(q.docType));      where.push(`d."docType" = $${params.length}`); }
    if (q.academicYear) { params.push(String(q.academicYear)); where.push(`d."academicYear" = $${params.length}::uuid`); }

    if (q.target === 'classes') {
        params.push(CLASS_TARGETS);   where.push(`d."targetType" = ANY($${params.length}::text[])`);
    } else if (q.target === 'teachers') {
        params.push(TEACHER_TARGETS); where.push(`d."targetType" = ANY($${params.length}::text[])`);
    } else if (q.target) {
        params.push(String(q.target)); where.push(`d."targetType" = $${params.length}`);
    }

    if (q.assignment === 'yes') where.push('COALESCE(d."isAssignment", false) = true');
    if (q.assignment === 'no')  where.push('COALESCE(d."isAssignment", false) = false');

    const search = String(q.search || '').trim();
    if (search) {
        params.push(`%${search}%`);
        // Title, the line under it and the school's own filing label — the three
        // things visible in the row someone is trying to find again.
        where.push(`(d."title" ILIKE $${params.length}
                     OR d."description" ILIKE $${params.length}
                     OR d."category" ILIKE $${params.length})`);
    }

    return { params, clause: where.join(' AND ') };
}

exports.adminGetDocuments = async (req, res) => {
    try {
        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 10)));
        const order = LIST_SORTS[req.query.sort] || LIST_SORTS.newest;

        const { params, clause } = listWhere(req);
        const rowParams = [...params, limit, (page - 1) * limit];

        const [rows, count] = await Promise.all([
            pool.query(
                `SELECT d."_id", d."title", d."description", d."category", d."docType",
                        d."subject", d."assignmentType", d."questions",
                        d."targetType", d."isAssignment", d."dueDate", d."allowSubmission",
                        d."marksEnabled", d."totalMarks", d."tags", d."files",
                        d."currentVersion", d."isArchived", d."createdAt", d."updatedAt",
                        d."academicYear", d."targetClasses", d."targetSections", d."targetUsers",
                        u."_id"  AS "uploaderId",
                        u."name" AS "uploaderName",
                        u."role" AS "uploaderRole",
                        u."profileImage" AS "uploaderPhoto",
                        ay."yearName" AS "academicYearName",
                        cls.labels AS "classLabels",
                        sec.labels AS "sectionLabels",
                        usr.labels AS "userLabels"
                   FROM ${qt(Document)} d
                   LEFT JOIN ${qt(User)} u          ON u."_id"  = d."uploadedBy"
                   LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = d."academicYear"
                   ${SHARED_LABELS}
                  WHERE ${clause}
                  ORDER BY ${order}
                  LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                rowParams,
            ),
            pool.query(`SELECT count(*)::int AS n FROM ${qt(Document)} d WHERE ${clause}`, params),
        ]);

        const total = count.rows[0]?.n || 0;
        res.json({
            success: true,
            data:  rows.rows.map(shapeRow),
            total,
            page,
            limit,
            pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * One row, in the shape the page reads.
 *
 * `sharedWith` is resolved here rather than in the browser: the same sentence
 * appears in the table, in the drawer and in the grid card, and three copies of
 * "how do I turn a targetType into words" is three chances to disagree.
 */
function shapeRow(r) {
    const classes  = r.classLabels   || [];
    const sections = r.sectionLabels || [];
    const people   = r.userLabels    || [];

    const shared = (() => {
        switch (r.targetType) {
            case 'whole_school':      return { icon: 'school',  label: 'Whole School', items: [] };
            case 'all_teachers':      return { icon: 'users',   label: 'All Teachers', items: [] };
            case 'specific_teachers': return {
                icon: 'user',
                label: people.length === 1 ? people[0] : `${people.length} Teachers`,
                items: people,
            };
            case 'class':             return {
                icon: 'layers',
                label: classes[0] || 'No class selected',
                items: classes,
            };
            case 'class_sections':    return {
                icon: 'layers',
                label: sections[0] || 'No section selected',
                items: sections,
            };
            default:                  return { icon: 'files', label: r.targetType || '—', items: [] };
        }
    })();

    const files = Array.isArray(r.files) ? r.files : [];
    return {
        _id: r._id,
        title: r.title,
        description: r.description || '',
        category: r.category || '',
        docType: r.docType || 'other',
        // Carried on the row, not just on the single-document read: the edit
        // form is opened from the list, and a field the list leaves out is a
        // field that silently empties itself when the document is saved again.
        subject: r.subject || '',
        assignmentType: r.assignmentType || null,
        questions: Array.isArray(r.questions) ? r.questions : [],
        targetType: r.targetType,
        targetClasses:  r.targetClasses  || [],
        targetSections: r.targetSections || [],
        targetUsers:    r.targetUsers    || [],
        sharedWith: { ...shared, extra: Math.max(0, shared.items.length - 1) },
        isAssignment: !!r.isAssignment,
        allowSubmission: !!r.allowSubmission,
        marksEnabled: !!r.marksEnabled,
        totalMarks: r.totalMarks,
        dueDate: r.dueDate,
        tags: Array.isArray(r.tags) ? r.tags : [],
        files,
        fileCount: files.length,
        fileSize: files.reduce((n, f) => n + (Number(f.fileSize) || 0), 0),
        currentVersion: r.currentVersion || 1,
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
 * The four tiles, the tab counts and the options behind every dropdown.
 *
 * The tiles state where the school stands *now* and how that compares with
 * where it stood at the end of last month — a percentage, so a school with 24
 * documents and one with 2,400 read the same way. The comparison is against the
 * total as it was then, not against last month's uploads: the tile says "Total
 * Documents", and a delta measured off a different quantity than the number
 * beside it is a lie told in small type.
 *
 * Everything here ignores the filter bar. The summary describes the school, and
 * switching a filter must not make the figures above the list move.
 */
exports.adminGetDocumentOverview = async (req, res) => {
    try {
        const school = String(req.schoolId);
        const now    = new Date();
        // First instant of this month, in the server's own calendar — the same
        // boundary a human means by "last month".
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [totals, tabs, cats, years, unfiled] = await Promise.all([
            pool.query(
                `SELECT COALESCE(d."isArchived", false)              AS "archived",
                        count(*)::int                                AS "n",
                        count(*) FILTER (WHERE d."createdAt" < $2)::int AS "before"
                   FROM ${qt(Document)} d
                  WHERE d."school" = $1
                  GROUP BY 1`,
                [school, monthStart],
            ),
            pool.query(
                `SELECT d."docType",
                        COALESCE(d."isAssignment", false) AS "isAssignment",
                        d."targetType",
                        count(*)::int                                   AS "n",
                        count(*) FILTER (WHERE d."createdAt" < $2)::int AS "before"
                   FROM ${qt(Document)} d
                  WHERE d."school" = $1 AND COALESCE(d."isArchived", false) = false
                  GROUP BY 1, 2, 3`,
                [school, monthStart],
            ),
            // The school's own filing labels, plus anything in use that has since
            // been removed from the master list — a filter that cannot reach a
            // row visible in the table is worse than no filter.
            pool.query(
                `SELECT name, count(d."_id")::int AS "n"
                   FROM (
                     SELECT "name" FROM ${qt(DocumentCategory)}
                      WHERE "school" = $1 AND COALESCE("isActive", true)
                     UNION
                     SELECT DISTINCT "category" FROM ${qt(Document)}
                      WHERE "school" = $1 AND "category" IS NOT NULL AND "category" <> ''
                   ) c(name)
                   LEFT JOIN ${qt(Document)} d
                     ON d."school" = $1 AND d."category" = c.name
                    AND COALESCE(d."isArchived", false) = false
                  GROUP BY name
                  ORDER BY lower(name)`,
                [school],
            ),
            pool.query(
                `SELECT ay."_id", ay."yearName", ay."status", ay."startDate",
                        count(d."_id")::int AS "n"
                   FROM ${qt(AcademicYear)} ay
                   LEFT JOIN ${qt(Document)} d
                     ON d."academicYear" = ay."_id" AND COALESCE(d."isArchived", false) = false
                  WHERE ay."school" = $1
                  GROUP BY ay."_id", ay."yearName", ay."status", ay."startDate"
                  ORDER BY ay."startDate" DESC NULLS LAST`,
                [school],
            ),
            // Documents filed against no year at all — uploaded before the field
            // existed, or while the school had no active year.
            pool.query(
                `SELECT count(*)::int AS "n"
                   FROM ${qt(Document)} d
                  WHERE d."school" = $1 AND d."academicYear" IS NULL
                    AND COALESCE(d."isArchived", false) = false`,
                [school],
            ),
        ]);

        const live     = totals.rows.find((r) => r.archived === false) || { n: 0, before: 0 };
        const archived = totals.rows.find((r) => r.archived === true)  || { n: 0, before: 0 };

        const sum = (pick) => tabs.rows.reduce(
            (a, r) => (pick(r) ? { n: a.n + r.n, before: a.before + r.before } : a),
            { n: 0, before: 0 },
        );

        const tile = ({ n, before }) => ({
            value: n,
            // A school that had nothing last month has no percentage to show —
            // "↑ ∞%" is not a figure. The page prints the raw count instead.
            change: before > 0 ? Math.round(((n - before) / before) * 100) : null,
            added:  n - before,
        });

        const byClass   = sum((r) => CLASS_TARGETS.includes(r.targetType));
        const byTeacher = sum((r) => TEACHER_TARGETS.includes(r.targetType));

        res.json({
            success: true,
            data: {
                tiles: {
                    total:       tile(live),
                    classes:     tile(byClass),
                    teachers:    tile(byTeacher),
                    assignments: tile(sum((r) => r.isAssignment)),
                },
                counts: {
                    all:         live.n,
                    assignments: sum((r) => TAB_TYPES.assignments.includes(r.docType)).n,
                    notices:     sum((r) => TAB_TYPES.notices.includes(r.docType)).n,
                    study:       sum((r) => TAB_TYPES.study.includes(r.docType)).n,
                    archived:    archived.n,
                },
                categories:   cats.rows.map((r) => ({ name: r.name, count: r.n })),
                academicYears: years.rows.map((r) => ({
                    _id: r._id, name: r.yearName, status: r.status, count: r.n,
                })),
                unfiledYear: unfiled.rows[0]?.n || 0,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * The year a document is filed under.
 *
 * The school's active year, or — when none is marked active — the year whose
 * window the upload date falls inside. Returns null rather than guessing when
 * neither answers, so an unfiled document stays visibly unfiled instead of
 * being quietly parked in the wrong year.
 */
async function currentAcademicYearId(schoolId, at = new Date()) {
    const active = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    if (active) return active._id;
    const covering = await AcademicYear.findOne({
        school: schoolId,
        startDate: { $lte: at },
        endDate:   { $gte: at },
    }).lean();
    return covering?._id || null;
}

const ASSIGNMENT_TYPES = ['homework', 'classwork', 'project', 'practice', 'lab', 'reading'];

/**
 * The question breakdown, as the form posts it — `[{label, maxMarks}]`.
 *
 * Labels are trimmed and de-duplicated because they are the key the marks are
 * later stored against: two questions both called "Q1" would have one set of
 * scores between them.
 */
function parseQuestions(raw) {
    let list;
    try { list = JSON.parse(raw || '[]'); } catch { return []; }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list
        .map((q) => ({
            label: String(q?.label ?? '').trim(),
            maxMarks: q?.maxMarks === '' || q?.maxMarks == null ? null : Number(q.maxMarks),
        }))
        .filter((q) => {
            if (!q.label || seen.has(q.label.toLowerCase())) return false;
            seen.add(q.label.toLowerCase());
            return true;
        })
        .map((q) => ({ ...q, maxMarks: Number.isFinite(q.maxMarks) ? q.maxMarks : null }))
        .slice(0, 30);
}

/** One of the fixed kinds, falling back to the assignment flag then "other". */
function normalizeDocType(value, isAssignment) {
    const allowed = ['notice', 'circular', 'study_material', 'assignment', 'other'];
    const v = String(value || '').trim();
    if (allowed.includes(v)) return v;
    return isAssignment ? 'assignment' : 'other';
}

exports.adminUpload = async (req, res) => {
    try {
        const { title, description, category, docType, subject, assignmentType,
                questions, targetType, targetClasses, targetSections,
                targetUsers, isAssignment, dueDate, allowSubmission, marksEnabled, totalMarks, tags } = req.body;

        if (!title?.trim())  return res.status(400).json({ success: false, message: 'Title is required' });
        if (!category)       return res.status(400).json({ success: false, message: 'Category is required' });
        if (!targetType)     return res.status(400).json({ success: false, message: 'Target type is required' });

        const files    = buildFileObjects(req.files);
        const assigned = !!isAssignment && isAssignment !== 'false';

        const doc = await Document.create({
            school: req.schoolId,
            title:  title.trim(),
            description: description || '',
            category,
            docType: normalizeDocType(docType, assigned),
            files,
            uploadedBy:   req.userId,
            uploaderRole: 'school_admin',
            targetType,
            targetClasses:  JSON.parse(targetClasses  || '[]'),
            targetSections: JSON.parse(targetSections || '[]'),
            targetUsers:    JSON.parse(targetUsers    || '[]'),
            tags: JSON.parse(tags || '[]'),
            subject: subject || '',
            academicYear:    await currentAcademicYearId(req.schoolId),
            isAssignment:    assigned,
            assignmentType:  assigned && ASSIGNMENT_TYPES.includes(assignmentType) ? assignmentType : 'homework',
            questions:       assigned ? parseQuestions(questions) : [],
            dueDate:         dueDate ? new Date(dueDate) : null,
            allowSubmission: assigned ? allowSubmission !== false : false,
            // Marks are what makes an assignment gradeable, so a total given
            // without the flag still counts — the form has one field, not two.
            marksEnabled:    assigned && (marksEnabled === 'true' || marksEnabled === true || Number(totalMarks) > 0),
            totalMarks:      Number(totalMarks) > 0 ? Number(totalMarks) : null,
        });
        res.status(201).json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminEditDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const { title, description, category, docType, subject, assignmentType, questions,
                targetType, targetClasses, targetSections,
                targetUsers, isAssignment, dueDate, marksEnabled, totalMarks, tags, academicYear } = req.body;

        if (title !== undefined)      doc.title       = title.trim();
        if (description !== undefined)doc.description = description;
        if (category !== undefined)   doc.category    = category;
        if (targetType !== undefined) doc.targetType  = targetType;
        if (targetClasses  !== undefined) doc.targetClasses  = JSON.parse(targetClasses);
        if (targetSections !== undefined) doc.targetSections = JSON.parse(targetSections);
        if (targetUsers    !== undefined) doc.targetUsers    = JSON.parse(targetUsers);
        if (tags !== undefined) doc.tags = JSON.parse(tags);
        if (dueDate !== undefined)    doc.dueDate     = dueDate ? new Date(dueDate) : null;
        if (subject !== undefined)    doc.subject     = subject;
        if (totalMarks !== undefined) {
            doc.totalMarks   = Number(totalMarks) > 0 ? Number(totalMarks) : null;
            doc.marksEnabled = doc.totalMarks != null;
        }
        if (assignmentType !== undefined && ASSIGNMENT_TYPES.includes(assignmentType)) {
            doc.assignmentType = assignmentType;
        }
        if (questions !== undefined) doc.questions = parseQuestions(questions);
        if (academicYear !== undefined) doc.academicYear = academicYear || null;
        if (isAssignment !== undefined) {
            doc.isAssignment = !!isAssignment && isAssignment !== 'false';
            if (!doc.isAssignment) {
                doc.dueDate = null;
                doc.allowSubmission = false;
                // Nothing left to grade or to break into questions.
                doc.questions = [];
                doc.marksEnabled = false;
                doc.totalMarks = null;
            }
        }
        // Read after the flag above, so "not an assignment any more" cannot be
        // left holding docType 'assignment'.
        if (docType !== undefined || isAssignment !== undefined) {
            doc.docType = normalizeDocType(
                docType !== undefined ? docType : doc.docType,
                doc.isAssignment,
            );
        }

        if (req.files?.length) {
            doc.files = buildFileObjects(req.files);
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        await doc.save();
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminDeleteDocument = async (req, res) => {
    try {
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        // Nothing cascades in the database, so everything hanging off the
        // document goes here — the submissions against it and the discussion
        // about it. Orphaned rows are invisible until somebody counts them.
        await Promise.all([
            AssignmentSubmission.deleteMany({ document: doc._id }),
            DocumentComment.deleteMany({ document: doc._id }),
        ]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminArchiveDocument = async (req, res) => {
    try {
        // The one endpoint puts a document away and takes it back out — an
        // archived document with no route back is a deleted one with extra steps.
        const archive = req.body?.archived === undefined ? true : !!req.body.archived;
        const doc = await Document.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { isArchived: archive },
            { new: true }
        ).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminBulkArchive = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: 'ids are required' });
        const archive = req.body.archived === undefined ? true : !!req.body.archived;
        await Document.updateMany({ _id: { $in: ids }, school: req.schoolId }, { isArchived: archive });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminBulkDelete = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: 'ids are required' });
        await Document.deleteMany({ _id: { $in: ids }, school: req.schoolId });
        await Promise.all([
            AssignmentSubmission.deleteMany({ document: { $in: ids } }),
            DocumentComment.deleteMany({ document: { $in: ids } }),
        ]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const [docs, total] = await Promise.all([
            Document.find({ school: req.schoolId })
                .populate('uploadedBy', 'name email')
                .sort({ updatedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Document.countDocuments({ school: req.schoolId }),
        ]);
        res.json({ success: true, data: docs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRestoreVersion = async (req, res) => {
    // Version history not tracked separately; return document as-is
    try {
        const doc = await Document.findOne({ _id: req.params.docId, school: req.schoolId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Documents ────────────────────────────────────────────────────────

exports.teacherGetDocuments = async (req, res) => {
    try {
        const { category, isArchived, page = 1, limit = 20 } = req.query;

        // Teacher sees: documents they uploaded OR targeted at them / their section
        const mySections = await SectionSubjectTeacher.find({ teacher: req.userId }).distinct('section');

        const filter = {
            school: req.schoolId,
            isArchived: isArchived === 'true' ? true : false,
            $or: [
                { uploadedBy: req.userId },
                { targetType: 'all_teachers' },
                { targetType: 'whole_school' },
                { targetType: 'specific_teachers', targetUsers: req.userId },
                { targetType: 'class_sections', targetSections: { $in: mySections } },
            ],
        };
        if (category) filter.category = category;

        const [docs, total] = await Promise.all([
            Document.find(filter)
                .populate('uploadedBy', 'name')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Document.countDocuments(filter),
        ]);
        res.json({ success: true, data: docs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * The sections a teacher may actually share to, checked against the ones they
 * stand in front of.
 *
 * This used to be taken on trust: whatever `sectionId` the form posted was
 * written straight onto the document, so any teacher could put a notice in
 * front of any class in the school by editing one field in the request. The
 * only sections that count are the ones they are class teacher, substitute or
 * subject teacher for.
 */
async function ownSections(req, raw) {
    let wanted;
    try {
        wanted = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    } catch { wanted = raw ? [String(raw)] : []; }
    wanted = [...new Set((Array.isArray(wanted) ? wanted : [wanted]).map(String).filter(Boolean))];
    if (!wanted.length) return { ok: false, message: 'Choose at least one section' };

    const { teacherReach } = require('./documentViewer.controller');
    // `postable`, not `sections`: reading reaches back across years, sharing
    // only ever goes to this year's rows — the ones the picker offered.
    const mine = new Set((await teacherReach(req.userId, req.schoolId)).postable.map(String));
    const bad  = wanted.filter((id) => !mine.has(id));
    if (bad.length) {
        return { ok: false, message: 'You can only share with sections you teach' };
    }
    return { ok: true, sections: wanted };
}

exports.teacherUpload = async (req, res) => {
    try {
        const { title, description, category, docType, subject, assignmentType, questions,
                sectionId, sectionIds, isAssignment, dueDate,
                allowSubmission, marksEnabled, totalMarks, tags } = req.body;

        if (!title?.trim())  return res.status(400).json({ success: false, message: 'Title is required' });
        if (!category)       return res.status(400).json({ success: false, message: 'Category is required' });

        // `sectionIds` is the array the form posts; `sectionId` is the single
        // value older callers send, and still works.
        const target = await ownSections(req, sectionIds !== undefined ? sectionIds : sectionId);
        if (!target.ok) return res.status(400).json({ success: false, message: target.message });

        const files    = buildFileObjects(req.files);
        const assigned = !!isAssignment && isAssignment !== 'false';

        const doc = await Document.create({
            school: req.schoolId,
            title:  title.trim(),
            description: description || '',
            category,
            // Stamped here too, so a teacher's upload lands on the admin's tabs
            // and year filter alongside everything else.
            docType: normalizeDocType(docType, assigned),
            subject: subject || '',
            files,
            uploadedBy:   req.userId,
            uploaderRole: 'teacher',
            // One document across every section it was set for, not a copy per
            // section — a teacher who takes 9-A and 9-B sets the homework once
            // and marks it in one place.
            targetType:   'class_sections',
            targetSections: target.sections,
            tags: JSON.parse(tags || '[]'),
            academicYear:    await currentAcademicYearId(req.schoolId),
            isAssignment:    assigned,
            assignmentType:  assigned && ASSIGNMENT_TYPES.includes(assignmentType) ? assignmentType : 'homework',
            questions:       assigned ? parseQuestions(questions) : [],
            dueDate:         dueDate ? new Date(dueDate) : null,
            allowSubmission: assigned ? allowSubmission !== 'false' : false,
            marksEnabled:    assigned && (marksEnabled === 'true' || marksEnabled === true || Number(totalMarks) > 0),
            totalMarks:      Number(totalMarks) > 0 ? Number(totalMarks) : null,
        });
        res.status(201).json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherEditDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const { title, description, category, docType, subject, assignmentType, questions,
                sectionIds, isAssignment, dueDate, marksEnabled, totalMarks } = req.body;

        if (title !== undefined)       doc.title       = title.trim();
        if (description !== undefined) doc.description = description;
        if (category !== undefined)    doc.category    = category;
        if (subject !== undefined)     doc.subject     = subject;

        if (sectionIds !== undefined) {
            const target = await ownSections(req, sectionIds);
            if (!target.ok) return res.status(400).json({ success: false, message: target.message });
            doc.targetSections = target.sections;
        }

        if (isAssignment !== undefined) {
            doc.isAssignment = !!isAssignment && isAssignment !== 'false';
            if (!doc.isAssignment) {
                doc.dueDate = null;
                doc.allowSubmission = false;
                doc.questions = [];
                doc.marksEnabled = false;
                doc.totalMarks = null;
            }
        }
        // After the flag, so "not an assignment any more" cannot keep the type.
        if (docType !== undefined || isAssignment !== undefined) {
            doc.docType = normalizeDocType(docType !== undefined ? docType : doc.docType, doc.isAssignment);
        }
        if (assignmentType !== undefined && ASSIGNMENT_TYPES.includes(assignmentType)) {
            doc.assignmentType = assignmentType;
        }
        if (questions !== undefined && doc.isAssignment) doc.questions = parseQuestions(questions);

        if (dueDate !== undefined && doc.isAssignment) doc.dueDate = dueDate ? new Date(dueDate) : null;
        if (totalMarks !== undefined && doc.isAssignment) {
            doc.totalMarks   = Number(totalMarks) > 0 ? Number(totalMarks) : null;
            doc.marksEnabled = doc.totalMarks != null;
        }

        if (req.files?.length) {
            doc.files = buildFileObjects(req.files);
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        await doc.save();
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherDeleteDocument = async (req, res) => {
    try {
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        await AssignmentSubmission.deleteMany({ document: doc._id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetSubmissions = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const submissions = await AssignmentSubmission.find({ document: doc._id })
            .populate('student', 'name rollNumber email')
            .sort({ submittedAt: -1 })
            .lean();
        res.json({ success: true, data: submissions });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherReviewSubmission = async (req, res) => {
    try {
        const { marks, feedback } = req.body;
        const sub = await AssignmentSubmission.findOne({ _id: req.params.submissionId, school: req.schoolId });
        if (!sub) return res.status(404).json({ success: false, message: 'Submission not found' });

        sub.marks      = marks !== undefined ? Number(marks) : sub.marks;
        sub.feedback   = feedback || sub.feedback;
        sub.reviewedBy = req.userId;
        sub.reviewedAt = new Date();
        await sub.save();
        res.json({ success: true, data: sub });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Documents ────────────────────────────────────────────────────────

exports.studentGetDocuments = async (req, res) => {
    try {
        const { category } = req.query;
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [], _debug: 'no currentSection' });

        const section = await ClassSection.findById(profile.currentSection).lean();

        const orConditions = [{ targetType: 'whole_school' }];

        if (section) {
            const classDoc = await Class.findById(section.class).lean();
            if (classDoc) {
                const sameClasses = await Class.find({ school: req.schoolId, classNumber: classDoc.classNumber }).distinct('_id');
                orConditions.push({ targetType: 'class', targetClasses: { $in: sameClasses } });

                const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: section.sectionName, school: req.schoolId }).distinct('_id');
                orConditions.push({ targetType: 'class_sections', targetSections: { $in: sameSections } });
            }
        }

        const filter = { school: req.schoolId, isArchived: false, $or: orConditions };
        if (category) filter.category = category;

        const docs = await Document.find(filter)
            .populate('uploadedBy', 'name')
            .populate('targetClasses', 'classNumber className')
            .populate('targetSections', 'sectionName')
            .sort({ createdAt: -1 })
            .lean();

        // Attach submission status for assignments
        const assignmentIds = docs.filter(d => d.isAssignment).map(d => d._id);
        const submissions   = await AssignmentSubmission.find({ student: req.userId, document: { $in: assignmentIds } }).lean();
        const subMap        = Object.fromEntries(submissions.map(s => [s.document.toString(), s]));

        const data = docs.map(d => ({
            ...d,
            mySubmission: d.isAssignment ? (subMap[d._id.toString()] || null) : undefined,
        }));
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const canView = await canStudentViewDocument(doc, req.userId, req.schoolId);
        if (!canView) return res.status(403).json({ success: false, message: 'Access denied' });

        let mySubmission = null;
        if (doc.isAssignment) {
            mySubmission = await AssignmentSubmission.findOne({ document: doc._id, student: req.userId }).lean();
        }
        res.json({ success: true, data: { ...doc, mySubmission } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentSubmitAssignment = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isAssignment: true, allowSubmission: true }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Assignment not found or submissions not allowed' });

        if (doc.dueDate && new Date() > new Date(doc.dueDate)) {
            const files = buildFileObjects(req.files);
            const profile = await StudentProfile.findOne({ user: req.userId }).lean();
            const sub = await AssignmentSubmission.findOneAndUpdate(
                { document: doc._id, student: req.userId },
                { $set: { files, status: 'late', submittedAt: new Date(), section: profile?.currentSection || null, school: req.schoolId } },
                { upsert: true, new: true }
            ).lean();
            return res.json({ success: true, data: sub, message: 'Submitted late' });
        }

        const files   = buildFileObjects(req.files);
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const sub     = await AssignmentSubmission.findOneAndUpdate(
            { document: doc._id, student: req.userId },
            { $set: { files, status: 'submitted', submittedAt: new Date(), section: profile?.currentSection || null, school: req.schoolId } },
            { upsert: true, new: true }
        ).lean();
        res.json({ success: true, data: sub });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: documents visible to child ───────────────────────────────────────
exports.parentGetDocuments = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.json({ success: true, data: [] });

        const profile = await StudentProfile.findOne({ user: childId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const section = await ClassSection.findById(profile.currentSection).lean();

        const parentOrConds = [{ targetType: 'whole_school' }];

        if (section) {
            const classDoc = await Class.findById(section.class).lean();
            if (classDoc) {
                const sameClasses = await Class.find({ school: req.schoolId, classNumber: classDoc.classNumber }).distinct('_id');
                parentOrConds.push({ targetType: 'class', targetClasses: { $in: sameClasses } });

                const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: section.sectionName, school: req.schoolId }).distinct('_id');
                parentOrConds.push({ targetType: 'class_sections', targetSections: { $in: sameSections } });
            }
        }

        const docs = await Document.find({
            school: req.schoolId,
            isArchived: false,
            $or: parentOrConds,
        })
            .populate('uploadedBy', 'name')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, data: docs });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.parentGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
