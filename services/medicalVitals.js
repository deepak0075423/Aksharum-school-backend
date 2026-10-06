'use strict';
/**
 * A visit, looked at over time (Oct 2026): every set of readings, how urgent
 * the case is (triage), the protocol being followed, when the student is next
 * due a look, and the body map of their injuries.
 *
 *   readingOf     a reading from a form, checked (null when nothing was measured)
 *   addReading    another set of readings on a visit
 *   strikeReading a reading entered by mistake, struck through with a reason — never deleted
 *   setTriage     the nurse's colour ('auto' goes back to following the suggestion)
 *   setProtocol   the protocol, its ticked red flags and the steps done
 *   setInjuries   the body map, on a visit or an incident
 *   derive        what follows from the readings and the protocol: the latest
 *                 value of each vital, the suggested colour, the next check
 */
const { patch } = require('../db/patch');
const { newId } = require('../db/schema');
const MedicalVisit = require('../models/MedicalVisit');
const MedicalIncident = require('../models/MedicalIncident');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const protocols = require('./medicalProtocols');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, toInstant, isUuid } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';

const NUMBERS = ['temperature', 'pulse', 'spo2', 'bpSystolic', 'bpDiastolic', 'respRate', 'painScore', 'glucose', 'weightKg'];
const AVPU = { A: 'Alert', V: 'Responds to voice', P: 'Responds to pain', U: 'Unresponsive' };
const PUPILS = { equal: 'Equal and reacting', unequal: 'Unequal', sluggish: 'Slow to react' };

const REGIONS = {
    head: 'Head', face: 'Face', neck: 'Neck', chest: 'Chest', abdomen: 'Abdomen', groin: 'Groin',
    upper_back: 'Upper back', lower_back: 'Lower back', buttocks: 'Buttocks',
    shoulder_l: 'Left shoulder', shoulder_r: 'Right shoulder', upper_arm_l: 'Left upper arm', upper_arm_r: 'Right upper arm',
    elbow_l: 'Left elbow', elbow_r: 'Right elbow', forearm_l: 'Left forearm', forearm_r: 'Right forearm',
    wrist_l: 'Left wrist', wrist_r: 'Right wrist', hand_l: 'Left hand', hand_r: 'Right hand',
    hip_l: 'Left hip', hip_r: 'Right hip', thigh_l: 'Left thigh', thigh_r: 'Right thigh', knee_l: 'Left knee', knee_r: 'Right knee',
    lower_leg_l: 'Left lower leg', lower_leg_r: 'Right lower leg', ankle_l: 'Left ankle', ankle_r: 'Right ankle',
    foot_l: 'Left foot', foot_r: 'Right foot',
};
const INJURY_KIND = {
    cut: 'Cut', graze: 'Graze', bruise: 'Bruise', swelling: 'Swelling', burn: 'Burn', bite: 'Bite', sting: 'Sting',
    rash: 'Rash', pain: 'Pain', deformity: 'Deformity', other: 'Other',
};

/** A reading from a form, checked; null when nothing was measured. */
function readingOf(raw, unit = 'F') {
    if (!raw || typeof raw !== 'object') return null;
    const r = { tempUnit: raw.tempUnit === 'C' || raw.tempUnit === 'F' ? raw.tempUnit : unit };
    for (const k of NUMBERS) r[k] = num(raw[k]);
    r.avpu = oneOf(raw.avpu, AVPU, null);
    r.pupils = oneOf(raw.pupils, PUPILS, null);
    r.note = str(raw.note, 300);
    if (!NUMBERS.some((k) => r[k] !== null) && !r.avpu && !r.pupils) return null;
    const range = (k, lo, hi, label) => { if (r[k] !== null && (r[k] < lo || r[k] > hi)) refuse(`${label} of ${r[k]} looks wrong — check the reading`); };
    if (r.tempUnit === 'C') range('temperature', 30, 45, 'A temperature'); else range('temperature', 86, 113, 'A temperature');
    range('bpSystolic', 50, 250, 'A systolic pressure'); range('bpDiastolic', 30, 160, 'A diastolic pressure');
    range('pulse', 30, 250, 'A pulse'); range('spo2', 50, 100, 'An SpO2'); range('weightKg', 5, 250, 'A weight');
    range('respRate', 4, 80, 'A breathing rate'); range('glucose', 20, 600, 'A blood sugar');
    if (r.painScore !== null && (!Number.isInteger(r.painScore) || r.painScore < 0 || r.painScore > 10)) refuse('Pain is a whole number from 0 to 10');
    r.at = toInstant(raw.takenAt || raw.at) || new Date();
    if (r.at > new Date(Date.now() + 5 * 60000)) refuse('The reading time is in the future');
    return r;
}

