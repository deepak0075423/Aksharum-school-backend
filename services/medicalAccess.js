'use strict';
/**
 * Whose medical information a caller may see (Oct 2026).
 *
 *   medical staff   the school admin, and a teacher whose designation grants
 *                   ADMIN on `medical` (a nurse) — every student of the school.
 *                   The route guard (allowModuleAdmin) decides who they are.
 *   a teacher       the students of the sections they are attached to this
 *                   year — class teacher, vice, or a subject they teach there —
 *                   and only the slice the medical room shares with teachers.
 *   a student       themselves.
 *   a parent        their own children (services/parentChildren — both links,
 *                   re-checked against the school and the student role).
 *
 * Every lookup is school-scoped: an id from another school is "not found",
 * never "forbidden", so the answer does not confirm the record exists.
 */
const pool = require('../db/pool');
const { ownSections, taughtSections } = require('./teacherOwnSections');
const { childrenOf } = require('./parentChildren');
const { refuse, isUuid } = require('./medicalRules');

const T = {
    users: '"users"', profiles: '"studentprofiles"', sections: '"classsections"', classes: '"classes"', idcards: '"idcards"',
};

/**
 * The identity of students as every medical screen shows them: name, photo,
 * admission and roll number, class and section (the current placement — a
 * student admitted to a class but not yet placed in a section still names
 * the class), date of birth, gender and blood group.
 */
async function studentCards(schoolId, ids) {
    const list = [...new Set((ids || []).map(String).filter(isUuid))];
    if (!list.length) return new Map();
    const { rows } = await pool.query(
        `SELECT u."_id"::text AS "_id", u."name", u."profileImage" AS "photo", u."isActive",
                sp."admissionNumber", sp."rollNumber", sp."dob", sp."gender", sp."bloodGroup",
                sp."currentSection"::text AS "sectionId",
                COALESCE(cs."class", sp."currentClass")::text AS "classId",
                c."className", cs."sectionName"
           FROM ${T.users} u
           LEFT JOIN ${T.profiles} sp ON sp."user" = u."_id"
           LEFT JOIN ${T.sections} cs ON cs."_id" = sp."currentSection"
           LEFT JOIN ${T.classes} c ON c."_id" = COALESCE(cs."class", sp."currentClass")
          WHERE u."school" = $1 AND u."role" = 'student' AND u."_id"::text = ANY($2::text[])`,
        [String(schoolId), list],
    );
    return new Map(rows.map((r) => [r._id, {
        ...r,
        classLabel: [r.className, r.sectionName].filter(Boolean).join(' – '),
    }]));
}

async function studentCard(schoolId, id) {
    return (await studentCards(schoolId, [id])).get(String(id)) || null;
}

/** The student, or a 404 — for any id a caller hands us. */
async function assertStudent(schoolId, id, { current = false } = {}) {
    if (!isUuid(id)) refuse('Choose a student', 400, 'MEDICAL_NO_STUDENT');
    const card = await studentCard(schoolId, id);
    if (!card) refuse('Student not found', 404, 'MEDICAL_NOT_FOUND');
    // A student who has left keeps their record, read-only: nothing new is added to it.
    if (current && card.isActive === false) refuse(`${card.name} has left the school — the medical record is kept, but nothing new is added to it`, 409, 'MEDICAL_STUDENT_LEFT');
    return card;
}

/** The "Student ID" — the newest live ID card's number, when the school has issued one. */
async function studentCode(schoolId, id) {
    try {
        const { rows } = await pool.query(
            `SELECT "number" FROM ${T.idcards}
              WHERE "school" = $1 AND "holder" = $2 AND "kind" = 'student' AND "status" IN ('active', 'blocked')
              ORDER BY "issuedAt" DESC LIMIT 1`,
            [String(schoolId), String(id)],
        );
        return rows[0]?.number || '';
    } catch { return ''; }
}

/**
 * A teacher's sections this year and the students in them.
 *
 * A student counts as in a section through either source of membership —
 * the section's roster or the student's own pointer — because the two drift
 * (see the class pages), and a teacher must not lose a child's allergy alert
 * to that drift.
 */
