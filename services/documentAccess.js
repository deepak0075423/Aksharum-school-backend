'use strict';
/**
 * Who a document reaches, and who may open what hangs off it (Nov 2026).
 *
 * One place, because four readers used to answer the question four ways and
 * disagreed: the student's and parent's lists, the admin's roster, the route
 * guards, and the rule in front of the files themselves — which let anyone
 * signed in at the school open any file whose address they had.
 *
 * WHERE A STUDENT SITS IS A FACT PER ACADEMIC YEAR (models/StudentEnrollment).
 * A document belongs to a year, so it reaches the students who were in its
 * class or section IN THAT YEAR — not whoever sits in a section of the same
 * name today. Reading the profile's current-section pointer instead emptied
 * every roster after a rollover and showed this year's Class 7 - A last year's
 * Class 7 - A homework. The pointer is still the answer for a document filed
 * under no year, and for a student whose enrolment row has not been written.
 */
const fs   = require('fs');
const path = require('path');
const pool = require('../db/pool');

const Document             = require('../models/Document');
const DocumentVersion      = require('../models/DocumentVersion');
const DocumentComment      = require('../models/DocumentComment');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const StudentEnrollment    = require('../models/StudentEnrollment');
const StudentProfile       = require('../models/StudentProfile');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const AcademicYear         = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const User                 = require('../models/User');

const qt = (Model) => `"${Model.tableName}"`;
const ids = (list) => (list || []).map(String).filter(Boolean);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID.test(String(v ?? ''));

/** A jsonb column as an array, whatever was stored in it. */
const ARR = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

// ── Files ────────────────────────────────────────────────────────────────────

const FOLDER = path.join(__dirname, '..', 'uploads', 'documents');

/** What is stored for one uploaded file. The path is the address under the server root, never the disk path. */
function storedFiles(files) {
    return (files || []).map((f) => ({
        originalName: f.originalname,
        storedName:   f.filename,
        filePath:     `uploads/documents/${f.filename}`,
        mimeType:     f.mimetype,
        fileSize:     f.size,
    }));
}

/**
 * Files as a client reads them. Rows written before Nov 2026 hold the server's
 * own disk path (`/var/www/…/uploads/documents/x.pdf`), which told every
 * reader how the machine is laid out; what goes out is the address alone.
 */
function publicFiles(files) {
    return (Array.isArray(files) ? files : []).filter(Boolean).map((f) => ({
        originalName: f.originalName,
        storedName:   f.storedName,
        filePath:     f.storedName ? `uploads/documents/${f.storedName}` : '',
        mimeType:     f.mimeType,
        fileSize:     f.fileSize,
    }));
}

/** The files a refused request brought with it — multer has already written them. */
function discardUploads(req) {
    const list = Array.isArray(req?.files) ? req.files : Object.values(req?.files || {}).flat();
    for (const f of [req?.file, ...list]) if (f?.path) fs.promises.unlink(f.path).catch(() => {});
}

/**
 * Take files off the disk once nothing points at them.
 *
 * A duplicate shares its original's files, and an earlier version keeps the
 * ones an edit replaced, so a file goes only when no document, version,
 * comment or submission still names it.
 */
async function removeUnreferenced(names) {
    const wanted = [...new Set(ids(names))].filter((n) => /^[\w.-]+$/.test(n) && !n.startsWith('.'));
    for (const name of wanted) {
        try {
            const { rows } = await pool.query(
                `SELECT 1 FROM ${qt(Document)} WHERE "files" @> $1::jsonb
                 UNION ALL SELECT 1 FROM ${qt(DocumentVersion)} WHERE "files" @> $1::jsonb
                 UNION ALL SELECT 1 FROM ${qt(DocumentComment)} WHERE "files" @> $1::jsonb
                 UNION ALL SELECT 1 FROM ${qt(AssignmentSubmission)} WHERE "files" @> $1::jsonb
                 LIMIT 1`,
                [holds(name)],
            );
            if (!rows.length) await fs.promises.unlink(path.join(FOLDER, name)).catch(() => {});
        } catch (e) { console.error('[documents] file cleanup:', e.message); }
    }
}

