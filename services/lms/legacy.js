'use strict';
/**
 * Video Learning — what the module was before Nov 2026.
 *
 * The old design (a flat master library, tags, playlists, courses, teacher
 * link uploads and per-school approvals) was replaced by the book-based
 * library. Its tables — videos, videotaxonomies, videoassignments,
 * videoprogresses and the rest — are NOT dropped or changed: the model files
 * stay so the rows remain readable. This copies the old master videos into
 * the new asset library, once (db/migrate.js ONCE), so they can be mapped to
 * chapters like any other.
 */
const fs = require('fs');
const path = require('path');
const { M } = require('./common');

async function copyMasterVideos() {
    let Legacy;
    try { Legacy = require('../../models/Video'); } catch { return { found: 0, copied: 0, skipped: 0 }; }
    const old = await Legacy.find({ scope: 'master', isDeleted: { $ne: true } }).sort({ createdAt: 1 }).lean();
    let copied = 0; let skipped = 0;
    for (const v of old) {
        if (await M.video.findOne({ legacyVideoId: v._id }, '_id').lean()) { skipped++; continue; }
        const base = {
            title: v.title, description: v.shortDescription || v.longDescription || '', thumbnailUrl: v.thumbnailUrl || '',
            durationSec: Number(v.durationSec) || 0, language: v.language || 'English',
            tags: [...new Set([...(v.tags || []), ...(v.keywords || [])])].slice(0, 20),
            isActive: v.status !== 'archived', legacyVideoId: v._id, createdBy: v.createdBy || null, uploadedAt: v.createdAt || new Date(),
        };
        try {
            if (v.source === 'youtube' || v.source === 'vimeo') {
                if (!v.providerId) { skipped++; continue; }
                if (await M.video.findOne({ provider: v.source, providerAssetId: v.providerId }, '_id').lean()) { skipped++; continue; }
                await M.video.create({
                    ...base, provider: v.source, providerAssetId: v.providerId, playbackType: 'embed',
                    protection: v.source === 'youtube' ? 'standard' : 'strict',
                    // Tracking needs the length; one that was never recorded is asked for.
                    processingStatus: base.durationSec > 0 ? 'ready' : 'failed',
                    processingError: base.durationSec > 0 ? '' : 'Enter the video\'s length to make it available',
                });
                copied++;
            } else if (v.s3Key) {
                // A file the old module kept under the public uploads folder: copied
                // into the private one and queued for processing like a new upload.
                const src = path.join(__dirname, '..', '..', 'uploads', v.s3Key);
                if (!fs.existsSync(src)) { skipped++; continue; }
                const doc = await M.video.create({ ...base, provider: 'local', playbackType: 'file', protection: 'strict', processingStatus: 'queued', originalFilename: path.basename(v.s3Key) });
                const key = `${doc._id}/source-legacy${path.extname(v.s3Key).toLowerCase() || '.mp4'}`;
                const dest = path.join(require('./providers/local').ROOT, key);
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                await fs.promises.copyFile(src, dest);
                await M.video.updateOne({ _id: doc._id }, { $set: { storageKey: key } });
                await M.job.create({ type: 'process_video', video: doc._id, status: 'queued', runAfter: new Date(), result: { clientDurationSec: base.durationSec } });
                copied++;
            } else { skipped++; }
        } catch (e) {
            if (e.code === 11000 || e.code === '23505') { skipped++; continue; }
            throw e;
        }
    }
    return { found: old.length, copied, skipped };
}

module.exports = { copyMasterVideos };
