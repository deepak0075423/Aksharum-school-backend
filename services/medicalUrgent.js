'use strict';
/**
 * Urgent news a family must answer (Oct 2026) — services for the
 * MedicalUrgentNotice record.
 *
 *   open         an emergency, a child sent home, a hospital referral or a
 *                serious incident: the parents are told in the app, live (by
 *                the caller, as before), and the clock starts
 *   acknowledge  a parent answers in the app ("on my way, 20 min"), or a
 *                member of staff records that they reached someone
 *   attempt      a call the staff made, and how it went
 *   close        done — and done by itself when the child is collected
 *   tick         every minute: a notice nobody has answered after the
 *                school's urgentEscalateMinutes moves to the next contact —
 *                the parents are reminded in the app (urgent) and the medical
 *                staff told whom to ring; when the list runs out the staff and
 *                the school admins are told that nobody has been reached
 *
 * The school sends no text messages: the app's live notifications, the
 * school's email for urgent news, and the staff's own calls are the channels.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const MedicalUrgentNotice = require('../models/MedicalUrgentNotice');
const tell = require('./medicalNotify');
const audit = require('./medicalAudit');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const live = require('./medicalLive');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, isUuid } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const plain = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);

const KIND = { emergency: 'Medical emergency', sent_home: 'Sent home', referred: 'Hospital referral', incident: 'Serious incident' };
// The parents' switch each kind of news is sent behind — a reminder follows the same switch as the news.
const PARENT_SETTING = { emergency: 'parentVisit', sent_home: 'parentSentHome', referred: 'parentReferral', incident: 'parentIncident' };
const RESULT = {
    sent: 'Sent', answered: 'Answered', no_answer: 'No answer', busy: 'Busy',
    wrong_number: 'Wrong number', left_message: 'Left a message',
};
const CALL_RESULTS = ['answered', 'no_answer', 'busy', 'wrong_number', 'left_message'];
const LIVE_STATUSES = ['open', 'escalated'];

/** The people to try, in order: the parents, the emergency contact, the alternate — those with a phone. */
async function callTree(schoolId, studentId) {
    const { collectorsFor } = require('./medicalCase');
    return (await collectorsFor(schoolId, studentId)).filter((c) => c.phone);
}

async function findNotice(req, id) {
    if (!isUuid(id)) notFound('Urgent notice');
    const n = await MedicalUrgentNotice.findOne({ _id: id, school: req.schoolId }).lean();
    if (!n) notFound('Urgent notice');
    return n;
}

/**
 * Nobody has answered: the parents are reminded in the app — urgent, live on
 * the web and the phone, in each parent's language — behind the switch the
 * news itself went out behind. The attempt to record, or null when nobody was told.
 */
async function remindParents(n, name, settings) {
    const setting = PARENT_SETTING[n.kind];
    if (setting && settings.notify?.[setting] === false) return null;
    const parents = await tell.parentIds(n.student);
    if (!parents.length) return null;
    const phone = settings.roomPhone || '';
    await tell.system(n.school, {
        to: parents, priority: 'high', email: false,
        link: { type: 'medical.child', params: { child: S(n.student), tab: 'visits' } },
        title: `Please answer — ${name}`,
        body: `The school is still waiting to hear from you about ${name} (${KIND[n.kind].toLowerCase()}). Please open the Medical Room page and answer, or call the school${phone ? ` on ${phone}` : ''}.`,
        i18n: { key: 'urgent_reminder', vars: { name, kind: n.kind, phone } },
    });
    return { at: new Date(), by: null, byName: 'Automatic', channel: 'app', to: 'Parents (app) — reminder', result: 'sent', note: '' };
}

const NOT_ANSWERED = { ackBy: null, ackByName: '', ackAt: null, ackNote: '', ackEtaMinutes: null };

