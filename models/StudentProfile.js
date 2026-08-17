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
    nationality: {
        type: String,
        default: 'Indian',
        trim: true,
    },

    // ── Emergency contact ───────────────────────────────────────────────────
    // Whoever the school rings first — often neither parent (a neighbour, an
    // uncle), so it is stored separately from the guardian blocks.
    emergencyContactName:     { type: String, default: '', trim: true },
    emergencyContactPhone:    { type: String, default: '', trim: true },
    emergencyContactRelation: { type: String, default: '', trim: true },
    // Legacy plain-text fields (kept for backward compat)
    class: {
        type: String,
        default: '',
    },
    section: {
        type: String,
        default: '',
    },
    // Class is set at admission; the section can follow later
    currentClass: {
        type: db.Types.UUID,
        ref: 'Class',
        default: null,
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
    // Permanent (home-town) address. The block above doubles as the current
    // address, so every existing reader of `address`/`city`/… keeps working.
    permanentAddress: { type: String, default: '', trim: true },
    permanentCity:    { type: String, default: '', trim: true },
    permanentState:   { type: String, default: '', trim: true },
    permanentPincode: { type: String, default: '', trim: true },
    permanentCountry: { type: String, default: 'India', trim: true },
    sameAsCurrent:    { type: Boolean, default: false },

    // ── Identity & certificates ─────────────────────────────────────────────
    // File fields hold the bare stored filename under uploads/student-docs,
    // matching how TeacherProfile keeps Aadhaar/PAN scans.
    aadhaarNumber:             { type: String, default: '', trim: true },
    // Passport-size photo. Also mirrored onto User.profileImage when uploaded,
    // so it doubles as the student's avatar across the app.
    photoFile:                 { type: String, default: '' },
    aadhaarFrontFile:          { type: String, default: '' },
    aadhaarBackFile:           { type: String, default: '' },
    birthCertificateFile:      { type: String, default: '' },
    casteCertificateFile:      { type: String, default: '' },
    disabilityCertificateFile: { type: String, default: '' },
    medicalCertificateFile:    { type: String, default: '' },

    // ── Previous school ─────────────────────────────────────────────────────
    // Only filled in for a transfer admission; `isTransferStudent` gates the
    // whole block in the intake form and in validation.
    isTransferStudent:         { type: Boolean, default: false },
    previousSchoolName:        { type: String, default: '', trim: true },
    // Same street / city / state / PIN / country shape as the student's own
    // addresses, so the whole block can reuse the shared AddressFields inputs.
    previousSchoolAddress:     { type: String, default: '', trim: true },
    previousSchoolCity:        { type: String, default: '', trim: true },
    previousSchoolState:       { type: String, default: '', trim: true },
    previousSchoolPincode:     { type: String, default: '', trim: true },
    previousSchoolCountry:     { type: String, default: 'India', trim: true },
    previousSchoolMedium:      { type: String, default: '', trim: true },
    previousSchoolBoard:       { type: String, default: '', trim: true },
    // Only when previousSchoolBoard is 'State Board' — which one, e.g.
    // "Maharashtra State Board of Secondary and Higher Secondary Education".
    previousSchoolStateBoardName: { type: String, default: '', trim: true },
    previousClass:             { type: String, default: '', trim: true },
    previousAcademicYear:      { type: String, default: '', trim: true },
    previousSchoolLeavingDate: { type: Date,   default: null },
    previousSchoolContact:     { type: String, default: '', trim: true },
    tcNumber:                  { type: String, default: '', trim: true },
    tcDate:                    { type: Date,   default: null },
    tcFile:                    { type: String, default: '' },
    migrationCertificateFile:  { type: String, default: '' },

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