/**
 * Whether a reading only repeats the latest values — a treatment form sent
 * back with the readings it was opened with. Only what the form measured is
 * compared: a form without a breathing-rate box is not a new reading because
 * the latest one had a breathing rate.
 */
function sameAs(r, vitals = {}) {
    if (!vitals) return false;
    const keys = [...NUMBERS, 'avpu', 'pupils'].filter((k) => r[k] !== null && r[k] !== undefined);
    if (!keys.length) return true;
    return keys.every((k) => r[k] === (vitals[k] ?? null))
        && (r.temperature == null || (r.tempUnit || 'F') === (vitals.tempUnit || 'F'));
}

const live = (readings = []) => readings.filter((x) => !x.struck);

/** The latest value of each vital across the readings that stand. */
function snapshotOf(readings = []) {
    const out = { tempUnit: 'F', takenAt: null };
    for (const r of [...live(readings)].sort((a, b) => new Date(a.at) - new Date(b.at))) {
        for (const k of [...NUMBERS, 'avpu', 'pupils']) if (r[k] !== null && r[k] !== undefined) out[k] = r[k];
        if (r.temperature != null) out.tempUnit = r.tempUnit || 'F';
        out.takenAt = r.at;
    }
    for (const k of [...NUMBERS, 'avpu', 'pupils']) if (out[k] === undefined) out[k] = null;
    return out;
}

/** What follows from a visit's readings and protocol. */
function derive(visit, readings = visit.readings || [], protocol = visit.protocol) {
    const standing = live(readings).sort((a, b) => new Date(a.at) - new Date(b.at));
    const latest = standing[standing.length - 1] || null;
    const s = protocols.suggestTriage({ protocol, reading: latest });
    // Being treated as an emergency is the top colour, whatever the readings say.
    if (visit.status === 'emergency') { s.level = protocols.higher(s.level, 'red'); s.reasons = ['Treated as an emergency', ...s.reasons]; }
    const t = visit.triage || {};
    // The nurse's colour stands once set; until then the suggestion is the colour.
    const level = t.setBy ? t.level : s.level;
    const triage = { ...t, level, suggested: s.level, reasons: s.reasons };
    let nextCheckAt = null;
    if (R.IN_ROOM.includes(visit.status)) {
        const m = protocols.recheckMinutes({ level, protocol, arrivedAt: visit.arrivedAt });
        if (m) nextCheckAt = new Date(new Date(latest?.at || visit.arrivedAt).getTime() + m * 60000);
    }
    return { vitals: snapshotOf(readings), triage, nextCheckAt };
}

async function findVisit(req, id) {
    if (!isUuid(id)) notFound('Visit');
    const v = await MedicalVisit.findOne({ _id: id, school: req.schoolId }).lean();
    if (!v) notFound('Visit');
    return v;
}
const writable = (v) => {
    if (v.archivedAt) refuse('This visit is archived');
    if (v.status === 'closed') refuse('This visit is closed — reopen it to change it');
};

/** The reading as stored: who took it and what it says. */
async function stamp(req, visit, r) {
    const card = await access.studentCard(req.schoolId, visit.student);
    return { _id: newId(), ...r, by: S(req.userId), byName: who(req), flags: R.vitalFlags(r, { age: R.ageYears(card?.dob) }) };
}

/** Push a reading (atomic), then work out what follows from the list as it now is. */
async function pushReading(req, visit, reading, q = null) {
    const pushed = await patch(MedicalVisit, visit._id, {}, { push: { readings: reading }, where: { school: req.schoolId }, q });
    return patch(MedicalVisit, visit._id, derive(pushed), { where: { school: req.schoolId }, q, touch: false });
}

