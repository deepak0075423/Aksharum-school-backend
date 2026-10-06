'use strict';
/**
 * Rescue medicines and emergency care plans (Oct 2026).
 *
 * A RESCUE MEDICINE is the auto-injector, inhaler, glucagon or seizure
 * medicine a child must have within reach: one row each, with its expiry,
 * how many there are and every place one is kept. The sweep tells the family
 * before it expires (once per expiry date) and the room when it has.
 *
 * A CARE PLAN is what to do, step by step, in an episode. It starts from a
 * template for its kind (anaphylaxis, asthma, seizure, low blood sugar,
 * cardiac) — a first-aid starting point that the school doctor reviews; the
 * doctor's sign-off is recorded with a date, the parent confirms it in the
 * app, and it carries a review date the sweep watches.
 *
 * Both are in the alert area, on the emergency card, and in what the staff
 * looking after the child are shown.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const MedicalRescueMed = require('../models/MedicalRescueMed');
const MedicalCarePlan = require('../models/MedicalCarePlan');
const MedicalAllergy = require('../models/MedicalAllergy');
const MedicalCondition = require('../models/MedicalCondition');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
// Who sees a child's emergency card is told when it changes — required late (medicalNeedToKnow reads through medicalRead, which reads this file).
const ntk = () => require('./medicalNeedToKnow');
const access = require('./medicalAccess');
const R = require('./medicalRules');

const { refuse, notFound, str, num, bool, oneOf, isUuid, toDay, todayStr, dayStr, dayLabel, daysBetween } = R;
const who = (req) => req.user?.name || '';
const plain = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);

const RESCUE_KIND = {
    auto_injector: 'Adrenaline auto-injector', inhaler: 'Reliever inhaler', glucagon: 'Glucagon',
    seizure: 'Seizure rescue medicine', antihistamine: 'Antihistamine', glucose: 'Fast-acting glucose', other: 'Other',
};
const RESCUE_PLACE = {
    bag: 'School bag', medical_room: 'Medical Room', classroom: 'Classroom', bus: 'School bus',
    staff_room: 'Staff room', hostel: 'Hostel', sports: 'Sports room', other: 'Other',
};
const CARE_PLAN_KIND = {
    anaphylaxis: 'Anaphylaxis', asthma: 'Asthma', seizure: 'Seizures / epilepsy', diabetes: 'Diabetes (low blood sugar)',
    cardiac: 'Heart condition', other: 'Other',
};

/**
 * Where each kind of plan starts. First-aid steps as published by first-aid
 * and allergy bodies — a starting point only: the school doctor reviews every
 * plan, and the room edits the steps to the child's own prescription.
 */
