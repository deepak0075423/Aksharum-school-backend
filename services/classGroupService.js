'use strict';
/**
 * Class groups
 * ────────────
 * Group chats tied to a section, created BY HAND by the teachers who run it.
 * Nothing in the system creates one on its own (the old automatic
 * "Class 1 – A Teachers" staff groups are gone; see sectionChatService).
 *
 *   Class group   (kind 'class')   — created by the section's class teacher or
 *     vice class teacher. Every student of the section is in it, always. Both
 *     the class teacher and the vice class teacher are in it and manage it.
 *     Any subject teacher of the section may be added.
 *
 *   Subject group (kind 'subject') — created by a teacher of one subject in one
 *     section. Every student of the section is in it, always. The only other
 *     teachers who may be in it teach the SAME subject in the SAME section.
 *
 * One class group per section, one subject group per section + subject (also
 * enforced by unique indexes on Chat).
 *
 * Membership is kept true to the school's records by reconcile(): students
 * follow StudentProfile.currentSection (the pointer the chat permission engine
 * reads), teachers who stop teaching the section drop out, and a change of
 * class teacher moves the group's management with it. It runs when a group is
 * created, when a section's teachers change, when a group's info is opened and
 * when a student loads their chat list — it only ever maintains groups that a
 * teacher made.
 */
const pool       = require('../db/pool');
const Chat       = require('../models/Chat');
const ChatMember = require('../models/ChatMember');
const broker     = require('./chatBrokerService');
const { ChatError } = require('./chatMessageService');

const KINDS = ['class', 'subject'];
const isClassGroup = (chat) => !!chat && KINDS.includes(chat.kind) && !!chat.classSection;

// "Class 9" + "A" → "9A"
const LABEL = `(regexp_replace(COALESCE(c."className", ''), '^\\s*class\\s*', '', 'i') || COALESCE(cs."sectionName", ''))`;
const ACTIVE_YEAR = `(NOT EXISTS (SELECT 1 FROM "academicyears" y WHERE y."school" = cs."school" AND y."status" = 'active')
                     OR cs."academicYear" IN (SELECT y."_id" FROM "academicyears" y WHERE y."school" = cs."school" AND y."status" = 'active'))`;

const id = (v) => (v ? String(v) : null);

// ─── What the school's records say ────────────────────────────────────────────

/** A section with its label and its two class-teacher posts. */
async function sectionInfo(sectionId, schoolId, { activeOnly = false } = {}) {
    const { rows: [s] } = await pool.query(
        `SELECT cs."_id", cs."classTeacher", cs."substituteTeacher", ${LABEL} AS "label"
           FROM "classsections" cs JOIN "classes" c ON c."_id" = cs."class"
          WHERE cs."_id" = $1::uuid AND cs."school" = $2::uuid ${activeOnly ? `AND ${ACTIVE_YEAR}` : ''}`,
        [String(sectionId), String(schoolId)],
    );
    return s ? { _id: id(s._id), label: s.label, classTeacher: id(s.classTeacher), vice: id(s.substituteTeacher) } : null;
}

/** Who teaches which subject in the section. */
async function subjectTeachers(sectionId) {
    const { rows } = await pool.query(
        `SELECT sst."teacher", sst."subject", sub."subjectName", u."name"
           FROM "sectionsubjectteachers" sst
           JOIN "users" u ON u."_id" = sst."teacher" AND u."isActive" IS NOT FALSE
           LEFT JOIN "subjects" sub ON sub."_id" = sst."subject"
          WHERE sst."section" = $1::uuid`,
        [String(sectionId)],
    );
    return rows.map((r) => ({ teacher: id(r.teacher), subject: id(r.subject), subjectName: r.subjectName || '', name: r.name }));
}

/** The section's students — by their own currentSection, as the permission engine reads it. */
async function sectionStudents(sectionId, schoolId) {
    const { rows } = await pool.query(
        `SELECT u."_id", u."name", sp."rollNumber"
           FROM "studentprofiles" sp
           JOIN "users" u ON u."_id" = sp."user"
          WHERE sp."currentSection" = $1::uuid AND u."school" = $2::uuid
            AND u."role" = 'student' AND u."isActive" IS NOT FALSE
          ORDER BY NULLIF(regexp_replace(COALESCE(sp."rollNumber", ''), '\\D', '', 'g'), '')::numeric NULLS LAST, u."name"`,
        [String(sectionId), String(schoolId)],
    );
    return rows.map((r) => ({ _id: id(r._id), name: r.name, rollNumber: r.rollNumber || '' }));
}

