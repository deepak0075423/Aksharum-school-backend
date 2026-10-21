const db = require('../db/orm');

/**
 * A school's wording for one admission email — every save is a new version,
 * and the version in force is the one with `isCurrent` (partial unique index
 * in db/migrate.js). A school that never edits an event has no row for it and
 * gets the platform default (services/admission/emailCatalog.js).
 *
 * `body` is the module's own light markup (services/admission/richText.js),
 * never HTML: it is rendered on the server, with every placeholder's value
 * escaped, inside the school's branded email frame.
 */
const AdmissionEmailTemplateSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    event:     { type: String, required: true },
    version:   { type: Number, required: true },
    isCurrent: { type: Boolean, default: true },
    enabled:   { type: Boolean, default: true },
    subject:   { type: String, required: true },
    body:      { type: String, required: true },
    note:      { type: String, default: '' },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
});

AdmissionEmailTemplateSchema.index({ school: 1, event: 1, version: 1 }, { unique: true });

module.exports = db.model('AdmissionEmailTemplate', AdmissionEmailTemplateSchema);
