const db = require('../db/orm');

const StudentProfileSchema = new db.Schema({
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
    gender: {
        type: String,
        enum: ['Male', 'Female', 'Other', ''],
        default: '',
    },
    bloodGroup: {
        type: String,
        default: '',
    },
    religion: {
        type: String,
        default: '',
    },
    category: {
        type: String,
        default: '',
    },
    // Legacy plain-text fields (kept for backward compat)
    class: {
        type: String,
        default: '',
    },
    section: {
        type: String,
        default: '',
    },
    // New FK — assigned section
    currentSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    admissionNumber: {
        type: String,
        default: '',
        trim: true,
    },
    dob: {
        type: Date,
        default: null,
    },
    // Street / house line; city–state–pincode are stored separately so they can
    // be filtered on and auto-filled from the PIN code.
    address: {
        type: String,
        default: '',
    },
    city: {
        type: String,
        default: '',
        trim: true,
    },
    state: {
        type: String,
        default: '',
        trim: true,
    },
    pincode: {
        type: String,
        default: '',
        trim: true,
    },
    country: {
        type: String,
        default: 'India',
        trim: true,
    },
    parent: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    rollNumber: {
        type: String,
        default: '',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('StudentProfile', StudentProfileSchema);

