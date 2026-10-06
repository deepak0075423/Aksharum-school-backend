'use strict';
/**
 * Finding a student by their ID card, and the walk-in kiosk (Oct 2026).
 *
 *   resolve   what a scanner (or a typed number) gives the desk: the QR's
 *             verify address, the card's code or number, or an admission
 *             number → the student. Identity only — the record is opened
 *             (and recorded) by the screen that asks for it. A staff card is
 *             refused here: staff health has its own page.
 *   walkIn    a tablet at the Medical Room's door, signed in as the room, in
 *             kiosk mode: the student scans their card (or types their
 *             admission number), sees their own name and photo — nothing
 *             medical — picks why they came, and the room's desk gets a
 *             request "at the door". Their class teachers hear they went.
 */
const pool = require('../db/pool');
const MedicalRequest = require('../models/MedicalRequest');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const numbers = require('./medicalNumber');
const R = require('./medicalRules');

const { refuse, str } = R;
const S = (v) => String(v);
const CARD_STATE = { active: '', blocked: 'This card is blocked', lost: 'This card was reported lost', damaged: 'This card was reported damaged', reissued: 'This card was replaced by a newer one', cancelled: 'This card was cancelled' };

async function resolve(req, q) {
    const raw = str(q, 300);
    if (!raw) refuse('Scan a card, or type its number or an admission number');
    const fromUrl = raw.match(/\/verify\/id\/([A-Za-z0-9]{6,20})/);
    const token = (fromUrl ? fromUrl[1] : raw).toUpperCase().replace(/\s+/g, '');
    const { rows: [card] } = await pool.query(
        `SELECT "holder"::text AS holder, "kind", "status", "number" FROM "idcards" WHERE "school" = $1 AND ("code" = $2 OR upper("number") = $2) ORDER BY "issuedAt" DESC LIMIT 1`,
        [S(req.schoolId), token]);
    let studentId = null;
    if (card) {
        if (card.kind !== 'student') refuse('That is a staff or parent card — the Medical Room looks up students here', 409, 'MEDICAL_NOT_STUDENT_CARD');
        studentId = card.holder;
    } else if (!fromUrl) {
        const { rows: [p] } = await pool.query(`SELECT "user"::text AS id FROM "studentprofiles" WHERE "school" = $1 AND upper("admissionNumber") = upper($2) LIMIT 1`, [S(req.schoolId), raw]);
        studentId = p?.id || null;
    }
    if (!studentId) refuse(fromUrl ? 'That QR code is not a card of this school' : 'No student has that card or admission number', 404, 'MEDICAL_NOT_FOUND');
    const s = await access.studentCard(req.schoolId, studentId);
    if (!s) refuse('Student not found', 404, 'MEDICAL_NOT_FOUND');
    return {
        student: { _id: s._id, name: s.name, photo: s.photo, classLabel: s.classLabel, admissionNumber: s.admissionNumber, isActive: s.isActive !== false },
        via: card ? 'card' : 'admission', cardNumber: card?.number || '', cardWarning: card ? CARD_STATE[card.status] || '' : '',
    };
}

const REASONS = ['Fever', 'Headache', 'Stomach ache', 'Feeling sick', 'Injury', 'Cough & cold', 'Toothache', 'Feeling dizzy', 'Something else'];

async function walkIn(req, body = {}) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    let reason = str(body.reason, 120);
    if (!reason) refuse('Choose why you came');
    if (reason === 'Something else') {
        reason = str(body.symptoms, 120);
        if (reason.length < 3) refuse('Say what is wrong');
    }
    const { openRequestOf, openVisitOf } = require('./medicalCase');
    if (await openVisitOf(req.schoolId, student._id) || await openRequestOf(req.schoolId, student._id)) {
        return { already: true, message: 'The nurse already knows you are here — please wait' };
    }
    const number = await numbers.next(req.schoolId, 'request');
    const urgency = body.urgent ? 'high' : 'normal';
    const row = await MedicalRequest.create({
        school: req.schoolId, number, student: student._id,
        requestedBy: req.userId, requestedByName: 'Walk-in (kiosk)', requestedByRole: 'kiosk',
        reason, symptoms: str(body.symptoms, 300), location: 'At the Medical Room door', urgency,
        status: 'requested', history: [{ status: 'requested', at: new Date(), by: req.userId, byName: 'Walk-in (kiosk)', note: 'Checked in at the kiosk' }],
        source: 'kiosk',
    });
    const plain = row.toObject ? row.toObject() : row;
    audit.log(req, { action: 'created', entity: 'request', entityId: plain._id, student: student._id, summary: `${number}: ${student.name} checked in at the kiosk — ${reason}` });
    // The desk's screens reload (and sound for an urgent one) — the kiosk's own login included.
    require('./medicalLive').changed(req, 'request', { id: S(plain._id), urgent: urgency === 'high' });
    // …and the medical staff are told wherever they are. Sent as the school, not as the kiosk's
    // login: that login is often the nurse's own, and a sender never hears their own notice.
    tell.system(req.schoolId, {
        to: await tell.staffIds(req.schoolId), setting: 'staffRequests', priority: urgency === 'high' ? 'high' : null,
        link: { type: 'medical.desk', entityId: S(plain._id) },
        title: `${urgency === 'high' ? 'URGENT · ' : ''}${student.name} is at the Medical Room door`,
        body: `${student.name}${student.classLabel ? ` (${student.classLabel})` : ''} checked in at the kiosk — ${reason}${plain.symptoms ? `. ${plain.symptoms}` : ''}.`,
    });
    tell.toTeachers(req, {
        studentId: student._id, requesterId: null, setting: 'teacherClassAlert', requestId: plain._id,
        title: `${student.name} went to the Medical Room`,
        body: `${student.name} checked in at the Medical Room (${reason}).`,
    });
    return { already: false, number, name: student.name };
}

module.exports = { resolve, walkIn, REASONS };
