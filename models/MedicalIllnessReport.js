const db = require('../db/orm');

/**
 * A family telling the school their child is off sick (Oct 2026): from when,
 * the signs, a note. The medical staff read it; it counts towards the
 * outbreak watch; nothing here is shown to teachers beyond "off sick".
 */
const MedicalIllnessReportSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    from:     { type: Date, required: true },
    to:       { type: Date, default: null },
    symptoms: { type: [String], default: [] },   // fever | cough | vomiting | diarrhoea | red_eyes | rash | other
    note:     { type: String, default: '', trim: true },

    reportedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    reportedByName: { type: String, default: '' },
    status:     { type: String, enum: ['new', 'seen', 'withdrawn'], default: 'new' },
    seenAt:     { type: Date, default: null },
    seenBy:     { type: db.Types.UUID, ref: 'User', default: null },
    seenByName: { type: String, default: '' },
}, { timestamps: true });

MedicalIllnessReportSchema.index({ school: 1, from: -1 });
MedicalIllnessReportSchema.index({ school: 1, student: 1 });

module.exports = db.model('MedicalIllnessReport', MedicalIllnessReportSchema);
