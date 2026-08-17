const db = require('../db/orm');

const LeaveTypeSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    // What kind of leave this is. 'compoff' switches the type over to the
    // Comp Off engine: its balance is credited only by an approved
    // CompOffRequest, never by allocation or accrual.
    category: {
        type: String,
        enum: ['general', 'compoff'],
        default: 'general',
    },
    annualAllocation: { type: Number, required: true, default: 0 },
    monthlyAccrual: {
        enabled: { type: Boolean, default: false },
        daysPerMonth: { type: Number, default: 0 },
    },
    carryForward: {
        enabled: { type: Boolean, default: false },
        maxDays: { type: Number, default: 0 },
    },
    encashable:         { type: Boolean, default: false },
    maxEncashableDays:  { type: Number,  default: 0 },    // 0 = no limit
    maxConsecutiveDays: { type: Number, default: 0 }, // 0 = no limit
    requiresDocument: { type: Boolean, default: false },
    // 0 = document always required; N > 0 = required only when leave exceeds N days
    documentRequiredAfterDays: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

LeaveTypeSchema.index({ school: 1, code: 1 }, { unique: true });
LeaveTypeSchema.index({ school: 1, isActive: 1 });

module.exports = db.model('LeaveType', LeaveTypeSchema);
