'use strict';
/**
 * Substitute Subject Teacher engine.
 * ──────────────────────────────────
 * Turns "this subject teacher is away today" into one covered period at a time.
 *
 * The unit of work is a PERIOD, never a teacher-day. A Maths teacher scheduled
 * for 8-A P2, 9-B P4 and 10-A P6 produces three independent requirements, each
 * matched against whoever is genuinely free at that exact slot — a teacher free
 * at P2 but teaching at P4 is a candidate for the first only.
 *
 * Absence has three possible sources, and which ones are consulted depends on
 * what the school has switched on:
 *   • attendance module  → TeacherAttendance says Absent / Half-Day / Leave, or
 *                          the teacher never marked and the cutoff has passed
 *   • leave module       → an approved LeaveApplication covers the date
 *   • neither            → nothing is detected; the admin drives it by hand,
 *                          picking a teacher and covering their periods
 *
 * Everything a single day needs is loaded once into a context object
 * (buildContext) — the timetable for the year is a few thousand rows, and
 * reading it once beats re-querying per candidate per period.
 */
const Timetable           = require('../models/Timetable');
const TimetableEntry      = require('../models/TimetableEntry');
const ClassSection        = require('../models/ClassSection');
const AcademicYear        = require('../models/AcademicYear');
const School              = require('../models/School');
const Subject             = require('../models/Subject');
const User                = require('../models/User');
const TeacherAttendance   = require('../models/TeacherAttendance');
const LeaveApplication    = require('../models/LeaveApplication');
const TeacherAvailability = require('../models/TeacherAvailability');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const SubstituteAssignment  = require('../models/SubstituteAssignment');
const SubstituteSettings    = require('../models/SubstituteSettings');
const { notify }            = require('./notifyService');
const { schoolModuleFlags } = require('../config/modules');
const {
    normalizeLeaveSettings, isSaturdayWorking, staffHolidaysInRange, utcMidnight,
} = require('../utils/leaveDays');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LIVE = ['uncovered', 'assigned'];

const sid       = (v) => ((v && v._id) ? v._id : v)?.toString() || '';
const dayNameOf = (d) => DAY_NAMES[new Date(d).getUTCDay()];
const isoOf     = (d) => new Date(d).toISOString().slice(0, 10);

// 'HH:mm' → minutes since midnight; NaN-safe (returns null on anything odd).
function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

// The server runs in the school's timezone, and every 'HH:mm' in the timetable
// is school-local, so "now" is read locally while dates stay UTC-midnight (the
// same convention utils/leaveDays uses).
const nowMinutes    = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const todayUtcMidnight = () => {
    const n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
};

/** Monday–Sunday week containing `date`. */
function weekRange(date) {
    const d    = utcMidnight(date);
    const dow  = d.getUTCDay();            // 0 = Sunday
    const back = dow === 0 ? 6 : dow - 1;  // weeks start Monday
    const start = new Date(d); start.setUTCDate(d.getUTCDate() - back);
    const end   = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
    return { start, end };
}

function monthRange(date) {
    const d = utcMidnight(date);
    return {
        start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
        end:   new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
    };
}

/* ══════════════════════════════════════════════════════════════════════════
   Settings
══════════════════════════════════════════════════════════════════════════ */

// One row per school, created on first read so a school that never opens the
// settings tab still behaves sensibly.
async function getSettings(schoolId) {
    const existing = await SubstituteSettings.findOne({ school: schoolId }).lean();
    if (existing) return existing;
    try {
        const created = await SubstituteSettings.create({ school: schoolId });
        return created.toObject ? created.toObject() : created;
    } catch {
        // Lost a race with a concurrent first read — the other one won.
        return SubstituteSettings.findOne({ school: schoolId }).lean();
    }
}

async function saveSettings(schoolId, patch, userId) {
    await getSettings(schoolId);                       // ensure the row exists
    const BOOLEANS = [
        'autoAssign', 'useAttendance', 'useLeave', 'skipPeriodsAlreadyStarted',
        'respectAvailabilityBlocks', 'respectDailyPeriodCap', 'requireSubjectMatch',
        'notifySubstitute', 'notifyOriginalTeacher', 'notifyOnChange', 'emailSubstitute',
    ];
    const NUMBERS = [
        'maxSubstitutionsPerDay',
        'weightSubsToday', 'weightSubsWeek', 'weightSubsMonth', 'weightNormalToday',
        'bonusSubjectMatch', 'bonusSameSection',
    ];
    const $set = { updatedBy: userId || null };
    for (const k of BOOLEANS) {
        if (patch[k] !== undefined) $set[k] = !!patch[k];
    }
    for (const k of NUMBERS) {
        if (patch[k] === undefined) continue;
        const n = Number(patch[k]);
        $set[k] = Number.isFinite(n) ? Math.max(0, n) : 0;
    }
    if (patch.unmarkedAbsentAfter !== undefined) {
        // Reject anything that isn't a clock time rather than storing a value
        // the cutoff comparison would silently read as "never".
        $set.unmarkedAbsentAfter = toMinutes(patch.unmarkedAbsentAfter) == null
            ? '09:30'
            : String(patch.unmarkedAbsentAfter).trim();
    }
    await SubstituteSettings.findOneAndUpdate({ school: schoolId }, { $set }, { new: true });
    return getSettings(schoolId);
}

