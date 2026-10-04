const db = require('../db/orm');

/**
 * Everything that happened to an ID card, and the module's school-wide trail
 * (Oct 2026): issued, brought up to date, printed, downloaded, blocked,
 * activated, reported lost or damaged, replaced, cancelled, verified at the
 * desk, scanned. The card drawer's timeline is a card's rows; the dashboard's
 * activity is the school's. `card` is null for what concerns no one card — a
 * template or the settings changed.
 */
const IdCardLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    card:   { type: db.Types.UUID, ref: 'IdCard', default: null },
    holder: { type: db.Types.UUID, ref: 'User', default: null },
    kind:   { type: String, default: '' },
    action: { type: String, required: true },
    note:   { type: String, default: '' },
    by:     { type: db.Types.UUID, ref: 'User', default: null },
    byRole: { type: String, default: '' },
    meta:   { type: db.Types.JSON, default: {} },
    createdAt: { type: Date, default: Date.now },
});

IdCardLogSchema.index({ school: 1, createdAt: -1 });
IdCardLogSchema.index({ card: 1, createdAt: -1 });

module.exports = db.model('IdCardLog', IdCardLogSchema);
