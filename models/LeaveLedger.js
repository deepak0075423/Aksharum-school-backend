const db = require('../db/orm');

// Append-only ledger behind LeaveBalance — the audit trail for every day that
// enters or leaves an employee's balance. Same immutable-ledger shape as
// FeeLedger: rows are written, never edited (the one exception is the FIFO
// `remainingDays` counter on EARNED lots, see below).
//
// entryType and its effect on the balance:
//   EARNED     +  a comp off claim was approved (credit)
//   USED       −  an approved leave consumed days
//   EXPIRED    −  credited days lapsed unused per policy validity
//   CANCELLED  −  an already-credited earning was withdrawn
//   REVERSED   +  a consumption was undone (leave rejected/cancelled after use)
//   ADJUSTMENT ±  a manual admin correction; `delta` carries the sign
//
// `delta` is the signed effect so a running position is a plain SUM(delta);
// `days` is the unsigned magnitude for display.
const LeaveLedgerSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School',    required: true },
    teacher:      { type: db.Types.UUID, ref: 'User',      required: true },
    leaveType:    { type: db.Types.UUID, ref: 'LeaveType', required: true },
    academicYear: { type: String, required: true },

    entryType: {
        type: String,
        enum: ['EARNED', 'USED', 'EXPIRED', 'CANCELLED', 'REVERSED', 'ADJUSTMENT'],
        required: true,
    },
    days:  { type: Number, required: true },   // absolute magnitude, always ≥ 0
    delta: { type: Number, required: true },   // signed effect on the balance

    balanceAfter: { type: Number, default: 0 }, // running balance snapshot

    // ── FIFO lot tracking (EARNED rows only) ────────────────────────────────
    // Each approved comp off is a "lot" that expires on its own date. Spending
    // walks the lots oldest-expiry-first so the days closest to lapsing go out
    // of the door first; `remainingDays` is the only mutable column here.
    expiresAt:     { type: Date,   default: null },
    remainingDays: { type: Number, default: 0 },

    source: {
        type: String,
        enum: ['compoff', 'leave', 'manual', 'system'],
        default: 'leave',
    },
    referenceType: {
        type: String,
        enum: ['CompOffRequest', 'LeaveApplication', 'LeaveLedger', 'Manual', 'System'],
        default: 'Manual',
    },
    referenceId: { type: db.Types.UUID, default: null },
    description: { type: String, default: '' },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
});

LeaveLedgerSchema.index({ school: 1, teacher: 1, leaveType: 1, academicYear: 1, createdAt: -1 });
LeaveLedgerSchema.index({ school: 1, entryType: 1, createdAt: -1 });
LeaveLedgerSchema.index({ referenceType: 1, referenceId: 1 });
// FIFO lot scan + expiry sweep
LeaveLedgerSchema.index({ teacher: 1, leaveType: 1, academicYear: 1, entryType: 1, expiresAt: 1 });

module.exports = db.model('LeaveLedger', LeaveLedgerSchema);
