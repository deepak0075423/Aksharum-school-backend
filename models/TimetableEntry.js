const db = require('../db/orm');

const TimetableEntrySchema = new db.Schema({
    timetable: {
        type: db.Types.UUID,
        ref: 'Timetable',
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
    // Allocated by the timetable generator; null for hand-built timetables.
    room: {
        type: db.Types.UUID,
        ref: 'Room',
        default: null,
    },
    // The draft version this entry was published from, for traceability.
    sourceVersion: {
        type: db.Types.UUID,
        ref: 'TimetableVersion',
        default: null,
    },
    // Subjects taught alongside `subject` in this very period (merged subjects).
    // Written by publish from TimetableVersionEntry.additionalSubjects.
    additionalSubjects: [{
        subject: { type: db.Types.UUID, ref: 'Subject' },
        teacher: { type: db.Types.UUID, ref: 'User', default: null },
        room:    { type: db.Types.UUID, ref: 'Room', default: null },
    }],
    mergedSections: [{
        type: db.Types.UUID,
        ref: 'ClassSection',
    }],
    // Written by hand in the live grid after publishing. Publish reprojects the
    // whole section from its draft, so this is what tells it — and the admin —
    // which live corrections are about to be overwritten.
    isManual: {
        type: Boolean,
        default: false,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique period per day per timetable
TimetableEntrySchema.index({ timetable: 1, dayOfWeek: 1, periodNumber: 1 }, { unique: true });

module.exports = db.model('TimetableEntry', TimetableEntrySchema);
