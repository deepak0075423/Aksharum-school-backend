const db = require('../db/orm');

/**
 * First aid given to a student — in the room, on the field, on a trip.
 * The supplies it used come out of the medical stock in the same transaction
 * (services/medicalStock), so `supplies` is what was taken and from which
 * batch: [{ item, name, unit, quantity, batches: [{ batch, batchNumber, quantity }] }].
 */
const MedicalFirstAidSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    at:      { type: Date, required: true, default: Date.now },

    reason:    { type: String, required: true, trim: true },
    injury:    { type: String, default: '', trim: true },     // injury or symptoms
    treatment: { type: String, required: true, trim: true },  // the first aid given
    supplies:  { type: Array, default: [] },
    givenBy:     { type: db.Types.UUID, ref: 'User', default: null },
    givenByName: { type: String, default: '' },
    remarks:   { type: String, default: '', trim: true },

    visit:    { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    incident: { type: db.Types.UUID, ref: 'MedicalIncident', default: null },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalFirstAidSchema.index({ school: 1, at: -1 });
MedicalFirstAidSchema.index({ school: 1, student: 1, at: -1 });

module.exports = db.model('MedicalFirstAid', MedicalFirstAidSchema);
