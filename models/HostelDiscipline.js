const db = require('../db/orm');

// A disciplinary action against a resident (spec §23). Separate from the
// incident that triggered it, because one incident can produce several actions
// (a fine plus a written warning) and an action can stand on its own.
const HostelDisciplineSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    incident: { type: db.Types.UUID, ref: 'HostelIncident', default: null },

    actionNumber: { type: String, default: '' },               // HD-YYMM-####
    violation: { type: String, required: true },
    violationType: {
        type: String,
        enum: ['curfew', 'ragging', 'substance', 'property_damage', 'misbehaviour',
               'unauthorized_absence', 'visitor_rule', 'mess_rule', 'other'],
        default: 'other',
    },
    actionType: {
        type: String,
        enum: ['verbal_warning', 'written_warning', 'fine', 'parent_notification',
               'warden_action', 'principal_escalation', 'suspension', 'expulsion'],
        required: true,
    },
    severity: { type: String, enum: ['minor', 'moderate', 'major'], default: 'minor' },
    description: { type: String, default: '' },
    date: { type: Date, default: Date.now },

    fineAmount: { type: Number, default: 0 },
    // Set when the fine has been billed — links to the invoice that carries it,
    // so a fine is never charged twice.
    fineInvoice: { type: db.Types.UUID, ref: 'HostelFeeInvoice', default: null },

    suspensionFrom: { type: Date, default: null },
    suspensionTo: { type: Date, default: null },

    parentNotified: { type: Boolean, default: false },
    parentNotifiedAt: { type: Date, default: null },
    escalatedToPrincipal: { type: Boolean, default: false },
    escalatedAt: { type: Date, default: null },

    // How many prior actions this student already had — snapshotted so a repeat
    // offence reads correctly even after older rows are archived.
    priorCount: { type: Number, default: 0 },
    isRepeatOffence: { type: Boolean, default: false },

    status: { type: String, enum: ['issued', 'acknowledged', 'served', 'revoked'], default: 'issued' },
    attachments: { type: [String], default: [] },
    issuedBy: { type: db.Types.UUID, ref: 'User', default: null },
    issuedByName: { type: String, default: '' },
    remarks: { type: String, default: '' },
}, { timestamps: true });

HostelDisciplineSchema.index({ school: 1, student: 1, date: -1 });
HostelDisciplineSchema.index({ school: 1, hostel: 1, date: -1 });
HostelDisciplineSchema.index({ school: 1, actionType: 1, date: -1 });

module.exports = db.model('HostelDiscipline', HostelDisciplineSchema);
