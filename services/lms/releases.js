'use strict';
/**
 * Video Learning — a teacher releasing content to their students.
 *
 *   level book     the whole book: every chapter, every video
 *         chapter  one chapter and all its videos
 *         video    ONE video of a chapter — and nothing else in that chapter
 *
 * A release is for one section. A teacher may act only where they are the
 * subject teacher of the book's subject (services/lms/access); that is
 * checked again on every action, so a teacher taken off a section loses the
 * controls with the timetable change, not at their next sign-in.
 *
 * Nothing here deletes. Unpublishing or revoking closes access from that
 * moment — open watch sessions included — and leaves every student's watch
 * record exactly as it was. Every step is written to the audit history.
 */
const { q, M, T, bad, notFound, conflict, forbidden, str, id, idOrNull, oneOf, dateOrNull, paging, audit } = require('./common');
const { withTransaction } = require('../dbTx');
const access = require('./access');
const notices = require('./notices');

const one = async (sql, params) => (await q(sql, params))[0] || null;

/** What a release is right now, whatever its stored status says (alias r). */
const SHOWN_STATUS = `(CASE
    WHEN r."status" IN ('scheduled', 'active') AND r."expiresAt" IS NOT NULL AND r."expiresAt" <= now() THEN 'expired'
    WHEN r."status" = 'scheduled' AND r."releaseAt" <= now() THEN 'active'
    ELSE r."status" END)`;

const RELEASE_SELECT = `
    SELECT r.*, ${SHOWN_STATUS} AS "shownStatus",
           k."title" AS "bookTitle", k."coverUrl", ch."title" AS "chapterTitle", ch."chapterNumber", v."title" AS "videoTitle",
           c."className", cs."sectionName", ss."subjectName", u."name" AS "createdByName",
           COALESCE(jsonb_array_length(r."students"), 0) AS "selectedCount"
      FROM ${T.release} r
      JOIN ${T.book} k ON k."_id" = r."book"
      LEFT JOIN ${T.chapter} ch ON ch."_id" = r."chapter"
      LEFT JOIN ${T.video} v ON v."_id" = r."video"
      JOIN ${T.class} c ON c."_id" = r."class"
      JOIN ${T.section} cs ON cs."_id" = r."section"
      LEFT JOIN ${T.schoolSubjectRow} ss ON ss."_id" = r."schoolSubject"
      LEFT JOIN ${T.user} u ON u."_id" = r."createdBy"`;

/** Close every open watch session a release was feeding. Their playback addresses stop working at once. */
async function closeSessions(releaseId, reason) {
    await q(`UPDATE ${T.session} SET "status" = 'closed', "closeReason" = $2, "endedAt" = now(), "updatedAt" = now() WHERE "release" = $1 AND "status" = 'open'`, [releaseId, reason]);
}

// ── What a teacher has to work with ──────────────────────────────────────────

/** The teacher's sections and subjects, and the books each follows — with how much of each is out. */
async function workspace(user) {
    const scope = await access.teacherScope(user);
    if (!scope.assignments.length) return { sections: scope.pairs, books: [] };
    const bookIds = [...new Set(scope.assignments.map((a) => String(a.book)))];
    const books = await q(`
        SELECT k."_id", k."title", k."publisher", k."edition", k."coverUrl", k."classLevel", k."language", ls."name" AS "subjectName",
               (SELECT count(*) FROM ${T.chapter} c WHERE c."book" = k."_id" AND c."status" = 'active')::int AS "chapterCount",
               (SELECT count(*) FROM ${T.chapterVideo} cv JOIN ${T.video} v ON v."_id" = cv."video" AND v."isActive" AND v."processingStatus" = 'ready'
                 WHERE cv."book" = k."_id" AND cv."isActive")::int AS "videoCount"
          FROM ${T.book} k JOIN ${T.subject} ls ON ls."_id" = k."subject"
         WHERE k."_id" = ANY($1::uuid[]) AND k."status" IN ('active', 'archived') ORDER BY lower(k."title")`, [bookIds]);
    const live = await q(`
        SELECT r."book", r."section", count(*)::int AS n FROM ${T.release} r
         WHERE r."school" = $1 AND r."book" = ANY($2::uuid[]) AND ${access.LIVE} GROUP BY r."book", r."section"`, [scope.schoolId, bookIds]);
    return {
        sections: scope.pairs,
        books: books.map((b) => ({
            ...b,
            sections: scope.assignments.filter((a) => String(a.book) === String(b._id)).map((a) => {
                const p = scope.pairs.find((x) => String(x.section) === String(a.section) && String(x.schoolSubject) === String(a.schoolSubject));
                return { section: a.section, class: a.class, className: p?.className, sectionName: p?.sectionName, subjectName: p?.subjectName,
                    schoolSubject: a.schoolSubject, studentCount: p?.studentCount || 0,
                    liveReleases: live.find((l) => String(l.book) === String(b._id) && String(l.section) === String(a.section))?.n || 0 };
            }),
        })),
    };
}

