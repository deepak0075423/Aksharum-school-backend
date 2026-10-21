const db = require('../db/orm');

/**
 * One post office of India Post's "All India Pincode Directory" (data.gov.in,
 * Government Open Data Licence – India) — the table the PIN lookup reads first
 * (services/pincodes.js). Shared by every school; loaded and replaced as a
 * whole by scripts/importPincodes.js, never edited by hand.
 */
const PinCodeSchema = new db.Schema({
    pincode:    { type: String, required: true },
    officeName: { type: String, default: '' },
    officeType: { type: String, default: '' },
    district:   { type: String, default: '' },
    state:      { type: String, default: '' },
}, { timestamps: true });

PinCodeSchema.index({ pincode: 1 });

module.exports = db.model('PinCode', PinCodeSchema);
