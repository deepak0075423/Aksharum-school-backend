'use strict';
/**
 * Formal exams — the lifecycle, and everything that writes to it.
 *
 *   DRAFT ──open──▶ MARKS_PENDING ──every sheet in──▶ SUBMITTED ──validate──▶ CLASS_APPROVED ──publish──▶ FINAL_APPROVED
 *                        ▲                                 │ reject                 │ reject                    │ withdraw
 *                        │                                 ▼                        ▼                           │
 *                    REOPENED ◀────────reopen──────────  REJECTED ◀─────────────────┘                           │
 *                        ▲                                                                                       │
 *                        └───────────────────────────────────────────────────────────────────────────────────────┘
 *
 * These rules used to live in the request handlers, one copy per caller, and
 * the copies disagreed: a teacher could save marks into an exam that had
 * already been validated; "reopen" changed the exam's status but left every
 * sheet submitted, so nobody could correct anything; results were generated
 * after the reply had gone, so a failure left an exam published with nothing
 * in it. The admin screens and the teacher's endpoints both go through here
 * now, so a step means the same thing whoever takes it.
 *
 * Everything throws a RuleError carrying the HTTP status to answer with; the
 * controllers only translate.
 */
require('../config/timezone');   // the process runs on the school's clock — dayStart() below relies on it
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const ExamMarksSheet = require('../models/ExamMarksSheet');
const FormalResult = require('../models/FormalResult');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const ClassSubject = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject = require('../models/Subject');
const User = require('../models/User');
const ElectiveRoster = require('../models/ElectiveRoster');
const ResultAuditLog = require('../models/ResultAuditLog');
const { isUuid, newId } = require('../db/schema');
const { patch, insert } = require('../db/patch');
const { notify } = require('./notifyService');
const designations = require('./designationService');
const settings = require('./resultSettings');
const schoolClock = require('./schoolClock');
/**
 * Who runs Results for the school: its admins, and any teacher whose
 * designation administers the module (an exam coordinator). Office notices went
 * to school admins alone, so a school that had handed Results to a coordinator
 * left them to find out by looking.
 */
const officeIds = (schoolId) => designations.moduleAdminIds(schoolId, 'result');
const { parentsOf } = require('./parentChildren');
// Lazily: services/resultPromotion is a separate concern, loaded on first use.
const promotion = () => require('./resultPromotion');

/* ── Vocabulary ───────────────────────────────────────────────────────────── */

const EXAM_TYPES = { MID_TERM: 'Mid Term', FINAL: 'Final', UNIT_TEST: 'Unit Test' };

const STATUS_LABELS = {
    DRAFT: 'Draft',
    MARKS_PENDING: 'Mark Entry',
    REOPENED: 'Reopened',
    REJECTED: 'Rejected',
    SUBMITTED: 'Pending Validation',
    CLASS_APPROVED: 'Ready to Publish',
    FINAL_APPROVED: 'Published',
};

/**
 * Where an exam sits in the admin's tabs. Every status belongs to exactly one
 * stage, so the tabs add up to the total (services/resultBoard has the SQL
 * twin of this, and a test holds the two together).
 */
const STAGES = {
    draft: ['DRAFT'],
    marks: ['MARKS_PENDING', 'REOPENED', 'REJECTED'],
    validation: ['SUBMITTED', 'CLASS_APPROVED'],
    published: ['FINAL_APPROVED'],
};
const stageOf = (exam) => {
    if (exam.archivedAt) return 'archived';
    return Object.keys(STAGES).find((k) => STAGES[k].includes(exam.status)) || 'draft';
};

/** Marks may be entered while an exam is in one of these. */
const MARKS_OPEN = ['MARKS_PENDING', 'REOPENED'];

/**
 * The options an exam is created with. A row older than one of them reads
 * NULL there, and NULL reads as the default below — which is exactly what
 * every exam did before the option existed, so nothing had to be backfilled.
 *
 *   showInPortal      students and parents see the published results
 *   includeInOverall  the exam counts towards the year's overall result
 *   allowGraceMarks   a student just short of passing is given the marks (applyGrace)
 *   notifyOnPublish   publishing tells students and parents
 *   showRank          the scorecard families see carries the rank
 */
const OPTION_DEFAULTS = { showInPortal: true, includeInOverall: false, allowGraceMarks: false, notifyOnPublish: true, showRank: true };
const OPTION_LABELS = {
    showInPortal: 'Show in student portal', includeInOverall: 'Include in overall result',
    allowGraceMarks: 'Grace marks', notifyOnPublish: 'Notify on publishing', showRank: 'Show rank',
    promoteOnPass: 'Promote students who pass', promoteSection: 'Promote into', failedPlacement: 'Students who do not pass',
};
const SECTION_MODES = ['same', 'none'];
const MODE_LABELS = { same: 'the same section', none: 'no section' };
// What a final exam set to promote does with the students who do not pass.
const PLACEMENTS = ['stay', 'repeat'];
const PLACEMENT_LABELS = { stay: 'stay where they are', repeat: 'repeat the class next year' };
const GRACE_LIMITS = { perSubject: 20, maxSubjects: 10 };

function optionsOf(exam) {
    const out = {};
    for (const [k, d] of Object.entries(OPTION_DEFAULTS)) out[k] = typeof exam?.[k] === 'boolean' ? exam[k] : d;
    const g = exam?.grace && typeof exam.grace === 'object' ? exam.grace : {};
    out.grace = out.allowGraceMarks
        ? { perSubject: Math.max(0, Number(g.perSubject) || 0), maxSubjects: Math.max(0, Number(g.maxSubjects) || 0) }
        : { perSubject: 0, maxSubjects: 0 };
    // Only a final exam promotes; on any other type the switch reads off.
    out.promoteOnPass = exam?.examType === 'FINAL' && exam?.promoteOnPass === true;
    out.promoteSection = exam?.promoteSection === 'none' ? 'none' : 'same';
    out.failedPlacement = out.promoteOnPass && exam?.failedPlacement === 'repeat' ? 'repeat' : 'stay';
    return out;
}

/**
 * Whether students and parents may see an exam's results today: published,
 * not kept off the portal, and past its result date. Every family-facing
 * reader goes through this — or FAMILY_FILTER, its query half — so no screen
 * can show a mark another would still be hiding.
 */
const FAMILY_FILTER = { status: 'FINAL_APPROVED', showInPortal: { $ne: false } };

/**
 * The instant a stored calendar day begins on the school's clock.
 *
 * Exam days are stored at UTC midnight of the day they mean, which is the right
 * way to keep a DAY and the wrong thing to compare an INSTANT against: UTC
 * midnight is 5:30 in the morning in India. A result dated the 5th was released
 * — to families, and to the promotion that goes with it — at half past five,
 * not when the 5th began. It begins at the SCHOOL's midnight (services/
 * schoolClock: the school's own zone, or the platform's when it names none).
 */
function dayStart(day, schoolId = null) {
    return schoolClock.dayStartIn(day, schoolClock.zoneOf(String(schoolId?._id ?? schoolId ?? '')));
}
/** When an exam's results reach families: the start of its result date, or at once when it has none. */
const releaseAt = (exam) => (exam?.publishDate ? dayStart(exam.publishDate, exam.school) : null);
/** Whether the result date has come (true when there is none). */
function released(exam, now = new Date()) {
    const at = releaseAt(exam);
    return !at || now >= at;
}
function visibleToFamilies(exam, now = new Date()) {
    if (!exam || exam.status !== 'FINAL_APPROVED' || exam.showInPortal === false) return false;
    return released(exam, now);
}
/**
 * The same rule as SQL, for the readers that filter in the query: `col` is the
 * result-date column and `tz` a parameter holding the school's zone. Both
 * sides are compared as calendar days.
 */
const releasedSql = (col, tz) => `(${col} IS NULL OR (${col} AT TIME ZONE 'UTC')::date <= (now() AT TIME ZONE ${tz})::date)`;
/** A result as a family reads it: without the rank when the exam hides ranks. */
function forFamily(result, exam) {
    if (!result || exam?.showRank !== false) return result;
    return { ...result, rank: null };
}

class RuleError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra || null;
    }
}
const fail = (status, message, extra) => { throw new RuleError(status, message, extra); };

/* ── Small helpers ────────────────────────────────────────────────────────── */

const GRADE_BANDS = [[90, 'A+'], [80, 'A'], [70, 'B+'], [60, 'B'], [50, 'C'], [40, 'D']];
function calcGrade(pct) {
    for (const [min, grade] of GRADE_BANDS) if (pct >= min) return grade;
    return 'F';
}

/**
 * A subject's grade, which must never contradict its result.
 *
 * The bands run on percentage and the pass mark is the school's own, per
 * subject — so with the usual pass mark of 33 a student on 35% had PASSED with
 * grade F, and one on 45% with a pass mark of 50 had FAILED with grade D. A
 * scorecard said both things side by side. So: absent is AB, not passed is F,
 * and a pass is never below D, the lowest passing grade.
 */
// The rule itself, on the school's own scale, lives in services/resultSettings;
// these default to the standard scale for callers that have no school to hand.
const gradeFor = (marks, max, passed, absent = false, scale) => settings.gradeFor(marks, max, passed, absent, scale);
const overallGrade = (pct, passed, scale) => settings.overallGrade(pct, passed, scale);

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A calendar day off a form. Exam dates are stored at UTC midnight of the day
 * they mean (what `new Date('2026-10-12')` gives), so they are compared as day
 * numbers and never against a local instant.
 *   null → nothing given,  undefined → given but not a date.
 */
function dayOf(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
    const s = String(v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

const idOf = (v) => String(v?._id ?? v ?? '');
const subjectIdsOf = (exam) => (exam.subjects || []).map((s) => idOf(s.subject)).filter(Boolean);

function audit(exam, action, ctx, notes = '') {
    if (!Array.isArray(exam.auditLog)) exam.auditLog = [];
    const entry = { action, by: ctx.userId, at: new Date(), notes: String(notes || '').trim() };
    exam.auditLog.push(entry);
    return entry;
}
/** A history entry, for a write that appends it itself (writeExam). */
const entryOf = (action, ctx, notes = '', extra = null) => ({
    action, by: String(ctx.userId), at: new Date(), notes: String(notes || '').trim(), ...(extra || {}),
});
/** `"auditLog" || $n` for a statement that appends to the log itself, whatever the column held. */
const APPEND_LOG = (param) => `(CASE WHEN jsonb_typeof("auditLog") = 'array' THEN "auditLog" ELSE '[]'::jsonb END) || ${param}::jsonb`;

const MOVED_ON = 'This exam has moved on since it was opened — reload it and try again';
/**
 * Write these columns of the exam — and only these — with its history entry,
 * provided it still stands where this step found it (`where`).
 *
 * Every step used to change the exam in memory and save() it, which wrote the
 * WHOLE row back from the copy it had read: an office edit that began before
 * the last marks sheet arrived put the exam back in Mark Entry with every
 * sheet in (and nothing would ever move it on), and the history entry the
 * other step had appended vanished; a settings switch could wipe re-exam marks
 * a teacher had just saved. The row as it now is replaces the in-memory copy.
 */
async function writeExam(exam, set, { where = {}, entry = null, q = null, moved = MOVED_ON } = {}) {
    const row = await patch(FormalExam, exam._id, set, { where, push: entry ? { auditLog: entry } : {}, q });
    if (!row) fail(409, moved);
    Object.assign(exam, row);
    return exam;
}

/** The Results trail, for what no exam is left to carry (services/../ResultAuditLog). */
function trail(ctx, actionType, entityType, entityId, description, meta = {}) {
    return ResultAuditLog.create({
        school: ctx.schoolId, user: isUuid(String(ctx.userId || '')) ? ctx.userId : null, role: ctx.userRole || '',
        actionType, entityType, entityId: isUuid(String(entityId || '')) ? entityId : null,
        description: String(description || '').slice(0, 500), meta,
    }).catch((e) => console.error('[results] trail failed:', e.message));
}

async function load(ctx, id) {
    if (!isUuid(String(id || ''))) fail(404, 'Exam not found');
    const exam = await FormalExam.findOne({ _id: id, school: ctx.schoolId });
    if (!exam) fail(404, 'Exam not found');
    return exam;
}

function notArchived(exam, doing) {
    if (exam.archivedAt) fail(400, `This exam is archived — restore it to ${doing}`);
}

/**
 * The students an exam is for: the section's roll, less any id that no longer
 * names a student account. `enrolledStudents` is a list of ids with nothing
 * holding it to the users table, so a deleted account can linger in it.
 *
 * A student whose account has been switched off — left the school — is not on
 * it either, as on the attendance register: they stayed on every marks sheet,
 * and a sheet could not be submitted until each teacher had marked them absent.
 */
async function rosterOf(sectionId) {
    const section = await ClassSection.findById(sectionId).select('enrolledStudents').lean();
    const ids = [...new Set((section?.enrolledStudents || []).map(String).filter(isUuid))];
    if (!ids.length) return [];
    const { rows } = await pool.query(
        `SELECT "_id" FROM "${User.tableName}" WHERE "_id" = ANY($1::uuid[]) AND "role" = 'student' AND "isActive" IS NOT FALSE`, [ids]);
    const real = new Set(rows.map((r) => String(r._id)));
    return ids.filter((id) => real.has(id));
}

/**
 * Who takes each elective subject in a section: Map(subjectId → Set(studentId))
 * for the subjects that have an elective roster (models/ElectiveRoster). A
 * subject with none is taken by the whole roll.
 */
async function takersOf(sectionId, subjectIds = null) {
    const filter = { section: sectionId };
    if (subjectIds) filter.subject = { $in: subjectIds.map(String).filter(isUuid) };
    const rows = await ElectiveRoster.find(filter).select('subject students').lean();
    return new Map(rows.map((r) => [String(r.subject), new Set((r.students || []).map(String))]));
}
/** One subject's roll: the whole roll, or only the students on its elective roster. */
function rollFor(roster, takers, subjectId) {
    const t = takers.get(String(subjectId));
    return t ? roster.filter((id) => t.has(id)) : roster;
}

/** Who teaches the exam's subjects in its section. */
async function subjectTeachersOf(exam) {
    const ids = subjectIdsOf(exam);
    if (!ids.length) return [];
    const rows = await SectionSubjectTeacher.find({ section: exam.section, subject: { $in: ids } }).select('teacher').lean();
    return [...new Set(rows.map((r) => String(r.teacher)))];
}

async function classTeachersOf(exam) {
    const section = await ClassSection.findById(exam.section).select('classTeacher substituteTeacher').lean();
    return [section?.classTeacher, section?.substituteTeacher].filter(Boolean).map(String);
}

/** A notice must never be the reason a step fails. */
function tell(ctx, exam, { title, body, recipients, type = 'results.marks' }) {
    try {
        if (!recipients?.length) return;
        notify({
            school: exam.school, sender: ctx.userId, senderRole: ctx.userRole,
            title, body, recipients, link: { type, entityId: exam._id },
        });
    } catch (e) {
        console.error('[results] notice failed:', e.message);
    }
}

/* ── The exam timetable, as families and teachers hear of it ──────────────── */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A stored day (UTC midnight of the day meant) as its key, "2026-09-16". */
const keyOfDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
/** Today on the school's clock, "2026-09-16". */
const todayOf = (schoolId) => schoolClock.todayIn(schoolClock.zoneOf(String(schoolId?._id ?? schoolId ?? '')));
/**
 * Whether students and parents may see an exam's timetable (on their schedule,
 * and in notices). Until the office shares it the exam is a plan. An exam from
 * before the switch existed (NULL) reads as shared — as every exam was then.
 */
const timetableShared = (exam) => exam?.timetableShared !== false;
const clock = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    if (!m) return '';
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
};
/** A paper's sitting in words: "Mon 16 Sep, 9:30–11:00 am". */
function sittingText(x) {
    if (!x?.examDate) return 'date to be announced';
    const d = new Date(x.examDate);
    const day = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    const a = clock(x.startTime); const b = clock(x.endTime);
    const time = !a ? '' : !b ? a : a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
    return time ? `${day}, ${time}` : day;
}
const sittingKey = (x) => `${keyOfDay(x?.examDate)}|${x?.startTime || ''}|${x?.endTime || ''}`;
/** What of an exam's timetable to compare: its dates, and each paper's sitting. */
const timetableOf = (exam) => ({
    start: keyOfDay(exam.startDate), end: keyOfDay(exam.endDate),
    papers: (exam.subjects || []).map((x) => ({ subject: idOf(x.subject), examDate: x.examDate || null, startTime: x.startTime || '', endTime: x.endTime || '' })),
});

/**
 * Tell the section's families and its teachers when an exam's timetable is
 * set or changes (Oct 2026) — the exam's dates, a paper's day or time, a
 * paper added or taken off. Until now nobody heard: the schedule pages showed
 * the new times to whoever happened to look.
 *
 * Only what is still to come is said: a paper whose old and new days have
 * both gone is a correction to the record, and tells nobody. Families hear of
 * an exam shown on their portal; the subject teachers of the papers that
 * moved, and the class teachers, always. `before` is null for a new exam.
 * A notice is never the reason a step fails.
 */
async function announceTimetable(ctx, exam, before) {
    try {
        // A timetable not yet shared is the office's plan: nobody hears of it.
        if (exam.archivedAt || !timetableShared(exam)) return;
        const today = todayOf(exam.school);
        const now = timetableOf(exam);
        const first = !before;
        const prev = new Map((before?.papers || []).map((x) => [x.subject, x]));
        const nowIds = new Set(now.papers.map((x) => x.subject));
        const moved = [];
        for (const x of now.papers) {
            const was = prev.get(x.subject) || null;
            if (was && sittingKey(was) === sittingKey(x)) continue;
            if (!x.examDate && !was?.examDate) continue;
            if (!(keyOfDay(x.examDate) >= today || keyOfDay(was?.examDate) >= today)) continue;
            moved.push({ subject: x.subject, now: x, was });
        }
        const off = (before?.papers || []).filter((x) => !nowIds.has(x.subject) && x.examDate && keyOfDay(x.examDate) >= today);
        const datesMoved = !first && (before.start !== now.start || before.end !== now.end) && now.end >= today;
        if (first && now.end < today) return;
        if (!first && !moved.length && !off.length && !datesMoved) return;
        if (first && !moved.length && !now.start) return;

        const ids = [...new Set([...moved.map((m) => m.subject), ...off.map((x) => x.subject)])];
        const subs = ids.length ? await Subject.find({ _id: { $in: ids } }).select('subjectName').lean() : [];
        const nameOf = (sid) => subs.find((x) => String(x._id) === String(sid))?.subjectName || 'A subject';
        const range = (a, b) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);
        const lines = [];
        if (first) lines.push(`Dates: ${range(now.start, now.end)}`);
        else if (datesMoved) lines.push(`Dates: ${range(now.start, now.end)} (was ${range(before.start, before.end)})`);
        moved.forEach((m) => lines.push(`${nameOf(m.subject)}: ${sittingText(m.now)}${!first && m.was?.examDate ? ` (was ${sittingText(m.was)})` : ''}`));
        off.forEach((x) => lines.push(`${nameOf(x.subject)}: taken off the exam (was ${sittingText(x)})`));
        const body = `${lines.slice(0, 9).join('\n')}${lines.length > 9 ? `\n…and ${lines.length - 9} more` : ''}`;

        const section = await ClassSection.findById(exam.section).select('classTeacher substituteTeacher').lean();
        const links = ids.length ? await SectionSubjectTeacher.find({ section: exam.section, subject: { $in: ids } }).select('teacher').lean() : [];
        const teachers = [...new Set([section?.classTeacher, section?.substituteTeacher, ...links.map((l) => l.teacher)].map(idOf).filter(Boolean))];
        const families = optionsOf(exam).showInPortal ? await familyOf(exam.school, await rosterOf(exam.section)) : [];
        tell(ctx, exam, {
            title: first ? `📅 Exam timetable: ${exam.title}` : `📅 Exam timetable changed: ${exam.title}`,
            body, recipients: [...new Set([...teachers, ...families])], type: 'results.schedule',
        });
    } catch (e) {
        console.error('[results] timetable notice failed:', e.message);
    }
}

