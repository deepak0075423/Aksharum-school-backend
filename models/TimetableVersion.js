const db = require('../db/orm');

// One generation run / editable draft of a school timetable.
//
// A version is the WORKSPACE: entries live in TimetableVersionEntry and are
// only projected onto the live Timetable/TimetableEntry tables at publish time.
// That is what keeps the currently published schedule untouched while an admin
// generates, previews and edits a replacement.
const TimetableVersionSchema = new db.Schema({
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
    versionNumber: {
        type: Number,
        required: true,
    },
    label: {
        type: String,
        default: '',
        trim: true,
    },
    description: {
        type: String,
        default: '',
    },
    status: {
        type: String,
        enum: ['draft', 'generating', 'generated', 'conflict', 'validated', 'published', 'archived', 'failed'],
        default: 'draft',
    },
    scopeType: {
        type: String,
        enum: ['single', 'multiple', 'school'],
        default: 'single',
    },
    scopeClasses: [{ type: db.Types.UUID, ref: 'Class' }],
    // Resolved section list this version owns — publish only ever touches these.
    sections: [{ type: db.Types.UUID, ref: 'ClassSection' }],
    options: {
        avoidSameSubjectTwiceADay: { type: Boolean, default: true },
        balanceDifficultSubjects:  { type: Boolean, default: true },
        minimizeTeacherGaps:       { type: Boolean, default: true },
        minimizeStudentGaps:       { type: Boolean, default: true },
        preferTeacherAvailability: { type: Boolean, default: true },
        keepPracticalsConsecutive: { type: Boolean, default: true },
        spreadAcrossWeek:          { type: Boolean, default: true },
        // Carry over manual edits from the version this run was based on.
        preserveManualEdits:       { type: Boolean, default: false },
    },
    // Reusing the seed reproduces an identical run — the generator's only
    // randomness is a seeded PRNG used for tie-breaking.
    seed: {
        type: Number,
        default: 0,
    },
    basedOn: {
        type: db.Types.UUID,
        ref: 'TimetableVersion',
        default: null,
    },
    stats: {
        type: db.Types.JSON,
        default: {},
    },
    // Persisted so any cluster worker can answer the progress poll, not just
    // the worker that happens to be running the solver.
    progress: {
        type: db.Types.JSON,
        default: { percent: 0, step: '', steps: [] },
    },
    conflictCount: { type: Number, default: 0 },
    errorCount:    { type: Number, default: 0 },
    warningCount:  { type: Number, default: 0 },
    validatedAt:   { type: Date, default: null },
    generatedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    generatedAt:   { type: Date, default: null },
    publishedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    publishedAt:   { type: Date, default: null },
    archivedAt:    { type: Date, default: null },
    // Soft edit lock so two admins don't silently overwrite each other.
    lockedBy:      { type: db.Types.UUID, ref: 'User', default: null },
    lockedAt:      { type: Date, default: null },
    isDeleted:     { type: Boolean, default: false },
    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

TimetableVersionSchema.index({ school: 1, academicYear: 1, versionNumber: 1 }, { unique: true });
TimetableVersionSchema.index({ school: 1, status: 1 });
TimetableVersionSchema.index({ school: 1, academicYear: 1, status: 1 });

module.exports = db.model('TimetableVersion', TimetableVersionSchema);
