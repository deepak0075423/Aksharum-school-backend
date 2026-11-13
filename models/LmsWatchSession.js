const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  One sitting: opened when the server authorises playback, kept alive by
//  heartbeats, closed when the student leaves, goes quiet, or loses access.
//  The signed playback address a student is given works only while its
//  session is open (controllers/lms/media).
//
//  lastState / lastBeatAt / lastPositionSec are what the NEXT heartbeat is
//  judged against; lastSeq is the highest heartbeat number taken so far.
// ─────────────────────────────────────────────────────────────────────────────
const LmsWatchSessionSchema = new db.Schema({
    progress:     { type: db.Types.UUID, ref: 'LmsProgress', required: true, index: true },
    student:      { type: db.Types.UUID, ref: 'User', required: true, index: true },
    school:       { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    class:        { type: db.Types.UUID, ref: 'Class', default: null },
    section:      { type: db.Types.UUID, ref: 'ClassSection', default: null },
    book:         { type: db.Types.UUID, ref: 'LmsBook', default: null },
    chapter:      { type: db.Types.UUID, ref: 'LmsChapter', default: null },
    chapterVideo: { type: db.Types.UUID, ref: 'LmsChapterVideo', required: true, index: true },
    video:        { type: db.Types.UUID, ref: 'LmsVideo', required: true },
    release:      { type: db.Types.UUID, ref: 'LmsRelease', default: null, index: true },

    startedAt:        { type: Date, default: Date.now },
    lastBeatAt:       { type: Date, default: Date.now },
    endedAt:          { type: Date, default: null },
    startPositionSec: { type: Number, default: 0 },
    lastPositionSec:  { type: Number, default: 0 },
    lastState:        { type: String, enum: ['idle', 'playing', 'paused', 'ended'], default: 'idle' },
    lastSeq:          { type: Number, default: 0 },
    creditedSec:      { type: Number, default: 0 },
    slackSec:         { type: Number, default: 0 },     // jitter allowance in hand — see services/lms/tracking
    seekViolations:   { type: Number, default: 0 },
    status:           { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    closeReason:      { type: String, default: '' },
    ip:               { type: String, default: '' },
    userAgent:        { type: String, default: '' },
}, { timestamps: true });

LmsWatchSessionSchema.index({ status: 1, lastBeatAt: 1 });

module.exports = db.model('LmsWatchSession', LmsWatchSessionSchema);
