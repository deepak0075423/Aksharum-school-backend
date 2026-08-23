const db = require('../db/orm');

const ClassSectionSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    class: {
        type: db.Types.UUID,
        ref: 'Class',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    sectionName: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
    },
    classTeacher: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    substituteTeacher: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    maxStudents: {
        type: Number,
        required: true,
        min: 1,
        default: 40,
    },
    currentCount: {
        type: Number,
        default: 0,
        min: 0,
    },
    // Set the first (and only) time roll numbers are auto-assigned for this
    // section; individual numbers can still be corrected by hand afterwards.
    rollNumbersAssignedAt: {
        type: Date,
        default: null,
    },
    enrolledStudents: [{
        type: db.Types.UUID,
        ref: 'User'
    }],
    status: {
        type: String,
        enum: ['active', 'inactive', 'archived'],
        default: 'active',
    },
    startTime: {
        type: String,
        default: '08:00',
    },
    endTime: {
        type: String,
        default: '14:00',
    },
    totalPeriods: {
        type: Number,
        default: 8,
    },
    lunchTimeTotalInMinutes: {
        type: Number,
        default: 30,
    },
    lunchAfterPeriod: {
        type: Number,
        default: 4,
    },
    // Whether this section teaches on Saturday. The SCHOOL decides — see
    // utils/timetableDays.js — and this is the per-section override, so the
    // default has to mean "follow the school", not "closed".
    //
    // It used to default to false while School.leaveSettings.saturdayWorking
    // defaulted to true. Two defaults contradicting each other meant every new
    // section was born closed on Saturday, and stayed that way until somebody
    // happened to re-save School Settings.
    openOnSaturday: {
        type: Boolean,
        default: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique section name within a class
ClassSectionSchema.index({ class: 1, sectionName: 1 }, { unique: true });

module.exports = db.model('ClassSection', ClassSectionSchema);
