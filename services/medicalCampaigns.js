'use strict';
/**
 * Health campaigns (Oct 2026): a deworming day, a vitamin A round, iron and
 * folic acid, a vaccination drive, a screening camp — planned for the whole
 * school or some classes, the families told and (when the school asks) their
 * answer taken, a roster marked on the day, a mop-up day for those who were
 * away, and the coverage at the end.
 *
 *   draft      the medical staff are planning it; nobody has been told
 *   announced  families told; one entry per student in the audience
 *   closed     the coverage is final
 *   cancelled  families who were told are told again
 *
 * Giving something checks the family's answer (an "opt in" campaign needs a
 * yes, any campaign stops at a no) and the child's allergies; a vaccination
 * drive writes each dose given into the child's vaccination record.
 */
const pool = require('../db/pool');
const MedicalCampaign = require('../models/MedicalCampaign');
const MedicalCampaignEntry = require('../models/MedicalCampaignEntry');
const MedicalVaccination = require('../models/MedicalVaccination');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const numbers = require('./medicalNumber');
const { patch } = require('../db/patch');
const { newId } = require('../db/schema');
const R = require('./medicalRules');

const { refuse, str, isUuid, todayStr, dayStr, dayLabel, toDay, addDays } = R;
const S = (v) => String(v);

const KIND = {
    deworming:   { label: 'Deworming day',              gives: true,  medicine: 'Albendazole 400 mg (chewable)', done: 'Given' },
    vitamin_a:   { label: 'Vitamin A round',            gives: true,  medicine: 'Vitamin A solution',            done: 'Given' },
    iron:        { label: 'Iron & folic acid (WIFS)',   gives: true,  medicine: 'Iron & folic acid tablet',      done: 'Given' },
    vaccination: { label: 'Vaccination drive',          gives: true,  medicine: '',                              done: 'Vaccinated' },
    screening:   { label: 'Health screening',           gives: false, medicine: '',                              done: 'Screened' },
    dental:      { label: 'Dental camp',                gives: false, medicine: '',                              done: 'Examined' },
    eye:         { label: 'Eye camp',                   gives: false, medicine: '',                              done: 'Examined' },
    awareness:   { label: 'Health talk',                gives: false, medicine: '',                              done: 'Attended' },
    other:       { label: 'Other',                      gives: false, medicine: '',                              done: 'Done' },
};
const CONSENT = {
    none:    'Families are told; nothing is asked',
    opt_out: 'Taking part unless the family says no',
    opt_in:  'Taking part only if the family says yes',
};
const OUTCOME = {
    given:    { label: 'Given', tone: 'green' },
    absent:   { label: 'Absent', tone: 'amber' },
    refused:  { label: 'Refused on the day', tone: 'slate' },
    excluded: { label: 'Not given — medical reason', tone: 'rose' },
};

const thing = (c) => c.vaccine ? `${c.vaccine}${c.dose ? ` (${c.dose})` : ''}` : (c.medicine || KIND[c.kind]?.label || 'it');
const lastDay = (c) => dayStr(c.mopUpOn || c.endOn || c.startOn);
/** May this entry be given, as far as the family's answer goes? */
const allowed = (c, e) => (c.consent === 'opt_in' ? e.consent === 'yes' : e.consent !== 'no');

function phase(c, today = todayStr()) {
    if (c.status === 'draft' || c.status === 'cancelled' || c.status === 'closed') return c.status;
    if (dayStr(c.startOn) > today) return 'upcoming';
    if (lastDay(c) >= today) return 'running';
    return 'past';
}
const PHASE = {
    draft: { label: 'Draft', tone: 'slate' }, upcoming: { label: 'Coming up', tone: 'sky' }, running: { label: 'On now', tone: 'green' },
    past: { label: 'Finished — close it', tone: 'amber' }, closed: { label: 'Closed', tone: 'slate' }, cancelled: { label: 'Cancelled', tone: 'slate' },
};

function decorate(c, today = todayStr()) {
    const ph = phase(c, today);
    return {
        ...c, kindLabel: KIND[c.kind]?.label || c.kind, consentLabel: CONSENT[c.consent], doneLabel: KIND[c.kind]?.done || 'Given',
        gives: !!KIND[c.kind]?.gives, phase: ph, phaseLabel: PHASE[ph].label, tone: PHASE[ph].tone, what: thing(c),
    };
}

