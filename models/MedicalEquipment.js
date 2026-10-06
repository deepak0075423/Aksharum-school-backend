const db = require('../db/orm');

/**
 * A piece of medical equipment — a thermometer, a BP monitor, a stretcher, a
 * first-aid box. `log` is its history: maintenance done, status and condition
 * changes, notes — newest last, appended, never rewritten.
 */
const MedicalEquipmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name:   { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['thermometer', 'bp_monitor', 'pulse_oximeter', 'weighing_machine', 'wheelchair', 'stretcher', 'nebulizer',
               'first_aid_box', 'glucometer', 'oxygen_cylinder', 'defibrillator', 'other'],
        default: 'other',
    },
    serialNumber: { type: String, default: '', trim: true },
    quantity:     { type: Number, default: 1 },
    purchaseDate: { type: Date, default: null },
    warrantyUntil: { type: Date, default: null },
    vendor:       { type: String, default: '', trim: true },
    location:     { type: String, default: '', trim: true },
    condition:    { type: String, enum: ['good', 'fair', 'poor', 'damaged'], default: 'good' },
    status:       { type: String, enum: ['available', 'in_use', 'under_maintenance', 'out_of_service', 'retired'], default: 'available' },
    lastMaintenanceOn: { type: Date, default: null },
    nextMaintenanceOn: { type: Date, default: null },
    remarks:      { type: String, default: '', trim: true },
    log:          { type: Array, default: [] },   // [{ at, kind, note, by, byName, cost }]
    maintenanceNotifiedFor: { type: Date, default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalEquipmentSchema.index({ school: 1, status: 1 });

module.exports = db.model('MedicalEquipment', MedicalEquipmentSchema);
