const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A teacher designation plus the module access it grants.
//
//  `name` (not _id) is the join key: TeacherProfile.designation stores the name,
//  which predates this table and is compared by name across the app. Renaming a
//  designation therefore has to rewrite the matching profiles — see
//  services/designationService.rename().
//
//  `permissions` maps a module key from config/modules.js to one of:
//     'admin' — administrative privileges inside that module
//     'user'  — normal privileges
//     'none'  — no access
//  A key that is absent means 'none'. The stored map is intentionally NOT
//  pruned when the Super Admin disables a module at the school level: access is
//  denied at resolution time (School flag AND designation level), so re-enabling
//  the module restores whatever was configured here.
// ─────────────────────────────────────────────────────────────────────────────

const DesignationSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    permissions: {
        type: db.Types.JSON,
        default: {},
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

DesignationSchema.index({ school: 1, name: 1 }, { unique: true });
DesignationSchema.index({ school: 1, isActive: 1 });

module.exports = db.model('Designation', DesignationSchema);
