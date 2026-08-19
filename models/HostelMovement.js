const db = require('../db/orm');

// Append-only gate/movement log (spec §20). Every entry and exit lands here —
// outpass departures and returns, leave departures, plain gate scans, visitor
// and vehicle movement — so "who is inside right now" and "who is overdue" are
// answerable from one table. HostelAllocation.presence is the cached read of it.
const HostelMovementSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },

    // Exactly one of student / visitor is set (vehicle movement sets neither).
    student: { type: db.Types.UUID, ref: 'User', default: null, index: true },
    visitor: { type: db.Types.UUID, ref: 'HostelVisitor', default: null },
    personName: { type: String, default: '' },

    direction: { type: String, enum: ['in', 'out'], required: true },
    movementType: {
        type: String,
        enum: ['gate', 'outpass', 'leave', 'visitor', 'vehicle', 'medical', 'other'],
        default: 'gate',
    },
    reference: { type: db.Types.UUID, default: null },         // outpass / leave id
    referenceType: { type: String, default: '' },              // HostelOutpass | HostelLeave

    at: { type: Date, default: Date.now, required: true },
    gate: { type: String, default: '' },
    vehicleNumber: { type: String, default: '' },
    remarks: { type: String, default: '' },

    isLate: { type: Boolean, default: false },
    lateMinutes: { type: Number, default: 0 },
    recordedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMovementSchema.index({ school: 1, hostel: 1, at: -1 });
HostelMovementSchema.index({ school: 1, student: 1, at: -1 });
HostelMovementSchema.index({ school: 1, at: -1, direction: 1 });

module.exports = db.model('HostelMovement', HostelMovementSchema);