/** Teachers allowed in a group of this kind. */
function eligibleTeachers(kind, sec, staff, subjectId) {
    if (kind === 'class') {
        return new Set([sec.classTeacher, sec.vice, ...staff.map((s) => s.teacher)].filter(Boolean));
    }
    return new Set(staff.filter((s) => s.subject === id(subjectId)).map((s) => s.teacher));
}

/** The line shown next to a teacher in the group: class teacher, vice, their subjects. */
function teacherTags(sec, staff) {
    const tags = new Map();
    const add = (uid, tag) => { if (!uid) return; tags.set(uid, [...(tags.get(uid) || []), tag]); };
    add(sec.classTeacher, 'Class teacher');
    add(sec.vice, 'Vice class teacher');
    for (const s of staff) if (s.subjectName) add(s.teacher, s.subjectName);
    return new Map([...tags].map(([k, v]) => [k, [...new Set(v)].join(' · ')]));
}

async function subjectName(subjectId) {
    const { rows: [r] } = await pool.query(`SELECT "subjectName" FROM "subjects" WHERE "_id" = $1::uuid`, [String(subjectId)]);
    return r?.subjectName || '';
}

// ─── Who may create what ──────────────────────────────────────────────────────

/**
 * Check the actor may create (or manage the creation of) this group and
 * return what the roster is built from.
 */
async function authorize(actor, { kind, sectionId, subjectId }) {
    if (actor.role !== 'teacher') throw new ChatError(403, 'Class and subject groups are created by their teachers');
    if (!KINDS.includes(kind)) throw new ChatError(400, 'kind must be class or subject');
    if (!sectionId) throw new ChatError(400, 'sectionId is required');

    const sec = await sectionInfo(sectionId, actor.schoolId, { activeOnly: true });
    if (!sec) throw new ChatError(404, 'Section not found in the current academic year');
    const staff = await subjectTeachers(sec._id);

    if (kind === 'class') {
        if (actor.userId !== sec.classTeacher && actor.userId !== sec.vice) {
            throw new ChatError(403, `Only the class teacher or vice class teacher of Class ${sec.label} can create its class group`);
        }
        return { sec, staff, subject: null };
    }

    if (!subjectId) throw new ChatError(400, 'subjectId is required for a subject group');
    const mine = staff.some((s) => s.teacher === actor.userId && s.subject === id(subjectId));
    const name = await subjectName(subjectId);
    if (!mine) throw new ChatError(403, `You do not teach ${name || 'this subject'} in Class ${sec.label}`);
    return { sec, staff, subject: { _id: id(subjectId), name } };
}

async function existingGroup(kind, sectionId, subjectId) {
    const filter = { classSection: sectionId, kind };
    if (kind === 'subject') filter.subject = subjectId;
    return Chat.findOne(filter).select('_id name').lean();
}

