const db = require('../db/orm');

/**
 * A bed or rest area in the Medical Room. Occupancy is the visit lying on it
 * (`visit`, since `since`); the visit carries the check-in and check-out times
 * (bedIn / bedOut), so a bed's history is the visits that named it.
 */
const MedicalBedSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    location: { type: db.Types.UUID, ref: 'MedicalLocation', default: null },   // which room (null = the main one)
    label:  { type: String, required: true, trim: true },          // Bed 1, Rest area A
    kind:   { type: String, enum: ['bed', 'rest_area', 'isolation'], default: 'bed' },
    status: { type: String, enum: ['available', 'occupied', 'cleaning', 'out_of_service'], default: 'available' },
    visit:  { type: db.Types.UUID, ref: 'MedicalVisit', default: null },
    since:  { type: Date, default: null },
    note:   { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive:  { type: Boolean, default: true },
}, { timestamps: true });

MedicalBedSchema.index({ school: 1, sortOrder: 1 });

module.exports = db.model('MedicalBed', MedicalBedSchema);
