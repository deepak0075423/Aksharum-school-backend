const db = require('../db/orm');

// A single scheduled period inside a draft version. Mirrors TimetableEntry
// (the live table) plus room + provenance so a draft can be previewed, edited
// and diffed before it ever reaches the published schedule.
const TimetableVersionEntrySchema = new db.Schema({
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
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    dayOfWeek: {
        type: String,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        required: true,
    },
    periodNumber: {
        type: Number,
        required: true,
        min: 1,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        required: true,
    },
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    room: {
        type: db.Types.UUID,
        ref: 'Room',
        default: null,
    },
    // Set when an admin moved/created this entry by hand — regeneration with
    // `preserveManualEdits` pins these before solving.
    isManual: {
        type: Boolean,
        default: false,
    },
    isLocked: {
        type: Boolean,
        default: false,
    },
    note: {
        type: String,
        default: '',
    },
}, { timestamps: true });

// HARD rule #1: one subject per section per slot.
TimetableVersionEntrySchema.index({ version: 1, section: 1, dayOfWeek: 1, periodNumber: 1 }, { unique: true });
TimetableVersionEntrySchema.index({ version: 1, teacher: 1, dayOfWeek: 1, periodNumber: 1 });
TimetableVersionEntrySchema.index({ version: 1, room: 1, dayOfWeek: 1, periodNumber: 1 });
TimetableVersionEntrySchema.index({ version: 1, section: 1 });

module.exports = db.model('TimetableVersionEntry', TimetableVersionEntrySchema);