/**
 * One of the teacher's books: its chapters and their ready videos, and — for
 * the section asked about — which of them are out, and how.
 */
async function bookForTeacher(user, bookId, sectionId = null) {
    const scope = await access.teacherScope(user);
    const mine = scope.assignments.filter((a) => String(a.book) === String(id(bookId, 'Book')));
    if (!mine.length) throw forbidden('This book is not assigned to a section you teach', 'OUT_OF_SCOPE');
    const section = sectionId ? id(sectionId, 'Section') : String(mine[0].section);
    if (!mine.some((a) => String(a.section) === section)) throw forbidden('You do not teach this book in that section', 'OUT_OF_SCOPE');
    const [book, chapters, videos, live] = await Promise.all([
        one(`SELECT k."_id", k."title", k."publisher", k."author", k."edition", k."coverUrl", k."classLevel", k."description", ls."name" AS "subjectName"
               FROM ${T.book} k JOIN ${T.subject} ls ON ls."_id" = k."subject" WHERE k."_id" = $1`, [bookId]),
        q(`SELECT "_id", "title", "chapterNumber", "description", "thumbnailUrl", "estimatedMinutes" FROM ${T.chapter}
            WHERE "book" = $1 AND "status" = 'active' ORDER BY "displayOrder", "chapterNumber"`, [bookId]),
        q(`SELECT cv."_id", cv."chapter", cv."video", v."title", v."durationSec", v."thumbnailUrl", v."thumbnailKey", v."provider", v."language"
             FROM ${T.chapterVideo} cv JOIN ${T.video} v ON v."_id" = cv."video" AND v."isActive" AND v."processingStatus" = 'ready'
            WHERE cv."book" = $1 AND cv."isActive" ORDER BY cv."displayOrder", cv."createdAt"`, [bookId]),
        q(`SELECT r."_id", r."level", r."chapter", r."chapterVideo", r."audience", r."releaseAt", r."expiresAt", ${SHOWN_STATUS} AS "shownStatus"
             FROM ${T.release} r WHERE r."school" = $1 AND r."section" = $2 AND r."book" = $3 AND r."status" IN ('scheduled', 'active')
              AND (r."expiresAt" IS NULL OR r."expiresAt" > now())`, [scope.schoolId, section, bookId]),
    ]);
    const { thumbOf } = require('./catalog');
    const bookRelease = live.find((r) => r.level === 'book') || null;
    return {
        book, section,
        sections: mine.map((a) => { const p = scope.pairs.find((x) => String(x.section) === String(a.section)); return { section: a.section, className: p?.className, sectionName: p?.sectionName, studentCount: p?.studentCount || 0 }; }),
        bookRelease,
        chapters: chapters.map((c) => {
            const chapterRelease = live.find((r) => r.level === 'chapter' && String(r.chapter) === String(c._id)) || null;
            return {
                ...c, release: chapterRelease,
                videos: videos.filter((v) => String(v.chapter) === String(c._id)).map((v) => {
                    const own = live.find((r) => r.level === 'video' && String(r.chapterVideo) === String(v._id)) || null;
                    const via = own || chapterRelease || bookRelease;
                    return { ...thumbOf(v), release: own, releasedVia: via ? via.level : null, releasedStatus: via ? via.shownStatus : null };
                }),
            };
        }),
    };
}

