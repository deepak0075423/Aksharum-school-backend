'use strict';
/**
 * Medical Room — a teacher's API (Oct 2026).
 *
 * What a teacher can do: send a student to the Medical Room and follow the
 * request, report a medical incident, see the medical alerts of the students
 * in their own sections (only what the room shares with teachers), and open a
 * student's emergency profile when the school allows it.
 *
 * What they cannot: any history, private note, prescription or document, or
 * anything at all about a student outside their sections. The student picker
 * reaches every student of the school — a teacher on playground duty must be
 * able to send any child — but it carries identity only, never health.
 */
const pool = require('../db/pool');
const { handle } = require('../utils/medicalHandler');
const access = require('../services/medicalAccess');
const read = require('../services/medicalRead');
const cases = require('../services/medicalCase');
const settingsSvc = require('../services/medicalSettings');
const audit = require('../services/medicalAudit');
const { STUDENT_SELECT, STUDENT_JOIN, withClass } = require('../services/medicalBoard');
const R = require('../services/medicalRules');
const ntk = require('../services/medicalNeedToKnow');
const tell = require('../services/medicalNotify');

const { refuse, notFound, isUuid } = R;
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

/** The teacher's view of their own requests — status and the room's note, no clinical detail. */
const REQUEST_FIELDS = `r."_id", r."number", r."reason", r."symptoms", r."location", r."urgency", r."remarks", r."status", r."createdAt",
    r."acceptedAt", r."arrivedAt", r."closedAt", r."cancelledAt", r."cancelReason", r."outcomeNote", r."history"`;

const cleanHistory = (h = []) => (h || []).map((x) => ({ status: x.status, at: x.at, byName: x.byName }));

exports.meta = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    const incidentTypes = s.incidentTypes?.length ? s.incidentTypes : Object.keys(R.INCIDENT_TYPE);
    return {
        roomName: s.roomName, roomPhone: s.roomPhone, roomLocation: s.roomLocation,
        visitReasons: s.visitReasons, locations: s.locations,
        incidentTypes: incidentTypes.map((k) => ({ value: k, label: R.INCIDENT_TYPE[k] })),
        severities: Object.entries(R.INCIDENT_SEVERITY).map(([value, v]) => ({ value, label: v.label })),
        urgency: Object.entries(R.URGENCY).map(([value, v]) => ({ value, label: v.label })),
        teacherAlerts: s.teacherAlerts, teacherEmergencyInfo: s.teacherEmergencyInfo, breakGlass: s.breakGlass,
    };
});

exports.overview = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    const scope = await access.teacherScope(req.schoolId, req.userId);
    const [open, recent, alerts] = await Promise.all([
        run(`SELECT ${REQUEST_FIELDS}, ${STUDENT_SELECT} FROM "medicalrequests" r ${STUDENT_JOIN('r."student"')}
              WHERE r."school" = $1 AND r."requestedBy" = $2 AND r."status" IN ('requested','accepted','arrived','treatment') ORDER BY r."createdAt" DESC`,
        [String(req.schoolId), String(req.userId)]),
        run(`SELECT ${REQUEST_FIELDS}, ${STUDENT_SELECT} FROM "medicalrequests" r ${STUDENT_JOIN('r."student"')}
              WHERE r."school" = $1 AND r."requestedBy" = $2 AND r."status" NOT IN ('requested','accepted','arrived','treatment')
                AND r."createdAt" > now() - interval '7 days' ORDER BY r."createdAt" DESC LIMIT 10`,
        [String(req.schoolId), String(req.userId)]),
        s.teacherAlerts ? read.teacherAlerts(req.schoolId, scope.studentIds) : new Map(),
    ]);
    // Students of mine in the room right now: where they are, not why.
    const inRoom = scope.studentIds.size
        ? await run(`SELECT v."student"::text AS student, v."status", v."arrivedAt", ${STUDENT_SELECT}
                       FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
                      WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" IN ('in_room','observation','emergency')
                        AND v."student"::text = ANY($2::text[])`, [String(req.schoolId), [...scope.studentIds]])
        : [];
    return {
        sections: scope.sections,
        studentCount: scope.studentIds.size,
        alertCount: alerts.size,
        criticalCount: [...alerts.values()].filter((a) => a.alerts.some((x) => x.level === 'critical')).length,
        open: open.map((r) => ({ ...withClass(r), history: cleanHistory(r.history) })),
        recent: recent.map((r) => ({ ...withClass(r), history: cleanHistory(r.history) })),
        inRoom: inRoom.map((v) => ({ ...withClass(v), status: v.status === 'in_room' ? 'in_room' : v.status === 'observation' ? 'observation' : 'emergency' })),
        settings: { teacherAlerts: s.teacherAlerts, teacherEmergencyInfo: s.teacherEmergencyInfo, roomName: s.roomName, roomPhone: s.roomPhone },
    };
});

