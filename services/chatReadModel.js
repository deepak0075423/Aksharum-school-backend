'use strict';
/**
 * Chat read model
 * ───────────────
 * Every read the chat screens make, as raw SQL.
 *
 * The list used to be one ORM query plus two more per conversation (the other
 * member, then an unread count) — forty conversations was eighty-one round trips
 * on every incoming message, because the page refetched the list each time. It
 * is one statement now, and the page patches it in place from socket events.
 *
 * Shapes are kept compatible with what the web page and the Expo app already
 * read (`displayName`, `otherUser`, `otherReadAt`, `lastMessage.sender.name`,
 * populated `sender` / `replyTo` on messages); fields only ever get added.
 *
 * Content of a deleted message never leaves here for anyone but a school admin
 * — not in the thread, not as a reply quote, not as a list preview.
 */
const pool = require('../db/pool');
const { getCacheRedis } = require('../config/cacheRedis');
const { childCards } = require('./parentChildren');

const PRESENCE_TTL_MS = 60 * 1000;     // lastSeenAt fallback when Redis is not there

// "Class 9" + "A" → "9A" — how staff write a section.
const SECTION_LABEL = (c, s) =>
    `(regexp_replace(COALESCE(${c}."className", ''), '^\\s*class\\s*', '', 'i') || COALESCE(${s}."sectionName", ''))`;

const iso = (d) => (d ? new Date(d).toISOString() : null);

// ─── Presence ─────────────────────────────────────────────────────────────────

/**
 * Which of these users have a live socket right now.
 *
 * The gateway keeps `presence:<userId>` alive with a 35 s TTL while any socket
 * of that user is connected, so a key's existence is the answer. Without Redis
 * (or when it is slow) this falls back to a recent `lastSeenAt`, which the same
 * gateway heartbeat refreshes.
 */
async function onlineSet(users) {
    const list = (users || []).filter((u) => u && u._id);
    const out = new Set();
    if (!list.length) return out;

    const redis = getCacheRedis();
    if (redis) {
        try {
            const keys = list.map((u) => `presence:${u._id}`);
            const vals = await Promise.race([
                redis.mget(keys),
                new Promise((_, rej) => setTimeout(() => rej(new Error('presence timeout')), 400)),
            ]);
            vals.forEach((v, i) => { if (v) out.add(String(list[i]._id)); });
            return out;
        } catch { /* fall through to lastSeenAt */ }
    }
    const now = Date.now();
    for (const u of list) {
        if (u.lastSeenAt && now - new Date(u.lastSeenAt).getTime() < PRESENCE_TTL_MS) out.add(String(u._id));
    }
    return out;
}

// ─── Chat list ────────────────────────────────────────────────────────────────

const LIST_SQL = `
    SELECT c."_id", c."type", c."name", c."description", c."isReadOnly", c."avatar",
           c."lastActivity", c."classSection", c."createdBy", c."createdAt", c."kind",
           gsub."subjectName" AS "subjectName", ${SECTION_LABEL('gcl', 'gcs')} AS "sectionLabel",
           me."role" AS "memberRole", me."isMuted", me."muteUntil", me."isArchived", me."lastReadAt",
           lm."_id" AS "lmId", lm."content" AS "lmContent", lm."type" AS "lmType",
           lm."sender" AS "lmSender", lm."isDeleted" AS "lmDeleted", lm."createdAt" AS "lmAt",
           lm."attachments" AS "lmAttachments", lms."name" AS "lmSenderName",
           ou."_id" AS "ouId", ou."name" AS "ouName", ou."role" AS "ouRole",
           ou."profileImage" AS "ouImage", ou."lastSeenAt" AS "ouSeen", om."lastReadAt" AS "ouReadAt",
           (SELECT count(*)::int FROM "chatmembers" x
             WHERE x."chat" = c."_id" AND x."isActive" = true) AS "memberCount",
           (SELECT count(*)::int FROM "messages" m
             WHERE m."chat" = c."_id" AND m."sender" <> $1::uuid AND m."isDeleted" IS NOT TRUE
               AND m."createdAt" > COALESCE(me."lastReadAt", 'epoch'::timestamptz)) AS "unreadCount",
           (SELECT min(COALESCE(x."lastReadAt", 'epoch'::timestamptz)) FROM "chatmembers" x
             WHERE x."chat" = c."_id" AND x."isActive" = true AND x."user" <> $1::uuid) AS "readUpTo"
      FROM "chatmembers" me
      JOIN "chats" c ON c."_id" = me."chat" AND c."school" = $2::uuid
      LEFT JOIN "messages" lm ON lm."_id" = c."lastMessage"
      LEFT JOIN "users" lms ON lms."_id" = lm."sender"
      LEFT JOIN "subjects" gsub ON gsub."_id" = c."subject"
      LEFT JOIN "classsections" gcs ON gcs."_id" = c."classSection"
      LEFT JOIN "classes" gcl ON gcl."_id" = gcs."class"
      LEFT JOIN LATERAL (
            SELECT x."user", x."lastReadAt" FROM "chatmembers" x
             WHERE c."type" = 'direct' AND x."chat" = c."_id" AND x."user" <> $1::uuid
             ORDER BY x."isActive" DESC NULLS LAST
             LIMIT 1
      ) om ON true
      LEFT JOIN "users" ou ON ou."_id" = om."user"
     WHERE me."user" = $1::uuid AND me."school" = $2::uuid AND me."isActive" = true
       AND ($3::uuid IS NULL OR c."_id" = $3::uuid)
     ORDER BY c."lastActivity" DESC NULLS LAST, c."createdAt" DESC`;

