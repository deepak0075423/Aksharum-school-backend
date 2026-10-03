const db = require('../db/orm');

/**
 * Who takes an elective subject in a section (Oct 2026).
 *
 * A section sits every subject of an exam unless a roster here says otherwise:
 * with one for (section, subject), only the students on it take that subject —
 * the others are not on its marks sheet, not "absent", and the subject is not
 * in their result. Before this a student who studies French was marked absent
 * in Sanskrit to let the sheet be submitted, and failed the exam for it.
 */
const ElectiveRosterSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    section:  { type: db.Types.UUID, ref: 'ClassSection', required: true },
    subject:  { type: db.Types.UUID, ref: 'Subject', required: true },
    students: { type: [db.Types.UUID], default: [] },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

ElectiveRosterSchema.index({ section: 1, subject: 1 }, { unique: true });
ElectiveRosterSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = db.model('ElectiveRoster', ElectiveRosterSchema);
