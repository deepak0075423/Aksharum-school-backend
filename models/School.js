const db = require('../db/orm');

const SchoolSchema = new db.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    code: {
        type: String,
        trim: true,
        default: '',
    },
    email: {
        type: String,
        trim: true,
        default: '',
        lowercase: true,
    },
    phone: {
        type: String,
        trim: true,
        default: '',
    },
    address: {
        type: String,
        trim: true,
        default: '',
    },
    city: {
        type: String,
        trim: true,
        default: '',
    },
    state: {
        type: String,
        trim: true,
        default: '',
    },
    country: {
        type: String,
        trim: true,
        default: 'India',
    },
    // Education board the school is affiliated with (CBSE, ICSE, …)
    board: {
        type: String,
        trim: true,
        default: '',
    },
    website: {
        type: String,
        default: '',
    },
    logo: {
        type: String,
        default: '',
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    // Per-school module feature flags — controlled by Super Admin
    // Teacher designations the admin can assign (dropdown source)
    designations: {
        type: [String],
        default: ['Teacher', 'Class Teacher', 'Librarian', 'Principal', 'Vice Principal'],
    },
    // Holiday types the admin can assign (dropdown source), same idea
    holidayTypes: {
        type: [String],
        default: ['Public Holiday', 'School Specific', 'Optional Holiday', 'Exam Break'],
    },
    // Template for auto-generated admission numbers — see utils/admissionNumber.js
    admissionNumberFormat: {
        type: String,
        default: '{INITIALS}{YYYY}{####}',
        trim: true,
    },
    // Separate template for employee / teacher IDs — see utils/employeeId.js
    employeeIdFormat: {
        type: String,
        default: '{INITIALS}{####}',
        trim: true,
    },
    modules: {
        attendance: {
            type: Boolean,
            default: false,
        },
        notification: {
            type: Boolean,
            default: false,
        },
        aptitudeExam: {
            type: Boolean,
            default: false,
        },
        result: {
            type: Boolean,
            default: false,
        },
        timetable: {
            type: Boolean,
            default: false,
        },
        holiday: {
            type: Boolean,
            default: false,
        },
        leave: {
            type: Boolean,
            default: false,
        },
        document: {
            type: Boolean,
            default: false,
        },
        library: {
            type: Boolean,
            default: false,
        },
        payroll: {
            type: Boolean,
            default: false,
        },
        fees: {
            type: Boolean,
            default: false,
        },
        chat: {
            type: Boolean,
            default: false,
        },
        inventory: {
            type: Boolean,
            default: false,
        },
        transport: {
            type: Boolean,
            default: false,
        },
        videoLibrary: {
            type: Boolean,
            default: false,
        },
        feedback: {
            type: Boolean,
            default: false,
        },
        employeeDirectory: {
            type: Boolean,
            default: false,
        },
    },
    leaveSettings: {
        saturdayWorking:  { type: Boolean, default: true },
        saturdayMode:     { type: String, enum: ['all', '1_3_5', '2_4'], default: 'all' },
        saturdayHalfDay:  { type: Boolean, default: false },
    },
    // Per-school SMTP — when enabled, all emails for this school are sent
    // through these credentials instead of the platform-wide transporter.
    smtp: {
        enabled:   { type: Boolean, default: false },
        host:      { type: String, trim: true, default: '' },
        port:      { type: Number, default: 587 },
        secure:    { type: Boolean, default: false },
        user:      { type: String, trim: true, default: '' },
        pass:      { type: String, default: '' },
        fromName:  { type: String, trim: true, default: '' },
        fromEmail: { type: String, trim: true, lowercase: true, default: '' },
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('School', SchoolSchema);
