'use strict';
/**
 * Who should carry an ID card, and what theirs would say if it were issued
 * today (Oct 2026).
 *
 * Three readers — students of an academic year, employees, parents — each one
 * SQL statement for the whole school, so a list of two thousand students is
 * one round trip. From a reader's row, `snapshotOf` builds exactly what a card
 * prints; the same function builds the card at issue and the comparison later,
 * which is how "this card is out of date" can never disagree with what a fresh
 * card would say (`diff`).
 *
 * A student's class and section are the year's, not today's: the year's own
 * section roster is the record (a student promoted to VIII-B in 2027-28 is
 * still in VII-A's roster for 2026-27), with the profile's pointer preferred
 * when it is in that year, and a class with no section yet ("admitted, not
 * placed") still counted. The roll number is only the profile's when the
 * profile's section IS that year's — last year's roll is not on record.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const ParentProfile = require('../models/ParentProfile');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const { FIELDS } = require('./idCardDesign');
const { dayKey } = require('./idCardRules');

const T = {
    users: `"${User.tableName}"`,
    sp: `"${StudentProfile.tableName}"`,
    tp: `"${TeacherProfile.tableName}"`,
    pp: `"${ParentProfile.tableName}"`,
    sections: `"${ClassSection.tableName}"`,
    classes: `"${Class.tableName}"`,
    years: `"${AcademicYear.tableName}"`,
    sst: `"${SectionSubjectTeacher.tableName}"`,
};
const UUID_TEXT = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
const jsonArr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;
const ids = (list) => (Array.isArray(list) && list.length ? [...new Set(list.map(String))] : null);

/* ── Students of a year ──────────────────────────────────────────────────── */

/**
 * Every student placed in `yearId` (or only `holderIds` of them).
 *   → [{ _id, name, isActive, photoSource, admissionNumber, rollNumber, dob,
 *        bloodGroup, gender, classId, className, classNumber, sectionId,
 *        sectionName, parentName, emergencyPhone, address }]
 */
async function studentsOfYear(schoolId, yearId, { holderIds } = {}) {
    const only = ids(holderIds);
    const { rows } = await pool.query(`
        WITH secs AS (
            SELECT s."_id", s."class", s."enrolledStudents"
              FROM ${T.sections} s
             WHERE s."school" = $1::uuid AND s."academicYear" = $2::uuid
        ),
        placed AS (
            SELECT sp."user" AS "student", s."_id" AS "section", s."class" AS "class", 0 AS "rank"
              FROM ${T.sp} sp JOIN secs s ON s."_id" = sp."currentSection"
             WHERE sp."school" = $1::uuid
            UNION ALL
            SELECT e.id::uuid, s."_id", s."class", 1
              FROM secs s
             CROSS JOIN LATERAL jsonb_array_elements_text(${jsonArr('s."enrolledStudents"')}) AS e(id)
             WHERE e.id ~ ${UUID_TEXT}
            UNION ALL
            SELECT sp."user", NULL::uuid, c."_id", 2
              FROM ${T.sp} sp JOIN ${T.classes} c ON c."_id" = sp."currentClass" AND c."academicYear" = $2::uuid
             WHERE sp."school" = $1::uuid
        ),
        member AS (
            SELECT DISTINCT ON ("student") "student", "section", "class" FROM placed ORDER BY "student", "rank"
        )
        SELECT u."_id"::text AS "_id", u."name", u."isActive", u."profileImage",
               sp."photoFile", sp."admissionNumber", sp."rollNumber", sp."currentSection"::text AS "currentSection",
               sp."bloodGroup", sp."gender",
               to_char((sp."dob" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "dob",
               sp."address", sp."city", sp."state", sp."pincode",
               sp."emergencyContactPhone",
               m."section"::text AS "sectionId", cs."sectionName",
               m."class"::text AS "classId", c."className", c."classNumber",
               pu."name" AS "parentUserName", pu."phone" AS "parentPhone"
          FROM member m
          JOIN ${T.users} u ON u."_id" = m."student" AND u."role" = 'student' AND u."school" = $1::uuid
          LEFT JOIN LATERAL (SELECT * FROM ${T.sp} x WHERE x."user" = u."_id" ORDER BY x."createdAt" ASC LIMIT 1) sp ON true
          LEFT JOIN ${T.sections} cs ON cs."_id" = m."section"
          LEFT JOIN ${T.classes} c ON c."_id" = m."class"
          LEFT JOIN ${T.users} pu ON pu."_id" = sp."parent"
         WHERE ($3::uuid[] IS NULL OR u."_id" = ANY($3::uuid[]))`,
    [String(schoolId), String(yearId), only]);
    return rows.map((r) => ({
        _id: r._id,
        name: r.name || '',
        isActive: r.isActive !== false,
        photoSource: r.photoFile ? `/uploads/student-docs/${r.photoFile}` : (r.profileImage || ''),
        admissionNumber: r.admissionNumber || '',
        // Only this year's roll is on record: the profile's, when its section is this year's.
        rollNumber: r.sectionId && r.currentSection === r.sectionId ? String(r.rollNumber || '') : '',
        dob: r.dob || '',
        bloodGroup: r.bloodGroup || '',
        gender: r.gender || '',
        classId: r.classId || null,
        className: r.className || '',
        classNumber: r.classNumber ?? null,
        sectionId: r.sectionId || null,
        sectionName: r.sectionName || '',
        parentName: r.parentUserName || '',
        emergencyPhone: r.emergencyContactPhone || r.parentPhone || '',
        address: [r.address, r.city, r.state, r.pincode].map((x) => String(x || '').trim()).filter(Boolean).join(', '),
    }));
}