const TEMPLATES = {
    anaphylaxis: {
        title: 'Anaphylaxis (severe allergic reaction)',
        signs: ['Swelling of the lips, face or eyes', 'Hives or welts on the skin', 'Difficult or noisy breathing; wheeze or persistent cough',
            'Swelling of the tongue or tightness in the throat; hoarse voice', 'Dizziness, collapse, or a young child pale and floppy', 'Stomach pain or vomiting (after an insect sting)'],
        steps: [
            { text: 'Lay the child flat — do not let them stand or walk. If breathing is hard, let them sit with legs out straight.', critical: true },
            { text: 'Give the adrenaline auto-injector into the outer thigh.', critical: true },
            { text: 'Call an ambulance (108 / 112).', critical: true },
            { text: 'Call the parents.', critical: false },
            { text: 'If there is no improvement after 5 minutes, give a second adrenaline dose if one is available.', critical: true },
            { text: 'Start CPR if the child stops breathing normally.', critical: true },
            { text: 'Send the used auto-injector to hospital with the child, and note the time it was given.', critical: false },
        ],
        ambulanceWhen: 'Always — after any dose of adrenaline, even if the child seems better.',
        afterCare: 'Stay with the child until the ambulance arrives. Write down the time adrenaline was given.',
    },
    asthma: {
        title: 'Asthma attack',
        signs: ['Coughing and wheezing', 'Short of breath, tight chest', 'Cannot speak in full sentences', 'Blue lips or skin (emergency)'],
        steps: [
            { text: 'Sit the child upright. Stay calm and reassure them.', critical: false },
            { text: 'Give 4 separate puffs of the blue reliever inhaler through a spacer — 1 puff at a time, 4 breaths after each puff.', critical: true },
            { text: 'Wait 4 minutes.', critical: false },
            { text: 'If there is no improvement, give 4 more puffs the same way.', critical: true },
            { text: 'Still no improvement: call an ambulance (108 / 112) and keep giving 4 puffs every 4 minutes until it arrives.', critical: true },
            { text: 'Call the parents.', critical: false },
        ],
        ambulanceWhen: 'Not breathing, struggling to breathe or speak, blue lips, collapse, or no better after the second round of puffs.',
        afterCare: 'Let the child rest. Record the number of puffs and the times.',
    },
    seizure: {
        title: 'Seizure',
        signs: ['Sudden stiffening, then jerking of the body', 'Staring and not responding', 'Loss of consciousness', 'Confusion or sleepiness afterwards'],
        steps: [
            { text: 'Note the time the seizure starts.', critical: true },
            { text: 'Stay with the child and keep them safe: move hard objects away, cushion the head.', critical: true },
            { text: 'Do not hold them down, and put nothing in their mouth.', critical: true },
            { text: 'When the jerking stops, turn them on their side (recovery position) and check their breathing.', critical: false },
            { text: 'If it lasts more than 5 minutes: give the rescue medicine as prescribed and call an ambulance (108 / 112).', critical: true },
            { text: 'Call the parents. Let the child rest — they may be confused or sleepy.', critical: false },
        ],
        ambulanceWhen: 'A seizure over 5 minutes, a second seizure, an injury, difficulty breathing, a first-ever seizure, or a seizure in water.',
        afterCare: 'Write down how long it lasted and what happened.',
    },
    diabetes: {
        title: 'Low blood sugar (hypoglycaemia)',
        signs: ['Shaky, sweaty, pale', 'Hungry, headache', 'Confused or behaving unusually', 'Drowsy or unconscious (emergency)'],
        steps: [
            { text: 'Awake and able to swallow: give fast-acting sugar as the plan says (glucose tablets or juice).', critical: true },
            { text: 'Check blood glucose again after 15 minutes; give the sugar again if it is still low.', critical: false },
            { text: 'Once better, give a slow-acting snack (biscuits, a sandwich).', critical: false },
            { text: 'Drowsy or unconscious: nothing by mouth — recovery position, call an ambulance, give glucagon if prescribed and trained.', critical: true },
            { text: 'Call the parents.', critical: false },
        ],
        ambulanceWhen: 'Unconscious, having a seizure, or not better after two treatments.',
        afterCare: 'Record the readings and the sugar given.',
    },
    cardiac: {
        title: 'Heart condition',
        signs: ['Chest pain', 'Fainting or collapse, especially during exercise', 'A racing or irregular heartbeat', 'Breathlessness out of proportion to the activity'],
        steps: [
            { text: 'Stop the activity. Sit or lie the child down.', critical: false },
            { text: 'Unresponsive and not breathing normally: call an ambulance (108 / 112), start CPR and send for the AED.', critical: true },
            { text: 'Call the parents.', critical: false },
        ],
        ambulanceWhen: 'Collapse, chest pain that does not settle, or any fainting during exercise.',
        afterCare: '',
    },
    other: { title: '', signs: [], steps: [], ambulanceWhen: '', afterCare: '' },
};

/* ── Rescue medicines ─────────────────────────────────────────────────────── */

function locationsOf(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const l of list.slice(0, 8)) {
        const place = oneOf(typeof l === 'string' ? l : l?.place, RESCUE_PLACE, null);
        if (!place) continue;
        out.push({ place, note: str(typeof l === 'string' ? '' : l?.note, 120) });
    }
    return out;
}

function rescueFields(body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.kind !== undefined) out.kind = oneOf(body.kind, RESCUE_KIND, 'other');
    if (!partial || body.name !== undefined) { out.name = str(body.name, 120); if (!out.name) refuse('Name the medicine — e.g. "EpiPen Jr 0.15 mg"'); }
    if (body.dose !== undefined) out.dose = str(body.dose, 160);
    if (body.quantity !== undefined) {
        const n = num(body.quantity);
        if (n === null || n < 0 || n > 50) refuse('How many must be between 0 and 50');
        out.quantity = n;
    }
    if (body.expiresOn !== undefined) out.expiresOn = toDay(body.expiresOn);
    if (body.locations !== undefined) out.locations = locationsOf(body.locations);
    if (body.selfCarry !== undefined) out.selfCarry = bool(body.selfCarry);
    if (body.instructions !== undefined) out.instructions = str(body.instructions, 800);
    if (body.notes !== undefined) out.notes = str(body.notes, 600);
    return out;
}