async function find(req, id) {
    if (!isUuid(id)) refuse('Campaign not found', 404, 'MEDICAL_NOT_FOUND');
    const { rows } = await pool.query(`SELECT * FROM "medicalcampaigns" WHERE "_id" = $1 AND "school" = $2`, [id, S(req.schoolId)]);
    if (!rows[0]) refuse('Campaign not found', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

/** { all, classes, sections }, every id checked against the school. */
async function audienceOf(schoolId, raw = {}) {
    const all = raw.all === true || raw.all === 'true';
    const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(S).filter(isUuid))].slice(0, 200);
    let classes = ids(raw.classes); let sections = ids(raw.sections);
    if (!all) {
        if (classes.length) classes = (await pool.query(`SELECT "_id"::text AS id FROM "classes" WHERE "school" = $1 AND "_id" = ANY($2::uuid[])`, [S(schoolId), classes])).rows.map((r) => r.id);
        if (sections.length) sections = (await pool.query(`SELECT "_id"::text AS id FROM "classsections" WHERE "school" = $1 AND "_id" = ANY($2::uuid[])`, [S(schoolId), sections])).rows.map((r) => r.id);
        if (!classes.length && !sections.length) refuse('Choose the classes or sections taking part, or the whole school');
    }
    return all ? { all: true, classes: [], sections: [] } : { all: false, classes, sections };
}

function fieldsOf(body, prev = {}) {
    const kind = KIND[body.kind] ? body.kind : (prev.kind || 'other');
    const title = str(body.title ?? prev.title, 120);
    if (title.length < 3) refuse('Give the campaign a name');
    const startOn = toDay(body.startOn ?? prev.startOn);
    if (!startOn) refuse('Choose the day of the campaign');
    const endOn = body.endOn === '' ? null : body.endOn !== undefined ? toDay(body.endOn) : prev.endOn || null;
    const mopUpOn = body.mopUpOn === '' ? null : body.mopUpOn !== undefined ? toDay(body.mopUpOn) : prev.mopUpOn || null;
    const consentBy = body.consentBy === '' ? null : body.consentBy !== undefined ? toDay(body.consentBy) : prev.consentBy || null;
    if (endOn && dayStr(endOn) < dayStr(startOn)) refuse('The last day is before the first');
    if (endOn && dayStr(endOn) > addDays(dayStr(startOn), 60)) refuse('A campaign runs for at most 60 days');
    if (mopUpOn && dayStr(mopUpOn) <= dayStr(endOn || startOn)) refuse('The mop-up day comes after the campaign');
    if (mopUpOn && dayStr(mopUpOn) > addDays(dayStr(startOn), 90)) refuse('The mop-up day is within 90 days of the campaign');
    const consent = CONSENT[body.consent] ? body.consent : (prev.consent || (KIND[kind].gives ? 'opt_out' : 'none'));
    if (consentBy && dayStr(consentBy) > dayStr(startOn)) refuse('Answers are needed by the day of the campaign at the latest');
    const vaccine = str(body.vaccine ?? prev.vaccine, 80);
    if (kind === 'vaccination' && !vaccine) refuse('Choose the vaccine');
    const medicine = str(body.medicine ?? prev.medicine, 160) || (KIND[kind].gives && kind !== 'vaccination' ? KIND[kind].medicine : '');
    return {
        kind, title, startOn, endOn, mopUpOn, consent, consentBy, vaccine: kind === 'vaccination' ? vaccine : '',
        dose: kind === 'vaccination' ? str(body.dose ?? prev.dose, 40) : '', lotNumber: str(body.lotNumber ?? prev.lotNumber, 60),
        medicine: kind === 'vaccination' ? '' : medicine, about: str(body.about ?? prev.about, 1500),
    };
}

async function create(req, body = {}) {
    const f = fieldsOf(body);
    if (dayStr(f.startOn) < addDays(todayStr(), -30)) refuse('A campaign starts no more than 30 days ago');
    const audience = await audienceOf(req.schoolId, body.audience);
    const number = await numbers.next(req.schoolId, 'campaign');
    const row = await MedicalCampaign.create({ school: req.schoolId, number, ...f, audience, status: 'draft', createdBy: req.userId, createdByName: req.user?.name || '' });
    const plain = row.toObject ? row.toObject() : row;
    audit.log(req, { action: 'created', entity: 'campaign', entityId: plain._id, summary: `Campaign ${number} "${f.title}" planned for ${dayLabel(f.startOn)}` });
    return decorate(plain);
}

