'use strict';
/**
 * Video Learning — who may see, release and watch what. Every screen and
 * every playback request asks here; nothing a browser sends (a school, class,
 * section, student or teacher id) is believed until it is checked against
 * what the signed-in person really is.
 *
 *   A STUDENT sees the books assigned to the class and section they are in
 *   today (the section roster — the same source attendance and exams read),
 *   and may watch a video only while a release of their section covers it.
 *   Move them to another section and their books and releases move with them.
 *
 *   A TEACHER works with a book only in the sections where they are the
 *   subject teacher of the school subject the book was selected for
 *   (SectionSubjectTeacher — the ERP's own teacher ↔ section ↔ subject link).
 *
 * One definition of "released" lives here (`LIVE` + `itemsJoin`) and is used
 * by the student's screens, playback authorisation and every report, so they
 * cannot disagree about what a student was given.
 */
const { q, T, forbidden } = require('./common');

/** A release that is open at this moment (alias r). */
const LIVE = `r."status" IN ('scheduled', 'active') AND r."releaseAt" <= now() AND (r."expiresAt" IS NULL OR r."expiresAt" > now())`;

/**
 * From releases `r` to the chapter videos they open: the book must still be
 * followed by the release's section, and the book, chapter, mapping and video
 * must all be live. Adds aliases k (book), ch (chapter), cv (mapping), v (video).
 */
const itemsJoin = `
    JOIN ${T.book} k ON k."_id" = r."book" AND k."status" IN ('active', 'archived')
    JOIN ${T.chapter} ch ON ch."book" = k."_id" AND ch."status" = 'active' AND (r."level" = 'book' OR ch."_id" = r."chapter")
    JOIN ${T.chapterVideo} cv ON cv."chapter" = ch."_id" AND cv."isActive" AND (r."level" <> 'video' OR cv."_id" = r."chapterVideo")
    JOIN ${T.video} v ON v."_id" = cv."video" AND v."isActive" AND v."processingStatus" = 'ready'`;

/** The release's section still follows the release's book (alias r). */
const stillAssigned = `EXISTS (SELECT 1 FROM ${T.assignment} a WHERE a."book" = r."book" AND a."class" = r."class"
                                  AND a."status" = 'active' AND (a."section" IS NULL OR a."section" = r."section"))`;

// ── Students ─────────────────────────────────────────────────────────────────

/**
 * Where a student is now: school, year, class and section — from the section
 * roster of an active year, falling back to their own record's section.
 * `section` is null for a student not placed in a section yet.
 */
async function studentContext(user) {
    const schoolId = String(user.school?._id || user.school || '');
    const userId = String(user._id);
    const base = { userId, schoolId, section: null, class: null, academicYear: null, sectionName: '', className: '', classNumber: null, yearName: '' };
    if (!schoolId) return base;
    const pick = `cs."_id" AS "section", cs."class", cs."academicYear", cs."sectionName", c."className", c."classNumber", y."yearName"`;
    let rows = await q(`
        SELECT ${pick}
          FROM ${T.section} cs
          JOIN ${T.year} y ON y."_id" = cs."academicYear" AND y."status" = 'active'
          JOIN ${T.class} c ON c."_id" = cs."class"
         WHERE cs."school" = $1 AND cs."enrolledStudents" ? $2
         ORDER BY y."startDate" DESC LIMIT 1`, [schoolId, userId]);
    if (!rows.length) {
        rows = await q(`
            SELECT ${pick}
              FROM ${T.studentProfile} sp
              JOIN ${T.section} cs ON cs."_id" = sp."currentSection" AND cs."school" = $1
              JOIN ${T.year} y ON y."_id" = cs."academicYear" AND y."status" = 'active'
              JOIN ${T.class} c ON c."_id" = cs."class"
             WHERE sp."user" = $2 LIMIT 1`, [schoolId, userId]);
    }
    return rows.length ? { ...base, ...rows[0] } : base;
}

/** The books a student's class and section follow, with the subject each is for. */
async function studentBooks(ctx, { book = null } = {}) {
    if (!ctx.section) return [];
    const params = [ctx.schoolId, ctx.class, ctx.section];
    if (book) params.push(book);
    return q(`
        SELECT DISTINCT ON (k."_id") k."_id", k."title", k."publisher", k."author", k."edition", k."coverUrl", k."language", k."description", k."classLevel",
               k."displayOrder", a."lmsSubject", a."schoolSubject", ls."name" AS "subjectName", ss."subjectName" AS "schoolSubjectName"
          FROM ${T.assignment} a
          JOIN ${T.book} k ON k."_id" = a."book" AND k."status" IN ('active', 'archived')
          JOIN ${T.subject} ls ON ls."_id" = a."lmsSubject"
          LEFT JOIN ${T.schoolSubjectRow} ss ON ss."_id" = a."schoolSubject"
         WHERE a."school" = $1 AND a."class" = $2 AND a."status" = 'active' AND (a."section" IS NULL OR a."section" = $3)
           ${book ? 'AND k."_id" = $4' : ''}
         ORDER BY k."_id"`, params);
}

