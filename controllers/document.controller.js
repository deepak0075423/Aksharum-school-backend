'use strict';

const Document             = require('../models/Document');
const yearScope = require('../services/yearScope');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const StudentProfile       = require('../models/StudentProfile');
const ParentProfile        = require('../models/ParentProfile');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const SectionSubjectTeacher= require('../models/SectionSubjectTeacher');
const DocumentCategory     = require('../models/DocumentCategory');
const AcademicYear         = require('../models/AcademicYear');
const DocumentComment      = require('../models/DocumentComment');
const DocumentRead         = require('../models/DocumentRead');
const TeacherProfile       = require('../models/TeacherProfile');
const Subject              = require('../models/Subject');
const User                 = require('../models/User');
const DocumentVersion      = require('../models/DocumentVersion');
const DocumentReminder     = require('../models/DocumentReminder');
const pool                 = require('../db/pool');
const { yearOrderSql } = require('../utils/listOrder');
const access               = require('../services/documentAccess');
const { notify }           = require('../services/notifyService');
const { isUuid }           = access;

/** Table name, quoted — the raw-SQL reads below take their names from the models. */
const qt = (Model) => `"${Model.tableName}"`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// What is stored for an upload — the address under the server root, never the
// machine's own disk path (services/documentAccess).
const buildFileObjects = access.storedFiles;

