'use strict';
/**
 * The Medical Room's cases (Oct 2026): requests, visits, incidents, first aid,
 * beds and follow-ups — the one writer of all of them.
 *
 * The connected workflow the brief describes runs through here:
 *
 *   teacher sends a student          createRequest      staff + class teacher told
 *   the room accepts                 acceptRequest      teacher told
 *   the student arrives              arriveRequest      a MedicalVisit is opened
 *   examined, treated                updateVisit        vitals, treatment, doses
 *                                                       (stock out), first aid
 *   the outcome                      setVisitStatus     returned / sent home /
 *                                                       referred — teacher and
 *                                                       parents told
 *   the follow-up                    completeFollowUp
 *   the history                      (read from all of the above)
 *
 * A request's status follows its visit (requestStatusForVisit) and is written
 * in the same breath as the visit's, so the teacher's list and the room's
 * board never disagree. Status changes are compare-and-set on the status the
 * caller saw: two people pressing "Sent home" and "Returned" at once cannot
 * both win.
 */
const pool = require('../db/pool');
const { withTransaction } = require('../db/pool');
const { patch, insert } = require('../db/patch');
const { newId } = require('../db/schema');
const MedicalRequest = require('../models/MedicalRequest');
const MedicalVisit = require('../models/MedicalVisit');
const MedicalIncident = require('../models/MedicalIncident');
const MedicalFirstAid = require('../models/MedicalFirstAid');
const MedicalBed = require('../models/MedicalBed');
const MedicalProfile = require('../models/MedicalProfile');
const MedicalCheckup = require('../models/MedicalCheckup');
const numbers = require('./medicalNumber');
const stock = require('./medicalStock');
const meds = require('./medicalMeds');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const live = require('./medicalLive');
const urgentSvc = () => require('./medicalUrgent');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const R = require('./medicalRules');

const { refuse, notFound, str, num, bool, oneOf, isUuid, toInstant, toDay, todayStr, dayStr, dayLabel } = R;

const who = (req) => req.user?.name || '';
const step = (req, status, note = '') => ({ status, at: new Date(), by: req.userId || null, byName: who(req), note: str(note, 300) });
const time = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const plainOf = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);

/* ── Shared field cleaners ────────────────────────────────────────────────── */

const vitalsSvc = () => require('./medicalVitals');

function referralOf(raw, prev = {}) {
    if (!raw || typeof raw !== 'object') return prev || {};
    const referred = raw.referred === undefined ? !!prev?.referred : bool(raw.referred);
    return {
        referred,
        hospital: str(raw.hospital ?? prev?.hospital, 160),
        reason: str(raw.reason ?? prev?.reason, 300),
        transport: str(raw.transport ?? prev?.transport, 80),
        accompaniedBy: str(raw.accompaniedBy ?? prev?.accompaniedBy, 120),
        at: referred ? (toInstant(raw.at) || prev?.at || new Date()) : null,
    };
}

function followUpOf(raw, prev = {}) {
    if (!raw || typeof raw !== 'object') return prev || {};
    const required = raw.required === undefined ? !!prev?.required : bool(raw.required);
    if (!required) return { required: false, on: null, note: '', status: '', doneAt: null, doneBy: null, outcome: '' };
    const on = toDay(raw.on ?? prev?.on);
    return {
        required: true,
        on,
        note: str(raw.note ?? prev?.note, 300),
        status: prev?.status && prev.status !== '' ? prev.status : 'pending',
        doneAt: prev?.doneAt || null,
        doneBy: prev?.doneBy || null,
        outcome: prev?.outcome || '',
    };
}

/* ── Loading ──────────────────────────────────────────────────────────────── */

async function findRequest(req, id) {
    if (!isUuid(id)) notFound('Request');
    const row = await MedicalRequest.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Request');
    return row;
}

async function findVisit(req, id) {
    if (!isUuid(id)) notFound('Visit');
    const row = await MedicalVisit.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Visit');
    return row;
}

async function findIncident(req, id) {
    if (!isUuid(id)) notFound('Incident');
    const row = await MedicalIncident.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Incident');
    return row;
}

async function openVisitOf(schoolId, studentId) {
    return MedicalVisit.findOne({ school: schoolId, student: studentId, status: { $in: R.IN_ROOM }, archivedAt: null }).lean();
}

async function openRequestOf(schoolId, studentId) {
    return MedicalRequest.findOne({ school: schoolId, student: studentId, status: { $in: R.OPEN_REQUEST } }).lean();
}

/* ── Requests (teacher → room) ────────────────────────────────────────────── */

async function createRequest(req, body) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const reason = str(body.reason, 200);
    if (!reason) refuse('Say why the student needs the Medical Room');
    const urgency = oneOf(body.urgency, R.URGENCY, 'normal');
    const open = await openRequestOf(req.schoolId, student._id);
    if (open) refuse(`${student.name} already has an open request (${open.number}, ${R.REQUEST_STATUS[open.status].label.toLowerCase()})`, 409, 'MEDICAL_REQUEST_OPEN', { requestId: String(open._id) });
    const inRoom = await openVisitOf(req.schoolId, student._id);
    if (inRoom) refuse(`${student.name} is already in the Medical Room`, 409, 'MEDICAL_VISIT_OPEN');

    const number = await numbers.next(req.schoolId, 'request');
    const row = plainOf(await MedicalRequest.create({
        school: req.schoolId, number, student: student._id,
        requestedBy: req.userId, requestedByName: who(req), requestedByRole: req.userRole,
        reason, symptoms: str(body.symptoms, 600), location: str(body.location, 120), urgency,
        remarks: str(body.remarks, 600), escortedBy: str(body.escortedBy, 120),
        status: 'requested', history: [step(req, 'requested')],
    }).catch(unique));
    audit.log(req, { action: 'created', entity: 'request', entityId: row._id, student: student._id, summary: `${number}: sent ${student.name} to the Medical Room — ${reason}` });

    const urgent = urgency === 'high' || urgency === 'emergency';
    live.changed(req, 'request', { id: String(row._id), urgent: urgency === 'emergency' });
    const where = row.location ? ` from ${row.location}` : '';
    tell.toStaff(req, {
        title: `${urgency === 'emergency' ? 'EMERGENCY · ' : ''}${student.name} is coming to the Medical Room`,
        body: `${who(req)} sent ${student.name}${student.classLabel ? ` (${student.classLabel})` : ''}${where} — ${reason}${row.symptoms ? `. Symptoms: ${row.symptoms}` : ''}. Urgency: ${R.URGENCY[urgency].label}.`,
        setting: 'staffRequests', link: { type: 'medical.desk', entityId: String(row._id) }, urgent, email: urgency === 'emergency',
    });
    tell.toTeachers(req, {
        studentId: student._id, requesterId: null, setting: 'teacherClassAlert', requestId: row._id,
        title: `${student.name} was sent to the Medical Room`,
        body: `${who(req)} sent ${student.name} to the Medical Room${where} (${reason}).`,
    });
    return row;
}

async function acceptRequest(req, id, body = {}) {
    const r = await findRequest(req, id);
    if (r.status !== 'requested') refuse(`This request is already ${R.REQUEST_STATUS[r.status].label.toLowerCase()}`, 409, 'MEDICAL_STALE');
    const row = await patch(MedicalRequest, id, { status: 'accepted', acceptedBy: req.userId, acceptedAt: new Date() },
        { where: { school: req.schoolId, status: 'requested' }, push: { history: step(req, 'accepted', body.note) } });
    if (!row) refuse('Someone else acted on this request a moment ago — reload', 409, 'MEDICAL_STALE');
    const card = await access.studentCard(req.schoolId, r.student);
    audit.log(req, { action: 'accepted', entity: 'request', entityId: id, student: r.student, summary: `${r.number} accepted` });
    live.toUser(r.requestedBy, 'medical:request', { id: String(id), status: 'accepted' });
    tell.toTeachers(req, {
        studentId: r.student, requesterId: r.requestedBy, includeClass: false, requestId: id,
        title: 'Medical request accepted',
        body: `The Medical Room is expecting ${card?.name || 'the student'}${body.note ? ` — ${str(body.note, 200)}` : ''}.`,
    });
    return row;
}

