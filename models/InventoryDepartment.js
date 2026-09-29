const db = require('../db/orm');

// A department that raises requests and owns purchase orders (Science Lab,
// Sports, Computer…).
//
// It used to hold a budget too — `annualBudget` and a running `usedBudget` —
// which was a SECOND budget system beside models/InventoryBudget.js. That one
// is the only one now: it is what the Budgets screen shows and what a purchase
// order is measured against, and its spend is summed from the orders rather
// than accumulated in a field that drifted. See services/inventoryBudget.js.
const InventoryDepartmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },
    financialYear: { type: String, default: '' },          // e.g. "2026-2027"
    headName: { type: String, default: '' },               // department head (label)
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryDepartmentSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryDepartment', InventoryDepartmentSchema);
