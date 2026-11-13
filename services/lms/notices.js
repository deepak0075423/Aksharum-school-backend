'use strict';
/**
 * Video Learning — its notifications, sent through the ERP's own notification
 * service (services/notifyService): the bell, the phone's tray, the browser.
 * Nothing here delivers anything itself.
 *
 * Each thing worth telling has a key, claimed in LmsNotice before it is sent
 * (`claim`). A second server, a retried request or a repeated heartbeat finds
 * the key taken and says nothing — nobody is told the same thing twice.
 *
 *   a new book in the library           → admins of the schools on its board
 *   a request's status changes          → the school that asked
 *   a teacher releases book/chapter/video, or a scheduled one opens
 *                                        → the students it is for
 *   a student finishes a video / chapter → the teacher who released it
 *   released content not started after N days → those students, once
 */
const { q, M, T, levelLabel } = require('./common');
const { notify, schoolAdminIds } = require('../notifyService');
const access = require('./access');
const settings = require('./settings');

/** Take the key. True when this caller is the one who should send. */
async function claim(key, kind = '', school = null) {
    const rows = await q(`
        INSERT INTO ${T.notice} ("_id", "key", "kind", "school", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) ON CONFLICT ("key") DO NOTHING RETURNING "_id"`, [key, kind, school]);
    return rows.length > 0;
}

const superAdminIds = async () => (await q(`SELECT "_id" FROM ${T.user} WHERE "role" = 'super_admin' AND "isActive" IS NOT FALSE`, [])).map((r) => r._id);

// ── The library ──────────────────────────────────────────────────────────────

/** A book has gone live for the first time: tell the admins of every school that follows its board. */
async function bookAdded(book, actor) {
    if (book.status !== 'active') return 0;
    if (!await claim(`book:new:${book._id}`, 'book_added')) return 0;
    await M.book.updateOne({ _id: book._id }, { $set: { announcedAt: new Date() } });
    const schools = await q(`
        SELECT DISTINCT c."school" FROM ${T.schoolConfig} c
          JOIN ${T.year} y ON y."_id" = c."academicYear" AND y."status" = 'active'
          JOIN ${T.school} s ON s."_id" = c."school" AND s."isActive" IS NOT FALSE AND COALESCE((s."modules"->>'videoLibrary')::boolean, false)
         WHERE c."board" = $1`, [book.board]);
    for (const { school } of schools) {
        notify({
            school, sender: actor._id, senderRole: 'super_admin', includeSender: false,
            title: 'New book in the video library',
            body: `${book.title}${book.publisher ? ` (${book.publisher})` : ''} — ${book.subjectName || 'a subject you follow'}, ${levelLabel(book.classLevel)} — is now available to select for your classes.`,
            recipients: await schoolAdminIds(school),
            link: { type: 'video.setup' },
        });
    }
    return schools.length;
}

// ── Requests ─────────────────────────────────────────────────────────────────

const REQUEST_WORDS = {
    under_review: 'is under review', approved: 'was approved', rejected: 'was not approved',
    in_progress: 'is being worked on', completed: 'is complete',
};
const requestName = (r) => (r.type === 'book' ? `the book "${r.title}"` : `Chapter ${r.chapterNumber ?? ''} ${r.chapterName || r.topic || ''}`.replace(/\s+/g, ' ').trim());

/** A school filed a request: tell the Super Admins. */
async function requestFiled(request, schoolName, actor) {
    if (!await claim(`request:${request._id}:filed`, 'request_filed', request.school)) return;
    notify({
        school: null, sender: actor._id, senderRole: actor.role,
        title: request.type === 'book' ? 'A school has requested a book' : 'A school has requested a chapter',
        body: `${schoolName || 'A school'} asked for ${requestName(request)}.`,
        recipients: await superAdminIds(),
        link: { type: 'video.requests', entityId: request._id },
    });
}

