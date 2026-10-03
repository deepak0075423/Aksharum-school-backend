'use strict';
/**
 * Reminders about marks still owed, and steps still waiting (Oct 2026), by
 * each school's own settings (Results → Settings → Reminders):
 *
 *   subject teachers  of each subject whose sheet is not yet submitted, on an
 *                     exam open for mark entry (MARKS_PENDING, REOPENED) — the
 *                     day before the marks are due, then from the due day
 *                     every `repeatDays`; an exam with no due date: `afterDays`
 *                     after its last day, then every `repeatDays`
 *   class teachers    (and vice class teachers) of an exam whose sheets are
 *                     all in, waiting for them to validate it (SUBMITTED)
 *   the office        sheets still out after the day they were due (one
 *                     notice per exam, naming them); results validated and
 *                     not published, or rejected and not reopened, for
 *                     `repeatDays` — the steps only the office can take
 *
 * A subject with nobody to teach it, or a section with no class teacher, is
 * the office's to see to — the board already flags those. Archived exams are
 * left alone, and reminders stop GIVE_UP_DAYS after an exam ended.
 *
 * Each reminder is stamped on the exam (`reminders`: { key: when }) by an SQL
 * claim before it is sent, so two servers ticking at once send it once — and a
 * restart never sends it again before its time. "Today" is each school's own
 * (services/schoolClock). Every exam in the window is looked at, a page at a
 * time — the old single read of 500, oldest first, never reached the newest
 * exams once a busy platform had more than that.
 */
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const ExamMarksSheet = require('../models/ExamMarksSheet');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject = require('../models/Subject');
const settings = require('./resultSettings');
const designations = require('./designationService');
const schoolClock = require('./schoolClock');
const { notify, schoolAdminIds } = require('./notifyService');
const { dateKey, addDays } = require('./staffAttendanceDays');

const T = (M) => `"${M.tableName}"`;
const DAY = 24 * 60 * 60 * 1000;
const OPEN = ['MARKS_PENDING', 'REOPENED'];
const OFFICE = ['CLASS_APPROVED', 'REJECTED'];
const GIVE_UP_DAYS = 45;
const PAGE = 500;
const idOf = (v) => String(v?._id ?? v ?? '');
const todayFor = (schoolId) => schoolClock.todayIn(schoolClock.zoneOf(String(schoolId)));

/** Is the reminder `key` due on this exam today (on its school's calendar)? */
function isDue(exam, key, { afterDays, repeatDays }, now = new Date(), { from = null } = {}) {
    const today = todayFor(exam.school);
    // The first one: from `from` (a due day), else `afterDays` after the exam's last day.
    const start = from || (exam.endDate ? addDays(dateKey(exam.endDate), afterDays) : null);
    if (!start || today < start) return false;
    const last = exam.reminders && exam.reminders[key] ? new Date(exam.reminders[key]) : null;
    // Then every `repeatDays` — less an hour, so an hourly tick does not slip a day.
    return !last || now - last >= repeatDays * DAY - 60 * 60 * 1000;
}