const namesOf = (files) => (Array.isArray(files) ? files : []).map((f) => f?.storedName).filter(Boolean);

/**
 * "Holds a file stored under this name", as the jsonb a `"files" @> $1` asks
 * with — answered from the gin indexes db/migrate.js creates, where the
 * `"files"::text LIKE` it replaces read every row of four tables.
 */
function holds(name) { return JSON.stringify([{ storedName: String(name) }]); }

/** What the first bytes of a file are, for the kinds that can be told apart. */
function sniff(buf) {
    if (!buf || buf.length < 4) return null;
    const head = buf.slice(0, 8);
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'heif';
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';     // docx, xlsx, pptx
    if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';      // doc, xls, ppt
    return null;
}

const KIND_OF_EXT = {
    pdf: 'pdf', jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', heic: 'heif', heif: 'heif',
    docx: 'zip', xlsx: 'zip', pptx: 'zip', doc: 'ole', xls: 'ole', ppt: 'ole',
};

/**
 * Route middleware, after multer: every upload has to BE what its name says.
 *
 * The filter in middleware/upload.js reads the extension alone, so a page of
 * script renamed "notes.pdf" went straight onto the shelf. Text files have no
 * signature to check; they are refused only when they are not text at all.
 * Each file is then put through the virus scanner, where one is set up.
 */
async function checkUploads(req, res, next) {
    try {
        const list = Array.isArray(req.files) ? req.files : [];
        for (const f of list) {
            const ext = path.extname(f.originalname || '').slice(1).toLowerCase();
            const fd = await fs.promises.open(f.path, 'r');
            const buf = Buffer.alloc(4100);
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            await fd.close();
            const head = buf.slice(0, bytesRead);
            const want = KIND_OF_EXT[ext];
            const bad = !bytesRead ? `${f.originalname} is empty`
                : want ? (sniff(head) !== want ? `${f.originalname} is not a real ${ext.toUpperCase()} file — it may be damaged or renamed` : '')
                    : (head.includes(0) ? `${f.originalname} is not a text file` : '');
            if (bad) {
                discardUploads(req);
                return res.status(400).json({ success: false, code: 'BAD_FILE', message: bad });
            }

            // The same ClamAV daemon admission uploads go through
            // (services/admission/virusScan.js): on once CLAMAV_HOST is set.
            // A file is refused when clamd names a virus in it — and, with
            // CLAMAV_REQUIRED, when clamd cannot be asked at all.
            const virus = require('./admission/virusScan');
            const scan = await virus.scanFile(f.path);
            if (scan.status === 'infected') {
                console.warn(`[documents] upload refused — ${scan.signature} in ${f.originalname} (user ${req.userId})`);
                discardUploads(req);
                return res.status(400).json({
                    success: false, code: 'INFECTED_FILE',
                    message: `${f.originalname} was not attached — the virus check found ${scan.signature} in it`,
                });
            }
            if (scan.status === 'unavailable' && virus.config().required) {
                discardUploads(req);
                return res.status(503).json({
                    success: false, code: 'SCAN_UNAVAILABLE',
                    message: 'Files cannot be checked for viruses just now — try again in a few minutes',
                });
            }
        }
        return next();
    } catch (e) {
        discardUploads(req);
        return res.status(400).json({ success: false, code: 'BAD_FILE', message: 'One of the files could not be read — try attaching it again' });
    }
}

// ── Years ────────────────────────────────────────────────────────────────────

/**
 * The year a document is filed under: the school's active year, or — with none
 * marked active — the year whose window covers the date. Null rather than a
 * guess when neither answers.
 */
async function currentYearId(schoolId, at = new Date()) {
    const active = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    if (active) return active._id;
    const covering = await AcademicYear.findOne({
        school: schoolId, startDate: { $lte: at }, endDate: { $gte: at },
    }).lean();
    return covering?._id || null;
}

// ── Where students sit, year by year ─────────────────────────────────────────

/**
 * `place`: one row per (student, year) for the students in `$param::text[]`,
 * as a CTE. Every student also has one row with no placement at all, so a
 * school-wide document still reaches someone the office has not placed yet.
 *
 * `cur` marks the row a year-less document is judged by: the active year's, or
 * the one the profile's pointer rests on.
 */