/** The family answered: the visit says the parent was contacted, and how. */
async function markVisitReached(req, n, note) {
    if (!n.visit) return;
    try {
        const MedicalVisit = require('../models/MedicalVisit');
        await patch(MedicalVisit, n.visit, { parentContacted: true, parentContactedAt: new Date(), parentContactNote: str(note, 300) }, { where: { school: req.schoolId } });
    } catch (e) { console.error('[medical] could not mark the parent contacted:', e.message); }
}

/**
 * open(req, { studentId, visit?, incident?, kind, title, body, setting? })
 * One notice per case. The same news again changes nothing; new news about
 * the same case (sent home, then referred to hospital) opens it again from
 * the first contact, keeping the call log — the family has to hear it.
 * `setting` is the parents' notification switch: when it is off the app
 * notice was not sent, but the staff still have to reach the family.
 */
async function open(req, { studentId, visit = null, incident = null, kind, title = '', body = '', setting = null }) {
    try {
        const scope = visit ? { visit: S(visit) } : incident ? { incident: S(incident) } : null;
        const existing = scope
            ? await MedicalUrgentNotice.findOne({ school: req.schoolId, student: studentId, status: { $in: [...LIVE_STATUSES, 'acknowledged'] }, ...scope }).lean()
            : null;
        if (existing && existing.kind === kind) return existing;
        const settings = await settingsSvc.get(req.schoolId);
        const minutes = Number(settings.urgentEscalateMinutes) || 10;
        const contacts = await callTree(req.schoolId, studentId);
        const now = new Date();
        const attempts = [];
        if (!setting || settings.notify?.[setting] !== false) {
            attempts.push({ at: now, by: req.userId ? S(req.userId) : null, byName: who(req) || 'Medical Room', channel: 'app', to: 'Parents (app)', result: 'sent', note: title });
        }
        const fields = { kind, title, body, contacts, step: 0, status: 'open', nextEscalationAt: new Date(now.getTime() + minutes * 60000), ...NOT_ANSWERED };
        const row = existing
            ? await patch(MedicalUrgentNotice, existing._id, fields, { push: { attempts }, where: { school: req.schoolId } })
            : plain(await MedicalUrgentNotice.create({ school: req.schoolId, student: studentId, visit, incident, ...fields, attempts, createdBy: req.userId || null }));
        live.changed(req, 'urgent', { id: S(row._id), urgent: true });
        return row;
    } catch (e) {
        console.error('[medical] urgent notice failed:', e.message);
        return null;
    }
}

/** A parent answers in the app. */
async function acknowledge(req, id, body = {}) {
    const n = await findNotice(req, id);
    if (n.status === 'closed') refuse('This is closed — the school has dealt with it');
    if (req.userRole === 'parent') await access.familyChild(req, S(n.student));
    const note = str(body.note, 300);
    const eta = num(body.etaMinutes);
    if (eta !== null && (eta < 0 || eta > 600)) refuse('Say how long, in minutes');
    const attempt = { at: new Date(), by: S(req.userId), byName: who(req), channel: 'app', to: who(req), result: 'answered', note: [note, eta !== null ? `ETA ${eta} min` : ''].filter(Boolean).join(' · ') };
    const row = await patch(MedicalUrgentNotice, id, {
        status: 'acknowledged', ackBy: req.userId, ackByName: who(req), ackAt: new Date(), ackNote: note, ackEtaMinutes: eta, nextEscalationAt: null,
    }, { push: { attempts: attempt }, where: { school: req.schoolId } });
    audit.log(req, { action: 'acknowledged', entity: 'urgent_notice', entityId: id, student: n.student, summary: `${who(req)} answered the ${KIND[n.kind].toLowerCase()} notice${note ? ` — ${note}` : ''}${eta !== null ? ` (${eta} min)` : ''}` });
    await markVisitReached(req, n, `${who(req)} answered in the app${eta !== null ? ` — arriving in about ${eta} min` : ''}${note ? ` — ${note}` : ''}`);
    const card = await access.studentCard(req.schoolId, n.student);
    tell.toStaff(req, {
        title: `${who(req)} answered — ${card?.name || 'a student'}`,
        body: `${who(req)} answered the ${KIND[n.kind].toLowerCase()} notice about ${card?.name || 'a student'}${note ? `: "${note}"` : ''}${eta !== null ? ` · arriving in about ${eta} min` : ''}.`,
        link: { type: 'medical.room' },
    });
    live.changed(req, 'urgent', { id: S(id) });
    return row;
}

