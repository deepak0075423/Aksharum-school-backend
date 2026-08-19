const db = require('../db/orm');

// A short exit pass (spec §12). `qrToken` backs gate verification: the guard
// scans it and the gate endpoint resolves the pass without trusting any id the
// scanner supplies.
const HostelOutpassSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },

    outpassNumber: { type: String, default: '' },              // OP-YYMMDD-####
    outpassType: {
        type: String,
        enum: ['day', 'night', 'medical', 'emergency', 'academic', 'market', 'other'],
        default: 'day',
    },
    purpose: { type: String, required: true, trim: true },
    destination: { type: String, default: '' },
    requestedBy: { type: db.Types.UUID, ref: 'User', default: null },

    departureDate: { type: Date, required: true },
    expectedDepartureTime: { type: String, default: '' },      // "16:00"
    expectedReturnTime: { type: String, default: '' },         // "20:00"
    expectedReturnAt: { type: Date, default: null },           // resolved datetime, drives overdue
    actualDepartureAt: { type: Date, default: null },
    actualReturnAt: { type: Date, default: null },

    guardianName: { type: String, default: '' },
    guardianPhone: { type: String, default: '' },
    emergencyContact: { type: String, default: '' },
    remarks: { type: String, default: '' },
    attachments: { type: [String], default: [] },

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'cancelled', 'active', 'returned', 'overdue'],
        default: 'pending',
    },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: db.Types.UUID, ref: 'User', default: null },
    rejectionReason: { type: String, default: '' },

    // Opaque scan token — regenerated on approval, cleared on return.
    qrToken: { type: String, default: '' },
    verifiedOutBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedInBy: { type: db.Types.UUID, ref: 'User', default: null },
    lateReturnMinutes: { type: Number, default: 0 },
    overdueNotifiedAt: { type: Date, default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelOutpassSchema.index({ school: 1, status: 1, departureDate: -1 });
HostelOutpassSchema.index({ school: 1, student: 1, departureDate: -1 });
HostelOutpassSchema.index({ school: 1, hostel: 1, status: 1 });
HostelOutpassSchema.index({ qrToken: 1 });

module.exports = db.model('HostelOutpass', HostelOutpassSchema);