/** Identity only. `mine=1` keeps to the teacher's own sections. */
exports.students = handle(async (req) => {
    const onlyIds = req.query.mine === '1' ? (await access.teacherScope(req.schoolId, req.userId)).studentIds : null;
    if (onlyIds && !onlyIds.size) return [];
    return access.searchStudents(req.schoolId, req.query.q, { limit: 20, onlyIds });
});

exports.requests = handle(async (req) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 15));
    const status = req.query.tab === 'open' ? `AND r."status" IN ('requested','accepted','arrived','treatment')`
        : req.query.tab === 'done' ? `AND r."status" NOT IN ('requested','accepted','arrived','treatment')` : '';
    const rows = await run(
        `SELECT ${REQUEST_FIELDS}, ${STUDENT_SELECT}, count(*) OVER ()::int AS "__total" FROM "medicalrequests" r ${STUDENT_JOIN('r."student"')}
          WHERE r."school" = $1 AND r."requestedBy" = $2 ${status} ORDER BY r."createdAt" DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        [String(req.schoolId), String(req.userId)],
    );
    const total = rows[0]?.__total || 0;
    return { rows: rows.map(({ __total, ...r }) => ({ ...withClass(r), history: cleanHistory(r.history) })), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
});

exports.createRequest = handle((req) => cases.createRequest(req, req.body || {}));
exports.cancelRequest = handle((req) => cases.cancelRequest(req, req.params.id, req.body || {}, { asTeacher: true }));

exports.alerts = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    if (!s.teacherAlerts) refuse('Your school does not share medical alerts with teachers', 403, 'MEDICAL_ALERTS_OFF');
    const scope = await access.teacherScope(req.schoolId, req.userId);
    const alerts = await read.teacherAlerts(req.schoolId, scope.studentIds);
    // Beyond their own classes: today's covers and exam rooms, their bus, their hostel, the mess.
    const groups = await ntk.groupsFor(req.schoolId, req.userId);
    const groupCards = await Promise.all(groups.map((g) => ntk.cardsFor(req.schoolId, g.students, { contacts: g.contacts, foodOnly: g.foodOnly })));
    const everyone = new Set([...alerts.keys(), ...groupCards.flatMap((m) => [...m.keys()])]);
    const cards = await access.studentCards(req.schoolId, [...everyone]);
    const who = (sid) => (cards.get(sid) ? { _id: sid, name: cards.get(sid).name, photo: cards.get(sid).photo, classLabel: cards.get(sid).classLabel, admissionNumber: cards.get(sid).admissionNumber, rollNumber: cards.get(sid).rollNumber } : { _id: sid, name: '' });
    const order = (a, b) => Number(b.critical) - Number(a.critical) || a.student.name.localeCompare(b.student.name);
    const rows = [...alerts.entries()].map(([sid, a]) => ({
        student: who(sid),
        sectionId: scope.sectionOf.get(sid) || null,
        alerts: a.alerts.map(({ id, ...x }) => x),
        instructions: a.instructions,
        critical: a.alerts.some((x) => x.level === 'critical'),
    })).filter((r) => r.student.name).sort(order);
    const extra = groups.map((g, i) => ({
        key: g.key, label: g.label, sub: g.sub, until: g.until, foodOnly: g.foodOnly, students: g.students.length,
        rows: [...groupCards[i].entries()].map(([sid, c]) => ({
            student: who(sid), alerts: c.alerts.map(({ id, ...x }) => x), instructions: c.instructions || '', contacts: c.contacts || [], diet: c.diet || '',
            critical: c.alerts.some((x) => x.level === 'critical'),
        })).filter((r) => r.student.name).sort(order),
    }));
    audit.log(req, { action: 'viewed', entity: 'teacher_alerts', summary: `Opened the medical alerts of their students (${rows.length})` });
    if (extra.some((g) => g.rows.length)) {
        audit.log(req, {
            action: 'viewed', entity: 'need_to_know',
            summary: `Opened the critical cards of ${extra.reduce((n, g) => n + g.rows.length, 0)} students they look after: ${extra.filter((g) => g.rows.length).map((g) => `${g.label}${g.sub ? ` — ${g.sub}` : ''}`).join('; ')}`,
        });
    }
    // What teachers have been asked to do (never why), and who is off school until when (never the illness).
    const limits = require('../services/medicalRestrictions');
    const covered = new Set(groups.flatMap((g) => g.students.map(String)));
    const [restrictions, away] = await Promise.all([
        limits.restrictionsFor(req.schoolId, [...scope.studentIds, ...covered], { days: 3 }),
        limits.exclusionsFor(req.schoolId, [...scope.studentIds]),
    ]);
    const named = await access.studentCards(req.schoolId, [...restrictions.map((r) => r.student), ...away.map((x) => x.student)]);
    const person = (sid) => (named.get(sid) ? { _id: sid, name: named.get(sid).name, photo: named.get(sid).photo, classLabel: named.get(sid).classLabel } : null);
    return {
        sections: scope.sections, rows, groups: extra, emergencyInfo: s.teacherEmergencyInfo, breakGlass: s.breakGlass,
        restrictions: restrictions.map((r) => ({ ...r, student: person(r.student) })).filter((r) => r.student),
        away: away.filter((x) => x.status === 'excluded').map((x) => ({ _id: x._id, student: person(x.student), from: x.from, earliestReturn: x.earliestReturn })).filter((x) => x.student),
    };
});

/**
 * In an emergency, any member of staff may open any child's emergency card —
 * the whole card, not the teacher's share of it — by saying why. Logged, and
 * the medical staff are told at once.
 */
exports.emergencyAccess = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    if (!s.breakGlass) refuse('Your school has switched off emergency access — call the Medical Room', 403, 'MEDICAL_BREAKGLASS_OFF');
    const reason = R.str(req.body?.reason, 300);
    if (reason.length < 5) refuse('Say what is happening — e.g. "Collapsed on the playground"');
    const student = await access.assertStudent(req.schoolId, req.body?.student);
    const out = await read.emergencyProfile(req.schoolId, student._id, { forTeacher: false });
    audit.log(req, { action: 'break_glass', entity: 'emergency_profile', student: student._id, summary: `Emergency access by ${req.user?.name || 'staff'} to ${student.name}'s emergency card — "${reason}"` });
    tell.toStaff(req, {
        title: `Emergency access — ${student.name}`,
        body: `${req.user?.name || 'A member of staff'} opened ${student.name}'s emergency card: "${reason}". If the student needs the Medical Room, go to them.`,
        link: { type: 'medical.desk' }, urgent: true,
    });
    return out;
});

