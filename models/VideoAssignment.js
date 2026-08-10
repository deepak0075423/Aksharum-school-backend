const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoAssignment — a teacher / class-teacher / school-admin pushing content
//  (a video, several videos, a playlist or a whole course) to an audience with
//  a rule-set (dates, mandatory %, attempts, download policy, …).
//
//  Targeting (spec: whole class / selected students / groups / remedial /
//  gifted / absent) is captured by targetType + class/section/students/groupTag.
//  A resolved snapshot of recipient student ids is stored in `students` so the
//  audience is stable even if class membership changes later.
// ─────────────────────────────────────────────────────────────────────────────
const VideoAssignmentSchema = new db.Schema({
    school:         { type: db.Types.UUID, ref: 'School', required: true, index: true },
    assignmentCode: { type: String, default: '' },  // SA-YYMM-####

    title:        { type: String, required: true, trim: true },
    instructions: { type: String, default: '' },

    assignedBy:     { type: db.Types.UUID, ref: 'User', required: true, index: true },
    assignedByRole: { type: String, default: 'teacher' }, // teacher | class_teacher | subject_teacher | school_admin

    // ── What is assigned ────────────────────────────────────────────────────────
    contentType: { type: String, enum: ['video', 'multiple', 'playlist', 'course'], required: true },
    videos:      { type: [{ type: db.Types.UUID, ref: 'Video' }], default: [] },
    playlist:    { type: db.Types.UUID, ref: 'VideoPlaylist', default: null },
    course:      { type: db.Types.UUID, ref: 'VideoCourse', default: null },

    // ── Who it targets ──────────────────────────────────────────────────────────
    targetType: { type: String, enum: ['class', 'section', 'students', 'group'], required: true },
    class:      { type: db.Types.UUID, ref: 'Class', default: null },
    section:    { type: db.Types.UUID, ref: 'ClassSection', default: null, index: true },
    subject:    { type: db.Types.UUID, ref: 'Subject', default: null }, // subject-teacher scoping
    groupTag:   { type: String, enum: ['', 'remedial', 'gifted', 'absent', 'custom'], default: '' },
    students:   { type: [{ type: db.Types.UUID, ref: 'User' }], default: [] }, // resolved recipients

    // ── Rules ───────────────────────────────────────────────────────────────────
    startDate:      { type: Date, default: null },
    endDate:        { type: Date, default: null },
    visibilityDate: { type: Date, default: null },
    expiryDate:     { type: Date, default: null },

    mandatory:        { type: Boolean, default: false },
    minWatchPercent:  { type: Number, default: 80 },
    maxAttempts:      { type: Number, default: 0 }, // 0 = unlimited
    watchLimitPerDay: { type: Number, default: 0 }, // 0 = no cap
    allowDownload:    { type: Boolean, default: false },
    allowPlaybackSpeed:{ type: Boolean, default: true },

    isPinned:       { type: Boolean, default: false },
    notifyOnAssign: { type: Boolean, default: true },

    status: { type: String, enum: ['scheduled', 'active', 'expired', 'archived'], default: 'active', index: true },

    recipientCount:{ type: Number, default: 0 },
    completedCount:{ type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false, index: true },
}, { timestamps: true });

VideoAssignmentSchema.index({ school: 1, status: 1 });
VideoAssignmentSchema.index({ school: 1, assignedBy: 1 });

module.exports = db.model('VideoAssignment', VideoAssignmentSchema);
