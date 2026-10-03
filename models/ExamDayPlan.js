const db = require('../db/orm');

/**
 * One exam day's plan (Oct 2026): where every student sits and who
 * invigilates each room, for every sitting of the day (a sitting is the papers
 * that start at the same time). Made by the office from the day's papers and
 * the rooms it picks (services/resultSeating), kept as a draft until it is
 * published — then each invigilator is told their rooms, and each family sees
 * the student's seat on the exam schedule. One plan per school and day.
 *
 * `sittings` is the plan as it was made, names included, so a student who
 * changes section or a room renamed afterwards does not rewrite a printed
 * plan:
 *   [{ key, startTime, endTime,
 *      papers: [{ exam, subject, section, title, subjectName, className, sectionName, students }],
 *      rooms:  [{ room, roomName, roomNumber, building, capacity,
 *                 seats: [{ seat, student, name, rollNumber, className, sectionName, exam, subject, subjectName }],
 *                 invigilators: [{ teacher, name }] }],
 *      unseated: [{ student, name, className, sectionName, subjectName }] }]
 */
const ExamDayPlanSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    date:        { type: Date, required: true },
    sittings:    { type: db.Types.JSON, default: [] },
    // What the plan was made from: the rooms picked, and invigilators per room (0 = by size).
    rooms:       { type: db.Types.JSON, default: [] },
    perRoom:     { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: db.Types.UUID, ref: 'User', default: null },
    createdBy:   { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:   { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

ExamDayPlanSchema.index({ school: 1, date: 1 }, { unique: true });

module.exports = db.model('ExamDayPlan', ExamDayPlanSchema);
