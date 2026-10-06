const db = require('../db/orm');

/**
 * A student sent on to a specialist after a screening or a visit (Oct 2026) —
 * the eye doctor after a vision check, the dentist after the dental camp —
 * followed until the family says what the specialist found.
 *
 *   waiting   the family has been told; no appointment yet
 *   booked    the family has an appointment (`appointmentOn`)
 *   seen      the family (or the room) recorded what the specialist said;
 *             the medical staff read it and close the referral
 *   closed    done
 *   declined  the family will not go — their reason is kept
 *   cancelled raised in error
 *
 * Overdue is worked out at read time from `dueBy`. One referral per checkup
 * (`source`), so saving a checkup twice never refers the child twice.
 */
const MedicalReferralSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    number:  { type: String, default: '' },

    specialty: {
        type: String,
        enum: ['eye', 'ent', 'dental', 'paediatric', 'nutrition', 'skin', 'mental_health', 'orthopaedic', 'other'],
        default: 'paediatric',
    },
    reason:   { type: String, default: '', trim: true },     // in words for the family
    findings: { type: String, default: '', trim: true },     // the screening's results, for the specialist
    urgency:  { type: String, enum: ['routine', 'soon', 'urgent'], default: 'routine' },
    dueBy:    { type: Date, default: null },
    source: {
        kind:  { type: String, default: 'manual' },           // checkup | visit | incident | growth | campaign | manual
        id:    { type: String, default: '' },
        label: { type: String, default: '' },
    },

    status: { type: String, enum: ['waiting', 'booked', 'seen', 'closed', 'declined', 'cancelled'], default: 'waiting' },
    appointmentOn:   { type: Date, default: null },
    appointmentWith: { type: String, default: '', trim: true },
    // What the specialist found — from the family or the room.
    outcome:  { type: Object, default: {} },   // { seenOn, seenBy, diagnosis, advice, glasses, reportedBy, reportedByName, reportedByRole, reportedAt }
    document: { type: db.Types.UUID, ref: 'MedicalDocument', default: null },
    declinedReason: { type: String, default: '' },
    familyToldAt:   { type: Date, default: null },
    reminders: { type: [Object], default: [] }, // [{ at, kind: 'due'|'overdue'|'manual', by }]

    closedAt:      { type: Date, default: null },
    closedBy:      { type: db.Types.UUID, ref: 'User', default: null },
    closedByName:  { type: String, default: '' },
    closeNote:     { type: String, default: '' },
    cancelReason:  { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
}, { timestamps: true });

MedicalReferralSchema.index({ school: 1, status: 1 });
MedicalReferralSchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicalReferral', MedicalReferralSchema);