/** Students with a card, read by id whatever year they are in now — for rows a roster no longer has. */
async function studentsById(schoolId, holderIds) {
    const only = ids(holderIds);
    if (!only) return [];
    const { rows } = await pool.query(`
        SELECT u."_id"::text AS "_id", u."name", u."isActive", u."profileImage", sp."photoFile", sp."admissionNumber"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT * FROM ${T.sp} x WHERE x."user" = u."_id" ORDER BY x."createdAt" ASC LIMIT 1) sp ON true
         WHERE u."school" = $1::uuid AND u."role" = 'student' AND u."_id" = ANY($2::uuid[])`, [String(schoolId), only]);
    return rows.map((r) => ({
        _id: r._id, name: r.name || '', isActive: r.isActive !== false,
        photoSource: r.photoFile ? `/uploads/student-docs/${r.photoFile}` : (r.profileImage || ''),
        admissionNumber: r.admissionNumber || '',
    }));
}

/* ── Employees ───────────────────────────────────────────────────────────── */

/**
 * Teaching or not — the Employee Directory's rule, kept in step with
 * admin.controller STAFF_TYPE: a stated value wins; otherwise subjects on the
 * profile, a section led or covered, or a subject taught on a section in the
 * active year make a teacher.
 */
const ACTIVE_YEAR_SECTION = `(
        NOT EXISTS (SELECT 1 FROM ${T.years} ay WHERE ay."school" = u."school" AND ay."status" = 'active')
     OR s."academicYear" IN (SELECT ay."_id" FROM ${T.years} ay WHERE ay."school" = u."school" AND ay."status" = 'active'))`;
const STAFF_TYPE = `(CASE
        WHEN u."role" = 'school_admin' THEN 'admin'
        WHEN tp."staffType" IN ('teaching', 'non_teaching') THEN tp."staffType"
        WHEN jsonb_typeof(tp."subjects") = 'array' AND jsonb_array_length(tp."subjects") > 0 THEN 'teaching'
        WHEN EXISTS (SELECT 1 FROM ${T.sections} s
                      WHERE s."school" = u."school"
                        AND (s."classTeacher" = u."_id" OR s."substituteTeacher" = u."_id")
                        AND ${ACTIVE_YEAR_SECTION})
          OR EXISTS (SELECT 1 FROM ${T.sst} sst JOIN ${T.sections} s ON s."_id" = sst."section"
                      WHERE sst."teacher" = u."_id" AND s."school" = u."school" AND ${ACTIVE_YEAR_SECTION})
        THEN 'teaching'
        ELSE 'non_teaching' END)`;

