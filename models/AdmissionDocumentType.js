const db = require('../db/orm');

/**
 * A kind of paper the school asks applicants for — birth certificate, last
 * report card, transfer certificate, a passport photo.
 *
 *   appliesTo     classes / rounds it is asked for (empty = every one)
 *   required      whether an application can be submitted without it
 *   gate          the latest point it must be VERIFIED by: never, before the
 *                 entrance exam, or before admission is confirmed
 *   reviewers     staff (besides admission administrators) who verify it
 *   mapsTo        the student-record field it becomes on enrolment
 *                 (StudentProfile.birthCertificateFile …), or ''
 *   sensitive     shown only to admission administrators and the applicant
 */
const AdmissionDocumentTypeSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    key:          { type: String, required: true, trim: true },
    name:         { type: String, required: true, trim: true },
    description:  { type: String, default: '' },
    accept:       { type: [String], default: () => ['pdf', 'jpg', 'jpeg', 'png'] },
    maxSizeMB:    { type: Number, default: 5 },
    required:     { type: Boolean, default: false },
    appliesTo: {
        classes:  { type: [db.Types.UUID], default: () => [] },
        rounds:   { type: [db.Types.UUID], default: () => [] },
    },
    verification: { type: Boolean, default: true },
    gate:         { type: String, enum: ['none', 'submission', 'before_exam', 'before_confirmation'], default: 'before_confirmation' },
    reviewers:    { type: [db.Types.UUID], default: () => [] },
    rejectionReasons: { type: [String], default: () => [] },
    allowResubmission: { type: Boolean, default: true },
    maxResubmissions:  { type: Number, default: 3 },
    deadlineDays: { type: Number, default: null },      // days after submission; null = the round's document deadline
    mapsTo:       { type: String, default: '' },
    sensitive:    { type: Boolean, default: false },
    order:        { type: Number, default: 0 },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionDocumentTypeSchema.index({ school: 1, key: 1 }, { unique: true });

module.exports = db.model('AdmissionDocumentType', AdmissionDocumentTypeSchema);
