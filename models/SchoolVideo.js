const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  SchoolVideo — the tenant-isolation mapping. A master video is invisible to a
//  school until the School Admin enables it here. This is what lets one physical
//  video serve thousands of schools while each school controls its own catalogue
//  and visibility. (Teacher/school-added videos are scoped by Video.school and
//  do not need a SchoolVideo row.)
// ─────────────────────────────────────────────────────────────────────────────
const SchoolVideoSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    video:  { type: db.Types.UUID, ref: 'Video', required: true, index: true },

    enabled:    { type: Boolean, default: true, index: true },
    visibility: { type: String, enum: ['school', 'class', 'section', 'hidden'], default: 'school' },
    note:       { type: String, default: '' },

    enabledBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

SchoolVideoSchema.index({ school: 1, video: 1 }, { unique: true });
SchoolVideoSchema.index({ school: 1, enabled: 1 });

module.exports = db.model('SchoolVideo', SchoolVideoSchema);