/** Everything the teacher could create, for the Create Group dialog. */
async function options(actor) {
    if (actor.role !== 'teacher') return { classGroups: [], subjectGroups: [] };
    const params = [actor.userId, actor.schoolId];
    const [own, taught] = await Promise.all([
        pool.query(
            `SELECT cs."_id", ${LABEL} AS "label", c."classNumber",
                    CASE WHEN cs."classTeacher" = $1::uuid THEN 'class' ELSE 'vice' END AS "as",
                    (SELECT count(*)::int FROM "studentprofiles" sp JOIN "users" u ON u."_id" = sp."user"
                      WHERE sp."currentSection" = cs."_id" AND u."role" = 'student' AND u."isActive" IS NOT FALSE) AS "students",
                    g."_id" AS "chatId", g."name" AS "chatName",
                    EXISTS (SELECT 1 FROM "chatmembers" x WHERE x."chat" = g."_id" AND x."user" = $1::uuid AND x."isActive" = true) AS "isMember"
               FROM "classsections" cs JOIN "classes" c ON c."_id" = cs."class"
               LEFT JOIN "chats" g ON g."classSection" = cs."_id" AND g."kind" = 'class'
              WHERE cs."school" = $2::uuid AND ${ACTIVE_YEAR}
                AND (cs."classTeacher" = $1::uuid OR cs."substituteTeacher" = $1::uuid)
              ORDER BY c."classNumber" NULLS LAST, cs."sectionName"`, params),
        pool.query(
            `SELECT cs."_id", ${LABEL} AS "label", c."classNumber", sst."subject", sub."subjectName",
                    (SELECT count(*)::int FROM "studentprofiles" sp JOIN "users" u ON u."_id" = sp."user"
                      WHERE sp."currentSection" = cs."_id" AND u."role" = 'student' AND u."isActive" IS NOT FALSE) AS "students",
                    g."_id" AS "chatId", g."name" AS "chatName",
                    EXISTS (SELECT 1 FROM "chatmembers" x WHERE x."chat" = g."_id" AND x."user" = $1::uuid AND x."isActive" = true) AS "isMember"
               FROM "sectionsubjectteachers" sst
               JOIN "classsections" cs ON cs."_id" = sst."section"
               JOIN "classes" c ON c."_id" = cs."class"
               LEFT JOIN "subjects" sub ON sub."_id" = sst."subject"
               LEFT JOIN "chats" g ON g."classSection" = cs."_id" AND g."kind" = 'subject' AND g."subject" = sst."subject"
              WHERE sst."teacher" = $1::uuid AND cs."school" = $2::uuid AND ${ACTIVE_YEAR}
              ORDER BY c."classNumber" NULLS LAST, cs."sectionName", sub."subjectName"`, params),
    ]);
    const existing = (r) => (r.chatId ? { chatId: id(r.chatId), name: r.chatName, isMember: !!r.isMember } : null);
    return {
        classGroups: own.rows.map((r) => ({
            sectionId: id(r._id), label: r.label, as: r.as, students: r.students, existing: existing(r),
        })),
        subjectGroups: taught.rows.map((r) => ({
            sectionId: id(r._id), label: r.label, subjectId: id(r.subject), subjectName: r.subjectName || '',
            students: r.students, existing: existing(r),
        })),
    };
}

/** Who the group would hold — students (fixed) and the teachers that may be picked. */
async function roster(actor, { kind, sectionId, subjectId }) {
    const { sec, staff, subject } = await authorize(actor, { kind, sectionId, subjectId });
    const [students, existing] = await Promise.all([
        sectionStudents(sec._id, actor.schoolId),
        existingGroup(kind, sec._id, subject?._id),
    ]);
    const eligible = eligibleTeachers(kind, sec, staff, subject?._id);
    const tags = teacherTags(sec, staff);
    const locked = new Set(kind === 'class' ? [sec.classTeacher, sec.vice, actor.userId].filter(Boolean) : [actor.userId]);

    const names = new Map(staff.map((s) => [s.teacher, s.name]));
    const missing = [...eligible].filter((t) => !names.has(t));
    if (missing.length) {
        const { rows } = await pool.query(`SELECT "_id", "name" FROM "users" WHERE "_id" = ANY($1::uuid[])`, [missing]);
        rows.forEach((r) => names.set(id(r._id), r.name));
    }
    const teachers = [...eligible].map((t) => ({
        _id: t, name: names.get(t) || 'Teacher', tag: tags.get(t) || '', locked: locked.has(t),
        admin: kind === 'class' ? (t === sec.classTeacher || t === sec.vice) : t === actor.userId,
        you: t === actor.userId,
    })).sort((a, b) => Number(b.locked) - Number(a.locked) || a.name.localeCompare(b.name));

    const label = `Class ${sec.label}`;
    return {
        kind, sectionId: sec._id, label,
        subjectId: subject?._id || null, subjectName: subject?.name || '',
        defaultName: kind === 'class' ? label : `${label} · ${subject.name}`,
        students, teachers,
        existing: existing ? { chatId: id(existing._id), name: existing.name } : null,
    };
}

// ─── Create ───────────────────────────────────────────────────────────────────