async function findRescue(req, id) {
    if (!isUuid(id)) notFound('Rescue medicine');
    const row = await MedicalRescueMed.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Rescue medicine');
    return row;
}

async function addRescue(req, studentId, body, { source = 'staff' } = {}) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const card = await ntk().cardBefore(req, student._id);
    const f = rescueFields(body);
    if (!f.locations?.length) refuse('Say where it is kept — the bag, the Medical Room, the classroom …');
    const row = plain(await MedicalRescueMed.create({
        school: req.schoolId, student: student._id, ...f, source, status: 'active',
        createdBy: req.userId, updatedBy: req.userId,
    }));
    audit.log(req, { action: 'created', entity: 'rescue_med', entityId: row._id, student: student._id, summary: `Rescue medicine: ${f.name}${f.expiresOn ? ` (expires ${dayLabel(f.expiresOn)})` : ''}` });
    ntk().cardAfter(req, card);
    return row;
}

async function updateRescue(req, id, body) {
    const cur = await findRescue(req, id);
    if (cur.archivedAt) refuse('This rescue medicine is archived');
    const set = rescueFields(body, { partial: true });
    if (set.locations && !set.locations.length) refuse('Say where it is kept');
    // A new expiry date is a new medicine to watch: it may be reminded about again.
    if (set.expiresOn !== undefined && dayStr(set.expiresOn) !== dayStr(cur.expiresOn)) { set.expiryNotifiedFor = ''; set.expiredNotifiedFor = ''; }
    if (body.status !== undefined) set.status = oneOf(body.status, { active: 1, used: 1, returned: 1 }, cur.status);
    const changes = audit.diff(cur, set);
    if (!changes.length) return cur;
    const card = await ntk().cardBefore(req, cur.student);
    const row = await patch(MedicalRescueMed, id, { ...set, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'rescue_med', entityId: id, student: cur.student, summary: `Updated rescue medicine ${cur.name}`, changes });
    ntk().cardAfter(req, card);
    return row;
}

/** Seen and in date: recorded, with a new expiry or count if they changed. */
async function checkRescue(req, id, body = {}) {
    const cur = await findRescue(req, id);
    const set = { lastCheckedAt: new Date(), lastCheckedBy: req.userId, lastCheckedName: who(req) };
    if (body.expiresOn !== undefined) {
        set.expiresOn = toDay(body.expiresOn);
        if (dayStr(set.expiresOn) !== dayStr(cur.expiresOn)) { set.expiryNotifiedFor = ''; set.expiredNotifiedFor = ''; }
    }
    if (body.quantity !== undefined) {
        const n = num(body.quantity);
        if (n === null || n < 0) refuse('How many must be zero or more');
        set.quantity = n;
    }
    const row = await patch(MedicalRescueMed, id, set, { where: { school: req.schoolId } });
    audit.log(req, { action: 'checked', entity: 'rescue_med', entityId: id, student: cur.student, summary: `Checked ${cur.name}${set.expiresOn ? ` — expires ${dayLabel(set.expiresOn)}` : ''}` });
    return row;
}

/* ── Care plans ───────────────────────────────────────────────────────────── */

function stepsOf(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list.slice(0, 20).map((s) => (typeof s === 'string' ? { text: str(s, 400), critical: false } : { text: str(s?.text, 400), critical: bool(s?.critical) }))
        .filter((s) => s.text);
}

async function linkOf(Model, req, studentId, id, what) {
    if (!id) return null;
    if (!isUuid(id)) refuse(`That ${what} could not be found`);
    const row = await Model.findOne({ _id: id, school: req.schoolId, student: studentId }).select('_id').lean();
    if (!row) refuse(`That ${what} is not on this student's record`);
    return String(row._id);
}