function placeCte(param) {
    return `
      place AS (
        SELECT x.id::uuid AS "student", NULL::uuid AS "y", NULL::double precision AS "n",
               NULL::text AS "sec", NULL::uuid AS "section", false AS "placed", true AS "cur"
          FROM unnest(${param}::text[]) x(id)
        UNION ALL
        SELECT e."student", e."academicYear", c."classNumber", s."sectionName", e."section", true,
               (COALESCE(ey."status", '') = 'active' OR e."section" IS NOT DISTINCT FROM sp."currentSection")
          FROM ${qt(StudentEnrollment)} e
          JOIN ${qt(Class)} c             ON c."_id" = e."class"
          LEFT JOIN ${qt(ClassSection)} s ON s."_id" = e."section"
          LEFT JOIN ${qt(AcademicYear)} ey ON ey."_id" = e."academicYear"
          LEFT JOIN ${qt(StudentProfile)} sp ON sp."user" = e."student"
         WHERE e."student"::text = ANY(${param}::text[])
        UNION ALL
        SELECT sp."user", c."academicYear", c."classNumber", s."sectionName", s."_id", true, true
          FROM ${qt(StudentProfile)} sp
          JOIN ${qt(ClassSection)} s ON s."_id" = sp."currentSection"
          JOIN ${qt(Class)} c        ON c."_id" = s."class"
         WHERE sp."user"::text = ANY(${param}::text[])
           AND NOT EXISTS (
             SELECT 1 FROM ${qt(StudentEnrollment)} e
              WHERE e."student" = sp."user" AND e."academicYear" IS NOT DISTINCT FROM c."academicYear")
      )`;
}

/**
 * Which of the students in `place` document `d` reaches — a text[] of their
 * ids. Correlated: the query around it must name the document `d` and its
 * academic year `ay` (LEFT JOIN).
 *
 * Classes and sections are matched on (class number, section name), not on the
 * stored ids — a class row exists once per year, and a target picked from one
 * year's list must still mean "Class 9 - A" in the document's own year.
 */
const REACH = `
  ARRAY(
    SELECT DISTINCT p."student"::text
      FROM place p
     WHERE CASE d."targetType"
       WHEN 'whole_school' THEN
         (d."academicYear" IS NULL OR COALESCE(ay."status", '') = 'active' OR p."y" = d."academicYear")
       WHEN 'class' THEN
         p."placed"
         AND ((d."academicYear" IS NOT NULL AND p."y" = d."academicYear") OR (d."academicYear" IS NULL AND p."cur"))
         AND p."n" IN (
           SELECT tc."classNumber"
             FROM jsonb_array_elements_text(${ARR('d."targetClasses"')}) t(id)
             JOIN ${qt(Class)} tc ON tc."_id"::text = t.id)
       WHEN 'class_sections' THEN
         p."placed"
         AND ((d."academicYear" IS NOT NULL AND p."y" = d."academicYear") OR (d."academicYear" IS NULL AND p."cur"))
         AND (p."n", p."sec") IN (
           SELECT tc."classNumber", ts."sectionName"
             FROM jsonb_array_elements_text(${ARR('d."targetSections"')}) t(id)
             JOIN ${qt(ClassSection)} ts ON ts."_id"::text = t.id
             JOIN ${qt(Class)} tc        ON tc."_id" = ts."class")
       ELSE false
     END
  )`;

/** Of these students, the ones one document reaches. */
async function studentsReached(docId, studentIds) {
    const wanted = ids(studentIds).filter(isUuid);
    if (!wanted.length || !isUuid(docId)) return [];
    const { rows } = await pool.query(
        `WITH ${placeCte('$2')}
         SELECT ${REACH} AS "reaches"
           FROM ${qt(Document)} d
           LEFT JOIN ${qt(AcademicYear)} ay ON ay."_id" = d."academicYear"
          -- A draft has not been shared with anyone yet.
          WHERE d."_id" = $1 AND NOT COALESCE(d."isDraft", false)`,
        [String(docId), wanted],
    );
    return rows[0]?.reaches || [];
}

// ── Teachers ─────────────────────────────────────────────────────────────────

