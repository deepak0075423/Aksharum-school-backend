const db = require('../db/orm');

// Mess running costs (spec §15) — groceries, gas, vendor bills, salaries.
// Rolls into the hostel expense report alongside maintenance cost.
const HostelMessExpenseSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    mess: { type: db.Types.UUID, ref: 'HostelMess', required: true, index: true },

    date: { type: Date, default: Date.now },
    category: {
        type: String,
        enum: ['groceries', 'vegetables', 'dairy', 'gas', 'vendor_bill', 'salary', 'equipment', 'other'],
        default: 'groceries',
    },
    description: { type: String, default: '' },
    amount: { type: Number, required: true, default: 0 },
    vendorName: { type: String, default: '' },
    invoiceNumber: { type: String, default: '' },
    attachment: { type: String, default: '' },
    recordedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMessExpenseSchema.index({ school: 1, mess: 1, date: -1 });
HostelMessExpenseSchema.index({ school: 1, date: -1 });

module.exports = db.model('HostelMessExpense', HostelMessExpenseSchema);