/**
 * The exam will not be sat after all — a draft deleted, an exam put away —
 * so whoever its shared timetable reached is told it is off. A deleted draft
 * used to vanish from every schedule without a word, after families had been
 * told its dates.
 */
async function announceCancelled(ctx, exam, how = 'cancelled') {
    try {
        if (!timetableShared(exam)) return;
        const today = todayOf(exam.school);
        const ahead = keyOfDay(exam.endDate) >= today || (exam.subjects || []).some((x) => x.examDate && keyOfDay(x.examDate) >= today);
        if (!ahead) return;
        const ids = subjectIdsOf(exam);
        const [section, links, roll] = await Promise.all([
            ClassSection.findById(exam.section).select('classTeacher substituteTeacher').lean(),
            ids.length ? SectionSubjectTeacher.find({ section: exam.section, subject: { $in: ids } }).select('teacher').lean() : [],
            rosterOf(exam.section),
        ]);
        const teachers = [...new Set([section?.classTeacher, section?.substituteTeacher, ...links.map((l) => l.teacher)].map(idOf).filter(Boolean))];
        const families = optionsOf(exam).showInPortal ? await familyOf(exam.school, roll) : [];
        const range = keyOfDay(exam.startDate) === keyOfDay(exam.endDate) ? fmtDay(exam.startDate) : `${fmtDay(exam.startDate)} – ${fmtDay(exam.endDate)}`;
        tell(ctx, exam, {
            title: `📅 Exam ${how}: ${exam.title}`,
            body: `"${exam.title}" (${range}) has been ${how} by the school, and its papers are off the exam schedule.`,
            recipients: [...new Set([...teachers, ...families])], type: 'results.schedule',
        });
    } catch (e) {
        console.error('[results] cancellation notice failed:', e.message);
    }
}

/* ── Creating and editing ─────────────────────────────────────────────────── */

/**
 * The subject rows of an exam, checked. `locked` is the list an exam already
 * has once marks entry has opened: from then on only a paper's date and times
 * may move — the subjects themselves and their marks are what teachers have
 * been entering against.
 *
 * `sittings(rows)` splits the list into the papers one student actually sits —
 * a form for several classes hands over every class's subjects at once, and
 * two papers clash only where one class has both. Left out, it is one sitting.
 */
/**
 * A paper's parts, checked: 2 to 4 of them, each named once, each out of a
 * whole number of marks, with a pass mark no more than its maximum (0 — the
 * part has no pass mark of its own). Null for a paper in one piece.
 */
function cleanComponents(name, raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    if (raw.length < 2 || raw.length > 4) fail(400, `${name}: a paper is split into 2 to 4 parts`);
    const keys = new Set();
    return raw.map((c, j) => {
        const label = String(c?.label ?? '').trim();
        if (!label) fail(400, `${name}: part ${j + 1} needs a name`);
        if (label.length > 30) fail(400, `${name}: "${label}" is too long for a part (30 characters at most)`);
        let key = String(c?.key || settings.keyFrom(label)).slice(0, 30);
        if (keys.has(key)) key = `${key}_${j + 1}`;
        if ([...keys].some((k) => k.toLowerCase() === key.toLowerCase())) fail(400, `${name}: two parts are called "${label}"`);
        keys.add(key);
        const max = Number(c?.maxMarks);
        const pass = c?.passingMarks === '' || c?.passingMarks === null || c?.passingMarks === undefined ? 0 : Number(c.passingMarks);
        if (!Number.isFinite(max) || max < 1 || max > 1000) fail(400, `${name}: ${label} is out of 1 to 1000 marks`);
        if (!Number.isFinite(pass) || pass < 0 || pass > max) fail(400, `${name}: ${label}'s pass mark is between 0 and ${max}`);
        return { key, label, maxMarks: round2(max), passingMarks: round2(pass) };
    });
}

async function cleanSubjects(schoolId, list, { start, end }, { sittings, mayOverlap } = {}) {
    if (!Array.isArray(list) || !list.length) fail(400, 'Add at least one subject to the exam');

    const ids = list.map((s) => idOf(s?.subject));
    if (ids.some((id) => !isUuid(id))) fail(400, 'One of the subjects is not valid');
    if (new Set(ids).size !== ids.length) fail(400, 'A subject appears twice on the list');

    const found = await Subject.find({ _id: { $in: ids }, school: schoolId }).select('subjectName').lean();
    const nameOf = new Map(found.map((s) => [String(s._id), s.subjectName]));
    if (nameOf.size !== ids.length) fail(400, 'One of the subjects does not belong to this school');

    const out = list.map((raw, i) => {
        const id = ids[i];
        const name = nameOf.get(id);
        // Graded, not marked: no marks to check — the paper is out of nothing.
        const gradeOnly = raw.gradeOnly === true || raw.gradeOnly === 'true';
        const components = gradeOnly ? null : cleanComponents(name, raw.components);
        // A paper in parts is out of what its parts add up to.
        const max = gradeOnly ? 100 : components ? round2(components.reduce((t, c) => t + c.maxMarks, 0)) : Number(raw.maxMarks);
        const pass = gradeOnly ? 0 : (raw.passingMarks === '' || raw.passingMarks === null || raw.passingMarks === undefined) && components
            ? round2(components.reduce((t, c) => t + c.passingMarks, 0)) : Number(raw.passingMarks);
        if (!Number.isFinite(max) || max < 1) fail(400, `${name}: maximum marks must be 1 or more`);
        if (max > 1000) fail(400, `${name}: maximum marks cannot be more than 1000`);
        if (!Number.isFinite(pass) || pass < 0) fail(400, `${name}: passing marks cannot be negative`);
        if (pass > max) fail(400, `${name}: passing marks cannot be more than the maximum (${max})`);

        const examDate = dayOf(raw.examDate);
        if (examDate === undefined) fail(400, `${name}: the paper's date is not a valid date`);
        if (examDate && (examDate < start || examDate > end)) {
            fail(400, `${name}: the paper is dated outside the exam (${fmtDay(start)} – ${fmtDay(end)})`);
        }
        // A paper's sitting, as the school's wall clock says it ("09:30").
        const time = (v, what) => {
            const t = String(v ?? '').trim();
            if (!t) return '';
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail(400, `${name}: the ${what} time is not a valid time`);
            return t;
        };
        const startTime = time(raw.startTime, 'start');
        const endTime = time(raw.endTime, 'end');
        if (endTime && !startTime) fail(400, `${name}: give the time the paper starts as well as when it ends`);
        if (startTime && endTime && endTime <= startTime) fail(400, `${name}: the paper cannot end before it starts`);
        if ((startTime || endTime) && !examDate) fail(400, `${name}: give the paper a date to go with its time`);
        return {
            subject: id, maxMarks: round2(max), passingMarks: round2(pass), assignedTeachers: [],
            examDate: examDate || null, startTime, endTime, order: i,
            components, gradeOnly,
        };
    });

    // One student sits every paper of their exam, so two papers that overlap
    // on the same day cannot both be sat. Papers with no time yet are not
    // compared — nor two electives nobody takes both of (Sanskrit and French
    // in the same slot is how electives are usually set).
    for (const papers of (sittings ? sittings(out) : [out])) {
        const timed = papers.filter((x) => x.examDate && x.startTime);
        for (let a = 0; a < timed.length; a += 1) {
            for (let b = a + 1; b < timed.length; b += 1) {
                const [x, y] = [timed[a], timed[b]];
                if (x.examDate.getTime() !== y.examDate.getTime()) continue;
                const xEnd = x.endTime || x.startTime;
                const yEnd = y.endTime || y.startTime;
                if ((x.startTime < yEnd && y.startTime < xEnd) || x.startTime === y.startTime) {
                    if (mayOverlap && mayOverlap(x.subject, y.subject)) continue;
                    fail(400, `${nameOf.get(x.subject)} and ${nameOf.get(y.subject)} overlap on ${fmtDay(x.examDate)} — a student cannot sit both`);
                }
            }
        }
    }
    return out;
}

/**
 * Two subjects' papers may share a sitting when, in every one of these
 * sections, both are electives and nobody takes both.
 */
async function electiveOverlap(sectionIds) {
    const rows = await ElectiveRoster.find({ section: { $in: sectionIds.map(String) } }).select('section subject students').lean();
    const bySection = new Map();
    rows.forEach((r) => {
        const k = String(r.section);
        if (!bySection.has(k)) bySection.set(k, new Map());
        bySection.get(k).set(String(r.subject), new Set((r.students || []).map(String)));
    });
    return (a, b) => sectionIds.every((sid) => {
        const m = bySection.get(String(sid));
        const x = m?.get(String(a)); const y = m?.get(String(b));
        if (!x || !y) return false;
        for (const s of x) if (y.has(s)) return false;
        return true;
    });
}

/**
 * `types` is the school's exam types (services/resultSettings). The form sends
 * the TYPE's key; the exam stores what it behaves as (examType — one of the
 * three kinds) beside the type's own key and name. A switched-off type is kept
 * by an exam already created as it, and offered to no new one.
 */
function cleanBasics(body, current = {}, types = settings.BUILT_IN, conf = null) {
    const title = String(body.title ?? current.title ?? '').trim();
    if (!title) fail(400, 'Give the exam a name');
    if (title.length > 120) fail(400, 'The exam name is too long (120 characters at most)');

    const had = settings.typeKeyOf(current);
    const wanted = String(body.examType ?? had ?? '');
    const type = types.find((t) => t.key === wanted) || (wanted && wanted === had && EXAM_TYPES[current.examType]
        ? { key: had, label: settings.typeLabelOf(current), kind: current.examType, active: true } : null);
    if (!type) fail(400, 'Choose the type of exam');
    if (type.active === false && wanted !== had) fail(400, `"${type.label}" has been switched off — choose another type`);
    const examType = type.kind;

    const start = dayOf(body.startDate ?? current.startDate);
    const end = dayOf(body.endDate ?? current.endDate);
    if (!start) fail(400, 'Choose the date the exam starts');
    if (!end) fail(400, 'Choose the date the exam ends');
    if (end < start) fail(400, 'The exam cannot end before it starts');

    const publishRaw = body.publishDate !== undefined ? body.publishDate : current.publishDate;
    const publishDate = dayOf(publishRaw);
    if (publishDate === undefined) fail(400, 'The result date is not a valid date');
    if (publishDate && publishDate < end) fail(400, 'Results cannot be dated before the exam ends');

    // The office's own reference, kept in capitals (the ORM has no `uppercase`).
    // It names a cycle, so the sections of one exam share it and it is not unique.
    const code = String(body.code ?? current.code ?? '').trim().toUpperCase();
    if (code.length > 20) fail(400, 'The exam code is too long (20 characters at most)');
    if (code && !/^[A-Z0-9][A-Z0-9 ._/-]*$/.test(code)) fail(400, 'The exam code may use letters, digits, spaces and . _ / - only');

    const description = String(body.description ?? current.description ?? '').trim();
    if (description.length > 500) fail(400, 'The description is too long (500 characters at most)');

    // The school's term this exam belongs to — one of its terms, or none.
    const term = String(body.term ?? current.term ?? '').trim();
    if (term && conf && !conf.terms.some((t) => t.key === term) && term !== (current.term || '')) fail(400, 'Choose one of the school\'s terms');

    // When the subject teachers' marks are due.
    const dueRaw = body.marksDueDate !== undefined ? body.marksDueDate : current.marksDueDate;
    const marksDueDate = dayOf(dueRaw);
    if (marksDueDate === undefined) fail(400, 'The marks due date is not a valid date');
    if (marksDueDate && marksDueDate < start) fail(400, 'Marks cannot be due before the exam starts');
    if (marksDueDate && publishDate && marksDueDate > publishDate) fail(400, 'Marks cannot be due after the result date');

    return {
        title, examType, typeKey: type.key, typeLabel: type.label, code, description, start, end, publishDate: publishDate || null,
        term, marksDueDate: marksDueDate || null, marksDueGiven: dueRaw !== undefined && dueRaw !== null && dueRaw !== '',
    };
}
/** A stored day plus n days. */
const plusDays = (day, n) => { const d = new Date(day); d.setUTCDate(d.getUTCDate() + n); return d; };

const flag = (v) => {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    return undefined;
};

/**
 * The form's options, checked. What the body leaves out keeps its current
 * value (or the default, for a new exam). Grace needs both of its limits when
 * it is on, and is stored as zeros when it is off.
 */
function cleanOptions(body, current = {}) {
    const now = optionsOf(current);
    const out = {};
    for (const k of Object.keys(OPTION_DEFAULTS)) {
        const v = flag(body[k]);
        out[k] = v === undefined ? now[k] : v;
    }
    // Promotion: final exams only — on any other type it is simply off.
    const type = body.examType ?? current.examType;
    const promote = flag(body.promoteOnPass);
    out.promoteOnPass = type === 'FINAL' && (promote === undefined ? (current.promoteOnPass === true) : promote);
    const mode = body.promoteSection ?? current.promoteSection ?? 'same';
    if (!SECTION_MODES.includes(mode)) fail(400, 'Choose where promoted students go: the same section, or no section');
    out.promoteSection = mode;
    const placement = body.failedPlacement ?? current.failedPlacement ?? 'stay';
    if (!PLACEMENTS.includes(placement)) fail(400, 'Choose what happens to students who do not pass: they stay where they are, or repeat the class next year');
    out.failedPlacement = out.promoteOnPass ? placement : 'stay';
    if (!out.allowGraceMarks) {
        out.grace = { perSubject: 0, maxSubjects: 0 };
        return out;
    }
    const g = body.grace !== undefined && body.grace !== null ? body.grace : now.grace;
    const per = Number(g?.perSubject);
    const subjects = Number(g?.maxSubjects);
    if (!Number.isInteger(per) || per < 1 || per > GRACE_LIMITS.perSubject) {
        fail(400, `Grace marks: give between 1 and ${GRACE_LIMITS.perSubject} marks in a subject`);
    }
    if (!Number.isInteger(subjects) || subjects < 1 || subjects > GRACE_LIMITS.maxSubjects) {
        fail(400, `Grace marks: allow them in between 1 and ${GRACE_LIMITS.maxSubjects} subjects`);
    }
    out.grace = { perSubject: per, maxSubjects: subjects };
    return out;
}

/**
 * The subjects each class may be examined in, for the chosen sections: what is
 * linked to the class, and anything actually taught in one of those sections.
 *   → Map(classId → Set(subjectId))
 */
async function offeredByClass(sectionIds) {
    const ids = [...new Set((sectionIds || []).map(String).filter(isUuid))];
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(`
        WITH sec AS (SELECT "_id", "class" FROM "${ClassSection.tableName}" WHERE "_id" = ANY($1::uuid[]) AND "class" IS NOT NULL)
        SELECT cs."class"::text AS "class", cs."subject"::text AS "subject"
          FROM "${ClassSubject.tableName}" cs WHERE cs."class" IN (SELECT "class" FROM sec)
        UNION
        SELECT sec."class"::text, st."subject"::text
          FROM "${SectionSubjectTeacher.tableName}" st JOIN sec ON sec."_id" = st."section"`, [ids]);
    for (const r of rows) {
        if (!out.has(r.class)) out.set(r.class, new Set());
        out.get(r.class).add(r.subject);
    }
    return out;
}

/**
 * Create one exam per chosen section.
 *
 * A school sits "Mid Term" as a class, not a section at a time, but each
 * section has its own teachers, its own marks sheets and its own class teacher
 * to validate them — so the grain stays one exam per section and the form may
 * simply name several. The academic year is the SECTIONS' year: it used to be
 * whichever year was active, which mislabelled any exam set for another one.
 *
 * The sections may span several classes. With one class every subject on the
 * form is that class's, as it always was. With several, each class sits only
 * the subjects it is taught (offeredByClass) — Class 9's Sanskrit paper is not
 * Class 6's — and a class left with none of the chosen subjects is refused by
 * name rather than given an exam with nothing in it.
 */
