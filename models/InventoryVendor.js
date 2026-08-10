const db = require('../db/orm');

const InventoryVendorSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },        // Company name
    gstNumber: { type: String, default: '', trim: true },
    pan: { type: String, default: '', trim: true },
    contactPerson: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
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
