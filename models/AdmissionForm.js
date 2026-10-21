const db = require('../db/orm');

/**
 * An application form a school has designed. The form itself is only a name
 * and two pointers; what it asks lives in its versions (AdmissionFormVersion):
 *
 *   currentVersion  the latest PUBLISHED version — what new applications get
 *   draftVersion    the version being edited in the builder, if any
 *
 * A published version never changes again, so an application keeps exactly
 * the questions it was answered against (services/admission/formEngine.js).
 */
const AdmissionFormSchema = new db.Schema({
    school:         { type: db.Types.UUID, ref: 'School', required: true },
    name:           { type: String, required: true, trim: true },
    description:    { type: String, default: '' },
    isActive:       { type: Boolean, default: true },
    currentVersion: { type: db.Types.UUID, ref: 'AdmissionFormVersion', default: null },
    draftVersion:   { type: db.Types.UUID, ref: 'AdmissionFormVersion', default: null },
    createdBy:      { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:      { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionFormSchema.index({ school: 1, name: 1 });

module.exports = db.model('AdmissionForm', AdmissionFormSchema);