async function update(req, id, body = {}) {
    const c = await find(req, id);
    if (!['draft', 'announced'].includes(c.status)) refuse('A closed or cancelled campaign cannot be changed');
    const f = fieldsOf(body, c);
    if (c.status === 'announced' && f.kind !== c.kind) refuse('The kind of campaign cannot change after families were told');
    if (c.status === 'announced' && f.consent !== c.consent) refuse('What families are asked cannot change after they were told — cancel and plan it again');
    const audience = body.audience !== undefined ? await audienceOf(req.schoolId, body.audience) : c.audience;
    const row = await patch(MedicalCampaign, id, { ...f, audience }, { where: { school: req.schoolId, status: c.status } });
    if (!row) refuse('Someone else changed this campaign — open it again', 409, 'MEDICAL_STALE');
    if (c.status === 'announced') await syncEntries(req, row);
    audit.log(req, { action: 'updated', entity: 'campaign', entityId: id, summary: `Campaign ${c.number} changed` });
    return decorate(row);
}

/** The students the audience covers today (current students only). */
async function audienceStudents(schoolId, audience) {
    const a = audience || {};
    const { rows } = await pool.query(
        `SELECT u."_id"::text AS id, sp."currentSection"::text AS section, COALESCE(cs."class", sp."currentClass")::text AS class
           FROM "users" u JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE
            AND ($2::boolean OR sp."currentSection" = ANY($3::uuid[]) OR COALESCE(cs."class", sp."currentClass") = ANY($4::uuid[]))`,
        [S(schoolId), !!a.all, (a.sections || []).map(S), (a.classes || []).map(S)],
    );
    return rows;
}

/** Make the roster match the audience: new students added; students no longer in it, with nothing recorded, removed. */
async function syncEntries(req, c) {
    const list = await audienceStudents(req.schoolId, c.audience);
    if (!list.length) return { added: 0, removed: 0 };
    const ids = list.map((x) => x.id);
    const added = [];
    for (let i = 0; i < list.length; i += 500) {
        const part = list.slice(i, i + 500);
        const vals = []; const p = [];
        for (const s of part) {
            p.push(newId(), S(req.schoolId), S(c._id), s.id, s.section || null, s.class || null);
            const n = p.length;
            vals.push(`($${n - 5},$${n - 4},$${n - 3},$${n - 2},$${n - 1},$${n},'pending','',now(),now())`);
        }
        const { rows } = await pool.query(
            `INSERT INTO "medicalcampaignentries" ("_id","school","campaign","student","section","class","consent","outcome","createdAt","updatedAt")
             VALUES ${vals.join(',')} ON CONFLICT ("campaign","student") DO NOTHING RETURNING "student"::text AS student`, p);
        added.push(...rows.map((r) => r.student));
    }
    const { rowCount: removed } = await pool.query(
        `DELETE FROM "medicalcampaignentries" WHERE "campaign" = $1 AND "outcome" = '' AND "consent" = 'pending' AND NOT ("student" = ANY($2::uuid[]))`,
        [S(c._id), ids]);
    return { added, removed };
}

function familyText(c, name) {
    const when = c.endOn && dayStr(c.endOn) !== dayStr(c.startOn) ? `from ${dayLabel(c.startOn)} to ${dayLabel(c.endOn)}` : `on ${dayLabel(c.startOn)}`;
    const about = c.about ? ` ${c.about}` : '';
    const by = c.consentBy ? ` by ${dayLabel(c.consentBy)}` : ' before the day';
    if (c.consent === 'opt_in') return `${KIND[c.kind].label} at school ${when}: ${thing(c)}.${about} If you would like ${name} to take part, please say yes on the Medical Room page${by}.`;
    if (c.consent === 'opt_out') return `${KIND[c.kind].label} at school ${when}: ${name} will be given ${thing(c)}.${about} If you do NOT want this, please say no on the Medical Room page${by}.`;
    return `${KIND[c.kind].label} at school ${when}: ${thing(c)}.${about}`;
}