/**
 * Every chapter video the student may watch right now — one row each, with
 * the release that opens it. Narrow it with { book, chapter, chapterVideo }.
 */
async function entitledItems(ctx, { book = null, chapter = null, chapterVideo = null } = {}) {
    if (!ctx.section) return [];
    const params = [ctx.schoolId, ctx.section, ctx.userId];
    const more = [];
    if (book) { params.push(book); more.push(`r."book" = $${params.length}`); }
    if (chapter) { params.push(chapter); more.push(`ch."_id" = $${params.length}`); }
    if (chapterVideo) { params.push(chapterVideo); more.push(`cv."_id" = $${params.length}`); }
    return q(`
        SELECT DISTINCT ON (cv."_id")
               cv."_id" AS "chapterVideo", cv."chapter", cv."book", cv."video", cv."displayOrder",
               r."_id" AS "release", r."createdBy" AS "releasedBy", r."releaseAt", r."expiresAt",
               r."class", r."section", r."academicYear", r."schoolSubject", r."lmsSubject",
               v."title", v."description", v."durationSec", v."thumbnailUrl", v."thumbnailKey", v."provider", v."language"
          FROM ${T.release} r
          ${itemsJoin}
         WHERE r."school" = $1 AND r."section" = $2 AND ${LIVE} AND ${stillAssigned}
           AND (r."audience" = 'all' OR r."students" ? $3)
           ${more.length ? `AND ${more.join(' AND ')}` : ''}
         ORDER BY cv."_id", r."releaseAt"`, params);
}

// ── Teachers ─────────────────────────────────────────────────────────────────

/**
 * The (section, school subject) pairs a teacher takes this year, each with the
 * books that section follows for that subject.
 */
async function teacherScope(user) {
    const schoolId = String(user.school?._id || user.school || '');
    const pairs = await q(`
        SELECT sst."section", sst."subject" AS "schoolSubject", cs."class", cs."academicYear", cs."sectionName",
               c."className", c."classNumber", s."subjectName", y."yearName",
               COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END), 0) AS "studentCount"
          FROM ${T.sectionTeacher} sst
          JOIN ${T.section} cs ON cs."_id" = sst."section" AND cs."school" = $1
          JOIN ${T.year} y ON y."_id" = cs."academicYear" AND y."status" = 'active'
          JOIN ${T.class} c ON c."_id" = cs."class"
          JOIN ${T.schoolSubjectRow} s ON s."_id" = sst."subject"
         WHERE sst."teacher" = $2
         ORDER BY c."classNumber", cs."sectionName", lower(s."subjectName")`, [schoolId, String(user._id)]);
    if (!pairs.length) return { schoolId, pairs: [], assignments: [] };
    const assignments = await q(`
        SELECT a."_id" AS "assignment", a."book", a."class", a."section" AS "assignedSection", a."schoolSubject", a."lmsSubject", a."academicYear",
               p.section AS "section"
          FROM ${T.assignment} a
          JOIN unnest($2::uuid[], $3::uuid[], $4::uuid[]) AS p(section, class, subject)
            ON p.class = a."class" AND p.subject = a."schoolSubject" AND (a."section" IS NULL OR a."section" = p.section)
         WHERE a."school" = $1 AND a."status" = 'active'`,
    [schoolId, pairs.map((p) => p.section), pairs.map((p) => p.class), pairs.map((p) => p.schoolSubject)]);
    return { schoolId, pairs, assignments };
}

/** The teacher's assignment of `book` to `section`, or a 403. */
function teacherAssignment(scope, sectionId, bookId) {
    const hit = scope.assignments.find((a) => String(a.section) === String(sectionId) && String(a.book) === String(bookId));
    if (!hit) throw forbidden('You can release a book only to the sections where you teach its subject', 'OUT_OF_SCOPE');
    const pair = scope.pairs.find((p) => String(p.section) === String(sectionId) && String(p.schoolSubject) === String(hit.schoolSubject));
    return { ...hit, pair };
}

/** Does the teacher take this school subject in this section today? */
const teaches = (scope, sectionId, schoolSubjectId) => scope.pairs.some((p) => String(p.section) === String(sectionId) && String(p.schoolSubject) === String(schoolSubjectId));

/** The active students on a section's roster: [{ _id, name, rollNumber }]. School-scoped. */
async function roster(schoolId, sectionId) {
    return q(`
        SELECT u."_id", u."name", sp."rollNumber", sp."admissionNumber"
          FROM ${T.section} cs
          CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(sid)
          JOIN ${T.user} u ON u."_id"::text = e.sid AND u."role" = 'student' AND u."isActive" IS NOT FALSE AND u."school" = cs."school"
          LEFT JOIN ${T.studentProfile} sp ON sp."user" = u."_id"
         WHERE cs."_id" = $2 AND cs."school" = $1
         ORDER BY NULLIF(regexp_replace(COALESCE(sp."rollNumber"::text, ''), '[^0-9]', '', 'g'), '')::numeric NULLS LAST, lower(u."name")`, [schoolId, sectionId]);
}

module.exports = { LIVE, itemsJoin, stillAssigned, studentContext, studentBooks, entitledItems, teacherScope, teacherAssignment, teaches, roster };