async function cancelRequest(req, id, body = {}, { asTeacher = false } = {}) {
    const r = await findRequest(req, id);
    if (asTeacher && String(r.requestedBy) !== String(req.userId)) notFound('Request');
    if (!['requested', 'accepted'].includes(r.status)) refuse('Only a request the student has not yet arrived for can be cancelled', 409, 'MEDICAL_STALE');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the request is being cancelled');
    const row = await patch(MedicalRequest, id, { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
        { where: { school: req.schoolId, status: r.status }, push: { history: step(req, 'cancelled', reason) } });
    if (!row) refuse('This request changed a moment ago — reload', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'cancelled', entity: 'request', entityId: id, student: r.student, summary: `${r.number} cancelled — ${reason}` });
    if (!asTeacher) live.toUser(r.requestedBy, 'medical:request', { id: String(id), status: 'cancelled' });
    if (asTeacher) {
        tell.toStaff(req, { title: `Request ${r.number} withdrawn`, body: `${who(req)} withdrew the request: ${reason}`, setting: 'staffRequests', link: { type: 'medical.desk', entityId: String(id) } });
    } else {
        const card = await access.studentCard(req.schoolId, r.student);
        tell.toTeachers(req, { studentId: r.student, requesterId: r.requestedBy, includeClass: false, requestId: id, title: 'Medical request closed', body: `The Medical Room closed your request for ${card?.name || 'the student'}: ${reason}` });
        // The class teachers heard the child was sent — they hear it was closed (not as "your request").
        const others = (await tell.classTeacherIds(req.schoolId, r.student)).map(String).filter((t) => t !== String(r.requestedBy) && t !== String(req.userId));
        if (others.length) {
            tell.send(req, {
                to: others, setting: 'teacherClassAlert', link: { type: 'medical.mine' },
                title: `${card?.name || 'A student'}: Medical Room request closed`,
                body: `The Medical Room closed the request for ${card?.name || 'the student'}: ${reason}`,
            });
        }
    }
    return row;
}

/** The student walked in: open their visit from the request. */
async function arriveRequest(req, id, body = {}) {
    const r = await findRequest(req, id);
    if (!['requested', 'accepted'].includes(r.status)) refuse(`This request is already ${R.REQUEST_STATUS[r.status].label.toLowerCase()}`, 409, 'MEDICAL_STALE');
    return createVisit(req, {
        ...body,
        student: r.student,
        reason: body.reason || r.reason,
        symptoms: body.symptoms ?? r.symptoms,
        request: id,
    });
}

/** Keep the request in step with its visit — inside the visit's transaction. */
async function syncRequest(req, visit, q, note = '') {
    if (!visit?.request) return;
    const status = R.requestStatusForVisit(visit);
    const set = { status, visit: String(visit._id) };
    if (note) set.outcomeNote = str(note, 300);
    const cur = await MedicalRequest.findOne({ _id: visit.request }).select('status arrivedAt requestedBy').lean();
    if (!cur || (cur.status === status && !note)) return;
    // The teacher who sent the student sees it move — once the visit's transaction has committed.
    setTimeout(() => live.toUser(cur.requestedBy, 'medical:request', { id: String(visit.request), status }), 600);
    // Every status past "accepted" means the student reached the room — also
    // when a reading or treatment on arrival made it "under treatment" at once.
    if (!cur.arrivedAt) set.arrivedAt = visit.arrivedAt;
    set.closedAt = status === 'closed' ? new Date() : null;
    await patch(MedicalRequest, visit.request, set, { where: { school: req.schoolId }, push: cur.status === status ? null : { history: step(req, status, note) }, q });
}

/* ── Visits ───────────────────────────────────────────────────────────────── */

/**
 * Lines of medicine given in a visit: [{ plan?, item?, source?, medicineName?, dosage, quantity?, note? }].
 * Supplies used for first aid: [{ item, quantity }].
 */
async function takeMedicines(req, visit, lines, q, override = null) {
    const out = [];
    for (const line of (Array.isArray(lines) ? lines : []).slice(0, 12)) {
        if (!line || (!line.plan && !line.item && !line.medicineName)) continue;
        // A safety check stops the whole visit save (one transaction) until a reason is given.
        const dose = await meds.giveDose(req, { ...line, student: visit.student, override: line.override || override }, q, { visit: visit._id, notifyParents: false, log: false });
        out.push({ dose: String(dose._id), name: dose.medicineName, dosage: dose.dosage, quantity: dose.quantity, unit: dose.unit, at: dose.givenAt });
    }
    return out;
}

/** The audit rows for doses given inside a visit — written once the visit has committed. */
function logDoses(req, studentId, given) {
    for (const m of given || []) {
        audit.log(req, { action: 'administered', entity: 'dose', entityId: m.dose, student: studentId, summary: `Gave ${m.name} — ${m.dosage}${m.quantity ? ` (${m.quantity} ${m.unit || ''})` : ''}`.trim() });
    }
    // A safety check overridden inside the visit is logged now that the visit has committed.
    const ids = (given || []).map((m) => m.dose).filter(Boolean);
    if (!ids.length) return;
    pool.query(`SELECT "_id"::text AS id, "medicineName", "safetyOverrides" FROM "medicationdoses" WHERE "_id"::text = ANY($1::text[]) AND jsonb_array_length(COALESCE("safetyOverrides", '[]'::jsonb)) > 0`, [ids])
        .then(({ rows }) => rows.forEach((r) => meds.overridden(req, studentId, r.id, r.medicineName, r.safetyOverrides)))
        .catch((e) => console.error('[medical] override log failed:', e.message));
}

/** A second open visit or request for one student is refused by the database; say so plainly. */
function unique(e) {
    if (e?.code === '23505' && /medicalvisits_open/.test(e.constraint || e.message)) refuse('This student is already in the Medical Room', 409, 'MEDICAL_VISIT_OPEN');
    if (e?.code === '23505' && /medicalrequests_open/.test(e.constraint || e.message)) refuse('This student already has an open request', 409, 'MEDICAL_REQUEST_OPEN');
    throw e;
}

async function takeSupplies(req, lines, refId, studentId, q) {
    const used = [];
    for (const line of (Array.isArray(lines) ? lines : []).slice(0, 20)) {
        if (!line?.item) continue;
        const qty = num(line.quantity);
        if (!qty || qty <= 0) continue;
        const item = await meds.findItem(req.schoolId, line.item);
        const taken = await stock.consume(req, { item: item._id, quantity: qty, type: 'first_aid', reason: 'First aid', refKind: 'firstaid', refId, student: studentId }, q);
        used.push({ item: String(item._id), name: item.name, unit: item.unit, quantity: qty, batches: taken.batches });
    }
    return used;
}

/**
 * The visit's first-aid record: created the first time first aid is written
 * down or a supply is used, then added to. Its id exists before the supplies
 * are taken, so their ledger rows can name it.
 */
async function syncFirstAid(req, visit, { supplies = [], text = '' }, q) {
    const faId = visit.firstAidRecord ? String(visit.firstAidRecord) : newId();
    const used = await takeSupplies(req, supplies, faId, visit.student, q);
    if (!visit.firstAidRecord) {
        if (!used.length && !text) return { id: null, used };
        await insert(MedicalFirstAid, {
            _id: faId, school: req.schoolId, student: visit.student, at: new Date(), reason: visit.reason, injury: visit.symptoms || '',
            treatment: text || visit.treatment || 'First aid given', supplies: used, givenBy: req.userId, givenByName: who(req),
            visit: visit._id, incident: visit.incident || null, createdBy: req.userId,
        }, { q });
        return { id: faId, used };
    }
    if (!used.length && !text) return { id: faId, used };
    const { rows } = await q(`SELECT "supplies", "treatment" FROM "medicalfirstaids" WHERE "_id" = $1::uuid`, [faId]);
    await patch(MedicalFirstAid, faId, {
        treatment: text || rows[0]?.treatment || 'First aid given',
        supplies: [...(rows[0]?.supplies || []), ...used],
    }, { q });
    return { id: faId, used };
}