/** Tell the families and make the roster. */
async function announce(req, id) {
    const c = await find(req, id);
    if (c.status !== 'draft') refuse('This campaign has already been announced');
    if (lastDay(c) < todayStr()) refuse('The campaign\'s days have passed — change the dates first');
    const row = await patch(MedicalCampaign, id, { status: 'announced', announcedAt: new Date(), announcedBy: req.userId }, { where: { school: req.schoolId, status: 'draft' } });
    if (!row) refuse('Someone else announced this campaign a moment ago', 409, 'MEDICAL_STALE');
    const { added } = await syncEntries(req, row);
    if (!added.length) {
        await patch(MedicalCampaign, id, { status: 'draft', announcedAt: null, announcedBy: null });
        refuse('No current students are in the audience of this campaign');
    }
    const cards = await access.studentCards(req.schoolId, added);
    for (const sid of added) {
        const name = cards.get(sid)?.name || 'your child';
        tell.toParents(req, sid, {
            title: `${KIND[row.kind].label} — ${name}`, body: familyText(row, name), tab: 'campaigns', params: { campaign: S(id) },
            i18n: { key: 'campaign', vars: {
                name, kind: row.kind, consent: row.consent, what: thing(row), about: row.about,
                by: row.consentBy ? dayLabel(row.consentBy) : '',
                when: row.endOn && dayStr(row.endOn) !== dayStr(row.startOn) ? `${dayLabel(row.startOn)} से ${dayLabel(row.endOn)} तक` : `${dayLabel(row.startOn)} को`,
            } },
        });
    }
    // The class teachers hear what is happening in their sections (no names).
    const { rows: teachers } = await pool.query(
        `SELECT DISTINCT unnest(ARRAY[cs."classTeacher", cs."substituteTeacher"])::text AS id
           FROM "medicalcampaignentries" e JOIN "classsections" cs ON cs."_id" = e."section" WHERE e."campaign" = $1`, [S(id)]);
    const to = teachers.map((t) => t.id).filter(Boolean);
    if (to.length) tell.send(req, { to, title: `${KIND[row.kind].label} for your class`, body: `${row.title} ${row.endOn && dayStr(row.endOn) !== dayStr(row.startOn) ? `from ${dayLabel(row.startOn)} to ${dayLabel(row.endOn)}` : `on ${dayLabel(row.startOn)}`} — the Medical Room will come round. ${thing(row)}.`, link: { type: 'medical.mine' } });
    audit.log(req, { action: 'announced', entity: 'campaign', entityId: id, summary: `Campaign ${row.number} announced to ${added.length} famil${added.length === 1 ? 'y' : 'ies'}` });
    return decorate(row);
}

async function cancel(req, id, body = {}) {
    const c = await find(req, id);
    if (!['draft', 'announced'].includes(c.status)) refuse('This campaign is already closed or cancelled');
    const why = str(body.reason, 300);
    if (why.length < 3) refuse('Say why the campaign is cancelled');
    const row = await patch(MedicalCampaign, id, { status: 'cancelled', cancelledAt: new Date(), cancelledBy: req.userId, cancelReason: why }, { where: { school: req.schoolId, status: c.status } });
    if (!row) refuse('Someone else changed this campaign — open it again', 409, 'MEDICAL_STALE');
    if (c.status === 'announced') {
        const { rows } = await pool.query(`SELECT "student"::text AS id FROM "medicalcampaignentries" WHERE "campaign" = $1 AND "outcome" = ''`, [S(id)]);
        const cards = await access.studentCards(req.schoolId, rows.map((r) => r.id));
        for (const r of rows) tell.toParents(req, r.id, { title: `Cancelled: ${row.title}`, body: `${row.title} on ${dayLabel(row.startOn)} will not take place for ${cards.get(r.id)?.name || 'your child'}: ${why}`, tab: 'campaigns' });
    }
    audit.log(req, { action: 'cancelled', entity: 'campaign', entityId: id, summary: `Campaign ${c.number} cancelled — ${why}` });
    return decorate(row);
}

async function close(req, id) {
    const c = await find(req, id);
    if (c.status !== 'announced') refuse('Only an announced campaign can be closed');
    if (dayStr(c.startOn) > todayStr()) refuse('The campaign has not started yet — cancel it instead');
    const row = await patch(MedicalCampaign, id, { status: 'closed', closedAt: new Date(), closedBy: req.userId }, { where: { school: req.schoolId, status: 'announced' } });
    if (!row) refuse('Someone else changed this campaign — open it again', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'closed', entity: 'campaign', entityId: id, summary: `Campaign ${c.number} closed` });
    return decorate(row);
}