async function addReading(req, id, body = {}) {
    const visit = await findVisit(req, id);
    writable(visit);
    const settings = await settingsSvc.get(req.schoolId);
    const r = readingOf(body, settings.temperatureUnit);
    if (!r) refuse('Enter at least one reading');
    const reading = await stamp(req, visit, r);
    const row = await pushReading(req, visit, reading);
    const critical = reading.flags.filter((f) => f.level === 'critical');
    audit.log(req, {
        action: 'reading_added', entity: 'visit', entityId: id, student: visit.student,
        summary: `${visit.number}: readings${reading.flags.length ? ` — ${reading.flags.map((f) => f.label).join(', ')}` : ''}`,
    });
    if (critical.length && !['emergency', 'referred'].includes(visit.status)) {
        const card = await access.studentCard(req.schoolId, visit.student);
        tell.toStaff(req, {
            title: `${critical.map((f) => f.label).join(', ')} — ${card?.name || 'a student'}`,
            body: `${visit.number}: a reading needs attention now (${critical.map((f) => f.label).join(', ')}).`,
            link: { type: 'medical.room' }, urgent: true,
        });
    }
    return { visit: row, reading, suggestEmergency: !!critical.length && R.IN_ROOM.includes(visit.status) && visit.status !== 'emergency' };
}

async function strikeReading(req, id, readingId, body = {}) {
    const visit = await findVisit(req, id);
    writable(visit);
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the reading is struck out');
    const readings = visit.readings || [];
    const at = readings.findIndex((x) => S(x._id) === S(readingId));
    if (at < 0) notFound('Reading');
    if (readings[at].struck) refuse('This reading is already struck out');
    const next = readings.map((x, i) => (i === at ? { ...x, struck: { at: new Date(), by: S(req.userId), byName: who(req), reason } } : x));
    // Compare-and-set on the length: a reading added a moment ago is not lost.
    const { rows } = await require('../db/pool').query(
        `UPDATE "medicalvisits" SET "readings" = $1::jsonb, "updatedAt" = now() WHERE "_id" = $2 AND "school" = $3 AND jsonb_array_length("readings") = $4 RETURNING "_id"`,
        [JSON.stringify(next), S(id), S(req.schoolId), readings.length],
    );
    if (!rows.length) refuse('Another reading was added a moment ago — reload and try again', 409, 'MEDICAL_STALE');
    const row = await patch(MedicalVisit, id, derive({ ...visit, readings: next }), { where: { school: req.schoolId }, touch: false });
    audit.log(req, { action: 'reading_struck', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: a reading from ${R.instantLabel(readings[at].at)} struck out — ${reason}` });
    return row;
}

async function setTriage(req, id, body = {}) {
    const visit = await findVisit(req, id);
    writable(visit);
    const auto = body.level === 'auto';
    const level = auto ? null : oneOf(body.level, protocols.TRIAGE, null);
    if (!auto && !level) refuse('Choose a colour');
    const note = str(body.note, 300);
    const t = { ...(visit.triage || {}), setBy: auto ? null : S(req.userId), setByName: auto ? '' : who(req), setAt: auto ? null : new Date(), note: auto ? '' : note, level: level || visit.triage?.level };
    const row = await patch(MedicalVisit, id, derive({ ...visit, triage: t }), { where: { school: req.schoolId } });
    audit.log(req, { action: 'triage_set', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: triage ${auto ? `back to the suggestion (${protocols.TRIAGE[row.triage.level].label})` : protocols.TRIAGE[level].label}${note ? ` — ${note}` : ''}` });
    return { visit: row, suggestEmergency: row.triage.level === 'red' && R.IN_ROOM.includes(visit.status) && visit.status !== 'emergency' };
}