async function carePlanFields(req, studentId, body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.kind !== undefined) out.kind = oneOf(body.kind, CARE_PLAN_KIND, 'other');
    if (!partial || body.title !== undefined) {
        out.title = str(body.title, 160) || (out.kind ? TEMPLATES[out.kind].title : '');
        if (!out.title) refuse('Give the plan a title');
    }
    if (body.triggers !== undefined) out.triggers = str(body.triggers, 600);
    if (body.signs !== undefined) out.signs = (Array.isArray(body.signs) ? body.signs : String(body.signs || '').split('\n')).map((s) => str(s, 200)).filter(Boolean).slice(0, 15);
    if (body.steps !== undefined) out.steps = stepsOf(body.steps);
    if (body.ambulanceWhen !== undefined) out.ambulanceWhen = str(body.ambulanceWhen, 600);
    if (body.afterCare !== undefined) out.afterCare = str(body.afterCare, 600);
    if (body.doctorName !== undefined) out.doctorName = str(body.doctorName, 120);
    if (body.doctorPhone !== undefined) out.doctorPhone = str(body.doctorPhone, 40);
    if (body.doctorSignedOn !== undefined) {
        out.doctorSignedOn = toDay(body.doctorSignedOn);
        if (out.doctorSignedOn && dayStr(out.doctorSignedOn) > todayStr()) refuse('The doctor\'s sign-off date is in the future');
    }
    if (body.reviewDue !== undefined) out.reviewDue = toDay(body.reviewDue);
    if (body.allergy !== undefined) out.allergy = await linkOf(MedicalAllergy, req, studentId, body.allergy, 'allergy');
    if (body.condition !== undefined) out.condition = await linkOf(MedicalCondition, req, studentId, body.condition, 'condition');
    if (body.rescueMed !== undefined) out.rescueMed = await linkOf(MedicalRescueMed, req, studentId, body.rescueMed, 'rescue medicine');
    if (body.status !== undefined) out.status = oneOf(body.status, { active: 1, draft: 1 }, 'active');
    return out;
}

async function findCarePlan(req, id) {
    if (!isUuid(id)) notFound('Care plan');
    const row = await MedicalCarePlan.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Care plan');
    return row;
}

async function addCarePlan(req, studentId, body) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const f = await carePlanFields(req, student._id, body);
    // Nothing sent for the steps: the template's, to be edited.
    const t = TEMPLATES[f.kind] || TEMPLATES.other;
    if (body.steps === undefined) f.steps = t.steps;
    if (body.signs === undefined) f.signs = t.signs;
    if (body.ambulanceWhen === undefined) f.ambulanceWhen = t.ambulanceWhen;
    if (body.afterCare === undefined) f.afterCare = t.afterCare;
    if (!f.steps.length) refuse('Add at least one step');
    if (f.reviewDue === undefined || f.reviewDue === null) f.reviewDue = toDay(R.addDays(todayStr(), 365));
    const card = await ntk().cardBefore(req, student._id);
    const row = plain(await MedicalCarePlan.create({
        school: req.schoolId, student: student._id, ...f, status: f.status || 'active',
        createdBy: req.userId, updatedBy: req.userId,
    }));
    audit.log(req, { action: 'created', entity: 'care_plan', entityId: row._id, student: student._id, summary: `Care plan: ${f.title}` });
    ntk().cardAfter(req, card);
    if (row.status === 'active') {
        tell.toParents(req, student._id, {
            title: `Care plan for ${student.name} — please confirm`,
            body: `The Medical Room has written a ${CARE_PLAN_KIND[row.kind].toLowerCase()} care plan for ${student.name}. Please read it and confirm it in the app.`,
            setting: 'parentFollowUp', tab: 'overview',
        });
    }
    return row;
}