/** A request moved on: tell the person who asked and the school's other admins. */
async function requestStatus(request, actor) {
    const words = REQUEST_WORDS[request.status];
    if (!words) return;
    if (!await claim(`request:${request._id}:${request.status}`, 'request_status', request.school)) return;
    const admins = await schoolAdminIds(request.school);
    notify({
        school: request.school, sender: actor._id, senderRole: 'super_admin',
        title: request.status === 'completed' ? (request.type === 'book' ? 'Your requested book is ready' : 'Your requested chapter is ready')
            : `Your ${request.type} request ${words}`,
        body: `Your request for ${requestName(request)} ${words}.${request.reviewNote ? ` Note: ${request.reviewNote}` : ''}`,
        recipients: [...new Set([String(request.requestedBy), ...admins.map(String)])],
        link: { type: 'video.requests', entityId: request._id },
    });
}

// ── Releases ─────────────────────────────────────────────────────────────────

/** The students a release is for, as they stand on the section's roster today. */
async function releaseAudience(release) {
    const roster = await access.roster(release.school, release.section);
    const picked = release.audience === 'selected' ? new Set((release.students || []).map(String)) : null;
    return roster.filter((s) => !picked || picked.has(String(s._id))).map((s) => String(s._id));
}

async function releaseTarget(release) {
    const [row] = await q(`
        SELECT k."title" AS "bookTitle", ch."title" AS "chapterTitle", ch."chapterNumber", v."title" AS "videoTitle"
          FROM ${T.book} k
          LEFT JOIN ${T.chapter} ch ON ch."_id" = $2
          LEFT JOIN ${T.chapterVideo} cv ON cv."_id" = $3
          LEFT JOIN ${T.video} v ON v."_id" = cv."video"
         WHERE k."_id" = $1`, [release.book, release.chapter, release.chapterVideo]);
    return row || {};
}

/**
 * A release is open: tell its students. Called when a teacher publishes one
 * for now, and by the sweep when a scheduled one comes due — whichever gets
 * there first claims it.
 */