async function setProtocol(req, id, body = {}) {
    const visit = await findVisit(req, id);
    writable(visit);
    if (body.key === null || body.key === '') {
        const row = await patch(MedicalVisit, id, { protocol: null, ...derive({ ...visit, protocol: null }, visit.readings, null) }, { where: { school: req.schoolId } });
        audit.log(req, { action: 'protocol_cleared', entity: 'visit', entityId: id, student: visit.student, summary: `${visit.number}: protocol cleared` });
        return { visit: row };
    }
    const p = protocols.BY_KEY[body.key];
    if (!p) refuse('Choose a protocol from the list');
    const same = visit.protocol?.key === p.key;
    const redFlags = Array.isArray(body.redFlags) ? [...new Set(body.redFlags.map(String))].filter((k) => p.redFlags.some((f) => f.key === k)) : (same ? visit.protocol.redFlags || [] : []);
    const stepsDone = Array.isArray(body.stepsDone) ? [...new Set(body.stepsDone.map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < p.steps.length) : (same ? visit.protocol.stepsDone || [] : []);
    const protocol = { key: p.key, redFlags, stepsDone, at: same ? visit.protocol.at : new Date(), by: same ? visit.protocol.by : S(req.userId), byName: same ? visit.protocol.byName : who(req) };
    const row = await patch(MedicalVisit, id, { protocol, ...derive({ ...visit, protocol }, visit.readings, protocol) }, { where: { school: req.schoolId } });
    const before = new Set(same ? visit.protocol.redFlags || [] : []);
    const added = redFlags.filter((k) => !before.has(k)).map((k) => p.redFlags.find((f) => f.key === k));
    audit.log(req, {
        action: same ? 'protocol_updated' : 'protocol_started', entity: 'visit', entityId: id, student: visit.student,
        summary: `${visit.number}: ${p.title}${added.length ? ` — red flag${added.length > 1 ? 's' : ''}: ${added.map((f) => f.label).join('; ')}` : ''}`,
    });
    const urgentFlags = added.filter((f) => f.level === 'red');
    if (urgentFlags.length) {
        const card = await access.studentCard(req.schoolId, visit.student);
        tell.toStaff(req, {
            title: `Red flag — ${card?.name || 'a student'}`,
            body: `${visit.number} (${p.title}): ${urgentFlags.map((f) => f.label).join('; ')}. The protocol says: call an ambulance.`,
            link: { type: 'medical.room' }, urgent: true,
        });
    }
    return { visit: row, suggestEmergency: urgentFlags.length > 0 && R.IN_ROOM.includes(visit.status) && visit.status !== 'emergency' };
}

/** The body map, checked: [{ id, view, region, kind, note }]. */
function injuriesOf(list) {
    if (!Array.isArray(list)) refuse('The body map must be a list');
    if (list.length > 40) refuse('At most 40 marks on the body map');
    return list.map((x) => {
        const region = oneOf(x?.region, REGIONS, null);
        if (!region) refuse('Mark a part of the body from the map');
        return {
            id: isUuid(x.id) ? S(x.id) : newId(), view: x.view === 'back' ? 'back' : 'front', region,
            kind: oneOf(x.kind, INJURY_KIND, 'other'), note: str(x.note, 200),
        };
    });
}

async function setInjuries(req, kind, id, body = {}) {
    const injuries = injuriesOf(body.injuries);
    const Model = kind === 'incident' ? MedicalIncident : MedicalVisit;
    if (!isUuid(id)) notFound(kind === 'incident' ? 'Incident' : 'Visit');
    const row0 = await Model.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row0) notFound(kind === 'incident' ? 'Incident' : 'Visit');
    if (row0.archivedAt) refuse('This record is archived');
    const row = await patch(Model, id, { injuries }, { where: { school: req.schoolId } });
    const line = injuries.map((x) => `${INJURY_KIND[x.kind]} — ${REGIONS[x.region]}${x.view === 'back' ? ' (back)' : ''}`).join('; ');
    audit.log(req, { action: 'body_map', entity: kind, entityId: id, student: row0.student, summary: `${row0.number}: body map — ${line || 'cleared'}` });
    return row;
}

const library = () => ({ triage: protocols.TRIAGE, protocols: protocols.describe(), regions: REGIONS, injuryKinds: INJURY_KIND, avpu: AVPU, pupils: PUPILS });

module.exports = {
    NUMBERS, AVPU, PUPILS, REGIONS, INJURY_KIND,
    readingOf, sameAs, snapshotOf, derive, stamp, pushReading, addReading, strikeReading, setTriage, setProtocol, setInjuries, injuriesOf, library,
};
