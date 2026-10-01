const db = require('../db/orm');

// A room change that is waiting for a decision.
//
// Two people can ask for one: a resident (for themselves — the destination is
// left to the office), and a warden posted to a hostel when the school has
// "transfers need approval" on. The module's admins move people directly; for
// everyone else the move is a request, and this is where it waits.
const HostelTransferRequestSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },   // the resident
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', required: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },  // where they live now
    fromBed: { type: db.Types.UUID, ref: 'HostelBed', default: null },
    toBed: { type: db.Types.UUID, ref: 'HostelBed', default: null },              // null: "wherever suits"
    toHostel: { type: db.Types.UUID, ref: 'Hostel', default: null },

    requestNumber: { type: String, default: '' },
    reason: { type: String, default: '' },
    preference: { type: String, default: '' },                 // a resident's words: "ground floor", "with Rahul"
    requestedBy: { type: db.Types.UUID, ref: 'User', default: null },
    requestedByRole: { type: String, default: '' },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    decidedBy: { type: db.Types.UUID, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionRemark: { type: String, default: '' },
    newAllocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
}, { timestamps: true });

HostelTransferRequestSchema.index({ school: 1, status: 1, createdAt: -1 });
HostelTransferRequestSchema.index({ school: 1, hostel: 1, status: 1 });

module.exports = db.model('HostelTransferRequest', HostelTransferRequestSchema);
