const db = require('../db/orm');

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
    department: { type: db.Types.UUID, ref: 'InventoryDepartment', default: null },

    issueDate: { type: Date, default: Date.now },
    expectedReturn: { type: Date, default: null },
    conditionOut: { type: String, default: 'Good' },
    signature: { type: String, default: '' },
    note: { type: String, default: '' },

    // Return tracking.
    returnedQty: { type: Number, default: 0 },
    returnedAt: { type: Date, default: null },
    returnCondition: { type: String, enum: ['', 'good', 'damaged', 'lost', 'repair_needed'], default: '' },

    // issued → returned (fully) | partially_returned | overdue is derived
    status: { type: String, enum: ['issued', 'partially_returned', 'returned'], default: 'issued' },
    issuedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryIssueSchema.index({ school: 1, createdAt: -1 });
InventoryIssueSchema.index({ school: 1, issueNumber: 1 }, { unique: true });
InventoryIssueSchema.index({ school: 1, status: 1 });
InventoryIssueSchema.index({ school: 1, item: 1 });

module.exports = db.model('InventoryIssue', InventoryIssueSchema);
