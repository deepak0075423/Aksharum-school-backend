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
