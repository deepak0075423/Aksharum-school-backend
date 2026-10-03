'use strict';
/**
 * The exam day's plan (Oct 2026): where every student sits, and who
 * invigilates each room — for each sitting of the day (the papers that start
 * at the same time). The school had exam papers with days and times, and
 * rooms with capacities (the timetable module's), but nothing that put the
 * two together: seating charts and duty rosters were made by hand, on paper.
 *
 *   dayBoard   the exam days ahead, and for one day: its sittings (each paper
 *              with how many sit it — an elective's takers only), the rooms
 *              the school has, and the plan saved for the day
 *   generate   the plan, made and saved as a draft:
 *                seats   students of different classes and papers side by
 *                        side (taken in turn from each paper's list, in roll
 *                        order), filling the rooms picked in their order up to
 *                        each one's capacity — whoever does not fit is listed
 *                        as unseated, never squeezed in;
 *                duties  each room one invigilator (two above 30 seats, or
 *                        what the office says), never a teacher of a paper
 *                        sat in that room, never one teacher in two rooms at
 *                        once, the fewest duties so far going first
 *   publish    teachers are told their rooms; families see the seat on the
 *              exam schedule (studentSeats); teachers their duties (teacherDuties)
 *   remove     the day's plan taken away — its invigilators told, if it was out
 */
const pool = require('../db/pool');
const ExamDayPlan = require('../models/ExamDayPlan');
const FormalExam = require('../models/FormalExam');
const Room = require('../models/Room');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const board = require('./resultBoard');
const { RuleError, dayOf, todayOf, trail } = require('./resultExams');
const { notify } = require('./notifyService');