/** Put the visit on a bed — the bed must be free (compare-and-set). */
async function occupyBed(req, bedId, visitId, q) {
    if (!bedId) return null;
    if (!isUuid(bedId)) refuse('That bed could not be found');
    const run = q || ((sql, p) => pool.query(sql, p));
    const { rows } = await run(
        `UPDATE "medicalbeds" SET "status" = 'occupied', "visit" = $3::uuid, "since" = now(), "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "school" = $2::uuid AND "isActive" IS NOT FALSE AND "status" = 'available'
          RETURNING "_id", "label"`,
        [String(bedId), String(req.schoolId), String(visitId)],
    );
    if (!rows[0]) refuse('That bed is not free — choose another', 409, 'MEDICAL_BED_TAKEN');
    return rows[0];
}

async function freeBed(req, visit, q) {
    if (!visit?.bed) return;
    const run = q || ((sql, p) => pool.query(sql, p));
    await run(
        `UPDATE "medicalbeds" SET "status" = 'cleaning', "visit" = NULL, "since" = now(), "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "school" = $2::uuid AND "visit" = $3::uuid`,
        [String(visit.bed), String(req.schoolId), String(visit._id)],
    );
}

/** A weight taken in the room becomes the profile's latest. */
async function noteWeight(req, studentId, weightKg) {
    if (!weightKg) return;
    try {
        const p = await MedicalProfile.findOne({ school: req.schoolId, student: studentId }).lean();
        if (p) await patch(MedicalProfile, p._id, { weightKg, measuredOn: toDay(todayStr()), measuredBy: 'visit' });
        else await MedicalProfile.create({ school: req.schoolId, student: studentId, weightKg, measuredOn: toDay(todayStr()), measuredBy: 'visit' });
    } catch (e) { console.error('[medical] weight update failed:', e.message); }
}

const VISIT_TEXT = ['symptoms', 'observation', 'treatment', 'firstAid', 'remarks'];

async function createVisit(req, body) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const reason = str(body.reason, 200);
    if (!reason) refuse('Give the reason for the visit');
    const open = await openVisitOf(req.schoolId, student._id);
    if (open) refuse(`${student.name} is already in the Medical Room (${open.number})`, 409, 'MEDICAL_VISIT_OPEN', { visitId: String(open._id) });
    const settings = await settingsSvc.get(req.schoolId);
    const status = oneOf(body.status, R.VISIT_STATUS, 'in_room');
    if (status === 'closed') refuse('Record the visit first, then close it');
    const arrivedAt = toInstant(body.arrivedAt) || new Date();
    if (arrivedAt > new Date(Date.now() + 5 * 60000)) refuse('The arrival time is in the future');
    // Which room (a school with more than one): a place that is a room; the main one is stored as no place.
    let roomOf = null;
    if (body.location) {
        const place = await require('./medicalStock').placeOf((sql, p) => pool.query(sql, p), req.schoolId, body.location);
        const [k] = (await pool.query(`SELECT "kind" FROM "medicallocations" WHERE "_id" = $1`, [String(place._id)])).rows;
        // A Medical Room, or a hostel's sick bay (a night nurse seeing a resident there).
        if (!['room', 'hostel'].includes(k?.kind)) refuse('A visit is in a Medical Room or a hostel sick bay — choose one');
        roomOf = place.isMain ? null : String(place._id);
    }
    // The readings taken on arrival start the visit's series.
    const firstReading = vitalsSvc().readingOf(body.vitals, settings.temperatureUnit);
    const reading0 = firstReading ? await vitalsSvc().stamp(req, { student: student._id }, firstReading) : null;

    // The request this visit answers: the one the screen came from, or an
    // open one for the same student (a nurse who opens the visit from the
    // visits page still closes the teacher's loop).
    let request = null;
    if (body.request) {
        request = await findRequest(req, body.request);
        if (String(request.student) !== String(student._id)) refuse('That request is for another student');
        if (!['requested', 'accepted'].includes(request.status)) refuse('That request has already been answered', 409, 'MEDICAL_STALE');
    } else {
        request = await openRequestOf(req.schoolId, student._id);
        if (request && !['requested', 'accepted'].includes(request.status)) request = null;
    }
    let incident = null;
    if (body.incident) {
        incident = await findIncident(req, body.incident);
        if (String(incident.student) !== String(student._id)) refuse('That incident is about another student');
    }

    const visitId = newId();
    const visit = await withTransaction(async (q) => {
        const number = await numbers.next(req.schoolId, 'visit', q);
        const departed = R.DEPARTED.includes(status);
        const doc = {
            _id: visitId, school: req.schoolId, number, student: student._id,
            request: request?._id || null, incident: incident?._id || null,
            arrivedAt, reason, readings: reading0 ? [reading0] : [], location: roomOf,
            restAdvised: bool(body.restAdvised), restMinutes: num(body.restMinutes),
            parentContacted: bool(body.parentContacted), parentContactedAt: bool(body.parentContacted) ? new Date() : null,
            parentContactNote: str(body.parentContactNote, 300),
            referral: referralOf(body.referral), followUp: followUpOf(body.followUp),
            handledBy: req.userId, handledByName: who(req), privateNotes: str(body.privateNotes, 4000),
            status, emergency: status === 'emergency', history: [step(req, status, body.statusNote)],
            departedAt: departed ? (toInstant(body.departedAt) || new Date()) : null, createdBy: req.userId,
        };
        for (const k of VISIT_TEXT) doc[k] = str(body[k], 1500);
        if (status === 'referred') doc.referral = referralOf({ ...(body.referral || {}), referred: true });
        Object.assign(doc, vitalsSvc().derive(doc, doc.readings, null));
        if (!reading0) delete doc.vitals;
        await insert(MedicalVisit, doc, { q });

        const extra = {};
        extra.medicines = await takeMedicines(req, doc, body.medicines, q, body.override);
        const fa = await syncFirstAid(req, doc, { supplies: body.supplies, text: doc.firstAid }, q);
        if (fa.id) extra.firstAidRecord = fa.id;
        if (body.bed && R.IN_ROOM.includes(status)) {
            await occupyBed(req, body.bed, visitId, q);
            extra.bed = String(body.bed); extra.bedIn = new Date();
        }
        const saved = await patch(MedicalVisit, visitId, extra, { q });
        if (incident) await patch(MedicalIncident, incident._id, { visit: visitId, status: incident.status === 'reported' ? 'in_progress' : incident.status }, { q });
        await syncRequest(req, saved, q, departed ? body.outcomeNote : '');
        return saved;
    }).catch(unique);

    if (reading0?.weightKg) noteWeight(req, student._id, reading0.weightKg);
    audit.log(req, { action: 'created', entity: 'visit', entityId: visit._id, student: student._id, summary: `${visit.number}: ${student.name} — ${reason}` });
    logDoses(req, student._id, visit.medicines);
    // A student who walked in on their own: their class teacher hears it here
    // (a teacher's request already told them when it was sent).
    if (!visit.request && R.IN_ROOM.includes(visit.status)) {
        tell.toTeachers(req, {
            studentId: student._id, setting: 'teacherClassAlert',
            title: `${student.name} is in the Medical Room`,
            body: `${student.name} came to the Medical Room at ${time(visit.arrivedAt)} (${reason}).`,
        });
    }
    if ((visit.medicines || []).length) {
        tell.toParents(req, student._id, {
            title: 'Medicine given at school',
            body: `${student.name} was given ${visit.medicines.map((m) => `${m.name} (${m.dosage})`).join(', ')} in the Medical Room at ${time(new Date())}.`,
            setting: 'parentMedicine', tab: 'medicines',
        });
    }
    await afterStatus(req, visit, null, { outcomeNote: body.outcomeNote, student });
    // Recorded as already gone home: the attendance register follows, when the school asks.
    await require('./medicalAttendance').afterStatus(req, visit, null).catch((e) => console.error('[medical] attendance:', e.message));
    return visit;
}

const EDITABLE = ['reason', ...VISIT_TEXT, 'restAdvised', 'restMinutes', 'parentContactNote', 'privateNotes', 'handledByName'];

