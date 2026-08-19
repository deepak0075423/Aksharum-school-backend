const db = require('../db/orm');

// A mess / dining facility (spec §15). One mess can serve several hostels.
const HostelMessSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostels: { type: [db.Types.UUID], ref: 'Hostel', default: [] },

    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },        // auto MS-####
    messType: { type: String, enum: ['veg', 'non_veg', 'both'], default: 'both' },
    capacity: { type: Number, default: 0 },
    location: { type: String, default: '' },
    inCharge: { type: db.Types.UUID, ref: 'User', default: null },

    // Meal windows — drives the meal-attendance screen and the menu editor.
    mealTimings: {
        breakfast: { start: { type: String, default: '07:30' }, end: { type: String, default: '09:00' }, enabled: { type: Boolean, default: true } },
        lunch:     { start: { type: String, default: '12:30' }, end: { type: String, default: '14:00' }, enabled: { type: Boolean, default: true } },
        snacks:    { start: { type: String, default: '16:30' }, end: { type: String, default: '17:30' }, enabled: { type: Boolean, default: true } },
        dinner:    { start: { type: String, default: '19:30' }, end: { type: String, default: '21:00' }, enabled: { type: Boolean, default: true } },
    },

    // Vendor (spec §15) — a catering contract, not a purchasing vendor, so it is
    // held here rather than in InventoryVendor which models procurement.
    vendorName: { type: String, default: '' },
    vendorContact: { type: String, default: '' },
    vendorEmail: { type: String, default: '' },
    contractFrom: { type: Date, default: null },
    contractTo: { type: Date, default: null },
    contractAmount: { type: Number, default: 0 },

    holidays: { type: db.Types.JSON, default: [] },            // [{date, reason}]
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMessSchema.index({ school: 1, code: 1 }, { unique: true });
HostelMessSchema.index({ school: 1, status: 1 });

module.exports = db.model('HostelMess', HostelMessSchema);