async function createExams(ctx, body) {
    const conf = await settings.get(ctx.schoolId);
    const basics = cleanBasics(body, {}, conf.examTypes, conf);
    const options = cleanOptions({ ...body, examType: basics.examType });

    const sectionIds = [...new Set([].concat(body.sectionIds || [], body.sectionId || []).map(idOf))].filter(Boolean);
    if (!sectionIds.length) fail(400, 'Choose at least one section');
    if (sectionIds.some((id) => !isUuid(id))) fail(400, 'One of the sections is not valid');
    if (sectionIds.length > 60) fail(400, 'Create an exam for at most 60 sections at a time');

    // In the order they were asked for: the database hands rows back in no
    // promised order, and the first exam made is the one the reply names.
    const sections = (await ClassSection.find({ _id: { $in: sectionIds }, school: ctx.schoolId }).lean())
        .sort((a, b) => sectionIds.indexOf(String(a._id)) - sectionIds.indexOf(String(b._id)));
    if (sections.length !== sectionIds.length) fail(400, 'One of the sections does not belong to this school');
    const years = new Set(sections.map((s) => String(s.academicYear)));
    if (years.size > 1) fail(400, 'Choose sections from one academic year');
    const yearAsked = idOf(body.academicYear);
    if (isUuid(yearAsked) && !years.has(yearAsked)) fail(400, 'The sections chosen are not in that academic year');

    // Several classes: each sits only what it is taught, so that is also what
    // can clash — Class 6's paper and Class 8's may well share a morning.
    const classIds = [...new Set(sections.map((s) => idOf(s.class)))];
    const offered = classIds.length > 1 ? await offeredByClass(sectionIds) : null;
    const mayOverlap = await electiveOverlap(sectionIds);
    const subjects = await cleanSubjects(ctx.schoolId, body.subjects, basics,
        offered ? { sittings: (rows) => classIds.map((c) => rows.filter((s) => offered.get(c)?.has(s.subject))), mayOverlap } : { mayOverlap });

    let subjectsOf = () => subjects;
    if (offered) {
        const perClass = new Map(classIds.map((c) => [c, subjects
            .filter((s) => offered.get(c)?.has(s.subject))
            .map((s, i) => ({ ...s, order: i }))]));
        const bare = classIds.filter((c) => !perClass.get(c).length);
        if (bare.length) {
            const named = await Class.find({ _id: { $in: bare.filter(isUuid) } }).select('className classNumber').lean();
            const names = named.sort((a, b) => (a.classNumber ?? 0) - (b.classNumber ?? 0)).map((c) => c.className);
            fail(400, `None of the chosen subjects is taught in ${names.join(', ') || 'one of the classes'} — choose one of its subjects or leave it out`,
                { code: 'CLASS_WITHOUT_SUBJECTS', classes: names });
        }
        subjectsOf = (section) => perClass.get(idOf(section.class));
    }

    const openNow = body.openMarksEntry === true || body.openMarksEntry === 'true';
    // Shared with families at once unless the form says otherwise — what every
    // exam did before the choice existed.
    const share = flag(body.shareTimetable ?? body.timetableShared);
    // Marks are due by the date given, else the school's default after the end.
    const marksDueDate = basics.marksDueGiven ? basics.marksDueDate
        : (conf.marksDueDays !== null && conf.marksDueDays !== undefined ? plusDays(basics.end, conf.marksDueDays) : null);

    // The check for the same exam twice and the creating are one step, one
    // school at a time: they used to be two, so two quick clicks both found no
    // clash and both created — and a failure part-way through several sections
    // left some created and some not.
    const made = await pool.withTransaction(async (q) => {
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`results:exams:${ctx.schoolId}`]);
        await assertNewTitle(ctx.schoolId, sectionIds, basics.typeKey, basics.title, { q });
        const out = [];
        for (const section of sections) {
            const exam = new FormalExam({
                school: ctx.schoolId, academicYear: section.academicYear, section: section._id,
                title: basics.title, examType: basics.examType, typeKey: basics.typeKey, typeLabel: basics.typeLabel,
                code: basics.code, description: basics.description, term: basics.term,
                subjects: subjectsOf(section),
                startDate: basics.start, endDate: basics.end, publishDate: basics.publishDate, marksDueDate,
                ...options,
                timetableShared: share === undefined ? true : share,
                status: 'DRAFT', createdBy: ctx.userId, auditLog: [entryOf('CREATED', ctx)],
            });
            await insert(FormalExam, exam, { q });
            out.push(exam);
        }
        return out;
    });
    if (openNow) for (const exam of made) await openMarksEntry(ctx, exam._id, exam);
    // Each section's families and teachers hear of the new exam's dates —
    // once its timetable is shared.
    for (const exam of made) announceTimetable(ctx, exam, null);
    return made;
}

/**
 * The same exam twice for one section is a slip of the form, and a costly one
 * to notice after teachers have split their marks across the two. Checked on
 * creating and on renaming alike (`except` — the exam being renamed).
 */
async function assertNewTitle(schoolId, sectionIds, typeKey, title, { q = null, except = null } = {}) {
    const run = q || ((sql, p) => pool.query(sql, p));
    const { rows: clashes } = await run(
        `SELECT s."sectionName", c."className"
           FROM "${FormalExam.tableName}" e
           JOIN "${ClassSection.tableName}" s ON s."_id" = e."section"
           LEFT JOIN "${Class.tableName}" c ON c."_id" = s."class"
          WHERE e."school" = $1::uuid AND e."section" = ANY($2::uuid[]) AND e."archivedAt" IS NULL
            AND COALESCE(NULLIF(e."typeKey", ''), e."examType") = $3 AND lower(btrim(e."title")) = lower(btrim($4))
            AND ($5::uuid IS NULL OR e."_id" <> $5::uuid)`,
        [String(schoolId), sectionIds.map(String), typeKey, title, except ? String(except) : null]);
    if (clashes.length) {
        const names = clashes.map((r) => [r.className, r.sectionName].filter(Boolean).join(' – ')).sort();
        fail(409, `"${title}" already exists for ${names.join(', ')}`, { code: 'EXAM_EXISTS', sections: names });
    }
}

/**
 * What may still change once the results are out: what the exam is CALLED.
 * Its dates, subjects, marks and grace are what the published results were
 * worked out from, and stay fixed — but a typo in the title is not a reason to
 * withdraw every student's result, which was the only way to correct one.
 */
const RENAMABLE = ['title', 'code', 'description'];

/** A paper's shape — its parts and whether it is graded — to compare two versions of it. */
const shapeOfPaper = (x) => JSON.stringify([!!x?.gradeOnly, (Array.isArray(x?.components) ? x.components : [])
    .map((c) => [c.key, Number(c.maxMarks), Number(c.passingMarks)])]);

async function updateExam(ctx, id, body) {
    const exam = await load(ctx, id);
    notArchived(exam, 'edit it');
    const conf = await settings.get(ctx.schoolId);
    if (exam.status === 'FINAL_APPROVED') {
        const other = Object.keys(body || {}).filter((k) => !RENAMABLE.includes(k) && body[k] !== undefined);
        if (other.length || !Object.keys(body || {}).length) {
            fail(400, 'Published results cannot be edited — withdraw them first. Only the name, code and description can still change.');
        }
        const basics = cleanBasics({ title: body.title, code: body.code, description: body.description }, exam, conf.examTypes, conf);
        const was = [exam.title, exam.code || '', exam.description || ''];
        if (was[0] !== basics.title || was[1] !== basics.code || was[2] !== basics.description) {
            // Renaming onto another exam's name for the same section made the
            // duplicate that creating refuses.
            if (was[0].trim().toLowerCase() !== basics.title.trim().toLowerCase()) {
                await assertNewTitle(ctx.schoolId, [exam.section], settings.typeKeyOf(exam), basics.title, { except: exam._id });
            }
            await writeExam(exam, { title: basics.title, code: basics.code, description: basics.description }, {
                where: { status: 'FINAL_APPROVED', archivedAt: null },
                entry: entryOf('RENAMED', ctx, was[0] !== basics.title ? `was "${was[0]}"` : ''),
            });
        }
        return exam;
    }

    // The old screen opened marks entry by PUTting a status; keep honouring it.
    if (body.status === 'MARKS_PENDING' && exam.status === 'DRAFT' && Object.keys(body).length === 1) {
        return openMarksEntry(ctx, id, exam);
    }

    const draft = exam.status === 'DRAFT';
    // The timetable as it stood, to tell families and teachers what moved.
    const timetableBefore = timetableOf(exam);
    const sharedBefore = timetableShared(exam);
    const basics = cleanBasics(body, exam, conf.examTypes, conf);
    if (!draft && basics.typeKey !== settings.typeKeyOf(exam)) fail(400, 'The exam type is fixed once marks entry has opened');
    // Every option may still change here: grace is applied when the results
    // are worked out, which is at publishing — and published exams are refused above.
    const options = cleanOptions({ ...body, examType: basics.examType }, exam);
    if (basics.title.trim().toLowerCase() !== String(exam.title).trim().toLowerCase() || basics.typeKey !== settings.typeKeyOf(exam)) {
        await assertNewTitle(ctx.schoolId, [exam.section], basics.typeKey, basics.title, { except: exam._id });
    }

    // Only what this edit is about is written: every column it does not name
    // keeps whatever another step has put there since this edit began.
    const set = {
        title: basics.title, examType: basics.examType, typeKey: basics.typeKey, typeLabel: basics.typeLabel,
        code: basics.code, description: basics.description, term: basics.term,
        startDate: basics.start, endDate: basics.end, publishDate: basics.publishDate, marksDueDate: basics.marksDueDate,
        ...options,
    };
    const share = flag(body.shareTimetable ?? body.timetableShared);
    if (share !== undefined) set.timetableShared = share;

    let added = []; let removed = []; let notes = '';
    if (body.subjects !== undefined) {
        const next = await cleanSubjects(ctx.schoolId, body.subjects, basics, { mayOverlap: await electiveOverlap([exam.section]) });
        if (draft) {
            set.subjects = next;
        } else if (MARKS_OPEN.includes(exam.status)) {
            // Mark entry is open. A paper left off the exam used to be a dead
            // end: the subjects were fixed, and going back to draft is refused
            // once anybody has entered a mark. Now a paper can be added, one
            // nobody has entered marks for taken off, and a maximum changed —
            // never under marks already entered against it. A pass mark can
            // change freely: it is applied when the results are worked out.
            const current = new Map((exam.subjects || []).map((x) => [idOf(x.subject), x]));
            const nextIds = new Set(next.map((x) => x.subject));
            const sheets = await ExamMarksSheet.find({ exam: exam._id }).select('subject entries').lean();
            const entered = new Map(sheets.map((sh) => [String(sh.subject),
                (sh.entries || []).filter((e) => e.isAbsent || (e.marksObtained !== null && e.marksObtained !== undefined)).length]));
            const named = await Subject.find({ _id: { $in: [...new Set([...current.keys(), ...nextIds])] } }).select('subjectName').lean();
            const nameOf = (id) => named.find((x) => String(x._id) === String(id))?.subjectName || 'A subject';
            for (const id of current.keys()) {
                if (!nextIds.has(id) && entered.get(id)) fail(400, `${nameOf(id)} already has marks entered — it cannot be taken off the exam`);
            }
            for (const n of next) {
                const was = current.get(n.subject);
                if (was && Number(was.maxMarks) !== Number(n.maxMarks) && entered.get(n.subject)) {
                    fail(400, `${nameOf(n.subject)} already has marks entered out of ${was.maxMarks} — its maximum marks cannot change now`);
                }
                if (was && shapeOfPaper(was) !== shapeOfPaper(n) && entered.get(n.subject)) {
                    fail(400, `${nameOf(n.subject)} already has marks entered — how it is marked (its parts, or graded only) cannot change now`);
                }
            }
            removed = [...current.keys()].filter((id) => !nextIds.has(id));
            added = next.filter((n) => !current.has(n.subject)).map((n) => n.subject);
            set.subjects = next.map((n) => {
                const was = current.get(n.subject);
                return was ? { ...was, ...n, assignedTeachers: was.assignedTeachers || [] } : n;
            });
            notes = [
                added.length ? `Added ${added.map(nameOf).join(', ')}` : '',
                removed.length ? `Took off ${removed.map(nameOf).join(', ')}` : '',
            ].filter(Boolean).join('; ');
        } else {
            // The marks have gone forward for validation against these subjects
            // and totals: only when a paper is sat may still move.
            const byId = new Map(next.map((s) => [s.subject, s]));
            const same = next.length === (exam.subjects || []).length && (exam.subjects || []).every((s) => {
                const n = byId.get(idOf(s.subject));
                return n && Number(n.maxMarks) === Number(s.maxMarks) && Number(n.passingMarks) === Number(s.passingMarks)
                    && shapeOfPaper(n) === shapeOfPaper(s);
            });
            if (!same) fail(400, 'The marks have been submitted, so the subjects and their marks are fixed — paper dates and times can still change. Reopen the exam to change a subject.');
            set.subjects = (exam.subjects || []).map((s) => {
                const n = byId.get(idOf(s.subject));
                return { ...s, examDate: n.examDate, startTime: n.startTime, endTime: n.endTime };
            });
        }
    } else {
        // New dates must still hold every paper already scheduled.
        const stray = (exam.subjects || []).find((s) => s.examDate && (new Date(s.examDate) < basics.start || new Date(s.examDate) > basics.end));
        if (stray) fail(400, 'A paper is dated outside the new exam dates — change that paper first');
    }

    // The exam must still be at the step these rules were checked against: an
    // edit that began before the last sheet arrived is refused, not written
    // over the step that sheet took.
    await writeExam(exam, set, { where: { status: exam.status, archivedAt: null }, entry: entryOf('UPDATED', ctx, notes) });
    // Shared just now: everyone hears the timetable as new. Already shared:
    // they hear what moved.
    if (!sharedBefore && timetableShared(exam)) announceTimetable(ctx, exam, null);
    else announceTimetable(ctx, exam, timetableBefore);

    // A paper taken off takes its empty sheet with it — and may have been the
    // last one outstanding, so the exam can now go to the class teacher.
    if (removed.length) {
        await ExamMarksSheet.deleteMany({ exam: exam._id, subject: { $in: removed } });
        await advanceIfComplete(ctx, exam);
    }
    // A paper added while marks are being entered: its teachers are told, as
    // opening mark entry told everyone else.
    if (added.length) {
        const teachers = await SectionSubjectTeacher.find({ section: exam.section, subject: { $in: added } }).select('teacher').lean().catch(() => []);
        tell(ctx, exam, {
            title: `📝 Marks entry open: ${exam.title}`,
            body: `A subject you teach has been added to "${exam.title}". Enter and submit its marks.`,
            recipients: [...new Set(teachers.map((t) => String(t.teacher)))],
        });
    }
    return exam;
}

/**
 * The options that still mean something once the results are out: who sees
 * them, whether they count towards the overall result, whether the rank shows.
 * Any of these may change at any step, archived or not — hiding an old exam's
 * results from families is exactly the kind of thing done to an archived one.
 * Grace marks change the results themselves, so they are set through
 * updateExam, which refuses a published exam.
 */
const LIVE_OPTIONS = ['showInPortal', 'includeInOverall', 'showRank', 'notifyOnPublish'];
async function setOptions(ctx, id, body = {}) {
    const exam = await load(ctx, id);
    const before = optionsOf(exam);
    const changed = [];
    const set = {};
    for (const k of LIVE_OPTIONS) {
        const v = flag(body[k]);
        if (v === undefined || v === before[k]) continue;
        set[k] = v;
        changed.push(k);
    }
    // The timetable, shared with families (or taken back while it is still a plan).
    const share = flag(body.timetableShared ?? body.shareTimetable);
    const sharedBefore = timetableShared(exam);
    if (share !== undefined && share !== sharedBefore) {
        set.timetableShared = share;
        changed.push('timetableShared');
    }

    // Promotion: free to change until it has moved somebody. After that the
    // moves are facts — withdrawing the results is what takes them back.
    const promote = flag(body.promoteOnPass);
    const mode = body.promoteSection;
    const placement = body.failedPlacement;
    const promoteChanges = (promote !== undefined && promote !== before.promoteOnPass) || (mode !== undefined && mode !== before.promoteSection)
        || (placement !== undefined && placement !== before.failedPlacement);
    if (promoteChanges) {
        if (exam.examType !== 'FINAL') fail(400, 'Only a final exam promotes students');
        if (mode !== undefined && !SECTION_MODES.includes(mode)) fail(400, 'Choose where promoted students go: the same section, or no section');
        if (placement !== undefined && !PLACEMENTS.includes(placement)) fail(400, 'Choose what happens to students who do not pass: they stay where they are, or repeat the class next year');
        if (exam.promotedAt && ['done', 'waiting', 'running'].includes(exam.promotionState)) {
            fail(400, 'Students have already been promoted on these results — withdraw the results to undo the promotion');
        }
        if (promote !== undefined && promote !== before.promoteOnPass) { set.promoteOnPass = promote; changed.push('promoteOnPass'); }
        if (mode !== undefined && mode !== before.promoteSection) { set.promoteSection = mode; changed.push('promoteSection'); }
        if (placement !== undefined && placement !== before.failedPlacement) { set.failedPlacement = placement; changed.push('failedPlacement'); }
    }

    if (!changed.length) return exam;
    const after = { ...optionsOf(exam), ...set };
    const said = (k) => (k === 'promoteSection' ? `${OPTION_LABELS[k]} ${MODE_LABELS[after.promoteSection]}`
        : k === 'failedPlacement' ? `${OPTION_LABELS[k]} ${PLACEMENT_LABELS[after.failedPlacement]}`
            : k === 'timetableShared' ? `Timetable ${set.timetableShared ? 'shared with families' : 'kept from families'}`
                : `${OPTION_LABELS[k]}: ${after[k] ? 'on' : 'off'}`);
    // Only the switches that moved are written. A promotion change is made only
    // while the promotion still stands where it was read: a run claiming it in
    // between is not overwritten.
    await writeExam(exam, set, {
        where: promoteChanges ? { promotionState: exam.promotionState ?? null } : {},
        entry: entryOf('OPTIONS_CHANGED', ctx, changed.map(said).join(', ')),
        moved: 'The promotion has started since this exam was opened — reload it',
    });

    // A published final exam: switching promotion on schedules it (and runs
    // it, if the result date has come); switching it off calls it off.
    if (promoteChanges && exam.status === 'FINAL_APPROVED') {
        exam.promotionResult = await promotion().schedule(exam, { actor: ctx.userId });
    }

    // Results kept off the portal and now let onto it reach families for the
    // first time, so they are told — as publishing would have told them.
    if (changed.includes('showInPortal') && exam.showInPortal && exam.status === 'FINAL_APPROVED' && optionsOf(exam).notifyOnPublish) {
        FormalResult.find({ exam: exam._id }).distinct('student')
            .then((students) => announce(ctx, exam, students.map(String)))
            .catch(() => {});
    }
    // The timetable shared just now: everybody hears it, as new.
    if (changed.includes('timetableShared') && set.timetableShared && !exam.archivedAt) announceTimetable(ctx, exam, null);
    return exam;
}