/**
 * The sections a teacher stands in front of.
 *
 *   • `sections` / `classes` — every year on record: what they may READ.
 *   • `postable` / `list` — this year's only, one per label: what they may
 *     share to. A class row exists once per year, so offering them all asks a
 *     teacher to choose between four chips called "Class 9 - A".
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

/** May this teacher open the document at all — their own, or one that reaches them. */
async function teacherCanRead(doc, teacherId, schoolId) {
    if (String(doc.uploadedBy) === String(teacherId)) return true;
    // Put away by the office, or not shared yet: on nobody's shelf but its owner's.
    if (doc.isArchived || doc.isDraft) return false;
    if (['all_teachers', 'whole_school'].includes(doc.targetType)) return true;
    if (doc.targetType === 'specific_teachers') return ids(doc.targetUsers).includes(String(teacherId));
    const reach = await teacherReach(teacherId, schoolId || doc.school);
    if (doc.targetType === 'class_sections') return ids(doc.targetSections).some((s) => reach.sections.includes(s));
    if (doc.targetType === 'class')          return ids(doc.targetClasses).some((c) => reach.classes.includes(c));
    return false;
}

// ── Everyone ─────────────────────────────────────────────────────────────────

const designations = () => require('./designationService');

/** Is the Documents module switched on for this school. */
async function moduleOn(schoolId) {
    try {
        const snap = await designations().getSnapshot(schoolId);
        return !snap || snap.moduleFlags?.document !== false;
    } catch { return true; }
}

/** The office: a school admin, or a teacher whose designation administers Documents. */
async function isOffice(viewer) {
    if (viewer.role === 'school_admin') return true;
    if (viewer.role !== 'teacher') return false;
    try {
        return (await designations().moduleAdminIds(viewer.sid, 'document')).map(String).includes(String(viewer.uid));
    } catch { return false; }
}

async function childIds(parentId, schoolId) {
    const kids = await require('./parentChildren').childrenOf(parentId, schoolId, '_id name');
    return kids.map((k) => String(k._id));
}

/**
 * May this person see the document.
 * `viewer` is { uid, role, sid } — the same shape services/privateFiles reads.
 */
async function canSeeDocument(viewer, doc) {
    if (!viewer || !doc || String(doc.school) !== String(viewer.sid)) return false;
    if (await isOffice(viewer)) return true;
    if (viewer.role === 'teacher') return teacherCanRead(doc, viewer.uid, viewer.sid);
    if (doc.isArchived || doc.isDraft) return false;
    if (viewer.role === 'student') return (await studentsReached(doc._id, [viewer.uid])).length > 0;
    if (viewer.role === 'parent') {
        const kids = await childIds(viewer.uid, viewer.sid);
        return (await studentsReached(doc._id, kids)).length > 0;
    }
    return false;
}

/** Does this teacher teach the section the student sat in for the document's year. */
async function teachesStudent(teacherId, schoolId, studentId, yearId) {
    const reach = await teacherReach(teacherId, schoolId);
    if (!reach.sections.length) return false;
    const { rows } = await pool.query(
        `SELECT 1 FROM ${qt(StudentEnrollment)} e
          WHERE e."student" = $1 AND e."section"::text = ANY($2::text[])
            AND ($3::uuid IS NULL OR e."academicYear" = $3::uuid)
         UNION ALL
         SELECT 1 FROM ${qt(StudentProfile)} sp
          WHERE sp."user" = $1 AND sp."currentSection"::text = ANY($2::text[])
          LIMIT 1`,
        [String(studentId), reach.sections, yearId ? String(yearId) : null],
    );
    return rows.length > 0;
}

/**
 * May this person open the file stored under `name`, and what it is called.
 *
 *   a document's file (or an earlier version's)  whoever can see the document
 *   a comment's attachment                       the same, and staff only when
 *                                                the comment is staff-only
 *   a student's submitted work                   the student, their parents,
 *                                                the office, the teacher who
 *                                                set it, and a teacher of the
 *                                                student's own section
 *
 * It used to be "anyone signed in at the school": a student could open a
 * classmate's submission, or a note the staff had kept among themselves, with
 * nothing but the address.
 */