async function updateVisit(req, id, body) {
    const visit = await findVisit(req, id);
    if (visit.archivedAt) refuse('This visit is archived');
    if (visit.status === 'closed' && !bool(body.allowClosed)) refuse('This visit is closed — reopen it to make changes');
    const settings = await settingsSvc.get(req.schoolId);
    const set = {};
    if (body.reason !== undefined) { set.reason = str(body.reason, 200); if (!set.reason) refuse('The reason cannot be empty'); }
    for (const k of VISIT_TEXT) if (body[k] !== undefined) set[k] = str(body[k], 1500);
    if (body.privateNotes !== undefined) set.privateNotes = str(body.privateNotes, 4000);
    if (body.restAdvised !== undefined) set.restAdvised = bool(body.restAdvised);
    if (body.restMinutes !== undefined) set.restMinutes = num(body.restMinutes);
    if (body.parentContactNote !== undefined) set.parentContactNote = str(body.parentContactNote, 300);
    if (body.parentContacted !== undefined) {
        set.parentContacted = bool(body.parentContacted);
        set.parentContactedAt = set.parentContacted ? (visit.parentContactedAt || new Date()) : null;
    }
    if (body.arrivedAt !== undefined) {
        const at = toInstant(body.arrivedAt);
        if (!at || at > new Date()) refuse('The arrival time is not valid');
        set.arrivedAt = at;
    }
    // New readings join the series; a form sent back with the same values adds nothing.
    let newReading = null;
    if (body.vitals !== undefined) {
        const r = vitalsSvc().readingOf(body.vitals, settings.temperatureUnit);
        if (r && !vitalsSvc().sameAs(r, visit.vitals)) newReading = await vitalsSvc().stamp(req, visit, r);
    }
    if (body.referral !== undefined) set.referral = referralOf(body.referral, visit.referral);
    if (body.followUp !== undefined) set.followUp = followUpOf(body.followUp, visit.followUp);
    const changes = audit.diff(visit, set);

    const hasMeds = Array.isArray(body.medicines) && body.medicines.some((m) => m && (m.plan || m.item || m.medicineName));
    const hasSupplies = Array.isArray(body.supplies) && body.supplies.some((x) => x?.item && num(x.quantity) > 0);
    const firstAidText = set.firstAid !== undefined && set.firstAid && set.firstAid !== visit.firstAid;
    if (!changes.length && !hasMeds && !hasSupplies && !newReading) return visit;

    let given = [];
    const saved = await withTransaction(async (q) => {
        if (hasMeds) {
            given = await takeMedicines(req, visit, body.medicines, q, body.override);
            set.medicines = [...(visit.medicines || []), ...given];
        }
        if (hasSupplies || firstAidText) {
            const fa = await syncFirstAid(req, { ...visit, ...set }, { supplies: hasSupplies ? body.supplies : [], text: set.firstAid ?? '' }, q);
            if (fa.id && !visit.firstAidRecord) set.firstAidRecord = fa.id;
        }
        let row = Object.keys(set).length ? await patch(MedicalVisit, id, set, { where: { school: req.schoolId }, q }) : visit;
        if (newReading) row = await vitalsSvc().pushReading(req, row, newReading, q);
        await syncRequest(req, row, q);
        return row;
    }).catch(unique);
    if (newReading?.weightKg) noteWeight(req, visit.student, newReading.weightKg);
    if (newReading) audit.log(req, { action: 'reading_added', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: readings${newReading.flags.length ? ` — ${newReading.flags.map((f) => f.label).join(', ')}` : ''}` });
    if (changes.length) audit.log(req, { action: 'updated', entity: 'visit', entityId: id, student: visit.student, summary: `Updated ${visit.number}`, changes });
    logDoses(req, visit.student, given);
    if (hasMeds) {
        const card = await access.studentCard(req.schoolId, visit.student);
        if (given.length) {
            tell.toParents(req, visit.student, {
                title: 'Medicine given at school',
                body: `${card?.name || 'Your child'} was given ${given.map((m) => `${m.name} (${m.dosage})`).join(', ')} in the Medical Room at ${time(new Date())}.`,
                setting: 'parentMedicine', tab: 'medicines',
            });
        }
    }
    if (hasSupplies) {
        const card = await access.studentCard(req.schoolId, visit.student);
        tell.toParents(req, visit.student, {
            title: 'First aid given at school',
            body: `${card?.name || 'Your child'} was given first aid in the Medical Room${(set.firstAid || visit.firstAid) ? `: ${set.firstAid || visit.firstAid}` : ''}.`,
            setting: 'parentFirstAid', tab: 'visits',
        });
    }
    return saved;
}

/**
 * Move a visit on. body: { status, note, outcomeNote (what the teacher is
 * told), bed (observation), referral (referred), notifyParents (default true) }
 */
async function setVisitStatus(req, id, body) {
    const visit = await findVisit(req, id);
    if (visit.archivedAt) refuse('This visit is archived');
    const status = oneOf(body.status, R.VISIT_STATUS, null);
    if (!status) refuse('Choose what happens next');
    if (status === visit.status) refuse(`The visit is already “${R.VISIT_STATUS[status].label}”`);
    if (!(R.VISIT_NEXT[visit.status] || []).includes(status)) {
        refuse(`A visit that is “${R.VISIT_STATUS[visit.status].label}” cannot be moved to “${R.VISIT_STATUS[status].label}”`);
    }
    if (status === 'closed' && R.followUpState(visit.followUp)) refuse('This visit has a follow-up waiting — record it as done or cancel it first', 409, 'MEDICAL_FOLLOWUP_OPEN');
    if (status === 'referred' && !str(body.referral?.hospital ?? visit.referral?.hospital)) refuse('Name the hospital the student is referred to');

    const set = { status };
    if (status === 'emergency') set.emergency = true;
    if (R.DEPARTED.includes(status)) {
        set.departedAt = visit.departedAt || new Date();
        if (visit.bed && !visit.bedOut) set.bedOut = new Date();
    }
    if (status === 'closed') { set.closedAt = new Date(); set.closedBy = req.userId; }
    if (status === 'referred') set.referral = referralOf({ ...(body.referral || {}), referred: true }, visit.referral);
    // The colour and the next check follow the status: none once the student has left.
    { const d = vitalsSvc().derive({ ...visit, ...set }); set.triage = d.triage; set.nextCheckAt = d.nextCheckAt; }
    if (R.IN_ROOM.includes(status) && body.parentContacted !== undefined) {
        set.parentContacted = bool(body.parentContacted);
        set.parentContactedAt = set.parentContacted ? new Date() : null;
    }

    const saved = await withTransaction(async (q) => {
        if (status === 'observation' && body.bed && !visit.bed) {
            await occupyBed(req, body.bed, id, q);
            set.bed = String(body.bed); set.bedIn = new Date();
        }
        if (R.DEPARTED.includes(status) || status === 'closed') await freeBed(req, visit, q);
        const row = await patch(MedicalVisit, id, set, { where: { school: req.schoolId, status: visit.status }, push: { history: step(req, status, body.note) }, q });
        if (!row) refuse('This visit was changed by someone else a moment ago — reload', 409, 'MEDICAL_STALE');
        await syncRequest(req, row, q, body.outcomeNote || (R.DEPARTED.includes(status) ? defaultOutcome(row) : ''));
        return row;
    });
    audit.log(req, { action: 'status_changed', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: ${R.VISIT_STATUS[visit.status].label} → ${R.VISIT_STATUS[status].label}${body.note ? ` (${str(body.note, 120)})` : ''}` });
    // Sent home and must stay off school for a while: the return-to-school record starts now.
    if (status === 'sent_home' && body.exclusion?.rule) {
        await require('./medicalRestrictions').addExclusion(req, saved.student, { ...body.exclusion, from: body.exclusion.from || saved.departedAt }, { visit: String(id) });
    }
    // Sent home with the parent already at the door: the handover is recorded with it, and nobody needs chasing.
    const collectingNow = status === 'sent_home' && body.collection && (body.collection.contact || body.collection.name);
    await afterStatus(req, saved, visit.status, { outcomeNote: body.outcomeNote, notifyParents: body.notifyParents !== false, collectingNow: !!collectingNow });
    // Sent home (or to hospital): the attendance register follows, when the school asks; a correction puts it back.
    await require('./medicalAttendance').afterStatus(req, saved, visit.status).catch((e) => console.error('[medical] attendance:', e.message));
    live.changed(req, 'visit', { id: String(id), status, urgent: ['emergency', 'referred'].includes(status) });
    if (collectingNow) {
        try { return await recordCollection(req, id, body.collection); } catch (e) {
            // The handover was not recorded: the family still has to be reached.
            if (body.notifyParents !== false) {
                const card = await access.studentCard(req.schoolId, saved.student);
                await urgentSvc().open(req, { studentId: saved.student, visit: saved._id, kind: 'sent_home', setting: 'parentSentHome', title: `${card?.name || 'The student'} is being sent home`, body: `${saved.number}: ${saved.reason}` });
            }
            throw e;
        }
    }
    return saved;
}