/* ══════════════════════════════════════════════════════════════════════════
   Context — one day's worth of everything, loaded once
══════════════════════════════════════════════════════════════════════════ */

/**
 * A period as taught by ONE teacher. A merged-subject period yields several
 * slots from a single TimetableEntry — the main subject plus one per
 * additionalSubjects[] — which is what lets an absent additional-subject
 * teacher be covered without disturbing the main one.
 */
function slotsOf(entry) {
    const out = [];
    if (entry.teacher) {
        out.push({ entry, teacher: sid(entry.teacher), subject: sid(entry.subject), isPrimary: true });
    }
    for (const a of entry.additionalSubjects || []) {
        if (a && a.teacher) {
            out.push({ entry, teacher: sid(a.teacher), subject: sid(a.subject), isPrimary: false });
        }
    }
    return out;
}

async function buildContext(schoolId, dateLike) {
    const date      = utcMidnight(dateLike || new Date());
    const dayOfWeek = dayNameOf(date);

    const [settings, school, year] = await Promise.all([
        getSettings(schoolId),
        School.findById(schoolId).select('name modules leaveSettings').lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);

    const flags         = schoolModuleFlags(school);
    const leaveSettings = normalizeLeaveSettings(school && school.leaveSettings);

    const ctx = {
        schoolId, date, dayOfWeek, settings, school, flags, leaveSettings, year,
        timetableById: new Map(),
        sectionById:   new Map(),
        subjectById:   new Map(),
        teachers: [], teacherById: new Map(),
        slots: [],
        slotsByTeacherDay: new Map(),   // `${teacherId}|${day}` → slots
        slotsByDayPeriod:  new Map(),   // `${day}|${period}`    → slots
        availabilityByTeacher: new Map(),
        subjectsByTeacher:     new Map(),
        sectionsByTeacher:     new Map(),
        ready: false,
    };

    const teachers = await User.find({ school: schoolId, role: 'teacher', isActive: true })
        .select('name email').lean();
    ctx.teachers = teachers;
    for (const t of teachers) ctx.teacherById.set(sid(t._id), t);

    // No active year means no published timetable to substitute against.
    if (!year) return ctx;

    const [timetables, sections, subjects, availability, sst] = await Promise.all([
        Timetable.find({ academicYear: year._id }).lean(),
        ClassSection.find({ school: schoolId, academicYear: year._id })
            .populate('class', 'className').lean(),
        Subject.find({ school: schoolId }).select('subjectName subjectCode').lean(),
        TeacherAvailability.find({ school: schoolId, academicYear: year._id }).lean(),
        SectionSubjectTeacher.find().select('section subject teacher').lean(),
    ]);

    for (const tt of timetables) ctx.timetableById.set(sid(tt._id), tt);
    for (const s of sections)    ctx.sectionById.set(sid(s._id), s);
    for (const s of subjects)    ctx.subjectById.set(sid(s._id), s);
    for (const a of availability) ctx.availabilityByTeacher.set(sid(a.teacher), a);

    // "Does this teacher teach this subject / this section anywhere?" — drives
    // the ranking bonuses and the optional hard subject filter. Section ids are
    // filtered to this school's sections, since the table has no school column.
    for (const r of sst) {
        const tid = sid(r.teacher);
        if (!ctx.sectionById.has(sid(r.section))) continue;
        if (!ctx.subjectsByTeacher.has(tid)) ctx.subjectsByTeacher.set(tid, new Set());
        if (!ctx.sectionsByTeacher.has(tid)) ctx.sectionsByTeacher.set(tid, new Set());
        ctx.subjectsByTeacher.get(tid).add(sid(r.subject));
        ctx.sectionsByTeacher.get(tid).add(sid(r.section));
    }

    const ttIds = timetables.map((t) => t._id);
    const entries = ttIds.length
        ? await TimetableEntry.find({ timetable: { $in: ttIds } })
            .select('timetable dayOfWeek periodNumber subject teacher additionalSubjects').lean()
        : [];

    for (const e of entries) {
        for (const slot of slotsOf(e)) {
            ctx.slots.push(slot);
            const k1 = `${slot.teacher}|${e.dayOfWeek}`;
            const k2 = `${e.dayOfWeek}|${e.periodNumber}`;
            if (!ctx.slotsByTeacherDay.has(k1)) ctx.slotsByTeacherDay.set(k1, []);
            if (!ctx.slotsByDayPeriod.has(k2))  ctx.slotsByDayPeriod.set(k2, []);
            ctx.slotsByTeacherDay.get(k1).push(slot);
            ctx.slotsByDayPeriod.get(k2).push(slot);
        }
    }

    ctx.ready = true;
    return ctx;
}

/** 'HH:mm' window for a period, read from the section's own timetable. */
function periodTimes(ctx, timetableId, periodNumber) {
    const tt = ctx.timetableById.get(sid(timetableId));
    const p  = (tt && tt.periodsStructure || []).find((x) => Number(x.periodNumber) === Number(periodNumber));
    return { startTime: (p && p.startTime) || '', endTime: (p && p.endTime) || '' };
}

/** Readable "8 — Section A" for a section id. */
function sectionLabel(ctx, sectionId) {
    const s = ctx.sectionById.get(sid(sectionId));
    if (!s) return '';
    const cls = (s.class && s.class.className) || '';
    return cls ? `${cls} — Section ${s.sectionName}` : `Section ${s.sectionName}`;
}

const subjectName = (ctx, subjectId) => {
    const s = ctx.subjectById.get(sid(subjectId));
    return (s && s.subjectName) || '';
};
const teacherName = (ctx, teacherId) => {
    const t = ctx.teacherById.get(sid(teacherId));
    return (t && t.name) || '';
};

/* ══════════════════════════════════════════════════════════════════════════
   Working days
══════════════════════════════════════════════════════════════════════════ */

// Sundays, non-working Saturdays and staff holidays are not school days, so
// nothing is substituted on them and they don't inflate the weekly/monthly
// normal-load counts.
async function workingDaysIn(ctx, from, to) {
    const holidays = await staffHolidaysInRange(from, to, ctx.schoolId);
    const holidaySet = new Set();
    for (const h of holidays) {
        const cur = utcMidnight(h.startDate);
        const end = utcMidnight(h.endDate);
        while (cur <= end) {
            holidaySet.add(isoOf(cur));
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }
    const out = [];
    const cur = new Date(from);
    while (cur <= to) {
        const dow = cur.getUTCDay();
        const open = dow !== 0
            && (dow !== 6 || isSaturdayWorking(cur, ctx.leaveSettings))
            && !holidaySet.has(isoOf(cur));
        if (open) out.push({ date: new Date(cur), day: DAY_NAMES[dow] });
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

// Cached on the context: the board, the requirement pass and the sweep all ask,
// and the answer costs a holiday query.
async function isWorkingDay(ctx) {
    if (ctx._workingDay === undefined) {
        const days = await workingDaysIn(ctx, ctx.date, ctx.date);
        ctx._workingDay = days.length > 0;
    }
    return ctx._workingDay;
}

/* ══════════════════════════════════════════════════════════════════════════
   Absence detection
══════════════════════════════════════════════════════════════════════════ */

// An unmarked teacher is not absent the moment school opens — they may be
// running late. Past days are settled; future days can't be judged at all.
function unmarkedCountsAsAbsent(ctx) {
    const today = todayUtcMidnight();
    if (ctx.date < today) return true;
    if (ctx.date > today) return false;
    const cutoff = toMinutes(ctx.settings.unmarkedAbsentAfter);
    return cutoff == null ? false : nowMinutes() >= cutoff;
}

/**
 * Who is away on ctx.date → Map<teacherId, {reason, sourceRef, needsReview, label}>.
 *
 * Attendance wins over leave where both speak: a teacher with approved leave who
 * was nonetheless marked Present came in, and their classes need no cover.
 */
async function detectAbsences(ctx) {
    const out = new Map();
    const useAttendance = ctx.settings.useAttendance && ctx.flags.attendance;
    const useLeave      = ctx.settings.useLeave && ctx.flags.leave;

    if (useLeave) {
        const apps = await LeaveApplication.find({
            school:   ctx.schoolId,
            status:   'approved',
            fromDate: { $lte: ctx.date },
            toDate:   { $gte: ctx.date },
        }).select('teacher leaveMode _id').lean();
        for (const a of apps) {
            out.set(sid(a.teacher), {
                reason: 'leave',
                sourceRef: a._id,
                needsReview: a.leaveMode === 'half_day',
                label: a.leaveMode === 'half_day' ? 'Approved leave (half day)' : 'Approved leave',
            });
        }
    }

    if (useAttendance) {
        const rows = await TeacherAttendance.find({ school: ctx.schoolId, date: ctx.date })
            .select('teacher status _id').lean();
        const marked = new Set();
        for (const r of rows) {
            const tid = sid(r.teacher);
            marked.add(tid);
            if (r.status === 'Present') { out.delete(tid); continue; }
            out.set(tid, {
                reason:      r.status === 'Leave' ? 'leave' : 'absent',
                sourceRef:   r._id,
                needsReview: r.status === 'Half-Day',
                label:       r.status === 'Half-Day' ? 'Half day'
                           : r.status === 'Leave'    ? 'On leave (attendance)'
                           : 'Marked absent',
            });
        }
        // "Not marked present" only means absent when attendance was actually
        // taken. On a day nobody marked at all — a holiday nobody flagged, the
        // register simply not run — the honest reading is "no data", not "the
        // entire staff is away": inferring absence there would open a
        // requirement for every period in the school and leave none of them
        // coverable, since every possible substitute would be absent too.
        if (rows.length && unmarkedCountsAsAbsent(ctx)) {
            for (const t of ctx.teachers) {
                const tid = sid(t._id);
                if (marked.has(tid) || out.has(tid)) continue;
                out.set(tid, {
                    reason: 'absent', sourceRef: null, needsReview: false,
                    label: 'Attendance not marked',
                });
            }
        }
    }

    // Only teachers who actually have periods that day matter here; the caller
    // filters, but dropping unknown ids keeps the map honest.
    for (const tid of [...out.keys()]) {
        if (!ctx.teacherById.has(tid)) out.delete(tid);
    }
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Requirements — one per affected period
══════════════════════════════════════════════════════════════════════════ */

/** Every period `teacherId` is scheduled to teach on ctx.dayOfWeek. */
function periodsOf(ctx, teacherId) {
    const slots = ctx.slotsByTeacherDay.get(`${sid(teacherId)}|${ctx.dayOfWeek}`) || [];
    return slots.map((slot) => {
        const tt = ctx.timetableById.get(sid(slot.entry.timetable));
        const times = periodTimes(ctx, slot.entry.timetable, slot.entry.periodNumber);
        return {
            timetableEntry: slot.entry._id,
            section:        tt ? tt.section : null,
            subject:        slot.subject || null,
            periodNumber:   slot.entry.periodNumber,
            startTime:      times.startTime,
            endTime:        times.endTime,
        };
    }).sort((a, b) => a.periodNumber - b.periodNumber);
}

/**
 * Create the missing rows for today's absences and retire the ones whose reason
 * has gone away (attendance corrected to Present, leave cancelled). Idempotent:
 * running it twice changes nothing, which is what lets the sweep run on a timer
 * and the board refresh on every page load.
 */
async function ensureRequirements(ctx, absences) {
    if (!ctx.ready) return { created: 0, retired: 0 };
    if (!(await isWorkingDay(ctx))) return { created: 0, retired: 0 };

    const existing = await SubstituteAssignment.find({
        school: ctx.schoolId, date: ctx.date, status: { $in: LIVE },
    }).lean();
    const keyOf = (entryId, teacherId) => `${sid(entryId)}|${sid(teacherId)}`;
    const haveKeys = new Set(existing.map((r) => keyOf(r.timetableEntry, r.originalTeacher)));

    let created = 0;
    for (const [teacherId, info] of absences) {
        for (const p of periodsOf(ctx, teacherId)) {
            if (!p.section) continue;
            if (haveKeys.has(keyOf(p.timetableEntry, teacherId))) continue;
            try {
                await SubstituteAssignment.create({
                    school:          ctx.schoolId,
                    academicYear:    ctx.year._id,
                    date:            ctx.date,
                    dayOfWeek:       ctx.dayOfWeek,
                    timetableEntry:  p.timetableEntry,
                    section:         p.section,
                    subject:         p.subject,
                    periodNumber:    p.periodNumber,
                    startTime:       p.startTime,
                    endTime:         p.endTime,
                    originalTeacher: teacherId,
                    reason:          info.reason,
                    sourceRef:       info.sourceRef,
                    needsReview:     !!info.needsReview,
                    status:          'uncovered',
                    assignedVia:     'none',
                });
                created += 1;
                haveKeys.add(keyOf(p.timetableEntry, teacherId));
            } catch (e) {
                // Unique index caught a concurrent sweep — that row exists now.
                if (!/duplicate|unique/i.test(e.message || '')) throw e;
            }
        }
    }

    // Retire auto-detected rows whose teacher is no longer away. Manual rows are
    // left alone: an admin who substituted a period by hand meant it.
    let retired = 0;
    for (const row of existing) {
        if (row.reason === 'manual') continue;
        if (absences.has(sid(row.originalTeacher))) continue;
        await cancelAssignment(ctx, row, { actor: null, note: 'Absence no longer recorded' });
        retired += 1;
    }

    return { created, retired };
}

/* ══════════════════════════════════════════════════════════════════════════
   Workload — the six counts, normal load kept separate from substitute load
══════════════════════════════════════════════════════════════════════════ */

/**
 * For each teacher: normal periods today/this week/this month, and substitute
 * periods today/this week/this month.
 *
 * Normal load is the timetable, so a week is not six independent queries — it
 * is the per-weekday period count multiplied by how many of those weekdays in
 * the range are actually school days (Sundays, closed Saturdays and staff
 * holidays excluded).
 */
async function computeWorkloads(ctx, teacherIds) {
    const ids  = [...new Set(teacherIds.map(sid).filter(Boolean))];
    const week  = weekRange(ctx.date);
    const month = monthRange(ctx.date);

    // A week can straddle a month boundary, so query the union of both windows.
    const from = week.start < month.start ? week.start : month.start;
    const to   = week.end   > month.end   ? week.end   : month.end;

    const [weekDays, monthDays, subRows] = await Promise.all([
        workingDaysIn(ctx, week.start,  week.end),
        workingDaysIn(ctx, month.start, month.end),
        ids.length
            ? SubstituteAssignment.find({
                school: ctx.schoolId,
                substituteTeacher: { $in: ids },
                status: 'assigned',
                date: { $gte: from, $lte: to },
            }).select('substituteTeacher date').lean()
            : [],
    ]);

    const countDays = (days) => {
        const m = new Map();
        for (const d of days) m.set(d.day, (m.get(d.day) || 0) + 1);
        return m;
    };
    const weekDayCount  = countDays(weekDays);
    const monthDayCount = countDays(monthDays);
    const todayIso = isoOf(ctx.date);
    const weekIsos = new Set(weekDays.map((d) => isoOf(d.date)));
    const monthIsos = new Set(monthDays.map((d) => isoOf(d.date)));

    const out = new Map();
    for (const tid of ids) {
        // periods this teacher has on each weekday, from the timetable
        const perDay = new Map();
        for (const day of DAY_NAMES) {
            const n = (ctx.slotsByTeacherDay.get(`${tid}|${day}`) || []).length;
            if (n) perDay.set(day, n);
        }
        let normalWeek = 0, normalMonth = 0;
        for (const [day, n] of perDay) {
            normalWeek  += n * (weekDayCount.get(day)  || 0);
            normalMonth += n * (monthDayCount.get(day) || 0);
        }
        out.set(tid, {
            normalToday: perDay.get(ctx.dayOfWeek) || 0,
            normalWeek,
            normalMonth,
            subsToday: 0,
            subsWeek:  0,
            subsMonth: 0,
        });
    }

    for (const r of subRows) {
        const w = out.get(sid(r.substituteTeacher));
        if (!w) continue;
        const iso = isoOf(r.date);
        if (iso === todayIso)  w.subsToday += 1;
        if (weekIsos.has(iso))  w.subsWeek  += 1;
        if (monthIsos.has(iso)) w.subsMonth += 1;
    }

    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Candidate search
══════════════════════════════════════════════════════════════════════════ */

/** Teachers already covering some period on this date → `${teacherId}|${period}`. */
async function busySubstituteSlots(ctx) {
    const rows = await SubstituteAssignment.find({
        school: ctx.schoolId, date: ctx.date, status: 'assigned',
    }).select('substituteTeacher periodNumber').lean();
    const set = new Set();
    for (const r of rows) {
        if (r.substituteTeacher) set.add(`${sid(r.substituteTeacher)}|${r.periodNumber}`);
    }
    return set;
}

function isBlockedByAvailability(ctx, teacherId, periodNumber) {
    if (!ctx.settings.respectAvailabilityBlocks) return false;
    const a = ctx.availabilityByTeacher.get(sid(teacherId));
    if (!a) return false;
    return (a.unavailable || []).some(
        (u) => u.dayOfWeek === ctx.dayOfWeek && Number(u.periodNumber) === Number(periodNumber),
    );
}

function scoreCandidate(ctx, work, { subjectMatch, sameSection }) {
    const s = ctx.settings;
    let score = (work.subsToday   * s.weightSubsToday)
              + (work.subsWeek    * s.weightSubsWeek)
              + (work.subsMonth   * s.weightSubsMonth)
              + (work.normalToday * s.weightNormalToday);
    if (subjectMatch) score -= s.bonusSubjectMatch;
    if (sameSection)  score -= s.bonusSameSection;
    return score;
}

/**
 * Ranked, eligible substitutes for one requirement.
 *
 * Every exclusion below answers "otherwise unavailable" from the spec:
 * the teacher being replaced, anyone else away that day, anyone with a normal
 * period at that exact slot, anyone already covering that slot, anyone the
 * timetable's own availability rules block, and anyone already at their period
 * ceiling for the day.
 *
 * `extraBusy` lets a single auto-assign pass keep track of teachers it has
 * committed moments earlier, before those rows are re-read.
 */
function candidatesFor(ctx, requirement, { absences, workloads, busySlots, extraBusy }) {
    const period = Number(requirement.periodNumber);
    const originalId = sid(requirement.originalTeacher);
    const sectionId  = sid(requirement.section);
    const subjectId  = sid(requirement.subject);

    // Everyone with a normal class at this exact slot.
    const teaching = new Set(
        (ctx.slotsByDayPeriod.get(`${ctx.dayOfWeek}|${period}`) || []).map((s) => s.teacher),
    );

    const out = [];
    for (const t of ctx.teachers) {
        const tid = sid(t._id);
        if (tid === originalId)  continue;                       // the absent teacher
        if (absences.has(tid))   continue;                       // absent or on leave
        if (teaching.has(tid))   continue;                       // teaching elsewhere
        if (busySlots.has(`${tid}|${period}`)) continue;         // already covering this slot
        if (extraBusy && extraBusy.has(`${tid}|${period}`)) continue;
        if (isBlockedByAvailability(ctx, tid, period)) continue; // blocked slot

        const work = workloads.get(tid) || {
            normalToday: 0, normalWeek: 0, normalMonth: 0, subsToday: 0, subsWeek: 0, subsMonth: 0,
        };
        const pendingSubs = work.subsToday + ((extraBusy && extraBusy.countFor) ? extraBusy.countFor(tid) : 0);

        const cap = ctx.settings.maxSubstitutionsPerDay;
        if (cap > 0 && pendingSubs >= cap) continue;

        if (ctx.settings.respectDailyPeriodCap) {
            const avail = ctx.availabilityByTeacher.get(tid);
            const dayCap = avail && avail.maxPeriodsPerDay;
            if (dayCap && (work.normalToday + pendingSubs) >= dayCap) continue;
        }

        const subjectMatch = !!(subjectId && ctx.subjectsByTeacher.get(tid)
            && ctx.subjectsByTeacher.get(tid).has(subjectId));
        if (ctx.settings.requireSubjectMatch && !subjectMatch) continue;

        const sameSection = !!(sectionId && ctx.sectionsByTeacher.get(tid)
            && ctx.sectionsByTeacher.get(tid).has(sectionId));

        out.push({
            teacher: { _id: t._id, name: t.name, email: t.email },
            workload: { ...work, subsToday: pendingSubs },
            subjectMatch,
            sameSection,
            score: scoreCandidate(ctx, { ...work, subsToday: pendingSubs }, { subjectMatch, sameSection }),
        });
    }

    // Lowest score first; name breaks ties so the ordering is stable between
    // requests and two admins looking at the same period see the same list.
    out.sort((a, b) => (a.score - b.score) || String(a.teacher.name).localeCompare(String(b.teacher.name)));
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Notifications
══════════════════════════════════════════════════════════════════════════ */

// notify() needs an acting user. The scheduler has none, so it borrows the
// school's first active admin as the sender and labels the role 'system'.
const _senderCache = new Map();
async function systemSender(schoolId) {
    const key = sid(schoolId);
    if (_senderCache.has(key)) return _senderCache.get(key);
    const admin = await User.findOne({ school: schoolId, role: 'school_admin', isActive: true })
        .select('_id').lean();
    const id = admin ? admin._id : null;
    _senderCache.set(key, id);
    return id;
}

const prettyDate = (d) => new Date(d).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

/** The shared body every substitution notification carries (spec §6, §7). */
function describe(ctx, row) {
    const time = row.startTime
        ? ` (${row.startTime}${row.endTime ? `–${row.endTime}` : ''})`
        : '';
    const lines = [
        `Date: ${prettyDate(row.date)}`,
        `Period: ${row.periodNumber}${time}`,
        `Class: ${sectionLabel(ctx, row.section)}`,
        `Subject: ${subjectName(ctx, row.subject) || '—'}`,
        `Covering for: ${teacherName(ctx, row.originalTeacher) || '—'}`,
    ];
    if (row.remarks) lines.push(`Remarks: ${row.remarks}`);
    return lines.join('\n');
}

const headline = (ctx, row) => {
    const subj = subjectName(ctx, row.subject);
    const sec  = sectionLabel(ctx, row.section);
    return [sec, subj].filter(Boolean).join(' · ') || `Period ${row.periodNumber}`;
};

async function notifySubstituteAssigned(ctx, row, { changedFrom } = {}) {
    const s = ctx.settings;
    if (!s.notifySubstitute || !row.substituteTeacher) return;
    const sender = await systemSender(ctx.schoolId);
    if (!sender) return;

    notify({
        school: ctx.schoolId,
        sender,
        senderRole: 'system',
        title: `${changedFrom ? 'Substitute class updated' : 'Substitute class assigned'} — ${headline(ctx, row)}`,
        body: `You have been assigned to take a substitute class.\n\n${describe(ctx, row)}`,
        recipients: [row.substituteTeacher],
        email: !!s.emailSubstitute,
    });

    if (s.notifyOriginalTeacher && row.originalTeacher) {
        notify({
            school: ctx.schoolId,
            sender,
            senderRole: 'system',
            title: `Your class will be covered — ${headline(ctx, row)}`,
            body: `${teacherName(ctx, row.substituteTeacher) || 'A colleague'} will take this class in your absence.\n\n${describe(ctx, row)}`,
            recipients: [row.originalTeacher],
        });
    }

    // The teacher who was moved off this period needs to know they are off it.
    if (changedFrom && s.notifyOnChange && sid(changedFrom) !== sid(row.substituteTeacher)) {
        notify({
            school: ctx.schoolId,
            sender,
            senderRole: 'system',
            title: `Substitute class reassigned — ${headline(ctx, row)}`,
            body: `This substitute class has been reassigned to ${teacherName(ctx, row.substituteTeacher) || 'another teacher'}. You no longer need to take it.\n\n${describe(ctx, row)}`,
            recipients: [changedFrom],
        });
    }
}

async function notifySubstituteCancelled(ctx, row, note) {
    if (!ctx.settings.notifyOnChange || !row.substituteTeacher) return;
    const sender = await systemSender(ctx.schoolId);
    if (!sender) return;
    notify({
        school: ctx.schoolId,
        sender,
        senderRole: 'system',
        title: `Substitute class cancelled — ${headline(ctx, row)}`,
        body: `This substitute class has been cancelled${note ? ` (${note})` : ''}. You no longer need to take it.\n\n${describe(ctx, row)}`,
        recipients: [row.substituteTeacher],
    });
}

/* ══════════════════════════════════════════════════════════════════════════
   Mutations
══════════════════════════════════════════════════════════════════════════ */

function historyEntry(event, { to, toName, by, byName, note }) {
    return {
        at: new Date().toISOString(),
        event,
        to:     to     ? sid(to) : null,
        toName: toName || '',
        by:     by     ? sid(by) : null,
        byName: byName || '',
        note:   note   || '',
    };
}

/**
 * Put `substituteTeacherId` on this period. Used by the sweep (via 'auto') and
 * by the admin (via 'manual'); an auto row an admin changes becomes manual, so
 * a human decision is never silently overwritten by the next sweep.
 */
async function assignSubstitute(ctx, row, {
    substituteTeacherId, actor = null, actorName = '', via = 'manual', remarks,
}) {
    const previous = row.substituteTeacher ? sid(row.substituteTeacher) : null;
    const next     = sid(substituteTeacherId);
    const changed  = previous && previous !== next;

    const $set = {
        substituteTeacher: next,
        status:      'assigned',
        assignedVia: via,
        assignedBy:  actor,
        assignedAt:  new Date(),
        notifiedAt:  null,
    };
    if (remarks !== undefined) $set.remarks = String(remarks || '').trim();

    const updated = await SubstituteAssignment.findByIdAndUpdate(
        row._id,
        {
            $set,
            $push: {
                history: historyEntry(changed ? 'changed' : 'assigned', {
                    to: next, toName: teacherName(ctx, next), by: actor, byName: actorName,
                }),
            },
        },
        { new: true },
    );

    const fresh = (updated && updated.toObject) ? updated.toObject() : (updated || { ...row, ...$set });
    await notifySubstituteAssigned(ctx, fresh, { changedFrom: changed ? previous : null });
    await SubstituteAssignment.findByIdAndUpdate(row._id, { $set: { notifiedAt: new Date() } });

    return fresh;
}

/**
 * Withdraw a substitution. The row is kept (never deleted) so the notification
 * trail and the audit history survive; the partial unique index only covers
 * live rows, so the period can be re-covered afterwards.
 */
async function cancelAssignment(ctx, row, { actor = null, actorName = '', note = '' } = {}) {
    const had = !!row.substituteTeacher;
    await SubstituteAssignment.findByIdAndUpdate(row._id, {
        $set: {
            status: 'cancelled',
            cancelledBy: actor,
            cancelledAt: new Date(),
        },
        $push: {
            history: historyEntry('cancelled', {
                to: row.substituteTeacher, toName: teacherName(ctx, row.substituteTeacher),
                by: actor, byName: actorName, note,
            }),
        },
    });
    // Only someone who was actually on the hook needs telling they are off it.
    if (had) await notifySubstituteCancelled(ctx, row, note);
    return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   Auto-assign sweep
══════════════════════════════════════════════════════════════════════════ */

/**
 * Detect today's absences, open a requirement per affected period, and fill
 * each one with the fairest eligible teacher.
 *
 * Idempotent by construction: requirements are keyed on (period, day, teacher)
 * and only rows still 'uncovered' are filled, so a restart mid-sweep or a
 * second timer tick changes nothing. Rows an admin has touched are never
 * re-decided — the sweep only ever fills blanks.
 */
async function runAutoAssign(schoolId, dateLike, { force = false } = {}) {
    const ctx = await buildContext(schoolId, dateLike);
    const result = { created: 0, retired: 0, assigned: 0, uncovered: 0, skipped: 0 };
    if (!ctx.ready) return result;
    if (!(await isWorkingDay(ctx))) return result;

    const absences = await detectAbsences(ctx);
    const ensured  = await ensureRequirements(ctx, absences);
    result.created = ensured.created;
    result.retired = ensured.retired;

    if (!force && !ctx.settings.autoAssign) {
        result.uncovered = await SubstituteAssignment.countDocuments({
            school: schoolId, date: ctx.date, status: 'uncovered',
        });
        return result;
    }

    const open = await SubstituteAssignment.find({
        school: schoolId, date: ctx.date, status: 'uncovered',
    }).lean();
    if (!open.length) return result;

    const busySlots = await busySubstituteSlots(ctx);
    const workloads = await computeWorkloads(ctx, ctx.teachers.map((t) => t._id));

    // Commitments made during this pass, before their rows are re-read.
    const claimed = new Set();
    const extraCount = new Map();
    const extraBusy = {
        has: (k) => claimed.has(k),
        countFor: (tid) => extraCount.get(tid) || 0,
    };

    const nowMin = nowMinutes();
    const isToday = isoOf(ctx.date) === isoOf(todayUtcMidnight());

    for (const row of open.sort((a, b) => a.periodNumber - b.periodNumber)) {
        // A half-day absence doesn't say which half — the admin decides.
        if (row.needsReview) { result.skipped += 1; continue; }

        // Don't auto-assign a period that has already begun; nobody can act on
        // a notification that arrives mid-class. Manual assignment still can.
        if (ctx.settings.skipPeriodsAlreadyStarted && isToday) {
            const start = toMinutes(row.startTime);
            if (start != null && nowMin >= start) { result.skipped += 1; continue; }
        }

        const ranked = candidatesFor(ctx, row, { absences, workloads, busySlots, extraBusy });
        if (!ranked.length) { result.uncovered += 1; continue; }

        const pick = ranked[0];
        await assignSubstitute(ctx, row, {
            substituteTeacherId: pick.teacher._id,
            via: 'auto',
            actor: null,
        });
        const tid = sid(pick.teacher._id);
        claimed.add(`${tid}|${row.periodNumber}`);
        extraCount.set(tid, (extraCount.get(tid) || 0) + 1);
        result.assigned += 1;
    }

    return result;
}

/** Every school with the timetable module on — the sweep's work list. */
async function schoolsToSweep() {
    return School.find({ 'modules.timetable': true }).select('_id').lean();
}

/* ══════════════════════════════════════════════════════════════════════════
   Read models for the UI
══════════════════════════════════════════════════════════════════════════ */

/** Flesh a stored row out with the names the UI shows (spec §6). */
function decorate(ctx, row) {
    const s = ctx.sectionById.get(sid(row.section));
    return {
        _id:          row._id,
        date:         row.date,
        dayOfWeek:    row.dayOfWeek,
        periodNumber: row.periodNumber,
        startTime:    row.startTime,
        endTime:      row.endTime,
        status:       row.status,
        reason:       row.reason,
        needsReview:  !!row.needsReview,
        assignedVia:  row.assignedVia,
        remarks:      row.remarks || '',
        notifiedAt:   row.notifiedAt || null,
        history:      row.history || [],
        section: {
            _id:         row.section,
            sectionName: (s && s.sectionName) || '',
            className:   (s && s.class && s.class.className) || '',
            label:       sectionLabel(ctx, row.section),
        },
        subject: {
            _id:  row.subject,
            name: subjectName(ctx, row.subject),
        },
        originalTeacher: {
            _id:  row.originalTeacher,
            name: teacherName(ctx, row.originalTeacher),
        },
        substituteTeacher: row.substituteTeacher ? {
            _id:  row.substituteTeacher,
            name: teacherName(ctx, row.substituteTeacher),
        } : null,
    };
}

/**
 * Everything the admin board renders for one day: who is away, every affected
 * period grouped under them, and the coverage state of each.
 */
async function getBoard(schoolId, dateLike) {
    const ctx = await buildContext(schoolId, dateLike);
    const working = ctx.ready ? await isWorkingDay(ctx) : false;

    const base = {
        date:      isoOf(ctx.date),
        dayOfWeek: ctx.dayOfWeek,
        isWorkingDay: working,
        hasTimetable: ctx.ready,
        academicYear: ctx.year ? { _id: ctx.year._id, yearName: ctx.year.yearName } : null,
        settings: ctx.settings,
        sources: {
            // What the board is actually able to detect, after the school's
            // module flags are applied. Both false = fully manual (spec §4).
            attendance: !!(ctx.settings.useAttendance && ctx.flags.attendance),
            leave:      !!(ctx.settings.useLeave && ctx.flags.leave),
        },
        absentTeachers: [],
        assignments: [],
        summary: { total: 0, assigned: 0, uncovered: 0, needsReview: 0, cancelled: 0 },
    };
    if (!ctx.ready || !working) return base;

    const absences = await detectAbsences(ctx);
    await ensureRequirements(ctx, absences);

    const rows = await SubstituteAssignment.find({ school: schoolId, date: ctx.date }).lean();
    const decorated = rows
        .map((r) => decorate(ctx, r))
        .sort((a, b) => (a.periodNumber - b.periodNumber)
            || String(a.originalTeacher.name).localeCompare(String(b.originalTeacher.name)));

    // Absent teachers, each with the periods they were due to take. A teacher
    // with nothing scheduled that day is left off the board entirely — they
    // need no cover, and with "attendance not marked" in play that list would
    // otherwise fill up with staff who simply have a free morning.
    const byTeacher = new Map();
    for (const [tid, info] of absences) {
        if (!periodsOf(ctx, tid).length) continue;
        byTeacher.set(tid, {
            teacher: { _id: tid, name: teacherName(ctx, tid) },
            reason: info.reason,
            label: info.label,
            needsReview: !!info.needsReview,
            periods: [],
        });
    }
    for (const row of decorated) {
        if (row.status === 'cancelled') continue;
        const tid = sid(row.originalTeacher._id);
        if (!byTeacher.has(tid)) {
            // A manual substitution for a teacher with no recorded absence.
            byTeacher.set(tid, {
                teacher: { _id: tid, name: row.originalTeacher.name },
                reason: 'manual', label: 'Manual substitution', needsReview: false, periods: [],
            });
        }
        byTeacher.get(tid).periods.push(row);
    }

    base.absentTeachers = [...byTeacher.values()]
        .sort((a, b) => String(a.teacher.name).localeCompare(String(b.teacher.name)));
    base.assignments = decorated;
    base.summary = {
        total:       decorated.filter((r) => r.status !== 'cancelled').length,
        assigned:    decorated.filter((r) => r.status === 'assigned').length,
        uncovered:   decorated.filter((r) => r.status === 'uncovered').length,
        needsReview: decorated.filter((r) => r.status !== 'cancelled' && r.needsReview).length,
        cancelled:   decorated.filter((r) => r.status === 'cancelled').length,
    };
    return base;
}

module.exports = {
    // context & helpers
    buildContext, isWorkingDay, periodsOf, decorate, sectionLabel, subjectName, teacherName,
    weekRange, monthRange, workingDaysIn, isoOf, sid, toMinutes,
    // settings
    getSettings, saveSettings,
    // detection & requirements
    detectAbsences, ensureRequirements,
    // candidates & workload
    computeWorkloads, candidatesFor, busySubstituteSlots,
    // mutations
    assignSubstitute, cancelAssignment,
    // orchestration
    runAutoAssign, schoolsToSweep, getBoard,
    LIVE,
};
