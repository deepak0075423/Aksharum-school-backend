const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A named responsibility an employee holds beyond their teaching load —
//  HOD, Academic Coordinator, Examination Coordinator, House / Club / Sports /
//  Discipline / Event Coordinator, and so on.
//
//  Why a new table: the ERP already records the two responsibilities that are
//  structural — Class Teacher and Vice Class Teacher live on ClassSection
//  (classTeacher / substituteTeacher) — but has nowhere to record the rest.
//  They are deliberately NOT stored on TeacherProfile: an employee can hold
//  several at once, each scoped to a class / section / subject / department and
//  bounded by an academic year.
//
//  This table is standalone on purpose. The Employee Directory reads it, but
//  nothing here depends on the directory: any module can assign or read a
//  responsibility, and removing the directory would leave it working.
//
//  Class Teacher / Vice Class Teacher are NEVER written here — they are read
//  from ClassSection so there is exactly one source of truth for them.
// ─────────────────────────────────────────────────────────────────────────────

const RESPONSIBILITY_TYPES = [
    'hod',
    'academic_coordinator',
    'examination_coordinator',
    'house_coordinator',
    'club_coordinator',
    'sports_coordinator',
    'discipline_coordinator',
    'event_coordinator',
    'other',
];

const EmployeeResponsibilitySchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    employee: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    type: {
        type: String,
        enum: RESPONSIBILITY_TYPES,
        required: true,
    },
    // Free-text label shown to users. Defaults to the type's label when blank.
    title: {
        type: String,
        default: '',
        trim: true,
    },
    // What the responsibility covers. All optional — an HOD is scoped by
    // department, a House Coordinator by nothing but its own name.
    department: { type: String, default: '', trim: true },
    class:   { type: db.Types.UUID, ref: 'Class',        default: null },
    section: { type: db.Types.UUID, ref: 'ClassSection', default: null },
    subject: { type: db.Types.UUID, ref: 'Subject',      default: null },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    fromDate: { type: Date, default: null },
    toDate:   { type: Date, default: null },
    notes:    { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    assignedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

EmployeeResponsibilitySchema.index({ school: 1, employee: 1 });
EmployeeResponsibilitySchema.index({ school: 1, type: 1, isActive: 1 });

module.exports = db.model('EmployeeResponsibility', EmployeeResponsibilitySchema);
module.exports.RESPONSIBILITY_TYPES = RESPONSIBILITY_TYPES;