// ── Creating ─────────────────────────────────────────────────────────────────

/** Read and check when a release opens and closes. */
function timing(body, { now = new Date() } = {}) {
    let releaseAt = dateOrNull(body.releaseAt, 'Release date');
    // "Now", or a moment already gone, opens at once.
    if (!releaseAt || releaseAt.getTime() <= now.getTime() + 30000) releaseAt = now;
    const expiresAt = dateOrNull(body.expiresAt, 'Expiry date');
    if (expiresAt && expiresAt.getTime() <= releaseAt.getTime()) throw bad('The expiry must be after the release date');
    if (expiresAt && expiresAt.getTime() <= now.getTime()) throw bad('The expiry is already in the past');
    return { releaseAt, expiresAt, status: releaseAt.getTime() > now.getTime() ? 'scheduled' : 'active' };
}

/** Read the audience of a release for a section: everyone, or students who are on its roster. */
async function audienceFor(schoolId, sectionId, body) {
    const audience = body.audience === 'selected' ? 'selected' : 'all';
    if (audience === 'all') return { audience, students: [] };
    const want = [...new Set((Array.isArray(body.students) ? body.students : []).map((s) => id(s, 'Student')))];
    if (!want.length) throw bad('Choose at least one student, or release to the whole section');
    const roster = new Set((await access.roster(schoolId, sectionId)).map((s) => String(s._id)));
    const strangers = want.filter((s) => !roster.has(s));
    if (strangers.length) throw bad(`${strangers.length} of the chosen students ${strangers.length === 1 ? 'is' : 'are'} not in this section`, 'NOT_IN_SECTION');
    return { audience, students: want };
}

/** Check what is being released belongs to the book and can be played. Returns { chapter, chapterVideo, video }. */
async function targetFor(bookId, level, body) {
    if (level === 'book') {
        const n = await one(`SELECT count(*)::int AS n FROM ${T.chapter} WHERE "book" = $1 AND "status" = 'active'`, [bookId]);
        if (!n.n) throw bad('This book has no chapters yet, so there is nothing to release');
        return { chapter: null, chapterVideo: null, video: null };
    }
    if (level === 'chapter') {
        const ch = await M.chapter.findOne({ _id: id(body.chapter, 'Chapter'), book: bookId }).lean();
        if (!ch || ch.status !== 'active') throw notFound('Chapter');
        return { chapter: ch._id, chapterVideo: null, video: null };
    }
    const cv = await one(`
        SELECT cv."_id", cv."chapter", cv."video" FROM ${T.chapterVideo} cv
          JOIN ${T.chapter} ch ON ch."_id" = cv."chapter" AND ch."status" = 'active'
          JOIN ${T.video} v ON v."_id" = cv."video" AND v."isActive" AND v."processingStatus" = 'ready'
         WHERE cv."_id" = $1 AND cv."book" = $2 AND cv."isActive"`, [id(body.chapterVideo, 'Video'), bookId]);
    if (!cv) throw notFound('Video');
    return { chapter: cv.chapter, chapterVideo: cv._id, video: cv.video };
}

/** Is the same thing already out (or booked) for everyone in this section? */
async function duplicateOf(tx, schoolId, sectionId, bookId, level, target, exceptId = null) {
    const { rows } = await tx(`
        SELECT r."_id" FROM ${T.release} r
         WHERE r."school" = $1 AND r."section" = $2 AND r."book" = $3 AND r."level" = $4 AND r."audience" = 'all'
           AND r."status" IN ('scheduled', 'active') AND (r."expiresAt" IS NULL OR r."expiresAt" > now())
           AND COALESCE(r."chapter"::text, '') = COALESCE($5::text, '') AND COALESCE(r."chapterVideo"::text, '') = COALESCE($6::text, '')
           AND ($7::uuid IS NULL OR r."_id" <> $7::uuid) LIMIT 1`,
    [schoolId, sectionId, bookId, level, target.chapter, target.chapterVideo, exceptId]);
    return rows[0] || null;
}

/**
 * Release a book, a chapter or a video to one or more of the teacher's
 * sections. `sections` may list several; each gets its own release, and they
 * are created together or not at all.
 */
