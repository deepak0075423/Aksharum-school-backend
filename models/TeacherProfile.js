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
        trgm: true,   // searched by substring from the library issue counter
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
    // ── Organisation placement ──────────────────────────────────────────────
    // Added with the Employee Directory. Both are additive and default to the
    // pre-existing behaviour, so every teacher record written before this
    // module reads back exactly as it did.
    //
    // reportingManager — the employee this person reports to. This is employee
    // master data: it belongs on the employee record itself, and giving it its
    // own table would have meant a second employee master keyed by user id.
    reportingManager: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    // staffType — an explicit teaching / non-teaching classification. Empty
    // means "not stated", in which case the directory derives it from the
    // employee's academic assignments, so existing rows need no backfill.
    staffType: {
        type: String,
        enum: ['teaching', 'non_teaching', ''],
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
    // Highest qualification. When the admin picks "Other" the typed text is
    // stored here directly, so downstream screens never special-case it.
    qualification: {
        type: String,
        default: '',
    },
    experience: {
        type: String,
        default: '',
    },

    // ── Personal ────────────────────────────────────────────────────────────
    bloodGroup:            { type: String, default: '' },
    fatherOrHusbandName:   { type: String, default: '', trim: true },
    emergencyContactName:  { type: String, default: '', trim: true },
    emergencyContactPhone: { type: String, default: '', trim: true },

    // ── Contact ─────────────────────────────────────────────────────────────
    alternatePhone:   { type: String, default: '', trim: true },
    // Street / house line; city–state–pincode are stored separately so they can
    // be filtered on and auto-filled from the PIN code — same shape as StudentProfile.
    currentAddress:   { type: String, default: '', trim: true },
    currentCity:      { type: String, default: '', trim: true },
    currentState:     { type: String, default: '', trim: true },
    currentPincode:   { type: String, default: '', trim: true },
    currentCountry:   { type: String, default: 'India', trim: true },
    permanentAddress: { type: String, default: '', trim: true },
    permanentCity:    { type: String, default: '', trim: true },
    permanentState:   { type: String, default: '', trim: true },
    permanentPincode: { type: String, default: '', trim: true },
    permanentCountry: { type: String, default: 'India', trim: true },

    // ── Government ID & tax ─────────────────────────────────────────────────
    aadhaarNumber:    { type: String, default: '', trim: true },
    aadhaarFrontFile: { type: String, default: '' },
    aadhaarBackFile:  { type: String, default: '' },
    panNumber:        { type: String, default: '', trim: true },
    panCardFile:      { type: String, default: '' },
    uanNumber:        { type: String, default: '', trim: true },

    // ── Education ───────────────────────────────────────────────────────────
    teachingDegree: { type: String, default: '' },

    // ── Work experience ─────────────────────────────────────────────────────
    employmentType:  { type: String, enum: ['fresher', 'experienced', ''], default: '' },
    totalExperience: { type: String, default: '', trim: true },
    previousSchool:  { type: String, default: '', trim: true },
    lastDesignation: { type: String, default: '', trim: true },
    experienceCertificateFile: { type: String, default: '' },
    resignationLetterFile:     { type: String, default: '' },
    joiningLetterFile:         { type: String, default: '' },

    // ── Bank ────────────────────────────────────────────────────────────────
    bankAccountHolder: { type: String, default: '', trim: true },
    bankAccountNumber: { type: String, default: '', trim: true },
    bankIfsc:          { type: String, default: '', trim: true },
    bankBranch:        { type: String, default: '', trim: true },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('TeacherProfile', TeacherProfileSchema);