/** A closed campaign opened again — to correct a row. */
async function reopen(req, id) {
    const c = await find(req, id);
    if (c.status !== 'closed') refuse('Only a closed campaign can be reopened');
    const row = await patch(MedicalCampaign, id, { status: 'announced', closedAt: null, closedBy: null }, { where: { school: req.schoolId, status: 'closed' } });
    if (!row) refuse('Someone else changed this campaign — open it again', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'reopened', entity: 'campaign', entityId: id, summary: `Campaign ${c.number} reopened` });
    return decorate(row);
}

/* ── The family's answer ──────────────────────────────────────────────────── */

async function familyAnswer(req, body = {}) {
    if (req.userRole !== 'parent') refuse('Only a parent can answer', 403, 'MEDICAL_PARENT_ONLY');
    const child = await access.familyChild(req, body.child);
    const c = await find(req, body.campaign);
    if (c.status !== 'announced') refuse('This campaign is not taking answers');
    if (c.consent === 'none') refuse('Nothing is asked for this campaign');
    const today = todayStr();
    if (c.consentBy && dayStr(c.consentBy) < today) refuse(`Answers closed on ${dayLabel(c.consentBy)} — please call the Medical Room`);
    if (lastDay(c) < today) refuse('This campaign is over');
    const answer = body.answer === 'yes' ? 'yes' : body.answer === 'no' ? 'no' : null;
    if (!answer) refuse('Say yes or no');
    const reason = str(body.reason, 300);
    const { rows } = await pool.query(`SELECT * FROM "medicalcampaignentries" WHERE "campaign" = $1 AND "student" = $2`, [S(c._id), S(child)]);
    const e = rows[0];
    if (!e) refuse('Your child is not part of this campaign', 404, 'MEDICAL_NOT_FOUND');
    if (e.outcome) refuse('This has already happened at school');
    const row = await patch(MedicalCampaignEntry, e._id, { consent: answer, consentReason: reason, consentBy: req.userId, consentByName: req.user?.name || '', consentAt: new Date() }, { where: { outcome: '' } });
    if (!row) refuse('This has just been recorded at school — open the page again', 409, 'MEDICAL_STALE');
    const card = await access.studentCard(req.schoolId, child);
    audit.log(req, { action: `campaign_${answer}`, entity: 'campaign', entityId: c._id, student: child, summary: `${req.user?.name || 'A parent'} said ${answer} to ${c.title} for ${card?.name || 'their child'}${reason ? ` — ${reason}` : ''}` });
    return row;
}

/* ── The day ──────────────────────────────────────────────────────────────── */

/**
 * Record what happened. body: { entries: [{ student, outcome, reason }], mopUp }
 * Each row stands alone: one that cannot be saved is reported, the rest are.
 */
