const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  What one student has watched of one video of one chapter, in one academic
//  year — the rolled-up record every screen and report reads.
//
//  furthestSec     how far into the video the student has genuinely watched:
//                  it only moves forward through playback the server accepted
//                  (services/lms/tracking), never by a seek. The player lets
//                  the student move freely up to this point and no further.
//  lastPositionSec where to resume.
//  watchedSeconds  time spent actually playing, replays included.
//  watchedPercent  furthestSec against the video's length.
//
//  The row is written by heartbeats only, and is never deleted or reset when
//  a release is taken down, a book is reassigned or the student changes
//  section — the class and section recorded here are the ones they watched in.
// ─────────────────────────────────────────────────────────────────────────────
const LmsProgressSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear:  { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    class:         { type: db.Types.UUID, ref: 'Class', default: null },
    section:       { type: db.Types.UUID, ref: 'ClassSection', default: null, index: true },
    schoolSubject: { type: db.Types.UUID, ref: 'Subject', default: null },
    lmsSubject:    { type: db.Types.UUID, ref: 'LmsSubject', default: null },
    book:          { type: db.Types.UUID, ref: 'LmsBook', required: true, index: true },
    chapter:       { type: db.Types.UUID, ref: 'LmsChapter', required: true, index: true },
    chapterVideo:  { type: db.Types.UUID, ref: 'LmsChapterVideo', required: true, index: true },
    video:         { type: db.Types.UUID, ref: 'LmsVideo', required: true, index: true },
    student:       { type: db.Types.UUID, ref: 'User', required: true, index: true },

    durationSec:     { type: Number, default: 0 },
    firstWatchedAt:  { type: Date, default: null },
    lastWatchedAt:   { type: Date, default: null },
    watchedSeconds:  { type: Number, default: 0 },
    furthestSec:     { type: Number, default: 0 },
    lastPositionSec: { type: Number, default: 0 },
    watchedPercent:  { type: Number, default: 0 },
    sessionsCount:   { type: Number, default: 0 },
    seekViolations:  { type: Number, default: 0 },
    status:          { type: String, enum: ['in_progress', 'completed'], default: 'in_progress', index: true },
    completedAt:     { type: Date, default: null },
}, { timestamps: true });

LmsProgressSchema.index({ student: 1, chapterVideo: 1, academicYear: 1 }, { unique: true });
LmsProgressSchema.index({ student: 1, lastWatchedAt: 1 });

module.exports = db.model('LmsProgress', LmsProgressSchema);
