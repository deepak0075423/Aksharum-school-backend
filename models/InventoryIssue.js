const db = require('../db/orm');

// One return event against an issue (spec §15). Returns were originally folded
// into the issue row — a single `returnedQty` / `returnedAt` / `returnCondition`
// — which meant two partial returns overwrote each other's date and condition,
// and the Issue/Return screen had no way to list a return as a row of its own.
// Each event is now recorded, with its own transaction number.
const ReturnSchema = new db.Schema({
    returnNumber: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 1 },
    condition: { type: String, enum: ['good', 'used', 'partially_used', 'damaged', 'lost', 'repair_needed'], default: 'good' },
    restocked: { type: Boolean, default: true },
    returnedAt: { type: Date, default: Date.now },
    receivedBy: { type: db.Types.UUID, ref: 'User', default: null },
    note: { type: String, default: '' },
}, { _id: true });

// Issue / return of stock to a person or department (spec §14 & §15).
const InventoryIssueSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    issueNumber: { type: String, required: true },
    item: { type: db.Types.UUID, ref: 'InventoryItem', required: true },
    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', required: true },
    quantity: { type: Number, required: true, min: 1 },

    // Who received it — either a user or a free-text recipient / department.
    issuedToUser: { type: db.Types.UUID, ref: 'User', default: null },
    issuedToName: { type: String, default: '' },
    // What kind of recipient that is. The screen groups by it ("All users" /
    // students / staff / a whole class), and a class group has no user row at
    // all, so it cannot be read off `issuedToUser`.
    recipientType: { type: String, enum: ['student', 'teacher', 'staff', 'department', 'class'], default: 'staff' },
    // The section a class-group issue went to, for the Department/Class column.
    classLabel: { type: String, default: '' },
    department: { type: db.Types.UUID, ref: 'InventoryDepartment', default: null },

    issueDate: { type: Date, default: Date.now },
    expectedReturn: { type: Date, default: null },
    conditionOut: { type: String, default: 'Good' },
    signature: { type: String, default: '' },
    note: { type: String, default: '' },
    // A consumable (chalk, paper) is issued and never comes back; the screen
    // must not count it as a pending return forever.
    returnable: { type: Boolean, default: true },

    // Return tracking. `returns` is the record; the three fields beside it are
    // a roll-up kept in step by the one writer in the controller.
    returns: [ReturnSchema],
    returnedQty: { type: Number, default: 0 },
    returnedAt: { type: Date, default: null },
    returnCondition: { type: String, enum: ['', 'good', 'used', 'partially_used', 'damaged', 'lost', 'repair_needed'], default: '' },

    // issued → partially_returned → returned. "Overdue" is derived: still
    // outstanding with an expectedReturn in the past.
    status: { type: String, enum: ['issued', 'partially_returned', 'returned'], default: 'issued' },
    issuedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryIssueSchema.index({ school: 1, createdAt: -1 });
InventoryIssueSchema.index({ school: 1, issueNumber: 1 }, { unique: true });
InventoryIssueSchema.index({ school: 1, status: 1 });
InventoryIssueSchema.index({ school: 1, item: 1 });

module.exports = db.model('InventoryIssue', InventoryIssueSchema);