async function updateCarePlan(req, id, body) {
    const cur = await findCarePlan(req, id);
    if (cur.archivedAt) refuse('This care plan is archived');
    const set = await carePlanFields(req, cur.student, body, { partial: true });
    if (set.steps && !set.steps.length) refuse('Add at least one step');
    const changes = audit.diff(cur, set);
    if (!changes.length) return cur;
    // What the parent confirmed is not this plan any more.
    const material = ['steps', 'signs', 'ambulanceWhen', 'kind', 'triggers'].some((k) => changes.some((c) => c.field === k));
    if (material && cur.parentConfirmedAt) Object.assign(set, { parentConfirmedAt: null, parentConfirmedBy: null, parentConfirmedName: '' });
    if (set.reviewDue !== undefined && dayStr(set.reviewDue) !== dayStr(cur.reviewDue)) set.reviewNotifiedFor = '';
    const card = await ntk().cardBefore(req, cur.student);
    const row = await patch(MedicalCarePlan, id, { ...set, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'care_plan', entityId: id, student: cur.student, summary: `Updated care plan ${cur.title}`, changes });
    ntk().cardAfter(req, card);
    if (material && cur.parentConfirmedAt) {
        const card = await access.studentCard(req.schoolId, cur.student);
        tell.toParents(req, cur.student, {
            title: `Care plan changed — ${card?.name || 'your child'}`,
            body: `The Medical Room has changed ${card?.name || 'your child'}'s ${CARE_PLAN_KIND[row.kind].toLowerCase()} care plan. Please read it and confirm it again.`,
            setting: 'parentFollowUp', tab: 'overview',
        });
    }
    return row;
}

