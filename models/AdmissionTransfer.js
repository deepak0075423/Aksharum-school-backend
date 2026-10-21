const db = require('../db/orm');

/**
 * Moving an application to another branch of the group (Oct 2026), at the
 * family's request: the branch the family applied to offers it, the other
 * branch accepts or declines. Accepted, the answers and documents are copied
 * into a draft at the new branch for the family to check and submit; the
 * first application is withdrawn when they do.
 *
 *   status   pending | accepted | declined | cancelled | completed
 */
const AdmissionTransferSchema = new db.Schema({
    group:           { type: db.Types.UUID, ref: 'AdmissionGroup', required: true },
    fromSchool:      { type: db.Types.UUID, ref: 'School', required: true },
    fromApplication: { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    toSchool:        { type: db.Types.UUID, ref: 'School', required: true },
    toRound:         { type: db.Types.UUID, ref: 'AdmissionRound', default: null },
    toClass:         { type: db.Types.UUID, ref: 'Class', default: null },
    toApplication:   { type: db.Types.UUID, ref: 'AdmissionApplication', default: null },
    reason:          { type: String, default: '' },
    status:          { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled', 'completed'], default: 'pending' },
    answer:          { type: String, default: '' },
    requestedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    decidedBy:       { type: db.Types.UUID, ref: 'User', default: null },
    decidedAt:       { type: Date, default: null },
}, { timestamps: true });

AdmissionTransferSchema.index({ toSchool: 1, status: 1 });
AdmissionTransferSchema.index({ fromSchool: 1, status: 1 });

module.exports = db.model('AdmissionTransfer', AdmissionTransferSchema);
