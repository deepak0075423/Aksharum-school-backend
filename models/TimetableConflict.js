const db = require('../db/orm');

// Every reason a version is not publishable, recorded rather than swallowed.
// Rebuilt from scratch on each generate / validate run for a given version.
const TimetableConflictSchema = new db.Schema({
    version: {
        type: db.Types.UUID,
        ref: 'TimetableVersion',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    type: {
        type: String,
        enum: [
            'TEACHER_CLASH', 'CLASS_CLASH', 'ROOM_CLASH',
            'TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE',
            'SUBJECT_PERIOD_SHORTAGE', 'ROOM_CAPACITY',
            'SUBJECT_TEACHER_MISMATCH', 'PRACTICAL_ROOM_MISSING',
            'DAILY_LIMIT_EXCEEDED', 'WEEKLY_LIMIT_EXCEEDED',
            'CONSECUTIVE_PERIOD_ERROR', 'NON_TEACHING_SLOT',
            'NO_TEACHER_ASSIGNED', 'OTHER',
        ],
        required: true,
    },
    severity: {
        type: String,
        enum: ['ERROR', 'WARNING', 'INFO'],
        default: 'ERROR',
    },
    section:      { type: db.Types.UUID, ref: 'ClassSection', default: null },
    class:        { type: db.Types.UUID, ref: 'Class',        default: null },
    teacher:      { type: db.Types.UUID, ref: 'User',         default: null },
    subject:      { type: db.Types.UUID, ref: 'Subject',      default: null },
    room:         { type: db.Types.UUID, ref: 'Room',         default: null },
    dayOfWeek:    { type: String, default: '' },
    periodNumber: { type: Number, default: null },
    description: {
        type: String,
        default: '',
    },
    suggestion: {
        type: String,
        default: '',
    },
    status: {
        type: String,
        enum: ['open', 'resolved', 'ignored'],
        default: 'open',
    },
    meta: {
        type: db.Types.JSON,
        default: {},
    },
}, { timestamps: true });

TimetableConflictSchema.index({ version: 1, severity: 1 });
TimetableConflictSchema.index({ version: 1, type: 1 });
TimetableConflictSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('TimetableConflict', TimetableConflictSchema);