async function record(req, id, body = {}) {
    const c = await find(req, id);
    if (c.status !== 'announced') refuse(c.status === 'closed' ? 'This campaign is closed — reopen it from its page to correct a row' : 'Announce the campaign first');
    if (dayStr(c.startOn) > todayStr()) refuse(`The campaign starts on ${dayLabel(c.startOn)}`);
    const list = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
    if (!list.length) refuse('There is nothing to record');
    const ids = list.map((x) => S(x.student)).filter(isUuid);
    const { rows } = await pool.query(`SELECT * FROM "medicalcampaignentries" WHERE "campaign" = $1 AND "student" = ANY($2::uuid[])`, [S(c._id), ids]);
    const byStudent = new Map(rows.map((r) => [S(r.student), r]));
    const cards = await access.studentCards(req.schoolId, ids);
    const safety = require('./medicalSafety');
    const saved = []; const failed = []; const told = [];
    for (const x of list) {
        const sid = S(x.student);
        const e = byStudent.get(sid);
        const name = cards.get(sid)?.name || 'This student';
        try {
            if (!e) refuse(`${name} is not on this campaign's roster`);
            const outcome = OUTCOME[x.outcome] ? x.outcome : x.outcome === '' ? '' : null;
            if (outcome === null) refuse('Choose what happened');
            const reason = str(x.reason, 300);
            if (['excluded', 'refused'].includes(outcome) && reason.length < 3) refuse(`Say why ${name} did not have it`);
            if (outcome === 'given') {
                if (KIND[c.kind].gives && !allowed(c, e)) refuse(c.consent === 'opt_in' && e.consent !== 'no' ? `${name}'s family has not said yes` : `${name}'s family said no`);
                if (KIND[c.kind].gives) {
                    const check = await safety.check(req.schoolId, sid, { medicineName: c.vaccine || c.medicine });
                    if (check.blocks?.length) refuse(`${name}: ${check.blocks[0].message}`, 409, 'MEDICAL_SAFETY');
                }
            }
            const set = { outcome, outcomeReason: reason, outcomeAt: outcome ? new Date() : null, outcomeBy: outcome ? req.userId : null, outcomeByName: outcome ? (req.user?.name || '') : '', mopUp: !!body.mopUp && !!outcome };
            // The row is claimed first (compare-and-set on what it said), so two people marking the
            // same child never write two doses into the record.
            const row = await patch(MedicalCampaignEntry, e._id, set, { where: { outcome: e.outcome } });
            if (!row) refuse(`${name} was just recorded by someone else`, 409, 'MEDICAL_STALE');
            // A vaccination drive: the dose goes into the child's record; a correction takes it out again.
            if (c.kind === 'vaccination' && outcome === 'given' && !e.vaccination) {
                const v = await MedicalVaccination.create({
                    school: req.schoolId, student: sid, vaccine: c.vaccine, dose: c.dose, givenOn: toDay(todayStr()), lotNumber: c.lotNumber,
                    provider: `School campaign — ${c.title}`, source: 'staff', verified: true, verifiedBy: req.userId, verifiedAt: new Date(),
                    createdBy: req.userId, updatedBy: req.userId,
                });
                await patch(MedicalCampaignEntry, e._id, { vaccination: v._id });
            } else if (c.kind === 'vaccination' && outcome !== 'given' && e.vaccination) {
                await pool.query(`UPDATE "medicalvaccinations" SET "archivedAt" = now(), "archivedBy" = $2, "archiveReason" = 'The campaign roster was corrected' WHERE "_id" = $1 AND "archivedAt" IS NULL`, [S(e.vaccination), S(req.userId)]);
                await patch(MedicalCampaignEntry, e._id, { vaccination: null });
            }
            saved.push(sid);
            // The family hears what happened — once per change, and only when something is given (a screening's findings come as a checkup).
            if (outcome && outcome !== e.outcome && KIND[c.kind].gives) told.push({ sid, name, outcome, reason });
        } catch (err) {
            if (!err.status) console.error('[medical] campaign record failed:', err.message);
            failed.push({ student: sid, name, message: err.message, code: err.code || '' });
        }
    }
    if (saved.length) audit.log(req, { action: 'recorded', entity: 'campaign', entityId: id, summary: `${saved.length} result${saved.length === 1 ? '' : 's'} recorded for ${c.number}${body.mopUp ? ' (mop-up)' : ''}` });
    // A mop-up day still to come is a second chance — said when the child did not have it.
    const mopUp = c.mopUpOn && !body.mopUp && dayStr(c.mopUpOn) > todayStr() ? dayLabel(c.mopUpOn) : '';
    for (const t of told) {
        const what = thing(c);
        const again = mopUp ? ` There is a mop-up day on ${mopUp}.` : '';
        const body = t.outcome === 'given' ? `${t.name} had ${what} at school today (${c.title}).`
            : t.outcome === 'absent' ? `${t.name} was not at school for ${c.title}, so did not have ${what}.${again}`
                : `${t.name} did not have ${what} at ${c.title}${t.reason ? ` (${t.reason})` : ''}.${again}`;
        tell.toParents(req, t.sid, {
            title: `${KIND[c.kind].label}: ${OUTCOME[t.outcome].label.toLowerCase()} — ${t.name}`, body,
            setting: 'parentCampaign', tab: 'campaigns',
            i18n: { key: 'campaign_result', vars: { name: t.name, kind: c.kind, title: c.title, what, outcome: t.outcome, note: t.reason, mopUp } },
        }).catch((err) => console.error('[medical] campaign result notice failed:', err.message));
    }
    return { saved: saved.length, failed };
}