/** 'teacher' or 'staff' — which card an employee row carries. */
const employeeKind = (row) => (row.staffType === 'teaching' ? 'teacher' : 'staff');

/**
 * Every employee: teachers and other staff (role teacher — a driver is a
 * teacher account with a job designation) and the office's administrators.
 * An administrator who also holds a teacher post at the school is one person
 * with one card, carried by the teacher row.
 */
async function employees(schoolId, { holderIds } = {}) {
    const only = ids(holderIds);
    const { rows } = await pool.query(`
        SELECT u."_id"::text AS "_id", u."role", u."name", u."email", u."isActive", u."profileImage", u."phone",
               tp."employeeId", tp."designation", tp."department", tp."bloodGroup",
               to_char((tp."dob" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "dob",
               to_char((tp."joiningDate" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "joiningDate",
               tp."emergencyContactPhone", tp."alternatePhone",
               ${STAFF_TYPE} AS "staffType"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT * FROM ${T.tp} x WHERE x."user" = u."_id" ORDER BY x."createdAt" ASC LIMIT 1) tp ON true
         WHERE u."school" = $1::uuid AND u."role" IN ('teacher', 'school_admin')
           AND NOT (u."role" = 'school_admin' AND u."email" <> '' AND EXISTS (
                SELECT 1 FROM ${T.users} t WHERE t."school" = u."school" AND t."role" = 'teacher' AND t."email" = u."email"))
           AND ($2::uuid[] IS NULL OR u."_id" = ANY($2::uuid[]))`,
    [String(schoolId), only]);
    return rows.map((r) => ({
        _id: r._id,
        role: r.role,
        name: r.name || '',
        isActive: r.isActive !== false,
        photoSource: r.profileImage || '',
        employeeId: r.employeeId || '',
        designation: r.designation || (r.role === 'school_admin' ? 'Administrator' : ''),
        department: r.department || (r.role === 'school_admin' ? 'Administration' : ''),
        bloodGroup: r.bloodGroup || '',
        dob: r.dob || '',
        joiningDate: r.joiningDate || '',
        phone: r.phone || r.alternatePhone || '',
        emergencyPhone: r.emergencyContactPhone || '',
        staffType: r.staffType,
        kind: employeeKind(r),
    }));
}

/* ── Parents ─────────────────────────────────────────────────────────────── */

const REL = { Father: 'father', Mother: 'mother', Guardian: 'guardian' };

/**
 * Every parent, with their children at this school by both links (the
 * parent's own list and each student profile's pointer) — the same union
 * services/parentChildren reads, here for the whole school at once.
 */
