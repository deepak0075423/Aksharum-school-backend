'use strict';
/**
 * Video Learning — what a student sees.
 *
 * Only ever their own: the books their class and section follow, the chapters
 * and videos a teacher has released to them, and their own record of watching.
 * Nothing unreleased is listed — an unreleased chapter appears in its book as
 * a locked title (so the book reads in order) and cannot be opened.
 */
const { q, T, forbidden, notFound, id, paging } = require('./common');
const access = require('./access');
const { thumbOf } = require('./catalog');

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

/** The student's progress rows for these chapter videos: Map(chapterVideo → row). */
async function progressOf(ctx, chapterVideoIds) {
    if (!chapterVideoIds.length) return new Map();
    const rows = await q(`
        SELECT "chapterVideo", "status", "watchedPercent", "watchedSeconds", "lastPositionSec", "furthestSec", "lastWatchedAt", "completedAt"
          FROM ${T.progress} WHERE "student" = $1 AND "chapterVideo" = ANY($2::uuid[]) ORDER BY "lastWatchedAt" DESC NULLS LAST`, [ctx.userId, chapterVideoIds]);
    const map = new Map();
    for (const r of rows) if (!map.has(String(r.chapterVideo))) map.set(String(r.chapterVideo), r);
    return map;
}

const stateOf = (p) => (!p || !(p.watchedSeconds > 0 || p.furthestSec > 0) ? 'not_started' : p.status === 'completed' ? 'completed' : 'in_progress');

async function dashboard(user) {
    const ctx = await access.studentContext(user);
    const where = { className: ctx.className, sectionName: ctx.sectionName, yearName: ctx.yearName, placed: !!ctx.section };
    if (!ctx.section) return { where, totals: null, subjects: [], books: [], continueWatching: [] };
    const [books, items] = await Promise.all([access.studentBooks(ctx), access.entitledItems(ctx)]);
    const progress = await progressOf(ctx, items.map((i) => i.chapterVideo));
    const titles = items.length ? await q(`SELECT "_id", "title", "chapterNumber" FROM ${T.chapter} WHERE "_id" = ANY($1::uuid[])`, [[...new Set(items.map((i) => String(i.chapter)))]]) : [];
    const chapterOf = new Map(titles.map((c) => [String(c._id), c]));

    const tally = (list) => {
        const t = { videos: list.length, completed: 0, inProgress: 0, notStarted: 0, percentSum: 0 };
        for (const i of list) {
            const p = progress.get(String(i.chapterVideo));
            const st = stateOf(p);
            if (st === 'completed') t.completed++; else if (st === 'in_progress') t.inProgress++; else t.notStarted++;
            t.percentSum += st === 'completed' ? 100 : (p?.watchedPercent || 0);
        }
        return { videos: t.videos, completed: t.completed, inProgress: t.inProgress, notStarted: t.notStarted, percent: t.videos ? Math.round(t.percentSum / t.videos) : 0 };
    };
    const bookCards = books.map((b) => {
        const mine = items.filter((i) => String(i.book) === String(b._id));
        return { ...b, releasedChapters: new Set(mine.map((i) => String(i.chapter))).size, ...tally(mine) };
    }).sort((a, b) => a.subjectName.localeCompare(b.subjectName) || a.displayOrder - b.displayOrder || a.title.localeCompare(b.title));
    const subjects = [...new Map(bookCards.map((b) => [String(b.lmsSubject), { _id: b.lmsSubject, name: b.subjectName }])).values()]
        .map((s) => { const mine = bookCards.filter((b) => String(b.lmsSubject) === String(s._id)); return { ...s, books: mine.length, videos: mine.reduce((n, b) => n + b.videos, 0), completed: mine.reduce((n, b) => n + b.completed, 0) }; });
    const all = tally(items);
    const continueWatching = items
        .map((i) => ({ i, p: progress.get(String(i.chapterVideo)) }))
        .filter((x) => stateOf(x.p) === 'in_progress')
        .sort((a, b) => new Date(b.p.lastWatchedAt || 0) - new Date(a.p.lastWatchedAt || 0)).slice(0, 6)
        .map(({ i, p }) => {
            const t = thumbOf({ _id: i.chapterVideo, video: i.video, thumbnailUrl: i.thumbnailUrl, thumbnailKey: i.thumbnailKey });
            const ch = chapterOf.get(String(i.chapter));
            return { chapterVideo: i.chapterVideo, book: i.book, chapter: i.chapter, title: i.title, durationSec: i.durationSec, thumbnailUrl: t.thumbnailUrl,
                chapterTitle: ch?.title || '', chapterNumber: ch?.chapterNumber ?? null, bookTitle: books.find((b) => String(b._id) === String(i.book))?.title || '',
                watchedPercent: p.watchedPercent, resumePositionSec: p.lastPositionSec, lastWatchedAt: p.lastWatchedAt };
        });
    return {
        where,
        totals: { subjects: subjects.length, books: books.length, releasedChapters: new Set(items.map((i) => String(i.chapter))).size, ...all },
        subjects, books: bookCards, continueWatching,
    };
}