/**
 * A call the staff made: body { contact (key) | to, phone?, channel: call|whatsapp, result, note }.
 * "Answered" counts as the family reached.
 */
async function attempt(req, id, body = {}) {
    const n = await findNotice(req, id);
    if (n.status === 'closed') refuse('This notice is closed');
    const result = oneOf(body.result, Object.fromEntries(CALL_RESULTS.map((k) => [k, 1])), null);
    if (!result) refuse('Say how the call went');
    const c = (n.contacts || []).find((x) => x.key === body.contact);
    const to = c ? `${c.name}${c.relation ? ` (${c.relation})` : ''}` : str(body.to, 120);
    if (!to) refuse('Who was called?');
    const note = str(body.note, 300);
    const channel = oneOf(body.channel, { call: 1, whatsapp: 1 }, 'call');
    const entry = { at: new Date(), by: S(req.userId), byName: who(req), channel, to, phone: c?.phone || str(body.phone, 30), result, note };
    const set = {};
    if (result === 'answered') Object.assign(set, { status: 'acknowledged', ackByName: `${to} (by phone, recorded by ${who(req)})`, ackAt: new Date(), ackNote: note, nextEscalationAt: null });
    const row = await patch(MedicalUrgentNotice, id, set, { push: { attempts: entry }, where: { school: req.schoolId } });
    audit.log(req, { action: 'call_logged', entity: 'urgent_notice', entityId: id, student: n.student, summary: `Called ${to}: ${RESULT[result]}${note ? ` — ${note}` : ''}` });
    if (result === 'answered') await markVisitReached(req, n, `${to} reached by phone${note ? ` — ${note}` : ''}`);
    live.changed(req, 'urgent', { id: S(id) });
    return row;
}

async function close(req, id, body = {}) {
    const n = await findNotice(req, id);
    if (n.status === 'closed') return n;
    const note = str(body.note, 300);
    const row = await patch(MedicalUrgentNotice, id, { status: 'closed', closedAt: new Date(), closedBy: req.userId, closeNote: note, nextEscalationAt: null }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'closed', entity: 'urgent_notice', entityId: id, student: n.student, summary: `Closed the ${KIND[n.kind].toLowerCase()} notice${note ? ` — ${note}` : ''}` });
    live.changed(req, 'urgent', { id: S(id) });
    return row;
}

/** The child has been collected: the notice about the visit is done. */
async function closeForVisit(req, visitId, note) {
    const n = await MedicalUrgentNotice.findOne({ school: req.schoolId, visit: visitId, status: { $in: [...LIVE_STATUSES, 'acknowledged'] } }).lean();
    if (n) await close(req, n._id, { note });
}

/* ── The minute ticker ────────────────────────────────────────────────────── */