/**
 * Move the result date of an exam that is already published.
 *
 * Until now the date was fixed the moment the results were published: bringing
 * a release forward, or putting it back a day, meant withdrawing the results —
 * every sheet back to draft, every teacher submitting again. It may move while
 * the results have not yet reached families. Once they have, the date is a
 * fact (and a promotion may have run on it): withdrawing is the way back.
 *
 * `date` empty means "release now". The promotion follows the new date, and
 * families are told again when they will see the results.
 */
async function setResultDate(ctx, id, date) {
    const exam = await load(ctx, id);
    if (exam.status !== 'FINAL_APPROVED') fail(400, 'Change the result date under Edit — these results are not published yet');
    if (released(exam)) fail(400, 'These results have already reached families — withdraw them to change the result date');

    const day = dayOf(date);
    if (day === undefined) fail(400, 'The result date is not a valid date');
    if (day && exam.endDate && day < new Date(exam.endDate)) fail(400, 'Results cannot be dated before the exam ends');
    const before = exam.publishDate ? fmtDay(exam.publishDate) : 'as soon as published';
    // Released now → families are told now (below), so the release sweep
    // does not tell them again on a date that no longer applies.
    const releasingNow = !day || dayStart(day, exam.school) <= new Date();
    await writeExam(exam, { publishDate: day || null, releaseNotifiedAt: releasingNow ? new Date() : null }, {
        where: { status: 'FINAL_APPROVED', publishDate: exam.publishDate ?? null },
        entry: entryOf('RESULT_DATE_CHANGED', ctx, `${before} → ${day ? fmtDay(day) : 'released now'}`),
    });

    // The promotion goes with the results: rescheduled, and run now if the new date has come.
    let promoted = null;
    try {
        promoted = await promotion().schedule(exam, { actor: ctx.userId });
    } catch (e) {
        console.error('[results] promotion failed:', e.message);
        promoted = { state: 'scheduled', error: e.message };
    }
    const { showInPortal, notifyOnPublish } = optionsOf(exam);
    if (showInPortal && notifyOnPublish) {
        FormalResult.find({ exam: exam._id }).distinct('student')
            .then((students) => announce(ctx, exam, students.map(String)))
            .catch(() => {});
    }
    return { exam, promotion: promoted, released: released(exam) };
}

/**
 * Only an exam nobody has worked on can be deleted; anything else is archived.
 * The exam's own history goes with it, so the deletion is written to the
 * school's Results trail — and whoever its shared timetable reached is told
 * it is off.
 */
async function deleteExam(ctx, id) {
    const exam = await load(ctx, id);
    if (exam.status !== 'DRAFT') fail(400, 'Only a draft can be deleted — archive this exam instead');
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "status" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (!now || now.status !== 'DRAFT') fail(409, 'Marks entry has been opened since this exam was loaded — it can no longer be deleted');
        await q(`DELETE FROM "${ExamMarksSheet.tableName}" WHERE "exam" = $1::uuid`, [String(exam._id)]);
        await q(`DELETE FROM "${FormalResult.tableName}" WHERE "exam" = $1::uuid`, [String(exam._id)]);
        await q(`DELETE FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid`, [String(exam._id)]);
    });
    const section = await ClassSection.findById(exam.section).select('sectionName class').lean().catch(() => null);
    const cls = section?.class ? await Class.findById(section.class).select('className').lean().catch(() => null) : null;
    await trail(ctx, 'EXAM_DELETED', 'Exam', exam._id,
        `Deleted the draft "${exam.title}"${cls || section ? ` (${[cls?.className, section?.sectionName].filter(Boolean).join(' – ')})` : ''}`,
        { title: exam.title, code: exam.code || '', section: String(exam.section), startDate: exam.startDate, endDate: exam.endDate });
    announceCancelled(ctx, exam, 'cancelled');
    return exam;
}

/* ── Marks entry ──────────────────────────────────────────────────────────── */

async function openMarksEntry(ctx, id, loaded) {
    const exam = loaded || await load(ctx, id);
    notArchived(exam, 'open marks entry');
    if (exam.status !== 'DRAFT') fail(400, 'Marks entry is already open for this exam');
    if (!(exam.subjects || []).length) fail(400, 'Add at least one subject before opening marks entry');

    // Claimed: a second click (or a second admin) finds it open, and does not
    // tell every teacher twice.
    await writeExam(exam, { status: 'MARKS_PENDING' }, {
        where: { status: 'DRAFT', archivedAt: null }, entry: entryOf('MARKS_OPENED', ctx),
        moved: 'Marks entry is already open for this exam',
    });

    tell(ctx, exam, {
        title: `📝 Marks entry open: ${exam.title}`,
        body: `Marks entry is open for "${exam.title}". Enter and submit the marks for your subjects.${exam.marksDueDate ? ` They are due by ${fmtDay(exam.marksDueDate)}.` : ''}`,
        recipients: await subjectTeachersOf(exam).catch(() => []),
    });
    return exam;
}

/** Marks entry opened by mistake: allowed back to draft while no mark has been entered. */
async function backToDraft(ctx, id) {
    const exam = await load(ctx, id);
    if (exam.status !== 'MARKS_PENDING') fail(400, 'Only an exam waiting for marks can go back to draft');
    const entry = entryOf('BACK_TO_DRAFT', ctx);
    // Checked and done under the exam's lock: a teacher's save takes the same
    // lock (saveMarks), so a mark cannot land between the check and the delete.
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "status" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (!now || now.status !== 'MARKS_PENDING') fail(409, MOVED_ON);
        const { rows: [{ n }] } = await q(
            `SELECT count(*)::int AS "n" FROM "${ExamMarksSheet.tableName}" m
               CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m."entries") = 'array' THEN m."entries" ELSE '[]'::jsonb END) en
              WHERE m."exam" = $1::uuid AND ((en->>'isAbsent') = 'true' OR (en->>'marksObtained') IS NOT NULL OR COALESCE(en->>'grade', '') <> '')`,
            [String(exam._id)]);
        if (n) fail(400, 'Marks have already been entered for this exam — it cannot go back to draft');
        await q(`DELETE FROM "${ExamMarksSheet.tableName}" WHERE "exam" = $1::uuid`, [String(exam._id)]);
        await writeExam(exam, { status: 'DRAFT' }, { where: { status: 'MARKS_PENDING' }, entry, q });
    });
    return exam;
}

/** The class number an exam's section belongs to (for its grading scale). */
async function classNumberOf(sectionId) {
    const { rows: [r] } = await pool.query(
        `SELECT c."classNumber" FROM "${ClassSection.tableName}" s JOIN "${Class.tableName}" c ON c."_id" = s."class" WHERE s."_id" = $1::uuid`,
        [String(sectionId)]);
    return r && r.classNumber !== null && r.classNumber !== undefined ? Number(r.classNumber) : null;
}
/** The scale an exam's results are graded on: its class's, under the school's settings. */
async function scaleForExam(exam) {
    return settings.scaleOf(exam.school, await classNumberOf(exam.section));
}

const partsOf = (cfg) => (Array.isArray(cfg?.components) && cfg.components.length ? cfg.components : null);
/** Whether an entry answers for its paper: absent, a grade, every part, or a mark. */
function answeredFor(cfg, e) {
    if (!e) return false;
    if (e.isAbsent) return true;
    if (cfg?.gradeOnly) return !!String(e.grade || '').trim();
    const parts = partsOf(cfg);
    if (parts) return parts.every((c) => e.parts && e.parts[c.key] !== null && e.parts[c.key] !== undefined && e.parts[c.key] !== '');
    return e.marksObtained !== null && e.marksObtained !== undefined;
}
/** An entry's figures, to tell a change from a save of the same thing. */
const figuresOf = (e) => (e ? JSON.stringify([
    e.isAbsent ? 1 : 0, e.marksObtained ?? null, String(e.grade || ''),
    e.parts ? Object.keys(e.parts).sort().map((k) => [k, e.parts[k] ?? null]) : null,
]) : null);
const figureText = (e) => (!e ? 'blank' : e.isAbsent ? 'absent' : e.grade ? String(e.grade)
    : e.marksObtained !== null && e.marksObtained !== undefined ? String(e.marksObtained) : 'blank');

/**
 * One entry off a form, checked against its paper: absent; a grade on the
 * school's scale (a graded paper); a mark in each part (the paper's mark is
 * their sum, once every part has one); or a mark between 0 and the maximum.
 * 45.666666 is not a mark anybody awarded — marks are kept to 2 places.
 */
function cleanEntry(cfg, e, grades) {
    const sid = idOf(e?.student);
    const out = { student: sid, marksObtained: null, isAbsent: !!e?.isAbsent, remarks: String(e?.remarks || '').trim().slice(0, 300), parts: null, grade: '' };
    if (out.isAbsent) return out;
    if (cfg.gradeOnly) {
        const g = String(e?.grade || '').trim();
        if (g && !grades.has(g)) fail(400, `"${g}" is not a grade on the school's scale (${[...grades].join(', ')})`);
        out.grade = g;
        return out;
    }
    const num = (raw, max, what) => {
        if (raw === null || raw === undefined || raw === '') return null;
        const v = Number(raw);
        if (!Number.isFinite(v)) fail(400, 'Marks must be a number');
        if (v < 0) fail(400, 'Marks cannot be negative');
        if (v > max) fail(400, `${what} cannot be more than the maximum (${max})`);
        return round2(v);
    };
    const parts = partsOf(cfg);
    if (parts) {
        out.parts = {};
        for (const c of parts) out.parts[c.key] = num(e?.parts?.[c.key], Number(c.maxMarks), `${c.label} marks`);
        const all = parts.every((c) => out.parts[c.key] !== null);
        out.marksObtained = all ? round2(parts.reduce((t, c) => t + out.parts[c.key], 0)) : null;
        return out;
    }
    out.marksObtained = num(e?.marksObtained, Number(cfg.maxMarks), 'Marks');
    return out;
}

/**
 * Save one subject's marks sheet.
 *
 * `admin` is the office entering or correcting marks. A subject teacher may
 * only write while marks entry is open; the office may also correct a sheet
 * that has gone forward — and a correction to marks the class teacher already
 * validated sends them back to be validated again, with the class teacher told
 * what changed. Every change to a mark already given is written into the
 * sheet's history (who, when, from what to what).
 *
 * A save MERGES: the students it names get what it says, every other entry on
 * the sheet stays as it was. It used to replace the whole list, so a student
 * moved to another section the day after the paper — no longer on this roll,
 * so not on the grid — lost the marks already entered for them. Only students
 * on the roll (for an elective, on its roster), or already on the sheet, are
 * taken. `version` is the sheet's version the screen loaded: a save over
 * changes somebody else made since is refused instead of quietly undoing them.
 *
 * Returns { sheet, exam } — `exam` moves to SUBMITTED once every subject's
 * sheet is in.
 */
async function saveMarks(ctx, exam, subjectId, entries, { submit = false, admin = false, version } = {}) {
    notArchived(exam, 'change its marks');
    const cfg = (exam.subjects || []).find((s) => idOf(s.subject) === String(subjectId));
    if (!cfg) fail(404, 'That subject is not part of this exam');

    const closed = (status) => fail(400, {
        DRAFT: 'Marks entry has not been opened for this exam yet',
        REJECTED: 'These marks were rejected — the exam has to be reopened before they can change',
        FINAL_APPROVED: 'These results are published and can no longer change',
    }[status] || 'Marks entry is closed for this exam');
    const allowedNow = (status) => MARKS_OPEN.includes(status) || (admin && ['SUBMITTED', 'CLASS_APPROVED'].includes(status));
    if (!allowedNow(exam.status)) closed(exam.status);

    const [roster, takers, scale] = await Promise.all([
        rosterOf(exam.section), takersOf(exam.section, [subjectId]), cfg.gradeOnly ? scaleForExam(exam) : null,
    ]);
    const roll = rollFor(roster, takers, subjectId);
    const onRoll = new Set(roll);
    const grades = new Set((scale?.bands || []).map((b) => b.grade));
    const seen = new Set();
    const clean = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const sid = idOf(e?.student);
        if (!isUuid(sid) || seen.has(sid)) continue;   // sent twice
        seen.add(sid);
        clean.push(cleanEntry(cfg, e, grades));
    }

    const at = new Date();
    const result = await pool.withTransaction(async (q) => {
        // The exam is held where it is while the sheet is written: validating,
        // publishing or going back to draft wait for this save, and this save
        // sees the step they took. A correction may move the exam itself.
        const { rows: [now] } = await q(
            `SELECT "status", "archivedAt" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR ${admin ? 'UPDATE' : 'SHARE'}`, [String(exam._id)]);
        if (!now) fail(404, 'Exam not found');
        if (now.archivedAt) fail(400, 'This exam is archived — restore it to change its marks');
        if (!allowedNow(now.status)) closed(now.status);
        const correcting = !MARKS_OPEN.includes(now.status);
        const final = submit || correcting;

        // The sheet, made on its first save, then held.
        await q(
            `INSERT INTO "${ExamMarksSheet.tableName}" ("_id", "exam", "subject", "section", "status", "entries", "auditLog", "version", "createdAt", "updatedAt")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DRAFT', '[]'::jsonb, '[]'::jsonb, 0, now(), now())
             ON CONFLICT ("exam", "subject") DO NOTHING`,
            [newId(), String(exam._id), String(subjectId), String(exam.section)]);
        const { rows: [sheet] } = await q(
            `SELECT * FROM "${ExamMarksSheet.tableName}" WHERE "exam" = $1::uuid AND "subject" = $2::uuid FOR UPDATE`, [String(exam._id), String(subjectId)]);
        const current = Number(sheet.version) || 0;
        if (version !== undefined && version !== null && version !== '' && Number(version) !== current) {
            const by = Array.isArray(sheet.auditLog) && sheet.auditLog.length ? sheet.auditLog[sheet.auditLog.length - 1] : null;
            const who = by?.by ? (await User.findById(by.by).select('name').lean().catch(() => null))?.name : '';
            fail(409, `These marks were changed${who ? ` by ${who}` : ''} after you opened the sheet — reload it to see their changes, then make yours again`,
                { code: 'SHEET_CHANGED' });
        }

        const had = new Map((Array.isArray(sheet.entries) ? sheet.entries : []).map((e) => [String(e.student), e]));
        const next = new Map(had);
        const changes = [];
        let entered = 0;
        for (const e of clean) {
            if (!onRoll.has(e.student) && !had.has(e.student)) continue;   // not this subject's student
            const before = had.get(e.student) || null;
            if (figuresOf(before) !== figuresOf(e)) {
                if (answeredFor(cfg, before)) {
                    changes.push({ student: e.student, before: figureText(before), after: figureText(e) });
                } else if (answeredFor(cfg, e)) entered += 1;
            }
            next.set(e.student, e);
        }

        // A sheet that goes forward has to answer for every student who takes
        // the paper: a blank would otherwise be read as a zero.
        if (final) {
            const missing = roll.filter((id) => !answeredFor(cfg, next.get(id))).length;
            if (missing) {
                fail(400, `Enter marks or mark absent for every student before submitting — ${missing} ${missing === 1 ? 'is' : 'are'} still blank`,
                    { code: 'MARKS_INCOMPLETE', missing });
            }
        }

        const action = admin ? (final ? 'ADMIN_SUBMITTED' : 'ADMIN_SAVED') : (final ? 'SUBMITTED' : 'SAVED');
        const notes = [entered ? `${entered} entered` : '', changes.length ? `${changes.length} changed` : ''].filter(Boolean).join(' · ');
        const log = { action, by: String(ctx.userId), at, notes, ...(changes.length ? { changes } : {}) };
        const { rows: [saved] } = await q(
            `UPDATE "${ExamMarksSheet.tableName}"
                SET "entries" = $2::jsonb, "status" = $3, "section" = $4::uuid,
                    "submittedBy" = CASE WHEN $3 = 'SUBMITTED' THEN $5::uuid ELSE "submittedBy" END,
                    "submittedAt" = CASE WHEN $3 = 'SUBMITTED' THEN $6::timestamptz ELSE "submittedAt" END,
                    "version" = COALESCE("version", 0) + 1, "updatedAt" = $6::timestamptz,
                    "auditLog" = (CASE WHEN jsonb_typeof("auditLog") = 'array' THEN "auditLog" ELSE '[]'::jsonb END) || $7::jsonb
              WHERE "_id" = $1::uuid RETURNING *`,
            [String(sheet._id), JSON.stringify([...next.values()]), final ? 'SUBMITTED' : 'DRAFT', String(exam.section),
                String(ctx.userId), at, JSON.stringify([log])]);

        // Marks the class teacher validated have changed: they go back to be
        // validated again — the class teacher signed off on other figures.
        let revalidate = false;
        if (correcting && changes.length && now.status === 'CLASS_APPROVED') {
            await writeExam(exam, { status: 'SUBMITTED', classApprovedBy: null, classApprovedAt: null }, {
                where: { status: 'CLASS_APPROVED' }, q,
                entry: entryOf('MARKS_CORRECTED', ctx, `${changes.length} mark${changes.length === 1 ? '' : 's'} changed — to be validated again`, { subject: String(subjectId) }),
            });
            revalidate = true;
        } else if (correcting && changes.length) {
            await writeExam(exam, {}, {
                q, entry: entryOf('MARKS_CORRECTED', ctx, `${changes.length} mark${changes.length === 1 ? '' : 's'} changed`, { subject: String(subjectId) }),
            }).catch(() => {});
        } else {
            exam.status = now.status;
        }
        return { sheet: saved, final, correcting, changes, revalidate };
    });

    if (result.correcting && result.changes.length) tellCorrection(ctx, exam, subjectId, result.changes, result.revalidate);
    if (result.final) await advanceIfComplete(ctx, exam);
    return { sheet: result.sheet, exam };
}

/**
 * The office changed marks that had gone forward: the class teacher (who is
 * to validate them, again if they already had) and the subject's teachers
 * hear what changed. A notice never makes a step fail.
 */
async function tellCorrection(ctx, exam, subjectId, changes, revalidate) {
    try {
        const [sub, users, links, ct] = await Promise.all([
            Subject.findById(subjectId).select('subjectName').lean(),
            User.find({ _id: { $in: changes.map((c) => c.student) } }).select('name').lean(),
            SectionSubjectTeacher.find({ section: exam.section, subject: subjectId }).select('teacher').lean(),
            classTeachersOf(exam),
        ]);
        const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
        const lines = changes.slice(0, 8).map((c) => `${nameOf.get(String(c.student)) || 'A student'}: ${c.before} → ${c.after}`);
        if (changes.length > 8) lines.push(`…and ${changes.length - 8} more`);
        const subjectName = sub?.subjectName || 'A subject';
        tell(ctx, exam, {
            title: revalidate ? `✏️ Marks corrected — validate again: ${exam.title}` : `✏️ Marks corrected: ${exam.title}`,
            body: `The school office changed ${subjectName} marks for "${exam.title}".${revalidate ? ' They need to be validated again before the results can be published.' : ''}\n${lines.join('\n')}`,
            recipients: [...new Set([...ct, ...links.map((l) => String(l.teacher))])].filter((id) => id !== String(ctx.userId)),
            type: ct.length ? 'results.validate' : 'results.marks',
        });
    } catch (e) {
        console.error('[results] correction notice failed:', e.message);
    }
}

