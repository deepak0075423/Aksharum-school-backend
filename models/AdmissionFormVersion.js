const db = require('../db/orm');

/**
 * One version of an application form.
 *
 * `schema` is { sections: [{ key, title, description, fields: [...] }] } —
 * validated by services/admission/formEngine.validateSchema before it can be
 * saved, and frozen once `status` is 'published'. A draft is edited in place;
 * publishing stamps it and the next edit starts a new draft from a copy.
 */
const AdmissionFormVersionSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    form:        { type: db.Types.UUID, ref: 'AdmissionForm', required: true },
    version:     { type: Number, required: true },
    status:      { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    schema:      { type: db.Types.JSON, default: () => ({ sections: [] }) },
    changeNote:  { type: String, default: '' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:   { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionFormVersionSchema.index({ form: 1, version: 1 }, { unique: true });

module.exports = db.model('AdmissionFormVersion', AdmissionFormVersionSchema);
