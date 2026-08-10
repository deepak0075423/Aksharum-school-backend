const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoWatchEvent — append-only telemetry stream. Every play/pause/seek/
//  heartbeat/complete emitted by the player lands here. This is the raw source
//  for analytics (drop-off curves, skipped %, average watch time, device mix).
//
//  This table is HIGH VOLUME (100M+ views ⇒ billions of rows). In production it
//  should be time-partitioned (monthly) and rolled up nightly into VideoProgress
//  and per-video/per-day aggregates, then aged out. See the design doc §17/§23.
// ─────────────────────────────────────────────────────────────────────────────
const VideoWatchEventSchema = new db.Schema({
    school:     { type: db.Types.UUID, ref: 'School', default: null, index: true },
    student:    { type: db.Types.UUID, ref: 'User', required: true, index: true },
    video:      { type: db.Types.UUID, ref: 'Video', required: true, index: true },
    assignment: { type: db.Types.UUID, ref: 'VideoAssignment', default: null },

    eventType: {
        type: String,
        enum: ['play', 'pause', 'seek', 'heartbeat', 'complete', 'ended', 'ratechange', 'error'],
        required: true,
    },
    sessionId:      { type: String, default: '' },
    positionSec:    { type: Number, default: 0 },
    fromSec:        { type: Number, default: 0 }, // seek origin
    toSec:          { type: Number, default: 0 }, // seek destination
    watchedDeltaSec:{ type: Number, default: 0 }, // seconds actually watched since last heartbeat
    playbackRate:   { type: Number, default: 1 },

    device:  { type: String, default: '' },
    browser: { type: String, default: '' },
    os:      { type: String, default: '' },
    network: { type: String, default: '' },
    ip:      { type: String, default: '' },
}, { timestamps: true });

VideoWatchEventSchema.index({ video: 1, createdAt: 1 });
VideoWatchEventSchema.index({ student: 1, video: 1, createdAt: 1 });

module.exports = db.model('VideoWatchEvent', VideoWatchEventSchema);
