'use strict';
/**
 * The rules a hand-edited timetable has to obey.
 *
 * The generator has had a full constraint engine since day one; the manual grid
 * had a single teacher-clash check whose result was reported and then ignored —
 * it saved regardless. This is the same rule set the solver enforces, expressed
 * against rows the grid is about to write, so both editing paths agree on what
 * a legal timetable is.
 *
 * Three severities, because "can I override this?" has three answers:
 *
 *   fatal    the grid cannot physically hold it — two subjects in one slot, a
 *            period that does not exist. `force` does not apply; the unique
 *            index would reject the write anyway.
 *   error    a real clash with another section. Blocks by default, but a head
 *            teacher may genuinely know better, so `force` overrides it.
 *   warning  reported and saved — worth knowing, not broken.
 */

const Timetable            = require('../models/Timetable');
const TimetableEntry       = require('../models/TimetableEntry');
const ClassSection         = require('../models/ClassSection');
const Subject              = require('../models/Subject');
const User                 = require('../models/User');
const Room                 = require('../models/Room');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

const sid = (v) => (v == null ? null : String(v._id ?? v));
const slot = (e) => `${e.dayOfWeek}#${e.periodNumber}`;

/**
 * @param {object}   opts.timetable  the Timetable being written (for its structure)
 * @param {Array}    opts.rows       the entries about to be inserted
 * @returns {Promise<Array>} [{ code, severity, dayOfWeek, periodNumber, message }]
 */
async function validateManualEntries({ schoolId, timetable, sectionId, rows }) {
    const problems = [];
    const add = (severity, code, e, message) => problems.push({
        code, severity, dayOfWeek: e?.dayOfWeek || '', periodNumber: e?.periodNumber ?? null, message,
    });

    if (!rows.length) return problems;

    /* ── 1. The grid itself: one subject per slot, and slots that exist ──── */
    const teaching = new Set(
        (timetable.periodsStructure || [])
            .filter((p) => !p.isRecess && (p.periodType || 'Teaching') === 'Teaching')
            .map((p) => Number(p.periodNumber)),
    );
    const seen = new Map();
    for (const e of rows) {
        if (seen.has(slot(e))) {
            add('fatal', 'DUPLICATE_SLOT', e, `Two subjects are placed at ${e.dayOfWeek} P${e.periodNumber}`);
        }
        seen.set(slot(e), e);
        // An empty structure means the section never saved one — don't invent rules for it.
        if (teaching.size && !teaching.has(Number(e.periodNumber))) {
            add('fatal', 'NOT_A_TEACHING_PERIOD', e,
                `P${e.periodNumber} is not a teaching period in this section's structure`);
        }
    }

    /* ── 2. Names, for messages worth reading ───────────────────────────── */
    const teacherIds = [...new Set(rows.map((e) => sid(e.teacher)).filter(Boolean))];
    const subjectIds = [...new Set(rows.map((e) => sid(e.subject)).filter(Boolean))];
    const roomIds    = [...new Set(rows.map((e) => sid(e.room)).filter(Boolean))];
    const [teachers, subjects, rooms, assigned] = await Promise.all([
        User.find({ _id: { $in: teacherIds } }).select('name isActive').lean(),
        Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean(),
        Room.find({ _id: { $in: roomIds } }).select('roomName').lean(),
        SectionSubjectTeacher.find({ section: sectionId }).select('subject teacher').lean(),
    ]);
    const teacherName = new Map(teachers.map((t) => [sid(t._id), t.name]));
    const subjectName = new Map(subjects.map((x) => [sid(x._id), x.subjectName]));
    const roomName    = new Map(rooms.map((r) => [sid(r._id), r.roomName]));
    const nameOfT = (id) => teacherName.get(sid(id)) || 'That teacher';
    const nameOfS = (id) => subjectName.get(sid(id)) || 'That subject';

    /* ── 3. Is the teacher even meant to teach this here? ───────────────── */
    const assignedPairs = new Set(assigned.map((a) => `${sid(a.teacher)}#${sid(a.subject)}`));
    const inactive = new Set(teachers.filter((t) => t.isActive === false).map((t) => sid(t._id)));
    for (const e of rows) {
        if (!e.teacher) continue;
        if (inactive.has(sid(e.teacher))) {
            add('error', 'TEACHER_INACTIVE', e, `${nameOfT(e.teacher)} is deactivated`);
            continue;
        }
        if (assignedPairs.size && !assignedPairs.has(`${sid(e.teacher)}#${sid(e.subject)}`)) {
            add('warning', 'TEACHER_NOT_ASSIGNED', e,
                `${nameOfT(e.teacher)} is not the assigned ${nameOfS(e.subject)} teacher for this section`);
        }
    }

    /* ── 4. Clashes with every other section in the same year ───────────── */
    const siblings = await Timetable.find({
        _id: { $ne: timetable._id }, academicYear: timetable.academicYear,
    }).select('_id section').lean();

    if (siblings.length && (teacherIds.length || roomIds.length)) {
        const sectionOf = new Map(siblings.map((t) => [sid(t._id), sid(t.section)]));
        const sectionRows = await ClassSection.find({ _id: { $in: [...sectionOf.values()] } })
            .select('sectionName class').lean();
        const labelOf = new Map(sectionRows.map((x) => [sid(x._id), x.sectionName]));

        const busy = await TimetableEntry.find({
            timetable: { $in: siblings.map((t) => t._id) },
            $or: [
                ...(teacherIds.length ? [{ teacher: { $in: teacherIds } }] : []),
                ...(roomIds.length    ? [{ room:    { $in: roomIds } }]    : []),
            ],
        }).select('timetable dayOfWeek periodNumber teacher room mergedSections').lean();

        const mySection = String(sectionId);
        for (const e of rows) {
            for (const b of busy) {
                if (b.dayOfWeek !== e.dayOfWeek || Number(b.periodNumber) !== Number(e.periodNumber)) continue;
                const otherSection = sectionOf.get(sid(b.timetable));
                const label = labelOf.get(otherSection) || 'another section';
                // A merged lesson IS the same lesson in both sections — the
                // teacher and room being "busy" there is the point, not a clash.
                const sharedLesson = (b.mergedSections || []).map(sid).includes(mySection)
                    || (e.mergedSections || []).map(sid).includes(otherSection);
                if (sharedLesson) continue;

                if (e.teacher && sid(b.teacher) === sid(e.teacher)) {
                    add('error', 'TEACHER_CLASH', e,
                        `${nameOfT(e.teacher)} is already teaching ${label} at ${e.dayOfWeek} P${e.periodNumber}`);
                }
                if (e.room && sid(b.room) === sid(e.room)) {
                    add('error', 'ROOM_CLASH', e,
                        `${roomName.get(sid(e.room)) || 'That room'} is already booked by ${label} at ${e.dayOfWeek} P${e.periodNumber}`);
                }
            }
        }
    }

    return problems;
}

module.exports = { validateManualEntries };