/** The parent has read the plan and agrees with it. */
async function confirmCarePlan(req, id) {
    const cur = await findCarePlan(req, id);
    if (cur.archivedAt || cur.status !== 'active') refuse('This care plan is not in use');
    if (cur.parentConfirmedAt) return cur;
    const row = await patch(MedicalCarePlan, id, { parentConfirmedBy: req.userId, parentConfirmedName: who(req), parentConfirmedAt: new Date() }, { where: { school: req.schoolId, parentConfirmedAt: null } });
    audit.log(req, { action: 'confirmed', entity: 'care_plan', entityId: id, student: cur.student, summary: `${who(req)} confirmed the care plan "${cur.title}"` });
    if (row) {
        const card = await access.studentCard(req.schoolId, cur.student);
        tell.toStaff(req, {
            title: `Care plan confirmed — ${card?.name || 'a student'}`,
            body: `${who(req) || 'A parent'} read and confirmed the care plan "${cur.title}" for ${card?.name || 'a student'}.`,
            setting: 'staffParentUpdates', link: { type: 'medical.student', entityId: String(cur.student) },
        }).catch((e) => console.error('[medical] care plan notice failed:', e.message));
    }
    return row || cur;
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

const S = (v) => String(v);

/** The rescue medicines and care plans in force for many students: Map(id → { rescueMeds, carePlans }). */
async function careFor(schoolId, studentIds) {
    const ids = [...studentIds].map(S);
    const out = new Map(ids.map((id) => [id, { rescueMeds: [], carePlans: [] }]));
    if (!ids.length) return out;
    const [rescue, plans] = await Promise.all([
        pool.query(`SELECT * FROM "medicalrescuemeds" WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND "archivedAt" IS NULL AND "status" = 'active' ORDER BY "createdAt"`, [S(schoolId), ids]),
        pool.query(`SELECT * FROM "medicalcareplans" WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND "archivedAt" IS NULL AND "status" = 'active' ORDER BY "createdAt"`, [S(schoolId), ids]),
    ]);
    for (const r of rescue.rows) out.get(S(r.student))?.rescueMeds.push(r);
    for (const p of plans.rows) out.get(S(p.student))?.carePlans.push(p);
    return out;
}

/** Every rescue medicine and care plan of one student, archived ones included — the staff record. */
async function allFor(schoolId, studentId) {
    const [rescue, plans] = await Promise.all([
        pool.query(`SELECT * FROM "medicalrescuemeds" WHERE "school" = $1 AND "student" = $2 ORDER BY "archivedAt" NULLS FIRST, "createdAt" DESC`, [S(schoolId), S(studentId)]),
        pool.query(`SELECT * FROM "medicalcareplans" WHERE "school" = $1 AND "student" = $2 ORDER BY "archivedAt" NULLS FIRST, "createdAt" DESC`, [S(schoolId), S(studentId)]),
    ]);
    return { rescueMeds: rescue.rows, carePlans: plans.rows };
}

/** 'expired' | 'expiring' | 'ok' | '' (no date) for a rescue medicine. */
function rescueState(r, today = todayStr(), days = 30) {
    const exp = dayStr(r?.expiresOn);
    if (!exp) return '';
    if (exp < today) return 'expired';
    return daysBetween(today, exp) <= days ? 'expiring' : 'ok';
}

/* ── The sweep ────────────────────────────────────────────────────────────── */

/**
 * Once a day per school: a rescue medicine expiring within 30 days (the
 * family, once per expiry date), one that has expired (the room and the
 * family, once), a care plan past its review date (the room, once).
 */
async function sweep(schoolId) {
    const today = todayStr();
    const soon = R.addDays(today, 30);
    const { rows: meds } = await pool.query(
        `SELECT r.*, u."name" AS "studentName" FROM "medicalrescuemeds" r JOIN "users" u ON u."_id" = r."student"
          WHERE r."school" = $1 AND r."archivedAt" IS NULL AND r."status" = 'active' AND r."expiresOn" IS NOT NULL
            AND (r."expiresOn" AT TIME ZONE 'UTC')::date <= $2::date AND u."isActive" IS NOT FALSE`,
        [S(schoolId), soon],
    );
    const staff = (await tell.staffIds(schoolId));
    for (const m of meds) {
        const exp = dayStr(m.expiresOn);
        if (exp < today) {
            if (m.expiredNotifiedFor === exp) continue;
            await pool.query(`UPDATE "medicalrescuemeds" SET "expiredNotifiedFor" = $2 WHERE "_id" = $1`, [S(m._id), exp]);
            const to = [...staff, ...(await tell.parentIds(m.student))];
            await tell.system(schoolId, {
                to, title: `Expired: ${m.studentName}'s ${m.name}`,
                body: `${m.studentName}'s ${m.name} expired on ${dayLabel(m.expiresOn)}. An expired rescue medicine may not work — please replace it.`,
                link: { type: 'medical.child', params: { child: S(m.student), tab: 'overview' } }, priority: 'high',
            });
        } else {
            if (m.expiryNotifiedFor === exp) continue;
            await pool.query(`UPDATE "medicalrescuemeds" SET "expiryNotifiedFor" = $2 WHERE "_id" = $1`, [S(m._id), exp]);
            const parents = await tell.parentIds(m.student);
            if (parents.length) {
                await tell.system(schoolId, {
                    to: parents, title: `${m.name} expires on ${dayLabel(m.expiresOn)}`,
                    body: `${m.studentName}'s ${m.name} kept at school expires on ${dayLabel(m.expiresOn)}. Please send a replacement before then.`,
                    link: { type: 'medical.child', params: { child: S(m.student), tab: 'overview' } },
                });
            }
        }
    }
    const { rows: plans } = await pool.query(
        `SELECT p."_id", p."title", p."reviewDue", p."reviewNotifiedFor", u."name" AS "studentName"
           FROM "medicalcareplans" p JOIN "users" u ON u."_id" = p."student"
          WHERE p."school" = $1 AND p."archivedAt" IS NULL AND p."status" = 'active' AND p."reviewDue" IS NOT NULL
            AND (p."reviewDue" AT TIME ZONE 'UTC')::date <= $2::date AND u."isActive" IS NOT FALSE`,
        [S(schoolId), today],
    );
    const due = plans.filter((p) => p.reviewNotifiedFor !== dayStr(p.reviewDue));
    if (due.length && staff.length) {
        for (const p of due) await pool.query(`UPDATE "medicalcareplans" SET "reviewNotifiedFor" = $2 WHERE "_id" = $1`, [S(p._id), dayStr(p.reviewDue)]);
        await tell.system(schoolId, {
            to: staff, title: `${due.length} care plan${due.length === 1 ? '' : 's'} due for review`,
            body: due.slice(0, 6).map((p) => `${p.studentName} — ${p.title} (due ${dayLabel(p.reviewDue)})`).join('; '),
            link: { type: 'medical.desk' },
        });
    }
    return { rescue: meds.length, plans: due.length };
}

module.exports = {
    RESCUE_KIND, RESCUE_PLACE, CARE_PLAN_KIND, TEMPLATES,
    findRescue, addRescue, updateRescue, checkRescue, findCarePlan, addCarePlan, updateCarePlan, confirmCarePlan,
    careFor, allFor, rescueState, sweep,
};