async function teacherScope(schoolId, teacherId) {
    const { sections: own, current } = await ownSections(schoolId, teacherId);
    const taught = await taughtSections(schoolId, teacherId, current);
    const byId = new Map();
    for (const s of own) {
        byId.set(String(s._id), { section: s, role: String(s.classTeacher) === String(teacherId) ? 'Class teacher' : 'Vice class teacher' });
    }
    for (const s of taught.sections) if (!byId.has(String(s._id))) byId.set(String(s._id), { section: s, role: 'Subject teacher' });
    const sectionIds = [...byId.keys()];
    if (!sectionIds.length) return { sections: [], studentIds: new Set(), sectionOf: new Map() };

    const { rows } = await pool.query(
        `WITH secs AS (SELECT unnest($2::text[]) AS id)
         SELECT DISTINCT x."student", x."section" FROM (
             SELECT e.id AS "student", cs."_id"::text AS "section"
               FROM ${T.sections} cs
              CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(id)
              WHERE cs."_id"::text IN (SELECT id FROM secs)
             UNION
             SELECT sp."user"::text, sp."currentSection"::text
               FROM ${T.profiles} sp
              WHERE sp."currentSection"::text IN (SELECT id FROM secs)
         ) x
         JOIN ${T.users} u ON u."_id"::text = x."student" AND u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE`,
        [String(schoolId), sectionIds],
    );
    const classIds = [...new Set([...byId.values()].map((v) => String(v.section.class)))];
    const { rows: classes } = classIds.length
        ? await pool.query(`SELECT "_id"::text AS id, "className", "classNumber" FROM ${T.classes} WHERE "_id"::text = ANY($1::text[])`, [classIds])
        : { rows: [] };
    const className = new Map(classes.map((c) => [c.id, c.className]));
    const classNumber = new Map(classes.map((c) => [c.id, Number(c.classNumber) || 0]));
    const sectionOf = new Map();
    for (const r of rows) if (!sectionOf.has(r.student)) sectionOf.set(r.student, r.section);
    const sections = [...byId.entries()].map(([id, v]) => ({
        _id: id,
        className: className.get(String(v.section.class)) || '',
        sectionName: v.section.sectionName || '',
        role: v.role,
        count: rows.filter((r) => r.section === id).length,
        classNumber: classNumber.get(String(v.section.class)) || 0,
    })).sort((a, b) => (a.classNumber - b.classNumber) || a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName));
    return { sections, studentIds: new Set(rows.map((r) => r.student)), sectionOf };
}

/** The students a student or parent may see: themselves, or their children. */
async function familyIds(req) {
    if (req.userRole === 'student') return [String(req.userId)];
    if (req.userRole === 'parent') return (await childrenOf(req.userId, req.schoolId)).map((k) => String(k._id));
    return [];
}

/** For a parent or student: the child asked for, or the first one — refusing anyone else's. */
async function familyChild(req, wanted) {
    const ids = await familyIds(req);
    if (!ids.length) refuse(req.userRole === 'parent' ? 'No child is linked to your account' : 'Student not found', 404, 'MEDICAL_NO_CHILD');
    if (wanted && !ids.includes(String(wanted))) refuse('Student not found', 404, 'MEDICAL_NOT_FOUND');
    return wanted ? String(wanted) : ids[0];
}

/** Every student of the school, as ids (for school-wide figures). */
async function schoolStudentCount(schoolId) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${T.users} WHERE "school" = $1 AND "role" = 'student' AND "isActive" IS NOT FALSE`,
        [String(schoolId)],
    );
    return rows[0]?.n || 0;
}

/**
 * Student search for pickers: name, admission number, or "8 B" / "Class VIII-B".
 * Identity only — no medical information ever rides on a picker.
 */
async function searchStudents(schoolId, q, { limit = 20, onlyIds = null } = {}) {
    const term = String(q || '').trim().slice(0, 60);
    const params = [String(schoolId)];
    const where = [`u."school" = $1`, `u."role" = 'student'`, `u."isActive" IS NOT FALSE`];
    if (term) {
        params.push(`%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
        const p = `$${params.length}`;
        where.push(`(u."name" ILIKE ${p} OR sp."admissionNumber" ILIKE ${p} OR (c."className" || ' ' || COALESCE(cs."sectionName", '')) ILIKE ${p}
                     OR (c."className" || '-' || COALESCE(cs."sectionName", '')) ILIKE ${p})`);
    }
    if (onlyIds) {
        params.push([...onlyIds].map(String));
        where.push(`u."_id"::text = ANY($${params.length}::text[])`);
    }
    params.push(Math.min(50, Math.max(1, limit)));
    const { rows } = await pool.query(
        `SELECT u."_id"::text AS "_id", u."name", u."profileImage" AS "photo",
                sp."admissionNumber", sp."rollNumber", c."className", cs."sectionName"
           FROM ${T.users} u
           LEFT JOIN ${T.profiles} sp ON sp."user" = u."_id"
           LEFT JOIN ${T.sections} cs ON cs."_id" = sp."currentSection"
           LEFT JOIN ${T.classes} c ON c."_id" = COALESCE(cs."class", sp."currentClass")
          WHERE ${where.join(' AND ')}
          ORDER BY u."name" ASC
          LIMIT $${params.length}`,
        params,
    );
    return rows.map((r) => ({ ...r, classLabel: [r.className, r.sectionName].filter(Boolean).join(' – ') }));
}

module.exports = {
    studentCards, studentCard, assertStudent, studentCode, teacherScope, familyIds, familyChild,
    schoolStudentCount, searchStudents,
};