async function parents(schoolId, { holderIds } = {}) {
    const only = ids(holderIds);
    const { rows } = await pool.query(`
        WITH links AS (
            SELECT sp."parent" AS "parent", sp."user" AS "student"
              FROM ${T.sp} sp WHERE sp."school" = $1::uuid AND sp."parent" IS NOT NULL
            UNION
            SELECT pp."user", e.id::uuid
              FROM ${T.pp} pp
             CROSS JOIN LATERAL jsonb_array_elements_text(${jsonArr('pp."children"')}) AS e(id)
             WHERE pp."school" = $1::uuid AND e.id ~ ${UUID_TEXT}
        ),
        kids AS (
            SELECT l."parent",
                   jsonb_agg(jsonb_build_object('_id', s."_id", 'name', s."name",
                                                'className', COALESCE(c."className", c2."className", ''),
                                                'sectionName', COALESCE(cs."sectionName", ''))
                             ORDER BY s."name") AS "children"
              FROM links l
              JOIN ${T.users} s ON s."_id" = l."student" AND s."role" = 'student' AND s."school" = $1::uuid AND s."isActive" IS NOT FALSE
              LEFT JOIN LATERAL (SELECT * FROM ${T.sp} x WHERE x."user" = s."_id" ORDER BY x."createdAt" ASC LIMIT 1) sp ON true
              LEFT JOIN ${T.sections} cs ON cs."_id" = sp."currentSection"
              LEFT JOIN ${T.classes} c ON c."_id" = cs."class"
              LEFT JOIN ${T.classes} c2 ON c2."_id" = sp."currentClass"
             GROUP BY l."parent"
        )
        SELECT u."_id"::text AS "_id", u."name", u."email", u."isActive", u."profileImage", u."phone",
               pp."relationship", pp."father", pp."mother", pp."guardian",
               COALESCE(k."children", '[]'::jsonb) AS "children"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT * FROM ${T.pp} x WHERE x."user" = u."_id" ORDER BY x."createdAt" ASC LIMIT 1) pp ON true
          LEFT JOIN kids k ON k."parent" = u."_id"
         WHERE u."school" = $1::uuid AND u."role" = 'parent'
           AND ($2::uuid[] IS NULL OR u."_id" = ANY($2::uuid[]))`,
    [String(schoolId), only]);
    return rows.map((r) => {
        const rel = r.relationship || 'Guardian';
        const block = (r[REL[rel] || 'guardian']) || {};
        return {
            _id: r._id,
            name: r.name || block.name || '',
            isActive: r.isActive !== false,
            photoSource: r.profileImage || (block.photoFile ? `/uploads/student-docs/${block.photoFile}` : ''),
            relationship: rel === 'Guardian' && block.relation ? `Guardian (${block.relation})` : rel,
            phone: r.phone || block.phone || '',
            children: (Array.isArray(r.children) ? r.children : []).map((c) => ({
                _id: String(c._id), name: c.name || '', className: c.className || '', sectionName: c.sectionName || '',
            })),
        };
    });
}

/* ── What a card prints ──────────────────────────────────────────────────── */

/**
 * The card's own record of its holder, from a reader's row. `extra` carries
 * what the row cannot know: the year (students), the permanent parent ID.
 */
function snapshotOf(kind, row, extra = {}) {
    if (kind === 'student') {
        const y = extra.year || {};
        return {
            name: row.name,
            photoSource: row.photoSource || '',
            holderCode: row.admissionNumber || '',
            className: row.className || '',
            classNumber: row.classNumber ?? null,
            sectionName: row.sectionName || '',
            rollNumber: row.rollNumber || '',
            yearName: y.yearName || '',
            yearStart: dayKey(y.startDate),
            yearEnd: dayKey(y.endDate),
            dob: row.dob || '',
            bloodGroup: row.bloodGroup || '',
            gender: row.gender || '',
            parentName: row.parentName || '',
            emergencyPhone: row.emergencyPhone || '',
            address: row.address || '',
        };
    }
    if (kind === 'parent') {
        return {
            name: row.name,
            photoSource: row.photoSource || '',
            holderCode: extra.parentId || '',
            relationship: row.relationship || '',
            children: (row.children || []).map((c) => ({ _id: c._id, name: c.name })),
            phone: row.phone || '',
        };
    }
    return {
        name: row.name,
        photoSource: row.photoSource || '',
        holderCode: row.employeeId || '',
        designation: row.designation || (kind === 'teacher' ? 'Teacher' : 'Staff'),
        department: row.department || '',
        bloodGroup: row.bloodGroup || '',
        dob: row.dob || '',
        joiningDate: row.joiningDate || '',
        phone: row.phone || '',
        emergencyPhone: row.emergencyPhone || '',
    };
}

/**
 * What a card says, field by field, as [key, label, value] — only what this
 * card's design actually prints. Two snapshots differ in print exactly when
 * these lists differ.
 */
