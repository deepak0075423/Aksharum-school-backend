const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoEnrollment — a student's progress through a whole playlist or course,
//  aggregated from the underlying VideoProgress rows. Backs the "Course
//  Progress" / "Playlist Progress" widgets and certificate issuance.
// ─────────────────────────────────────────────────────────────────────────────
const VideoEnrollmentSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },

    kind:     { type: String, enum: ['playlist', 'course'], required: true },
    playlist: { type: db.Types.UUID, ref: 'VideoPlaylist', default: null },
    course:   { type: db.Types.UUID, ref: 'VideoCourse', default: null },

    itemsTotal:     { type: Number, default: 0 },
    itemsCompleted: { type: Number, default: 0 },
    progressPercent:{ type: Number, default: 0 },

    completed:   { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: null },

    // Certificate (issued when course.certificateEnabled and progress ≥ passPercent)
    certificateIssued: { type: Boolean, default: false },
    certificateNo:     { type: String, default: '' }, // CERT-YYMM-####
    certificateUrl:    { type: String, default: '' },
    issuedAt:          { type: Date, default: null },
}, { timestamps: true });

VideoEnrollmentSchema.index({ student: 1, kind: 1 });
VideoEnrollmentSchema.index({ course: 1 });
VideoEnrollmentSchema.index({ playlist: 1 });

module.exports = db.model('VideoEnrollment', VideoEnrollmentSchema);
