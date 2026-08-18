const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Per-section verification state for one employee record.
//
//  Why a new table: the ERP had no verification mechanism at all — a teacher's
//  Aadhaar, PAN, certificates and bank details were captured at intake and
//  never signed off. Rather than bolt a pile of *Verified booleans onto
//  TeacherProfile (which would need a new column per section and carries no
//  trail of who signed off, or when), each section gets one row here.
//
//  Absence of a row means 'pending' — so existing employees need no backfill
//  and the feature is inert until a school starts using it.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFICATION_SECTIONS = [
    'personal',
    'contact',
    'government_id',
    'education',
    'employment_documents',
    'bank',
];

const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'];

const EmployeeVerificationSchema = new db.Schema({
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
    section: {
        type: String,
        enum: VERIFICATION_SECTIONS,
        required: true,
    },
    status: {
        type: String,
        enum: VERIFICATION_STATUSES,
        default: 'pending',
    },
    // Free-text reason, shown next to a rejected section.
    note: { type: String, default: '', trim: true },
    verifiedBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    // Optional expiry for sections backed by a document that lapses.
    expiresAt:  { type: Date, default: null },
}, { timestamps: true });

// One row per employee per section.
EmployeeVerificationSchema.index({ employee: 1, section: 1 }, { unique: true });
EmployeeVerificationSchema.index({ school: 1, status: 1 });

module.exports = db.model('EmployeeVerification', EmployeeVerificationSchema);
module.exports.VERIFICATION_SECTIONS = VERIFICATION_SECTIONS;
module.exports.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
