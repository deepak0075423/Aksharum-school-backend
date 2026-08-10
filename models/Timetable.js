const db = require('../db/orm');

const TimetableSchema = new db.Schema({
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    schoolStartTime: {
        type: String,
        required: true,
    },
    schoolEndTime: {
        type: String,
        required: true,
    },
    periodsStructure: [
        {
            periodNumber: { type: Number },
            startTime: { type: String, default: '' },
            endTime: { type: String, default: '' },
            isRecess: { type: Boolean, default: false },
            recessName: { type: String, default: 'Break' }
        }
    ],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// One timetable per section per academic year
TimetableSchema.index({ section: 1, academicYear: 1 }, { unique: true });

module.exports = db.model('Timetable', TimetableSchema);
