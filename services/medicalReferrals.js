'use strict';
/**
 * Referrals to a specialist, followed to the end (Oct 2026). A screening that
 * finds something (a checkup saved as "Referred") raises one by itself; the
 * medical staff raise others from a visit, a growth chart or by hand.
 *
 * The family is told at once and can answer from their page: "we have an
 * appointment", "we saw the doctor — this is what they said" (with the
 * report), or "we will not go". The sweep reminds them once when the
 * referral falls due and once a fortnight later. The medical staff read what
 * came back and close it.
 *
 * Families see their own child's referrals; teachers never do.
 */
const pool = require('../db/pool');
const MedicalReferral = require('../models/MedicalReferral');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const numbers = require('./medicalNumber');
const { patch } = require('../db/patch');
const R = require('./medicalRules');

const { refuse, str, isUuid, todayStr, dayStr, dayLabel, toDay, addDays, bool } = R;
const S = (v) => String(v);

const SPECIALTY = {
    eye: 'Eye specialist', ent: 'Ear, nose & throat', dental: 'Dentist', paediatric: 'Paediatrician', nutrition: 'Nutrition / dietitian',
    skin: 'Skin specialist', mental_health: 'Counsellor / mental health', orthopaedic: 'Bone & joint specialist', other: 'Other specialist',
};
// Who, in a sentence: "please see an eye specialist".
const WHOM = {
    eye: 'an eye specialist', ent: 'an ear, nose and throat (ENT) specialist', dental: 'a dentist', paediatric: 'a paediatrician',
    nutrition: 'a dietitian', skin: 'a skin specialist', mental_health: 'a counsellor', orthopaedic: 'a bone and joint specialist', other: 'a specialist',
};
const URGENCY = {
    routine: { label: 'Routine', days: 30, tone: 'slate' },
    soon:    { label: 'Soon',    days: 14, tone: 'amber' },
    urgent:  { label: 'Urgent',  days: 3,  tone: 'red' },
};
const STATUS = {
    waiting:   { label: 'Waiting for the family', tone: 'amber' },
    booked:    { label: 'Appointment booked',     tone: 'sky' },
    seen:      { label: 'Seen — to review',       tone: 'indigo' },
    closed:    { label: 'Closed',                 tone: 'green' },
    declined:  { label: 'Family declined',        tone: 'slate' },
    cancelled: { label: 'Cancelled',              tone: 'slate' },
};
const OPEN = ['waiting', 'booked'];
// A screening's type → who the child is sent to.
const FROM_CHECKUP = { vision: 'eye', hearing: 'ent', dental: 'dental', bmi: 'nutrition', weight: 'nutrition', height: 'paediatric', bp: 'paediatric', general: 'paediatric', physical: 'paediatric' };

function decorate(r, today = todayStr()) {
    const overdue = OPEN.includes(r.status) && r.dueBy && dayStr(r.dueBy) < today;
    return {
        ...r,
        specialtyLabel: SPECIALTY[r.specialty] || r.specialty,
        urgencyLabel: URGENCY[r.urgency]?.label || r.urgency, urgencyTone: URGENCY[r.urgency]?.tone || 'slate',
        statusLabel: overdue ? 'Overdue' : STATUS[r.status]?.label || r.status,
        tone: overdue ? 'red' : STATUS[r.status]?.tone || 'slate',
        overdue: !!overdue,
    };
}

