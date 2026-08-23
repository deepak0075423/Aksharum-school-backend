const db = require('../db/orm');

// School-wide timetable settings for one academic year: the default day/period
// grid used when a section has no structure of its own, plus the solver's
// global limits and soft-constraint weights. One row per school+year.
const TimetableConfigSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    workingDays: [{ type: String }],
    // Default grid. `periodType` is what the generator keys on — only
    // 'Teaching' (and 'Activity' when allowSubjectsInActivity) can hold a subject.
    periodTemplate: [{
        periodNumber: { type: Number, default: 0 },
        startTime:    { type: String, default: '' },
        endTime:      { type: String, default: '' },
        periodType:   { type: String, default: 'Teaching' },
        label:        { type: String, default: '' },
    }],
    // Saturdays are commonly shorter / half-day; empty ⇒ reuse periodTemplate.
    saturdayTemplate: [{
        periodNumber: { type: Number, default: 0 },
        startTime:    { type: String, default: '' },
        endTime:      { type: String, default: '' },
        periodType:   { type: String, default: 'Teaching' },
        label:        { type: String, default: '' },
    }],
    allowSubjectsInActivity: {
        type: Boolean,
        default: false,
    },
    defaults: {
        maxTeacherPeriodsPerDay:  { type: Number,  default: 6 },
        maxTeacherPeriodsPerWeek: { type: Number,  default: 30 },
        // Room capacity is deliberately not a scheduling rule — a room is chosen
        // on type and availability — so there is no enforceRoomCapacity here.
        enforceTeacherQualified:  { type: Boolean, default: true },
        hardTeacherDailyLimit:    { type: Boolean, default: true },
    },
    // Relative weights for the optimiser. 0 disables a soft constraint.
    softWeights: {
        sameSubjectTwiceADay:  { type: Number, default: 8 },
        spreadAcrossWeek:      { type: Number, default: 4 },
        difficultLastPeriod:   { type: Number, default: 3 },
        difficultConsecutive:  { type: Number, default: 2 },
        teacherLoadBalance:    { type: Number, default: 3 },
        teacherGaps:           { type: Number, default: 4 },
        studentGaps:           { type: Number, default: 5 },
        teacherPreferred:      { type: Number, default: 2 },
        subjectPreferred:      { type: Number, default: 2 },
        sameSubjectAdjacent:   { type: Number, default: 3 },
        dailyOverload:         { type: Number, default: 3 },
    },
    // Solver budgets — tunable per school so a 60-section campus can be given
    // more time than a 6-section one.
    solver: {
        timeBudgetMs:   { type: Number, default: 20000 },
        maxRestarts:    { type: Number, default: 3 },
        optimiseRounds: { type: Number, default: 2000 },
    },
    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

TimetableConfigSchema.index({ school: 1, academicYear: 1 }, { unique: true });

module.exports = db.model('TimetableConfig', TimetableConfigSchema);