async function create(req, body) {
    const user = req.user;
    const scope = await access.teacherScope(user);
    const bookId = id(body.book, 'Book');
    const level = oneOf(body.level, ['book', 'chapter', 'video'], 'Release level');
    const sections = [...new Set((Array.isArray(body.sections) ? body.sections : [body.section]).filter(Boolean).map((s) => id(s, 'Section')))];
    if (!sections.length) throw bad('Choose the section to release to');
    if (body.audience === 'selected' && sections.length > 1) throw bad('Choosing individual students works one section at a time');
    const grants = sections.map((s) => access.teacherAssignment(scope, s, bookId));     // 403 outside the teacher's subjects
    const target = await targetFor(bookId, level, body);
    const when = timing(body);
    const note = str(body.note, 500);
    const audiences = [];
    for (const s of sections) audiences.push(await audienceFor(scope.schoolId, s, body));

    const created = await withTransaction(async (tx) => {
        const out = [];
        for (let i = 0; i < sections.length; i++) {
            const g = grants[i];
            await tx('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`lms-release:${sections[i]}:${bookId}`]);
            if (audiences[i].audience === 'all' && await duplicateOf(tx, scope.schoolId, sections[i], bookId, level, target)) {
                throw conflict(`This is already released${sections.length > 1 ? ` to ${g.pair?.className || ''} ${g.pair?.sectionName || ''}` : ' to this section'}. Edit or take down the existing release instead.`, 'ALREADY_RELEASED');
            }
            const { rows } = await tx(`
                INSERT INTO ${T.release} ("_id", "school", "academicYear", "class", "section", "schoolSubject", "lmsSubject", "assignment", "book",
                       "level", "chapter", "chapterVideo", "video", "audience", "students", "releaseAt", "expiresAt", "status", "note",
                       "reReleaseOf", "createdBy", "updatedBy", "createdAt", "updatedAt")
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $20, now(), now())
                RETURNING *`,
            [scope.schoolId, g.academicYear, g.class, sections[i], g.schoolSubject, g.lmsSubject, g.assignment, bookId, level,
                target.chapter, target.chapterVideo, target.video, audiences[i].audience, JSON.stringify(audiences[i].students),
                when.releaseAt, when.expiresAt, when.status, note, idOrNull(body.reReleaseOf, 'Release'), user._id]);
            out.push(rows[0]);
        }
        return out;
    });
    for (const r of created) {
        await audit(req, r.reReleaseOf ? 'release.rereleased' : (r.status === 'scheduled' ? 'release.scheduled' : 'release.published'), 'release', r._id,
            `${level} released to a section`, { level, book: bookId, section: r.section, audience: r.audience, releaseAt: r.releaseAt, expiresAt: r.expiresAt });
        if (r.status === 'active') notices.releaseAvailable(r).catch((e) => console.error('[video] release notice failed:', e.message));
    }
    return created.map((r) => r._id);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The teacher's releases. tab: active | scheduled | history. */
async function list(user, query) {
    const scope = await access.teacherScope(user);
    const pg = paging(query);
    const params = [scope.schoolId, String(user._id), scope.pairs.map((p) => p.section), scope.pairs.map((p) => p.schoolSubject)];
    // Their own, and those of a subject they now teach (a colleague's before them).
    const where = [`r."school" = $1`, `(r."createdBy" = $2 OR EXISTS (SELECT 1 FROM unnest($3::uuid[], $4::uuid[]) AS p(s, j) WHERE p.s = r."section" AND p.j = r."schoolSubject"))`];
    const tab = query.tab || 'active';
    if (tab === 'active') where.push(`${SHOWN_STATUS} = 'active'`);
    else if (tab === 'scheduled') where.push(`${SHOWN_STATUS} = 'scheduled'`);
    else if (tab === 'history') where.push(`${SHOWN_STATUS} IN ('expired', 'unpublished', 'revoked')`);
    if (query.section) { params.push(id(query.section, 'Section')); where.push(`r."section" = $${params.length}`); }
    if (query.book) { params.push(id(query.book, 'Book')); where.push(`r."book" = $${params.length}`); }
    if (query.level) { params.push(oneOf(query.level, ['book', 'chapter', 'video'], 'Level')); where.push(`r."level" = $${params.length}`); }
    const w = where.join(' AND ');
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.release} r WHERE ${w}`, params);
    const rows = await q(`${RELEASE_SELECT} WHERE ${w} ORDER BY r."releaseAt" DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    const counts = await one(`
        SELECT count(*) FILTER (WHERE s = 'active')::int AS active, count(*) FILTER (WHERE s = 'scheduled')::int AS scheduled,
               count(*) FILTER (WHERE s IN ('expired', 'unpublished', 'revoked'))::int AS history
          FROM (SELECT ${SHOWN_STATUS} AS s FROM ${T.release} r WHERE ${where.slice(0, 2).join(' AND ')}) x`, params.slice(0, 4));
    return { rows, total: n, pg, counts };
}

/** A release the teacher may act on — or a 403 / 404. `mustTeach` insists they teach it today. */
async function mine(user, releaseId, { mustTeach = true } = {}) {
    const scope = await access.teacherScope(user);
    const r = await one(`${RELEASE_SELECT} WHERE r."_id" = $1 AND r."school" = $2`, [id(releaseId, 'Release'), scope.schoolId]);
    if (!r) throw notFound('Release');
    const teaches = access.teaches(scope, r.section, r.schoolSubject);
    if (!teaches && String(r.createdBy) !== String(user._id)) throw notFound('Release');
    if (mustTeach && !teaches) throw forbidden('You no longer teach this subject in this section, so you cannot change its releases', 'OUT_OF_SCOPE');
    return { r, scope };
}

async function get(user, releaseId) {
    const { r } = await mine(user, releaseId, { mustTeach: false });
    const students = r.audience === 'selected'
        ? await q(`SELECT u."_id", u."name" FROM ${T.user} u WHERE u."_id"::text = ANY($1::text[]) ORDER BY lower(u."name")`, [(r.students || []).map(String)])
        : [];
    const history = await q(`
        SELECT a."action", a."summary", a."meta", a."createdAt", u."name" AS "actorName"
          FROM ${T.audit} a LEFT JOIN ${T.user} u ON u."_id" = a."actor" WHERE a."entityType" = 'release' AND a."entityId" = $1 ORDER BY a."createdAt"`, [r._id]);
    return { ...r, selectedStudents: students, history };
}

// ── Changing ─────────────────────────────────────────────────────────────────

/**
 * Edit a release: a scheduled one fully (when, until, who, note); one already
 * open only in its expiry, its audience and its note.
 */
async function update(req, releaseId, body) {
    const { r, scope } = await mine(req.user, releaseId);
    if (!['scheduled', 'active'].includes(r.shownStatus)) throw conflict(`A release that is ${r.shownStatus} cannot be edited. Release it again instead.`, 'NOT_EDITABLE');
    const set = { updatedBy: req.user._id };
    const releaseAt = r.shownStatus === 'scheduled' && body.releaseAt !== undefined ? timing({ releaseAt: body.releaseAt, expiresAt: null }) : null;
    if (releaseAt) { set.releaseAt = releaseAt.releaseAt; set.status = releaseAt.status; }
    if (body.expiresAt !== undefined) {
        const exp = dateOrNull(body.expiresAt, 'Expiry date');
        const from = set.releaseAt || new Date(r.releaseAt);
        if (exp && (exp.getTime() <= from.getTime() || exp.getTime() <= Date.now())) throw bad('The expiry must be in the future and after the release date');
        set.expiresAt = exp;
    }
    if (body.audience !== undefined) {
        const a = await audienceFor(scope.schoolId, r.section, body);
        if (a.audience === 'all' && r.audience !== 'all') {
            const dup = await withTransaction((tx) => duplicateOf(tx, scope.schoolId, r.section, r.book, r.level, r, r._id));
            if (dup) throw conflict('The same content is already released to the whole section', 'ALREADY_RELEASED');
        }
        set.audience = a.audience; set.students = a.students;
    }
    if (body.note !== undefined) set.note = str(body.note, 500);
    await M.release.updateOne({ _id: r._id }, { $set: set });
    // A student taken off the list stops watching now, not when their session ends.
    if (set.audience === 'selected') {
        await q(`UPDATE ${T.session} SET "status" = 'closed', "closeReason" = 'audience_changed', "endedAt" = now(), "updatedAt" = now()
                  WHERE "release" = $1 AND "status" = 'open' AND NOT ("student"::text = ANY($2::text[]))`, [r._id, set.students.map(String)]);
    }
    await audit(req, 'release.edited', 'release', r._id, 'Release edited', { releaseAt: set.releaseAt, expiresAt: set.expiresAt, audience: set.audience, students: set.students?.length });
    const fresh = await M.release.findById(r._id).lean();
    if (fresh.status === 'active' && !fresh.availableNotifiedAt) notices.releaseAvailable(fresh).catch(() => {});
    return get(req.user, r._id);
}

/** Take a release down. It can be published again. */
async function unpublish(req, releaseId) {
    const { r } = await mine(req.user, releaseId);
    if (!['scheduled', 'active'].includes(r.shownStatus)) throw conflict(`This release is already ${r.shownStatus}`, 'NOT_LIVE');
    await M.release.updateOne({ _id: r._id }, { $set: { status: 'unpublished', unpublishedAt: new Date(), updatedBy: req.user._id } });
    await closeSessions(r._id, 'unpublished');
    await audit(req, 'release.unpublished', 'release', r._id, 'Release taken down');
    return get(req.user, r._id);
}

/** Put an unpublished release back: open now, or at its date if that is still ahead. */
async function publish(req, releaseId) {
    const { r, scope } = await mine(req.user, releaseId);
    if (r.status !== 'unpublished') throw conflict('Only a release that was taken down can be published again', 'NOT_UNPUBLISHED');
    access.teacherAssignment(scope, r.section, r.book);          // the section must still follow the book
    if (r.expiresAt && new Date(r.expiresAt) <= new Date()) throw conflict('This release has passed its expiry. Release it again with new dates.', 'EXPIRED');
    if (r.audience === 'all') {
        const dup = await withTransaction((tx) => duplicateOf(tx, scope.schoolId, r.section, r.book, r.level, r, r._id));
        if (dup) throw conflict('The same content has been released again since — this one is not needed', 'ALREADY_RELEASED');
    }
    const future = new Date(r.releaseAt) > new Date();
    await M.release.updateOne({ _id: r._id }, { $set: { status: future ? 'scheduled' : 'active', unpublishedAt: null, updatedBy: req.user._id } });
    await audit(req, 'release.published', 'release', r._id, 'Release published again');
    return get(req.user, r._id);
}

/** Withdraw access for good. The release stays in the history; what was watched stays on record. */
async function revoke(req, releaseId, body) {
    const { r } = await mine(req.user, releaseId);
    if (r.status === 'revoked') throw conflict('This release is already revoked', 'ALREADY_REVOKED');
    const reason = str(body?.reason, 500);
    await M.release.updateOne({ _id: r._id }, { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user._id, revokeReason: reason, updatedBy: req.user._id } });
    await closeSessions(r._id, 'revoked');
    await audit(req, 'release.revoked', 'release', r._id, reason || 'Access revoked', { previous: r.shownStatus });
    return get(req.user, r._id);
}

/** Release again what an ended release covered — a new release, with its own dates, linked to the old one. */
async function rerelease(req, releaseId, body) {
    const { r } = await mine(req.user, releaseId);
    if (['scheduled', 'active'].includes(r.shownStatus)) throw conflict('This release is still open — edit it instead', 'STILL_LIVE');
    const [newId] = await create(req, {
        book: r.book, level: r.level, section: r.section, chapter: r.chapter, chapterVideo: r.chapterVideo,
        audience: body.audience ?? r.audience, students: body.students ?? r.students,
        releaseAt: body.releaseAt, expiresAt: body.expiresAt, note: body.note ?? r.note, reReleaseOf: r._id,
    });
    return get(req.user, newId);
}

module.exports = { workspace, bookForTeacher, create, list, get, update, unpublish, publish, revoke, rerelease, closeSessions, SHOWN_STATUS, RELEASE_SELECT };