/** Every subject's sheet submitted → the exam goes to the class teacher. */
async function advanceIfComplete(ctx, exam) {
    if (!MARKS_OPEN.includes(exam.status)) return false;
    const ids = subjectIdsOf(exam);
    if (!ids.length) return false;
    const sheets = await ExamMarksSheet.find({ exam: exam._id, status: 'SUBMITTED' }).select('subject').lean();
    const done = new Set(sheets.map((s) => String(s.subject)));
    if (!ids.every((id) => done.has(id))) return false;

    // Claimed in one statement: two teachers handing in the last two sheets at
    // the same moment both see every sheet in, and both used to move the exam
    // on — and both told the class teacher. Only the one whose UPDATE finds it
    // still open does now.
    const entry = { action: 'ALL_MARKS_SUBMITTED', by: String(ctx.userId), at: new Date(), notes: '' };
    const { rows } = await pool.query(
        `UPDATE "${FormalExam.tableName}" SET "status" = 'SUBMITTED', "updatedAt" = $2, "auditLog" = ${APPEND_LOG('$3')}
          WHERE "_id" = $1::uuid AND "status" = ANY($4::text[]) RETURNING "_id"`,
        [String(exam._id), entry.at, JSON.stringify([entry]), MARKS_OPEN]);
    if (!rows.length) return false;
    exam.status = 'SUBMITTED';
    if (!Array.isArray(exam.auditLog)) exam.auditLog = [];
    exam.auditLog.push(entry);

    const validators = await classTeachersOf(exam).catch(() => []);
    if (validators.length) {
        tell(ctx, exam, {
            title: `✅ Marks ready to validate: ${exam.title}`,
            body: `Every subject's marks for "${exam.title}" are in. Review and validate them so the results can be published.`,
            recipients: validators,
            type: 'results.validate',
        });
    } else {
        // Nobody is this section's class teacher, so nobody else can take the
        // next step: say so to the people who can.
        tell(ctx, exam, {
            title: `✅ Marks ready to validate: ${exam.title}`,
            body: `Every subject's marks for "${exam.title}" are in. This section has no class teacher, so the marks are waiting for you to validate.`,
            recipients: await officeIds(exam.school).catch(() => []),
            type: 'results.exam',
        });
    }
    return true;
}

/* ── Validation, publishing, sending back ─────────────────────────────────── */

/**
 * Validate the marks. A class teacher does this for their own section; the
 * office may do it for any — a section with no class teacher would otherwise
 * hold its exam at this step for ever.
 */
async function validateExam(ctx, id, { notes = '', admin = false } = {}) {
    const exam = await load(ctx, id);
    notArchived(exam, 'validate it');
    if (exam.status !== 'SUBMITTED') {
        fail(400, exam.status === 'CLASS_APPROVED' ? 'These marks are already validated' : 'Marks can be validated once every subject has been submitted');
    }
    if (!admin) {
        const mine = await classTeachersOf(exam);
        if (!mine.includes(String(ctx.userId))) fail(403, 'Only the class teacher can validate these marks');
    }
    // Claimed: validating and rejecting at the same moment cannot both win.
    await writeExam(exam, { status: 'CLASS_APPROVED', classApprovedBy: ctx.userId, classApprovedAt: new Date() }, {
        where: { status: 'SUBMITTED', archivedAt: null },
        entry: entryOf(admin ? 'VALIDATED_BY_ADMIN' : 'CLASS_APPROVED', ctx, notes),
        moved: 'These marks have moved on since you opened them (validated, sent back, or corrected) — reload to see where they stand',
    });

    if (!admin) {
        tell(ctx, exam, {
            title: `📊 Results ready to publish: ${exam.title}`,
            body: `The marks for "${exam.title}" have been validated by the class teacher and are ready for you to publish.`,
            recipients: await officeIds(exam.school).catch(() => []),
            type: 'results.exam',
        });
    }
    return exam;
}

/**
 * Work out every student's result from the marks sheets and store them.
 *
 * A student with nothing against their name in ANY subject is left out: they
 * joined the section after the papers, and a row of zeros would read as a
 * fail. A gap in one subject among entered ones counts as absent for that
 * paper. Rank is competition rank on total marks — equal totals share a place.
 * Grace, when the exam allows it, is applied before totals and ranks: the
 * result counts the marks awarded, and says how many of them were grace.
 *
 * Replaces the exam's results in one transaction, so a failure part-way leaves
 * what was there.
 */
async function generateResults(exam, { q = null, rows: given = null } = {}) {
    const rows = given || await computeResults(exam);
    return writeResults(exam, rows, q);
}

/** A result's share of the marks, as integer hundredths — compared exactly, never as rounded percentages. */
const shareCmp = (a, b) => Math.round(b.totalMarks * 100) * Math.round(a.totalMaxMarks * 100)
    - Math.round(a.totalMarks * 100) * Math.round(b.totalMaxMarks * 100);

/**
 * Every student's result for the exam, worked out from its sheets — reads only.
 *
 *   who        the section's roll, and anyone who sat a paper of it and has
 *              since left the school or moved section: their result is what
 *              they sat for, and withdrawing and republishing used to delete
 *              it. A student with nothing entered in ANY subject gets none.
 *   electives  a subject with an elective roster is in its takers' results
 *              only — the others did not sit it, they were not absent from it
 *   parts      a paper in parts is passed when every part with a pass mark is
 *              passed and the paper's own pass mark is reached
 *   graded     a graded paper carries its grade and counts in no total and no
 *              pass/fail
 *   scale      the exam's class's grading scale (Results → Settings)
 *   rank       competition rank on the share of marks — totals differ once
 *              students sit different electives — equal shares tie
 */
async function computeResults(exam, { scale: given = null } = {}) {
    const { allowGraceMarks, grace } = optionsOf(exam);
    const ids = subjectIdsOf(exam);
    const [scale, roster, sheets, takers] = await Promise.all([
        given || scaleForExam(exam), rosterOf(exam.section),
        ExamMarksSheet.find({ exam: exam._id }).lean(), takersOf(exam.section, ids),
    ]);
    const entriesOf = new Map(sheets.map((s) => [
        String(s.subject), new Map((s.entries || []).map((e) => [String(e.student), e])),
    ]));
    // Off the roll now, but sat a paper: a mark (not only an absence) on a sheet.
    const onRoll = new Set(roster);
    const off = new Set();
    for (const s of sheets) {
        for (const e of s.entries || []) {
            const sid = String(e.student);
            if (onRoll.has(sid) || e.isAbsent) continue;
            const sat = e.marksObtained !== null && e.marksObtained !== undefined
                || String(e.grade || '').trim()
                || (e.parts && Object.values(e.parts).some((v) => v !== null && v !== undefined && v !== ''));
            if (sat) off.add(sid);
        }
    }
    let offRoll = [];
    if (off.size) {
        const { rows } = await pool.query(
            `SELECT "_id" FROM "${User.tableName}" WHERE "_id" = ANY($1::uuid[]) AND "role" = 'student' AND "school" = $2::uuid`,
            [[...off], String(exam.school)]);
        offRoll = rows.map((r) => String(r._id));
    }

    const rows = [];
    for (const student of [...roster, ...offRoll]) {
        let assessed = 0;
        const subjects = [];
        for (const cfg of exam.subjects || []) {
            const sid = idOf(cfg.subject);
            const t = takers.get(sid);
            if (t && !t.has(student)) continue;   // an elective they do not take
            const entry = entriesOf.get(sid)?.get(student);
            const answered = answeredFor(cfg, entry);
            if (answered) assessed += 1;
            const absent = !answered || !!entry.isAbsent;
            const remarks = entry?.remarks || '';
            if (cfg.gradeOnly) {
                subjects.push({
                    subject: sid, gradeOnly: true, marksObtained: 0, graceMarks: 0, maxMarks: 0, passingMarks: 0,
                    grade: absent ? 'AB' : String(entry.grade), isPassed: true, isAbsent: absent, remarks,
                });
                continue;
            }
            const max = Number(cfg.maxMarks) || 0;
            const pass = Number(cfg.passingMarks) || 0;
            const marks = absent ? 0 : Number(entry.marksObtained) || 0;
            let components = null;
            let partsPassed = true;
            const parts = partsOf(cfg);
            if (parts) {
                components = parts.map((c) => {
                    const m = absent ? null : round2(Number(entry?.parts?.[c.key]) || 0);
                    const needs = Number(c.passingMarks) > 0;
                    const ok = !absent && m >= Number(c.passingMarks || 0);
                    if (needs && !ok) partsPassed = false;
                    return { key: c.key, label: c.label, maxMarks: Number(c.maxMarks), passingMarks: Number(c.passingMarks) || 0, marks: m, passed: needs ? ok : null };
                });
            }
            const passed = !absent && marks >= pass && partsPassed;
            subjects.push({
                subject: sid, marksObtained: marks, graceMarks: 0, maxMarks: max, passingMarks: pass,
                grade: gradeFor(marks, max, passed, absent, scale),
                isPassed: passed, isAbsent: absent, remarks, ...(components ? { components } : {}),
            });
        }
        if (!assessed) continue;
        const counted = subjects.filter((x) => !x.gradeOnly);
        if (allowGraceMarks) applyGrace(counted, grace, scale);

        // Rounded once, here: 33.3 + 33.3 + 33.4 is 100.00000000000001 in
        // floating point, which printed as such and split a tie in the ranks.
        const totalMarks = round2(counted.reduce((s, r) => s + r.marksObtained, 0));
        const totalMaxMarks = round2(counted.reduce((s, r) => s + r.maxMarks, 0));
        const percentage = totalMaxMarks > 0 ? round2((totalMarks / totalMaxMarks) * 100) : 0;
        const isPassed = counted.every((r) => r.isPassed);
        rows.push({
            student, subjects, totalMarks, totalMaxMarks, percentage,
            grade: overallGrade(percentage, isPassed, scale), isPassed,
        });
    }

    rows.sort(shareCmp);
    rows.forEach((r, i) => { r.rank = i > 0 && shareCmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1; });
    // Re-exams last: a paper sat again changes the result, never the order
    // the exam itself produced.
    return applyReExams(rows, exam, scale, { grace: allowGraceMarks ? grace : null });
}