/** One of the student's books: its chapters in order, each locked, available, in progress or completed. */
async function book(user, bookId) {
    const ctx = await access.studentContext(user);
    const [b] = await access.studentBooks(ctx, { book: id(bookId, 'Book') });
    if (!b) throw notFound('Book');
    const [chapters, items] = await Promise.all([
        q(`SELECT "_id", "title", "chapterNumber", "description", "thumbnailUrl", "estimatedMinutes" FROM ${T.chapter}
            WHERE "book" = $1 AND "status" = 'active' ORDER BY "displayOrder", "chapterNumber"`, [b._id]),
        access.entitledItems(ctx, { book: b._id }),
    ]);
    const progress = await progressOf(ctx, items.map((i) => i.chapterVideo));
    let videos = 0; let completed = 0;
    const list = chapters.map((c) => {
        const mine = items.filter((i) => String(i.chapter) === String(c._id));
        const states = mine.map((i) => stateOf(progress.get(String(i.chapterVideo))));
        const done = states.filter((s) => s === 'completed').length;
        videos += mine.length; completed += done;
        const sum = mine.reduce((n, i) => { const p = progress.get(String(i.chapterVideo)); return n + (p?.status === 'completed' ? 100 : (p?.watchedPercent || 0)); }, 0);
        const status = !mine.length ? 'locked' : done === mine.length ? 'completed' : states.some((s) => s !== 'not_started') ? 'in_progress' : 'available';
        // A locked chapter shows its place in the book and nothing more.
        return { _id: c._id, title: c.title, chapterNumber: c.chapterNumber, thumbnailUrl: c.thumbnailUrl, estimatedMinutes: c.estimatedMinutes,
            description: mine.length ? c.description : '', videoCount: mine.length, completedCount: done, percent: mine.length ? Math.round(sum / mine.length) : 0, status };
    });
    return { book: b, chapters: list, totals: { videos, completed, percent: pct(completed, videos), releasedChapters: list.filter((c) => c.status !== 'locked').length } };
}

/** One chapter: the videos released to this student, with how much of each they have watched. */
async function chapter(user, chapterId) {
    const ctx = await access.studentContext(user);
    const [ch] = await q(`SELECT c."_id", c."title", c."chapterNumber", c."description", c."book", k."title" AS "bookTitle"
                            FROM ${T.chapter} c JOIN ${T.book} k ON k."_id" = c."book" WHERE c."_id" = $1 AND c."status" = 'active'`, [id(chapterId, 'Chapter')]);
    if (!ch) throw notFound('Chapter');
    if (!(await access.studentBooks(ctx, { book: ch.book })).length) throw notFound('Chapter');
    const items = await access.entitledItems(ctx, { chapter: ch._id });
    if (!items.length) throw forbidden('This chapter has not been released to you yet', 'NOT_RELEASED');
    const progress = await progressOf(ctx, items.map((i) => i.chapterVideo));
    const videos = items.sort((a, b) => a.displayOrder - b.displayOrder).map((i) => {
        const p = progress.get(String(i.chapterVideo));
        const t = thumbOf({ _id: i.chapterVideo, video: i.video, thumbnailUrl: i.thumbnailUrl, thumbnailKey: i.thumbnailKey });
        return { chapterVideo: i.chapterVideo, title: i.title, description: i.description, durationSec: i.durationSec, thumbnailUrl: t.thumbnailUrl, language: i.language,
            availableUntil: i.expiresAt, status: stateOf(p), watchedPercent: p?.status === 'completed' ? 100 : (p?.watchedPercent || 0),
            resumePositionSec: p?.lastPositionSec || 0, canResume: stateOf(p) === 'in_progress', lastWatchedAt: p?.lastWatchedAt || null };
    });
    const done = videos.filter((v) => v.status === 'completed').length;
    return { chapter: ch, videos, totals: { videos: videos.length, completed: done, percent: pct(done, videos.length) } };
}

