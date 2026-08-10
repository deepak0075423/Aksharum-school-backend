const db = require('../db/orm');

const TeacherProfileSchema = new db.Schema({
    user: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    employeeId: {
        type: String,
        default: '',
        trim: true,
    },
    gender: {
        type: String,
        enum: ['Male', 'Female', 'Other', ''],
        default: '',
    },
    dob: {
        type: Date,
        default: null,
    },
    joiningDate: {
        type: Date,
        default: null,
    },
    // Free-form: the school-managed designation list (School.designations)
    // is the source of truth. 'Librarian' remains RBAC-significant.
    designation: {
        type: String,
        default: '',
    },
    department: {
        type: String,
        default: '',
    },
    subjects: {
        type: [String],
        default: [],
    },
    classes: {
        type: [String],
        default: [],
    },
    qualification: {
        type: String,
        default: '',
    },
    experience: {
        type: String,
        default: '',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('TeacherProfile', TeacherProfileSchema);