function defaultOutcome(v) {
    const at = time(v.departedAt || new Date());
    if (v.status === 'returned') return `Seen in the Medical Room${v.restAdvised && v.restMinutes ? `, rested ${v.restMinutes} min` : ''}; back to class at ${at}.`;
    if (v.status === 'sent_home') return `Sent home from the Medical Room at ${at}.`;
    if (v.status === 'referred') return `Referred to ${v.referral?.hospital || 'hospital'} at ${at}.`;
    return '';
}

/** Who is told when a visit reaches `visit.status` (from `from`; null = just opened). */
async function afterStatus(req, visit, from, { outcomeNote = '', notifyParents = true, student = null, collectingNow = false } = {}) {
    try {
        const card = student || await access.studentCard(req.schoolId, visit.student);
        const name = card?.name || 'The student';
        const cls = card?.classLabel ? ` (${card.classLabel})` : '';
        const request = visit.request ? await MedicalRequest.findOne({ _id: visit.request }).select('requestedBy').lean() : null;
        const note = str(outcomeNote, 300) || defaultOutcome(visit);
        switch (visit.status) {
        case 'emergency':
            tell.toStaff(req, {
                title: `EMERGENCY · ${name}${cls}`,
                body: `${visit.number}: ${name} is being treated as an emergency in the Medical Room — ${visit.reason}.`,
                setting: 'staffEmergency', link: { type: 'medical.room' }, urgent: true, email: true,
            });
            if (notifyParents) {
                tell.toParents(req, visit.student, {
                    title: `Medical emergency — ${name}`,
                    body: `${name} is receiving urgent care in the school's Medical Room (${visit.reason}). The school will contact you. Please call the school if you have not heard from us.`,
                    setting: 'parentVisit', urgent: true, tab: 'visits',
                    i18n: { key: 'emergency', vars: { name, reason: visit.reason } },
                });
                await urgentSvc().open(req, { studentId: visit.student, visit: visit._id, kind: 'emergency', setting: 'parentVisit', title: `Medical emergency — ${name}`, body: `${visit.number}: ${visit.reason}` });
            }
            tell.toTeachers(req, { studentId: visit.student, requesterId: request?.requestedBy, requestId: visit.request, title: `${name} is being treated as an emergency`, body: `${name} is receiving urgent care in the Medical Room.` });
            break;
        case 'returned':
            tell.toTeachers(req, { studentId: visit.student, requesterId: request?.requestedBy, requestId: visit.request, title: `${name} is returning to class`, body: note });
            if (notifyParents) {
                tell.toParents(req, visit.student, {
                    title: `${name} visited the Medical Room`,
                    body: `${name} visited the Medical Room at ${time(visit.arrivedAt)} (${visit.reason})${visit.treatment ? `. Treatment: ${visit.treatment}` : ''}. ${note}`,
                    setting: 'parentVisit', tab: 'visits',
                    i18n: { key: 'visit_seen', vars: { name, time: time(visit.arrivedAt), reason: visit.reason, treatment: visit.treatment } },
                });
            }
            break;
        case 'sent_home':
            tell.toTeachers(req, { studentId: visit.student, requesterId: request?.requestedBy, requestId: visit.request, title: `${name} has been sent home`, body: note });
            if (notifyParents) {
                tell.toParents(req, visit.student, {
                    title: `${name} is being sent home`,
                    body: `${name} came to the Medical Room at ${time(visit.arrivedAt)} (${visit.reason}) and is being sent home${visit.treatment ? `. Treatment given: ${visit.treatment}` : ''}. Please collect ${name} from the school office or contact the school.`,
                    setting: 'parentSentHome', urgent: true, tab: 'visits',
                    i18n: { key: 'sent_home', vars: { name, time: time(visit.arrivedAt), reason: visit.reason, treatment: visit.treatment } },
                });
                // Already collected at the door (recorded with the status): nobody needs chasing.
                if (!collectingNow && !visit.collection?.at) await urgentSvc().open(req, { studentId: visit.student, visit: visit._id, kind: 'sent_home', setting: 'parentSentHome', title: `${name} is being sent home`, body: `${visit.number}: ${visit.reason}` });
            }
            break;
        case 'referred':
            tell.toTeachers(req, { studentId: visit.student, requesterId: request?.requestedBy, requestId: visit.request, title: `${name} has been referred to hospital`, body: note });
            tell.toStaff(req, { title: `${name} referred to hospital`, body: `${visit.number}: referred to ${visit.referral?.hospital || 'hospital'}${visit.referral?.reason ? ` — ${visit.referral.reason}` : ''}.`, setting: 'staffEmergency', link: { type: 'medical.visit', entityId: String(visit._id) } });
            if (notifyParents) {
                tell.toParents(req, visit.student, {
                    title: `Hospital referral — ${name}`,
                    body: `${name} has been referred from the school's Medical Room to ${visit.referral?.hospital || 'hospital'}${visit.referral?.reason ? ` (${visit.referral.reason})` : ''}${visit.referral?.transport ? `, by ${visit.referral.transport}` : ''}. Please contact the school immediately.`,
                    setting: 'parentReferral', urgent: true, tab: 'visits',
                    i18n: { key: 'referred', vars: { name, hospital: visit.referral?.hospital, reason: visit.referral?.reason, transport: visit.referral?.transport } },
                });
                await urgentSvc().open(req, { studentId: visit.student, visit: visit._id, kind: 'referred', setting: 'parentReferral', title: `Hospital referral — ${name}`, body: `${visit.number}: ${visit.referral?.hospital || 'hospital'}${visit.referral?.reason ? ` — ${visit.referral.reason}` : ''}` });
            }
            break;
        case 'closed':
            await urgentSvc().closeForVisit(req, visit._id, 'The visit was closed');
            break;
        default:
            break;
        }
        // A head injury: the parents are told what to watch for over the next two days.
        const proto = visit.protocol?.key ? require('./medicalProtocols').BY_KEY[visit.protocol.key] : null;
        if (proto?.parentAdvice && R.DEPARTED.includes(visit.status) && !R.DEPARTED.includes(from) && notifyParents) {
            tell.toParents(req, visit.student, {
                title: `${proto.title} at school — what to watch for`,
                body: `${name} was seen in the Medical Room for a ${proto.title.toLowerCase()} at ${time(visit.arrivedAt)}. ${proto.parentAdvice}`,
                setting: 'parentVisit', urgent: (visit.protocol.redFlags || []).length > 0, tab: 'visits',
            });
        }
        if (R.DEPARTED.includes(visit.status) && visit.followUp?.required && !R.DEPARTED.includes(from) && notifyParents) {
            tell.toParents(req, visit.student, {
                title: 'Medical follow-up needed',
                body: `The Medical Room would like to see ${name} again${visit.followUp.on ? ` on ${dayLabel(visit.followUp.on)}` : ''}${visit.followUp.note ? `: ${visit.followUp.note}` : ''}.`,
                setting: 'parentFollowUp', tab: 'visits',
            });
        }
    } catch (e) { console.error('[medical] visit notifications failed:', e.message); }
}