async function create(actor, body = {}) {
    const kind = body.kind;
    const { sec, staff, subject } = await authorize(actor, { kind, sectionId: body.sectionId, subjectId: body.subjectId });

    const dup = await existingGroup(kind, sec._id, subject?._id);
    if (dup) {
        throw Object.assign(new ChatError(409, kind === 'class'
            ? `Class ${sec.label} already has a class group`
            : `Class ${sec.label} already has a ${subject.name} group`), { chatId: id(dup._id) });
    }

    const eligible = eligibleTeachers(kind, sec, staff, subject?._id);
    const picked = [...new Set((Array.isArray(body.teacherIds) ? body.teacherIds : []).map(String))];
    const refused = picked.filter((t) => !eligible.has(t));
    if (refused.length) {
        throw new ChatError(403, kind === 'class'
            ? 'Only the class teacher, vice class teacher and subject teachers of this class can be added'
            : `Only teachers who teach ${subject.name} in Class ${sec.label} can be added`);
    }

    const admins = new Set(kind === 'class' ? [sec.classTeacher, sec.vice, actor.userId].filter(Boolean) : [actor.userId]);
    const teachers = new Set([...admins, ...picked]);
    const students = await sectionStudents(sec._id, actor.schoolId);

    const name = String(body.name || '').trim() || (kind === 'class' ? `Class ${sec.label}` : `Class ${sec.label} · ${subject.name}`);
    let chat;
    try {
        chat = await Chat.create({
            school:       actor.schoolId,
            type:         'group',
            kind,
            classSection: sec._id,
            subject:      subject?._id || null,
            name:         name.slice(0, 80),
            description:  String(body.description || '').trim().slice(0, 300),
            isReadOnly:   body.isReadOnly === true || body.isReadOnly === 'true',
            createdBy:    actor.userId,
            lastActivity: new Date(),
        });
    } catch (err) {
        if (err.code === '23505' || /duplicate key/i.test(err.message || '')) {
            throw new ChatError(409, 'That group was created a moment ago by another teacher');
        }
        throw err;
    }

    const rows = [
        ...[...teachers].map((t) => ({ chat: chat._id, user: t, school: actor.schoolId, role: admins.has(t) ? 'admin' : 'member' })),
        ...students.map((s) => ({ chat: chat._id, user: s._id, school: actor.schoolId, role: 'member' })),
    ];
    await ChatMember.insertMany(rows);
    for (const r of rows) await broker.publishMembership('join', r.user, chat._id).catch(() => {});
    broker.publishToRoom(chat._id, 'chat:group_created', { chatId: id(chat._id), name: chat.name, type: 'group' }).catch(() => {});

    return { chatId: id(chat._id), students: students.length, teachers: teachers.size };
}

// ─── Keep a group true to the records ─────────────────────────────────────────

async function memberRows(chatId) {
    const { rows } = await pool.query(
        `SELECT x."_id", x."user", x."role", x."isActive", x."joinedAt", u."role" AS "userRole"
           FROM "chatmembers" x JOIN "users" u ON u."_id" = x."user"
          WHERE x."chat" = $1::uuid`,
        [String(chatId)],
    );
    return rows.map((r) => ({ ...r, _id: id(r._id), user: id(r.user) }));
}

/**
 * Students = the section's students now; teachers who no longer teach it leave;
 * the class teacher and vice class teacher are in a class group and manage it.
 * @returns {Promise<{added: number, removed: number}>}
 */
