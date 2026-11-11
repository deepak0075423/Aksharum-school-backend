const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  The office's decision on ONE uploaded employee document.
//
//  EmployeeVerification signs off a whole section (Government ID, Employment
//  documents…). This is one level down: each scan on its own — the Aadhaar
//  front can be fine while the back is unreadable.
//
//  `fileName` is the file the decision was made on. When the employee (or the
//  office) puts a different file in the slot, the decision no longer describes
//  what is on file and the document reads as awaiting review again — so a
//  re-upload needs no flag to be set anywhere; the names simply differ.
//
//  Absence of a row means "never reviewed" (see services/employeeDocuments).
// ─────────────────────────────────────────────────────────────────────────────

const DOCUMENT_REVIEW_STATUSES = ['verified', 'rejected'];

const EmployeeDocumentReviewSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    // One of DOCUMENT_DEFS' keys — the TeacherProfile column holding the file.
    docKey:   { type: String, required: true },
    fileName: { type: String, default: '' },
    status:   { type: String, enum: DOCUMENT_REVIEW_STATUSES, required: true },
    // Required when rejected: what the employee has to fix.
    comment:  { type: String, default: '', trim: true },
    reviewedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    // When the employee put a new file in after a rejection.
    resubmittedAt: { type: Date, default: null },
    // Every decision and re-upload, oldest first: { action, status?, comment?,
    // fileName, by, at }. Kept here because a rejection is only half the story
    // once the next file arrives.
    history: { type: Array, default: [] },
}, { timestamps: true });

EmployeeDocumentReviewSchema.index({ employee: 1, docKey: 1 }, { unique: true });
EmployeeDocumentReviewSchema.index({ school: 1, status: 1 });

module.exports = db.model('EmployeeDocumentReview', EmployeeDocumentReviewSchema);
module.exports.DOCUMENT_REVIEW_STATUSES = DOCUMENT_REVIEW_STATUSES;