async function reopenVisit(req, id, body = {}) {
    const visit = await findVisit(req, id);
    if (visit.status !== 'closed') refuse('Only a closed visit can be reopened');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the visit is being reopened');
    const prev = [...(visit.history || [])].reverse().find((h) => h.status !== 'closed')?.status || 'returned';
    const status = R.DEPARTED.includes(prev) ? prev : 'returned';
    const row = await withTransaction(async (q) => {
        const out = await patch(MedicalVisit, id, { status, closedAt: null, closedBy: null }, { where: { school: req.schoolId, status: 'closed' }, push: { history: step(req, status, `Reopened — ${reason}`) }, q });
        if (!out) refuse('This visit changed a moment ago — reload', 409, 'MEDICAL_STALE');
        // The teacher's request comes back with it, rather than staying "Closed".
        await syncRequest(req, out, q);
        return out;
    });
    audit.log(req, { action: 'reopened', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number} reopened — ${reason}` });
    return row;
}

async function contactParent(req, id, body = {}) {
    const visit = await findVisit(req, id);
    const note = str(body.note, 300);
    const row = await patch(MedicalVisit, id, { parentContacted: true, parentContactedAt: new Date(), parentContactNote: note || visit.parentContactNote },
        { where: { school: req.schoolId } });
    audit.log(req, { action: 'parent_contacted', entity: 'visit', entityId: id, student: visit.student, summary: `Parent contacted about ${visit.number}${note ? ` — ${note}` : ''}` });
    if (bool(body.notify)) {
        const card = await access.studentCard(req.schoolId, visit.student);
        tell.toParents(req, visit.student, {
            title: `Please contact the Medical Room — ${card?.name || 'your child'}`,
            body: `${card?.name || 'Your child'} is in the school's Medical Room (${visit.reason}).${note ? ` ${note}` : ''} Please call the school.`,
            urgent: true, tab: 'visits',
        });
    }
    return row;
}

/* ── Sent home: who collected the child ───────────────────────────────────── */

const digits = (p) => String(p || '').replace(/[^\d]/g, '').slice(-10);

/**
 * The people on record who may collect the child — parents and guardians,
 * the emergency contact, the alternate contact — each with a key the screen
 * sends back (`parent:<phone>`, `emergency:<phone>` …).
 */
async function collectorsFor(schoolId, studentId) {
    const read = require('./medicalRead');
    const [{ contacts }, profile] = await Promise.all([
        read.contactsOf(schoolId, studentId),
        MedicalProfile.findOne({ school: schoolId, student: studentId }).select('alternateContact').lean(),
    ]);
    const list = read.withAlternate(contacts, profile?.alternateContact);
    const seen = new Set();
    const out = [];
    for (const c of list) {
        const key = `${c.kind}:${digits(c.phone) || String(c.name || '').toLowerCase().replace(/\s+/g, '-')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, kind: c.kind, name: c.name || '', relation: c.relation || '', phone: c.phone || '' });
    }
    return out;
}

/**
 * body: { contact: <key from collectorsFor> | 'other', name, relation, phone,
 *         idChecked, idNote, note, at, correct }
 * Someone not on record needs `note` — who allowed it (e.g. "Mother, by phone at 11:40").
 */
async function recordCollection(req, id, body = {}) {
    const visit = await findVisit(req, id);
    if (visit.status !== 'sent_home') refuse('Only a student sent home is collected');
    if (visit.collection?.at && !bool(body.correct)) {
        refuse(`Already recorded: collected by ${visit.collection.name}${visit.collection.relation ? ` (${visit.collection.relation})` : ''} at ${time(visit.collection.at)}`, 409, 'MEDICAL_STALE');
    }
    const known = await collectorsFor(req.schoolId, visit.student);
    const key = str(body.contact, 160);
    const match = key && key !== 'other' ? known.find((c) => c.key === key) : null;
    if (key && key !== 'other' && !match) refuse('That person is not on the student\'s record — choose "Someone else"');
    const at = toInstant(body.at) || new Date();
    if (at > new Date(Date.now() + 5 * 60000)) refuse('The collection time is in the future');
    if (visit.departedAt && at < new Date(new Date(visit.departedAt).getTime() - 60 * 60000)) refuse('The collection time is before the student was sent home');
    const collection = match ? {
        name: match.name, relation: match.relation, phone: match.phone, contact: match.key, verified: true,
    } : {
        name: str(body.name, 120), relation: str(body.relation, 60), phone: str(body.phone, 30), contact: 'other', verified: false,
    };
    if (!collection.name) refuse('Who collected the student?');
    const note = str(body.note, 300);
    if (!match && !note) refuse('Someone not on the record: say who allowed it — e.g. "Mother, by phone at 11:40"');
    Object.assign(collection, {
        idChecked: bool(body.idChecked), idNote: str(body.idNote, 120), note, at, by: req.userId, byName: who(req),
    });
    const row = await withTransaction(async (q) => {
        const out = await patch(MedicalVisit, id, { collection }, { where: { school: req.schoolId, status: 'sent_home' }, q });
        if (!out) refuse('This visit changed a moment ago — reload', 409, 'MEDICAL_STALE');
        if (out.request) {
            await patch(MedicalRequest, out.request, { outcomeNote: `Sent home — collected by ${collection.name}${collection.relation ? ` (${collection.relation})` : ''} at ${time(at)}.` }, { q });
        }
        return out;
    });
    audit.log(req, {
        action: 'collected', entity: 'visit', entityId: id, student: visit.student,
        summary: `${visit.number}: collected by ${collection.name}${collection.relation ? ` (${collection.relation})` : ''}${collection.verified ? '' : ' — not on record'}${collection.idChecked ? ', ID checked' : ''}${note ? ` — ${note}` : ''}`,
    });
    await urgentSvc().closeForVisit(req, id, `Collected by ${collection.name}${collection.relation ? ` (${collection.relation})` : ''}`).catch(() => {});
    live.changed(req, 'visit', { id: String(id) });
    const card = await access.studentCard(req.schoolId, visit.student);
    const name = card?.name || 'The student';
    const request = visit.request ? await MedicalRequest.findOne({ _id: visit.request }).select('requestedBy').lean() : null;
    tell.toTeachers(req, {
        studentId: visit.student, requesterId: request?.requestedBy, requestId: visit.request,
        title: `${name} was collected from school`,
        body: `${name} (sent home from the Medical Room) was collected by ${collection.name}${collection.relation ? ` (${collection.relation})` : ''} at ${time(at)}.`,
    });
    // A parent should know when someone else took their child home.
    if (!collection.verified || !['parent'].includes(match?.kind)) {
        tell.toParents(req, visit.student, {
            title: `${name} was collected from school`,
            body: `${name} was collected from school by ${collection.name}${collection.relation ? ` (${collection.relation})` : ''} at ${time(at)}.${collection.verified ? '' : ' This person is not on the contact list the school holds — please call the school if you did not arrange this.'}`,
            setting: 'parentSentHome', urgent: !collection.verified, tab: 'visits',
        });
    }
    return row;
}

async function moveBed(req, id, body = {}) {
    const visit = await findVisit(req, id);
    if (!R.IN_ROOM.includes(visit.status)) refuse('Only a student in the room can be given a bed');
    // Already there: freeing the bed first would mark it "being cleaned" and then refuse it as "not free".
    if (body.bed && String(body.bed) === String(visit.bed || '')) return visit;
    const saved = await withTransaction(async (q) => {
        if (visit.bed) await freeBed(req, visit, q);
        const set = { bed: null, bedIn: visit.bedIn, bedOut: visit.bed ? new Date() : visit.bedOut };
        if (body.bed) { await occupyBed(req, body.bed, id, q); set.bed = String(body.bed); set.bedIn = new Date(); set.bedOut = null; }
        return patch(MedicalVisit, id, set, { where: { school: req.schoolId }, q });
    });
    audit.log(req, { action: body.bed ? 'bed_assigned' : 'bed_released', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: ${body.bed ? 'moved to a bed' : 'left the bed'}` });
    return saved;
}

/* ── Incidents ────────────────────────────────────────────────────────────── */

