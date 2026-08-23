const db = require('../db/orm');

/**
 * Sections taught a subject TOGETHER: 9-A and 9-B sit in one room, with one
 * teacher, in the same period. One lesson, several rosters.
 *
 * This is a different thing from SubjectRequirement.mergeGroup, which merges two
 * SUBJECTS inside a single section (Maths and Computer in the same slot). This
 * merges the same subject ACROSS sections, so the generator collapses their
 * demands into one placement that books every member's slot at once.
 *
 * A group is scoped to one academic year. `teacher` and `room` are optional
 * pins — left blank, the solver picks from the teachers assigned to the subject
 * in every member section.
 */
const TimetableMergeGroupSchema = new db.Schema({
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
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        required: true,
    },
    // Two or more. A group that drops to one member stops merging anything and
    // its remaining section simply schedules on its own.
    sections: [{
        type: db.Types.UUID,
        ref: 'ClassSection',
    }],
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
    // Set when an admin merges one period by hand in the manual grid rather
    // than planning the merge before generating.
    source: {
        type: String,
        enum: ['plan', 'manual'],
        default: 'plan',
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

TimetableMergeGroupSchema.index({ school: 1, academicYear: 1, subject: 1 });

module.exports = db.model('TimetableMergeGroup', TimetableMergeGroupSchema);
