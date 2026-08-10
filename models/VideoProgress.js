const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoProgress — the per-student, per-video watch state (the "resume point"
//  and completion record). One row per (student, video, assignment). Free
//  (non-assigned) watches use assignment = null. Fine-grained events go to
//  VideoWatchEvent; this table is the fast, up-to-date rollup the UI reads.
// ─────────────────────────────────────────────────────────────────────────────
const VideoProgressSchema = new db.Schema({
    school:     { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student:    { type: db.Types.UUID, ref: 'User', required: true, index: true },
    video:      { type: db.Types.UUID, ref: 'Video', required: true, index: true },
    assignment: { type: db.Types.UUID, ref: 'VideoAssignment', default: null, index: true },

    watchedSeconds:  { type: Number, default: 0 }, // sum of unique seconds actually watched
    lastPositionSec: { type: Number, default: 0 }, // resume point
    progressPercent: { type: Number, default: 0 },

    completed:   { type: Boolean, default: false, index: true },
    completedAt: { type: Date, default: null },

    attempts:    { type: Number, default: 0 },
    replayCount: { type: Number, default: 0 },
    pauseCount:  { type: Number, default: 0 },
    seekCount:   { type: Number, default: 0 },
    skippedSeconds: { type: Number, default: 0 },

    firstWatchedAt: { type: Date, default: null },
    lastWatchedAt:  { type: Date, default: null },

    // last-seen client context (denormalized for quick reporting)
    device:  { type: String, default: '' },
    browser: { type: String, default: '' },
    os:      { type: String, default: '' },
    network: { type: String, default: '' },
}, { timestamps: true });

VideoProgressSchema.index({ student: 1, video: 1, assignment: 1 }, { unique: true });
VideoProgressSchema.index({ student: 1, completed: 1, lastWatchedAt: 1 }); // "continue watching"
VideoProgressSchema.index({ video: 1, completed: 1 });                     // per-video analytics

module.exports = db.model('VideoProgress', VideoProgressSchema);