function mutedNow(r) {
    if (!r.isMuted) return false;
    return !r.muteUntil || new Date(r.muteUntil).getTime() > Date.now();
}

function shapeListRow(r, isAdmin, online) {
    const other = r.ouId ? {
        _id:          String(r.ouId),
        name:         r.ouName || '',
        role:         r.ouRole || '',
        profileImage: r.ouImage || '',
        lastSeenAt:   iso(r.ouSeen),
        isOnline:     online.has(String(r.ouId)),
    } : null;

    const lastMessage = r.lmId ? {
        _id:       String(r.lmId),
        content:   r.lmDeleted && !isAdmin ? '' : (r.lmContent || ''),
        type:      r.lmType || 'text',
        isDeleted: !!r.lmDeleted,
        createdAt: iso(r.lmAt),
        sender:    r.lmSender ? { _id: String(r.lmSender), name: r.lmSenderName || '' } : null,
        hasAttachments: Array.isArray(r.lmAttachments) && r.lmAttachments.length > 0,
    } : null;

    const isDirect = r.type === 'direct';
    const displayName = isDirect ? (other?.name || 'Unknown user') : (r.name || 'Group');
    const readUpTo = r.readUpTo && new Date(r.readUpTo).getTime() > 0 ? iso(r.readUpTo) : null;

    return {
        _id:           String(r._id),
        type:          r.type,
        name:          r.name || '',
        description:   r.description || '',
        isReadOnly:    !!r.isReadOnly,
        avatar:        r.avatar || '',
        classSection:  r.classSection ? String(r.classSection) : null,
        // 'class' | 'subject' for teacher-made class groups, '' otherwise
        kind:          r.kind || '',
        sectionLabel:  r.classSection ? (r.sectionLabel || '') : '',
        subjectName:   r.subjectName || '',
        createdBy:     r.createdBy ? String(r.createdBy) : null,
        createdAt:     iso(r.createdAt),
        lastActivity:  iso(r.lastActivity),
        lastMessage,
        displayName,
        displayAvatar: isDirect ? (other?.profileImage || '') : (r.avatar || ''),
        otherUser:     isDirect ? other : null,
        otherReadAt:   isDirect ? iso(r.ouReadAt) : null,
        // Who this conversation is with, for the list's tabs.
        peerRole:      isDirect ? (other?.role || '') : 'group',
        memberCount:   r.memberCount || 0,
        unreadCount:   r.unreadCount || 0,
        // Everyone else has read up to here — blue ticks on anything older.
        readUpTo,
        // A direct peer's device has fetched up to here (the gateway keeps
        // lastSeenAt fresh while they are connected) — grey double ticks.
        deliveredUpTo: isDirect ? (other?.isOnline ? new Date().toISOString() : other?.lastSeenAt || null) : null,
        isMuted:       mutedNow(r),
        muteUntil:     iso(r.muteUntil),
        isArchived:    !!r.isArchived,
        memberRole:    r.memberRole || 'member',
        lastReadAt:    iso(r.lastReadAt),
    };
}

