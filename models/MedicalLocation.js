const db = require('../db/orm');

/**
 * Where medical stock is kept (Oct 2026): the Medical Room (more than one in a
 * big school), a first-aid kit, the bus kit, the hostel cabinet, the lab, the
 * sports bag. Every batch is at one place (`MedicalBatch.location`, null =
 * the main room), so the room gives from its own shelf and a kit's contents
 * and expiry dates are watched. Moving stock between places is a transfer —
 * the school's total does not change.
 */
const MedicalLocationSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name:   { type: String, required: true, trim: true },
    kind:   { type: String, enum: ['room', 'kit', 'bus', 'hostel', 'lab', 'sports', 'other'], default: 'kit' },
    isMain: { type: Boolean, default: false },        // the main Medical Room: where a batch with no place is
    place:  { type: String, default: '', trim: true }, // "Bus 4", "Chemistry lab, 2nd floor"
    keeper: { type: String, default: '', trim: true }, // who looks after it
    note:   { type: String, default: '' },
    lastCheckedAt:   { type: Date, default: null },
    lastCheckedName: { type: String, default: '' },
    isActive:  { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

MedicalLocationSchema.index({ school: 1, isActive: 1, sortOrder: 1 });

module.exports = db.model('MedicalLocation', MedicalLocationSchema);
