const db = require('../db/orm');

// Video Learning settings: one row for the platform (key 'platform' — the
// completion threshold, the heartbeat interval, upload limits) and one per
// school (key = the school's id — its reminder and notification choices).
const LmsSettingSchema = new db.Schema({
    key:       { type: String, required: true, unique: true },
    school:    { type: db.Types.UUID, ref: 'School', default: null },
    values:    { type: db.Types.JSON, default: {} },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsSetting', LmsSettingSchema);