async function find(req, id) {
    if (!isUuid(id)) refuse('Referral not found', 404, 'MEDICAL_NOT_FOUND');
    const { rows } = await pool.query(`SELECT * FROM "medicalreferrals" WHERE "_id" = $1 AND "school" = $2`, [id, S(req.schoolId)]);
    if (!rows[0]) refuse('Referral not found', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

/** A family member may act on their own child's referral only. */
async function findForFamily(req, id) {
    const r = await find(req, id);
    if (req.userRole !== 'parent') refuse('Only a parent can answer a referral', 403, 'MEDICAL_PARENT_ONLY');
    await access.familyChild(req, S(r.student));
    return r;
}

/**
 * Raise a referral. body: { student, specialty, reason, findings, urgency, dueBy, source: { kind, id, label } }
 * `opts.quiet` skips telling the family (a caller that tells them itself).
 */
async function create(req, body = {}, opts = {}) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const specialty = Object.prototype.hasOwnProperty.call(SPECIALTY, body.specialty) ? body.specialty : null;
    if (!specialty) refuse('Choose who the student is referred to');
    const reason = str(body.reason, 600);
    if (reason.length < 5) refuse('Say why — in words the family will understand');
    const urgency = URGENCY[body.urgency] ? body.urgency : 'routine';
    const dueBy = body.dueBy ? toDay(body.dueBy) : toDay(addDays(todayStr(), URGENCY[urgency].days));
    if (!dueBy) refuse('The date to be seen by is not a date');
    const source = {
        kind: ['checkup', 'visit', 'incident', 'growth', 'campaign', 'manual'].includes(body.source?.kind) ? body.source.kind : 'manual',
        id: isUuid(body.source?.id) ? S(body.source.id) : '',
        label: str(body.source?.label, 120),
    };
    if (source.id) {
        const { rows } = await pool.query(
            `SELECT "_id" FROM "medicalreferrals" WHERE "school" = $1 AND "student" = $2 AND "source"->>'kind' = $3 AND "source"->>'id' = $4 AND "status" <> 'cancelled' LIMIT 1`,
            [S(req.schoolId), S(student._id), source.kind, source.id]);
        if (rows[0]) return decorate((await find(req, rows[0]._id)));
    }
    const number = await numbers.next(req.schoolId, 'referral');
    const row = await MedicalReferral.create({
        school: req.schoolId, student: student._id, number, specialty, reason, findings: str(body.findings, 2000), urgency, dueBy, source,
        status: 'waiting', familyToldAt: opts.quiet ? null : new Date(), createdBy: req.userId, createdByName: req.user?.name || '',
    });
    const plain = row.toObject ? row.toObject() : row;
    audit.log(req, { action: 'referred', entity: 'referral', entityId: plain._id, student: student._id, summary: `${student.name} referred to ${SPECIALTY[specialty].toLowerCase()} (${number})` });
    if (!opts.quiet) {
        tell.toParents(req, student._id, {
            setting: 'parentReferral', urgent: urgency === 'urgent', tab: 'checkups',
            title: `Please see ${WHOM[specialty]} — ${student.name}`,
            body: `The school's Medical Room suggests ${student.name} sees ${WHOM[specialty]}${urgency === 'urgent' ? ' as soon as possible' : ` by ${dayLabel(dueBy)}`}: ${reason} Please tell the school what the doctor says — you can do it from the Medical Room page.`,
            i18n: { key: 'referral', vars: { name: student.name, specialty, urgent: urgency === 'urgent', due: dayLabel(dueBy), reason } },
        });
    }
    return decorate(plain);
}

/** A checkup saved as "Referred" refers the child (once). */
async function fromCheckup(req, checkup, student) {
    if (checkup.outcome !== 'referred') return null;
    try {
        const res = checkup.results || {};
        const findings = [
            res.visionLeft || res.visionRight ? `Vision L ${res.visionLeft || '—'} R ${res.visionRight || '—'}` : '',
            res.hearingLeft || res.hearingRight ? `Hearing L ${res.hearingLeft || '—'} R ${res.hearingRight || '—'}` : '',
            res.dental ? `Dental: ${res.dental}` : '',
            res.bpSystolic ? `BP ${res.bpSystolic}/${res.bpDiastolic || '—'}` : '',
            res.heightCm ? `Height ${res.heightCm} cm` : '', res.weightKg ? `Weight ${res.weightKg} kg` : '',
            checkup.findings, checkup.observations,
        ].filter(Boolean).join(' · ');
        return await create(req, {
            student: student?._id || checkup.student,
            specialty: FROM_CHECKUP[checkup.type] || 'paediatric',
            reason: str(checkup.recommendations || checkup.findings || `The ${R.CHECKUP_TYPE[checkup.type]?.toLowerCase() || 'health'} check found something a specialist should look at.`, 600),
            findings,
            urgency: 'routine',
            dueBy: checkup.followUp?.on || null,
            source: { kind: 'checkup', id: checkup._id, label: `${R.CHECKUP_TYPE[checkup.type] || 'Health'} checkup, ${dayLabel(checkup.checkedOn)}` },
        });
    } catch (e) {
        console.error('[medical] referral from checkup failed:', e.message);
        return null;
    }
}

/** The staff record what the specialist said, close, cancel or remind. */
async function act(req, id, body = {}) {
    const r = await find(req, id);
    const action = body.action;
    const name = req.user?.name || '';
    let set = null; let summary = '';
    if (action === 'outcome') {
        if (['closed', 'cancelled'].includes(r.status)) refuse('This referral is finished');
        const outcome = outcomeOf(body, req);
        set = { status: bool(body.close) ? 'closed' : 'seen', outcome, ...(bool(body.close) ? { closedAt: new Date(), closedBy: req.userId, closedByName: name, closeNote: str(body.closeNote, 600) } : {}) };
        summary = `What the specialist said was recorded for ${r.number}`;
    } else if (action === 'close') {
        if (!['seen', 'waiting', 'booked', 'declined'].includes(r.status)) refuse('This referral is already finished');
        const note = str(body.note, 600);
        if (r.status !== 'seen' && note.length < 3) refuse('Say why it is closed without the specialist\'s answer');
        set = { status: 'closed', closedAt: new Date(), closedBy: req.userId, closedByName: name, closeNote: note };
        summary = `${r.number} closed`;
    } else if (action === 'cancel') {
        if (!OPEN.includes(r.status)) refuse('Only an open referral can be cancelled');
        const why = str(body.reason, 300);
        if (why.length < 3) refuse('Say why it is cancelled');
        set = { status: 'cancelled', cancelReason: why, closedAt: new Date(), closedBy: req.userId, closedByName: name };
        summary = `${r.number} cancelled — ${why}`;
    } else if (action === 'reopen') {
        if (!['closed', 'declined', 'seen'].includes(r.status)) refuse('Only a finished referral can be reopened');
        set = { status: 'waiting', closedAt: null, closedBy: null, closedByName: '', closeNote: '' };
        summary = `${r.number} reopened`;
    } else if (action === 'remind') {
        if (!OPEN.includes(r.status)) refuse('Only an open referral can be reminded');
        await remind(req.schoolId, r, 'manual', req.userId);
        return decorate(await find(req, id));
    } else refuse('Unknown action');
    const row = await patch(MedicalReferral, id, set, { where: { school: req.schoolId, status: r.status } });
    if (!row) refuse('Someone else changed this referral — open it again', 409, 'MEDICAL_STALE');
    audit.log(req, { action: `referral_${action}`, entity: 'referral', entityId: id, student: r.student, summary });
    return decorate(row);
}

function outcomeOf(body, req) {
    const seenOn = body.seenOn ? toDay(body.seenOn) : null;
    if (body.seenOn && !seenOn) refuse('The date seen is not a date');
    if (seenOn && dayStr(seenOn) > todayStr()) refuse('The date seen is in the future');
    const diagnosis = str(body.diagnosis, 600); const advice = str(body.advice, 1500);
    if (!diagnosis && !advice) refuse('Write what the specialist found or advised');
    return {
        seenOn: seenOn ? dayStr(seenOn) : todayStr(), seenBy: str(body.seenBy, 160), diagnosis, advice,
        glasses: body.glasses === undefined ? null : bool(body.glasses),
        reportedBy: S(req.userId), reportedByName: req.user?.name || '', reportedByRole: req.userRole, reportedAt: new Date(),
    };
}

/** The family answers. body: { action: 'booked'|'seen'|'declined', … } (+ a report file for 'seen'). */
async function familyAnswer(req, id, body = {}, file = null) {
    const r = await findForFamily(req, id);
    if (!OPEN.includes(r.status) && !(r.status === 'seen' && body.action === 'seen')) refuse('This referral is no longer open');
    const card = await access.studentCard(req.schoolId, r.student);
    const who = req.user?.name || 'A parent';
    let set; let staffText;
    if (body.action === 'booked') {
        const on = toDay(body.appointmentOn);
        if (!on) refuse('Choose the date of the appointment');
        if (dayStr(on) < addDays(todayStr(), -1)) refuse('That date has passed — tell the school what the doctor said instead');
        set = { status: 'booked', appointmentOn: on, appointmentWith: str(body.appointmentWith, 160) };
        staffText = `${who} booked an appointment for ${card?.name || 'the student'} on ${dayLabel(on)} (${r.number}).`;
    } else if (body.action === 'seen') {
        set = { status: 'seen', outcome: outcomeOf(body, req) };
        if (file) {
            const doc = await require('./medicalHealth').addDocument(req, S(r.student), {
                type: 'doctor_report', title: `${SPECIALTY[r.specialty]} — ${card?.name || ''}`.trim(), visibility: 'family', linkKind: '', linkId: null,
            }, file, { status: 'pending', source: 'parent' });
            set.document = doc._id;
        }
        staffText = `${who} sent what the doctor (${SPECIALTY[r.specialty].toLowerCase()}) said about ${card?.name || 'the student'} (${r.number}). Read it and close the referral.`;
    } else if (body.action === 'declined') {
        const why = str(body.reason, 600);
        if (why.length < 3) refuse('Please say why');
        set = { status: 'declined', declinedReason: why };
        staffText = `${who} will not take ${card?.name || 'the student'} to ${WHOM[r.specialty]} (${r.number}): ${why}`;
    } else refuse('Unknown answer');
    const row = await patch(MedicalReferral, id, set, { where: { school: req.schoolId, status: r.status } });
    if (!row) refuse('This referral changed — open it again', 409, 'MEDICAL_STALE');
    audit.log(req, { action: `referral_family_${body.action}`, entity: 'referral', entityId: id, student: r.student, summary: staffText });
    tell.toStaff(req, { title: `Referral ${r.number} — ${card?.name || 'a student'}`, body: staffText, setting: 'staffFollowUp', link: { type: 'medical.referrals' } });
    return decorate(row);
}

async function remind(schoolId, r, kind, by = null) {
    const card = await access.studentCard(schoolId, r.student);
    const name = card?.name || 'your child';
    const parents = await tell.parentIds(r.student);
    tell.system(schoolId, {
        to: parents, setting: 'parentReferral',
        link: { type: 'medical.child', params: { child: S(r.student), tab: 'checkups' } },
        title: `Reminder: ${WHOM[r.specialty]} for ${name}`,
        body: `The school suggested ${name} sees ${WHOM[r.specialty]}${r.dueBy ? ` by ${dayLabel(r.dueBy)}` : ''}: ${r.reason} Please tell the school what the doctor says, or that you have an appointment.`,
        i18n: { key: 'referral_reminder', vars: { name, specialty: r.specialty, due: r.dueBy ? dayLabel(r.dueBy) : '', reason: r.reason } },
    });
    await patch(MedicalReferral, r._id, {}, { push: { reminders: [{ at: new Date(), kind, by: by ? S(by) : null }] } });
}

/** The sweep: once when a referral falls due, once a fortnight after. */
async function sweep(schoolId, claim) {
    const today = todayStr();
    const { rows } = await pool.query(
        `SELECT * FROM "medicalreferrals" WHERE "school" = $1 AND "status" IN ('waiting','booked') AND "dueBy" IS NOT NULL
            AND ("dueBy" AT TIME ZONE 'UTC')::date <= $2::date`, [S(schoolId), today]);
    let n = 0;
    for (const r of rows) {
        // A booked appointment still ahead is the family keeping their word.
        if (r.status === 'booked' && r.appointmentOn && dayStr(r.appointmentOn) >= addDays(today, -7)) continue;
        const late = dayStr(r.dueBy) <= addDays(today, -14);
        if (await claim(schoolId, 'referral_due', `${r._id}:${late ? 'late' : 'due'}`, 'info')) {
            await remind(schoolId, r, late ? 'overdue' : 'due');
            n += 1;
        }
    }
    return n;
}

/** The board: tabs by state, filters by specialty, class and search. */
async function board(req, f = {}) {
    const { STUDENT_SELECT, STUDENT_JOIN, params, board: run } = require('./medicalBoard');
    const p = params([S(req.schoolId), todayStr()]);
    const where = ['rf."school" = $1'];
    if (SPECIALTY[f.specialty]) where.push(`rf."specialty" = ${p.$(f.specialty)}`);
    if (f.q && String(f.q).trim()) { const q = p.$(`%${String(f.q).trim().slice(0, 80).replace(/[%_\\]/g, (c) => `\\${c}`)}%`); where.push(`(u."name" ILIKE ${q} OR rf."number" ILIKE ${q} OR rf."reason" ILIKE ${q})`); }
    if (isUuid(f.sectionId)) where.push(`sp."currentSection" = ${p.$(f.sectionId)}::uuid`);
    else if (isUuid(f.classId)) where.push(`COALESCE(cs."class", sp."currentClass") = ${p.$(f.classId)}::uuid`);
    const overdue = `rf."status" IN ('waiting','booked') AND rf."dueBy" IS NOT NULL AND (rf."dueBy" AT TIME ZONE 'UTC')::date < $2::date`;
    const out = await run({
        from: `"medicalreferrals" rf ${STUDENT_JOIN('rf."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['open', 'Open', `rf."status" IN ('waiting','booked')`],
            ['overdue', 'Overdue', overdue],
            ['seen', 'To review', `rf."status" = 'seen'`],
            ['closed', 'Closed', `rf."status" = 'closed'`],
            ['declined', 'Declined', `rf."status" = 'declined'`],
            ['all', 'All', `rf."status" <> 'cancelled'`],
        ],
        select: `rf.*, rf."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'closed' ? 'rf."closedAt" DESC NULLS LAST' : 'rf."dueBy" ASC NULLS LAST, rf."createdAt" DESC'),
        map: (r) => decorate({ ...r, classLabel: [r.className, r.sectionName].filter(Boolean).join(' – ') }),
    });
    // How many came back, per specialty — over the year's referrals that were not cancelled.
    const { rows: rates } = await pool.query(
        `SELECT "specialty", count(*)::int AS total,
                count(*) FILTER (WHERE "status" IN ('seen','closed') AND ("outcome"->>'seenOn') IS NOT NULL)::int AS seen,
                count(*) FILTER (WHERE "status" = 'declined')::int AS declined
           FROM "medicalreferrals" WHERE "school" = $1 AND "status" <> 'cancelled' AND "createdAt" > now() - interval '365 days'
          GROUP BY "specialty" ORDER BY total DESC`, [S(req.schoolId)]);
    return { ...out, rates: rates.map((x) => ({ ...x, label: SPECIALTY[x.specialty] || x.specialty, rate: x.total ? Math.round((x.seen / x.total) * 100) : null })) };
}

/** A student's referrals — for their record (staff) or the family. */
async function forStudent(schoolId, studentId, { family = false } = {}) {
    const { rows } = await pool.query(
        `SELECT * FROM "medicalreferrals" WHERE "school" = $1 AND "student" = $2 ${family ? `AND "status" <> 'cancelled'` : ''}
          ORDER BY CASE WHEN "status" IN ('waiting','booked','seen') THEN 0 ELSE 1 END, "createdAt" DESC LIMIT 40`, [S(schoolId), S(studentId)]);
    return rows.map((r) => {
        const d = decorate(r);
        if (!family) return d;
        const { createdBy, closedBy, reminders, ...rest } = d;
        return rest;
    });
}

module.exports = { SPECIALTY, WHOM, URGENCY, STATUS, FROM_CHECKUP, create, fromCheckup, act, familyAnswer, sweep, board, forStudent, find, decorate };