/** "Everyone left in this section had it" (or was absent) — each still checked like a single row. */
async function markRest(req, id, body = {}) {
    const c = await find(req, id);
    const outcome = ['given', 'absent'].includes(body.outcome) ? body.outcome : null;
    if (!outcome) refuse('Mark the rest as given or absent');
    const where = ['"campaign" = $1', `"outcome" = ''`];
    const p = [S(c._id)];
    if (isUuid(body.sectionId)) { p.push(body.sectionId); where.push(`"section" = $${p.length}::uuid`); }
    else if (body.sectionId !== 'all') refuse('Choose the section');
    const { rows } = await pool.query(`SELECT "student"::text AS student, "consent" FROM "medicalcampaignentries" WHERE ${where.join(' AND ')}`, p);
    // Only those the family's answer allows are marked given; the rest are left for a decision.
    const go = rows.filter((e) => outcome !== 'given' || !KIND[c.kind].gives || allowed(c, e));
    const res = go.length ? await record(req, id, { entries: go.map((e) => ({ student: e.student, outcome })), mopUp: body.mopUp }) : { saved: 0, failed: [] };
    return { ...res, left: rows.length - go.length };
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

async function list(req, f = {}) {
    const today = todayStr();
    const { rows } = await pool.query(
        `SELECT c.*, c."_id"::text AS "_id",
                (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id") AS students,
                (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'given') AS given,
                (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'absent') AS absent,
                (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."consent" = 'no') AS declined,
                (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."consent" = 'pending') AS unanswered
           FROM "medicalcampaigns" c WHERE c."school" = $1 ORDER BY c."startOn" DESC LIMIT 200`, [S(req.schoolId)]);
    const all = rows.map((r) => decorate(r, today));
    const TABS = [['active', 'Coming up & on now', (c) => ['upcoming', 'running', 'past'].includes(c.phase)], ['draft', 'Drafts', (c) => c.phase === 'draft'],
        ['closed', 'Closed', (c) => c.phase === 'closed'], ['cancelled', 'Cancelled', (c) => c.phase === 'cancelled'], ['all', 'All', () => true]];
    const tab = TABS.find((t) => t[0] === f.tab) || TABS[0];
    return { tab: tab[0], tabs: TABS.map(([key, label, fn]) => ({ key, label, count: all.filter(fn).length })), rows: all.filter(tab[2]) };
}

/** One campaign: the numbers per section and the roster (one section at a time, or all). */
async function detail(req, id, f = {}) {
    const c = decorate(await find(req, id));
    const { rows: sections } = await pool.query(
        `SELECT e."section"::text AS "sectionId", c."className", cs."sectionName",
                count(*)::int AS students,
                count(*) FILTER (WHERE e."outcome" = 'given')::int AS given,
                count(*) FILTER (WHERE e."outcome" = 'absent')::int AS absent,
                count(*) FILTER (WHERE e."outcome" = 'refused')::int AS refused,
                count(*) FILTER (WHERE e."outcome" = 'excluded')::int AS excluded,
                count(*) FILTER (WHERE e."outcome" = '')::int AS waiting,
                count(*) FILTER (WHERE e."consent" = 'no')::int AS declined,
                count(*) FILTER (WHERE e."consent" = 'yes')::int AS agreed,
                count(*) FILTER (WHERE e."consent" = 'pending')::int AS unanswered
           FROM "medicalcampaignentries" e
           LEFT JOIN "classsections" cs ON cs."_id" = e."section"
           LEFT JOIN "classes" c ON c."_id" = COALESCE(e."class", cs."class")
          WHERE e."campaign" = $1
          GROUP BY e."section", c."className", cs."sectionName"
          ORDER BY c."className" NULLS LAST, cs."sectionName" NULLS LAST`, [S(c._id)]);
    const eligible = (x) => (c.consent === 'opt_in' ? x.agreed : x.students - x.declined);
    const per = sections.map((x) => ({ ...x, label: [x.className, x.sectionName].filter(Boolean).join(' – ') || 'No section', eligible: eligible(x), coverage: eligible(x) ? Math.round((x.given / eligible(x)) * 1000) / 10 : null }));
    const total = per.reduce((a, x) => { for (const k of ['students', 'given', 'absent', 'refused', 'excluded', 'waiting', 'declined', 'agreed', 'unanswered', 'eligible']) a[k] = (a[k] || 0) + x[k]; return a; }, {});
    total.coverage = total.eligible ? Math.round((total.given / total.eligible) * 1000) / 10 : null;
    const p = [S(c._id)];
    let where = '';
    if (isUuid(f.sectionId)) { p.push(f.sectionId); where = `AND e."section" = $2::uuid`; }
    const { rows: roster } = await pool.query(
        `SELECT e.*, e."_id"::text AS "_id", e."student"::text AS "studentId", u."name" AS "studentName", u."profileImage" AS "studentPhoto", sp."admissionNumber", sp."rollNumber"
           FROM "medicalcampaignentries" e JOIN "users" u ON u."_id" = e."student" LEFT JOIN "studentprofiles" sp ON sp."user" = e."student"
          WHERE e."campaign" = $1 ${where}
          ORDER BY sp."rollNumber" NULLS LAST, u."name" LIMIT 1000`, p);
    // What the room should know before giving it: allergies on record (the check runs again when it is given).
    const alertsOf = new Map();
    if (c.gives && roster.length) {
        const { rows: al } = await pool.query(
            `SELECT "student"::text AS id, string_agg("allergen", ', ') AS a FROM "medicalallergies"
              WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL AND COALESCE("status",'active') <> 'resolved' GROUP BY "student"`,
            [S(req.schoolId), roster.map((r) => r.studentId)]);
        for (const r of al) alertsOf.set(r.id, r.a);
    }
    return {
        campaign: c, sections: per, total,
        roster: roster.map((r) => ({ ...r, allowed: allowed(c, r), allergies: alertsOf.get(r.studentId) || '', outcomeLabel: OUTCOME[r.outcome]?.label || '', outcomeTone: OUTCOME[r.outcome]?.tone || 'slate' })),
    };
}

/** A child's campaigns, for the family page: upcoming ones to answer, and the last few months'. */
async function forFamily(schoolId, studentId) {
    const { rows } = await pool.query(
        `SELECT c."_id"::text AS "_id", c."number", c."title", c."kind", c."medicine", c."vaccine", c."dose", c."about", c."startOn", c."endOn", c."mopUpOn",
                c."consent", c."consentBy", c."status", e."consent" AS answer, e."consentReason", e."consentAt", e."outcome", e."outcomeAt"
           FROM "medicalcampaignentries" e JOIN "medicalcampaigns" c ON c."_id" = e."campaign"
          WHERE e."student" = $1 AND c."school" = $2 AND c."status" IN ('announced','closed')
            AND COALESCE(c."mopUpOn", c."endOn", c."startOn") > now() - interval '120 days'
          ORDER BY c."startOn" DESC LIMIT 20`, [S(studentId), S(schoolId)]);
    const today = todayStr();
    return rows.map((r) => {
        const d = decorate(r, today);
        const open = r.status === 'announced' && r.consent !== 'none' && !r.outcome && lastDay(r) >= today && (!r.consentBy || dayStr(r.consentBy) >= today);
        return { ...d, canAnswer: open, outcomeLabel: r.outcome ? (r.outcome === 'given' ? d.doneLabel : OUTCOME[r.outcome].label) : '' };
    });
}

/** The sweep: the staff hear on the morning of the day; opt-in families who have not answered get one reminder. */
async function sweep(schoolId, claim) {
    const today = todayStr();
    const { rows } = await pool.query(
        `SELECT * FROM "medicalcampaigns" WHERE "school" = $1 AND "status" = 'announced'
            AND ("startOn" AT TIME ZONE 'UTC')::date <= $2::date + 2 AND COALESCE("mopUpOn","endOn","startOn") >= $2::date - 1`, [S(schoolId), today]);
    for (const c of rows) {
        if (dayStr(c.startOn) === today && await claim(schoolId, 'campaign_day', `${c._id}:${today}`, 'info')) {
            tell.system(schoolId, { to: await tell.staffIds(schoolId), title: `Today: ${c.title}`, body: `${c.title} (${c.number}) is today. Mark the roster as you go — absentees can be seen on the mop-up day.`, link: { type: 'medical.campaigns' } });
        }
        const askBy = c.consentBy ? dayStr(c.consentBy) : dayStr(c.startOn);
        if (c.consent === 'opt_in' && askBy >= today && askBy <= addDays(today, 2) && await claim(schoolId, 'campaign_ask', S(c._id), 'info')) {
            const { rows: quiet } = await pool.query(`SELECT "student"::text AS id FROM "medicalcampaignentries" WHERE "campaign" = $1 AND "consent" = 'pending' AND "outcome" = ''`, [S(c._id)]);
            const cards = await access.studentCards(schoolId, quiet.map((q) => q.id));
            for (const q of quiet) {
                const name = cards.get(q.id)?.name || 'your child';
                tell.system(schoolId, { to: await tell.parentIds(q.id), title: `Reminder: ${c.title} — ${name}`, body: `${familyText(c, name)}`, link: { type: 'medical.child', params: { child: q.id, tab: 'campaigns' } } });
            }
        }
    }
}

module.exports = { KIND, CONSENT, OUTCOME, create, update, announce, cancel, close, reopen, familyAnswer, record, markRest, list, detail, forFamily, sweep, decorate };
