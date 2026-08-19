const db = require('../db/orm');

// The rate card hostel invoices are generated from (spec §16). Kept separate
// from the academic FeeStructure because it is priced per hostel / room type and
// billed on its own cycle; the resulting charges still land in the shared
// FeeLedger, so a student's overall position stays in one place.
const HostelFeePlanSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null, index: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    name: { type: String, required: true, trim: true },
    feeType: {
        type: String,
        enum: ['admission', 'monthly', 'quarterly', 'annual', 'mess', 'laundry', 'electricity',
               'maintenance', 'security_deposit', 'other'],
        default: 'monthly',
    },
    // 'flat' bills the same amount to everyone; 'room_type' picks from the bands.
    basis: { type: String, enum: ['flat', 'room_type'], default: 'flat' },
    amount: { type: Number, default: 0 },
    roomTypeRates: { type: db.Types.JSON, default: [] },       // [{roomType, amount}]

    frequency: { type: String, enum: ['one_time', 'monthly', 'quarterly', 'half_yearly', 'annual'], default: 'monthly' },
    dueDayOfMonth: { type: Number, default: 10 },
    isRefundable: { type: Boolean, default: false },           // security deposits
    // Optional link to an existing Fees-module head, so hostel charges can be
    // reported inside the school's normal fee heads when the school wants that.
    feeHead: { type: db.Types.UUID, ref: 'FeeHead', default: null },

    description: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelFeePlanSchema.index({ school: 1, hostel: 1, feeType: 1 });
HostelFeePlanSchema.index({ school: 1, status: 1 });

module.exports = db.model('HostelFeePlan', HostelFeePlanSchema);