const fail = (status, message) => { throw new RuleError(status, message); };
const keyOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (k) => { const d = new Date(`${k}T00:00:00Z`); return Number.isNaN(d.getTime()) ? k : `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const classLine = (r) => [r?.className, r?.sectionName].filter(Boolean).join(' – ');
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

/** Each day ahead with papers, and how many — for the day picker. */
async function daysAhead(schoolId) {
    const { rows } = await pool.query(`
        SELECT to_char((x->>'examDate')::date, 'YYYY-MM-DD') AS "day", count(*)::int AS "papers", count(DISTINCT e."_id")::int AS "exams"
          FROM "${FormalExam.tableName}" e CROSS JOIN LATERAL jsonb_array_elements(${jarr('e."subjects"')}) x
         WHERE e."school" = $1::uuid AND e."archivedAt" IS NULL AND COALESCE(x->>'examDate', '') <> ''
           AND (x->>'examDate')::date >= $2::date
         GROUP BY 1 ORDER BY 1 LIMIT 60`, [String(schoolId), todayOf(schoolId)]);
    // The day as text: the driver reads a SQL date as local midnight, a day early east of Greenwich.
    return rows.map((r) => ({ date: r.day, papers: r.papers, exams: r.exams }));
}

/** The day's papers, grouped into sittings by start time, each paper with who sits it. */
async function sittingsOf(schoolId, day) {
    const { rows } = await pool.query(`
        SELECT e."_id" AS "exam", e."title", e."section", s."sectionName", c."className", c."classNumber",
               x->>'subject' AS "subject", sub."subjectName", COALESCE(x->>'startTime', '') AS "startTime", COALESCE(x->>'endTime', '') AS "endTime"
          FROM "${FormalExam.tableName}" e
          CROSS JOIN LATERAL jsonb_array_elements(${jarr('e."subjects"')}) x
          JOIN "classsections" s ON s."_id" = e."section"
          LEFT JOIN "classes" c ON c."_id" = s."class"
          LEFT JOIN "subjects" sub ON sub."_id"::text = x->>'subject'
         WHERE e."school" = $1::uuid AND e."archivedAt" IS NULL AND (x->>'examDate')::date = $2::date
         ORDER BY COALESCE(x->>'startTime', '99:99'), c."classNumber" NULLS LAST, s."sectionName", sub."subjectName"`,
    [String(schoolId), keyOf(day)]);
    const rosterOf = new Map(); const takersOf = new Map();
    for (const sec of [...new Set(rows.map((r) => String(r.section)))]) {
        rosterOf.set(sec, await board.rosterRows(sec));
        takersOf.set(sec, await board.takersBySubject(sec));
    }
    const sittings = new Map();
    for (const r of rows) {
        const key = r.startTime || '';
        if (!sittings.has(key)) sittings.set(key, { key, startTime: r.startTime, endTime: r.endTime, papers: [] });
        const sit = sittings.get(key);
        if (r.endTime && (!sit.endTime || r.endTime > sit.endTime)) sit.endTime = r.endTime;
        const t = takersOf.get(String(r.section)).get(String(r.subject));
        const students = rosterOf.get(String(r.section)).filter((u) => !t || t.has(String(u._id)))
            .map((u) => ({ student: String(u._id), name: u.name, rollNumber: u.rollNumber || '' }));
        sit.papers.push({
            exam: String(r.exam), subject: String(r.subject), section: String(r.section), title: r.title, subjectName: r.subjectName || 'Subject',
            className: r.className || '', sectionName: r.sectionName || '', classNumber: r.classNumber, students,
        });
    }
    // Untimed papers last: they are a sitting of their own until the office times them.
    return [...sittings.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.key.localeCompare(b.key));
}

async function roomsOf(schoolId) {
    const rooms = await Room.find({ school: schoolId, isActive: true }).select('roomName roomNumber building capacity roomType').lean();
    return rooms.filter((r) => Number(r.capacity) > 0)
        .sort((a, b) => String(a.building || '').localeCompare(String(b.building || '')) || String(a.roomNumber || a.roomName).localeCompare(String(b.roomNumber || b.roomName), undefined, { numeric: true }))
        .map((r) => ({ _id: String(r._id), roomName: r.roomName, roomNumber: r.roomNumber || '', building: r.building || '', capacity: Number(r.capacity), roomType: r.roomType || '' }));
}

const shapePlan = (p) => (p ? {
    _id: p._id, date: keyOf(p.date), sittings: p.sittings || [], rooms: p.rooms || [], perRoom: p.perRoom || 0,
    publishedAt: p.publishedAt || null, updatedAt: p.updatedAt || null,
} : null);

/** GET …/results/exam-day — the days ahead; for one day its sittings, the rooms and the plan. */
async function dayBoard(schoolId, date) {
    const days = await daysAhead(schoolId);
    const asked = dayOf(date);
    if (asked === undefined) fail(400, 'Choose a day');
    const day = asked || (days[0] ? dayOf(days[0].date) : null);
    if (!day) return { days, date: null, sittings: [], rooms: await roomsOf(schoolId), plan: null };
    const [sittings, rooms, plan] = await Promise.all([
        sittingsOf(schoolId, day), roomsOf(schoolId), ExamDayPlan.findOne({ school: schoolId, date: day }).lean(),
    ]);
    return {
        days, date: keyOf(day), rooms, plan: shapePlan(plan),
        sittings: sittings.map((s) => ({
            key: s.key, startTime: s.startTime, endTime: s.endTime,
            students: new Set(s.papers.flatMap((p) => p.students.map((x) => x.student))).size,
            papers: s.papers.map(({ students, ...p }) => ({ ...p, students: students.length })),
        })),
    };
}

/**
 * Seat one sitting: students taken in turn from each paper's list (so a
 * neighbour sits another paper, or is from another section), into the rooms
 * in their order, up to each one's capacity.
 */
function seat(sitting, rooms) {
    const queues = sitting.papers.map((p) => p.students.map((s) => ({ ...s, paper: p })));
    const seen = new Set();
    const order = [];
    for (let i = 0; queues.some((q) => q.length); i += 1) {
        const q = queues[i % queues.length];
        const next = q.shift();
        if (!next) continue;
        // One student, two papers at the same time: seated once, for the first.
        if (seen.has(next.student)) continue;
        seen.add(next.student);
        order.push(next);
    }
    let at = 0;
    const out = rooms.map((room) => {
        const seats = order.slice(at, at + room.capacity).map((s, i) => ({
            seat: i + 1, student: s.student, name: s.name, rollNumber: s.rollNumber,
            className: s.paper.className, sectionName: s.paper.sectionName, exam: s.paper.exam, subject: s.paper.subject, subjectName: s.paper.subjectName,
        }));
        at += seats.length;
        return { room: room._id, roomName: room.roomName, roomNumber: room.roomNumber, building: room.building, capacity: room.capacity, seats, invigilators: [] };
    }).filter((r) => r.seats.length);
    const unseated = order.slice(at).map((s) => ({ student: s.student, name: s.name, className: s.paper.className, sectionName: s.paper.sectionName, subjectName: s.paper.subjectName }));
    return { rooms: out, unseated };
}

/** POST …/results/exam-day { date, rooms: [roomId…], perRoom } — make (or remake) the day's plan, as a draft. */
async function generate(ctx, { date, rooms: roomIds, perRoom = 0 } = {}) {
    const day = dayOf(date);
    if (!day) fail(400, 'Choose the exam day');
    const all = await roomsOf(ctx.schoolId);
    const ids = (Array.isArray(roomIds) ? roomIds : []).map(String);
    const picked = ids.map((id) => all.find((r) => r._id === id)).filter(Boolean);
    if (!picked.length) fail(400, 'Pick the rooms the papers are sat in');
    const per = Number(perRoom) || 0;
    if (![0, 1, 2, 3].includes(per)) fail(400, 'Invigilators per room: 1 to 3, or by the room\'s size');
    const sittings = await sittingsOf(ctx.schoolId, day);
    if (!sittings.length) fail(400, 'No paper is sat that day');

    // Who may invigilate: the school's active teachers — fewest duties so far
    // (on the school's other days' plans) first.
    const teachers = await User.find({ school: ctx.schoolId, role: 'teacher', isActive: { $ne: false } }).select('name').lean();
    const { rows: load } = await pool.query(`
        SELECT inv->>'teacher' AS "teacher", count(*)::int AS "n"
          FROM "${ExamDayPlan.tableName}" p
          CROSS JOIN LATERAL jsonb_array_elements(${jarr('p."sittings"')}) s
          CROSS JOIN LATERAL jsonb_array_elements(${jarr(`s->'rooms'`)}) r
          CROSS JOIN LATERAL jsonb_array_elements(${jarr(`r->'invigilators'`)}) inv
         WHERE p."school" = $1::uuid AND p."date" <> $2
         GROUP BY 1`, [String(ctx.schoolId), day]);
    const duties = new Map(load.map((r) => [r.teacher, r.n]));
    // Who teaches each paper there: they do not invigilate a room it is sat in.
    const pairs = sittings.flatMap((s) => s.papers.map((p) => ({ section: p.section, subject: p.subject })));
    const sst = pairs.length ? await SectionSubjectTeacher.find({ $or: pairs }).select('section subject teacher').lean() : [];
    const teachesPaper = new Map();
    sst.forEach((x) => { const k = `${x.section}:${x.subject}`; if (!teachesPaper.has(k)) teachesPaper.set(k, new Set()); teachesPaper.get(k).add(String(x.teacher)); });

    let short = 0;
    const out = sittings.map((s) => {
        const { rooms, unseated } = seat(s, picked);
        const busy = new Set();
        for (const room of rooms) {
            const need = per || (room.seats.length > 30 ? 2 : 1);
            const own = new Set();
            [...new Set(room.seats.map((x) => `${s.papers.find((p) => p.exam === x.exam && p.subject === x.subject)?.section}:${x.subject}`))]
                .forEach((k) => (teachesPaper.get(k) || new Set()).forEach((t) => own.add(t)));
            const choice = teachers
                .filter((t) => !busy.has(String(t._id)) && !own.has(String(t._id)))
                .sort((a, b) => (duties.get(String(a._id)) || 0) - (duties.get(String(b._id)) || 0) || String(a.name).localeCompare(String(b.name)))
                .slice(0, need);
            choice.forEach((t) => { busy.add(String(t._id)); duties.set(String(t._id), (duties.get(String(t._id)) || 0) + 1); });
            room.invigilators = choice.map((t) => ({ teacher: String(t._id), name: t.name }));
            if (choice.length < need) short += need - choice.length;
        }
        return {
            key: s.key, startTime: s.startTime, endTime: s.endTime,
            papers: s.papers.map(({ students, classNumber, ...p }) => ({ ...p, students: students.length })),
            rooms, unseated,
        };
    });

    const set = {
        sittings: out, rooms: picked.map((r) => r._id), perRoom: per,
        publishedAt: null, publishedBy: null, updatedBy: ctx.userId, updatedAt: new Date(),
    };
    const { newId } = require('../db/schema');
    await pool.query(
        `INSERT INTO "${ExamDayPlan.tableName}" ("_id", "school", "date", "sittings", "rooms", "perRoom", "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7::uuid, $7::uuid, now(), now())
         ON CONFLICT ("school", "date") DO UPDATE SET "sittings" = EXCLUDED."sittings", "rooms" = EXCLUDED."rooms", "perRoom" = EXCLUDED."perRoom",
             "publishedAt" = NULL, "publishedBy" = NULL, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()`,
        [newId(), String(ctx.schoolId), day, JSON.stringify(set.sittings), JSON.stringify(set.rooms), per, isUuid(String(ctx.userId || '')) ? String(ctx.userId) : null]);
    const plan = await ExamDayPlan.findOne({ school: ctx.schoolId, date: day }).lean();
    trail(ctx, 'EXAM_DAY_PLANNED', 'ExamDay', plan._id, `Seating and invigilation planned for ${fmtDay(keyOf(day))}`);
    return {
        plan: shapePlan(plan),
        // What the office should know before publishing.
        warnings: {
            unseated: out.reduce((n, s) => n + s.unseated.length, 0),
            invigilatorsShort: short,
        },
    };
}

/** What one teacher does on a plan: [{ key, startTime, endTime, roomName, …, papers }]. */
function dutiesIn(plan, teacherId) {
    const out = [];
    for (const s of plan.sittings || []) {
        for (const r of s.rooms || []) {
            if (!(r.invigilators || []).some((i) => String(i.teacher) === String(teacherId))) continue;
            const papers = [...new Map(r.seats.map((x) => [`${x.exam}:${x.subject}`, { subjectName: x.subjectName, className: x.className, sectionName: x.sectionName }])).values()];
            out.push({
                date: keyOf(plan.date), startTime: s.startTime, endTime: s.endTime, roomName: r.roomName, roomNumber: r.roomNumber, building: r.building,
                students: r.seats.length, papers, with: (r.invigilators || []).filter((i) => String(i.teacher) !== String(teacherId)).map((i) => i.name),
            });
        }
    }
    return out;
}

/** POST …/results/exam-day/publish { date } — the plan goes out: each invigilator is told their rooms. */
async function publish(ctx, { date } = {}) {
    const day = dayOf(date);
    if (!day) fail(400, 'Choose the exam day');
    const { rows: [row] } = await pool.query(
        `UPDATE "${ExamDayPlan.tableName}" SET "publishedAt" = now(), "publishedBy" = $3::uuid, "updatedAt" = now()
          WHERE "school" = $1::uuid AND "date" = $2 AND "publishedAt" IS NULL RETURNING *`,
        [String(ctx.schoolId), day, isUuid(String(ctx.userId || '')) ? String(ctx.userId) : null]);
    if (!row) {
        const there = await ExamDayPlan.findOne({ school: ctx.schoolId, date: day }).select('_id publishedAt').lean();
        fail(there ? 409 : 404, there ? 'This plan is already published' : 'Make the plan for this day first');
    }
    const teachers = [...new Set((row.sittings || []).flatMap((s) => (s.rooms || []).flatMap((r) => (r.invigilators || []).map((i) => String(i.teacher)))))];
    for (const t of teachers) {
        const mine = dutiesIn(row, t);
        try {
            notify({
                school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
                title: `🧑‍🏫 Invigilation duty: ${fmtDay(keyOf(day))}`,
                body: mine.map((m) => `${m.startTime ? `${m.startTime}${m.endTime ? `–${m.endTime}` : ''}` : 'Time to be told'} · ${m.roomName}${m.roomNumber ? ` (${m.roomNumber})` : ''} · ${m.students} students · ${m.papers.map((p) => `${p.subjectName} ${classLine(p)}`).join(', ')}`).join('\n'),
                recipients: [t], link: { type: 'results.schedule', entityId: row._id },
            });
        } catch (e) { console.error('[exam day] notice failed:', e.message); }
    }
    trail(ctx, 'EXAM_DAY_PUBLISHED', 'ExamDay', row._id, `Seating and invigilation published for ${fmtDay(keyOf(day))} — ${teachers.length} invigilator${teachers.length === 1 ? '' : 's'} told`);
    return { plan: shapePlan(row), told: teachers.length };
}

/** DELETE …/results/exam-day?date= — the plan taken away (its invigilators told, if it was out). */
async function remove(ctx, { date } = {}) {
    const day = dayOf(date);
    if (!day) fail(400, 'Choose the exam day');
    const { rows: [row] } = await pool.query(`DELETE FROM "${ExamDayPlan.tableName}" WHERE "school" = $1::uuid AND "date" = $2 RETURNING *`, [String(ctx.schoolId), day]);
    if (!row) fail(404, 'There is no plan for this day');
    if (row.publishedAt) {
        const teachers = [...new Set((row.sittings || []).flatMap((s) => (s.rooms || []).flatMap((r) => (r.invigilators || []).map((i) => String(i.teacher)))))];
        try {
            if (teachers.length) {
                notify({
                    school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
                    title: `🧑‍🏫 Invigilation duties withdrawn: ${fmtDay(keyOf(day))}`,
                    body: 'The seating and invigilation plan for this day has been taken back. A new one will be shared if it changes.',
                    recipients: teachers, link: { type: 'results.schedule', entityId: row._id },
                });
            }
        } catch (e) { console.error('[exam day] notice failed:', e.message); }
    }
    trail(ctx, 'EXAM_DAY_REMOVED', 'ExamDay', row._id, `Seating and invigilation plan for ${fmtDay(keyOf(day))} removed`);
    return { removed: true };
}

/** A teacher's invigilation duties, today and ahead, from published plans. */
async function teacherDuties(schoolId, teacherId) {
    const plans = await pool.query(
        `SELECT * FROM "${ExamDayPlan.tableName}" WHERE "school" = $1::uuid AND "publishedAt" IS NOT NULL AND ("date" AT TIME ZONE 'UTC')::date >= $2::date ORDER BY "date"`,
        [String(schoolId), todayOf(schoolId)]);
    return plans.rows.flatMap((p) => dutiesIn(p, teacherId));
}

/** A student's seats, today and ahead, from published plans: [{ date, startTime, roomName, seat, subjectName }]. */
async function studentSeats(schoolId, studentId) {
    const { rows } = await pool.query(
        `SELECT * FROM "${ExamDayPlan.tableName}" WHERE "school" = $1::uuid AND "publishedAt" IS NOT NULL AND ("date" AT TIME ZONE 'UTC')::date >= $2::date ORDER BY "date"`,
        [String(schoolId), todayOf(schoolId)]);
    const out = [];
    for (const p of rows) {
        for (const s of p.sittings || []) {
            for (const r of s.rooms || []) {
                const mine = (r.seats || []).find((x) => String(x.student) === String(studentId));
                if (mine) {
                    out.push({
                        date: keyOf(p.date), startTime: s.startTime, endTime: s.endTime, roomName: r.roomName, roomNumber: r.roomNumber, building: r.building,
                        seat: mine.seat, exam: mine.exam, subject: mine.subject, subjectName: mine.subjectName,
                    });
                }
            }
        }
    }
    return out;
}

module.exports = { dayBoard, generate, publish, remove, teacherDuties, studentSeats, seat, dutiesIn };
