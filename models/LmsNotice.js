const db = require('../db/orm');

// "This has been told": one row per thing a notification is sent about
// (a release becoming available, a student finishing a chapter, a reminder).
// The key is claimed before sending, so a retry, a second server or a repeated
// heartbeat never notifies anyone twice.
const LmsNoticeSchema = new db.Schema({
    key:    { type: String, required: true, unique: true },
    kind:   { type: String, default: '' },
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },
}, { timestamps: true });

module.exports = db.model('LmsNotice', LmsNoticeSchema);
