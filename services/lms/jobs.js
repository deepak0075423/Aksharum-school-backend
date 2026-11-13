'use strict';
/**
 * Video Learning — background processing of uploaded videos.
 *
 * A job is a row (LmsJob), not a timer in memory, so a restart loses nothing.
 * `tick()` claims a few due jobs in ONE statement (FOR UPDATE SKIP LOCKED), so
 * any number of servers may run it together and each job is still done once.
 *
 *   queued   → running → done                the provider finished in one go
 *                      → waiting → … → done  an outside transcoder (MediaConvert)
 *                                            is working; polled until it ends
 *                      → queued              something temporary failed: tried
 *                                            again later, up to maxAttempts
 *                      → failed              the file itself is no good, or
 *                                            the attempts ran out
 *
 * The video's `processingStatus` follows, and it is mappable only at `ready`.
 */
const { q, M, T, bad, notFound, conflict, id } = require('./common');
const providers = require('./providers');

const BATCH = 3;
const STUCK_MINUTES = 15;
const POLL_SECONDS = 30;

async function enqueue(videoId, result = {}) {
    const job = await M.job.create({ type: 'process_video', video: videoId, status: 'queued', runAfter: new Date(), result });
    // Do not wait for the next sweep — but never inside the request either.
    setImmediate(() => tick().catch((e) => console.error('[video] job tick failed:', e.message)));
    return job;
}

async function finish(job, video, outcome) {
    if (outcome.state === 'ready') {
        await M.video.updateOne({ _id: video._id }, { $set: { ...(outcome.patch || {}), processingStatus: 'ready', processingError: '' } });
        await M.job.updateOne({ _id: job._id }, { $set: { status: 'done', lastError: '' } });
    } else if (outcome.state === 'waiting') {
        await M.video.updateOne({ _id: video._id }, { $set: { ...(outcome.patch || {}), processingStatus: 'processing', processingJobId: outcome.externalId || '' } });
        await M.job.updateOne({ _id: job._id }, { $set: { status: 'waiting', externalId: outcome.externalId || job.externalId || '', runAfter: new Date(Date.now() + POLL_SECONDS * 1000) } });
    } else {
        await M.video.updateOne({ _id: video._id }, { $set: { processingStatus: 'failed', processingError: String(outcome.error || 'Processing failed').slice(0, 500) } });
        await M.job.updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: String(outcome.error || '').slice(0, 500) } });
    }
}

async function run(job) {
    const video = await M.video.findById(job.video).lean();
    if (!video) { await M.job.updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: 'The video no longer exists' } }); return; }
    try {
        const { provider, cfg } = await providers.ready(video.provider);
        const outcome = job.externalId
            ? await provider.poll(video, job, cfg)
            : await provider.process(video, { clientDurationSec: job.result?.clientDurationSec || 0 }, cfg);
        await finish(job, video, outcome);
    } catch (e) {
        // Something around the file failed (network, provider switched off) — not the file.
        const message = String(e.message || e).slice(0, 500);
        if (job.attempts < job.maxAttempts) {
            await M.job.updateOne({ _id: job._id }, { $set: { status: job.externalId ? 'waiting' : 'queued', lastError: message, runAfter: new Date(Date.now() + 30000 * job.attempts * job.attempts) } });
            await M.video.updateOne({ _id: video._id }, { $set: { processingError: `Will be tried again: ${message}`.slice(0, 500) } });
        } else {
            await finish(job, video, { state: 'failed', error: message });
        }
    }
}

/** Claim and run the jobs that are due. Returns how many were run. */
async function tick() {
    const claimed = await q(`
        UPDATE ${T.job} SET "status" = 'running', "lockedAt" = now(), "updatedAt" = now(),
               "attempts" = "attempts" + (CASE WHEN "status" = 'waiting' THEN 0 ELSE 1 END)
         WHERE "_id" IN (
               SELECT "_id" FROM ${T.job}
                WHERE ("status" IN ('queued', 'waiting') AND "runAfter" <= now())
                   OR ("status" = 'running' AND "lockedAt" < now() - interval '${STUCK_MINUTES} minutes')
                ORDER BY "runAfter" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING *`, []);
    for (const job of claimed) await run(job);
    return claimed.length;
}

/** Process a video again — after a failure, or after its length was entered by hand. */
async function retry(videoId) {
    const video = await M.video.findById(id(videoId)).lean();
    if (!video) throw notFound('Video');
    if (providers.get(video.provider).kind !== 'file') throw bad('A linked video has nothing to process');
    if (!video.storageKey) throw bad('This video has no file yet — upload it first');
    if (['queued', 'processing'].includes(video.processingStatus)) throw conflict('This video is already being processed');
    await M.video.updateOne({ _id: video._id }, { $set: { processingStatus: 'queued', processingError: '', processingJobId: '' } });
    await enqueue(video._id, { clientDurationSec: video.durationSec || 0 });
    return { processingStatus: 'queued' };
}

module.exports = { enqueue, tick, retry };