async function createIncident(req, body, { teacher = false } = {}) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const settings = await settingsSvc.get(req.schoolId);
    const type = oneOf(body.type, R.INCIDENT_TYPE, 'other');
    if (settings.incidentTypes?.length && !settings.incidentTypes.includes(type) && type !== 'other') refuse('That incident type is not in use at this school');
    const description = str(body.description, 2000);
    if (!description) refuse('Describe what happened');
    const occurredAt = toInstant(body.occurredAt) || new Date();
    if (occurredAt > new Date(Date.now() + 5 * 60000)) refuse('The time of the incident is in the future');
    const severity = oneOf(body.severity, R.INCIDENT_SEVERITY, 'minor');

    const doc = {
        school: req.schoolId, number: await numbers.next(req.schoolId, 'incident'), student: student._id, occurredAt,
        location: str(body.location, 120), type, description, injury: str(body.injury, 600), bodyPart: str(body.bodyPart, 80),
        severity, firstAid: str(body.firstAid, 1000), witnesses: str(body.witnesses, 300), remarks: str(body.remarks, 1000),
        reportedBy: req.userId, reportedByName: who(req), reportedByRole: req.userRole,
        status: 'reported', history: [step(req, 'reported')],
    };
    if (!teacher) {
        doc.medicineUsed = str(body.medicineUsed, 300);
        doc.referral = referralOf(body.referral);
        doc.followUp = followUpOf(body.followUp);
        doc.privateNotes = str(body.privateNotes, 4000);
        const status = oneOf(body.status, R.INCIDENT_STATUS, 'reported');
        if (status !== 'reported') { doc.status = status; doc.history = [step(req, status)]; }
        if (status === 'closed') { doc.closedAt = new Date(); doc.closedBy = req.userId; }
        if (isUuid(body.witnessTeacher)) doc.witnessTeacher = body.witnessTeacher;
    }
    const row = plainOf(await MedicalIncident.create(doc));
    audit.log(req, { action: 'created', entity: 'incident', entityId: row._id, student: student._id, summary: `${row.number}: ${R.INCIDENT_TYPE[type]} — ${student.name} (${R.INCIDENT_SEVERITY[severity].label})` });

    const urgent = severity === 'serious' || severity === 'critical';
    tell.toStaff(req, {
        title: `${urgent ? `${R.INCIDENT_SEVERITY[severity].label.toUpperCase()} · ` : ''}Incident: ${student.name}${student.classLabel ? ` (${student.classLabel})` : ''}`,
        body: `${who(req)} reported ${R.INCIDENT_TYPE[type].toLowerCase()}${row.location ? ` at ${row.location}` : ''}: ${description.slice(0, 200)}`,
        setting: urgent ? 'staffEmergency' : 'staffRequests', link: { type: 'medical.incident', entityId: String(row._id) }, urgent, email: severity === 'critical',
    });
    if (!teacher && bool(body.notifyParents)) await notifyIncidentParents(req, row._id, { note: body.parentNote, quiet: true });
    return row;
}

const INCIDENT_EDIT = ['location', 'description', 'injury', 'bodyPart', 'firstAid', 'medicineUsed', 'witnesses', 'remarks', 'privateNotes'];

async function updateIncident(req, id, body) {
    const inc = await findIncident(req, id);
    if (inc.archivedAt) refuse('This incident is archived');
    const set = {};
    for (const k of INCIDENT_EDIT) if (body[k] !== undefined) set[k] = str(body[k], k === 'privateNotes' ? 4000 : 2000);
    if (body.description !== undefined && !set.description) refuse('The description cannot be empty');
    if (body.type !== undefined) set.type = oneOf(body.type, R.INCIDENT_TYPE, inc.type);
    if (body.severity !== undefined) set.severity = oneOf(body.severity, R.INCIDENT_SEVERITY, inc.severity);
    if (body.occurredAt !== undefined) { set.occurredAt = toInstant(body.occurredAt); if (!set.occurredAt || set.occurredAt > new Date()) refuse('The time of the incident is not valid'); }
    if (body.referral !== undefined) set.referral = referralOf(body.referral, inc.referral);
    if (body.followUp !== undefined) set.followUp = followUpOf(body.followUp, inc.followUp);
    if (body.witnessTeacher !== undefined) set.witnessTeacher = isUuid(body.witnessTeacher) ? body.witnessTeacher : null;
    const changes = audit.diff(inc, set);
    if (!changes.length) return inc;
    const row = await patch(MedicalIncident, id, set, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'incident', entityId: id, student: inc.student, summary: `Updated ${inc.number}`, changes });
    if (set.severity && ['serious', 'critical'].includes(set.severity) && !['serious', 'critical'].includes(inc.severity)) {
        const card = await access.studentCard(req.schoolId, inc.student);
        tell.toStaff(req, { title: `${R.INCIDENT_SEVERITY[set.severity].label.toUpperCase()} · Incident: ${card?.name || ''}`, body: `${inc.number} was raised to ${R.INCIDENT_SEVERITY[set.severity].label.toLowerCase()}.`, setting: 'staffEmergency', link: { type: 'medical.incident', entityId: String(id) }, urgent: true });
    }
    return row;
}

const INCIDENT_NEXT = { reported: ['in_progress', 'resolved', 'closed'], in_progress: ['reported', 'resolved', 'closed'], resolved: ['in_progress', 'closed'], closed: ['in_progress'] };

async function setIncidentStatus(req, id, body) {
    const inc = await findIncident(req, id);
    const status = oneOf(body.status, R.INCIDENT_STATUS, null);
    if (!status || status === inc.status) refuse('Choose a new status');
    if (!(INCIDENT_NEXT[inc.status] || []).includes(status)) refuse(`An incident that is ${inc.status.replace('_', ' ')} cannot be moved to ${status.replace('_', ' ')}`);
    if (status === 'closed' && R.followUpState(inc.followUp)) refuse('This incident has a follow-up waiting — record it as done or cancel it first', 409, 'MEDICAL_FOLLOWUP_OPEN');
    if (inc.status === 'closed' && !str(body.note)) refuse('Say why the incident is being reopened');
    const set = { status };
    if (status === 'closed') { set.closedAt = new Date(); set.closedBy = req.userId; } else { set.closedAt = null; set.closedBy = null; }
    const row = await patch(MedicalIncident, id, set, { where: { school: req.schoolId, status: inc.status }, push: { history: step(req, status, body.note) } });
    if (!row) refuse('This incident changed a moment ago — reload', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'status_changed', entity: 'incident', entityId: id, student: inc.student, summary: `${inc.number}: ${inc.status} → ${status}` });
    return row;
}

async function notifyIncidentParents(req, id, body = {}) {
    const inc = await findIncident(req, id);
    const card = await access.studentCard(req.schoolId, inc.student);
    const name = card?.name || 'Your child';
    const note = str(body.note, 400);
    const urgent = ['serious', 'critical'].includes(inc.severity) || inc.referral?.referred;
    const what = R.INCIDENT_TYPE[inc.type].toLowerCase();
    const happened = what === 'other' ? 'an incident' : `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}`;
    // "at 3:20 pm" only when it was today — a notice about Monday's fall must say Monday.
    const when = new Date(inc.occurredAt).toDateString() === new Date().toDateString()   // the school's clock (pinned zone)
        ? `at ${time(inc.occurredAt)}` : `on ${R.instantLabel(inc.occurredAt)}`;
    await tell.toParents(req, inc.student, {
        title: `Medical incident — ${name}`,
        body: `${name} had ${happened} at school${inc.location ? ` (${inc.location})` : ''} ${when}.`
            + `${inc.injury ? ` Injury: ${inc.injury}.` : ''}${inc.firstAid ? ` First aid: ${inc.firstAid}.` : ''}${note ? ` ${note}` : ''}`,
        // The family page keeps incidents under "Visits & Incidents".
        setting: 'parentIncident', urgent, tab: 'visits',
        i18n: { key: 'incident', vars: {
            name, firstAid: inc.firstAid,
            when: new Date(inc.occurredAt).toDateString() === new Date().toDateString() ? `आज ${time(inc.occurredAt)} बजे` : `${R.instantLabel(inc.occurredAt)} को`,
            what: `${R.INCIDENT_TYPE[inc.type]}${inc.location ? ` (${inc.location})` : ''}${inc.injury ? ` — ${inc.injury}` : ''}`,
        } },
    });
    if (urgent) await urgentSvc().open(req, { studentId: inc.student, incident: inc._id, kind: 'incident', setting: 'parentIncident', title: `Medical incident — ${name}`, body: `${inc.number}: ${R.INCIDENT_TYPE[inc.type]}${inc.injury ? ` — ${inc.injury}` : ''}` });
    const row = await patch(MedicalIncident, id, { parentNotified: true, parentNotifiedAt: new Date(), parentNotifyNote: note }, { where: { school: req.schoolId } });
    if (!body.quiet) audit.log(req, { action: 'parent_notified', entity: 'incident', entityId: id, student: inc.student, summary: `Parents told about ${inc.number}` });
    return row;
}