/** Replace the exam's stored results with these — in `q`'s transaction, or one of its own. */
async function writeResults(exam, rows, q = null) {
    const T = `"${FormalResult.tableName}"`;
    const at = new Date();
    const write = async (run) => {
        await run(`DELETE FROM ${T} WHERE "exam" = $1::uuid`, [String(exam._id)]);
        for (const r of rows) {
            await run(
                `INSERT INTO ${T} ("_id", "exam", "student", "school", "section", "academicYear", "subjects",
                                   "totalMarks", "totalMaxMarks", "percentage", "grade", "rank", "isPassed", "reExam", "generatedAt")
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [newId(), String(exam._id), r.student, String(exam.school), String(exam.section), String(exam.academicYear),
                    JSON.stringify(r.subjects), r.totalMarks, r.totalMaxMarks, r.percentage, r.grade, r.rank, r.isPassed, !!r.reExam, at]);
        }
    };
    if (q) await write(q);
    else await pool.withTransaction(write);
    return rows;
}

/**
 * Grace marks: a student who would pass every subject but for a few marks is
 * given them — at most `perSubject` marks in a subject, in at most
 * `maxSubjects` subjects. Grace exists to carry a borderline student over the
 * line, so it is all or nothing: a student it cannot get through every subject
 * (absent from a paper, too far short, or short in too many) is given none,
 * rather than marks that change nothing but the figures.
 *
 * Changes `subjects` in place; returns how many subjects were given grace.
 */
function applyGrace(subjects, { perSubject, maxSubjects }, scale) {
    const short = subjects.filter((r) => !r.isPassed);
    if (!short.length || short.length > maxSubjects) return 0;
    if (short.some((r) => r.isAbsent || r.passingMarks - r.marksObtained > perSubject)) return 0;
    // A paper failed on one of its parts (the practical, say) is not short of
    // its pass mark at all — grace on the total cannot pass it.
    if (short.some((r) => r.marksObtained >= r.passingMarks || (r.components || []).some((c) => c.passed === false))) return 0;
    for (const r of short) {
        const add = round2(r.passingMarks - r.marksObtained);
        r.graceMarks = add;
        r.marksObtained = round2(r.marksObtained + add);
        r.isPassed = true;
        r.grade = gradeFor(r.marksObtained, r.maxMarks, true, false, scale);
    }
    return short.length;
}

/**
 * These students and every parent of theirs the school knows — by the student
 * record's own parent, and by any parent account that lists the student among
 * its children (services/parentChildren). The old lookup read the first link
 * alone, so a second parent, or one linked from the parent's side, was never
 * told a result was out.
 */
async function familyOf(schoolId, studentIds) {
    const ids = [...new Set((studentIds || []).map(String))];
    const parents = await parentsOf(ids, schoolId).catch(() => new Map());
    return [...new Set([...ids, ...[...parents.values()].flat().map(String)])];
}

/**
 * Tell students and their parents that results are out — or, with a later
 * result date, when they will be. A notice is never the reason a step fails.
 */
function announce(ctx, exam, studentIds) {
    if (!studentIds?.length) return;
    const later = !released(exam);
    familyOf(exam.school, studentIds).then((recipients) => tell(ctx, exam, {
        title: later ? `📊 Results on the way: ${exam.title}` : `📊 Results published: ${exam.title}`,
        body: later
            ? `Results for "${exam.title}" will be available from ${fmtDay(exam.publishDate)}.`
            : `Results for "${exam.title}" have been published. Check the Results section for your scorecard.`,
        recipients, type: 'results.mine',
    })).catch(() => {});
}

/** Students whose result in this exam is withheld from them and their parents. */
const withheldOf = (exam) => new Set((Array.isArray(exam?.withheld) ? exam.withheld : []).map((w) => String(w.student)));

/**
 * Publish. The results are worked out FIRST, while the exam is still only
 * validated: if that fails the exam has not moved, and can be tried again.
 */
async function publishExam(ctx, id, notes = '') {
    const exam = await load(ctx, id);
    notArchived(exam, 'publish its results');
    if (exam.status !== 'CLASS_APPROVED') {
        fail(400, {
            FINAL_APPROVED: 'These results are already published',
            SUBMITTED: 'These marks have to be validated before the results can be published',
        }[exam.status] || 'Results can be published once the marks have been validated');
    }

    // The results and the step that publishes them are one transaction, with
    // the exam's row locked first. They used to be two writes: a second click
    // (or a second admin) worked the results out again beside the first, and
    // collided with it on the unique index; and a failure between the two left
    // results stored for an exam that was not published.
    const entry = { action: 'FINAL_APPROVED', by: String(ctx.userId), at: new Date(), notes: String(notes || '').trim() };
    // Worked out first, from reads on the pool; the transaction then only locks,
    // checks and writes, holding one connection and waiting on nothing else.
    const scale = await scaleForExam(exam);
    const computed = await computeResults(exam, { scale });
    const { showInPortal, notifyOnPublish } = optionsOf(exam);
    // Families told now if they see the results now; otherwise on the result
    // date, by the release sweep (releaseNotifiedAt stays empty until then).
    const toldNow = showInPortal && notifyOnPublish && released(exam);
    const results = await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(
            `SELECT "status", "archivedAt" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (!now || now.archivedAt) fail(400, 'This exam is archived — restore it to publish its results');
        if (now.status !== 'CLASS_APPROVED') fail(409, now.status === 'FINAL_APPROVED' ? 'These results are already published' : 'This exam has moved on since it was opened — reload it');
        if (!computed.length) fail(400, 'No student in this section has any marks, so there are no results to publish');
        const rows = await generateResults(exam, { q, rows: computed });
        await q(
            `UPDATE "${FormalExam.tableName}"
                SET "status" = 'FINAL_APPROVED', "finalApprovedBy" = $2::uuid, "finalApprovedAt" = $3, "resultsGenerated" = true,
                    "gradeBands" = $5::jsonb, "releaseNotifiedAt" = $6,
                    "updatedAt" = $3, "auditLog" = ${APPEND_LOG('$4')}
              WHERE "_id" = $1::uuid`,
            [String(exam._id), String(ctx.userId), entry.at, JSON.stringify([entry]),
                JSON.stringify({ preset: scale.preset, label: scale.label, bands: scale.bands }), toldNow ? entry.at : null]);
        return rows;
    });
    exam.status = 'FINAL_APPROVED';
    exam.finalApprovedBy = ctx.userId;
    exam.finalApprovedAt = entry.at;
    exam.resultsGenerated = true;
    exam.gradeBands = { preset: scale.preset, label: scale.label, bands: scale.bands };
    exam.releaseNotifiedAt = toldNow ? entry.at : null;
    if (!Array.isArray(exam.auditLog)) exam.auditLog = [];
    exam.auditLog.push(entry);

    // Families are told the truth about WHEN: an exam with a later result date
    // is published now but its results stay hidden until that day. Nobody is
    // told of results kept off the portal, or when the office said not to —
    // nor of a result the school is holding back from that family.
    if (showInPortal && notifyOnPublish) {
        const held = withheldOf(exam);
        announce(ctx, exam, results.map((r) => String(r.student)).filter((sid) => !held.has(sid)));
    }

    // A final exam set to promote: scheduled for the day the results reach
    // families, and run now if that day has come. A failure here does not
    // unpublish anything — the scheduler picks the promotion up again.
    let promoted = null;
    try {
        promoted = await promotion().schedule(exam, { actor: ctx.userId });
    } catch (e) {
        console.error('[results] promotion failed:', e.message);
        promoted = { state: 'scheduled', error: e.message };
    }
    return { exam, results: results.length, promotion: promoted };
}

async function rejectExam(ctx, id, reason, { admin = true } = {}) {
    const exam = await load(ctx, id);
    notArchived(exam, 'reject its marks');
    const from = admin ? ['SUBMITTED', 'CLASS_APPROVED'] : ['SUBMITTED'];
    if (!from.includes(exam.status)) fail(400, 'Only marks that have been submitted can be rejected');
    const why = String(reason || '').trim();
    if (!why) fail(400, 'Say why the marks are being rejected — the teachers will see it');
    if (!admin) {
        const mine = await classTeachersOf(exam);
        if (!mine.includes(String(ctx.userId))) fail(403, 'Only the class teacher can reject these marks');
    }

    // Claimed: a reject racing a validate (or a second reject) cannot both win.
    await writeExam(exam, { status: 'REJECTED', rejectionReason: why.slice(0, 500) }, {
        where: { status: from, archivedAt: null },
        entry: entryOf(admin ? 'REJECTED' : 'CLASS_REJECTED', ctx, why),
        moved: 'These marks have moved on since you opened them — reload to see where they stand',
    });

    if (admin) {
        tell(ctx, exam, {
            title: `❌ Marks rejected: ${exam.title}`,
            body: `The marks for "${exam.title}" were rejected by the school office.\nReason: ${exam.rejectionReason}`,
            recipients: await classTeachersOf(exam).catch(() => []),
        });
    } else {
        // Only the office can reopen an exam, so the office has to hear of it.
        tell(ctx, exam, {
            title: `❌ Marks rejected: ${exam.title}`,
            body: `The class teacher rejected the marks for "${exam.title}". Reopen the exam so they can be corrected.\nReason: ${exam.rejectionReason}`,
            recipients: await officeIds(exam.school).catch(() => []),
            type: 'results.exam',
        });
    }
    return exam;
}

/**
 * Send an exam back for its marks to be corrected.
 *
 * From REJECTED this is the ordinary next step. From FINAL_APPROVED it
 * withdraws published results — the only way to put a wrong mark right once
 * nobody may correct it in place — so it needs a reason, and the stored
 * results go with it (they are worked out again when the exam is next
 * published, and nothing may go on showing the old ones).
 *
 * `subjects` names the papers to correct: only their sheets go back to draft,
 * and only their teachers are asked to submit again — the others' marks stay
 * submitted. Without it, every sheet goes back.
 *
 * The exam is claimed first, in one transaction with its sheets and its
 * results, so families stop seeing the results the moment it is withdrawn and
 * a failure part-way leaves it as it was. The promotion is taken back after:
 * it may move many students, and a failure in it must not leave an exam
 * "published" with its results gone.
 */
async function reopenExam(ctx, id, { reason = '', notes = '', subjects = null } = {}) {
    const exam = await load(ctx, id);
    notArchived(exam, 'reopen it');
    const why = String(reason || notes || '').trim();
    const withdrawing = exam.status === 'FINAL_APPROVED';
    if (!withdrawing && exam.status !== 'REJECTED') fail(400, 'Only rejected marks or published results can be reopened');
    if (withdrawing && !why) fail(400, 'Say why the published results are being withdrawn');
    const all = subjectIdsOf(exam);
    const only = Array.isArray(subjects) && subjects.length ? [...new Set(subjects.map(String))] : null;
    if (only && only.some((sid) => !all.includes(sid))) fail(400, 'One of those subjects is not part of this exam');
    const back = only || all;

    // Families who could already see these results are told they are being
    // corrected: a scorecard that simply vanished read as a fault in the app.
    const seen = withdrawing && visibleToFamilies(exam) && optionsOf(exam).notifyOnPublish
        ? (await FormalResult.find({ exam: exam._id }).distinct('student')).map(String) : [];
    const names = only ? await Subject.find({ _id: { $in: only } }).select('subjectName').lean() : [];
    const which = names.map((x) => x.subjectName).join(', ');

    const entry = entryOf(withdrawing ? 'RESULTS_WITHDRAWN' : 'REOPENED', ctx, [why, only ? `only ${which}` : ''].filter(Boolean).join(' — '),
        only ? { subjects: only } : null);
    await pool.withTransaction(async (q) => {
        await writeExam(exam, {
            status: 'REOPENED', classApprovedBy: null, classApprovedAt: null,
            ...(withdrawing ? { resultsGenerated: false, finalApprovedBy: null, finalApprovedAt: null, releaseNotifiedAt: null } : {}),
        }, { where: { status: withdrawing ? 'FINAL_APPROVED' : 'REJECTED', archivedAt: null }, entry, q });
        await q(
            `UPDATE "${ExamMarksSheet.tableName}"
                SET "status" = 'DRAFT', "version" = COALESCE("version", 0) + 1, "updatedAt" = now(),
                    "auditLog" = (CASE WHEN jsonb_typeof("auditLog") = 'array' THEN "auditLog" ELSE '[]'::jsonb END) || $3::jsonb
              WHERE "exam" = $1::uuid AND "subject" = ANY($2::uuid[])`,
            [String(exam._id), back, JSON.stringify([{ action: 'REOPENED', by: String(ctx.userId), at: new Date(), notes: why }])]);
        if (withdrawing) await q(`DELETE FROM "${FormalResult.tableName}" WHERE "exam" = $1::uuid`, [String(exam._id)]);
    });

    if (withdrawing) {
        // Students this exam promoted go back, and a promotion not yet run is
        // called off. If that fails the office is told: the moves can be taken
        // back by hand, and nothing else of the withdrawal depends on them.
        try {
            await promotion().undo(exam, { actor: ctx.userId, reason: why });
        } catch (e) {
            console.error('[results] promotion undo failed:', e.message);
            tell(ctx, exam, {
                title: `⚠️ Promotion not taken back: ${exam.title}`,
                body: `The results of "${exam.title}" were withdrawn, but the students it promoted could not all be moved back (${e.message}). Check them under Academics.`,
                recipients: await officeIds(exam.school).catch(() => []), type: 'results.exam',
            });
        }
        const fresh = await FormalExam.findById(exam._id).select('promotionState promotionDueAt promotionStats promotedAt').lean();
        Object.assign(exam, {
            promotionState: fresh?.promotionState ?? null, promotionDueAt: fresh?.promotionDueAt ?? null,
            promotionStats: fresh?.promotionStats ?? null, promotedAt: fresh?.promotedAt ?? null,
        });
    }

    const teachers = only
        ? (await SectionSubjectTeacher.find({ section: exam.section, subject: { $in: only } }).select('teacher').lean().catch(() => [])).map((x) => String(x.teacher))
        : await subjectTeachersOf(exam).catch(() => []);
    const recipients = [...new Set([...teachers, ...(await classTeachersOf(exam).catch(() => []))])];
    tell(ctx, exam, {
        title: `🔄 Marks entry reopened: ${exam.title}`,
        body: `"${exam.title}" has been reopened${only ? ` for ${which}` : ''}. Check your marks, correct them and submit again.${why ? `\nReason: ${why}` : ''}`,
        recipients,
    });
    if (seen.length) {
        familyOf(exam.school, seen).then((family) => tell(ctx, exam, {
            title: `📊 Results withdrawn: ${exam.title}`,
            body: `The results of "${exam.title}" have been withdrawn by the school for correction. They will be published again once they have been checked.`,
            recipients: family, type: 'results.mine',
        })).catch(() => {});
    }
    return exam;
}

/**
 * Send one subject's marks back to its teachers, from wherever the exam has
 * got to: the other subjects' marks stay as they are. Before this, correcting
 * one paper meant rejecting the whole exam and reopening every sheet, so every
 * teacher had to submit again. Once published, it is a withdrawal of the
 * results for that paper (reopenExam with the subject).
 */
async function returnSubject(ctx, id, subjectId, reason) {
    const exam = await load(ctx, id);
    notArchived(exam, 'send marks back');
    const sid = String(subjectId || '');
    if (!subjectIdsOf(exam).includes(sid)) fail(404, 'That subject is not part of this exam');
    const why = String(reason || '').trim();
    if (!why) fail(400, 'Say what is wrong with these marks — the subject teacher will see it');
    if (exam.status === 'FINAL_APPROVED') return reopenExam(ctx, id, { reason: why, subjects: [sid] });
    const from = ['SUBMITTED', 'CLASS_APPROVED', 'REJECTED', ...MARKS_OPEN];
    if (!from.includes(exam.status)) fail(400, 'Marks entry has not been opened for this exam yet');
    const sub = await Subject.findById(sid).select('subjectName').lean();
    const name = sub?.subjectName || 'A subject';

    await pool.withTransaction(async (q) => {
        if (!MARKS_OPEN.includes(exam.status)) {
            await writeExam(exam, { status: 'REOPENED', classApprovedBy: null, classApprovedAt: null }, {
                where: { status: exam.status, archivedAt: null }, q,
                entry: entryOf('SUBJECT_RETURNED', ctx, `${name} — ${why}`, { subject: sid }),
            });
        } else {
            await writeExam(exam, {}, { where: { archivedAt: null }, q, entry: entryOf('SUBJECT_RETURNED', ctx, `${name} — ${why}`, { subject: sid }) });
        }
        const { rowCount } = await q(
            `UPDATE "${ExamMarksSheet.tableName}"
                SET "status" = 'DRAFT', "version" = COALESCE("version", 0) + 1, "updatedAt" = now(),
                    "auditLog" = (CASE WHEN jsonb_typeof("auditLog") = 'array' THEN "auditLog" ELSE '[]'::jsonb END) || $3::jsonb
              WHERE "exam" = $1::uuid AND "subject" = $2::uuid AND "status" = 'SUBMITTED'`,
            [String(exam._id), sid, JSON.stringify([{ action: 'RETURNED', by: String(ctx.userId), at: new Date(), notes: why }])]);
        if (!rowCount && MARKS_OPEN.includes(exam.status)) fail(400, `${name}'s marks have not been submitted yet — there is nothing to send back`);
    });

    const teachers = (await SectionSubjectTeacher.find({ section: exam.section, subject: sid }).select('teacher').lean().catch(() => [])).map((x) => String(x.teacher));
    tell(ctx, exam, {
        title: `↩️ ${name} marks sent back: ${exam.title}`,
        body: `The ${name} marks for "${exam.title}" have been sent back for correction. Correct them and submit again.\nReason: ${why}`,
        recipients: [...new Set([...teachers, ...(await classTeachersOf(exam).catch(() => []))])].filter((x) => x !== String(ctx.userId)),
    });
    return exam;
}

/* ── Putting away ─────────────────────────────────────────────────────────── */

async function archiveExam(ctx, id) {
    const exam = await load(ctx, id);
    if (exam.archivedAt) fail(400, 'This exam is already archived');
    await writeExam(exam, { archivedAt: new Date(), archivedBy: ctx.userId }, {
        where: { archivedAt: null }, entry: entryOf('ARCHIVED', ctx), moved: 'This exam is already archived',
    });
    // Put away before it was sat: it leaves every schedule, so whoever its
    // timetable reached hears it is off. Published results stay visible.
    if (exam.status !== 'FINAL_APPROVED') announceCancelled(ctx, exam, 'called off');
    return exam;
}

async function restoreExam(ctx, id) {
    const exam = await load(ctx, id);
    if (!exam.archivedAt) fail(400, 'This exam is not archived');
    await writeExam(exam, { archivedAt: null, archivedBy: null }, {
        where: { archivedAt: { $ne: null } }, entry: entryOf('RESTORED', ctx), moved: 'This exam has already been restored',
    });
    if (exam.status !== 'FINAL_APPROVED') announceTimetable(ctx, exam, null);
    return exam;
}

/**
 * One action over several exams. Each exam is its own decision — one refused
 * by the rules must not take the rest down with it — so they run one at a time
 * and the refusals come back named. An unexpected failure is named too: it
 * used to abort the batch with a 500, though the exams before it were done.
 */
const BULK = {
    open: (ctx, id) => openMarksEntry(ctx, id),
    publish: (ctx, id) => publishExam(ctx, id),
    archive: (ctx, id) => archiveExam(ctx, id),
    restore: (ctx, id) => restoreExam(ctx, id),
    delete: (ctx, id) => deleteExam(ctx, id),
};
async function bulk(ctx, action, ids) {
    const run = BULK[action];
    if (!run) fail(400, 'Unknown action');
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(isUuid);
    if (!list.length) fail(400, 'Select at least one exam');
    if (list.length > 100) fail(400, 'Select at most 100 exams at a time');

    const done = []; const failed = [];
    for (const id of list) {
        try {
            await run(ctx, id);
            done.push(id);
        } catch (e) {
            if (!(e instanceof RuleError)) console.error(`[results] bulk ${action} of ${id} failed:`, e);
            let title = '';
            try {
                title = (await FormalExam.findOne({ _id: id, school: ctx.schoolId }).select('title').lean())?.title || '';
            } catch { /* the id may not name an exam at all */ }
            failed.push({ _id: id, title, message: e instanceof RuleError ? e.message : 'Something went wrong with this one — try it again on its own' });
        }
    }
    return { done, failed };
}

/* ── Re-exams ─────────────────────────────────────────────────────────────── */

const RE_EXAM_RULES = ['scored', 'pass'];
const plainOf = (exam) => (typeof exam?.toObject === 'function' ? exam.toObject() : exam);

/**
 * A paper sat again replaces the paper in the result — as scored, or at
 * exactly the pass mark when the school counts a re-exam pass as a bare pass
 * (exam.reExam.rule). Only a paper the result did not pass is replaced, so a
 * re-exam mark left over from before a correction is ignored, never misapplied.
 *
 * Grace is looked at again afterwards: a student who failed Maths badly and
 * Science by two marks was given no grace (it is all or nothing), passed Maths
 * on the re-exam — and stayed failed for the two marks grace would now cover.
 * Changes `rows` in place (computeResults' output) and returns them.
 */
function applyReExams(rows, exam, scale, { grace = null } = {}) {
    const rx = exam?.reExam;
    const list = Array.isArray(rx?.marks) ? rx.marks : [];
    if (!list.length) return rows;
    const rule = rx.rule === 'pass' ? 'pass' : 'scored';
    const markOf = new Map(list.map((m) => [`${m.student}:${m.subject}`, m]));
    for (const r of rows) {
        let changed = false;
        r.subjects = r.subjects.map((x) => {
            const m = markOf.get(`${r.student}:${x.subject}`);
            if (!m || x.isPassed || x.gradeOnly) return x;
            const absent = !!m.isAbsent;
            const sat = absent ? 0 : round2(Number(m.marksObtained) || 0);
            const passed = !absent && sat >= x.passingMarks;
            const counted = passed && rule === 'pass' ? x.passingMarks : sat;
            changed = true;
            return {
                ...x, marksObtained: counted, graceMarks: 0, isAbsent: absent, isPassed: passed,
                grade: gradeFor(counted, x.maxMarks, passed, absent, scale),
                // A paper in parts is re-sat whole: its parts' first marks stay in `original`.
                components: null,
                reExam: {
                    marksObtained: absent ? null : sat, isAbsent: absent,
                    original: { marksObtained: x.marksObtained, isAbsent: x.isAbsent, grade: x.grade, graceMarks: x.graceMarks, components: x.components || null },
                },
            };
        });
        if (!changed) continue;
        const counted = r.subjects.filter((x) => !x.gradeOnly);
        if (grace && !counted.every((x) => x.isPassed)) applyGrace(counted, grace, scale);
        r.totalMarks = round2(counted.reduce((t, x) => t + x.marksObtained, 0));
        r.percentage = r.totalMaxMarks > 0 ? round2((r.totalMarks / r.totalMaxMarks) * 100) : 0;
        r.isPassed = counted.every((x) => x.isPassed);
        r.grade = overallGrade(r.percentage, r.isPassed, scale);
        r.reExam = true;
    }
    return rows;
}

/** One paper as the figures that matter, whatever order its keys are stored in. */
const paperKey = (x) => [
    String(x.subject), round2(Number(x.marksObtained) || 0), round2(Number(x.graceMarks) || 0), !!x.isPassed, !!x.isAbsent, x.grade || '',
    x.reExam ? `${x.reExam.marksObtained ?? ''}|${!!x.reExam.isAbsent}` : '',
].join('/');
/** Whether a stored result and a worked-out one say the same thing. */
const sameResult = (a, b) => a.isPassed === b.isPassed
    && (a.subjects || []).map(paperKey).sort().join(',') === (b.subjects || []).map(paperKey).sort().join(',');

/** Each student's papers not passed in the exam itself, before any re-exam: Map(student → Map(subject → paper)). */
async function failedPapers(exam) {
    const base = await computeResults({ ...plainOf(exam), reExam: null });
    const out = new Map();
    base.forEach((r) => {
        const failed = r.subjects.filter((x) => !x.isPassed && !x.gradeOnly);
        if (failed.length) out.set(String(r.student), new Map(failed.map((x) => [String(x.subject), x])));
    });
    return out;
}

/**
 * Who may sit a re-exam at all: the school may limit it to students who failed
 * at most so many papers (compartment) — one who failed more repeats the year,
 * or stays, as the exam says. Map(student → reason) for those who may not.
 */
async function notEligible(exam, failed) {
    const conf = await settings.get(exam.school);
    const most = Number(conf.reExamMaxSubjects) || 0;
    const out = new Map();
    if (!most) return out;
    for (const [sid, papers] of failed) {
        if (papers.size > most) out.set(sid, `Failed ${papers.size} papers — a re-exam is allowed in at most ${most}`);
    }
    return out;
}

/**
 * The subjects of this exam's section a teacher teaches — the papers whose
 * re-exam marks are theirs to enter. A teacher may enter them once the office
 * has opened the re-exam (set its date, or entered a first mark).
 */
async function reExamSubjectsOf(exam, teacherId) {
    if (!exam.reExam || typeof exam.reExam !== 'object') fail(409, 'The office has not set up a re-exam for this exam yet');
    const mine = (await SectionSubjectTeacher.find({ section: exam.section, teacher: teacherId }).select('subject').lean())
        .map((x) => idOf(x.subject)).filter((sid) => subjectIdsOf(exam).includes(sid));
    if (!mine.length) fail(403, 'You do not teach a subject of this exam in this section');
    return new Set(mine);
}

/** A re-exam paper's own sitting, if the office gave it one, else the re-exam's date. */
function reSitting(rx, subjectId) {
    const p = rx?.papers && typeof rx.papers === 'object' ? rx.papers[String(subjectId)] : null;
    if (p && p.date) return { date: p.date, startTime: p.startTime || '', endTime: p.endTime || '' };
    return rx?.date ? { date: rx.date, startTime: '', endTime: '' } : null;
}

/**
 * GET /admin/results/exams/:id/re-exam — who may sit a re-exam, and what has
 * been entered: every student the published results failed, each paper they
 * did not pass with its first mark and any re-exam mark, and where the result
 * stands now. A subject teacher (`teacherId`) sees their own subjects' papers.
 */
async function reExamBoard(ctx, id, { teacherId = null } = {}) {
    const exam = await load(ctx, id);
    if (exam.status !== 'FINAL_APPROVED') fail(409, 'A re-exam follows published results — publish the results first');
    const mine = teacherId ? await reExamSubjectsOf(exam, teacherId) : null;
    const [allFailed, stored] = await Promise.all([
        failedPapers(exam),
        FormalResult.find({ exam: exam._id }).select('student isPassed subjects').lean(),
    ]);
    const barred = await notEligible(exam, allFailed);
    // A teacher's view: only the papers of their subjects, and the students who failed one.
    const failed = new Map();
    for (const [sid, papers] of allFailed) {
        const keep = mine ? new Map([...papers].filter(([sub]) => mine.has(sub))) : papers;
        if (keep.size) failed.set(sid, keep);
    }
    const nowOf = new Map(stored.map((r) => [String(r.student), r]));
    const ids = [...failed.keys()];
    const [users, subs, rolls] = await Promise.all([
        ids.length ? User.find({ _id: { $in: ids } }).select('name isActive').lean() : [],
        Subject.find({ _id: { $in: subjectIdsOf(exam) } }).select('subjectName subjectCode').lean(),
        ids.length ? pool.query(`SELECT DISTINCT ON ("user") "user"::text AS "user", "rollNumber", "admissionNumber" FROM "studentprofiles"
                                  WHERE "user" = ANY($1::uuid[]) ORDER BY "user", "createdAt" DESC NULLS LAST`, [ids]) : { rows: [] },
    ]);
    const nameOf = new Map(users.map((u) => [String(u._id), u]));
    const rollOf = new Map(rolls.rows.map((r) => [r.user, r]));
    const subOf = new Map(subs.map((x) => [String(x._id), x]));
    const rx = exam.reExam || {};
    const markOf = new Map((Array.isArray(rx.marks) ? rx.marks : []).map((m) => [`${m.student}:${m.subject}`, m]));

    const students = ids.map((sid) => {
        const now = nowOf.get(sid);
        const papers = [...failed.get(sid).values()].map((x) => {
            const m = markOf.get(`${sid}:${x.subject}`);
            const after = (now?.subjects || []).find((y) => String(y.subject) === String(x.subject));
            return {
                subject: x.subject, subjectName: subOf.get(String(x.subject))?.subjectName || 'Subject',
                maxMarks: x.maxMarks, passingMarks: x.passingMarks,
                first: { marksObtained: x.isAbsent ? null : x.marksObtained, isAbsent: x.isAbsent, grade: x.grade },
                reExam: m ? { marksObtained: m.isAbsent ? null : Number(m.marksObtained), isAbsent: !!m.isAbsent } : null,
                passedNow: !!after?.isPassed,
                sitting: reSitting(rx, x.subject),
            };
        });
        return {
            _id: sid, name: nameOf.get(sid)?.name || 'Student', isActive: nameOf.get(sid)?.isActive !== false,
            rollNumber: rollOf.get(sid)?.rollNumber || '', admissionNumber: rollOf.get(sid)?.admissionNumber || '',
            papers, passedNow: !!now?.isPassed,
            eligible: !barred.has(sid), notEligibleReason: barred.get(sid) || '',
        };
    }).sort((a, b) => (Number(a.rollNumber) || 1e9) - (Number(b.rollNumber) || 1e9) || a.name.localeCompare(b.name));

    const papers = students.flatMap((x) => x.papers);
    const section = await ClassSection.findById(exam.section).select('sectionName class').lean();
    const cls = section?.class ? await Class.findById(section.class).select('className').lean() : null;
    // The papers that have anyone to sit them, for the office's per-paper dates.
    const subjectsOwed = [...new Set(papers.map((x) => String(x.subject)))].map((sub) => ({
        subject: sub, subjectName: subOf.get(sub)?.subjectName || 'Subject',
        date: rx.papers?.[sub]?.date || null, startTime: rx.papers?.[sub]?.startTime || '', endTime: rx.papers?.[sub]?.endTime || '',
    }));
    return {
        exam: {
            _id: exam._id, title: exam.title, status: exam.status, examType: exam.examType, promotes: promotion().promotes(exam),
            className: cls?.className || '', sectionName: section?.sectionName || '',
        },
        // The office sets the dates and how a pass counts; a teacher enters marks.
        office: !teacherId,
        rule: RE_EXAM_RULES.includes(rx.rule) ? rx.rule : 'scored',
        date: rx.date || null, note: rx.note || '',
        papers: subjectsOwed,
        maxSubjects: (await settings.get(exam.school)).reExamMaxSubjects || null,
        students,
        counts: {
            students: students.length, papers: papers.length,
            entered: papers.filter((x) => x.reExam).length,
            passedNow: students.filter((x) => x.passedNow).length,
            notEligible: students.filter((x) => !x.eligible).length,
        },
    };
}

class ReExamConflict extends Error {}

/**
 * PUT /admin/results/exams/:id/re-exam — the re-exam's dates, how a pass
 * counts, and marks for papers students did not pass.
 *
 * Only what the body names changes. A mark is checked like any other (a
 * number, within the paper's maximum); `clear` takes one back. The results
 * that change are rewritten in place — the rank stays the exam's own — and
 * each family whose result changed is told. A final exam that promotes moves
 * a student up who now passes — and back, if a corrected re-exam mark means
 * they no longer do (services/resultPromotion.afterReExam).
 *
 * Two teachers saving their subjects' marks at the same moment used to lose
 * one of them: each merged its marks into the re-exam it had READ, and the
 * second write replaced the first. The save is now checked against what it
 * read, under the exam's lock, and done again on top of the other if they
 * collided.
 */
async function saveReExam(ctx, id, body = {}, opts = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await saveReExamOnce(ctx, id, body, opts);
        } catch (e) {
            if (e instanceof ReExamConflict && attempt < 5) continue;
            if (e instanceof ReExamConflict) fail(409, 'Somebody else is saving re-exam marks for this exam — try again in a moment');
            throw e;
        }
    }
}