/** One released video: where it sits and how far the student is — without opening a watch session. */
async function video(user, chapterVideoId) {
    const ctx = await access.studentContext(user);
    const [item] = await access.entitledItems(ctx, { chapterVideo: id(chapterVideoId, 'Video') });
    if (!item) throw forbidden('This video has not been released to you', 'NOT_RELEASED');
    const [ch] = await q(`SELECT c."_id", c."title", c."chapterNumber", c."book", k."title" AS "bookTitle"
                            FROM ${T.chapter} c JOIN ${T.book} k ON k."_id" = c."book" WHERE c."_id" = $1`, [item.chapter]);
    const p = (await progressOf(ctx, [item.chapterVideo])).get(String(item.chapterVideo));
    const t = thumbOf({ _id: item.chapterVideo, video: item.video, thumbnailUrl: item.thumbnailUrl, thumbnailKey: item.thumbnailKey });
    return {
        chapterVideo: item.chapterVideo, title: item.title, description: item.description, durationSec: item.durationSec, thumbnailUrl: t.thumbnailUrl,
        language: item.language, availableUntil: item.expiresAt, status: stateOf(p), watchedPercent: p?.status === 'completed' ? 100 : (p?.watchedPercent || 0),
        resumePositionSec: p?.lastPositionSec || 0, canResume: stateOf(p) === 'in_progress', lastWatchedAt: p?.lastWatchedAt || null, chapter: ch,
    };
}

/** The student's own watch history — every video they have played, most recent first. Kept even when access has ended. */
async function history(user, query) {
    const ctx = await access.studentContext(user);
    const pg = paging(query, { def: 15 });
    // Opening a video is not watching it: a row counts once playback was reported.
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.progress} WHERE "student" = $1 AND "school" = $2 AND "firstWatchedAt" IS NOT NULL`, [ctx.userId, ctx.schoolId]);
    const rows = await q(`
        SELECT p."_id", p."chapterVideo", p."status", p."watchedPercent", p."watchedSeconds", p."sessionsCount", p."firstWatchedAt", p."lastWatchedAt", p."completedAt",
               v."title", v."durationSec", ch."title" AS "chapterTitle", ch."chapterNumber", k."title" AS "bookTitle", ls."name" AS "subjectName"
          FROM ${T.progress} p JOIN ${T.video} v ON v."_id" = p."video" JOIN ${T.chapter} ch ON ch."_id" = p."chapter" JOIN ${T.book} k ON k."_id" = p."book"
          LEFT JOIN ${T.subject} ls ON ls."_id" = p."lmsSubject"
         WHERE p."student" = $1 AND p."school" = $2 AND p."firstWatchedAt" IS NOT NULL ORDER BY p."lastWatchedAt" DESC NULLS LAST LIMIT ${pg.limit} OFFSET ${pg.offset}`, [ctx.userId, ctx.schoolId]);
    const open = new Set((await access.entitledItems(ctx)).map((i) => String(i.chapterVideo)));
    return { rows: rows.map((r) => ({ ...r, stillAvailable: open.has(String(r.chapterVideo)) })), total: n, pg };
}

module.exports = { dashboard, book, chapter, video, history, stateOf };
