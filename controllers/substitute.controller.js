'use strict';
/**
 * Substitute Subject Teacher — HTTP surface.
 *
 * Admin side  (/api/admin/substitutions)  the day board, candidate lists with
 *   workload, assign / change / cancel, the fully-manual "pick a teacher and
 *   cover their periods" flow, workload reporting and settings.
 * Teacher side (/api/teacher/substitutions)  the duties I have been given and
 *   the classes of mine someone else is covering.
 *
 * All the thinking lives in services/substituteService — this file is request
 * parsing, authorisation scope and response shape.
 */
const SubstituteAssignment = require('../models/SubstituteAssignment');
const TimetableEntry       = require('../models/TimetableEntry');
const User                 = require('../models/User');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const Subject              = require('../models/Subject');
const TeacherProfile       = require('../models/TeacherProfile');
const TimetableConfig      = require('../models/TimetableConfig');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const sub                  = require('../services/substituteService');

const ok  = (res, d, s = 200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

// A missing / unparseable ?date= means today, which is what the board opens on.
function parseDate(raw) {
    if (!raw) return new Date();
    const d = new Date(String(raw).length <= 10 ? `${raw}T00:00:00.000Z` : raw);
    return Number.isNaN(d.getTime()) ? new Date() : d;
}

// Range bounds are compared against stored dates, which are always UTC midnight.
const dayOf = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

// Every write re-reads the row inside the caller's school, so an id from
// another school is a 404 rather than a cross-tenant edit.
async function loadRow(id, schoolId) {
    return SubstituteAssignment.findOne({ _id: id, school: schoolId }).lean();
}

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — the day board
══════════════════════════════════════════════════════════════════════════ */

exports.getBoard = async (req, res) => {
    try {
        ok(res, await sub.getBoard(req.schoolId, parseDate(req.query.date)));
    } catch (e) { err(res, e); }
};

/**
 * Run detection + auto-assign for a day on demand. `force` ignores the
 * autoAssign switch, which is what the board's "Fill uncovered periods" button
 * uses so an admin can auto-fill even in a school that runs manually.
 */
exports.runAutoAssign = async (req, res) => {
    try {
        const date = parseDate(req.query.date || req.body.date);
        const result = await sub.runAutoAssign(req.schoolId, date, {
            force: req.body.force === true || req.query.force === 'true',
        });
        ok(res, { ...result, board: await sub.getBoard(req.schoolId, date) });
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — candidates & workload
══════════════════════════════════════════════════════════════════════════ */

/**
 * Ranked eligible substitutes for one requirement, each carrying the six
 * workload counts the admin needs to judge fairness (spec §5).
 *
 * `ineligibleCount` is deliberately returned: "3 candidates" reads very
 * differently when the admin can see that 24 other teachers were filtered out.
 */
exports.getCandidates = async (req, res) => {
    try {
        const row = await loadRow(req.params.id, req.schoolId);
        if (!row) return err(res, 'Substitution not found', 404);

        const ctx = await sub.buildContext(req.schoolId, row.date);
        const [absences, busySlots] = await Promise.all([
            sub.detectAbsences(ctx),
            sub.busySubstituteSlots(ctx),
        ]);
        const workloads = await sub.computeWorkloads(ctx, ctx.teachers.map((t) => t._id));
        const ranked = sub.candidatesFor(ctx, row, { absences, workloads, busySlots });

        ok(res, {
            assignment: sub.decorate(ctx, row),
            candidates: ranked,
            ineligibleCount: Math.max(0, ctx.teachers.length - 1 - ranked.length),
            settings: {
                requireSubjectMatch:    ctx.settings.requireSubjectMatch,
                maxSubstitutionsPerDay: ctx.settings.maxSubstitutionsPerDay,
            },
        });
    } catch (e) { err(res, e); }
};

/**
 * The six counts for one or more teachers on a date — normal load and
 * substitute load kept separate, daily / weekly / monthly (spec §5, §8).
 */
exports.getWorkload = async (req, res) => {
    try {
        const ctx = await sub.buildContext(req.schoolId, parseDate(req.query.date));
        const ids = req.query.teacherIds
            ? String(req.query.teacherIds).split(',').map((s) => s.trim()).filter(Boolean)
            : ctx.teachers.map((t) => t._id);

        const workloads = await sub.computeWorkloads(ctx, ids);
        ok(res, {
            date: sub.isoOf(ctx.date),
            dayOfWeek: ctx.dayOfWeek,
            teachers: [...workloads.entries()].map(([tid, w]) => ({
                teacher: { _id: tid, name: sub.teacherName(ctx, tid) },
                ...w,
            })).sort((a, b) => String(a.teacher.name).localeCompare(String(b.teacher.name))),
        });
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — assign / change / cancel
══════════════════════════════════════════════════════════════════════════ */

exports.assign = async (req, res) => {
    try {
        const row = await loadRow(req.params.id, req.schoolId);
        if (!row) return err(res, 'Substitution not found', 404);
        if (row.status === 'cancelled') return err(res, 'This substitution has been cancelled', 400);

        const teacherId = req.body.substituteTeacherId;
        if (!teacherId) return err(res, 'substituteTeacherId is required', 400);

        const teacher = await User.findOne({
            _id: teacherId, school: req.schoolId, role: 'teacher', isActive: true,
        }).select('name').lean();
        if (!teacher) return err(res, 'Teacher not found', 404);
        if (sub.sid(teacher._id) === sub.sid(row.originalTeacher)) {
            return err(res, 'A teacher cannot substitute for themselves', 400);
        }

        const ctx = await sub.buildContext(req.schoolId, row.date);

        // An admin may knowingly overrule the eligibility rules (a period must
        // be covered by someone), but never silently: without ?force the clash
        // comes back as an error naming the reason.
        if (req.body.force !== true) {
            const [absences, busySlots] = await Promise.all([
                sub.detectAbsences(ctx),
                sub.busySubstituteSlots(ctx),
            ]);
            const workloads = await sub.computeWorkloads(ctx, [teacherId]);
            const eligible = sub.candidatesFor(ctx, row, { absences, workloads, busySlots })
                .some((c) => sub.sid(c.teacher._id) === sub.sid(teacherId));
            if (!eligible) {
                return err(res, `${teacher.name} is not available for this period. `
                    + 'Re-send with force to assign anyway.', 409);
            }
        }

        const updated = await sub.assignSubstitute(ctx, row, {
            substituteTeacherId: teacherId,
            actor: req.userId,
            actorName: req.user && req.user.name,
            via: 'manual',
            remarks: req.body.remarks,
        });
        ok(res, sub.decorate(ctx, updated));
    } catch (e) { err(res, e); }
};

exports.cancel = async (req, res) => {
    try {
        const row = await loadRow(req.params.id, req.schoolId);
        if (!row) return err(res, 'Substitution not found', 404);
        if (row.status === 'cancelled') return err(res, 'Already cancelled', 400);

        const ctx = await sub.buildContext(req.schoolId, row.date);
        await sub.cancelAssignment(ctx, row, {
            actor: req.userId,
            actorName: req.user && req.user.name,
            note: (req.body && req.body.note) || '',
        });
        ok(res, { cancelled: true });
    } catch (e) { err(res, e); }
};

/** Edit the instructions carried into the substitute's notification. */
exports.updateRemarks = async (req, res) => {
    try {
        const row = await loadRow(req.params.id, req.schoolId);
        if (!row) return err(res, 'Substitution not found', 404);

        await SubstituteAssignment.findByIdAndUpdate(row._id, {
            $set: { remarks: String(req.body.remarks || '').trim() },
        });
        const ctx = await sub.buildContext(req.schoolId, row.date);
        const fresh = await loadRow(req.params.id, req.schoolId);
        ok(res, sub.decorate(ctx, fresh));
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — fully manual flow (spec §4)
══════════════════════════════════════════════════════════════════════════ */

/**
 * A chosen teacher's periods for a date, each with whatever coverage already
 * exists. This is the entry point when neither attendance nor leave is enabled
 * and the admin drives everything by hand.
 */
exports.getTeacherPeriods = async (req, res) => {
    try {
        const teacherId = req.query.teacherId;
        if (!teacherId) return err(res, 'teacherId is required', 400);

        const date = parseDate(req.query.date);
        const ctx  = await sub.buildContext(req.schoolId, date);
        const teacher = ctx.teacherById.get(sub.sid(teacherId));
        if (!teacher) return err(res, 'Teacher not found', 404);

        const existing = await SubstituteAssignment.find({
            school: req.schoolId, date: ctx.date, originalTeacher: teacherId,
            status: { $in: sub.LIVE },
        }).lean();
        const byEntry = new Map(existing.map((r) => [sub.sid(r.timetableEntry), r]));

        const periods = sub.periodsOf(ctx, teacherId).map((p) => {
            const row = byEntry.get(sub.sid(p.timetableEntry));
            return {
                ...p,
                sectionLabel: sub.sectionLabel(ctx, p.section),
                subjectName:  sub.subjectName(ctx, p.subject),
                assignment:   row ? sub.decorate(ctx, row) : null,
            };
        });

        ok(res, {
            date: sub.isoOf(ctx.date),
            dayOfWeek: ctx.dayOfWeek,
            isWorkingDay: await sub.isWorkingDay(ctx),
            teacher: { _id: teacher._id, name: teacher.name },
            periods,
        });
    } catch (e) { err(res, e); }
};

/** Teachers who actually have periods on this weekday — the manual picker. */
exports.getSchedulableTeachers = async (req, res) => {
    try {
        const ctx = await sub.buildContext(req.schoolId, parseDate(req.query.date));
        const list = ctx.teachers
            .map((t) => ({
                _id: t._id,
                name: t.name,
                periods: (ctx.slotsByTeacherDay.get(`${sub.sid(t._id)}|${ctx.dayOfWeek}`) || []).length,
            }))
            .filter((t) => t.periods > 0)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        ok(res, { date: sub.isoOf(ctx.date), dayOfWeek: ctx.dayOfWeek, teachers: list });
    } catch (e) { err(res, e); }
};

/**
 * Open a substitution for a period with no detected absence — the admin knows
 * the teacher will be away. Optionally assigns the substitute in the same call.
 */
exports.createManual = async (req, res) => {
    try {
        const { timetableEntryId, substituteTeacherId, remarks } = req.body;
        if (!timetableEntryId) return err(res, 'timetableEntryId is required', 400);

        const date = parseDate(req.body.date || req.query.date);
        const ctx  = await sub.buildContext(req.schoolId, date);
        if (!ctx.ready) return err(res, 'No active academic year with a published timetable', 400);

        const entry = await TimetableEntry.findById(timetableEntryId).lean();
        if (!entry) return err(res, 'Timetable period not found', 404);

        // The entry must belong to this school's active-year timetable.
        const tt = ctx.timetableById.get(sub.sid(entry.timetable));
        if (!tt) return err(res, 'That period is not in the current academic year', 400);
        if (entry.dayOfWeek !== ctx.dayOfWeek) {
            return err(res, `That period is on a ${entry.dayOfWeek}, not a ${ctx.dayOfWeek}`, 400);
        }

        // Which teacher of this period is being replaced — the main subject
        // teacher by default, or a named additional-subject teacher.
        const requested = req.body.originalTeacherId ? sub.sid(req.body.originalTeacherId) : null;
        const slot = [
            entry.teacher ? { teacher: sub.sid(entry.teacher), subject: sub.sid(entry.subject) } : null,
            ...(entry.additionalSubjects || [])
                .filter((a) => a && a.teacher)
                .map((a) => ({ teacher: sub.sid(a.teacher), subject: sub.sid(a.subject) })),
        ].filter(Boolean).find((s) => !requested || s.teacher === requested);
        if (!slot) return err(res, 'That period has no teacher to substitute for', 400);

        const existing = await SubstituteAssignment.findOne({
            timetableEntry: entry._id, date: ctx.date, originalTeacher: slot.teacher,
            status: { $in: sub.LIVE },
        }).lean();
        if (existing) {
            return err(res, 'This period already has an open substitution', 409);
        }

        const times = (tt.periodsStructure || [])
            .find((p) => Number(p.periodNumber) === Number(entry.periodNumber)) || {};

        const created = await SubstituteAssignment.create({
            school:          req.schoolId,
            academicYear:    ctx.year._id,
            date:            ctx.date,
            dayOfWeek:       ctx.dayOfWeek,
            timetableEntry:  entry._id,
            section:         tt.section,
            subject:         slot.subject || null,
            periodNumber:    entry.periodNumber,
            startTime:       times.startTime || '',
            endTime:         times.endTime   || '',
            originalTeacher: slot.teacher,
            reason:          'manual',
            status:          'uncovered',
            assignedVia:     'none',
            remarks:         String(remarks || '').trim(),
        });

        const row = created.toObject ? created.toObject() : created;
        if (!substituteTeacherId) return ok(res, sub.decorate(ctx, row), 201);

        const updated = await sub.assignSubstitute(ctx, row, {
            substituteTeacherId,
            actor: req.userId,
            actorName: req.user && req.user.name,
            via: 'manual',
        });
        ok(res, sub.decorate(ctx, updated), 201);
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — reporting (spec §8)
══════════════════════════════════════════════════════════════════════════ */

/**
 * Normal vs substitute load per teacher across a date range. Normal load is the
 * timetable replayed over the range's actual school days, so a week with a
 * holiday in it reports fewer normal periods rather than a flat weekly figure.
 */
exports.getReport = async (req, res) => {
    try {
        const from = parseDate(req.query.from);
        const to   = parseDate(req.query.to || req.query.from);
        if (to < from) return err(res, 'Range ends before it starts', 400);

        const ctx  = await sub.buildContext(req.schoolId, from);
        const days = await sub.workingDaysIn(ctx, ctx.date, dayOf(to));

        const dayCount = new Map();
        for (const d of days) dayCount.set(d.day, (dayCount.get(d.day) || 0) + 1);

        const rows = await SubstituteAssignment.find({
            school: req.schoolId,
            status: 'assigned',
            date: { $gte: ctx.date, $lte: dayOf(to) },
        }).select('substituteTeacher originalTeacher date').lean();

        const taken = new Map();   // substitutions performed
        const given = new Map();   // own periods handed over
        for (const r of rows) {
            const t = sub.sid(r.substituteTeacher);
            const o = sub.sid(r.originalTeacher);
            if (t) taken.set(t, (taken.get(t) || 0) + 1);
            if (o) given.set(o, (given.get(o) || 0) + 1);
        }

        const teachers = ctx.teachers.map((t) => {
            const tid = sub.sid(t._id);
            let normal = 0;
            for (const [day, n] of dayCount) {
                normal += (ctx.slotsByTeacherDay.get(`${tid}|${day}`) || []).length * n;
            }
            return {
                teacher: { _id: t._id, name: t.name },
                normalPeriods:      normal,
                substitutesTaken:   taken.get(tid) || 0,
                periodsHandedOver:  given.get(tid) || 0,
                totalTaught:        normal + (taken.get(tid) || 0) - (given.get(tid) || 0),
            };
        }).sort((a, b) => b.substitutesTaken - a.substitutesTaken
            || String(a.teacher.name).localeCompare(String(b.teacher.name)));

        ok(res, {
            from: sub.isoOf(ctx.date),
            to:   sub.isoOf(dayOf(to)),
            schoolDays: days.length,
            totals: {
                substitutions: rows.length,
                teachersUsed:  taken.size,
            },
            teachers,
        });
    } catch (e) { err(res, e); }
};

/** Full history for one day, cancellations included — the audit view. */
exports.getHistory = async (req, res) => {
    try {
        const date = parseDate(req.query.date);
        const ctx  = await sub.buildContext(req.schoolId, date);
        const rows = await SubstituteAssignment.find({ school: req.schoolId, date: ctx.date })
            .sort({ periodNumber: 1 }).lean();
        ok(res, { date: sub.isoOf(ctx.date), rows: rows.map((r) => sub.decorate(ctx, r)) });
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — recent activity, one slot, and the workload roll-up
══════════════════════════════════════════════════════════════════════════ */

/**
 * The last N substitutions across days, newest first.
 *
 * Deliberately NOT decorated through a day context: that loads a whole day's
 * timetable, and a list spanning three weeks would load twenty of them. The
 * names are resolved in four flat lookups instead.
 */
exports.getRecent = async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
        const settings = await sub.getSettings(req.schoolId);

        const filter = { school: req.schoolId };
        if (req.query.via) filter.assignedVia = String(req.query.via);
        if (req.query.status) filter.status = String(req.query.status);
        else filter.status = { $in: ['uncovered', 'assigned'] };
        if (req.query.reason) filter.reason = String(req.query.reason);

        // The retention setting bounds how far back the list reaches. Rows are
        // never deleted for it, so lengthening it brings them back.
        const floor = new Date();
        floor.setUTCFullYear(floor.getUTCFullYear() - Math.max(1, Number(settings.historyYears) || 1));
        filter.date = { $gte: floor };

        const rows = await SubstituteAssignment.find(filter)
            .sort({ date: -1, periodNumber: 1 })
            .limit(limit)
            .lean();

        ok(res, { rows: await hydrate(req.schoolId, rows) });
    } catch (e) { err(res, e); }
};

/**
 * Resolve section / subject / teacher names for rows that may span many days.
 * One query per table, whatever the number of rows.
 */
async function hydrate(schoolId, rows) {
    if (!rows.length) return [];
    const ids = (key) => [...new Set(rows.map((r) => sub.sid(r[key])).filter(Boolean))];
    const [sections, subjects, users] = await Promise.all([
        ClassSection.find({ _id: { $in: ids('section') } }).select('sectionName class').lean(),
        Subject.find({ _id: { $in: ids('subject') } }).select('subjectName').lean(),
        User.find({ _id: { $in: [...ids('originalTeacher'), ...ids('substituteTeacher'), ...ids('assignedBy')] } })
            .select('name').lean(),
    ]);
    const classes = await Class.find({ _id: { $in: [...new Set(sections.map((x) => sub.sid(x.class)))] } })
        .select('className').lean();
    const className = new Map(classes.map((c) => [sub.sid(c._id), c.className]));
    const sectionById = new Map(sections.map((x) => [sub.sid(x._id), x]));
    const subjectById = new Map(subjects.map((x) => [sub.sid(x._id), x.subjectName]));
    const userById = new Map(users.map((x) => [sub.sid(x._id), x.name]));
    const nameOf = (id) => (id ? userById.get(sub.sid(id)) || '' : '');

    return rows.map((r) => {
        const sec = sectionById.get(sub.sid(r.section));
        const cls = sec ? className.get(sub.sid(sec.class)) || '' : '';
        return {
            _id: r._id,
            date: sub.isoOf(r.date),
            dayOfWeek: r.dayOfWeek,
            periodNumber: r.periodNumber,
            startTime: r.startTime || '',
            endTime: r.endTime || '',
            status: r.status,
            reason: r.reason,
            assignedVia: r.assignedVia,
            needsReview: !!r.needsReview,
            remarks: r.remarks || '',
            section: {
                _id: r.section,
                className: cls,
                sectionName: sec ? sec.sectionName : '',
                label: cls ? `${cls} - ${sec.sectionName}` : (sec ? sec.sectionName : ''),
            },
            subject: { _id: r.subject, name: subjectById.get(sub.sid(r.subject)) || '' },
            originalTeacher: { _id: r.originalTeacher, name: nameOf(r.originalTeacher) },
            substituteTeacher: r.substituteTeacher
                ? { _id: r.substituteTeacher, name: nameOf(r.substituteTeacher) } : null,
            assignedBy: r.assignedBy ? { _id: r.assignedBy, name: nameOf(r.assignedBy) } : null,
            assignedAt: r.assignedAt || null,
        };
    });
}

/**
 * One slot of the published week: what is taught there, by whom, whether they
 * are recorded away, and who could cover it.
 *
 * The manual-assignment screen asks this BEFORE any substitution row exists —
 * an admin picks a class, a section and a period, and wants to see the teacher
 * and the free staff before committing to anything. /:id/candidates cannot
 * answer that, because it needs a row to rank against.
 */
exports.getSlot = async (req, res) => {
    try {
        const { sectionId, periodNumber } = req.query;
        if (!sectionId || !periodNumber) return err(res, 'Section and period are required', 400);

        const ctx = await sub.buildContext(req.schoolId, parseDate(req.query.date));
        if (!ctx.ready) return err(res, 'No published timetable for the active academic year', 400);

        const period = Number(periodNumber);
        const slots = (ctx.slotsByDayPeriod.get(`${ctx.dayOfWeek}|${period}`) || [])
            .filter((slot) => {
                const tt = ctx.timetableById.get(sub.sid(slot.entry.timetable));
                return tt && sub.sid(tt.section) === String(sectionId);
            });

        const times = slots.length
            ? sub.periodTimes(ctx, slots[0].entry.timetable, period)
            : { startTime: '', endTime: '' };

        const [absences, busySlots] = await Promise.all([
            sub.detectAbsences(ctx),
            sub.busySubstituteSlots(ctx),
        ]);
        const workloads = await sub.computeWorkloads(ctx, ctx.teachers.map((t) => t._id));

        // Every teacher who is due in this room at this period: the main subject
        // plus any additional subject sharing the slot.
        const teaching = slots.map((slot) => {
            const away = absences.get(sub.sid(slot.teacher));
            return {
                teacher: { _id: slot.teacher, name: sub.teacherName(ctx, slot.teacher) },
                subject: { _id: slot.subject, name: sub.subjectName(ctx, slot.subject) },
                timetableEntry: slot.entry._id,
                isPrimary: slot.isPrimary,
                absence: away ? { reason: away.reason, label: away.label, needsReview: !!away.needsReview } : null,
            };
        });

        const existing = await SubstituteAssignment.find({
            school: req.schoolId, date: ctx.date, section: sectionId,
            periodNumber: period, status: { $in: ['uncovered', 'assigned'] },
        }).lean();

        // Rank against the first teaching slot — the candidate list is the same
        // for every teacher in the period, bar the subject-match bonus.
        const requirement = {
            periodNumber: period,
            section: sectionId,
            subject: slots[0] ? slots[0].subject : null,
            originalTeacher: slots[0] ? slots[0].teacher : null,
        };
        const candidates = slots.length
            ? sub.candidatesFor(ctx, requirement, { absences, workloads, busySlots })
            : [];

        // Everyone NOT free, and why — the availability panel lists both.
        const freeIds = new Set(candidates.map((c) => sub.sid(c.teacher._id)));
        const unavailable = ctx.teachers
            .filter((t) => !freeIds.has(sub.sid(t._id)))
            .map((t) => {
                const tid = sub.sid(t._id);
                const away = absences.get(tid);
                const busy = (ctx.slotsByDayPeriod.get(`${ctx.dayOfWeek}|${period}`) || [])
                    .some((x) => x.teacher === tid);
                return {
                    teacher: { _id: t._id, name: t.name },
                    reason: away ? (away.label || 'Away') : busy ? 'Teaching this period' : 'Not available',
                    subjects: [...(ctx.subjectsByTeacher.get(tid) || [])]
                        .map((id) => sub.subjectName(ctx, id)).filter(Boolean),
                };
            });

        ok(res, {
            date: sub.isoOf(ctx.date),
            dayOfWeek: ctx.dayOfWeek,
            periodNumber: period,
            ...times,
            teaching,
            existing: existing.map((r) => sub.decorate(ctx, r)),
            candidates: candidates.map((c) => ({
                ...c,
                subjects: [...(ctx.subjectsByTeacher.get(sub.sid(c.teacher._id)) || [])]
                    .map((id) => sub.subjectName(ctx, id)).filter(Boolean),
            })),
            unavailable,
        });
    } catch (e) { err(res, e); }
};

/**
 * Cover a period that has no substitution row yet, in one call: open it, then
 * assign. The manual screen is one form with one button, and making the client
 * chain create → assign leaves a half-made row behind whenever the second call
 * fails.
 *
 * Addressed by class period rather than by timetable entry, because that is
 * what the admin picked on screen; the entry is looked up here.
 */
exports.assignSlot = async (req, res) => {
    try {
        const { sectionId, periodNumber, substituteTeacherId } = req.body || {};
        if (!sectionId || !periodNumber) return err(res, 'Section and period are required', 400);
        if (!substituteTeacherId) return err(res, 'Choose a substitute teacher', 400);

        const ctx = await sub.buildContext(req.schoolId, parseDate(req.body.date));
        if (!ctx.ready) return err(res, 'No published timetable for the active academic year', 400);

        const period = Number(periodNumber);
        const slots = (ctx.slotsByDayPeriod.get(`${ctx.dayOfWeek}|${period}`) || [])
            .filter((slot) => {
                const tt = ctx.timetableById.get(sub.sid(slot.entry.timetable));
                return tt && sub.sid(tt.section) === String(sectionId);
            });
        if (!slots.length) return err(res, 'Nothing is timetabled for that class at that period', 400);

        const wanted = req.body.originalTeacherId
            ? slots.find((x) => x.teacher === sub.sid(req.body.originalTeacherId))
            : slots[0];
        if (!wanted) return err(res, 'That teacher does not take this period', 400);
        if (sub.sid(substituteTeacherId) === wanted.teacher) {
            return err(res, 'A teacher cannot substitute for themselves', 400);
        }

        const tt = ctx.timetableById.get(sub.sid(wanted.entry.timetable));
        let row = await SubstituteAssignment.findOne({
            school: req.schoolId, date: ctx.date,
            timetableEntry: wanted.entry._id, originalTeacher: wanted.teacher,
            status: { $in: sub.LIVE },
        }).lean();

        if (!row) {
            const times = sub.periodTimes(ctx, wanted.entry.timetable, period);
            const created = await SubstituteAssignment.create({
                school:          req.schoolId,
                academicYear:    ctx.year._id,
                date:            ctx.date,
                dayOfWeek:       ctx.dayOfWeek,
                timetableEntry:  wanted.entry._id,
                section:         tt.section,
                subject:         wanted.subject || null,
                periodNumber:    period,
                startTime:       times.startTime,
                endTime:         times.endTime,
                originalTeacher: wanted.teacher,
                // What the admin says is wrong today. 'manual' is the honest
                // default: this screen covers periods with no recorded absence.
                reason:          ['absent', 'leave', 'manual'].includes(req.body.reason)
                    ? req.body.reason : 'manual',
                status:          'uncovered',
                assignedVia:     'none',
            });
            row = created.toObject ? created.toObject() : created;
        }

        // The same override rule the per-row assign uses: a clash is refused
        // with its reason, never accepted quietly.
        if (req.body.force !== true) {
            const [absences, busySlots] = await Promise.all([
                sub.detectAbsences(ctx),
                sub.busySubstituteSlots(ctx),
            ]);
            const workloads = await sub.computeWorkloads(ctx, [substituteTeacherId]);
            const eligible = sub.candidatesFor(ctx, row, { absences, workloads, busySlots })
                .some((c) => sub.sid(c.teacher._id) === sub.sid(substituteTeacherId));
            if (!eligible) {
                return err(res, `${sub.teacherName(ctx, substituteTeacherId) || 'That teacher'} `
                    + 'is not available for this period. Re-send with force to assign anyway.', 409);
            }
        }

        const saved = await sub.assignSubstitute(ctx, row, {
            substituteTeacherId,
            remarks: req.body.remarks || '',
            actor: req.userId,
            actorName: req.user && req.user.name,
            via: 'manual',
        });
        ok(res, sub.decorate(ctx, saved), 201);
    } catch (e) { err(res, e, e.status || 500); }
};

/** Assign several open periods in one action — one board, one decision. */
exports.bulkAssign = async (req, res) => {
    try {
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (!items.length) return err(res, 'Nothing to assign', 400);
        if (items.length > 50) return err(res, 'Assign at most 50 periods at a time', 400);

        const date = parseDate(req.body.date);
        const ctx = await sub.buildContext(req.schoolId, date);

        const done = [];
        const failed = [];
        for (const item of items) {
            try {
                const row = await loadRow(item.id, req.schoolId);
                if (!row) throw new Error('Substitution not found');
                const saved = await sub.assignSubstitute(ctx, row, {
                    substituteTeacherId: item.substituteTeacherId,
                    remarks: item.remarks || req.body.remarks || '',
                    actor: req.userId,
                    actorName: req.user && req.user.name,
                    via: 'manual',
                });
                done.push(sub.decorate(ctx, saved));
            } catch (e) {
                failed.push({ id: item.id, message: e.message || 'Could not assign' });
            }
        }
        ok(res, { assigned: done.length, failed, rows: done });
    } catch (e) { err(res, e); }
};

/**
 * The workload screen: every teacher's timetabled load beside the cover they
 * have taken on, and which side of the school's own thresholds that puts them.
 *
 * The bands are derived from the configured weekly ceiling rather than being
 * hard-coded, so the labels a school reads ("> 34 periods") are its own numbers.
 */
exports.getWorkloadReport = async (req, res) => {
    try {
        const ctx = await sub.buildContext(req.schoolId, parseDate(req.query.date));
        const settings = ctx.settings;

        const from = req.query.from ? parseDate(req.query.from) : monthStart(ctx.date);
        const to   = req.query.to ? parseDate(req.query.to) : ctx.date;

        const [profiles, sst, subjects, sections, config] = await Promise.all([
            TeacherProfile.find({ teacher: { $in: ctx.teachers.map((t) => t._id) } })
                .select('teacher designation department').lean(),
            SectionSubjectTeacher.find().select('section subject teacher').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
            ClassSection.find({ school: req.schoolId, ...(ctx.year ? { academicYear: ctx.year._id } : {}) })
                .populate('class', 'className').lean(),
            ctx.year
                ? TimetableConfig.findOne({ school: req.schoolId, academicYear: ctx.year._id }).lean()
                : null,
        ]);

        const profileOf = new Map(profiles.map((p) => [sub.sid(p.teacher), p]));
        const subjectName = new Map(subjects.map((x) => [sub.sid(x._id), x.subjectName]));
        const sectionById = new Map(sections.map((x) => [sub.sid(x._id), x]));

        // Weekly timetabled load: every slot the teacher holds, across the week.
        const weekly = new Map();
        const sectionsOf = new Map();
        for (const slot of ctx.slots) {
            const tid = slot.teacher;
            weekly.set(tid, (weekly.get(tid) || 0) + 1);
            const tt = ctx.timetableById.get(sub.sid(slot.entry.timetable));
            if (tt) {
                if (!sectionsOf.has(tid)) sectionsOf.set(tid, new Set());
                sectionsOf.get(tid).add(sub.sid(tt.section));
            }
        }

        const covers = await SubstituteAssignment.find({
            school: req.schoolId, status: 'assigned',
            date: { $gte: from, $lte: to },
        }).select('substituteTeacher').lean();
        const subsBy = new Map();
        for (const c of covers) {
            const tid = sub.sid(c.substituteTeacher);
            if (tid) subsBy.set(tid, (subsBy.get(tid) || 0) + 1);
        }

        const target = Number(config && config.defaults && config.defaults.maxTeacherPeriodsPerWeek) || 30;
        const overAt  = target;
        const underAt = Math.max(1, Math.round(target * 0.4));

        const teacherSubjects = new Map();
        for (const row of sst) {
            const tid = sub.sid(row.teacher);
            if (!sectionById.has(sub.sid(row.section))) continue;
            if (!teacherSubjects.has(tid)) teacherSubjects.set(tid, new Map());
            const name = subjectName.get(sub.sid(row.subject));
            if (name) teacherSubjects.get(tid).set(sub.sid(row.subject), name);
        }

        // Filters name a class, a section or a subject; a teacher qualifies by
        // actually teaching there in the published week.
        const wantClass   = (req.query.className || '').trim();
        const wantSection = (req.query.sectionName || '').trim();
        const wantSubject = (req.query.subjectId || '').trim();
        const wantTeacher = (req.query.teacherId || '').trim();
        const wantStatus  = (req.query.status || '').trim();

        const rows = ctx.teachers.map((t) => {
            const tid = sub.sid(t._id);
            const profile = profileOf.get(tid);
            const assigned = weekly.get(tid) || 0;
            const substitutions = subsBy.get(tid) || 0;
            const total = settings.includeSubsInWorkload ? assigned + substitutions : assigned;
            const status = total > overAt ? 'overloaded' : total < underAt ? 'underloaded' : 'balanced';
            const mine = [...(sectionsOf.get(tid) || [])].map((id) => sectionById.get(id)).filter(Boolean);
            return {
                teacher: { _id: t._id, name: t.name },
                designation: (profile && profile.designation) || 'Teacher',
                department: (profile && profile.department) || '',
                subjects: [...(teacherSubjects.get(tid) || new Map()).entries()]
                    .map(([_id, name]) => ({ _id, name })),
                assignedPeriods: assigned,
                substitutionPeriods: substitutions,
                totalLoad: total,
                loadPct: target > 0 ? Math.round((total / target) * 100) : 0,
                status,
                classes: [...new Set(mine.map((x) => (x.class && x.class.className) || ''))].filter(Boolean),
                sectionNames: [...new Set(mine.map((x) => x.sectionName))].filter(Boolean),
            };
        }).filter((r) => {
            if (wantTeacher && sub.sid(r.teacher._id) !== wantTeacher) return false;
            if (wantClass && !r.classes.includes(wantClass)) return false;
            if (wantSection && !r.sectionNames.includes(wantSection)) return false;
            if (wantSubject && !r.subjects.some((x) => String(x._id) === wantSubject)) return false;
            if (wantStatus && r.status !== wantStatus) return false;
            return true;
        }).sort((a, b) => b.totalLoad - a.totalLoad
            || String(a.teacher.name).localeCompare(String(b.teacher.name)));

        const all = rows;
        ok(res, {
            from: sub.isoOf(from),
            to: sub.isoOf(to),
            thresholds: { target, overAt, underAt },
            includeSubsInWorkload: !!settings.includeSubsInWorkload,
            summary: {
                totalTeachers: all.length,
                averagePerWeek: all.length
                    ? Math.round((all.reduce((n, r) => n + r.totalLoad, 0) / all.length) * 10) / 10
                    : 0,
                overloaded: all.filter((r) => r.status === 'overloaded').length,
                balanced: all.filter((r) => r.status === 'balanced').length,
                underloaded: all.filter((r) => r.status === 'underloaded').length,
            },
            top: all.slice(0, 5).map((r) => ({ name: r.teacher.name, periods: r.totalLoad })),
            teachers: all,
        });
    } catch (e) { err(res, e); }
};

/** First of the month a date falls in, at UTC midnight like every stored day. */
function monthStart(d) {
    const x = new Date(d);
    x.setUTCDate(1);
    x.setUTCHours(0, 0, 0, 0);
    return x;
}

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — settings
══════════════════════════════════════════════════════════════════════════ */

exports.getSettings = async (req, res) => {
    try {
        const settings = await sub.getSettings(req.schoolId);
        const ctx = await sub.buildContext(req.schoolId, new Date());
        ok(res, {
            settings,
            // Which detection sources the school could use at all, so the
            // settings screen can grey out what the module flags forbid.
            moduleFlags: { attendance: ctx.flags.attendance, leave: ctx.flags.leave },
        });
    } catch (e) { err(res, e); }
};

exports.saveSettings = async (req, res) => {
    try {
        ok(res, await sub.saveSettings(req.schoolId, req.body || {}, req.userId));
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   TEACHER
══════════════════════════════════════════════════════════════════════════ */

/**
 * My substitute duties, plus the classes of mine someone else is covering.
 * Defaults to today→+7 days, which is what the mobile screen opens on.
 */
exports.teacherMySubstitutions = async (req, res) => {
    try {
        const from = parseDate(req.query.from);
        const to   = req.query.to
            ? parseDate(req.query.to)
            : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

        const range = { $gte: from, $lte: to };
        const [mine, covered] = await Promise.all([
            SubstituteAssignment.find({
                school: req.schoolId, substituteTeacher: req.userId,
                status: 'assigned', date: range,
            }).sort({ date: 1, periodNumber: 1 }).lean(),
            SubstituteAssignment.find({
                school: req.schoolId, originalTeacher: req.userId,
                status: { $in: sub.LIVE }, date: range,
            }).sort({ date: 1, periodNumber: 1 }).lean(),
        ]);

        // One context per distinct date — names come from the timetable of the
        // year that date falls in.
        const ctxByDate = new Map();
        const ctxFor = async (d) => {
            const key = sub.isoOf(d);
            if (!ctxByDate.has(key)) ctxByDate.set(key, await sub.buildContext(req.schoolId, d));
            return ctxByDate.get(key);
        };

        const decorateAll = async (rows) => {
            const out = [];
            for (const r of rows) out.push(sub.decorate(await ctxFor(r.date), r));
            return out;
        };

        const [duties, handedOver] = await Promise.all([
            decorateAll(mine), decorateAll(covered),
        ]);

        // The six counts for the requesting teacher, as of today.
        const todayCtx = await sub.buildContext(req.schoolId, new Date());
        const workloads = await sub.computeWorkloads(todayCtx, [req.userId]);

        ok(res, {
            from: sub.isoOf(from),
            to:   sub.isoOf(to),
            duties,
            handedOver,
            workload: workloads.get(sub.sid(req.userId)) || null,
        });
    } catch (e) { err(res, e); }
};
