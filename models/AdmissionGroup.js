const db = require('../db/orm');

/**
 * Schools of one group — branches of one trust or chain — that families can
 * see together on one page, app.aksharum.com/g/<slug> (Oct 2026). Set up by
 * the platform (super admin); each school decides whether it is listed.
 *
 *   members      [{ school, listed }] — `listed`: shown on the group page (the school's choice)
 *   shareStatus  branches may see the status of the same family's applications
 *                at each other — to co-ordinate seats; families are told so on the
 *                group page and in each branch's privacy notice
 */
const AdmissionGroupSchema = new db.Schema({
    name:        { type: String, required: true, trim: true },
    slug:        { type: String, required: true, trim: true, lowercase: true, unique: true },
    intro:       { type: String, default: '' },
    theme:       { type: db.Types.JSON, default: () => ({ primary: '#4f46e5' }) },
    members:     { type: db.Types.JSON, default: () => [] },
    shareStatus: { type: Boolean, default: false },
    isActive:    { type: Boolean, default: true },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('AdmissionGroup', AdmissionGroupSchema);
