const db = require('../db/orm');

/**
 * The alerts the Medical Room's watchman has already announced — so a low
 * stock, an expiring batch or a due service is told to the staff ONCE, not on
 * every sweep. A row is deleted when its condition clears, so the same
 * problem coming back is announced again (services/medicalSweep).
 */
const MedicalAlertSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    kind:    { type: String, required: true },     // low_stock | expiring | expired | maintenance | document | digest
    subject: { type: String, required: true },     // the item / batch / equipment id, or a digest key
    level:   { type: String, default: 'warning' },
    meta:    { type: Object, default: {} },
    notifiedAt: { type: Date, default: Date.now },
});

MedicalAlertSchema.index({ school: 1, kind: 1, subject: 1 }, { unique: true });

module.exports = db.model('MedicalAlert', MedicalAlertSchema);
