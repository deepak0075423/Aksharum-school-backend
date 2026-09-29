const db = require('../db/orm');

const InventoryVendorSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },        // Company name
    // What this vendor supplies — the badge on the vendor row, and the filter
    // above it. Free text so a school is not boxed into our list.
    vendorCategory: { type: String, default: '', trim: true },
    tagline: { type: String, default: '' },                    // "Stationery & Office Supplies"
    // The list of things this vendor actually sells, in their own words. Not
    // the same as `vendorCategory`, which is the ONE word the vendor row is
    // badged with, nor the tagline, which is how they describe themselves.
    supplies: { type: String, default: '' },
    logo: { type: String, default: '' },
    gstNumber: { type: String, default: '', trim: true },
    pan: { type: String, default: '', trim: true },
    contactPerson: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },
    phone: { type: String, default: '' },
    website: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '', trim: true },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    paymentTerms: { type: String, default: '' },               // "30 Days", "Advance"…
    // A shortlisted supplier. Reported as its own figure on the vendor screen,
    // so it is a flag the school sets, not a rating threshold we invent.
    preferred: { type: Boolean, default: false },
    bankDetails: {
        accountName: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        ifsc: { type: String, default: '' },
        bankName: { type: String, default: '' },
    },
    // Performance metrics — recomputed by the system as orders are delivered.
    performance: {
        totalOrders: { type: Number, default: 0 },
        onTimeDeliveries: { type: Number, default: 0 },
        delayedDeliveries: { type: Number, default: 0 },
        rejectedDeliveries: { type: Number, default: 0 },
        avgDeliveryDays: { type: Number, default: 0 },
        rating: { type: Number, default: 0, min: 0, max: 5 }, // 0–5 stars
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

InventoryVendorSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('InventoryVendor', InventoryVendorSchema);
