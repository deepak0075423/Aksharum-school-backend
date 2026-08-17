const db = require('../db/orm');

// What a section owes a subject each week, plus every scheduling rule the
// generator needs. One row per section+subject+year. Seeded from the existing
// SectionSubjectTeacher assignments so admins start from real data.
const SubjectRequirementSchema = new db.Schema({
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
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        required: true,
    },
    weeklyPeriods: {
        type: Number,
        required: true,
        min: 0,
    },
    // Primary teacher; alternates are tried in order when the primary is
    // unavailable or already at their cap.
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    altTeachers: [{
        type: db.Types.UUID,
        ref: 'User',
    }],
    subjectType: {
        type: String,
        enum: ['Theory', 'Practical', 'Laboratory', 'Activity', 'Sports', 'Library', 'Other'],
        default: 'Theory',
    },
    // Room demand. `room` pins one specific room; `roomTypes` accepts any free
    // room of those types; both empty ⇒ the section's home room (or none).
    room: {
        type: db.Types.UUID,
        ref: 'Room',
        default: null,
    },
    roomTypes: [{ type: String }],
    requiresRoom: {
        type: Boolean,
        default: false,
    },
    // Block size: 2 ⇒ periods are scheduled as back-to-back pairs (labs).
    consecutivePeriods: {
        type: Number,
        default: 1,
        min: 1,
    },
    maxPerDay: {
        type: Number,
        default: 1,
        min: 1,
    },
    hardMaxPerDay: {
        type: Boolean,
        default: true,
    },
    // Minimum number of periods between two blocks of this subject on one day.
    minGapPeriods: {
        type: Number,
        default: 0,
        min: 0,
    },
    preferredPeriods: [{ type: Number }],
    preferredDays: [{ type: String }],
    // 1 (easy) … 5 (hard). Drives the "no hard subject in the last period" and
    // "don't stack hard subjects" soft constraints.
    difficulty: {
        type: Number,
        default: 3,
        min: 1,
        max: 5,
    },
    priority: {
        type: Number,
        default: 0,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

SubjectRequirementSchema.index({ section: 1, subject: 1, academicYear: 1 }, { unique: true });
SubjectRequirementSchema.index({ school: 1, academicYear: 1 });
SubjectRequirementSchema.index({ school: 1, section: 1 });

module.exports = db.model('SubjectRequirement', SubjectRequirementSchema);
