'use strict';
/**
 * Video Learning — watching, and the record of it.
 *
 *   authorise   the student asks to play a chapter video. If a release of
 *               their section covers it, a watch SESSION is opened and the
 *               player is given a short-lived signed address bound to it.
 *   heartbeat   while it plays, the player reports where it is every few
 *               seconds. The server — not the player — decides what that is
 *               worth, against the previous report and its OWN clock:
 *
 *                 • a report numbered at or below the last one taken is a
 *                   duplicate (a retry, a second tab): ignored, counted once;
 *                 • playing time is credited only between two reports that
 *                   both said "playing", and never more than the wall-clock
 *                   time between them — so paused time, a parked tab and a
 *                   faster playback speed earn nothing;
 *                 • the furthest point reached (`furthestSec`) moves forward
 *                   only by such continuous play. A report from beyond it
 *                   that could not have been played to is a forward seek:
 *                   refused, and the player is told where to go back to;
 *                 • anywhere up to `furthestSec` is the student's to replay.
 *
 *               A video is complete when `furthestSec` reaches the platform's
 *               threshold of its length — which, by the rules above, cannot
 *               be reached without that much real time spent playing it.
 *   resume      `lastPositionSec` survives everything: sign-out, a refresh,
 *               a lost connection, another device.
 *
 * Sessions (LmsWatchSession) and raw heartbeats (LmsHeartbeat) are kept apart
 * from the rolled-up record (LmsProgress), which nothing but a heartbeat
 * writes and nothing ever deletes.
 *
 * What this cannot do: tell a student watching from a video left playing to
 * an empty room, or stop a screen being recorded. It measures playback, not
 * attention.
 */
const { q, M, T, HttpError, bad, notFound, forbidden, id, ipOf } = require('./common');
const { withTransaction, insertRow } = require('../dbTx');
const access = require('./access');
const providers = require('./providers');
const settings = require('./settings');
const token = require('./playbackToken');
const notices = require('./notices');

const TOLERANCE = 2;            // seconds of slack for timer jitter and rounding
const STATES = ['playing', 'paused', 'ended'];

/** The longest gap between two reports that is still counted as one stretch of play. */
const maxGap = (cfg) => cfg.heartbeatSeconds * 4 + 15;

const shape = (p) => ({
    furthestSec: Math.round((p.furthestSec || 0) * 100) / 100,
    resumePositionSec: Math.round((p.lastPositionSec || 0) * 100) / 100,
    watchedPercent: p.watchedPercent || 0,
    watchedSeconds: Math.round(p.watchedSeconds || 0),
    completed: p.status === 'completed',
});

/** What the player opens: the provider's answer, with a token bound to this session. */
async function playbackFor(video, session, userId, cfg) {
    const { provider, cfg: pcfg } = await providers.ready(video.provider);
    // Long enough to watch the video through with pauses; useless the moment the session closes.
    const ttl = Math.min(6 * 3600, Math.max(900, Math.round((video.durationSec || 0) * 2) + 900));
    const tok = token.sign({ kind: 'watch', vid: String(video._id), uid: String(userId), sid: String(session._id) }, ttl);
    const pb = await provider.playback(video, { token: tok, ttlSec: Math.max(cfg.playbackUrlSeconds, Math.round((video.durationSec || 0) * 1.5) + 300) }, pcfg);
    return { ...pb, tokenExpiresIn: ttl };
}

/**
 * Open a watch session on a chapter video for a student. Refused unless a
 * live release of the student's own section covers it.
 */
