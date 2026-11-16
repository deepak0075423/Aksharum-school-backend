const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  The school's list of departments (Employee Directory, Nov 2026).
//
//  Until this table a department existed only as the text typed on somebody's
//  record: it could not be added before it had a member, a typo made a second
//  department, and renaming one meant editing every person in it.
//
//  The person's department is still the NAME on TeacherProfile.department — so
//  every screen that reads it keeps working — and this row is what that name
//  refers to. Names are matched without regard to case; renaming a department
//  here rewrites the name on its members (controllers/employeeDirectory).
// ─────────────────────────────────────────────────────────────────────────────

const EmployeeDepartmentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name:   { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    // Who heads it. Shown beside the department; not a permission.
    head:   { type: db.Types.UUID, ref: 'User', default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

EmployeeDepartmentSchema.index({ school: 1, name: 1 });

module.exports = db.model('EmployeeDepartment', EmployeeDepartmentSchema);