async function releaseAvailable(release, { scheduled = false } = {}) {
    if (!await claim(`release:${release._id}:available`, 'release', release.school)) return 0;
    await M.release.updateOne({ _id: release._id }, { $set: { availableNotifiedAt: new Date() } });
    const recipients = await releaseAudience(release);
    if (!recipients.length) return 0;
    const t = await releaseTarget(release);
    const by = { book: [`New book released: ${t.bookTitle}`, 'All its chapters and videos are open to you.', { type: 'video.book', entityId: release.book }],
        chapter: [`New chapter released: ${t.chapterTitle}`, `Chapter ${t.chapterNumber} of ${t.bookTitle} is open to you.`, { type: 'video.chapter', entityId: release.chapter }],
        video: [`New video released: ${t.videoTitle}`, `A video from Chapter ${t.chapterNumber} of ${t.bookTitle} is open to you.`, { type: 'video.watch', entityId: release.chapterVideo }] }[release.level];
    notify({
        school: release.school, sender: release.createdBy, senderRole: 'teacher',
        title: scheduled ? by[0].replace(/^New (\w+) released/, (m, w) => `${w[0].toUpperCase()}${w.slice(1)} now available`) : by[0],
        body: `${by[1]}${release.expiresAt ? ` Available until ${new Date(release.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}`,
        recipients, link: by[2],
    });
    return recipients.length;
}

// ── Completion ───────────────────────────────────────────────────────────────

/** A student has just finished a video — and perhaps, with it, the chapter. */
async function videoCompleted(progress, { releasedBy, studentName }) {
    if (!releasedBy) return;
    const prefs = await settings.school(progress.school);
    const [info] = await q(`
        SELECT v."title" AS "videoTitle", ch."title" AS "chapterTitle", ch."chapterNumber", k."title" AS "bookTitle"
          FROM ${T.video} v JOIN ${T.chapter} ch ON ch."_id" = $2 JOIN ${T.book} k ON k."_id" = ch."book" WHERE v."_id" = $1`, [progress.video, progress.chapter]);
    const link = { type: 'video.progress', params: { student: String(progress.student) } };
    if (prefs.notifyTeacherOnVideoComplete && await claim(`complete:video:${progress._id}`, 'video_complete', progress.school)) {
        notify({
            school: progress.school, sender: progress.student, senderRole: 'student',
            title: `${studentName} completed a video`,
            body: `${studentName} finished "${info?.videoTitle || 'a video'}" (Chapter ${info?.chapterNumber ?? ''} of ${info?.bookTitle || 'the book'}).`,
            recipients: [releasedBy], link,
        });
    }
    if (!prefs.notifyTeacherOnChapterComplete) return;
    // The chapter is complete when every video of it that this student has been given is.
    const ctx = { schoolId: String(progress.school), section: progress.section, userId: String(progress.student) };
    const items = await access.entitledItems(ctx, { chapter: progress.chapter });
    if (!items.length) return;
    const done = await q(`SELECT "chapterVideo" FROM ${T.progress} WHERE "student" = $1 AND "academicYear" = $2 AND "chapter" = $3 AND "status" = 'completed'`,
        [progress.student, progress.academicYear, progress.chapter]);
    const doneSet = new Set(done.map((d) => String(d.chapterVideo)));
    if (!items.every((i) => doneSet.has(String(i.chapterVideo)))) return;
    if (!await claim(`complete:chapter:${progress.student}:${progress.chapter}:${progress.academicYear}`, 'chapter_complete', progress.school)) return;
    notify({
        school: progress.school, sender: progress.student, senderRole: 'student',
        title: `${studentName} completed a chapter`,
        body: `${studentName} has watched every released video of Chapter ${info?.chapterNumber ?? ''} "${info?.chapterTitle || ''}" (${info?.bookTitle || 'the book'}).`,
        recipients: [releasedBy], link,
    });
}

// ── Reminders ────────────────────────────────────────────────────────────────

/**
 * Students who were given something N days ago (their school's setting) and
 * have not started any of it are reminded — once per release.
 */
async function remindNotStarted() {
    const due = await q(`
        SELECT r.* FROM ${T.release} r
         WHERE ${access.LIVE} AND ${access.stillAssigned}
           AND r."releaseAt" > now() - interval '60 days'`, []);
    let sent = 0;
    const prefsBySchool = new Map();
    for (const release of due) {
        const key = String(release.school);
        if (!prefsBySchool.has(key)) prefsBySchool.set(key, await settings.school(key));
        const days = prefsBySchool.get(key).reminderAfterDays;
        if (!days || Date.now() - new Date(release.releaseAt).getTime() < days * 86400000) continue;
        if (!await claim(`reminder:${release._id}`, 'reminder', release.school)) continue;
        const audience = await releaseAudience(release);
        if (!audience.length) continue;
        // Who has touched anything this release opens?
        const started = await q(`
            SELECT DISTINCT p."student"::text AS s
              FROM ${T.release} r ${access.itemsJoin}
              JOIN ${T.progress} p ON p."chapterVideo" = cv."_id" AND p."academicYear" = r."academicYear" AND p."watchedSeconds" > 0
             WHERE r."_id" = $1 AND p."student"::text = ANY($2::text[])`, [release._id, audience]);
        const startedSet = new Set(started.map((x) => x.s));
        const idle = audience.filter((s) => !startedSet.has(s));
        if (!idle.length) continue;
        const t = await releaseTarget(release);
        const what = release.level === 'book' ? t.bookTitle : release.level === 'chapter' ? `Chapter ${t.chapterNumber}: ${t.chapterTitle}` : t.videoTitle;
        notify({
            school: release.school, sender: release.createdBy, senderRole: 'teacher',
            title: 'You have videos waiting',
            body: `You have not started "${what}" yet. It was released ${days} day${days === 1 ? '' : 's'} ago${release.expiresAt ? ' and will not stay open forever' : ''}.`,
            recipients: idle,
            link: release.level === 'book' ? { type: 'video.book', entityId: release.book }
                : release.level === 'chapter' ? { type: 'video.chapter', entityId: release.chapter } : { type: 'video.watch', entityId: release.chapterVideo },
        });
        sent += idle.length;
    }
    return sent;
}

module.exports = { claim, bookAdded, requestFiled, requestStatus, releaseAvailable, releaseAudience, videoCompleted, remindNotStarted };