/** Stamp the reminder, unless another tick has stamped it since — true when this one may send it. */
async function claim(exam, key, { repeatDays }, { once = false } = {}) {
    const { rows } = await pool.query(
        `UPDATE ${T(FormalExam)}
            SET "reminders" = COALESCE(CASE WHEN jsonb_typeof("reminders") = 'object' THEN "reminders" END, '{}'::jsonb) || jsonb_build_object($2::text, now())
          WHERE "_id" = $1::uuid
            AND ("reminders" ->> $2 IS NULL ${once ? '' : 'OR ("reminders" ->> $2)::timestamptz <= now() - make_interval(secs => $3)'})
          RETURNING "_id"`,
        // A statement is handed only the parameters it names.
        once ? [String(exam._id), key] : [String(exam._id), key, Math.max(0, repeatDays * 86400 - 3600)]);
    return rows.length > 0;
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00.000Z`) - new Date(`${a}T00:00:00.000Z`)) / DAY);
const ago = (n) => (n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Every exam that may be owed something, a page at a time. */
async function* candidates(schoolId) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const { rows } = await pool.query(
            `SELECT "_id", "school", "title", "section", "subjects", "status", "endDate", "marksDueDate", "reminders",
                    "classApprovedAt", "updatedAt", "auditLog"
               FROM ${T(FormalExam)}
              WHERE "status" = ANY($1::text[]) AND "archivedAt" IS NULL AND "endDate" IS NOT NULL
                AND "endDate" >= now() - make_interval(days => $2)
                AND "_id" > $3::uuid ${schoolId ? 'AND "school" = $5::uuid' : ''}
              ORDER BY "_id" LIMIT $4`,
            [[...OPEN, 'SUBMITTED', ...OFFICE], GIVE_UP_DAYS + 1, after, PAGE, ...(schoolId ? [String(schoolId)] : [])]);
        for (const r of rows) yield r;
        if (rows.length < PAGE) return;
        after = String(rows[rows.length - 1]._id);
    }
}

/** When the exam reached the step it is waiting at (the latest history entry that took it there). */
function since(exam, actions) {
    const log = Array.isArray(exam.auditLog) ? exam.auditLog : [];
    for (let i = log.length - 1; i >= 0; i -= 1) if (actions.includes(log[i].action)) return new Date(log[i].at);
    return exam.updatedAt ? new Date(exam.updatedAt) : null;
}

/**
 * One pass over every exam that may be owed something — or one school's
 * (`schoolId`, for tests). Returns what was sent.
 */
async function sweep({ now = new Date(), schoolId = null } = {}) {
    const out = { exams: 0, sheets: 0, validations: 0, office: 0 };
    const confOf = new Map();
    // A notice needs somebody to send it, and a scheduler is nobody: it goes
    // out under the school's first admin, marked as the system's.
    const senderOf = new Map();
    for await (const exam of candidates(schoolId)) {
        out.exams += 1;
        try {
            const k = String(exam.school);
            if (!confOf.has(k)) confOf.set(k, await settings.get(k));
            if (!senderOf.has(k)) senderOf.set(k, (await schoolAdminIds(k).catch(() => []))[0] || null);
            const full = confOf.get(k);
            const conf = full.reminders;
            const sender = senderOf.get(k);
            if (!conf.enabled || !sender) continue;
            if (exam.endDate > now && !OFFICE.includes(exam.status)) continue;   // still being sat
            const section = await ClassSection.findById(exam.section).select('sectionName class classTeacher substituteTeacher').lean();
            if (!section) continue;
            const cls = section.class ? await Class.findById(section.class).select('className').lean() : null;
            const where = [cls?.className, section.sectionName].filter(Boolean).join(' – ');
            const today = todayFor(exam.school);
            const due = exam.marksDueDate ? dateKey(exam.marksDueDate) : null;
            // The office's own reminders go out in its first admin's name — and
            // reach that admin too (a notice is otherwise never sent to its sender).
            const send = (recipients, title, body, type, link = exam._id) => notify({
                school: exam.school, sender, senderRole: 'system', title, body, recipients, link: { type, entityId: link },
                includeSender: type === 'results.exam',
            });

            if (OPEN.includes(exam.status)) {
                const subjectIds = (exam.subjects || []).map((s) => idOf(s.subject));
                const [sheets, links, subs] = await Promise.all([
                    ExamMarksSheet.find({ exam: exam._id }).select('subject status').lean(),
                    SectionSubjectTeacher.find({ section: exam.section, subject: { $in: subjectIds } }).select('subject teacher').lean(),
                    Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean(),
                ]);
                const done = new Set(sheets.filter((s) => s.status === 'SUBMITTED').map((s) => idOf(s.subject)));
                const nameOf = (sid) => subs.find((s) => idOf(s._id) === sid)?.subjectName || 'A subject';
                const owed = subjectIds.filter((sid) => !done.has(sid));
                for (const sid of owed) {
                    const teachers = [...new Set(links.filter((l) => idOf(l.subject) === sid).map((l) => idOf(l.teacher)))];
                    if (!teachers.length) continue;
                    const name = nameOf(sid);
                    if (due) {
                        // The day before: a heads-up, once.
                        if (today === addDays(due, -1) && await claim(exam, `soon:${sid}`, conf, { once: true })) {
                            send(teachers, `⏰ Marks due tomorrow: ${name}, ${exam.title}`,
                                `The ${name} marks for "${exam.title}" (${where}) are due tomorrow, ${fmtDay(exam.marksDueDate)}.`, 'results.marks');
                            out.sheets += 1;
                            continue;
                        }
                        // From the due day: overdue, every repeatDays.
                        if (!isDue(exam, `sheet:${sid}`, conf, now, { from: due }) || !(await claim(exam, `sheet:${sid}`, conf))) continue;
                        const late = daysBetween(due, today);
                        send(teachers, late ? `⏰ Marks overdue: ${name}, ${exam.title}` : `⏰ Marks due today: ${name}, ${exam.title}`,
                            `The ${name} marks for "${exam.title}" (${where}) ${late ? `were due ${ago(late)}` : 'are due today'} and are still to be submitted.`, 'results.marks');
                        out.sheets += 1;
                    } else {
                        if (!isDue(exam, `sheet:${sid}`, conf, now) || !(await claim(exam, `sheet:${sid}`, conf))) continue;
                        send(teachers, `⏰ Marks due: ${name}, ${exam.title}`,
                            `The ${name} marks for "${exam.title}" (${where}) are still to be submitted — the exam ended ${ago(daysBetween(dateKey(exam.endDate), today))}.`, 'results.marks');
                        out.sheets += 1;
                    }
                }
                // Past the due day with sheets still out: the office hears, naming them.
                if (due && today > due && owed.length && full.officeReminders
                    && isDue(exam, 'office:overdue', conf, now, { from: addDays(due, 1) }) && await claim(exam, 'office:overdue', conf)) {
                    const office = await designations.moduleAdminIds(exam.school, 'result').catch(() => []);
                    if (office.length) {
                        send(office, `⚠️ Marks overdue: ${exam.title} (${where})`,
                            `${owed.map(nameOf).join(', ')} ${owed.length === 1 ? 'was' : 'were'} due ${ago(daysBetween(due, today))} and ${owed.length === 1 ? 'is' : 'are'} still not submitted.`, 'results.exam');
                        out.office += 1;
                    }
                }
            } else if (exam.status === 'SUBMITTED') {
                const teachers = [...new Set([section.classTeacher, section.substituteTeacher].map(idOf).filter(Boolean))];
                if (!teachers.length) continue;
                if (!isDue(exam, 'validate', conf, now) || !(await claim(exam, 'validate', conf))) continue;
                send(teachers, `⏰ Waiting for you to validate: ${exam.title}`,
                    `Every subject's marks for "${exam.title}" (${where}) are in. They are waiting for the class teacher to validate them.`, 'results.validate');
                out.validations += 1;
            } else if (OFFICE.includes(exam.status) && full.officeReminders) {
                // Waiting on the office: validated and not published, or rejected and not reopened.
                const at = since(exam, exam.status === 'CLASS_APPROVED' ? ['CLASS_APPROVED', 'VALIDATED_BY_ADMIN'] : ['REJECTED', 'CLASS_REJECTED']);
                if (!at) continue;
                const waited = Math.floor((now - at) / DAY);
                if (waited < conf.repeatDays) continue;
                const key = exam.status === 'CLASS_APPROVED' ? 'office:publish' : 'office:reopen';
                if (!isDue(exam, key, conf, now, { from: dateKey(at) }) || !(await claim(exam, key, conf))) continue;
                const office = await designations.moduleAdminIds(exam.school, 'result').catch(() => []);
                if (!office.length) continue;
                if (exam.status === 'CLASS_APPROVED') {
                    send(office, `📊 Still to publish: ${exam.title} (${where})`,
                        `The marks for "${exam.title}" were validated ${ago(waited)} and the results are waiting to be published.`, 'results.exam');
                } else {
                    send(office, `❌ Still to reopen: ${exam.title} (${where})`,
                        `The marks for "${exam.title}" were rejected ${ago(waited)}. Reopen the exam so the teachers can correct them.`, 'results.exam');
                }
                out.office += 1;
            }
        } catch (e) {
            console.error(`[Results] reminder for exam ${exam._id} failed:`, e.message);
        }
    }
    return out;
}

module.exports = { sweep, isDue, GIVE_UP_DAYS };
