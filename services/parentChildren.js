'use strict';
/**
 * A parent's children, as student User ids.
 *
 * The link has two sources of truth and they drift: the parent's own
 * `children` list (what the dashboard's child picker is built from) and each
 * student profile's `parent` pointer. Both are read, then re-read as users
 * scoped to this school and the student role, so a stale id on either side
 * cannot reach a stranger or another school.
 *
 * Returned sorted by name — the order every child switch shows them in.
 */
const ParentProfile  = require('../models/ParentProfile');
const StudentProfile = require('../models/StudentProfile');
const User           = require('../models/User');

async function childrenOf(parentUserId, schoolId, fields = 'name') {
    const [parent, owned] = await Promise.all([
        ParentProfile.findOne({ user: parentUserId }).lean(),
        StudentProfile.find({ parent: parentUserId, school: schoolId }).select('user').lean(),
    ]);
    const listed = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);
    const ids = [...new Set([...listed, ...owned.map((p) => p.user)].filter(Boolean).map(String))];
    if (!ids.length) return [];

    const kids = await User.find({ _id: { $in: ids }, role: 'student', school: schoolId }).select(fields).lean();
    return kids.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

/**
 * The children as a child switch shows them: name, class and section.
 *
 * Classes are read directly — populate through section → class hands back the
 * bare id in this ORM, which is how the dashboard's class name came out blank.
 * A child admitted to a class but not yet placed in a section still names the
 * class.
 */
async function childCards(parentUserId, schoolId) {
    const ClassSection = require('../models/ClassSection');
    const Class        = require('../models/Class');

    const kids = await childrenOf(parentUserId, schoolId);
    if (!kids.length) return [];

    const profiles = await StudentProfile.find({ user: { $in: kids.map((k) => k._id) }, school: schoolId })
        .select('user currentSection currentClass').lean();
    const profileOf = new Map(profiles.map((p) => [String(p.user), p]));

    const sectionIds = [...new Set(profiles.map((p) => p.currentSection).filter(Boolean).map(String))];
    const sections = sectionIds.length
        ? await ClassSection.find({ _id: { $in: sectionIds } }).select('sectionName class').lean() : [];
    const sectionById = new Map(sections.map((s) => [String(s._id), s]));

    const classIds = [...new Set([
        ...sections.map((s) => s.class).filter(Boolean).map(String),
        ...profiles.map((p) => p.currentClass).filter(Boolean).map(String),
    ])];
    const classes = classIds.length ? await Class.find({ _id: { $in: classIds } }).select('className').lean() : [];
    const classById = new Map(classes.map((c) => [String(c._id), c.className]));

    return kids.map((k) => {
        const p   = profileOf.get(String(k._id)) || {};
        const sec = p.currentSection ? sectionById.get(String(p.currentSection)) : null;
        return {
            _id:         String(k._id),
            name:        k.name,
            className:   classById.get(String(sec?.class || p.currentClass || '')) || '',
            sectionName: sec?.sectionName || '',
        };
    });
}

/**
 * The other direction: every active parent of these students, by both links —
 * the student profile's `parent` pointer and any parent profile listing the
 * student among its `children`. A notice about a child reaches every parent
 * the school knows, not only the one the admission form happened to record.
 *
 * @returns {Promise<Map<studentId, string[]>>}
 */
async function parentsOf(studentIds, schoolId) {
    const pool = require('../db/pool');
    const ids = [...new Set((studentIds || []).map(String).filter(Boolean))];
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const T = (M) => `"${M.tableName}"`;
    const { rows } = await pool.query(
        `WITH links AS (
            SELECT sp."user"::text AS "student", sp."parent" AS "parent"
              FROM ${T(StudentProfile)} sp
             WHERE sp."user" = ANY($1::uuid[]) AND sp."parent" IS NOT NULL
            UNION
            SELECT e.id AS "student", pp."user" AS "parent"
              FROM ${T(ParentProfile)} pp
             CROSS JOIN LATERAL jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(pp."children") = 'array' THEN pp."children" ELSE '[]'::jsonb END) AS e(id)
             WHERE e.id = ANY($2::text[])
         )
         SELECT DISTINCT l."student", u."_id"::text AS "parent"
           FROM links l
           JOIN ${T(User)} u ON u."_id" = l."parent"
                AND u."role" = 'parent' AND u."school" = $3 AND u."isActive" IS NOT FALSE`,
        [ids, ids, String(schoolId)],
    );
    for (const r of rows) out.get(r.student)?.push(r.parent);
    return out;
}

module.exports = { childrenOf, childCards, parentsOf };
