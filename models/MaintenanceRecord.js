const db = require('../db/orm');

const PartSchema = new db.Schema({
    name: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    cost: { type: Number, default: 0 },
}, { _id: false });

// A preventive or corrective maintenance job on a vehicle (spec §16).
// nextDueDate/nextDueOdometer + reminderSent drive the automatic reminders.
const MaintenanceRecordSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', required: true, index: true },

    maintenanceType: { type: String, enum: ['preventive', 'corrective', 'scheduled'], default: 'preventive' },
    category: {
        type: String,
        enum: ['oil_change', 'tyres', 'battery', 'brakes', 'engine', 'ac', 'body', 'service', 'other'],
        default: 'service',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    scheduledDate: { type: Date, default: null },
    completedDate: { type: Date, default: null },
    status: { type: String, enum: ['scheduled', 'in_progress', 'completed', 'cancelled'], default: 'scheduled' },

    odometer: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    labourCost: { type: Number, default: 0 },
    parts: [PartSchema],
    vendor: { type: String, default: '' },
    invoice: { type: String, default: '' },

    nextDueDate: { type: Date, default: null },
    nextDueOdometer: { type: Number, default: null },
    reminderSent: { type: Boolean, default: false },

    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

MaintenanceRecordSchema.index({ school: 1, vehicle: 1, status: 1 });
MaintenanceRecordSchema.index({ school: 1, nextDueDate: 1 });

module.exports = db.model('MaintenanceRecord', MaintenanceRecordSchema);