exports.emergency = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    if (!s.teacherEmergencyInfo) refuse('Your school does not share emergency profiles with teachers', 403, 'MEDICAL_EMERGENCY_OFF');
    if (!isUuid(req.params.id)) notFound('Student');
    const scope = await access.teacherScope(req.schoolId, req.userId);
    // Outside the teacher's sections — and the children they look after today
    // (a cover, an exam room, their bus or hostel) — the answer is "not found".
    if (!scope.studentIds.has(String(req.params.id)) && !(await ntk.canSee(req.schoolId, req.userId, req.params.id))) notFound('Student');
    const out = await read.emergencyProfile(req.schoolId, req.params.id, { forTeacher: true });
    audit.log(req, { action: 'viewed', entity: 'emergency_profile', student: req.params.id, summary: `Teacher opened the emergency profile of ${out.student.name}` });
    return out;
});

exports.createIncident = handle((req) => cases.createIncident(req, req.body || {}, { teacher: true }));

exports.incidents = handle(async (req) => {
    const rows = await run(
        `SELECT i."_id", i."number", i."occurredAt", i."location", i."type", i."severity", i."status", i."description", i."injury", ${STUDENT_SELECT}
           FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
          WHERE i."school" = $1 AND i."reportedBy" = $2 AND i."archivedAt" IS NULL ORDER BY i."occurredAt" DESC LIMIT 50`,
        [String(req.schoolId), String(req.userId)],
    );
    return rows.map(withClass);
});
