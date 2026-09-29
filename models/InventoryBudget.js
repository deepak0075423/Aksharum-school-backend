const db = require('../db/orm');

/**
 * A named pot of money for inventory spending (Sep 2026 redesign, Budgets).
 *
 * `InventoryDepartment.annualBudget` was one number per department per year,
 * which could not express what the school actually runs: a Science Lab budget
 * and a Lab Consumables budget under the same department, each with its own
 * period and its own owner. A budget is therefore its own row, scoped to a
 * department, a category, or both.
 *
 * `spent` is NOT stored. It is summed from the purchase orders that fall inside
 * the budget's scope and period, so it cannot drift away from them the way
 * `usedBudget` did — see `budgetSpend()` in controllers/inventoryAdmin.
 */
const InventoryBudgetSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: '', trim: true },          // BUD-SCI-2026
    // department | category | both — which POs this budget pays for.
    scope: { type: String, enum: ['department', 'category', 'both'], default: 'department' },
    department: { type: db.Types.UUID, ref: 'InventoryDepartment', default: null },
    category: { type: db.Types.UUID, ref: 'InventoryCategory', default: null },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    allocated: { type: Number, default: 0 },

    description: { type: String, default: '' },
    icon: { type: String, default: 'wallet' },
    owner: { type: db.Types.UUID, ref: 'User', default: null },
    // Warn the school before the pot is empty rather than after.
    alertAt: { type: Number, default: 90 },                   // % of allocation
    // active | closed. "Over Budget" is not stored — it is what spend over
    // allocation means, and storing it would be a second copy of the sum.
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryBudgetSchema.index({ school: 1, name: 1, academicYear: 1 }, { unique: true });
InventoryBudgetSchema.index({ school: 1, department: 1 });
InventoryBudgetSchema.index({ school: 1, category: 1 });

module.exports = db.model('InventoryBudget', InventoryBudgetSchema);
