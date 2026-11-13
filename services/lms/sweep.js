'use strict';
/**
 * Video Learning — the module's clock (started once, on the primary worker).
 *
 *   every 15 s   uploaded videos waiting to be processed (services/lms/jobs)
 *   every minute scheduled releases that have come due are opened and their
 *                students told; expired ones are marked; sessions that went
 *                quiet are closed
 *   every hour   reminders for content not started; unfinished uploads
 *                cleared; old raw heartbeats pruned
 *
 * Every step claims its rows before acting (an UPDATE … RETURNING, or a key
 * in LmsNotice), so a restart or a second instance never acts twice. Access
 * itself never waits for this clock: a release opens and closes by its own
 * dates the moment a student asks (services/lms/access).
 */
const { q, T } = require('./common');
const jobs = require('./jobs');
const notices = require('./notices');
const tracking = require('./tracking');
const uploads = require('./uploads');

/** Scheduled releases whose time has come: marked active, students notified. */
async function openDueReleases() {
    const due = await q(`
        UPDATE ${T.release} SET "status" = 'active', "updatedAt" = now()
         WHERE "status" = 'scheduled' AND "releaseAt" <= now() AND ("expiresAt" IS NULL OR "expiresAt" > now()) RETURNING *`, []);
    for (const r of due) await notices.releaseAvailable(r, { scheduled: true }).catch((e) => console.error('[video] release notice failed:', e.message));
    return due.length;
}

/** Releases past their expiry: marked, and any session still open on them closed. */
async function expireReleases() {
    const gone = await q(`
        UPDATE ${T.release} SET "status" = 'expired', "updatedAt" = now()
         WHERE "status" IN ('scheduled', 'active') AND "expiresAt" IS NOT NULL AND "expiresAt" <= now() RETURNING "_id"`, []);
    if (gone.length) {
        await q(`UPDATE ${T.session} SET "status" = 'closed', "closeReason" = 'expired', "endedAt" = now(), "updatedAt" = now()
                  WHERE "status" = 'open' AND "release" = ANY($1::uuid[])`, [gone.map((g) => g._id)]);
    }
    return gone.length;
}

const safely = (label, fn) => fn().catch((e) => { console.error(`[video] ${label} failed:`, e.message); return 0; });

async function minute() {
    return {
        opened: await safely('opening due releases', openDueReleases),
        expired: await safely('expiring releases', expireReleases),
        idleClosed: await safely('closing idle sessions', tracking.closeIdle),
    };
}

async function hour() {
    return {
        reminded: await safely('reminders', notices.remindNotStarted),
        uploadsCleared: await safely('clearing stale uploads', uploads.expireStale),
        heartbeatsPruned: await safely('pruning heartbeats', tracking.pruneHeartbeats),
    };
}

let started = false;
function start() {
    if (started) return;
    started = true;
    setInterval(() => safely('job tick', jobs.tick), 15 * 1000);
    setInterval(minute, 60 * 1000);
    setInterval(hour, 60 * 60 * 1000);
    setTimeout(() => { safely('job tick', jobs.tick); minute(); }, 20 * 1000);     // once shortly after boot
    setTimeout(hour, 3 * 60 * 1000);
}

module.exports = { start, minute, hour, openDueReleases, expireReleases };
