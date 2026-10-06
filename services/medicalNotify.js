'use strict';
/**
 * Who the Medical Room tells, and what (Oct 2026). Built on the app's one
 * notification service (services/notifyService) — no new channel.
 *
 *   parents   every parent the school has linked to the child (both links)
 *   teachers  the teacher who sent the student, and the child's class and
 *             vice class teacher
 *   staff     whoever administers the module: the school admins and any
 *             teacher whose designation grants Medical admin (a nurse)
 *
 * Each message is behind a switch in the school's settings (medicalSettings
 * NOTIFY_DEFAULTS). What a teacher or a parent is told is written for them:
 * no private notes, no diagnosis beyond what the medical room chose to say.
 */
const pool = require('../db/pool');
const { notify, withParents } = require('./notifyService');
const designations = require('./designationService');
const settingsSvc = require('./medicalSettings');

async function staffIds(schoolId) {
    try { return (await designations.moduleAdminIds(schoolId, 'medical')).map(String); }
    catch (e) { console.error('[medical] staff lookup failed:', e.message); return []; }
}

async function parentIds(studentId) {
    const all = await withParents([String(studentId)]);
    return all.filter((id) => String(id) !== String(studentId));
}

/** The class teacher and vice class teacher of the student's current section. */
async function classTeacherIds(schoolId, studentId) {
    try {
        const { rows } = await pool.query(
            `SELECT cs."classTeacher"::text AS a, cs."substituteTeacher"::text AS b
               FROM "studentprofiles" sp JOIN "classsections" cs ON cs."_id" = sp."currentSection"
              WHERE sp."user" = $1 AND sp."school" = $2 LIMIT 1`,
            [String(studentId), String(schoolId)],
        );
        return [rows[0]?.a, rows[0]?.b].filter(Boolean);
    } catch { return []; }
}

/**
 * send(req, { to, title, body, link, priority, email, setting })
 * `setting` names the switch that must be on; `to` is a list of user ids.
 */
async function send(req, { to = [], title, body, link = null, priority = null, email = false, setting = null }) {
    try {
        if (!to.length) return;
        if (setting) {
            const s = await settingsSvc.get(req.schoolId);
            if (s.notify?.[setting] === false) return;
        }
        notify({
            school: req.schoolId,
            sender: req.userId,
            senderRole: req.userRole || 'system',
            title, body,
            recipients: to,
            link,
            priority,
            email,
        });
    } catch (e) { console.error('[medical] notify failed:', e.message); }
}

/**
 * To the child's parents, behind `setting`. Email when the school wants urgent news emailed.
 * `i18n: { key, vars }` writes to each parent in their language (services/medicalLang) —
 * the English is `title`/`body` as given.
 */
async function toParents(req, studentId, { title, body, setting, urgent = false, tab = 'overview', params = {}, i18n = null }) {
    const s = await settingsSvc.get(req.schoolId);
    if (setting && s.notify?.[setting] === false) return;
    const to = await parentIds(studentId);
    const base = {
        link: { type: 'medical.child', entityId: null, params: { child: String(studentId), tab, ...params } },
        priority: urgent ? 'high' : null,
        email: urgent && s.notify?.emailUrgent !== false,
    };
    if (!i18n) { await send(req, { to, title, body, ...base }); return; }
    const lang = require('./medicalLang');
    for (const [l, ids] of await lang.groups(req.schoolId, to)) {
        const m = lang.render(i18n.key, i18n.vars, l, { title, body });
        await send(req, { to: ids, title: m.title, body: m.body, ...base });
    }
}

/** To the medical staff, behind `setting`; never to the person who did it. */
async function toStaff(req, { title, body, setting, link = { type: 'medical.desk' }, urgent = false, email = false }) {
    const to = (await staffIds(req.schoolId)).filter((id) => id !== String(req.userId));
    await send(req, { to, title, body, link, setting, priority: urgent ? 'high' : null, email });
}

/**
 * To the teacher who sent the student and the child's class teachers. Two
 * links: the sender opens their request; a class teacher, who never sees
 * another teacher's request, opens their Medical Room page — a link to "My
 * Requests" took them to a list that did not have it.
 */
async function toTeachers(req, { studentId, requesterId = null, title, body, setting = 'teacherStatus', includeClass = true, requestId = null }) {
    const me = String(req.userId);
    const requester = requesterId && String(requesterId) !== me ? String(requesterId) : null;
    const others = new Set();
    if (includeClass) for (const id of await classTeacherIds(req.schoolId, studentId)) if (id !== me && id !== requester) others.add(id);
    if (requester) {
        await send(req, {
            to: [requester], title, body, setting,
            link: { type: 'medical.mine', entityId: requestId ? String(requestId) : null, params: { tab: 'requests' } },
        });
    }
    if (others.size) await send(req, { to: [...others], title, body, setting, link: { type: 'medical.mine', entityId: null } });
}

/**
 * A notice with no acting user — from the sweep. `notify` needs a sender, so
 * the school's first admin sends it, and is kept among the recipients.
 */
async function system(schoolId, { to, title, body, link = null, priority = null, email = false, setting = null, i18n = null }) {
    try {
        if (!to?.length) return;
        if (setting) {
            const s = await settingsSvc.get(schoolId);
            if (s.notify?.[setting] === false) return;
        }
        const { schoolAdminIds } = require('./notifyService');
        const admins = (await schoolAdminIds(schoolId)).map(String);
        const sender = admins[0] || String(to[0]);
        // Parents written to in their language (services/medicalLang); the English is title/body as given.
        if (i18n) {
            const lang = require('./medicalLang');
            for (const [l, ids] of await lang.groups(schoolId, to)) {
                const m = lang.render(i18n.key, i18n.vars, l, { title, body });
                notify({ school: schoolId, sender, senderRole: 'system', title: m.title, body: m.body, recipients: ids, includeSender: true, link, priority, email });
            }
            return;
        }
        notify({ school: schoolId, sender, senderRole: 'system', title, body, recipients: to, includeSender: true, link, priority, email });
    } catch (e) { console.error('[medical] system notice failed:', e.message); }
}

module.exports = { staffIds, parentIds, classTeacherIds, send, toParents, toStaff, toTeachers, system };