/** Every conversation this person belongs to, newest activity first. */
async function listChats(userId, schoolId, { chatId = null, isAdmin = false } = {}) {
    const { rows } = await pool.query(LIST_SQL, [String(userId), String(schoolId), chatId ? String(chatId) : null]);
    const peers = rows.filter((r) => r.ouId).map((r) => ({ _id: r.ouId, lastSeenAt: r.ouSeen }));
    const online = await onlineSet(peers);
    return rows.map((r) => shapeListRow(r, isAdmin, online));
}

/** One conversation's list row, or null when this person is not in it. */
async function chatSummary(userId, schoolId, chatId, opts = {}) {
    const [row] = await listChats(userId, schoolId, { ...opts, chatId });
    return row || null;
}

/**
 * Unread messages across every conversation that is not muted.
 * One statement — the sidebar badge asks for this after every message.
 */
async function unreadTotal(userId, schoolId) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS "n"
           FROM "chatmembers" me
           JOIN "messages" m ON m."chat" = me."chat"
          WHERE me."user" = $1::uuid AND me."school" = $2::uuid AND me."isActive" = true
            AND NOT (me."isMuted" = true AND (me."muteUntil" IS NULL OR me."muteUntil" > now()))
            AND m."sender" <> $1::uuid AND m."isDeleted" IS NOT TRUE
            AND m."createdAt" > COALESCE(me."lastReadAt", 'epoch'::timestamptz)`,
        [String(userId), String(schoolId)],
    );
    return rows[0]?.n || 0;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

const MESSAGE_SELECT = `
    SELECT m.*,
           s."name" AS "sName", s."role" AS "sRole", s."profileImage" AS "sImage",
           r."_id" AS "rId", r."content" AS "rContent", r."isDeleted" AS "rDeleted", r."type" AS "rType",
           r."attachments" AS "rAttachments", rs."_id" AS "rsId", rs."name" AS "rsName"
      FROM "messages" m
      LEFT JOIN "users" s  ON s."_id"  = m."sender"
      LEFT JOIN "messages" r ON r."_id" = m."replyTo"
      LEFT JOIN "users" rs ON rs."_id" = r."sender"`;

function shapeMessage(m, isAdmin) {
    const deleted = !!m.isDeleted;
    const out = {
        _id:         String(m._id),
        chat:        String(m.chat),
        school:      m.school ? String(m.school) : null,
        sender:      m.sender ? {
            _id: String(m.sender), name: m.sName || '', role: m.sRole || m.senderRole || '', profileImage: m.sImage || '',
        } : null,
        senderRole:  m.senderRole || '',
        content:     deleted && !isAdmin ? '' : (m.content || ''),
        type:        m.type || 'text',
        attachments: deleted && !isAdmin ? [] : (Array.isArray(m.attachments) ? m.attachments : []),
        replyTo:     m.rId ? {
            _id:       String(m.rId),
            content:   m.rDeleted && !isAdmin ? '' : (m.rContent || ''),
            isDeleted: !!m.rDeleted,
            type:      m.rType || 'text',
            sender:    m.rsId ? { _id: String(m.rsId), name: m.rsName || '' } : null,
        } : null,
        isEdited:    !!m.isEdited,
        editedAt:    iso(m.editedAt),
        isDeleted:   deleted,
        deletedAt:   iso(m.deletedAt),
        isForwarded: !!m.isForwarded,
        reactions:   Array.isArray(m.reactions) ? m.reactions.map((x) => ({ ...x, user: String(x.user) })) : [],
        clientId:    m.clientId || null,
        createdAt:   iso(m.createdAt),
        updatedAt:   iso(m.updatedAt),
    };
    // The audit trail of edits is the school admin's alone.
    if (isAdmin) out.editHistory = Array.isArray(m.editHistory) ? m.editHistory : [];
    return out;
}

/**
 * One page of a conversation, oldest first.
 *   before — the page ending just before this instant (scrolling back)
 *   after  — everything after this instant (catching up after a reconnect)
 */
async function messagesPage(chatId, schoolId, { before, after, limit = 40, isAdmin = false } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100);
    const params = [String(chatId), String(schoolId)];
    let where = `m."chat" = $1::uuid AND m."school" = $2::uuid`;
    let order = 'DESC';
    if (after && !Number.isNaN(new Date(after).getTime())) {
        params.push(new Date(after));
        where += ` AND m."createdAt" > $${params.length}`;
        order = 'ASC';
    } else if (before && !Number.isNaN(new Date(before).getTime())) {
        params.push(new Date(before));
        where += ` AND m."createdAt" < $${params.length}`;
    }
    params.push(lim + 1);
    const { rows } = await pool.query(
        `${MESSAGE_SELECT} WHERE ${where} ORDER BY m."createdAt" ${order}, m."_id" ${order} LIMIT $${params.length}`,
        params,
    );
    const hasMore = rows.length > lim;
    const page = rows.slice(0, lim).map((m) => shapeMessage(m, isAdmin));
    if (order === 'DESC') page.reverse();
    return { messages: page, hasMore };
}

async function messageById(messageId, isAdmin = false) {
    const { rows } = await pool.query(`${MESSAGE_SELECT} WHERE m."_id" = $1::uuid`, [String(messageId)]);
    return rows[0] ? shapeMessage(rows[0], isAdmin) : null;
}

// ─── Who is this? (thread header + info panel) ────────────────────────────────

async function teacherContext(teacherId, schoolId) {
    const { rows } = await pool.query(
        `WITH yr AS (
            SELECT "_id" FROM "academicyears"
             WHERE "school" = $2::uuid AND "status" = 'active'
             ORDER BY "startDate" DESC NULLS LAST LIMIT 1
         ),
         links AS (
            SELECT cs."_id", ${SECTION_LABEL('c', 'cs')} AS "label", c."classNumber" AS "num",
                   cs."sectionName" AS "sec", 'subject' AS "how", sub."subjectName" AS "subject"
              FROM "sectionsubjectteachers" sst
              JOIN "classsections" cs ON cs."_id" = sst."section"
              JOIN "classes" c ON c."_id" = cs."class"
              LEFT JOIN "subjects" sub ON sub."_id" = sst."subject"
             WHERE sst."teacher" = $1::uuid AND cs."school" = $2::uuid
               AND (NOT EXISTS (SELECT 1 FROM yr) OR cs."academicYear" = (SELECT "_id" FROM yr))
            UNION ALL
            SELECT cs."_id", ${SECTION_LABEL('c', 'cs')}, c."classNumber", cs."sectionName",
                   CASE WHEN cs."classTeacher" = $1::uuid THEN 'class' ELSE 'vice' END, NULL
              FROM "classsections" cs
              JOIN "classes" c ON c."_id" = cs."class"
             WHERE cs."school" = $2::uuid
               AND (cs."classTeacher" = $1::uuid OR cs."substituteTeacher" = $1::uuid)
               AND (NOT EXISTS (SELECT 1 FROM yr) OR cs."academicYear" = (SELECT "_id" FROM yr))
         )
         SELECT * FROM links ORDER BY "num" NULLS LAST, "sec"`,
        [String(teacherId), String(schoolId)],
    );
    const subjects = [...new Set(rows.map((r) => r.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const classes = [...new Set(rows.map((r) => r.label).filter(Boolean))];
    const classTeacherOf = [...new Set(rows.filter((r) => r.how === 'class').map((r) => r.label))];

    const { rows: [tp] } = await pool.query(
        `SELECT "designation", "department", "employeeId" FROM "teacherprofiles"
          WHERE "user" = $1::uuid LIMIT 1`,
        [String(teacherId)],
    );
    return {
        subjects, classes, classTeacherOf,
        designation: tp?.designation || '',
        department:  tp?.department || '',
    };
}

async function studentContext(studentId, schoolId) {
    const { rows: [r] } = await pool.query(
        `SELECT sp."rollNumber", sp."admissionNumber",
                ${SECTION_LABEL('c', 'cs')} AS "label",
                regexp_replace(COALESCE(pc."className", ''), '^\\s*class\\s*', '', 'i') AS "pendingClass"
           FROM "studentprofiles" sp
           LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
           LEFT JOIN "classes" c  ON c."_id"  = cs."class"
           LEFT JOIN "classes" pc ON pc."_id" = sp."currentClass"
          WHERE sp."user" = $1::uuid AND sp."school" = $2::uuid
          LIMIT 1`,
        [String(studentId), String(schoolId)],
    );
    // Admitted to a class but not placed in a section yet is a designed state —
    // name the class rather than claiming there is none.
    return {
        className:       r?.label || '',
        pendingClass:    r?.label ? '' : (r?.pendingClass || ''),
        rollNumber:      r?.rollNumber || '',
        admissionNumber: r?.admissionNumber || '',
    };
}

async function parentContext(parentId, schoolId) {
    const kids = await childCards(parentId, schoolId);
    return {
        children: kids.map((k) => ({
            _id:   k._id,
            name:  k.name,
            className: `${String(k.className || '').replace(/^\s*class\s*/i, '')}${k.sectionName || ''}`,
        })),
    };
}

/** The line under a person's name, by what they are to the school. */
async function personContext(user, schoolId) {
    if (!user) return {};
    switch (user.role) {
        case 'teacher': return teacherContext(user._id, schoolId);
        case 'student': return studentContext(user._id, schoolId);
        case 'parent':  return parentContext(user._id, schoolId);
        default:        return {};
    }
}

/**
 * Everything the thread header and the info panel show about a conversation:
 * the person (and what they teach / which class / whose parent) for a direct
 * chat, the roster for a group.
 */
async function chatProfile(chatId, schoolId, viewerId) {
    const { rows: [chat] } = await pool.query(
        `SELECT c.*, cu."name" AS "creatorName", ${SECTION_LABEL('cl', 'cs')} AS "sectionLabel", sub."subjectName"
           FROM "chats" c
           LEFT JOIN "users" cu ON cu."_id" = c."createdBy"
           LEFT JOIN "subjects" sub ON sub."_id" = c."subject"
           LEFT JOIN "classsections" cs ON cs."_id" = c."classSection"
           LEFT JOIN "classes" cl ON cl."_id" = cs."class"
          WHERE c."_id" = $1::uuid AND c."school" = $2::uuid`,
        [String(chatId), String(schoolId)],
    );
    if (!chat) return null;

    const { rows: members } = await pool.query(
        `SELECT u."_id", u."name", u."role", u."profileImage", u."lastSeenAt",
                x."role" AS "memberRole", x."joinedAt", x."lastReadAt"
           FROM "chatmembers" x
           JOIN "users" u ON u."_id" = x."user"
          WHERE x."chat" = $1::uuid AND x."isActive" = true
          ORDER BY (x."role" = 'admin') DESC, u."name"`,
        [String(chatId)],
    );
    const online = await onlineSet(members);
    const people = members.map((m) => ({
        _id:          String(m._id),
        name:         m.name || '',
        role:         m.role || '',
        profileImage: m.profileImage || '',
        memberRole:   m.memberRole || 'member',
        lastSeenAt:   iso(m.lastSeenAt),
        isOnline:     online.has(String(m._id)),
    }));

    const base = {
        _id:          String(chat._id),
        type:         chat.type,
        name:         chat.name || '',
        description:  chat.description || '',
        isReadOnly:   !!chat.isReadOnly,
        createdAt:    iso(chat.createdAt),
        createdBy:    chat.createdBy ? { _id: String(chat.createdBy), name: chat.creatorName || '' } : null,
        classSection: chat.classSection ? { _id: String(chat.classSection), label: chat.sectionLabel || '' } : null,
        kind:         chat.kind || '',
        subject:      chat.subject ? { _id: String(chat.subject), name: chat.subjectName || '' } : null,
        school:       String(chat.school),
        memberCount:  people.length,
    };

    if (chat.type === 'direct') {
        const other = people.find((p) => p._id !== String(viewerId)) || null;
        return { ...base, members: people, person: other ? { ...other, ...(await personContext(other, schoolId)) } : null };
    }
    return { ...base, members: people };
}

// ─── Search ───────────────────────────────────────────────────────────────────

const likeTerm = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Messages this person can see that contain `q`. */
async function searchMessages(userId, schoolId, q, { chatId = null, limit = 30 } = {}) {
    const { rows } = await pool.query(
        `SELECT m."_id", m."chat", m."content", m."type", m."createdAt",
                s."_id" AS "sId", s."name" AS "sName", s."role" AS "sRole", s."profileImage" AS "sImage",
                c."type" AS "cType", c."name" AS "cName",
                (SELECT u."name" FROM "chatmembers" x JOIN "users" u ON u."_id" = x."user"
                  WHERE c."type" = 'direct' AND x."chat" = c."_id" AND x."user" <> $1::uuid LIMIT 1) AS "peerName"
           FROM "messages" m
           JOIN "chatmembers" me ON me."chat" = m."chat" AND me."user" = $1::uuid AND me."isActive" = true
           JOIN "chats" c ON c."_id" = m."chat"
           LEFT JOIN "users" s ON s."_id" = m."sender"
          WHERE m."school" = $2::uuid AND m."isDeleted" IS NOT TRUE
            AND m."content" ILIKE $3
            AND ($4::uuid IS NULL OR m."chat" = $4::uuid)
          ORDER BY m."createdAt" DESC
          LIMIT $5`,
        [String(userId), String(schoolId), likeTerm(q), chatId ? String(chatId) : null, Math.min(limit, 50)],
    );
    return rows.map((r) => ({
        _id:       String(r._id),
        content:   r.content || '',
        type:      r.type || 'text',
        createdAt: iso(r.createdAt),
        sender:    r.sId ? { _id: String(r.sId), name: r.sName || '', role: r.sRole || '', profileImage: r.sImage || '' } : null,
        chat:      { _id: String(r.chat), type: r.cType, name: r.cType === 'direct' ? (r.peerName || '') : (r.cName || '') },
    }));
}

// ─── Admin: View All Chats ────────────────────────────────────────────────────
//
// Two reads behind the school admin's oversight page: everyone who has taken
// part in a conversation, then one person's conversations. Membership rows are
// read whether or not they are still active — someone who left a group still
// said what they said in it. Only conversations with at least one message
// count: an opened-and-abandoned direct chat is not communication.

/** People who have taken part in chats, most recently active first. */
async function adminPeople(schoolId, { q = '', role = '', page = 1, limit = 40 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const term = String(q || '').trim();
    const params = [
        String(schoolId),
        term ? likeTerm(term) : null,
        ['teacher', 'student', 'parent', 'school_admin'].includes(role) ? role : null,
    ];
    const base = `
        WITH part AS (
            SELECT x."user" AS "uid", count(DISTINCT c."_id")::int AS "conversations", max(c."lastActivity") AS "lastActivity"
              FROM "chatmembers" x
              JOIN "chats" c ON c."_id" = x."chat" AND c."school" = $1::uuid AND c."lastMessage" IS NOT NULL
             GROUP BY x."user"
        )
        SELECT u."_id", u."name", u."role", u."email", u."profileImage", u."isActive",
               p."conversations", p."lastActivity"
          FROM part p JOIN "users" u ON u."_id" = p."uid"
         WHERE u."school" = $1::uuid
           AND ($2::text IS NULL OR u."name" ILIKE $2 OR u."email" ILIKE $2)`;

    const [rowsRes, countsRes] = await Promise.all([
        pool.query(
            `${base} AND ($3::text IS NULL OR u."role" = $3::text)
              ORDER BY p."lastActivity" DESC NULLS LAST, u."name"
              LIMIT ${lim} OFFSET ${off}`,
            params,
        ),
        pool.query(`SELECT t."role", count(*)::int AS "n" FROM (${base}) t GROUP BY t."role"`, params.slice(0, 2)),
    ]);

    const ids = rowsRes.rows.map((r) => String(r._id));
    const [lines, sent] = await Promise.all([
        contactLines(ids, schoolId),
        ids.length
            ? pool.query(`SELECT "sender", count(*)::int AS "n" FROM "messages" WHERE "school" = $1::uuid AND "sender" = ANY($2::uuid[]) GROUP BY "sender"`,
                [String(schoolId), ids])
            : { rows: [] },
    ]);
    const sentBy = new Map(sent.rows.map((r) => [String(r.sender), r.n]));
    const byRole = Object.fromEntries(countsRes.rows.map((r) => [r.role, r.n]));
    const total = params[2] ? (byRole[params[2]] || 0) : Object.values(byRole).reduce((a, b) => a + b, 0);

    return {
        total,
        counts: byRole,
        page: Math.floor(off / lim) + 1,
        pages: Math.max(1, Math.ceil(total / lim)),
        data: rowsRes.rows.map((r) => ({
            _id:           String(r._id),
            name:          r.name || '',
            role:          r.role || '',
            profileImage:  r.profileImage || '',
            isActive:      r.isActive !== false,
            line:          lines.get(String(r._id)) || '',
            conversations: r.conversations || 0,
            messagesSent:  sentBy.get(String(r._id)) || 0,
            lastActivity:  iso(r.lastActivity),
        })),
    };
}

/**
 * One person's conversations: each direct chat under the name of whoever they
 * spoke with, each group under its own name, with counts and the last word.
 */
async function adminPersonConversations(schoolId, userId) {
    const { rows: [person] } = await pool.query(
        `SELECT "_id", "name", "role", "email", "profileImage", "lastSeenAt", "isActive"
           FROM "users" WHERE "_id" = $1::uuid AND "school" = $2::uuid`,
        [String(userId), String(schoolId)],
    );
    if (!person) return null;

    const { rows } = await pool.query(
        `SELECT c."_id", c."type", c."name", c."kind", c."isReadOnly", c."lastActivity", c."classSection",
                me."isActive" AS "stillMember", me."joinedAt", me."role" AS "memberRole",
                lm."content" AS "lmContent", lm."type" AS "lmType", lm."isDeleted" AS "lmDeleted",
                lm."createdAt" AS "lmAt", lm."sender" AS "lmSender", lms."name" AS "lmSenderName",
                cp."_id" AS "cpId", cp."name" AS "cpName", cp."role" AS "cpRole", cp."profileImage" AS "cpImage",
                sub."subjectName",
                (SELECT count(*)::int FROM "chatmembers" x WHERE x."chat" = c."_id" AND x."isActive" = true) AS "memberCount",
                (SELECT count(*)::int FROM "messages" m WHERE m."chat" = c."_id") AS "messageCount",
                (SELECT count(*)::int FROM "messages" m WHERE m."chat" = c."_id" AND m."sender" = $2::uuid) AS "sentCount"
           FROM "chatmembers" me
           JOIN "chats" c ON c."_id" = me."chat" AND c."school" = $1::uuid AND c."lastMessage" IS NOT NULL
           LEFT JOIN "messages" lm ON lm."_id" = c."lastMessage"
           LEFT JOIN "users" lms ON lms."_id" = lm."sender"
           LEFT JOIN "subjects" sub ON sub."_id" = c."subject"
           LEFT JOIN LATERAL (
                SELECT u."_id", u."name", u."role", u."profileImage"
                  FROM "chatmembers" x JOIN "users" u ON u."_id" = x."user"
                 WHERE c."type" = 'direct' AND x."chat" = c."_id" AND x."user" <> $2::uuid
                 LIMIT 1
           ) cp ON true
          WHERE me."user" = $2::uuid
          ORDER BY c."lastActivity" DESC NULLS LAST
          LIMIT 500`,
        [String(schoolId), String(userId)],
    );

    const lines = await contactLines([String(userId), ...rows.filter((r) => r.cpId).map((r) => String(r.cpId))], schoolId);
    const conversations = rows.map((r) => {
        const direct = r.type === 'direct';
        const with_ = direct && r.cpId ? {
            _id: String(r.cpId), name: r.cpName || '', role: r.cpRole || '', profileImage: r.cpImage || '',
            line: lines.get(String(r.cpId)) || '',
        } : null;
        return {
            _id:          String(r._id),
            type:         r.type,
            kind:         r.kind || '',
            name:         r.name || '',
            displayName:  direct ? (with_?.name || 'Unknown user') : (r.name || 'Group'),
            classSection: r.classSection ? String(r.classSection) : null,
            subjectName:  r.subjectName || '',
            isReadOnly:   !!r.isReadOnly,
            with:         with_,
            memberCount:  r.memberCount || 0,
            messageCount: r.messageCount || 0,
            sentCount:    r.sentCount || 0,
            stillMember:  r.stillMember !== false,
            memberRole:   r.memberRole || 'member',
            joinedAt:     iso(r.joinedAt),
            lastActivity: iso(r.lastActivity),
            lastMessage:  r.lmAt ? {
                content:   r.lmContent || '',
                type:      r.lmType || 'text',
                isDeleted: !!r.lmDeleted,
                createdAt: iso(r.lmAt),
                sender:    { _id: r.lmSender ? String(r.lmSender) : null, name: r.lmSenderName || '' },
            } : null,
        };
    });

    return {
        person: {
            _id:          String(person._id),
            name:         person.name || '',
            role:         person.role || '',
            email:        person.email || '',
            profileImage: person.profileImage || '',
            isActive:     person.isActive !== false,
            lastSeenAt:   iso(person.lastSeenAt),
            line:         lines.get(String(person._id)) || '',
            stats: {
                conversations: conversations.length,
                direct:        conversations.filter((c) => c.type === 'direct').length,
                groups:        conversations.filter((c) => c.type !== 'direct').length,
                messagesSent:  conversations.reduce((n, c) => n + c.sentCount, 0),
            },
        },
        conversations,
    };
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

/**
 * A short line per person for the new-chat picker: what they teach, which
 * class they are in, whose parent they are. One statement for the whole list.
 */
async function contactLines(userIds, schoolId) {
    const ids = [...new Set((userIds || []).map(String))];
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(
        `WITH yr AS (
            SELECT "_id" FROM "academicyears"
             WHERE "school" = $2::uuid AND "status" = 'active'
             ORDER BY "startDate" DESC NULLS LAST LIMIT 1
         )
         SELECT u."_id"::text AS "id", u."role",
                (SELECT string_agg(DISTINCT sub."subjectName", ', ')
                   FROM "sectionsubjectteachers" sst
                   JOIN "classsections" cs ON cs."_id" = sst."section"
                   JOIN "subjects" sub ON sub."_id" = sst."subject"
                  WHERE u."role" = 'teacher' AND sst."teacher" = u."_id"
                    AND (NOT EXISTS (SELECT 1 FROM yr) OR cs."academicYear" = (SELECT "_id" FROM yr))) AS "subjects",
                (SELECT tp."designation" FROM "teacherprofiles" tp WHERE tp."user" = u."_id" LIMIT 1) AS "designation",
                (SELECT ${SECTION_LABEL('c', 'cs')}
                   FROM "studentprofiles" sp
                   JOIN "classsections" cs ON cs."_id" = sp."currentSection"
                   JOIN "classes" c ON c."_id" = cs."class"
                  WHERE u."role" = 'student' AND sp."user" = u."_id" LIMIT 1) AS "classLabel"
           FROM "users" u
          WHERE u."_id" = ANY($1::uuid[])`,
        [ids, String(schoolId)],
    );
    for (const r of rows) {
        let line = '';
        if (r.role === 'teacher') line = r.subjects || r.designation || 'Teacher';
        else if (r.role === 'student') line = r.classLabel ? `Class ${r.classLabel}` : 'Student';
        else if (r.role === 'parent') line = 'Parent';
        else if (r.role === 'school_admin') line = 'School Admin';
        out.set(r.id, line);
    }
    // Parents: whose parent, read through both links.
    const parents = rows.filter((r) => r.role === 'parent').map((r) => r.id);
    if (parents.length) {
        const { rows: kids } = await pool.query(
            `SELECT DISTINCT l."parent", u."name"
               FROM (
                    SELECT sp."parent"::text AS "parent", sp."user" AS "student"
                      FROM "studentprofiles" sp WHERE sp."parent" = ANY($1::uuid[])
                    UNION
                    SELECT pp."user"::text, e.id::uuid
                      FROM "parentprofiles" pp
                     CROSS JOIN LATERAL jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(pp."children") = 'array' THEN pp."children" ELSE '[]'::jsonb END) AS e(id)
                     WHERE pp."user" = ANY($1::uuid[])
               ) l
               JOIN "users" u ON u."_id" = l."student" AND u."school" = $2::uuid`,
            [parents, String(schoolId)],
        );
        const byParent = new Map();
        for (const k of kids) {
            if (!byParent.has(k.parent)) byParent.set(k.parent, []);
            byParent.get(k.parent).push(k.name);
        }
        for (const [pid, names] of byParent) out.set(pid, `Parent of ${names.sort().join(', ')}`);
    }
    return out;
}

module.exports = {
    onlineSet,
    listChats,
    chatSummary,
    unreadTotal,
    messagesPage,
    messageById,
    chatProfile,
    searchMessages,
    adminPeople,
    adminPersonConversations,
    contactLines,
    shapeMessage,
};
