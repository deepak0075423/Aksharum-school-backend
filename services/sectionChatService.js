'use strict';
/**
 * Section group chats — maintenance only.
 * ──────────────────────────────────────
 * This used to CREATE a "Class 1 – A Teachers" group the moment a teacher was
 * attached to a section. Class groups are now made by hand — by the class
 * teacher, the vice class teacher, or a subject teacher for their subject (see
 * services/classGroupService). What is left here is keeping the groups those
 * teachers made in step when a section's line-up changes: it never creates one.
 *
 * The callers (class.controller / subject.controller on teacher assignment)
 * keep calling syncSectionChatGroup(); the name stayed so they did not have to
 * learn a new one.
 *
 * Old automatic staff groups (kind '' with a classSection) are left alone —
 * scripts/removeAutoSectionGroups.js removes the empty ones.
 */
const classGroups = require('./classGroupService');

/** Reconcile the section's teacher-made class and subject groups. */
async function syncSectionChatGroup(sectionId, schoolId) {
    return classGroups.reconcileSection(sectionId, schoolId);
}

/** The class and subject groups teachers have made for a section, for its admin page. */
async function sectionGroups(sectionId, schoolId) {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
        `SELECT c."_id", c."name", c."kind", c."isReadOnly", c."createdAt", c."lastActivity",
                sub."subjectName", cu."name" AS "createdByName",
                (SELECT count(*)::int FROM "chatmembers" x JOIN "users" u ON u."_id" = x."user"
                  WHERE x."chat" = c."_id" AND x."isActive" = true AND u."role" = 'student') AS "students",
                (SELECT count(*)::int FROM "chatmembers" x JOIN "users" u ON u."_id" = x."user"
                  WHERE x."chat" = c."_id" AND x."isActive" = true AND u."role" <> 'student') AS "teachers",
                (SELECT count(*)::int FROM "messages" m WHERE m."chat" = c."_id") AS "messages"
           FROM "chats" c
           LEFT JOIN "subjects" sub ON sub."_id" = c."subject"
           LEFT JOIN "users" cu ON cu."_id" = c."createdBy"
          WHERE c."school" = $1::uuid AND c."classSection" = $2::uuid AND c."kind" IN ('class', 'subject')
          ORDER BY (c."kind" = 'class') DESC, sub."subjectName"`,
        [String(schoolId), String(sectionId)],
    );
    return rows.map((r) => ({ ...r, _id: String(r._id) }));
}

module.exports = { syncSectionChatGroup, sectionGroups };
