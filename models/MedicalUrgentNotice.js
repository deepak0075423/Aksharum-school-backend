const db = require('../db/orm');

/**
 * An urgent message to a family that someone has to answer (Oct 2026): a child
 * is an emergency, is being sent home, has been referred to hospital, or had
 * a serious incident. The parents get it in the app (and by email and text
 * where the school has them); a parent acknowledges it ("on my way, 20 min").
 * If nobody does within the school's `urgentEscalateMinutes`, it moves down
 * the call tree — the next contact is texted and the medical staff are told
 * whom to ring — until someone answers or the list runs out.
 *
 * `contacts` is the call tree as it was when the notice opened:
 *   [{ key, kind, name, relation, phone }]
 * `attempts` is every try, the app's included:
 *   [{ at, by, byName, channel: app|whatsapp|call, to, phone, result, note }]
 *   result: sent | failed | answered | no_answer | busy | wrong_number | left_message
 */
const MedicalUrgentNoticeSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    student:  { type: db.Types.UUID, ref: 'User', required: true },
    visit:    { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    incident: { type: db.Types.UUID, ref: 'MedicalIncident', default: null },

    kind:  { type: String, enum: ['emergency', 'sent_home', 'referred', 'incident'], required: true },
    title: { type: String, default: '' },
    body:  { type: String, default: '' },

    contacts: { type: Array, default: [] },
    step:     { type: Number, default: 0 },      // the contact the call tree has reached
    attempts: { type: Array, default: [] },

    status: { type: String, enum: ['open', 'acknowledged', 'escalated', 'closed'], default: 'open' },
    nextEscalationAt: { type: Date, default: null },

    ackBy:     { type: db.Types.UUID, ref: 'User', default: null },
    ackByName: { type: String, default: '' },
    ackAt:     { type: Date, default: null },
    ackNote:   { type: String, default: '' },
    ackEtaMinutes: { type: Number, default: null },

    closedAt:  { type: Date, default: null },
    closedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    closeNote: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

MedicalUrgentNoticeSchema.index({ school: 1, status: 1 });
MedicalUrgentNoticeSchema.index({ school: 1, student: 1, createdAt: -1 });
MedicalUrgentNoticeSchema.index({ status: 1, nextEscalationAt: 1 });

module.exports = db.model('MedicalUrgentNotice', MedicalUrgentNoticeSchema);
