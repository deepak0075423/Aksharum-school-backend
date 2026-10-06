const db = require('../db/orm');

/**
 * A cluster of the same illness noticed by the sweep (Oct 2026): four
 * children of one section with conjunctivitis in three days. Cases come from
 * Medical Room visits, children kept off school (exclusions) and the
 * illnesses families report. Only the medical staff see who the cases are —
 * a notice to families or teachers names no child.
 *
 *   watching   noticed; the staff are looking into it
 *   confirmed  the staff agree it is an outbreak
 *   closed     over (by the staff, or by itself after a quiet fortnight)
 */
const MedicalOutbreakSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    number: { type: String, default: '' },

    rule:  { type: String, required: true },
    label: { type: String, default: '' },
    scope: { type: Object, default: {} },      // { kind: 'section'|'class'|'school', id, label }
    status: { type: String, enum: ['watching', 'confirmed', 'closed'], default: 'watching' },
    cases: { type: [Object], default: [] },    // [{ student, source: 'visit'|'exclusion'|'report', sourceId, on }]
    firstCaseAt: { type: Date, default: null },
    lastCaseAt:  { type: Date, default: null },

    confirmedAt:  { type: Date, default: null },
    confirmedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    closedAt:     { type: Date, default: null },
    closedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    closedByName: { type: String, default: '' },
    closeNote:    { type: String, default: '' },
    notices: { type: [Object], default: [] },  // [{ at, by, byName, audience, families, teachers, text }]
    log:     { type: [Object], default: [] },  // [{ at, by, byName, text }]
    reported: { type: Object, default: {} },   // to the health authority: { on, to, reference }
}, { timestamps: true });

MedicalOutbreakSchema.index({ school: 1, status: 1 });

module.exports = db.model('MedicalOutbreak', MedicalOutbreakSchema);
