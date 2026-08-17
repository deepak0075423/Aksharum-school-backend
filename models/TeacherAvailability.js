const db = require('../db/orm');

// Per-teacher scheduling constraints for one academic year.
//
// Availability is stored as a list of BLOCKED slots rather than one row per
// day+period: a school with 86 teachers × 6 days × 8 periods would otherwise
// need ~4k rows to say "everyone is free", and the generator only ever asks
// "is this teacher blocked at Mon-P3?".
const TeacherAvailabilitySchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    unavailable: [{
        dayOfWeek:    { type: String, default: '' },
        periodNumber: { type: Number, default: 0 },
        reason:       { type: String, default: '' },
    }],
    maxPeriodsPerDay: {
        type: Number,
        default: null,
    },
    maxPeriodsPerWeek: {
        type: Number,
        default: null,
    },
    // When true the daily cap is a HARD constraint the solver may never break;
    // when false it degrades to a weighted soft penalty.
    hardDailyLimit: {
        type: Boolean,
        default: true,
    },
    preferredDays: [{ type: String }],
    preferredPeriods: [{ type: Number }],
    notes: {
        type: String,
        default: '',
    },
    updatedBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

TeacherAvailabilitySchema.index({ school: 1, teacher: 1, academicYear: 1 }, { unique: true });
TeacherAvailabilitySchema.index({ school: 1, academicYear: 1 });

module.exports = db.model('TeacherAvailability', TeacherAvailabilitySchema);