async function fileAccess(viewer, name) {
    const out = { ok: false, originalName: '' };
    if (!viewer || !name) return out;
    const { rows } = await pool.query(
        `SELECT 'document' AS kind, d."_id" AS doc, NULL::uuid AS student, 'all' AS visibility, d."files"
           FROM ${qt(Document)} d WHERE d."files" @> $1::jsonb
         UNION ALL
         SELECT 'document', v."document", NULL::uuid, 'all', v."files"
           FROM ${qt(DocumentVersion)} v WHERE v."files" @> $1::jsonb
         UNION ALL
         SELECT 'comment', c."document", NULL::uuid, COALESCE(c."visibility", 'all'), c."files"
           FROM ${qt(DocumentComment)} c WHERE c."files" @> $1::jsonb
         UNION ALL
         SELECT 'submission', s."document", s."student", 'all', s."files"
           FROM ${qt(AssignmentSubmission)} s WHERE s."files" @> $1::jsonb`,
        [holds(name)],
    );
    if (!rows.length) return out;

    const docs = {};
    const docOf = async (id) => {
        const key = String(id);
        if (!(key in docs)) docs[key] = await Document.findById(key).lean();
        return docs[key];
    };
    const staff = viewer.role === 'school_admin' || viewer.role === 'teacher';

    for (const r of rows) {
        const hit = (Array.isArray(r.files) ? r.files : []).find((f) => f?.storedName === name);
        if (!hit) continue;
        const doc = await docOf(r.doc);
        if (!doc || String(doc.school) !== String(viewer.sid)) continue;

        let ok = false;
        if (r.kind === 'submission') {
            const student = String(r.student);
            if (viewer.uid === student) ok = true;
            else if (viewer.role === 'parent') ok = (await childIds(viewer.uid, viewer.sid)).includes(student);
            else if (await isOffice(viewer)) ok = true;
            else if (viewer.role === 'teacher') {
                ok = String(doc.uploadedBy) === String(viewer.uid)
                    || (await teacherCanRead(doc, viewer.uid, viewer.sid)
                        && await teachesStudent(viewer.uid, viewer.sid, student, doc.academicYear));
            }
        } else {
            ok = await canSeeDocument(viewer, doc);
            if (ok && r.kind === 'comment' && r.visibility === 'staff' && !staff) ok = false;
        }
        if (ok) return { ok: true, originalName: hit.originalName || '' };
        out.originalName = out.originalName || hit.originalName || '';
    }
    return out;
}

// ── Who to tell ──────────────────────────────────────────────────────────────

/**
 * Everyone a document was shared with, as user ids — for the notification that
 * says so. Students bring their parents with them; `about` is the students a
 * class document concerns, so a parent of two reads it under the right child.
 */
async function audience(doc) {
    const school = String(doc.school);
    const active = `u."school" = $1 AND COALESCE(u."isActive", true)`;
    const teachers = async () => (await pool.query(
        `SELECT u."_id" FROM ${qt(User)} u WHERE ${active} AND u."role" = 'teacher'`, [school],
    )).rows.map((r) => String(r._id));

    if (doc.targetType === 'all_teachers') return { recipients: await teachers(), about: null };
    if (doc.targetType === 'specific_teachers') return { recipients: ids(doc.targetUsers), about: null };

    const { rows } = await pool.query(
        `SELECT u."_id" FROM ${qt(User)} u WHERE ${active} AND u."role" = 'student'`, [school],
    );
    const everyone = rows.map((r) => String(r._id));
    const students = doc.targetType === 'whole_school'
        ? everyone
        : await studentsReached(doc._id, everyone);
    const { withParents } = require('./notifyService');
    const recipients = await withParents(students);
    if (doc.targetType === 'whole_school') {
        return { recipients: [...new Set([...recipients, ...(await teachers())])], about: null };
    }
    return { recipients, about: students };
}

module.exports = {
    isUuid, ARR,
    storedFiles, publicFiles, discardUploads, removeUnreferenced, namesOf, checkUploads,
    currentYearId, placeCte, REACH, studentsReached,
    teacherReach, teacherCanRead, teachesStudent,
    moduleOn, isOffice, childIds, canSeeDocument, fileAccess, audience,
};