const timeOf = (v, what) => {
    const t = String(v ?? '').trim();
    if (!t) return '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail(400, `The ${what} time is not a valid time`);
    return t;
};

async function saveReExamOnce(ctx, id, body = {}, { teacherId = null } = {}) {
    const exam = await load(ctx, id);
    if (exam.status !== 'FINAL_APPROVED') fail(409, 'A re-exam follows published results — publish the results first');
    // The re-exam as it is stored, read once: what this save builds on, and
    // what it checks has not changed when it comes to write.
    const { rows: [read] } = await pool.query(`SELECT "reExam"::text AS "t" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid`, [String(exam._id)]);
    const readText = read?.t ?? null;
    exam.reExam = readText ? JSON.parse(readText) : null;
    const mine = teacherId ? await reExamSubjectsOf(exam, teacherId) : null;
    if (mine && (body.rule !== undefined || body.date !== undefined || body.note !== undefined || body.papers !== undefined)) {
        fail(403, 'The office sets the re-exam dates and how a pass counts — you enter the marks');
    }
    const rx = exam.reExam && typeof exam.reExam === 'object' ? exam.reExam : {};
    const rule = body.rule === undefined ? (RE_EXAM_RULES.includes(rx.rule) ? rx.rule : 'scored') : String(body.rule);
    if (!RE_EXAM_RULES.includes(rule)) fail(400, 'Choose how a re-exam pass counts: as scored, or at the pass mark');
    let date = rx.date ? dayOf(rx.date) : null;
    if (body.date !== undefined) {
        date = dayOf(body.date);
        if (date === undefined) fail(400, 'Give the re-exam date as a day');
        if (date && exam.endDate && date < dayOf(exam.endDate)) fail(400, 'A re-exam cannot come before the exam itself ends');
    }
    const note = body.note === undefined ? (rx.note || '') : String(body.note || '').trim();
    if (note.length > 300) fail(400, 'The re-exam note is 300 characters at most');

    // Each paper's own sitting: { subject: { date, startTime, endTime } }.
    const papers = { ...(rx.papers && typeof rx.papers === 'object' ? rx.papers : {}) };
    const movedPapers = [];
    if (body.papers !== undefined) {
        for (const p of Array.isArray(body.papers) ? body.papers : []) {
            const sub = String(p?.subject || '');
            if (!subjectIdsOf(exam).includes(sub)) fail(400, 'That subject is not part of this exam');
            const d = dayOf(p.date);
            if (d === undefined) fail(400, 'Give each re-exam paper\'s date as a day');
            if (d && exam.endDate && d < dayOf(exam.endDate)) fail(400, 'A re-exam paper cannot come before the exam itself ends');
            const startTime = timeOf(p.startTime, 'start'); const endTime = timeOf(p.endTime, 'end');
            if (endTime && !startTime) fail(400, 'Give the time the paper starts as well as when it ends');
            if (startTime && endTime && endTime <= startTime) fail(400, 'A re-exam paper cannot end before it starts');
            if ((startTime || endTime) && !d) fail(400, 'Give the re-exam paper a date to go with its time');
            const before = papers[sub] || null;
            const next = d ? { date: d, startTime, endTime } : null;
            const key = (x) => (x ? `${keyOfDay(x.date)}|${x.startTime || ''}|${x.endTime || ''}` : '');
            if (key(before) !== key(next)) movedPapers.push(sub);
            if (next) papers[sub] = next; else delete papers[sub];
        }
    }

    const failed = await failedPapers(exam);
    const barred = await notEligible(exam, failed);
    const marks = new Map((Array.isArray(rx.marks) ? rx.marks : []).map((m) => [`${m.student}:${m.subject}`, m]));
    const at = new Date();
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const subs = await Subject.find({ _id: { $in: subjectIdsOf(exam) } }).select('subjectName').lean();
    const nameOf = (sid) => subs.find((x) => String(x._id) === String(sid))?.subjectName || 'A subject';
    for (const e of entries) {
        const student = String(e?.student || ''); const subject = String(e?.subject || '');
        if (mine && !mine.has(subject)) fail(403, `You do not teach ${nameOf(subject)} in this section`);
        const paper = failed.get(student)?.get(subject);
        if (!paper) fail(400, 'A re-exam is only for a paper the student did not pass');
        const key = `${student}:${subject}`;
        if (e.clear) { marks.delete(key); continue; }
        if (barred.has(student)) fail(400, barred.get(student));
        if (e.isAbsent) { marks.set(key, { student, subject, marksObtained: null, isAbsent: true, at, by: String(ctx.userId) }); continue; }
        const v = Number(e.marksObtained);
        if (e.marksObtained === '' || e.marksObtained === null || e.marksObtained === undefined || !Number.isFinite(v)) fail(400, `${nameOf(subject)}: marks must be a number`);
        if (v < 0 || v > paper.maxMarks) fail(400, `${nameOf(subject)}: marks are between 0 and ${paper.maxMarks}`);
        marks.set(key, { student, subject, marksObtained: round2(v), isAbsent: false, at, by: String(ctx.userId) });
    }

    const next = { rule, date, note, papers, marks: [...marks.values()], updatedAt: at };
    const before = await FormalResult.find({ exam: exam._id }).select('student isPassed subjects').lean();
    const beforeOf = new Map(before.map((r) => [String(r.student), r]));
    const rows = await computeResults({ ...plainOf(exam), reExam: next });
    // Compared field by field: a stored row comes back from JSONB with its keys
    // in another order, so as text every row looked changed — and every family
    // in the section was told about a re-exam they never sat.
    const changed = rows.filter((r) => {
        const b = beforeOf.get(String(r.student));
        return b && !sameResult(b, r);
    });
    const entered = entries.filter((e) => !e.clear).length;
    const cleared = entries.filter((e) => e.clear).length;
    const sameDay = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
    const notes = [
        entered ? `${entered} re-exam mark${entered === 1 ? '' : 's'} entered` : '',
        cleared ? `${cleared} taken back` : '',
        body.date !== undefined && !sameDay(date, rx.date) ? (date ? `re-exam on ${fmtDay(date)}` : 're-exam date cleared') : '',
        movedPapers.length ? `${movedPapers.map(nameOf).join(', ')} dated` : '',
        body.rule !== undefined && rule !== (rx.rule || 'scored') ? `a re-exam pass counts ${rule === 'pass' ? 'at the pass mark' : 'as scored'}` : '',
    ].filter(Boolean).join(' · ');
    const entry = { action: 'RE_EXAM', by: String(ctx.userId), at, notes };
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(
            `SELECT "status", "reExam"::text AS "t" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (now?.status !== 'FINAL_APPROVED') fail(409, 'These results have been withdrawn since the page was opened — reload it');
        // Somebody else saved between this save's read and now: do it again on top of theirs.
        if ((now.t ?? null) !== readText) throw new ReExamConflict();
        await q(`UPDATE "${FormalExam.tableName}" SET "reExam" = $2::jsonb, "updatedAt" = $3${notes ? `, "auditLog" = ${APPEND_LOG('$4')}` : ''} WHERE "_id" = $1::uuid`,
            [String(exam._id), JSON.stringify(next), at, ...(notes ? [JSON.stringify([entry])] : [])]);
        for (const r of changed) {
            await q(`UPDATE "${FormalResult.tableName}" SET "subjects" = $3::jsonb, "totalMarks" = $4, "percentage" = $5, "grade" = $6,
                            "isPassed" = $7, "reExam" = $8 WHERE "exam" = $1::uuid AND "student" = $2::uuid`,
            [String(exam._id), String(r.student), JSON.stringify(r.subjects), r.totalMarks, r.percentage, r.grade, r.isPassed, !!r.reExam]);
        }
    });
    exam.reExam = next;

    // Families whose result changed hear the new one; with a new date, those
    // still to sit hear when — only where the results are theirs to see, and
    // never a family whose result the school is holding back.
    const held = withheldOf(exam);
    if (visibleToFamilies(exam) && optionsOf(exam).notifyOnPublish) {
        const passedNow = changed.filter((r) => r.isPassed && !beforeOf.get(String(r.student))?.isPassed).map((r) => String(r.student)).filter((sid) => !held.has(sid));
        const others = changed.filter((r) => !passedNow.includes(String(r.student))).map((r) => String(r.student)).filter((sid) => !held.has(sid));
        if (passedNow.length) {
            familyOf(exam.school, passedNow).then((recipients) => tell(ctx, exam, {
                title: `🎉 Re-exam result: ${exam.title}`, recipients, type: 'results.mine',
                body: `The re-exam marks for "${exam.title}" are in, and the result is now a pass. The scorecard shows the new marks.`,
            })).catch(() => {});
        }
        if (others.length) {
            familyOf(exam.school, others).then((recipients) => tell(ctx, exam, {
                title: `📄 Re-exam marks: ${exam.title}`, recipients, type: 'results.mine',
                body: `Re-exam marks for "${exam.title}" have been entered. The scorecard shows the new marks.`,
            })).catch(() => {});
        }
    }
    // A new date for the whole re-exam, or for some papers: whoever still has
    // those papers to sit hears when, and so do the teachers who mark them.
    const dateMoved = body.date !== undefined && date && !sameDay(date, rx.date);
    if (dateMoved || movedPapers.length) announceReSittings(ctx, exam, next, failed, barred, { all: dateMoved, papers: movedPapers, nameOf, held });

    // Who passes now may move up, where the final has already moved the others
    // — and who no longer passes (a re-exam mark corrected or taken back) goes
    // back to where the exam left them.
    const nowPassing = changed.filter((r) => r.isPassed && !beforeOf.get(String(r.student))?.isPassed).map((r) => String(r.student));
    const nowFailing = changed.filter((r) => !r.isPassed && beforeOf.get(String(r.student))?.isPassed).map((r) => String(r.student));
    if ((nowPassing.length || nowFailing.length) && promotion().promotes(exam)) {
        await promotion().afterReExam(exam._id, { passed: nowPassing, failed: nowFailing }, ctx.userId)
            .catch((e) => console.error('[results] re-exam promotion failed:', e.message));
    }
    return reExamBoard(ctx, exam._id, { teacherId });
}

/** The re-exam papers' sittings, told to whoever still has them to sit and the teachers who mark them. */
function announceReSittings(ctx, exam, rx, failed, barred, { all, papers, nameOf, held }) {
    const moved = new Set(papers.map(String));
    const owedBySubject = new Map();
    for (const [sid, list] of failed) {
        if (barred.has(sid)) continue;
        for (const sub of list.keys()) {
            if (!all && !moved.has(sub)) continue;
            if ((rx.marks || []).some((m) => String(m.student) === sid && String(m.subject) === sub)) continue;
            if (!owedBySubject.has(sub)) owedBySubject.set(sub, []);
            owedBySubject.get(sub).push(sid);
        }
    }
    if (!owedBySubject.size) return;
    const when = (sub) => {
        const s = reSitting(rx, sub);
        return s ? sittingText({ examDate: s.date, startTime: s.startTime, endTime: s.endTime }) : 'date to be announced';
    };
    // One day for every paper: the title says it.
    const days = new Set([...owedBySubject.keys()].map((sub) => keyOfDay(reSitting(rx, sub)?.date)));
    const titleFor = (prefix) => (days.size === 1 && [...days][0] ? `${prefix} on ${fmtDay(reSitting(rx, [...owedBySubject.keys()][0]).date)}: ${exam.title}` : `${prefix}: ${exam.title}`);
    SectionSubjectTeacher.find({ section: exam.section, subject: { $in: [...owedBySubject.keys()] } }).select('subject teacher').lean()
        .then((links) => {
            const byTeacher = new Map();
            links.forEach((l) => {
                const t = idOf(l.teacher); const sub = idOf(l.subject);
                if (!byTeacher.has(t)) byTeacher.set(t, []);
                byTeacher.get(t).push(`${nameOf(sub)} on ${when(sub)} (${plural(owedBySubject.get(sub)?.length || 0, 'student')})`);
            });
            for (const [t, list] of byTeacher) {
                tell(ctx, exam, {
                    title: titleFor('📝 Re-exam'), recipients: [t], type: 'results.reexam',
                    body: `${list.join('; ')} — enter the re-exam marks once the papers are sat, under Results → Re-exams.`,
                });
            }
        }).catch(() => {});
    if (!(visibleToFamilies(exam) && optionsOf(exam).notifyOnPublish)) return;
    const byStudent = new Map();
    for (const [sub, sids] of owedBySubject) for (const sid of sids) {
        if (held.has(sid)) continue;
        if (!byStudent.has(sid)) byStudent.set(sid, []);
        byStudent.get(sid).push(`${nameOf(sub)}: ${when(sub)}`);
    }
    for (const [sid, list] of byStudent) {
        familyOf(exam.school, [sid]).then((recipients) => tell(ctx, exam, {
            title: `📝 Re-exam: ${exam.title}`, recipients, type: 'results.mine',
            body: `${list.join('\n')}${rx.note ? `\n${rx.note}` : ''}`,
        })).catch(() => {});
    }
}

/* ── After publishing ────────────────────────────────────────────────────── */

/**
 * Replace an exam's stored results with these, in place: a student's row is
 * updated (its id stays — a family's open scorecard keeps working), a new one
 * inserted, one with no result any more removed. `q` is the caller's
 * transaction, which holds the exam's lock.
 */
async function syncResults(exam, rows, q) {
    const T = `"${FormalResult.tableName}"`;
    const { rows: stored } = await q(`SELECT "_id", "student" FROM ${T} WHERE "exam" = $1::uuid`, [String(exam._id)]);
    const idOfStudent = new Map(stored.map((r) => [String(r.student), String(r._id)]));
    const keep = new Set();
    const at = new Date();
    for (const r of rows) {
        const sid = String(r.student);
        keep.add(sid);
        const vals = [JSON.stringify(r.subjects), r.totalMarks, r.totalMaxMarks, r.percentage, r.grade, r.rank, r.isPassed, !!r.reExam];
        if (idOfStudent.has(sid)) {
            await q(`UPDATE ${T} SET "subjects" = $2::jsonb, "totalMarks" = $3, "totalMaxMarks" = $4, "percentage" = $5, "grade" = $6,
                                    "rank" = $7, "isPassed" = $8, "reExam" = $9 WHERE "_id" = $1::uuid`, [idOfStudent.get(sid), ...vals]);
        } else {
            await q(`INSERT INTO ${T} ("_id", "exam", "student", "school", "section", "academicYear", "subjects",
                                       "totalMarks", "totalMaxMarks", "percentage", "grade", "rank", "isPassed", "reExam", "generatedAt")
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [newId(), String(exam._id), sid, String(exam.school), String(exam.section), String(exam.academicYear), ...vals, at]);
        }
    }
    const gone = stored.filter((r) => !keep.has(String(r.student))).map((r) => String(r._id));
    if (gone.length) await q(`DELETE FROM ${T} WHERE "_id" = ANY($1::uuid[])`, [gone]);
}