const ALWAYS = {
    student: [['name', 'Name'], ['photoSource', 'Photo'], ['className', 'Class'], ['sectionName', 'Section']],
    teacher: [['name', 'Name'], ['photoSource', 'Photo'], ['designation', 'Designation']],
    staff: [['name', 'Name'], ['photoSource', 'Photo'], ['designation', 'Designation']],
    parent: [['name', 'Name'], ['photoSource', 'Photo'], ['relationship', 'Relationship']],
};
const FIELD_KEYS = {
    admissionNo: 'holderCode', rollNo: 'rollNumber', dob: 'dob', bloodGroup: 'bloodGroup',
    parentName: 'parentName', emergencyPhone: 'emergencyPhone', address: 'address',
    employeeId: 'holderCode', department: 'department', joiningDate: 'joiningDate', phone: 'phone',
    children: 'children',
};
const show = (v) => (Array.isArray(v) ? v.map((c) => c?.name || '').join(', ') : String(v ?? ''));

function printed(kind, snap, design) {
    const s = snap || {};
    const out = ALWAYS[kind].map(([k, label]) => [k, label, show(s[k])]);
    for (const f of FIELDS[kind] || []) {
        const prop = FIELD_KEYS[f.key];
        if (!prop || design?.fields?.[f.key] === false) continue;
        if (design?.fields?.[f.key] === undefined && !f.on) continue;
        out.push([prop, f.label, show(s[prop])]);
    }
    return out;
}

/**
 * Where an issued card and a card issued now would differ, in print:
 * [{ key, label, was, now }]. Empty — the card is up to date.
 */
function diff(kind, cardSnap, liveSnap, design) {
    const a = printed(kind, cardSnap, design);
    const b = new Map(printed(kind, liveSnap, design).map(([k, , v]) => [k, v]));
    const out = [];
    for (const [k, label, was] of a) {
        const now = b.get(k) ?? '';
        if (String(was).trim() !== String(now).trim()) {
            out.push({ key: k, label, was: k === 'photoSource' ? (was ? 'On record' : 'None') : was, now: k === 'photoSource' ? (now ? 'Changed' : 'Removed') : now });
        }
    }
    return out;
}

/* ── Photos ──────────────────────────────────────────────────────────────── */

const UPLOADS = path.join(__dirname, '..', 'uploads');

/** "/uploads/x/y.png" → its file, or null for anything outside uploads. */
function uploadFile(p) {
    const s = String(p || '');
    if (!s.startsWith('/uploads/')) return null;
    const abs = path.normalize(path.join(UPLOADS, s.slice('/uploads/'.length)));
    return abs.startsWith(UPLOADS + path.sep) ? abs : null;
}

const PHOTO_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

/**
 * The card keeps its own copy of the photo: a new photo uploaded next year
 * must not change last year's card. '' when the holder has none on file.
 */
async function copyPhoto(schoolId, cardId, source) {
    const abs = uploadFile(source);
    if (!abs || !PHOTO_EXT.test(abs)) return '';
    try {
        await fs.promises.access(abs, fs.constants.R_OK);
        const dir = path.join(UPLOADS, 'id-cards', String(schoolId));
        await fs.promises.mkdir(dir, { recursive: true });
        const name = `${cardId}${path.extname(abs).toLowerCase()}`;
        await fs.promises.copyFile(abs, path.join(dir, name));
        return `/uploads/id-cards/${schoolId}/${name}`;
    } catch {
        return '';
    }
}

/** Remove a card's photo copy (a card that was never saved, or refreshed). */
async function dropPhoto(photo) {
    const abs = uploadFile(photo);
    if (!abs || !abs.includes(`${path.sep}id-cards${path.sep}`)) return;
    await fs.promises.unlink(abs).catch(() => {});
}

/** Is there a photo file behind this path at all? */
function photoExists(source) {
    const abs = uploadFile(source);
    return !!abs && PHOTO_EXT.test(abs) && fs.existsSync(abs);
}

module.exports = {
    studentsOfYear, studentsById, employees, parents, employeeKind,
    snapshotOf, printed, diff, copyPhoto, dropPhoto, photoExists, uploadFile,
};
