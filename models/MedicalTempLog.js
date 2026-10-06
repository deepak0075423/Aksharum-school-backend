const db = require('../db/orm');

/**
 * The medicine fridge's temperature (Oct 2026): vaccines and insulin keep
 * between 2 °C and 8 °C. One reading a school day at least (with the min/max
 * thermometer's readings since the last reset); a reading out of range tells
 * the medical staff at once and says what to check.
 */
const MedicalTempLogSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    location: { type: db.Types.UUID, ref: 'MedicalLocation', default: null },
    fridge:   { type: String, default: 'Medicine fridge' },
    at:       { type: Date, default: Date.now },
    current:  { type: Number, required: true },        // °C
    min:      { type: Number, default: null },
    max:      { type: Number, default: null },
    reset:    { type: Boolean, default: false },       // the min/max was reset after reading
    outOfRange: { type: Boolean, default: false },
    action:   { type: String, default: '' },           // what was done about it
    by:       { type: db.Types.UUID, ref: 'User', default: null },
    byName:   { type: String, default: '' },
}, { timestamps: true });

MedicalTempLogSchema.index({ school: 1, at: -1 });

module.exports = db.model('MedicalTempLog', MedicalTempLogSchema);