async function authorize(req, chapterVideoId) {
    const user = req.user;
    const ctx = await access.studentContext(user);
    const [item] = await access.entitledItems(ctx, { chapterVideo: id(chapterVideoId, 'Video') });
    if (!item) throw forbidden('This video has not been released to you', 'NOT_RELEASED');
    const video = await M.video.findById(item.video).lean();
    if (!video || !video.durationSec) throw new HttpError(503, 'This video is not available yet. Please try again later.', 'VIDEO_NOT_READY');
    const cfg = await settings.platform();
    await providers.ready(video.provider);          // a 503 that says so, before anything is recorded

    // One sitting at a time: an account watching in two places is one of them
    // borrowing it. Two requests at once (two tabs, a double click) take turns
    // on a per-student lock, so the second always closes the first.
    return withTransaction(async (tx) => {
        await tx('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`lms-watch:${ctx.userId}`]);
        await tx(`UPDATE ${T.session} SET "status" = 'closed', "closeReason" = 'superseded', "endedAt" = now(), "updatedAt" = now() WHERE "student" = $1 AND "status" = 'open'`, [ctx.userId]);
        return openSession(tx, req, ctx, item, video, cfg);
    });
}

async function openSession(tx, req, ctx, item, video, cfg) {
    const q = async (sql, params) => (await tx(sql, params)).rows;

    const [progress] = await q(`
        INSERT INTO ${T.progress} ("_id", "school", "academicYear", "class", "section", "schoolSubject", "lmsSubject", "book", "chapter", "chapterVideo", "video", "student",
               "durationSec", "sessionsCount", "watchedSeconds", "furthestSec", "lastPositionSec", "watchedPercent", "seekViolations", "status", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 0, 0, 0, 0, 0, 'in_progress', now(), now())
        ON CONFLICT ("student", "chapterVideo", "academicYear") DO UPDATE
           SET "sessionsCount" = ${T.progress}."sessionsCount" + 1, "class" = EXCLUDED."class", "section" = EXCLUDED."section",
               "schoolSubject" = EXCLUDED."schoolSubject", "durationSec" = EXCLUDED."durationSec", "updatedAt" = now()
        RETURNING *`,
    [ctx.schoolId, item.academicYear, item.class, item.section, item.schoolSubject, item.lmsSubject, item.book, item.chapter, item.chapterVideo, item.video, ctx.userId, video.durationSec]);

    // Resume where they were — the start again for a video already watched to the end.
    const resume = progress.lastPositionSec >= video.durationSec - TOLERANCE ? 0
        : Math.round(Math.min(progress.lastPositionSec || 0, progress.furthestSec || 0) * 100) / 100;
    // Written on the transaction's own connection, so the lock covers it too.
    const session = await insertRow(tx, M.session, {
        progress: progress._id, student: ctx.userId, school: ctx.schoolId, academicYear: item.academicYear, class: item.class, section: item.section,
        book: item.book, chapter: item.chapter, chapterVideo: item.chapterVideo, video: item.video, release: item.release,
        startPositionSec: resume, lastPositionSec: resume, lastState: 'idle', lastSeq: 0, status: 'open', startedAt: new Date(), lastBeatAt: new Date(),
        ip: ipOf(req), userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
    });
    return {
        sessionId: session._id,
        playback: await playbackFor(video, session, ctx.userId, cfg),
        video: { _id: video._id, title: video.title, description: video.description, durationSec: video.durationSec, provider: video.provider, language: video.language },
        chapterVideo: item.chapterVideo, chapter: item.chapter, book: item.book,
        progress: { ...shape(progress), resumePositionSec: resume },
        policy: { heartbeatSeconds: cfg.heartbeatSeconds, completionThresholdPercent: cfg.completionThresholdPercent, toleranceSeconds: TOLERANCE },
    };
}

/** The session, if it is this student's. */
async function ownSession(sessionId, userId) {
    const s = await M.session.findOne({ _id: id(sessionId, 'Session'), student: userId }).lean();
    if (!s) throw notFound('Session');
    return s;
}

/** A fresh playback address for a session that is still open and still entitled. */
async function renew(req, sessionId) {
    const s = await ownSession(sessionId, req.user._id);
    if (s.status !== 'open') throw forbidden('This viewing session has ended. Open the video again.', 'SESSION_CLOSED');
    const ctx = await access.studentContext(req.user);
    const [item] = await access.entitledItems(ctx, { chapterVideo: s.chapterVideo });
    if (!item) {
        await M.session.updateOne({ _id: s._id }, { $set: { status: 'closed', closeReason: 'access_ended', endedAt: new Date() } });
        throw forbidden('This video is no longer available to you', 'ACCESS_ENDED');
    }
    const video = await M.video.findById(s.video).lean();
    return { sessionId: s._id, playback: await playbackFor(video, s, req.user._id, await settings.platform()) };
}

/**
 * One heartbeat. `body` = { seq, positionSec, state, elapsedSec }.
 * Returns what the player should believe: how far the student may go, where
 * to resume, and — when the report was refused — why.
 */
async function heartbeat(req, sessionId, body) {
    const userId = String(req.user._id);
    const seq = Number(body.seq);
    const position = Number(body.positionSec);
    const state = String(body.state || '');
    if (!Number.isInteger(seq) || seq < 1 || seq > 1e7) throw bad('seq must be a whole number that goes up with every heartbeat');
    if (!Number.isFinite(position) || position < 0) throw bad('positionSec is not valid');
    if (!STATES.includes(state)) throw bad(`state must be one of: ${STATES.join(', ')}`);
    const sid = id(sessionId, 'Session');
    const cfg = await settings.platform();

    // Access can end while a video is open: a release revoked, a book reassigned, a section changed.
    const head = await M.session.findOne({ _id: sid, student: userId }, '_id status chapterVideo closeReason').lean();
    if (!head) throw notFound('Session');
    if (head.status === 'open') {
        const ctx = await access.studentContext(req.user);
        const [item] = await access.entitledItems(ctx, { chapterVideo: head.chapterVideo });
        if (!item) await M.session.updateOne({ _id: sid, status: 'open' }, { $set: { status: 'closed', closeReason: 'access_ended', endedAt: new Date() } });
    }

    const result = await withTransaction(async (tx) => {
        const { rows: [s] } = await tx(`SELECT * FROM ${T.session} WHERE "_id" = $1 AND "student" = $2 FOR UPDATE`, [sid, userId]);
        if (!s) throw notFound('Session');
        const { rows: [p] } = await tx(`SELECT * FROM ${T.progress} WHERE "_id" = $1 FOR UPDATE`, [s.progress]);
        if (s.status !== 'open') {
            return { accepted: false, reason: s.closeReason === 'superseded' ? 'session_superseded' : s.closeReason === 'idle' ? 'session_idle' : 'session_closed', closed: true, ...shape(p) };
        }
        // Seen before (a retry, the same tab twice) or older than one already taken: counted once.
        if (seq <= s.lastSeq) return { accepted: true, duplicate: true, ...shape(p) };

        const now = new Date();
        const wall = Math.max(0, (now.getTime() - new Date(s.lastBeatAt).getTime()) / 1000);
        const window = Math.min(wall, maxGap(cfg));
        const duration = p.durationSec || 0;
        const pos = Math.min(position, duration);
        const frontier = p.furthestSec || 0;
        const advance = pos - (s.lastPositionSec || 0);
        const continuous = s.lastState === 'playing' && advance >= 0 && advance <= window + TOLERANCE;

        // The furthest point moves forward only by play the server's own clock can
        // account for: at most the wall time since the last report, plus a little
        // slack for timer jitter. The slack is a small purse (never more than
        // TOLERANCE) refilled only by real time passing — so a burst of reports
        // sent back to back, each "a second or two further on", earns nothing.
        let credited = 0; let accepted = true; let reason = '';
        let newFrontier = frontier; let newPos = pos; let slack = s.slackSec || 0;
        if (continuous) {
            credited = Math.min(advance, window);
            const allowed = window + slack;
            const gain = Math.min(Math.max(0, pos - frontier), allowed);
            newFrontier = frontier + gain;
            slack = Math.min(TOLERANCE, allowed - gain);
            newPos = Math.min(pos, newFrontier + TOLERANCE);
        } else if (pos > frontier + TOLERANCE) {
            accepted = false; reason = 'seek_ahead'; newPos = frontier;        // back to the last point genuinely reached
        }
        // Seconds are kept to the millisecond — sums of fractions otherwise drift into 140.06099999999998.
        const r3 = (x) => Math.round(x * 1000) / 1000;
        credited = r3(credited); newFrontier = r3(newFrontier); newPos = r3(newPos); slack = r3(slack);
        const inserted = await tx(`
            INSERT INTO ${T.heartbeat} ("_id", "session", "student", "video", "seq", "positionSec", "state", "elapsedSec", "creditedSec", "accepted", "reason", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now()) ON CONFLICT ("session", "seq") DO NOTHING`,
        [s._id, userId, s.video, seq, position, state, Number(body.elapsedSec) > 0 ? Math.min(Number(body.elapsedSec), 86400) : 0, credited, accepted, reason]);
        if (!inserted.rowCount) return { accepted: true, duplicate: true, ...shape(p) };

        const percent = duration > 0 ? Math.min(100, Math.round((newFrontier / duration) * 1000) / 10) : 0;
        const justCompleted = p.status !== 'completed' && duration > 0 && newFrontier >= (duration * cfg.completionThresholdPercent) / 100;
        const { rows: [np] } = await tx(`
            UPDATE ${T.progress} SET "watchedSeconds" = "watchedSeconds" + $2, "furthestSec" = $3, "lastPositionSec" = $4, "watchedPercent" = $5,
                   "lastWatchedAt" = $6, "firstWatchedAt" = COALESCE("firstWatchedAt", $6), "seekViolations" = "seekViolations" + $7,
                   "status" = CASE WHEN $8 THEN 'completed' ELSE "status" END, "completedAt" = CASE WHEN $8 THEN $6 ELSE "completedAt" END, "updatedAt" = $6
             WHERE "_id" = $1 RETURNING *`,
        [p._id, credited, newFrontier, Math.min(newPos, newFrontier), percent, now, accepted ? 0 : 1, justCompleted]);
        await tx(`
            UPDATE ${T.session} SET "lastSeq" = $2, "lastBeatAt" = $3, "lastState" = $4, "lastPositionSec" = $5, "creditedSec" = "creditedSec" + $6,
                   "seekViolations" = "seekViolations" + $7, "slackSec" = $8, "updatedAt" = $3 WHERE "_id" = $1`,
        [s._id, seq, now, state, newPos, credited, accepted ? 0 : 1, slack]);
        return { accepted, reason, justCompleted, release: s.release, progressRow: np, ...shape(np) };
    });

    if (result.justCompleted) {
        const row = result.progressRow;
        setImmediate(async () => {
            try {
                const rel = result.release ? await M.release.findById(result.release, 'createdBy').lean() : null;
                await notices.videoCompleted(row, { releasedBy: rel?.createdBy, studentName: req.user.name || 'A student' });
            } catch (e) { console.error('[video] completion notice failed:', e.message); }
        });
    }
    const { progressRow, release, ...out } = result;
    return { ...out, serverTime: new Date().toISOString() };
}

/** The student has left the player. */
async function end(req, sessionId) {
    const s = await ownSession(sessionId, req.user._id);
    if (s.status === 'open') await M.session.updateOne({ _id: s._id, status: 'open' }, { $set: { status: 'closed', closeReason: 'ended', endedAt: new Date() } });
    return { closed: true };
}

/** Sessions that went quiet are closed (their playback addresses with them). Run by the sweep. */
async function closeIdle() {
    const { sessionIdleSeconds } = await settings.platform();
    const rows = await q(`
        UPDATE ${T.session} SET "status" = 'closed', "closeReason" = 'idle', "endedAt" = "lastBeatAt", "updatedAt" = now()
         WHERE "status" = 'open' AND "lastBeatAt" < now() - ($1 || ' seconds')::interval RETURNING "_id"`, [String(sessionIdleSeconds)]);
    return rows.length;
}

/** Raw heartbeats older than the retention period are dropped; the totals they made are kept. */
async function pruneHeartbeats() {
    const { heartbeatRetentionDays } = await settings.platform();
    const { rowCount } = await require('./common').pool.query(`DELETE FROM ${T.heartbeat} WHERE "createdAt" < now() - ($1 || ' days')::interval`, [String(heartbeatRetentionDays)]);
    return rowCount;
}

/**
 * Is this playback token good for a request right now? The token must be ours
 * and in date, and — for a student's — its session must still be open and
 * heard from recently. Returns { claims, video } or null.
 */
async function resolvePlayback(tok) {
    const claims = token.verify(tok);
    if (!claims) return null;
    if (claims.kind === 'watch') {
        const { sessionIdleSeconds } = await settings.platform();
        const [s] = await q(`
            SELECT 1 FROM ${T.session} WHERE "_id" = $1 AND "student" = $2 AND "video" = $3 AND "status" = 'open'
               AND "lastBeatAt" > now() - ($4 || ' seconds')::interval`, [claims.sid, claims.uid, claims.vid, String(sessionIdleSeconds)]);
        if (!s) return null;
    } else if (claims.kind !== 'preview') return null;
    const video = await M.video.findById(claims.vid).lean();
    return video ? { claims, video } : null;
}

/** A Super Admin previewing a video from the library: a short-lived address, no session, nothing recorded. */
async function preview(user, videoId) {
    const video = await M.video.findById(id(videoId)).lean();
    if (!video) throw notFound('Video');
    if (video.processingStatus !== 'ready') throw new HttpError(409, `This video is not ready to play (${video.processingStatus})`, 'VIDEO_NOT_READY');
    const { provider, cfg } = await providers.ready(video.provider);
    const tok = token.sign({ kind: 'preview', vid: String(video._id), uid: String(user._id) }, 900);
    return { playback: await provider.playback(video, { token: tok, ttlSec: 900 }, cfg), video: { _id: video._id, title: video.title, durationSec: video.durationSec, provider: video.provider } };
}

module.exports = { authorize, renew, heartbeat, end, closeIdle, pruneHeartbeats, resolvePlayback, preview, TOLERANCE, maxGap };