/** Bring the student of an incident into the room: a visit that points back at it. */
async function treatIncident(req, id, body = {}) {
    const inc = await findIncident(req, id);
    if (inc.visit) refuse('This incident already has a Medical Room visit');
    return createVisit(req, {
        ...body, student: inc.student, incident: id,
        reason: body.reason || `${R.INCIDENT_TYPE[inc.type]}${inc.injury ? ` — ${inc.injury}` : ''}`,
        symptoms: body.symptoms ?? inc.description,
    });
}

/* ── First aid (on its own) ───────────────────────────────────────────────── */

async function recordFirstAid(req, body) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const reason = str(body.reason, 200);
    if (!reason) refuse('Give the reason for the first aid');
    const treatment = str(body.treatment, 1500);
    if (!treatment) refuse('Describe the first aid given');
    const at = toInstant(body.at) || new Date();
    if (at > new Date(Date.now() + 5 * 60000)) refuse('The time is in the future');
    let incident = null;
    if (body.incident) {
        incident = await findIncident(req, body.incident);
        if (String(incident.student) !== String(student._id)) refuse('That incident is about another student');
    }
    const faId = newId();
    const row = await withTransaction(async (q) => {
        const supplies = await takeSupplies(req, body.supplies, faId, student._id, q);
        return insert(MedicalFirstAid, {
            _id: faId, school: req.schoolId, student: student._id, at, reason, injury: str(body.injury, 600), treatment, supplies,
            givenBy: isUuid(body.givenBy) ? body.givenBy : req.userId, givenByName: str(body.givenByName, 120) || who(req),
            remarks: str(body.remarks, 600), incident: incident?._id || null, createdBy: req.userId,
        }, { q });
    });
    audit.log(req, { action: 'created', entity: 'first_aid', entityId: faId, student: student._id, summary: `First aid: ${student.name} — ${reason}${row.supplies.length ? ` (${row.supplies.map((s) => `${s.quantity} ${s.name}`).join(', ')})` : ''}` });
    tell.toParents(req, student._id, {
        title: `First aid given — ${student.name}`,
        body: `${student.name} was given first aid at school at ${time(at)} (${reason}): ${treatment}.`,
        setting: 'parentFirstAid', tab: 'visits',
    });
    return plainOf(row);
}

/* ── Follow-ups ───────────────────────────────────────────────────────────── */

const FOLLOWUP_MODELS = { visit: MedicalVisit, incident: MedicalIncident, checkup: MedicalCheckup };

async function completeFollowUp(req, kind, id, body = {}) {
    const Model = FOLLOWUP_MODELS[kind];
    if (!Model || !isUuid(id)) notFound('Follow-up');
    const row = await Model.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Follow-up');
    if (!row.followUp?.required || row.followUp.status !== 'pending') refuse('There is no follow-up waiting on this record');
    const status = body.status === 'cancelled' ? 'cancelled' : 'done';
    const outcome = str(body.outcome, 600);
    if (status === 'done' && !outcome) refuse('Say what the follow-up found');
    const followUp = { ...row.followUp, status, doneAt: new Date(), doneBy: req.userId, outcome: outcome || str(body.reason, 300) };
    const out = await patch(Model, id, { followUp }, { where: { school: req.schoolId } });
    audit.log(req, { action: `followup_${status}`, entity: kind, entityId: id, student: row.student, summary: `Follow-up ${status}${outcome ? ` — ${outcome}` : ''}` });
    return out;
}

/* ── Archive (never delete) ───────────────────────────────────────────────── */

const ARCHIVABLE = { visit: MedicalVisit, incident: MedicalIncident, first_aid: MedicalFirstAid };

async function archive(req, kind, id, body = {}) {
    const Model = ARCHIVABLE[kind];
    if (!Model || !isUuid(id)) notFound('Record');
    const row = await Model.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Record');
    if (row.archivedAt) refuse('This record is already archived');
    if (kind === 'visit' && R.IN_ROOM.includes(row.status)) refuse('The student is still in the room — finish the visit first');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why this record is being archived');
    const out = await patch(Model, id, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: reason }, { where: { school: req.schoolId, archivedAt: null } });
    audit.log(req, { action: 'archived', entity: kind, entityId: id, student: row.student, summary: `Archived ${row.number || kind} — ${reason}` });
    return out;
}

async function restore(req, kind, id) {
    const Model = ARCHIVABLE[kind];
    if (!Model || !isUuid(id)) notFound('Record');
    const row = await Model.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row?.archivedAt) refuse('This record is not archived');
    const out = await patch(Model, id, { archivedAt: null, archivedBy: null, archiveReason: '' }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'restored', entity: kind, entityId: id, student: row.student, summary: `Restored ${row.number || kind}` });
    return out;
}

/* ── Beds ─────────────────────────────────────────────────────────────────── */

/** The room a bed is in: a place that is a room (the main one is stored as no place). */
async function bedRoom(req, location) {
    if (!location) return null;
    const place = await require('./medicalStock').placeOf((sql, p) => pool.query(sql, p), req.schoolId, location);
    const [k] = (await pool.query(`SELECT "kind" FROM "medicallocations" WHERE "_id" = $1`, [String(place._id)])).rows;
    if (k?.kind !== 'room') refuse('A bed is in a Medical Room — choose a room');
    return place.isMain ? null : String(place._id);
}

async function saveBed(req, id, body) {
    const label = str(body.label, 60);
    if (!label) refuse('Give the bed a name');
    const kind = oneOf(body.kind, R.BED_KIND, 'bed');
    if (id) {
        const bed = await MedicalBed.findOne({ _id: id, school: req.schoolId }).lean();
        if (!bed) notFound('Bed');
        const set = { label, kind, note: str(body.note, 200), sortOrder: num(body.sortOrder) ?? bed.sortOrder };
        if (body.location !== undefined) set.location = await bedRoom(req, body.location);
        if (body.status !== undefined) {
            const status = oneOf(body.status, R.BED_STATUS, bed.status);
            if (status === 'occupied' && bed.status !== 'occupied') refuse('A bed is occupied by putting a student on it from their visit');
            if (bed.status === 'occupied' && status !== 'occupied') refuse('Discharge the student from this bed first');
            set.status = status;
            if (status !== bed.status) set.since = new Date();
        }
        const row = await patch(MedicalBed, id, set, { where: { school: req.schoolId } });
        audit.log(req, { action: 'updated', entity: 'bed', entityId: id, summary: `Bed ${label}${set.status && set.status !== bed.status ? ` → ${R.BED_STATUS[set.status].label}` : ''}` });
        return row;
    }
    const count = await MedicalBed.countDocuments({ school: req.schoolId, isActive: true });
    if (count >= 40) refuse('A Medical Room can have at most 40 beds and rest areas');
    const row = plainOf(await MedicalBed.create({ school: req.schoolId, label, kind, note: str(body.note, 200), sortOrder: num(body.sortOrder) ?? count + 1, status: 'available', since: new Date(), location: await bedRoom(req, body.location) }));
    audit.log(req, { action: 'created', entity: 'bed', entityId: row._id, summary: `Added ${R.BED_KIND[kind].toLowerCase()} ${label}` });
    return row;
}

async function removeBed(req, id) {
    const bed = await MedicalBed.findOne({ _id: id, school: req.schoolId }).lean();
    if (!bed) notFound('Bed');
    if (bed.status === 'occupied') refuse('A student is on this bed');
    await patch(MedicalBed, id, { isActive: false, status: 'out_of_service' }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'archived', entity: 'bed', entityId: id, summary: `Removed bed ${bed.label}` });
    return { _id: id };
}

module.exports = {
    collectorsFor, recordCollection,
    findRequest, findVisit, findIncident, openVisitOf, openRequestOf,
    createRequest, acceptRequest, cancelRequest, arriveRequest,
    createVisit, updateVisit, setVisitStatus, reopenVisit, contactParent, moveBed,
    createIncident, updateIncident, setIncidentStatus, notifyIncidentParents, treatIncident,
    recordFirstAid, completeFollowUp, archive, restore, saveBed, removeBed,
};