async function reconcile(chat) {
    if (!isClassGroup(chat)) return { added: 0, removed: 0 };
    const chatId = id(chat._id);
    const sec = await sectionInfo(chat.classSection, chat.school);
    if (!sec) return { added: 0, removed: 0 };

    const [staff, students, rows] = await Promise.all([
        subjectTeachers(sec._id), sectionStudents(sec._id, chat.school), memberRows(chatId),
    ]);
    const eligible = eligibleTeachers(chat.kind, sec, staff, chat.subject);
    const classAdmins = new Set(chat.kind === 'class' ? [sec.classTeacher, sec.vice].filter(Boolean) : []);
    const byUser = new Map(rows.map((r) => [r.user, r]));
    const joined = [];
    const left = [];

    const ensure = async (uid, role) => {
        const r = byUser.get(uid);
        if (!r) {
            await ChatMember.create({ chat: chatId, user: uid, school: chat.school, role });
            joined.push(uid);
        } else if (!r.isActive) {
            await ChatMember.updateOne({ _id: r._id }, { isActive: true, role, joinedAt: new Date() });
            joined.push(uid);
        } else if (r.role !== role && (role === 'admin' || chat.kind === 'class')) {
            await ChatMember.updateOne({ _id: r._id }, { role });
        }
    };

    const studentIds = new Set(students.map((s) => s._id));
    for (const sid of studentIds) await ensure(sid, 'member');
    for (const t of classAdmins) await ensure(t, 'admin');

    for (const r of rows) {
        if (!r.isActive) continue;
        const gone = (r.userRole === 'student' && !studentIds.has(r.user))
            || (r.userRole === 'teacher' && !eligible.has(r.user));
        if (gone) {
            await ChatMember.updateOne({ _id: r._id }, { isActive: false });
            left.push(r.user);
        } else if (chat.kind === 'class' && r.userRole === 'teacher' && r.role === 'admin' && !classAdmins.has(r.user)) {
            // No longer class / vice class teacher, still teaches a subject here.
            await ChatMember.updateOne({ _id: r._id }, { role: 'member' });
        }
    }

    // A subject group must keep someone who can manage it.
    if (chat.kind === 'subject') {
        const now = await memberRows(chatId);
        const teachers = now.filter((r) => r.isActive && r.userRole === 'teacher');
        if (teachers.length && !teachers.some((r) => r.role === 'admin')) {
            const heir = teachers.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt))[0];
            await ChatMember.updateOne({ _id: heir._id }, { role: 'admin' });
        }
    }

    for (const uid of joined) {
        await broker.publishMembership('join', uid, chatId).catch(() => {});
        broker.publishToRoom(chatId, 'chat:member_added', { chatId, userId: uid }).catch(() => {});
    }
    for (const uid of left) {
        broker.publishToRoom(chatId, 'chat:member_removed', { chatId, userId: uid }).catch(() => {});
        await broker.publishMembership('leave', uid, chatId).catch(() => {});
    }
    return { added: joined.length, removed: left.length };
}

// Opening a group's info reconciles it; once a minute per group is plenty.
const lastReconciled = new Map();
async function reconcileSoon(chat) {
    if (!isClassGroup(chat)) return;
    const key = id(chat._id);
    if (Date.now() - (lastReconciled.get(key) || 0) < 60_000) return;
    lastReconciled.set(key, Date.now());
    await reconcile(chat);
}

/** A section's teachers or students changed: bring its class and subject groups along. Never creates one. */
async function reconcileSection(sectionId, schoolId) {
    const groups = await Chat.find({ school: schoolId, classSection: sectionId, kind: { $in: KINDS } }).lean();
    let added = 0, removed = 0;
    for (const g of groups) {
        const r = await reconcile(g);
        added += r.added; removed += r.removed;
    }
    return { groups: groups.length, added, removed };
}

/**
 * A student opening chat: into their section's class and subject groups, out of
 * any from a section they have left. Two cheap statements when nothing changed.
 */
async function joinMyClassGroups(studentId, schoolId) {
    const [{ rows: missing }, { rows: stale }] = await Promise.all([
        pool.query(
            `SELECT c."_id", x."_id" AS "rowId"
               FROM "studentprofiles" sp
               JOIN "chats" c ON c."classSection" = sp."currentSection" AND c."kind" IN ('class', 'subject')
               LEFT JOIN "chatmembers" x ON x."chat" = c."_id" AND x."user" = sp."user"
              WHERE sp."user" = $1::uuid AND c."school" = $2::uuid AND (x."_id" IS NULL OR x."isActive" IS NOT TRUE)`,
            [String(studentId), String(schoolId)]),
        pool.query(
            `SELECT x."_id", x."chat"
               FROM "chatmembers" x JOIN "chats" c ON c."_id" = x."chat"
              WHERE x."user" = $1::uuid AND x."isActive" = true AND c."kind" IN ('class', 'subject')
                AND c."classSection" IS DISTINCT FROM (
                    SELECT sp."currentSection" FROM "studentprofiles" sp WHERE sp."user" = $1::uuid LIMIT 1)`,
            [String(studentId)]),
    ]);
    for (const m of missing) {
        if (m.rowId) await ChatMember.updateOne({ _id: m.rowId }, { isActive: true, role: 'member', joinedAt: new Date() });
        else await ChatMember.create({ chat: m._id, user: studentId, school: schoolId, role: 'member' });
        await broker.publishMembership('join', studentId, m._id).catch(() => {});
        broker.publishToRoom(m._id, 'chat:member_added', { chatId: id(m._id), userId: String(studentId) }).catch(() => {});
    }
    for (const s of stale) {
        await ChatMember.updateOne({ _id: s._id }, { isActive: false });
        broker.publishToRoom(s.chat, 'chat:member_removed', { chatId: id(s.chat), userId: String(studentId) }).catch(() => {});
        await broker.publishMembership('leave', studentId, s.chat).catch(() => {});
    }
    return { joined: missing.length, left: stale.length };
}

