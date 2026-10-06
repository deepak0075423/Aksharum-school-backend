'use strict';
/**
 * The hostel's nights and the Medical Room (Oct 2026). A resident unwell in
 * the hostel is recorded by the warden as a hostel incident of the kind
 * "medical emergency" (controllers/hostel.controller createIncident); the
 * Medical Room used to know nothing of it. Now it becomes a request for the
 * room — "unwell in the hostel", the time, what the warden gave — so the nurse
 * sees the child in the morning (at once, when it is serious), and it joins
 * the child's medical history.
 *
 * Nothing new is opened when the child is already on the room's list or in
 * the room. Class teachers are not told: nobody has been "sent" anywhere.
 * A school with a night nurse records the visit itself at the hostel's sick
 * bay (a place of kind 'hostel' — services/medicalPlaces).
 */
const pool = require('../db/pool');
const MedicalRequest = require('../models/MedicalRequest');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const numbers = require('./medicalNumber');
const R = require('./medicalRules');

const S = (v) => String(v);
const { str } = R;
const URGENCY = { critical: 'emergency', high: 'high', medium: 'normal', low: 'normal' };
const firstSentence = (t) => String(t || '').split(/(?<=[.!?])\s/)[0];

async function fromHostelIncident(req, inc) {
    if (!inc?.student) return null;
    const { rows: [school] } = await pool.query(`SELECT ("modules"->>'medical')::boolean AS on FROM "schools" WHERE "_id" = $1`, [S(req.schoolId)]);
    if (!school?.on) return null;
    const card = await access.studentCard(req.schoolId, inc.student);
    if (!card || card.isActive === false) return null;
    const { openRequestOf, openVisitOf } = require('./medicalCase');
    if (await openRequestOf(req.schoolId, card._id) || await openVisitOf(req.schoolId, card._id)) return null;
    const [hostel] = (await pool.query(`SELECT "name" FROM "hostels" WHERE "_id" = $1`, [S(inc.hostel)])).rows;
    const [room] = inc.room ? (await pool.query(`SELECT "roomNumber" FROM "hostelrooms" WHERE "_id" = $1`, [S(inc.room)]).catch(() => ({ rows: [] }))).rows : [];
    const urgency = URGENCY[inc.severity] || 'normal';
    const when = `${R.instantDayLabel(inc.date || new Date())}${inc.time ? ` at ${inc.time}` : ''}`;
    const reason = str(inc.title || firstSentence(inc.description) || 'Unwell in the hostel', 200);
    const number = await numbers.next(req.schoolId, 'request');
    const by = req.user?.name || 'The warden';
    const row = await MedicalRequest.create({
        school: req.schoolId, number, student: card._id,
        requestedBy: req.userId, requestedByName: by, requestedByRole: 'warden',
        reason, symptoms: str(inc.description, 600),
        location: `${hostel?.name || 'Hostel'}${room?.roomNumber ? `, room ${room.roomNumber}` : ''}`,
        urgency,
        remarks: str([`Unwell in the hostel ${when} (${inc.incidentNumber})`, inc.treatmentGiven ? `Given: ${inc.treatmentGiven}` : '', inc.hospitalName ? `Hospital: ${inc.hospitalName}` : ''].filter(Boolean).join(' · '), 600),
        status: 'requested', history: [{ status: 'requested', at: new Date(), by: req.userId, byName: by, note: 'From the hostel' }],
        source: 'hostel', hostelIncident: inc._id,
    });
    const plain = row.toObject ? row.toObject() : row;
    audit.log(req, { action: 'created', entity: 'request', entityId: plain._id, student: card._id, summary: `${number}: unwell in the hostel (${inc.incidentNumber}) — ${reason}` });
    require('./medicalLive').changed(req, 'request', { id: S(plain._id), urgent: urgency === 'emergency' });
    tell.toStaff(req, {
        title: `${urgency === 'emergency' ? 'EMERGENCY · ' : ''}Unwell in the hostel — ${card.name}`,
        body: `${by} reported ${when} in ${hostel?.name || 'the hostel'}: ${reason}.${inc.treatmentGiven ? ` Given: ${inc.treatmentGiven}.` : ''}${inc.hospitalName ? ` Taken to ${inc.hospitalName}.` : ''} ${urgency === 'emergency' ? 'See them now.' : `See ${card.name.split(' ')[0]} when the room opens.`}`,
        setting: 'staffRequests', link: { type: 'medical.desk', entityId: S(plain._id) }, urgent: urgency !== 'normal', email: urgency === 'emergency',
    });
    return plain;
}

module.exports = { fromHostelIncident };