/**
 * Correct one paper of a published result in place (Oct 2026) — a mark
 * misread off the answer sheet, found when a family asked for it to be
 * checked again. The only way used to be withdrawing every student's result,
 * every teacher submitting again, and publishing afresh.
 *
 * The sheet's entry changes (with who, why and from what, in its history),
 * the exam's results are worked out again on the scale they were published on
 * — ranks included, since the paper is the exam's own — and the family is
 * told. A student whose pass or fail it turns moves with it, where the exam
 * promotes (resultPromotion.afterReExam).
 */
async function correctPublishedMark(ctx, id, body = {}) {
    const exam = await load(ctx, id);
    if (exam.status !== 'FINAL_APPROVED') fail(409, 'Only published results are corrected here — until then, correct the marks sheet');
    const student = String(body.student || ''); const subjectId = String(body.subject || '');
    const cfg = (exam.subjects || []).find((x) => idOf(x.subject) === subjectId);
    if (!cfg) fail(404, 'That subject is not part of this exam');
    if (!isUuid(student)) fail(400, 'Choose the student');
    const why = String(body.reason || '').trim();
    if (!why) fail(400, 'Say why the mark is being corrected — it is kept in the exam\'s history');
    const scale = exam.gradeBands?.bands ? exam.gradeBands : await scaleForExam(exam);
    const grades = new Set((scale.bands || []).map((b) => b.grade));
    const stored = await FormalResult.findOne({ exam: exam._id, student }).select('isPassed').lean();
    if (!stored) fail(404, 'That student has no result in this exam');

    const at = new Date();
    let change = null;
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "status" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (now?.status !== 'FINAL_APPROVED') fail(409, 'These results have been withdrawn since the page was opened — reload it');
        const { rows: [sheet] } = await q(
            `SELECT * FROM "${ExamMarksSheet.tableName}" WHERE "exam" = $1::uuid AND "subject" = $2::uuid FOR UPDATE`, [String(exam._id), subjectId]);
        if (!sheet) fail(404, 'That subject has no marks sheet');
        const entries = Array.isArray(sheet.entries) ? sheet.entries : [];
        const before = entries.find((e) => String(e.student) === student) || null;
        const next = cleanEntry(cfg, { ...body, student, remarks: body.remarks ?? before?.remarks ?? '' }, grades);
        if (!answeredFor(cfg, next)) fail(400, 'Give the corrected mark, or mark the student absent');
        if (figuresOf(before) === figuresOf(next)) fail(400, 'That is already the mark on the sheet');
        change = { student, before: figureText(before), after: figureText(next) };
        const merged = before ? entries.map((e) => (String(e.student) === student ? next : e)) : [...entries, next];
        await q(
            `UPDATE "${ExamMarksSheet.tableName}"
                SET "entries" = $2::jsonb, "version" = COALESCE("version", 0) + 1, "updatedAt" = $3,
                    "auditLog" = (CASE WHEN jsonb_typeof("auditLog") = 'array' THEN "auditLog" ELSE '[]'::jsonb END) || $4::jsonb
              WHERE "_id" = $1::uuid`,
            [String(sheet._id), JSON.stringify(merged), at,
                JSON.stringify([{ action: 'CORRECTED_AFTER_PUBLISHING', by: String(ctx.userId), at, notes: why, changes: [change] }])]);
    });

    // Worked out again from the corrected sheet, then written under the lock.
    const rows = await computeResults(exam, { scale });
    const sub = await Subject.findById(subjectId).select('subjectName').lean();
    const subjectName = sub?.subjectName || 'A subject';
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "status" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        if (now?.status !== 'FINAL_APPROVED') fail(409, 'These results have been withdrawn since the page was opened — reload it');
        await syncResults(exam, rows, q);
        await writeExam(exam, {}, {
            q, entry: entryOf('MARK_CORRECTED', ctx, `${subjectName}: ${change.before} → ${change.after} — ${why}`, { subject: subjectId, student }),
        });
    });
    const mine = rows.find((r) => String(r.student) === student) || null;

    if (visibleToFamilies(exam) && optionsOf(exam).notifyOnPublish && !withheldOf(exam).has(student)) {
        familyOf(exam.school, [student]).then((recipients) => tell(ctx, exam, {
            title: `✏️ Result corrected: ${exam.title}`, recipients, type: 'results.mine',
            body: `A ${subjectName} mark in "${exam.title}" has been corrected (${change.before} → ${change.after}). The scorecard shows the result as it now stands.`,
        })).catch(() => {});
    }
    if (mine && stored.isPassed !== mine.isPassed && promotion().promotes(exam)) {
        await promotion().afterReExam(exam._id, mine.isPassed ? { passed: [student], failed: [] } : { passed: [], failed: [student] }, ctx.userId)
            .catch((e) => console.error('[results] promotion after a correction failed:', e.message));
    }
    return { change, result: mine };
}

/** Each of these students' unpaid fee balance in the year — Map(student → amount), only those who owe. */
async function feeDuesOf(schoolId, yearId, studentIds) {
    const ids = [...new Set((studentIds || []).map(String))].filter(isUuid);
    if (!ids.length) return new Map();
    const { rows } = await pool.query(
        `SELECT l."student"::text AS "student",
                SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) AS "due"
           FROM "${require('../models/FeeLedger').tableName}" l
          WHERE l."school" = $1::uuid AND l."academicYear" = $2::uuid AND l."student" = ANY($3::uuid[])
          GROUP BY 1 HAVING SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) > 0.004`,
        [String(schoolId), String(yearId), ids]).catch(() => ({ rows: [] }));
    return new Map(rows.map((r) => [r.student, Math.round(Number(r.due) * 100) / 100]));
}

/**
 * Hold back some students' results from them and their parents — unpaid fees,
 * a discipline matter — or release them again (Oct 2026). The result itself
 * is untouched: the office sees it, families see "withheld" and the reason.
 * It is the exam's input, so withdrawing and republishing keeps it.
 */
async function setWithheld(ctx, id, { students, withhold = true, reason = '' } = {}) {
    const exam = await load(ctx, id);
    if (exam.status !== 'FINAL_APPROVED') fail(409, 'A result can be withheld once it is published');
    const ids = [...new Set((Array.isArray(students) ? students : [students]).map(String))].filter(isUuid);
    if (!ids.length) fail(400, 'Choose the students');
    const why = String(reason || '').trim().slice(0, 200);
    if (withhold && !why) fail(400, 'Say why — the family sees the reason with "result withheld"');
    const have = new Set((await FormalResult.find({ exam: exam._id, student: { $in: ids } }).select('student').lean()).map((r) => String(r.student)));
    const list = ids.filter((sid) => have.has(sid));
    if (!list.length) fail(400, 'None of those students has a result in this exam');

    let changedIds = [];
    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "withheld" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        const current = new Map((Array.isArray(now?.withheld) ? now.withheld : []).map((w) => [String(w.student), w]));
        for (const sid of list) {
            if (withhold) {
                if (!current.has(sid)) changedIds.push(sid);
                current.set(sid, { student: sid, reason: why, by: String(ctx.userId), at: new Date() });
            } else if (current.delete(sid)) changedIds.push(sid);
        }
        if (!changedIds.length) return;
        await writeExam(exam, { withheld: [...current.values()] }, {
            q, entry: entryOf(withhold ? 'RESULTS_WITHHELD' : 'RESULTS_RELEASED', ctx,
                `${plural(changedIds.length, 'student')}${withhold ? ` — ${why}` : ''}`, { students: changedIds }),
        });
    });
    changedIds = changedIds.filter(Boolean);
    if (changedIds.length && visibleToFamilies(exam) && optionsOf(exam).notifyOnPublish) {
        familyOf(exam.school, changedIds).then((recipients) => tell(ctx, exam, withhold ? {
            title: `📊 Result withheld: ${exam.title}`, recipients, type: 'results.mine',
            body: `The school is holding back this result for now — ${why}. Please contact the school office.`,
        } : {
            title: `📊 Result released: ${exam.title}`, recipients, type: 'results.mine',
            body: `The result of "${exam.title}" is now available. Check the Results section for the scorecard.`,
        })).catch(() => {});
    }
    return { exam, changed: changedIds.length };
}

/**
 * A final exam's promotion decided by hand for one student (Oct 2026):
 * 'promote' — moves up although the result is not a pass (promoted on
 * condition); 'detain' — kept back although it is; null — as the result says.
 * Where the promotion has already run, the student moves now.
 */
async function setPromotionOverride(ctx, id, { student, decision = null, reason = '' } = {}) {
    const exam = await load(ctx, id);
    if (!promotion().promotes(exam)) fail(400, 'This exam does not promote students — switch promotion on first');
    const sid = String(student || '');
    if (!isUuid(sid)) fail(400, 'Choose the student');
    const want = decision === null || decision === '' ? null : String(decision);
    if (want && !['promote', 'detain'].includes(want)) fail(400, 'Choose to promote the student or to keep them back');
    const why = String(reason || '').trim().slice(0, 200);
    if (want && !why) fail(400, 'Say why — it is kept with the promotion');
    const { rows: [onRoll] } = await pool.query(
        `SELECT 1 FROM "${ClassSection.tableName}" s WHERE s."_id" = $1::uuid
            AND (CASE WHEN jsonb_typeof(s."enrolledStudents") = 'array' THEN s."enrolledStudents" ELSE '[]'::jsonb END) @> to_jsonb(ARRAY[$2::text])`,
        [String(exam.section), sid]);
    const hasResult = await FormalResult.findOne({ exam: exam._id, student: sid }).select('_id').lean();
    if (!onRoll && !hasResult) fail(400, 'That student is not in this exam\'s section');

    await pool.withTransaction(async (q) => {
        const { rows: [now] } = await q(`SELECT "promotionOverrides" FROM "${FormalExam.tableName}" WHERE "_id" = $1::uuid FOR UPDATE`, [String(exam._id)]);
        const list = (Array.isArray(now?.promotionOverrides) ? now.promotionOverrides : []).filter((o) => String(o.student) !== sid);
        if (want) list.push({ student: sid, decision: want, reason: why, by: String(ctx.userId), at: new Date() });
        const name = (await User.findById(sid).select('name').lean())?.name || 'A student';
        await writeExam(exam, { promotionOverrides: list }, {
            q, entry: entryOf('PROMOTION_DECIDED', ctx,
                want === 'promote' ? `${name}: promoted on condition — ${why}` : want === 'detain' ? `${name}: kept back — ${why}` : `${name}: as the result says`,
                { student: sid }),
        });
    });
    // Already run: the student moves (or is taken back) now.
    let moved = null;
    if (exam.status === 'FINAL_APPROVED' && ['done', 'waiting'].includes(exam.promotionState)) {
        moved = await promotion().reconsider(exam._id, [sid], ctx.userId).catch((e) => {
            console.error('[results] promotion decision failed:', e.message);
            fail(500, `The decision is saved, but moving the student failed: ${e.message}`);
        });
    }
    return { exam, moved };
}

/**
 * The release sweep (every ten minutes, server.js): results published with a
 * later result date reach families on that day — and now families are TOLD
 * on that day. They used to hear "on the way" when the office published, and
 * nothing when the results actually appeared. Claimed in SQL, so two servers
 * tell them once; only a result date of the last few days is looked at, so an
 * old exam is never announced again.
 */
async function releaseSweep({ now = new Date(), schoolId = null } = {}) {
    const { rows } = await pool.query(
        `SELECT "_id", "school", "publishDate" FROM "${FormalExam.tableName}"
          WHERE "status" = 'FINAL_APPROVED' AND "releaseNotifiedAt" IS NULL AND "publishDate" IS NOT NULL
            AND "publishDate" <= $1::timestamptz + interval '1 day' AND "publishDate" >= $1::timestamptz - interval '3 days'
            AND "showInPortal" IS DISTINCT FROM false AND "notifyOnPublish" IS DISTINCT FROM false
            ${schoolId ? 'AND "school" = $2::uuid' : ''}
          ORDER BY "publishDate" LIMIT 200`, [now, ...(schoolId ? [String(schoolId)] : [])]);
    let told = 0;
    for (const r of rows) {
        if (!released(r, now)) continue;
        const { rows: [claimed] } = await pool.query(
            `UPDATE "${FormalExam.tableName}" SET "releaseNotifiedAt" = now() WHERE "_id" = $1::uuid AND "releaseNotifiedAt" IS NULL RETURNING "_id"`,
            [String(r._id)]);
        if (!claimed) continue;
        try {
            const exam = await FormalExam.findById(r._id).lean();
            const by = exam.finalApprovedBy || exam.createdBy;
            const students = (await FormalResult.find({ exam: exam._id }).distinct('student')).map(String);
            const held = withheldOf(exam);
            announce({ schoolId: exam.school, userId: by, userRole: 'school_admin' }, exam, students.filter((sid) => !held.has(sid)));
            told += 1;
        } catch (e) {
            console.error(`[results] release notice for ${r._id} failed:`, e.message);
        }
    }
    return { exams: told };
}

/**
 * A marks sheet's history (Oct 2026): every save and submission, and every
 * mark that changed — who, when, from what to what. The changes used to be
 * recorded nowhere: a mark corrected after validation left no trace.
 */
async function sheetHistory(ctx, id, subjectId) {
    const exam = await load(ctx, id);
    if (!subjectIdsOf(exam).includes(String(subjectId))) fail(404, 'That subject is not part of this exam');
    const sheet = await ExamMarksSheet.findOne({ exam: exam._id, subject: subjectId }).select('auditLog').lean();
    const log = Array.isArray(sheet?.auditLog) ? sheet.auditLog : [];
    const people = [...new Set([
        ...log.map((a) => String(a.by || '')),
        ...log.flatMap((a) => (Array.isArray(a.changes) ? a.changes : []).map((c) => String(c.student || ''))),
    ].filter(isUuid))];
    const users = people.length ? await User.find({ _id: { $in: people } }).select('name').lean() : [];
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    const LABEL = {
        SAVED: 'Saved', SUBMITTED: 'Submitted', ADMIN_SAVED: 'Saved by the office', ADMIN_SUBMITTED: 'Submitted by the office',
        REOPENED: 'Sent back for correction', RETURNED: 'Sent back for correction', CORRECTED_AFTER_PUBLISHING: 'Corrected after publishing',
    };
    return {
        entries: log.map((a, i) => ({ ...a, i })).filter((a) => a.at)
            .sort((a, b) => (new Date(b.at) - new Date(a.at)) || (b.i - a.i))
            .map((a) => ({
                action: a.action, label: LABEL[a.action] || a.action, at: a.at, by: nameOf.get(String(a.by)) || '', notes: a.notes || '',
                changes: (Array.isArray(a.changes) ? a.changes : []).map((c) => ({ student: c.student, name: nameOf.get(String(c.student)) || 'Student', before: c.before, after: c.after })),
            })),
    };
}

module.exports = {
    RE_EXAM_RULES, PLACEMENTS, applyReExams, failedPapers, reExamBoard, saveReExam, reSitting,
    EXAM_TYPES, STATUS_LABELS, STAGES, MARKS_OPEN, GRADE_BANDS, RuleError,
    OPTION_DEFAULTS, OPTION_LABELS, GRACE_LIMITS, FAMILY_FILTER, SECTION_MODES,
    stageOf, calcGrade, gradeFor, overallGrade, dayOf, subjectIdsOf, rosterOf, load,
    optionsOf, visibleToFamilies, forFamily, offeredByClass, applyGrace,
    dayStart, releaseAt, released, releasedSql, familyOf, todayOf, timetableShared, withheldOf,
    takersOf, rollFor, answeredFor, classNumberOf, scaleForExam, entryOf, writeExam, trail,
    createExams, updateExam, setOptions, setResultDate, deleteExam,
    openMarksEntry, backToDraft, saveMarks, advanceIfComplete,
    validateExam, publishExam, rejectExam, reopenExam, returnSubject, generateResults, computeResults,
    archiveExam, restoreExam, bulk,
    correctPublishedMark, feeDuesOf, setWithheld, setPromotionOverride, releaseSweep, sheetHistory, syncResults,
};
