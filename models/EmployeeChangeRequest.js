const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  "Please correct my details" — an employee asking the office to change
//  something on their own staff record (Employee Directory, Nov 2026).
//
//  Staff cannot edit their record themselves: the office keeps it. This is the
//  note that reaches the office, and the answer that comes back.
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_AREAS = ['personal', 'contact', 'government_id', 'education', 'employment', 'bank', 'other'];
const CHANGE_STATUSES = ['open', 'done', 'declined'];

const EmployeeChangeRequestSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    employee: { type: db.Types.UUID, ref: 'User', required: true },
    area:     { type: String, enum: CHANGE_AREAS, default: 'other' },
    message:  { type: String, required: true, trim: true },
    status:   { type: String, enum: CHANGE_STATUSES, default: 'open' },
    // What the office did about it, shown to the employee.
    reply:    { type: String, default: '', trim: true },
    closedBy: { type: db.Types.UUID, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
}, { timestamps: true });

EmployeeChangeRequestSchema.index({ school: 1, status: 1 });
EmployeeChangeRequestSchema.index({ employee: 1, createdAt: -1 });

module.exports = db.model('EmployeeChangeRequest', EmployeeChangeRequestSchema);
module.exports.CHANGE_AREAS = CHANGE_AREAS;
module.exports.CHANGE_STATUSES = CHANGE_STATUSES;
