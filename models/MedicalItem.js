const db = require('../db/orm');

/**
 * Something the Medical Room keeps in stock: a medicine, or a first-aid
 * supply (bandage, gauze, ice pack, gloves …).
 *
 * Stock is held in batches (MedicalBatch) because medicines expire batch by
 * batch; `stock` is the sum of the item's usable batches, kept by the one
 * writer in services/medicalStock in the same transaction as every movement,
 * so a list can sort and filter on it without adding batches up.
 */
const MedicalItemSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    kind:   { type: String, enum: ['medicine', 'supply'], required: true },

    name:        { type: String, required: true, trim: true, trgm: true },
    genericName: { type: String, default: '', trim: true },
    category:    { type: String, default: '', trim: true },
    form:        { type: String, default: '', trim: true },     // Tablet, Syrup, Inhaler, Roll, Pack …
    strength:    { type: String, default: '', trim: true },     // 500 mg, 5 ml
    unit:        { type: String, default: 'unit', trim: true }, // what one counts it in
    supplier:        { type: String, default: '', trim: true },
    storageLocation: { type: String, default: '', trim: true },
    minStock:  { type: Number, default: 0 },
    // A medicine given only against a medication plan or a doctor's note.
    prescriptionOnly: { type: Boolean, default: false },
    // A controlled medicine: every dose is witnessed by a second member of staff, and the stock is counted.
    controlled: { type: Boolean, default: false },
    // How often it may be given — checked at every dose (services/medicalSafety).
    // null: the medicine's known class decides (paracetamol 4 h, 4 a day …), or nothing.
    minHoursBetween: { type: Number, default: null },
    maxPerDay:       { type: Number, default: null },   // in any 24 hours
    stock:     { type: Number, default: 0 },
    remarks:   { type: String, default: '', trim: true },
    // The packs' barcodes (EAN/UPC as printed), so the phone can scan a pack to find the item.
    barcodes:  { type: [String], default: [] },
    isActive:  { type: Boolean, default: true },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

MedicalItemSchema.index({ school: 1, kind: 1, name: 1 });

module.exports = db.model('MedicalItem', MedicalItemSchema);