/** Is this document on this student's shelf — judged by where they sat in its year. */
async function canStudentViewDocument(doc, studentId) {
    return (await access.studentsReached(doc._id, [studentId])).length > 0;
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
    // Assignments is the flag, not the type: study material students hand work
    // in against is an assignment to whoever has to mark it — and the tile
    // above this tab counts the flag, so the two now agree.
    if (q.tab === 'assignments') where.push('COALESCE(d."isAssignment", false) = true');

    if (q.category)     { params.push(String(q.category));     where.push(`d."category" = $${params.length}`); }
    if (q.docType)      { params.push(String(q.docType));      where.push(`d."docType" = $${params.length}`); }
    // 'none' is the documents filed under no year at all. Anything that is not
    // an id is ignored rather than handed to Postgres to choke on.
    if (q.academicYear === 'none') where.push('d."academicYear" IS NULL');
    else if (isUuid(q.academicYear)) { params.push(String(q.academicYear)); where.push(`d."academicYear" = $${params.length}::uuid`); }
    // Nothing asked: the academic year in view (the switcher's, else the
    // school's active year), with the documents filed under no year, as every
    // reader's shelf shows them. `all` is every year.
    else if (q.academicYear !== 'all') {
        const year = yearScope.now();
        if (year?.id) { params.push(year.id); where.push(`(d."academicYear" = $${params.length}::uuid OR d."academicYear" IS NULL)`); }
    }

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
        // A typed % or _ is a character to find, not a wildcard.
        params.push(`%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
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
                        d."currentVersion", d."isArchived", d."isDraft", d."createdAt", d."updatedAt",
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

    const files = access.publicFiles(r.files);
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
        isDraft: !!r.isDraft,
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
                `SELECT ay."_id", ay."yearName", ${yearScope.yearStatus('ay')} AS "status", ay."startDate",
                        count(d."_id")::int AS "n"
                   FROM ${qt(AcademicYear)} ay
                   LEFT JOIN ${qt(Document)} d
                     ON d."academicYear" = ay."_id" AND COALESCE(d."isArchived", false) = false
                  WHERE ay."school" = $1
                  GROUP BY ay."_id", ay."yearName", ay."status", ay."startDate"
                  ORDER BY ${yearOrderSql('ay')}`,
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
                    assignments: sum((r) => r.isAssignment).n,
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

// The year a document is filed under — services/documentAccess.
const currentAcademicYearId = access.currentYearId;

const ASSIGNMENT_TYPES = ['homework', 'classwork', 'project', 'practice', 'lab', 'reading'];

/**
 * The question breakdown, as the form posts it — `[{label, maxMarks}]`.
 *
 * Labels are trimmed and de-duplicated because they are the key the marks are
 * later stored against: two questions both called "Q1" would have one set of
 * scores between them.
 */
const OTHER_MARKS = 'Other marks';
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
            // "Other marks" is the marking form's own line for what the named
            // questions leave over; a question cannot take its name.
            if (q.label.toLowerCase() === OTHER_MARKS.toLowerCase()) return false;
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

/**
 * The teachers a document is addressed to by name.
 *
 * Only read for `specific_teachers`. Every id has to be a teacher of this
 * school — the list arrives from a form, and an id from somewhere else would
 * otherwise sit on the document reaching nobody, or somebody it should not.
 */
async function teacherTargets(req, targetType, raw) {
    if (targetType !== 'specific_teachers') return { ok: true, users: [] };
    let wanted;
    try { wanted = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { wanted = []; }
    wanted = [...new Set((Array.isArray(wanted) ? wanted : []).map(String).filter(Boolean))];
    if (!wanted.length) return { ok: false, message: 'Pick at least one teacher' };

    const found = await User.find({ _id: { $in: wanted }, school: req.schoolId, role: 'teacher' }).distinct('_id');
    if (found.length !== wanted.length) {
        return { ok: false, message: 'Some of the chosen teachers are not on this school\'s staff' };
    }
    return { ok: true, users: wanted };
}

/**
 * The files a document holds after an edit.
 *
 * `keepFiles` is the stored names of the files already on it that should stay;
 * whatever is uploaded with the request is added after them. So an edit can
 * add a file, take one off, or both — it used to be all or nothing: the first
 * upload threw away every file already there.
 *
 * A caller that sends no `keepFiles` gets the old behaviour (an upload replaces
 * the lot, no upload changes nothing), so nothing that was written against it
 * breaks.
 */
const MAX_FILES = 10;
function filesAfterEdit(doc, req) {
    const had   = Array.isArray(doc.files) ? doc.files : [];
    const fresh = buildFileObjects(req.files);

    if (req.body.keepFiles === undefined) {
        return { ok: true, files: fresh.length ? fresh : had, changed: fresh.length > 0 };
    }

    let keep;
    try { keep = JSON.parse(req.body.keepFiles || '[]'); } catch { keep = []; }
    const names = new Set((Array.isArray(keep) ? keep : []).map(String));
    const kept  = had.filter((f) => names.has(String(f.storedName)));
    const files = [...kept, ...fresh];
    if (files.length > MAX_FILES) {
        return { ok: false, message: `A document can hold up to ${MAX_FILES} files` };
    }
    return { ok: true, files, changed: fresh.length > 0 || kept.length !== had.length };
}

/** Work that is handed in needs the paper it is handed in against. */
const NEEDS_FILE = 'Attach the assignment or its instructions — students need a file to work from';

/**
 * Every teacher, with the three things the office picks them by.
 *
 * `subjects` is what the staff record says they teach joined with what they
 * are actually timetabled for this year, because either one alone misses
 * people: a new joiner has a record and no sections yet, and an old record
 * often lists nothing at all.
 */
exports.adminDocumentTeachers = async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u."_id", u."name", u."profileImage",
                    tp."department", tp."designation", tp."subjects",
                    t.names AS "taught"
               FROM ${qt(User)} u
               LEFT JOIN ${qt(TeacherProfile)} tp ON tp."user" = u."_id"
               LEFT JOIN LATERAL (
                 SELECT array_agg(DISTINCT sb."subjectName") AS names
                   FROM ${qt(SectionSubjectTeacher)} sst
                   JOIN ${qt(Subject)} sb ON sb."_id" = sst."subject"
                   LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = sb."academicYear"
                  WHERE sst."teacher" = u."_id"
                    AND (ay."_id" IS NULL OR ${yearScope.yearStatus('ay')} = 'active')
               ) t ON true
              WHERE u."school" = $1 AND u."role" = 'teacher' AND COALESCE(u."isActive", true)
              ORDER BY lower(u."name")`,
            [String(req.schoolId)],
        );

        const clean = (v) => String(v || '').trim();
        const data = rows.map((r) => {
            const seen = new Set();
            const subjects = [...(Array.isArray(r.subjects) ? r.subjects : []), ...(r.taught || [])]
                .map(clean)
                .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
                .sort((a, b) => a.localeCompare(b));
            return {
                _id: r._id,
                name: r.name,
                photo: r.profileImage || '',
                department: clean(r.department),
                designation: clean(r.designation),
                subjects,
            };
        });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── What both sharing forms post ─────────────────────────────────────────────

const TARGET_TYPES  = ['whole_school', 'all_teachers', 'specific_teachers', 'class', 'class_sections'];
const STAFF_TARGETS = ['all_teachers', 'specific_teachers'];
const STAFF_ONLY    = 'Only students hand work in — an assignment cannot be shared with teachers alone';

/** A refusal takes the files the request brought with it: multer has already written them. */
const refuse = (req, res, message, status = 400, code = null) => {
    access.discardUploads(req);
    return res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
};

/** A form posts every value as text, so 'false' is false. */
const flag = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * When work is due.
 *
 * The form sends a day. `new Date('2026-11-20')` is midnight UTC — 5:30 in the
 * morning here — so work handed in at ten on the due day came out "late" and
 * everything unsubmitted was "missed" before school had opened. A day means
 * the whole day: it is due at the end of it. `undefined` is a value that is
 * not a date at all.
 */
function dueAt(value) {
    if (value == null || value === '') return null;
    const s = String(value);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999) : new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** A JSON list of ids from a form field; null when it is not a list. */
function idList(raw) {
    let list;
    try { list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return null; }
    if (!Array.isArray(list)) return null;
    return [...new Set(list.map((x) => String(x?._id || x || '')).filter(Boolean))];
}

function tagList(raw) {
    const list = idList(raw);
    return (list || []).map((t) => t.trim()).filter(Boolean).slice(0, 20);
}

/**
 * The classes or sections a document is aimed at — every one a row of this
 * school. An id from somewhere else used to be stored as it came, reaching
 * nobody; so did "whole classes" with no class ticked.
 */
async function classTargets(req, targetType, rawClasses, rawSections) {
    const none = { ok: true, classes: [], sections: [] };
    if (targetType === 'class') {
        const want = idList(rawClasses);
        if (!want?.length) return { ok: false, message: 'Pick at least one class' };
        const found = want.every(isUuid)
            ? await Class.find({ _id: { $in: want }, school: req.schoolId }).distinct('_id') : [];
        if (found.length !== want.length) return { ok: false, message: 'Some of the chosen classes are not in this school' };
        return { ...none, classes: want };
    }
    if (targetType === 'class_sections') {
        const want = idList(rawSections);
        if (!want?.length) return { ok: false, message: 'Pick at least one section' };
        const found = want.every(isUuid)
            ? await ClassSection.find({ _id: { $in: want }, school: req.schoolId }).distinct('_id') : [];
        if (found.length !== want.length) return { ok: false, message: 'Some of the chosen sections are not in this school' };
        return { ...none, sections: want };
    }
    return none;
}

/** A document as a client reads it: its files by address, not by disk path. */
function clean(doc) {
    const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
    o.files = access.publicFiles(o.files);
    return o;
}

const plainFiles = (files) => (Array.isArray(files) ? files : []).map((f) => ({
    originalName: f.originalName, storedName: f.storedName, filePath: f.filePath,
    mimeType: f.mimeType, fileSize: f.fileSize,
}));

/**
 * Tell the people a document was shared with that it is there.
 *
 * Nothing used to: a notice went onto the shelf and waited to be found. Run
 * after the answer has gone back — a school-wide notice writes a receipt per
 * reader, and the person sharing it should not wait on that.
 */
function announce(doc, req) {
    setImmediate(async () => {
        try {
            const { recipients, about } = await access.audience(doc);
            if (!recipients.length) return;
            const kind = doc.isAssignment ? 'assignment'
                : ({ notice: 'notice', circular: 'circular', study_material: 'study material' }[doc.docType] || 'document');
            const due = doc.isAssignment && doc.dueDate ? ` Due ${fmtDay(doc.dueDate)}.` : '';
            notify({
                school: doc.school, sender: req.userId, senderRole: req.userRole,
                title: `${doc.isAssignment ? '📝' : '📄'} New ${kind}: ${doc.title}`.slice(0, 140),
                body: `${doc.description ? String(doc.description).trim() : `A new ${kind} has been shared with you.`}${due}`,
                recipients,
                about: about || undefined,
                link: { type: 'documents.item', entityId: doc._id },
            });
        } catch (e) { console.error('[documents] announce:', e.message); }
    });
}

/**
 * The assignment half of an edit. Returns what is wrong, or null.
 *
 * `allowSubmission` is read here now. Both edit forms have always sent it and
 * neither endpoint looked, so "Accept submissions" could not be switched off —
 * and a notice later turned into an assignment kept the `false` it was created
 * with, so it said "Submissions are closed" for good.
 */
function applyAssignment(doc, b) {
    const was = !!doc.isAssignment;
    if (b.isAssignment !== undefined) doc.isAssignment = flag(b.isAssignment);

    if (!doc.isAssignment) {
        if (was) {
            doc.dueDate = null;
            doc.allowSubmission = false;
            // Nothing left to grade or to break into questions.
            doc.questions = [];
            doc.marksEnabled = false;
            doc.totalMarks = null;
        }
    } else {
        if (STAFF_TARGETS.includes(doc.targetType)) return STAFF_ONLY;
        if (b.allowSubmission !== undefined) doc.allowSubmission = flag(b.allowSubmission);
        else if (!was) doc.allowSubmission = true;
        if (b.dueDate !== undefined) {
            const due = dueAt(b.dueDate);
            if (due === undefined) return 'That due date is not a date';
            doc.dueDate = due;
        }
        if (b.totalMarks !== undefined) {
            doc.totalMarks   = Number(b.totalMarks) > 0 ? Number(b.totalMarks) : null;
            doc.marksEnabled = doc.totalMarks != null;
        }
        if (b.assignmentType !== undefined && ASSIGNMENT_TYPES.includes(b.assignmentType)) {
            doc.assignmentType = b.assignmentType;
        }
        if (b.questions !== undefined) doc.questions = parseQuestions(b.questions);
        // No "Out of", no marks — so no breakdown of them either.
        if (doc.totalMarks == null) doc.questions = [];
    }
    // Read after the flag, so "not an assignment any more" cannot keep the type.
    if (b.docType !== undefined || b.isAssignment !== undefined) {
        doc.docType = normalizeDocType(b.docType !== undefined ? b.docType : doc.docType, doc.isAssignment);
    }
    return null;
}

/**
 * Save an edited document, keeping what its files were.
 *
 * When the files change the set that was there is filed as a version — the
 * counter used to go up with nothing behind it — and the read marks are
 * cleared: a notice whose attachment was swapped is a notice people have not
 * read. Replaced files stay on disk for as long as a version holds them.
 */
async function saveEdited(doc, req, had, changed) {
    await doc.save();
    if (!changed) return;
    await Promise.all([
        DocumentVersion.create({
            document: doc._id, school: doc.school,
            versionNumber: (doc.currentVersion || 2) - 1,
            files: had, uploadedBy: req.userId,
        }),
        DocumentRead.deleteMany({ document: doc._id, user: { $ne: req.userId } }),
    ]).catch((e) => console.error('[documents] version:', e.message));
}

/** Everything hanging off these documents — nothing cascades in this database. */
async function wipe(docs) {
    const docIds = docs.map((d) => d._id);
    if (!docIds.length) return;
    const [versions, comments, subs] = await Promise.all([
        DocumentVersion.find({ document: { $in: docIds } }).select('files').lean(),
        DocumentComment.find({ document: { $in: docIds } }).select('files').lean(),
        AssignmentSubmission.find({ document: { $in: docIds } }).select('files').lean(),
    ]);
    const names = [...docs, ...versions, ...comments, ...subs].flatMap((r) => access.namesOf(r.files));
    await Promise.all([
        AssignmentSubmission.deleteMany({ document: { $in: docIds } }),
        DocumentComment.deleteMany({ document: { $in: docIds } }),
        DocumentRead.deleteMany({ document: { $in: docIds } }),
        DocumentVersion.deleteMany({ document: { $in: docIds } }),
        DocumentReminder.deleteMany({ document: { $in: docIds } }),
    ]);
    // The files go once no other document shares them (a duplicate does).
    access.removeUnreferenced(names);
}

// ── Admin: share, edit, put away, delete ─────────────────────────────────────

exports.adminUpload = async (req, res) => {
    let created = false;
    try {
        const b = req.body;
        if (!b.title?.trim())                      return refuse(req, res, 'Title is required');
        if (!b.category)                           return refuse(req, res, 'Category is required');
        if (!TARGET_TYPES.includes(b.targetType))  return refuse(req, res, 'Choose who this is shared with');

        const files    = buildFileObjects(req.files);
        const assigned = flag(b.isAssignment);
        if (assigned && !files.length)                      return refuse(req, res, NEEDS_FILE, 400, 'NEEDS_FILE');
        if (assigned && STAFF_TARGETS.includes(b.targetType)) return refuse(req, res, STAFF_ONLY);
        const due = assigned ? dueAt(b.dueDate) : null;
        if (due === undefined)                              return refuse(req, res, 'That due date is not a date');

        const where = await classTargets(req, b.targetType, b.targetClasses, b.targetSections);
        if (!where.ok) return refuse(req, res, where.message);
        const people = await teacherTargets(req, b.targetType, b.targetUsers);
        if (!people.ok) return refuse(req, res, people.message);

        const total = Number(b.totalMarks) > 0 ? Number(b.totalMarks) : null;
        const doc = await Document.create({
            school: req.schoolId,
            title:  b.title.trim(),
            description: b.description || '',
            category: b.category,
            docType: normalizeDocType(b.docType, assigned),
            files,
            uploadedBy:   req.userId,
            // Stamped from the account, not the route: a teacher who administers
            // Documents shares through this endpoint too.
            uploaderRole: req.userRole === 'teacher' ? 'teacher' : 'school_admin',
            targetType: b.targetType,
            targetClasses:  where.classes,
            targetSections: where.sections,
            targetUsers:    people.users,
            tags: tagList(b.tags),
            subject: b.subject || '',
            academicYear:    await currentAcademicYearId(req.schoolId),
            isAssignment:    assigned,
            assignmentType:  assigned && ASSIGNMENT_TYPES.includes(b.assignmentType) ? b.assignmentType : 'homework',
            // A breakdown splits the "Out of" — with none there are no marks to
            // split (an assignment set without marks takes feedback only).
            questions:       assigned && total != null ? parseQuestions(b.questions) : [],
            dueDate:         due,
            // Open unless the form says otherwise. This compared the text
            // 'false' with the boolean, so it was always open.
            allowSubmission: assigned ? (b.allowSubmission === undefined ? true : flag(b.allowSubmission)) : false,
            // Marks are what makes an assignment gradeable, so a total given
            // without the flag still counts — the form has one field, not two.
            marksEnabled:    assigned && total != null,
            totalMarks:      assigned ? total : null,
        });
        created = true;
        announce(doc, req);
        res.status(201).json({ success: true, data: clean(doc) });
    } catch (e) {
        if (!created) access.discardUploads(req);
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.adminGetDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminEditDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return refuse(req, res, 'Document not found', 404);
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId });
        if (!doc) return refuse(req, res, 'Document not found', 404);

        const b = req.body;
        if (b.title !== undefined) {
            if (!String(b.title).trim()) return refuse(req, res, 'Title is required');
            doc.title = String(b.title).trim();
        }
        if (b.description !== undefined) doc.description = b.description;
        if (b.category !== undefined) {
            if (!b.category) return refuse(req, res, 'Category is required');
            doc.category = b.category;
        }
        if (b.subject !== undefined) doc.subject = b.subject;
        if (b.tags !== undefined)    doc.tags    = tagList(b.tags);

        if (b.targetType !== undefined) {
            if (!TARGET_TYPES.includes(b.targetType)) return refuse(req, res, 'Choose who this is shared with');
            doc.targetType = b.targetType;
        }
        if (b.targetType !== undefined || b.targetClasses !== undefined || b.targetSections !== undefined) {
            const where = await classTargets(
                req, doc.targetType,
                b.targetClasses  !== undefined ? b.targetClasses  : (doc.targetClasses  || []).map(String),
                b.targetSections !== undefined ? b.targetSections : (doc.targetSections || []).map(String),
            );
            if (!where.ok) return refuse(req, res, where.message);
            doc.targetClasses  = where.classes;
            doc.targetSections = where.sections;
        }
        if (b.targetUsers !== undefined || b.targetType !== undefined) {
            const people = await teacherTargets(
                req, doc.targetType,
                b.targetUsers !== undefined ? b.targetUsers : (doc.targetUsers || []).map(String),
            );
            if (!people.ok) return refuse(req, res, people.message);
            doc.targetUsers = people.users;
        }
        if (b.academicYear !== undefined) {
            if (b.academicYear && !(isUuid(b.academicYear)
                && await AcademicYear.findOne({ _id: b.academicYear, school: req.schoolId }).lean())) {
                return refuse(req, res, 'That academic year is not one of this school\'s');
            }
            doc.academicYear = b.academicYear || null;
        }

        const wrong = applyAssignment(doc, b);
        if (wrong) return refuse(req, res, wrong);

        const had   = plainFiles(doc.files);
        const after = filesAfterEdit(doc, req);
        if (!after.ok) return refuse(req, res, after.message);
        if (after.changed) {
            doc.files = after.files;
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        if (doc.isAssignment && !doc.files?.length) return refuse(req, res, NEEDS_FILE, 400, 'NEEDS_FILE');

        await saveEdited(doc, req, had, after.changed);
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminDeleteDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        await wipe([doc]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Put a document away, or take it back out — `{ archived: bool }`, and leaving
 * it out still means archive. The office may do it to anything; a teacher (on
 * their own route) only to what they shared.
 */
const archiveBy = (own) => async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const archive = req.body?.archived === undefined ? true : flag(req.body.archived);
        const doc = await Document.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId, ...(own ? { uploadedBy: req.userId } : {}) },
            { isArchived: archive },
            { new: true },
        ).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.adminArchiveDocument   = archiveBy(false);
exports.teacherArchiveDocument = archiveBy(true);

/**
 * Share a draft: from here on it is on its audience's shelves, and they are
 * told — which is why a copy is not shared the moment it is made. It is dated
 * from now, not from when the copy was taken: "Assigned on" is the day the
 * class got it. Sharing something already shared changes nothing.
 */
const publishBy = (own) => async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({
            _id: req.params.id, school: req.schoolId, ...(own ? { uploadedBy: req.userId } : {}),
        }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        if (!doc.isDraft) return res.json({ success: true, data: clean(doc), already: true });
        if (doc.isAssignment && !(doc.files || []).length) {
            return res.status(400).json({ success: false, code: 'NEEDS_FILE', message: NEEDS_FILE });
        }
        // One statement, so two presses share it — and announce it — once.
        const { rowCount } = await pool.query(
            `UPDATE ${qt(Document)} SET "isDraft" = false, "createdAt" = now(), "updatedAt" = now()
              WHERE "_id" = $1 AND COALESCE("isDraft", false)`,
            [String(doc._id)],
        );
        const fresh = await Document.findById(doc._id).lean();
        if (rowCount) announce(fresh, req);
        res.json({ success: true, data: clean(fresh) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.adminPublishDocument   = publishBy(false);
exports.teacherPublishDocument = publishBy(true);

exports.adminBulkArchive = async (req, res) => {
    try {
        const wanted = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(isUuid);
        if (!wanted.length) return res.status(400).json({ success: false, message: 'ids are required' });
        const archive = req.body.archived === undefined ? true : flag(req.body.archived);
        await Document.updateMany({ _id: { $in: wanted }, school: req.schoolId }, { isArchived: archive });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Delete several documents at once. The office: any of the school's. A teacher
 * (their own route, Nov 23 2026): only what they shared — anything else among
 * the ids is left alone and not counted.
 */
const bulkDeleteBy = (own) => async (req, res) => {
    try {
        const wanted = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(isUuid);
        if (!wanted.length) return res.status(400).json({ success: false, message: 'ids are required' });
        // Only what is this school's. The submissions, comments and read marks
        // used to be deleted by the ids as posted — another school's with them.
        const mine = { school: req.schoolId, ...(own ? { uploadedBy: req.userId } : {}) };
        const docs = await Document.find({ _id: { $in: wanted }, ...mine }).select('files').lean();
        if (!docs.length) return res.status(404).json({ success: false, message: 'None of those documents could be deleted' });
        await Document.deleteMany({ _id: { $in: docs.map((d) => d._id) }, ...mine });
        await wipe(docs);
        res.json({ success: true, deleted: docs.length, skipped: wanted.length - docs.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
exports.adminBulkDelete   = bulkDeleteBy(false);
exports.teacherBulkDelete = bulkDeleteBy(true);

// ── Versions ─────────────────────────────────────────────────────────────────

/** A document's earlier sets of files, newest first, under what it holds now. */
exports.getVersions = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        const { rows } = await pool.query(
            `SELECT v."_id", v."versionNumber", v."files", v."createdAt", u."name" AS "by"
               FROM ${qt(DocumentVersion)} v
               LEFT JOIN ${qt(User)} u ON u."_id" = v."uploadedBy"
              WHERE v."document" = $1
              ORDER BY v."versionNumber" DESC, v."createdAt" DESC`,
            [String(doc._id)],
        );
        res.json({
            success: true,
            data: {
                current: { versionNumber: doc.currentVersion || 1, files: access.publicFiles(doc.files), at: doc.updatedAt },
                versions: rows.map((r) => ({
                    _id: r._id, versionNumber: r.versionNumber, files: access.publicFiles(r.files),
                    // When it stopped being the current one, and who replaced it.
                    replacedAt: r.createdAt, replacedBy: r.by || '',
                })),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Put an earlier set of files back. What is there now is filed as a version
 * first, so restoring is itself something that can be undone.
 */
exports.restoreVersion = async (req, res) => {
    try {
        if (!isUuid(req.params.id) || !isUuid(req.params.versionId)) {
            return res.status(404).json({ success: false, message: 'That version could not be found' });
        }
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        const version = await DocumentVersion.findOne({ _id: req.params.versionId, document: doc._id }).lean();
        if (!version) return res.status(404).json({ success: false, message: 'That version could not be found' });
        if (doc.isAssignment && !(version.files || []).length) {
            return res.status(400).json({ success: false, message: NEEDS_FILE });
        }

        const had = plainFiles(doc.files);
        doc.files = plainFiles(version.files);
        doc.currentVersion = (doc.currentVersion || 1) + 1;
        await saveEdited(doc, req, had, true);
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: share, edit, delete ─────────────────────────────────────────────

/**
 * The sections a teacher may actually share to, checked against the ones they
 * stand in front of this year.
 *
 * `keep` is what an edit must not lose: sections already on the document that
 * are not this teacher's to pick any more — an earlier year's, or a class they
 * have stopped teaching. The form cannot offer those, and saving used to write
 * only what it offered, so editing a title quietly un-shared the document from
 * them (and a document with nothing left to offer could not be saved at all).
 */
async function ownSections(req, raw, existing = null) {
    let wanted;
    try {
        wanted = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    } catch { wanted = raw ? [String(raw)] : []; }
    wanted = [...new Set((Array.isArray(wanted) ? wanted : [wanted]).map(String).filter(Boolean))];

    // `postable`, not `sections`: reading reaches back across years, sharing
    // only ever goes to this year's rows — the ones the picker offered.
    const mine = new Set((await access.teacherReach(req.userId, req.schoolId)).postable.map(String));
    const keep = (existing || []).map(String).filter((id) => !mine.has(id));
    if (!wanted.length && !keep.length) return { ok: false, message: 'Choose at least one section' };
    if (wanted.some((id) => !mine.has(id))) {
        return { ok: false, message: 'You can only share with sections you teach' };
    }
    return { ok: true, sections: [...keep, ...wanted] };
}

exports.teacherUpload = async (req, res) => {
    let created = false;
    try {
        const b = req.body;
        if (!b.title?.trim()) return refuse(req, res, 'Title is required');
        if (!b.category)      return refuse(req, res, 'Category is required');

        // `sectionIds` is the array the form posts; `sectionId` is the single
        // value older callers send, and still works.
        const target = await ownSections(req, b.sectionIds !== undefined ? b.sectionIds : b.sectionId);
        if (!target.ok) return refuse(req, res, target.message);

        const files    = buildFileObjects(req.files);
        const assigned = flag(b.isAssignment);
        if (assigned && !files.length) return refuse(req, res, NEEDS_FILE, 400, 'NEEDS_FILE');
        const due = assigned ? dueAt(b.dueDate) : null;
        if (due === undefined) return refuse(req, res, 'That due date is not a date');

        const total = Number(b.totalMarks) > 0 ? Number(b.totalMarks) : null;
        const doc = await Document.create({
            school: req.schoolId,
            title:  b.title.trim(),
            description: b.description || '',
            category: b.category,
            // Stamped here too, so a teacher's upload lands on the admin's tabs
            // and year filter alongside everything else.
            docType: normalizeDocType(b.docType, assigned),
            subject: b.subject || '',
            files,
            uploadedBy:   req.userId,
            uploaderRole: 'teacher',
            // One document across every section it was set for, not a copy per
            // section — a teacher who takes 9-A and 9-B sets the homework once
            // and marks it in one place.
            targetType:   'class_sections',
            targetSections: target.sections,
            tags: tagList(b.tags),
            academicYear:    await currentAcademicYearId(req.schoolId),
            isAssignment:    assigned,
            assignmentType:  assigned && ASSIGNMENT_TYPES.includes(b.assignmentType) ? b.assignmentType : 'homework',
            // A breakdown splits the "Out of" — with none there are no marks to
            // split (an assignment set without marks takes feedback only).
            questions:       assigned && total != null ? parseQuestions(b.questions) : [],
            dueDate:         due,
            allowSubmission: assigned ? (b.allowSubmission === undefined ? true : flag(b.allowSubmission)) : false,
            marksEnabled:    assigned && total != null,
            totalMarks:      assigned ? total : null,
        });
        created = true;
        announce(doc, req);
        res.status(201).json({ success: true, data: clean(doc) });
    } catch (e) {
        if (!created) access.discardUploads(req);
        res.status(500).json({ success: false, message: e.message });
    }
};

/** One document, for a reader the route has already let through. */
exports.teacherGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherEditDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return refuse(req, res, 'Document not found', 404);
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return refuse(req, res, 'Document not found', 404);

        const b = req.body;
        if (b.title !== undefined) {
            if (!String(b.title).trim()) return refuse(req, res, 'Title is required');
            doc.title = String(b.title).trim();
        }
        if (b.description !== undefined) doc.description = b.description;
        if (b.category !== undefined) {
            if (!b.category) return refuse(req, res, 'Category is required');
            doc.category = b.category;
        }
        if (b.subject !== undefined) doc.subject = b.subject;

        // Only a document shared by section is the teacher's to re-aim; one the
        // office set up for them some other way keeps its audience.
        if (b.sectionIds !== undefined && doc.targetType === 'class_sections') {
            const target = await ownSections(req, b.sectionIds, doc.targetSections);
            if (!target.ok) return refuse(req, res, target.message);
            doc.targetSections = target.sections;
        }

        const wrong = applyAssignment(doc, b);
        if (wrong) return refuse(req, res, wrong);

        const had   = plainFiles(doc.files);
        const after = filesAfterEdit(doc, req);
        if (!after.ok) return refuse(req, res, after.message);
        if (after.changed) {
            doc.files = after.files;
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        if (doc.isAssignment && !doc.files?.length) return refuse(req, res, NEEDS_FILE, 400, 'NEEDS_FILE');

        await saveEdited(doc, req, had, after.changed);
        res.json({ success: true, data: clean(doc) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherDeleteDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        // The discussion goes too — it used to be left behind, its attachments
        // still openable under a document that no longer existed.
        await wipe([doc]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: one document, and handing work in ───────────────────────────────

const shapeSubmission = (s) => (s ? {
    _id: s._id, status: s.status, submittedAt: s.submittedAt, marks: s.marks ?? null,
    feedback: s.feedback || '', reviewedAt: s.reviewedAt || null,
    questionScores: Array.isArray(s.questionScores) ? s.questionScores : [],
    files: access.publicFiles(s.files),
} : null);

exports.studentGetDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        if (!(await canStudentViewDocument(doc, req.userId))) {
            return res.status(403).json({ success: false, message: 'This document was not shared with you' });
        }

        const mySubmission = doc.isAssignment
            ? shapeSubmission(await AssignmentSubmission.findOne({ document: doc._id, student: req.userId }).lean())
            : null;
        res.json({ success: true, data: { ...clean(doc), mySubmission } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Hand work in, or replace what was handed in.
 *
 *   • Only against an assignment that is on this student's shelf and still
 *     open — the id alone used to be enough, shared with them or not.
 *   • At least one file.
 *   • Not once it has been marked: the marks and feedback describe the work
 *     that was read, and swapping the files under them made them describe
 *     something else.
 *   • After the due date it is late, including a replacement — the form says
 *     so before the student presses the button.
 */
exports.studentSubmitAssignment = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return refuse(req, res, 'Assignment not found', 404);
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isAssignment: true }).lean();
        if (!doc || doc.isArchived) return refuse(req, res, 'Assignment not found', 404);
        if (!(await canStudentViewDocument(doc, req.userId))) {
            return refuse(req, res, 'This assignment was not shared with you', 403);
        }
        if (!doc.allowSubmission) return refuse(req, res, 'Submissions are closed for this assignment', 400, 'CLOSED');

        const files = buildFileObjects(req.files);
        if (!files.length) return refuse(req, res, 'Attach at least one file');

        const before = await AssignmentSubmission.findOne({ document: doc._id, student: req.userId }).lean();
        if (before && (before.marks != null || before.reviewedAt)) {
            return refuse(req, res,
                'This has already been marked, so it can no longer be replaced. Ask your teacher if you need to hand it in again.',
                409, 'ALREADY_MARKED');
        }

        const late    = !!doc.dueDate && Date.now() > new Date(doc.dueDate).getTime();
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const sub     = await AssignmentSubmission.findOneAndUpdate(
            { document: doc._id, student: req.userId },
            { $set: {
                files, status: late ? 'late' : 'submitted', submittedAt: new Date(),
                section: profile?.currentSection || null, school: req.schoolId,
            } },
            { upsert: true, new: true },
        ).lean();

        const first = !before || !['submitted', 'late'].includes(before.status);
        if (before) access.removeUnreferenced(access.namesOf(before.files));

        // The person who set it hears that something has come in — once, not
        // again for every replacement.
        if (first && doc.uploadedBy) {
            const me = await User.findById(req.userId).select('name').lean();
            notify({
                school: req.schoolId, sender: req.userId, senderRole: 'student',
                title: '📥 Work handed in',
                body: `${me?.name || 'A student'} handed in "${doc.title}"${late ? ' — after the due date' : ''}.`,
                recipients: [doc.uploadedBy],
                link: { type: 'documents.item', entityId: doc._id },
            });
        }

        res.json({ success: true, data: shapeSubmission(sub), ...(late ? { message: 'Submitted late' } : {}) });
    } catch (e) {
        access.discardUploads(req);
        res.status(500).json({ success: false, message: e.message });
    }
};

// ── Parent: one document, with where each child stands on it ─────────────────

exports.parentGetDocument = async (req, res) => {
    try {
        if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        // Only what reaches one of their own children. This returned any
        // document in the school to any parent — staff notices included.
        const kids    = await require('../services/parentChildren').childrenOf(req.userId, req.schoolId, 'name');
        const reached = await access.studentsReached(doc._id, kids.map((k) => String(k._id)));
        if (!reached.length) return res.status(403).json({ success: false, message: 'This document was not shared with your child' });

        const subs = doc.isAssignment
            ? await AssignmentSubmission.find({ document: doc._id, student: { $in: reached } }).lean()
            : [];
        const children = kids.filter((k) => reached.includes(String(k._id))).map((k) => {
            const sub = subs.find((s) => String(s.student) === String(k._id)) || null;
            const s = shapeSubmission(sub);
            // A parent reads how it went, not the work itself.
            if (s) delete s.files;
            return { _id: k._id, name: k.name, submission: s };
        });
        res.json({ success: true, data: { ...clean(doc), forChildren: reached, children } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.dueAt = dueAt;
exports.OTHER_MARKS = OTHER_MARKS;
