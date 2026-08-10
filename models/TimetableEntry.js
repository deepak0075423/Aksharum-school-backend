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
    additionalSubjects: [{
        subject: { type: db.Types.UUID, ref: 'Subject' },
        teacher: { type: db.Types.UUID, ref: 'User', default: null },
    }],
    mergedSections: [{
        type: db.Types.UUID,
        ref: 'ClassSection',
    }],
});

// Unique period per day per timetable
TimetableEntrySchema.index({ timetable: 1, dayOfWeek: 1, periodNumber: 1 }, { unique: true });

module.exports = db.model('TimetableEntry', TimetableEntrySchema);
