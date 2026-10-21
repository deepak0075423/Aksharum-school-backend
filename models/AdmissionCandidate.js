const db = require('../db/orm');

/**
 * An application scheduled for an exam or interview — the admit card's row.
 * `rollNumber` is printed on the admit card and is what evaluators enter marks
 * against; `slot`/`room`/`panel` serve interviews and seating.
 */
const AdmissionCandidateSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    exam:         { type: db.Types.UUID, ref: 'AdmissionExam', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    applicant:    { type: db.Types.UUID, ref: 'User', default: null },
    rollNumber:   { type: String, default: '' },
    room:         { type: String, default: '' },
    seat:         { type: String, default: '' },
    slot:         { type: Date, default: null },
    slotId:       { type: String, default: '' },          // the exam's booking slot it holds (exam.booking.slots[].id)
    slotChanges:  { type: Number, default: 0 },           // times the family moved it
    slotBookedAt: { type: Date, default: null },
    // Extra time for this candidate (an accommodation, with the reason the office recorded).
    extraMinutes: { type: Number, default: 0 },
    extraReason:  { type: String, default: '' },
    panel:        { type: [db.Types.UUID], default: () => [] },
    status:       { type: String, enum: ['scheduled', 'present', 'absent', 'attempted', 'evaluated', 'withdrawn'], default: 'scheduled' },
    attendanceBy: { type: db.Types.UUID, ref: 'User', default: null },
    attendanceAt: { type: Date, default: null },
    scheduledBy:  { type: db.Types.UUID, ref: 'User', default: null },
    remindedAt:   { type: Date, default: null },          // the exam reminder went (services/admission/sweep.js)
    admitNotifiedAt: { type: Date, default: null },       // the "admit card ready" email went (sweep.js)
}, { timestamps: true });

AdmissionCandidateSchema.index({ exam: 1, application: 1 }, { unique: true });
AdmissionCandidateSchema.index({ school: 1, exam: 1, status: 1 });

module.exports = db.model('AdmissionCandidate', AdmissionCandidateSchema);