// ─── Managing members ─────────────────────────────────────────────────────────

/** What this viewer may do in a class/subject group, plus a tag per member. */
async function manageInfo(chat, viewerId, members) {
    if (!isClassGroup(chat)) return null;
    const sec = await sectionInfo(chat.classSection, chat.school);
    if (!sec) return null;
    const [staff, students] = await Promise.all([subjectTeachers(sec._id), sectionStudents(sec._id, chat.school)]);
    const tags = teacherTags(sec, staff);
    const studentIds = new Set(students.map((s) => s._id));
    const fixedTeachers = new Set(chat.kind === 'class' ? [sec.classTeacher, sec.vice].filter(Boolean) : []);
    const me = members.find((m) => m._id === String(viewerId));
    const canManage = me?.memberRole === 'admin';

    const locked = (m) => studentIds.has(m._id) || fixedTeachers.has(m._id);
    return {
        kind: chat.kind,
        sectionLabel: sec.label,
        canManage,
        canSync: canManage,
        canLeave: !!me && !locked(me),
        removable: canManage ? members.filter((m) => m._id !== String(viewerId) && !locked(m)).map((m) => m._id) : [],
        tags: Object.fromEntries(members.map((m) => [m._id, m.role === 'student' ? (studentIds.has(m._id) ? 'Student' : 'Student · left the class') : (tags.get(m._id) || '')])),
        studentCount: students.length,
    };
}

/** Teachers (and returning students) that may still be added to a class/subject group. */
async function candidates(chat) {
    const sec = await sectionInfo(chat.classSection, chat.school);
    if (!sec) return [];
    const [staff, students, rows] = await Promise.all([
        subjectTeachers(sec._id), sectionStudents(sec._id, chat.school), memberRows(chat._id),
    ]);
    const active = new Set(rows.filter((r) => r.isActive).map((r) => r.user));
    const tags = teacherTags(sec, staff);
    const eligible = [...eligibleTeachers(chat.kind, sec, staff, chat.subject)].filter((t) => !active.has(t));
    const names = new Map(staff.map((s) => [s.teacher, s.name]));
    const out = eligible.map((t) => ({ _id: t, name: names.get(t) || 'Teacher', role: 'teacher', line: tags.get(t) || '' }));
    for (const s of students) if (!active.has(s._id)) out.push({ _id: s._id, name: s.name, role: 'student', line: `Class ${sec.label}` });
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function assertCanAdd(chat, ids) {
    const sec = await sectionInfo(chat.classSection, chat.school);
    if (!sec) throw new ChatError(404, 'This group’s section no longer exists');
    const [staff, students] = await Promise.all([subjectTeachers(sec._id), sectionStudents(sec._id, chat.school)]);
    const allowed = new Set([...eligibleTeachers(chat.kind, sec, staff, chat.subject), ...students.map((s) => s._id)]);
    if (ids.some((u) => !allowed.has(String(u)))) {
        if (chat.kind === 'subject') {
            const name = await subjectName(chat.subject);
            throw new ChatError(403, `Only teachers who teach ${name || 'this subject'} in Class ${sec.label} can be added`);
        }
        throw new ChatError(403, `Only teachers of Class ${sec.label} and its students can be added`);
    }
}

async function assertCanRemove(chat, targetId, { leaving = false } = {}) {
    const sec = await sectionInfo(chat.classSection, chat.school);
    if (!sec) return;
    const students = await sectionStudents(sec._id, chat.school);
    if (students.some((s) => s._id === String(targetId))) {
        throw new ChatError(403, leaving
            ? `Students of Class ${sec.label} stay in its ${chat.kind === 'class' ? 'class' : 'subject'} group`
            : `Every student of Class ${sec.label} is part of this group and cannot be removed`);
    }
    if (chat.kind === 'class' && [sec.classTeacher, sec.vice].includes(String(targetId))) {
        throw new ChatError(403, 'The class teacher and vice class teacher stay in the class group');
    }
}

module.exports = {
    KINDS,
    isClassGroup,
    options,
    roster,
    create,
    reconcile,
    reconcileSoon,
    reconcileSection,
    joinMyClassGroups,
    manageInfo,
    candidates,
    assertCanAdd,
    assertCanRemove,
};