async function tick() {
    const now = new Date();
    const due = await MedicalUrgentNotice.find({ status: 'open', nextEscalationAt: { $lte: now } }).lean();
    for (const n of due) {
        try {
            const settings = await settingsSvc.get(n.school);
            const minutes = Number(settings.urgentEscalateMinutes) || 10;
            const card = await access.studentCard(n.school, n.student);
            const name = card?.name || 'a student';
            const staff = await tell.staffIds(n.school);
            const contacts = n.contacts || [];
            const step = (n.step || 0) + 1;
            const waited = Math.round((now - new Date(n.createdAt)) / 60000);
            // Claimed first (still open, still at the step read): a second
            // server, or a parent answering this second, means nothing is sent twice.
            const claim = { status: 'open', step: n.step || 0 };
            if (step < contacts.length) {
                const c = contacts[step];
                const row = await patch(MedicalUrgentNotice, n._id, { step, nextEscalationAt: new Date(now.getTime() + minutes * 60000) }, { where: claim });
                if (!row) continue;
                const reminded = await remindParents(n, name, settings);
                if (reminded) await patch(MedicalUrgentNotice, n._id, {}, { push: { attempts: reminded } });
                await tell.system(n.school, {
                    to: staff, priority: 'high', link: { type: 'medical.room' },
                    title: `No answer yet — ${name}`,
                    body: `Nobody has answered the ${KIND[n.kind].toLowerCase()} notice about ${name} in ${waited} min. Call ${c.name}${c.relation ? ` (${c.relation})` : ''} on ${c.phone}.`,
                });
            } else {
                const row = await patch(MedicalUrgentNotice, n._id, { status: 'escalated', nextEscalationAt: null }, { where: claim });
                if (!row) continue;
                const reminded = await remindParents(n, name, settings);
                if (reminded) await patch(MedicalUrgentNotice, n._id, {}, { push: { attempts: reminded } });
                const { schoolAdminIds } = require('./notifyService');
                const admins = (await schoolAdminIds(n.school)).map(S);
                await tell.system(n.school, {
                    to: [...new Set([...staff.map(S), ...admins])], priority: 'high', link: { type: 'medical.room' },
                    title: `Nobody reached — ${name}`,
                    body: `${contacts.length ? `All ${contacts.length} contact${contacts.length === 1 ? '' : 's'} on record were tried` : 'There is no phone number on record'} and nobody has answered about ${name} (${KIND[n.kind].toLowerCase()}, ${waited} min). Decide what happens next.`,
                });
            }
            live.toStaff(n.school, { kind: 'urgent', id: S(n._id), urgent: true });
        } catch (e) { console.error('[medical] urgent escalation failed:', e.message); }
    }
    // Nothing stays urgent for ever.
    await pool.query(`UPDATE "medicalurgentnotices" SET "status" = 'closed', "closedAt" = now(), "closeNote" = 'Closed after 24 hours', "nextEscalationAt" = NULL, "updatedAt" = now()
                       WHERE "status" IN ('open','acknowledged','escalated') AND "createdAt" < now() - interval '24 hours'`);
    return due.length;
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** For the desk: everything still open or escalated, and what was answered in the last 12 hours. */
async function forDesk(req) {
    const { rows } = await pool.query(
        `SELECT n.*, u."name" AS "studentName", u."profileImage" AS "studentPhoto"
           FROM "medicalurgentnotices" n JOIN "users" u ON u."_id" = n."student"
          WHERE n."school" = $1 AND (n."status" IN ('open','escalated') OR (n."status" = 'acknowledged' AND n."ackAt" > now() - interval '12 hours'))
          ORDER BY CASE n."status" WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, n."createdAt" ASC`,
        [S(req.schoolId)],
    );
    const cards = await access.studentCards(req.schoolId, rows.map((r) => r.student));
    return { items: rows.map((r) => ({ ...r, classLabel: cards.get(S(r.student))?.classLabel || '', kindLabel: KIND[r.kind] })) };
}

/** For the family page: what about this child is still waiting for an answer, or was answered today. */
async function forFamily(schoolId, studentId) {
    const { rows } = await pool.query(
        `SELECT "_id"::text AS "_id", "kind", "title", "body", "status", "createdAt", "ackAt", "ackByName", "ackNote", "ackEtaMinutes"
           FROM "medicalurgentnotices" WHERE "school" = $1 AND "student" = $2
            AND ("status" IN ('open','escalated') OR ("status" = 'acknowledged' AND "ackAt" > now() - interval '12 hours'))
          ORDER BY "createdAt" DESC LIMIT 5`,
        [S(schoolId), S(studentId)],
    );
    return rows.map((r) => ({ ...r, kindLabel: KIND[r.kind] }));
}

module.exports = { KIND, RESULT, CALL_RESULTS, open, acknowledge, attempt, close, closeForVisit, tick, forDesk, forFamily, callTree };
