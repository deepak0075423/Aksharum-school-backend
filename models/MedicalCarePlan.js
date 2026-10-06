const db = require('../db/orm');

/**
 * An emergency care plan (Oct 2026): what to do, step by step, when a child
 * with anaphylaxis, asthma, epilepsy, diabetes or a heart condition has an
 * episode. The Medical Room writes it (from a template), the doctor's name and
 * date record who signed it off, the parent confirms it in the app, and it is
 * reviewed by `reviewDue`. Active plans are printed on the emergency card and
 * shown, as steps, to the staff who look after the child.
 */
const MedicalCarePlanSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    kind: {
        type: String,
        enum: ['anaphylaxis', 'asthma', 'seizure', 'diabetes', 'cardiac', 'other'],
        default: 'other',
    },
    title:     { type: String, required: true, trim: true },   // "Anaphylaxis — peanuts"
    allergy:   { type: db.Types.UUID, ref: 'MedicalAllergy', default: null },
    condition: { type: db.Types.UUID, ref: 'MedicalCondition', default: null },
    rescueMed: { type: db.Types.UUID, ref: 'MedicalRescueMed', default: null },

    triggers:  { type: String, default: '', trim: true },
    signs:     { type: [String], default: [] },               // what an episode looks like
    steps:     { type: Array, default: [] },                  // [{ text, critical }]
    ambulanceWhen: { type: String, default: '', trim: true },
    afterCare:     { type: String, default: '', trim: true },

    doctorName:     { type: String, default: '', trim: true },
    doctorPhone:    { type: String, default: '', trim: true },
    doctorSignedOn: { type: Date, default: null },
    parentConfirmedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    parentConfirmedName: { type: String, default: '' },
    parentConfirmedAt:   { type: Date, default: null },
    reviewDue: { type: Date, default: null },
    document:  { type: db.Types.UUID, ref: 'MedicalDocument', default: null },   // the signed copy

    status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
    reviewNotifiedFor: { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalCarePlanSchema.index({ school: 1, student: 1 });
MedicalCarePlanSchema.index({ school: 1, status: 1, reviewDue: 1 });

module.exports = db.model('MedicalCarePlan', MedicalCarePlanSchema);
