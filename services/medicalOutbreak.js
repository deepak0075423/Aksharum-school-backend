'use strict';
/**
 * The outbreak watch (Oct 2026). Every quarter hour the sweep counts, per
 * illness, the children with it in the last few days — from Medical Room
 * visits, children kept off school (exclusions) and the illnesses families
 * report — and when one section (or class, or the school) reaches the rule's
 * number, an outbreak is opened and the medical staff are told.
 *
 * The staff confirm it, keep notes, record a report to the health authority,
 * send a notice to the families (and class teachers) of the section, class or
 * school, and close it — or it closes itself after a quiet fortnight. Who the
 * cases are is for the medical staff only: a notice that names one of the
 * children is refused.
 *
 * Families can also tell the school "my child is off sick" (an illness
 * report): the room reads it, and it counts towards the watch.
 */
const pool = require('../db/pool');
const MedicalOutbreak = require('../models/MedicalOutbreak');
const MedicalIllnessReport = require('../models/MedicalIllnessReport');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const numbers = require('./medicalNumber');
const settingsSvc = require('./medicalSettings');
const { patch } = require('../db/patch');
const R = require('./medicalRules');

const { refuse, str, num, isUuid, todayStr, dayStr, dayLabel, instantLabel, toDay, addDays } = R;
const S = (v) => String(v);

const RULES = {
    flu: {
        label: 'Fever or flu-like illness', cases: 5, days: 3, scope: 'section',
        words: ['fever', 'flu', 'cough', 'cold', 'sore throat', 'body ache'], exclusions: ['fever', 'flu', 'covid'],
        advice: 'Watch for fever, cough and a sore throat. Keep a child with a fever at home until 24 hours after it has gone without fever medicine, and remind them to cover coughs and wash their hands.',
    },
    gi: {
        label: 'Vomiting or diarrhoea', cases: 3, days: 2, scope: 'section',
        words: ['vomit', 'diarrh', 'loose motion', 'nausea', 'gastro'], exclusions: ['vomiting'],
        advice: 'Watch for vomiting and diarrhoea. Keep your child at home until 48 hours after the last episode, give plenty of fluids (ORS), and make sure hands are washed with soap before eating and after the toilet.',
    },
    eye: {
        label: 'Conjunctivitis (red, sticky eyes)', cases: 3, days: 4, scope: 'section',
        words: ['conjunctivitis', 'pink eye', 'red eye', 'eye irritation', 'eye infection', 'sticky eye', 'eye flu'], exclusions: ['conjunctivitis'],
        advice: 'Watch for red, watery or sticky eyes. Keep your child at home until the eyes are no longer discharging, do not share towels, and see a doctor if it does not settle.',
    },
    rash: {
        label: 'Rash, chickenpox or measles', cases: 2, days: 10, scope: 'section',
        words: ['rash', 'pox', 'measles', 'hand foot', 'hfmd', 'blister', 'spots', 'rubella'], exclusions: ['chickenpox', 'measles', 'rubella', 'hand_foot_mouth'],
        advice: 'Watch for a fever with a rash, spots or blisters. Keep your child at home and see a doctor, and tell the school if a doctor confirms an illness.',
    },
    mumps: {
        label: 'Mumps', cases: 2, days: 21, scope: 'class',
        words: ['mumps', 'swollen jaw', 'parotid'], exclusions: ['mumps'],
        advice: 'Watch for a fever with painful swelling below the ears. Keep your child at home and see a doctor; a child with mumps stays home for 5 days after the swelling starts.',
    },
    water: {
        label: 'Jaundice or typhoid (water-borne)', cases: 2, days: 30, scope: 'school',
        words: ['jaundice', 'hepatitis', 'typhoid', 'enteric'], exclusions: ['hepatitis_a', 'typhoid'],
        advice: 'Give your child boiled or filtered water, make sure hands are washed before eating, and see a doctor for a fever lasting more than three days or yellow eyes.',
    },
    school_fever: {
        label: 'Fever across the school', cases: 15, days: 2, scope: 'school',
        words: ['fever'], exclusions: ['fever', 'flu'],
        advice: 'More children than usual have had a fever this week. Keep a child with a fever at home until 24 hours after it has gone without fever medicine.',
    },
};
const SYMPTOMS = {
    fever: 'Fever', cough: 'Cough or cold', vomiting: 'Vomiting', diarrhoea: 'Diarrhoea', red_eyes: 'Red or sticky eyes',
    rash: 'Rash or spots', swelling: 'Swelling below the ears', jaundice: 'Yellow eyes or skin', other: 'Something else',
};
// What a family's ticked sign means to the rules' words.
const SYMPTOM_WORDS = { fever: 'fever', cough: 'cough cold', vomiting: 'vomiting', diarrhoea: 'diarrhoea', red_eyes: 'red eye conjunctivitis', rash: 'rash spots', swelling: 'swollen jaw mumps', jaundice: 'jaundice', other: '' };
const STATUS = { watching: { label: 'Watching', tone: 'amber' }, confirmed: { label: 'Outbreak confirmed', tone: 'red' }, closed: { label: 'Closed', tone: 'slate' } };

/** The rules in force: the defaults with the school's changes. */
function rulesOf(s) {
    const ch = s?.outbreakRules || {};
    return Object.entries(RULES).map(([key, r]) => {
        const c = ch[key] || {};
        return {
            key, ...r, off: !!c.off,
            cases: Math.min(50, Math.max(2, Math.round(num(c.cases) || r.cases))),
            days: Math.min(30, Math.max(1, Math.round(num(c.days) || r.days))),
            advice: str(c.advice, 600) || r.advice,
        };
    });
}

/** Validate the Settings screen's changes. */
function validateRules(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== 'object') refuse('The outbreak rules are not in the right shape');
    const out = {};
    for (const [key, c] of Object.entries(raw)) {
        if (!RULES[key] || !c || typeof c !== 'object') continue;
        const o = {};
        if (c.off !== undefined) o.off = !!c.off;
        if (c.cases !== undefined) { const n = Math.round(num(c.cases) ?? 0); if (n < 2 || n > 50) refuse(`${RULES[key].label}: the number of children is between 2 and 50`); if (n !== RULES[key].cases) o.cases = n; }
        if (c.days !== undefined) { const n = Math.round(num(c.days) ?? 0); if (n < 1 || n > 30) refuse(`${RULES[key].label}: the number of days is between 1 and 30`); if (n !== RULES[key].days) o.days = n; }
        if (c.advice !== undefined) { const a = str(c.advice, 600); if (a && a !== RULES[key].advice) o.advice = a; }
        if (Object.keys(o).length) out[key] = o;
    }
    return out;
}

const matches = (rule, c) => (c.exclusionRule ? rule.exclusions.includes(c.exclusionRule) : rule.words.some((w) => c.text.includes(w)));

/** Every case of the last `days` days, with where the child is. */
async function casesSince(schoolId, days) {
    const since = new Date(Date.now() - days * 86400000);
    const sql = `
        SELECT 'visit' AS source, v."_id"::text AS "sourceId", v."student"::text AS student, v."arrivedAt" AS on,
               lower(concat_ws(' ', v."reason", v."symptoms")) AS text, NULL::text AS "exclusionRule"
          FROM "medicalvisits" v WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."arrivedAt" >= $2
        UNION ALL
        SELECT 'exclusion', x."_id"::text, x."student"::text, x."from", lower(concat_ws(' ', x."label", x."note")), x."rule"
          FROM "medicalexclusions" x WHERE x."school" = $1 AND x."status" <> 'cancelled' AND x."from" >= $2
        UNION ALL
        SELECT 'report', r."_id"::text, r."student"::text, r."from", lower(concat_ws(' ', array_to_string(ARRAY(SELECT jsonb_array_elements_text(r."symptoms")), ' '), r."note")), NULL
          FROM "medicalillnessreports" r WHERE r."school" = $1 AND r."status" <> 'withdrawn' AND r."from" >= $2`;
    const { rows } = await pool.query(sql, [S(schoolId), since]);
    if (!rows.length) return [];
    const cards = await access.studentCards(schoolId, rows.map((r) => r.student));
    return rows.map((r) => {
        const card = cards.get(r.student);
        let text = r.text || '';
        if (r.source === 'report') for (const [k, w] of Object.entries(SYMPTOM_WORDS)) if (text.includes(k)) text += ` ${w}`;
        return { ...r, text, section: card?.sectionId || null, class: card?.classId || null, sectionLabel: card?.classLabel || '', className: card?.className || '', active: card?.isActive !== false };
    }).filter((r) => r.active);
}

function scopeOf(rule, c) {
    if (rule.scope === 'school') return { kind: 'school', id: '', label: 'the whole school' };
    if (rule.scope === 'class') return c.class ? { kind: 'class', id: c.class, label: c.className ? `Class ${c.className}`.replace(/^Class Class /, 'Class ') : 'one class' } : null;
    return c.section ? { kind: 'section', id: c.section, label: c.sectionLabel || 'one section' } : null;
}

/** The sweep's look: open (or add to) an outbreak per cluster; close the quiet ones. */
async function watch(schoolId, s, claim) {
    if (s.outbreakWatch === false) return { opened: 0 };
    const rules = rulesOf(s).filter((r) => !r.off);
    if (!rules.length) return { opened: 0 };
    const all = await casesSince(schoolId, Math.max(...rules.map((r) => r.days)));
    let opened = 0;
    const staff = all.length ? await tell.staffIds(schoolId) : [];
    for (const rule of rules) {
        const since = Date.now() - rule.days * 86400000;
        const groups = new Map();
        for (const c of all) {
            if (new Date(c.on).getTime() < since || !matches(rule, c)) continue;
            const scope = scopeOf(rule, c);
            if (!scope) continue;
            const k = `${scope.kind}:${scope.id}`;
            if (!groups.has(k)) groups.set(k, { scope, cases: new Map() });
            const g = groups.get(k);
            const prev = g.cases.get(c.student);
            if (!prev || new Date(c.on) > new Date(prev.on)) g.cases.set(c.student, c);
        }
        for (const { scope, cases } of groups.values()) {
            const subject = `${rule.key}:${scope.kind}:${scope.id}`;
            // Cases already counted in an outbreak of this illness here — open, or closed recently —
            // never count again: closing one while its cases are still in the window must not reopen it.
            const { rows: before } = await pool.query(
                `SELECT * FROM "medicaloutbreaks" WHERE "school" = $1 AND "rule" = $2 AND "scope"->>'kind' = $3 AND COALESCE("scope"->>'id','') = $4
                    AND ("status" <> 'closed' OR "closedAt" > now() - interval '60 days') ORDER BY "createdAt" DESC`,
                [S(schoolId), rule.key, scope.kind, scope.id]);
            const known = new Set(before.flatMap((o) => (o.cases || []).map((c) => `${c.student}:${c.sourceId}`)));
            const list = [...cases.values()].filter((c) => !known.has(`${c.student}:${c.sourceId}`))
                .map((c) => ({ student: c.student, source: c.source, sourceId: c.sourceId, on: c.on }));
            const open = before.find((o) => o.status !== 'closed');
            if (open) {
                if (list.length) {
                    const last = list.reduce((m, c) => (new Date(c.on) > m ? new Date(c.on) : m), new Date(open.lastCaseAt || 0));
                    await patch(MedicalOutbreak, open._id, { lastCaseAt: last }, { push: { cases: list } });
                }
                continue;
            }
            // A child already counted (in a closed outbreak) is not a new case either.
            const counted = new Set(before.flatMap((o) => (o.cases || []).map((c) => c.student)));
            if (list.filter((c) => !counted.has(c.student)).length < rule.cases) continue;
            // One open outbreak per illness and place: claimed before it is written.
            if (!(await claim(schoolId, 'outbreak', subject, 'warning'))) continue;
            const times = list.map((c) => new Date(c.on).getTime());
            const row = await MedicalOutbreak.create({
                school: schoolId, number: await numbers.next(schoolId, 'outbreak'), rule: rule.key, label: rule.label, scope,
                status: 'watching', cases: list, firstCaseAt: new Date(Math.min(...times)), lastCaseAt: new Date(Math.max(...times)),
                log: [{ at: new Date(), by: null, byName: 'Outbreak watch', text: `${list.length} children with ${rule.label.toLowerCase()} in ${rule.days} day${rule.days === 1 ? '' : 's'} (${scope.label}).` }],
            });
            opened += 1;
            tell.system(schoolId, {
                to: staff, priority: 'high', link: { type: 'medical.outbreaks', entityId: S(row._id) },
                title: `Possible outbreak — ${rule.label} (${scope.label})`,
                body: `${list.length} children in ${scope.label} have had ${rule.label.toLowerCase()} in the last ${rule.days} day${rule.days === 1 ? '' : 's'}. Open the outbreak watch to look into it.`,
            });
            require('./medicalLive').changed({ schoolId }, 'outbreak', { action: 'opened', id: S(row._id), urgent: true });
        }
    }
    // A fortnight (or twice the rule's window) without a new case: over.
    const { rows: quiet } = await pool.query(`SELECT "_id","rule","scope","lastCaseAt","number" FROM "medicaloutbreaks" WHERE "school" = $1 AND "status" <> 'closed'`, [S(schoolId)]);
    for (const o of quiet) {
        const rule = rules.find((r) => r.key === o.rule) || RULES[o.rule] || { days: 7 };
        const quietDays = Math.max(14, rule.days * 2);
        if (o.lastCaseAt && Date.now() - new Date(o.lastCaseAt).getTime() > quietDays * 86400000) {
            const row = await patch(MedicalOutbreak, o._id, { status: 'closed', closedAt: new Date(), closedByName: 'Outbreak watch', closeNote: `No new case for ${quietDays} days.` }, { where: { status: undefined } });
            if (row) await forget(schoolId, o);
        }
    }
    return { opened };
}

const forget = (schoolId, o) => pool.query(`DELETE FROM "medicalalerts" WHERE "school" = $1 AND "kind" = 'outbreak' AND "subject" = $2`,
    [S(schoolId), `${o.rule}:${o.scope?.kind}:${o.scope?.id || ''}`]);

async function find(req, id) {
    if (!isUuid(id)) refuse('Outbreak not found', 404, 'MEDICAL_NOT_FOUND');
    const { rows } = await pool.query(`SELECT * FROM "medicaloutbreaks" WHERE "_id" = $1 AND "school" = $2`, [id, S(req.schoolId)]);
    if (!rows[0]) refuse('Outbreak not found', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

function decorate(o) {
    const st = STATUS[o.status] || STATUS.watching;
    const distinct = new Set((o.cases || []).map((c) => c.student)).size;
    return { ...o, statusLabel: st.label, tone: st.tone, caseCount: distinct, advice: (RULES[o.rule] || {}).advice || '' };
}

/** A case's day on the school's clock: a family's report is a stored day; a visit's arrival and the time a child
 *  was kept off school are instants. */
const caseDay = (c) => (c.source === 'report' ? dayStr(c.on) : todayStr(new Date(c.on)));

/** Cases per day over the outbreak's span (for the little chart). */
function daily(cases, from, to) {
    const counts = new Map();
    const seen = new Set();
    for (const c of cases || []) {
        const d = caseDay(c);
        const k = `${d}:${c.student}`;
        if (seen.has(k)) continue;
        seen.add(k);
        counts.set(d, (counts.get(d) || 0) + 1);
    }
    const out = [];
    for (let d = from; d <= to && out.length < 60; d = addDays(d, 1)) out.push({ day: d, count: counts.get(d) || 0 });
    return out;
}

/** The first and last days of an outbreak's cases on the school's clock, and its chart: to today while it is open (the last 60 days at most). */
function span(o, cases) {
    const ds = (cases || []).map(caseDay).filter(Boolean).sort();
    const today = todayStr();
    const firstDay = ds[0] || today;
    const lastDay = ds[ds.length - 1] || firstDay;
    const end = o.status === 'closed' || lastDay > today ? lastDay : today;
    const start = firstDay > addDays(end, -59) ? firstDay : addDays(end, -59);
    return { firstDay, lastDay, days: daily(cases, start, end) };
}

async function list(req, f = {}) {
    const { rows } = await pool.query(`SELECT * FROM "medicaloutbreaks" WHERE "school" = $1 ORDER BY CASE WHEN "status" = 'closed' THEN 1 ELSE 0 END, "lastCaseAt" DESC NULLS LAST LIMIT 200`, [S(req.schoolId)]);
    const all = rows.map(decorate);
    const TABS = [['open', 'Open', (o) => o.status !== 'closed'], ['closed', 'Closed', (o) => o.status === 'closed'], ['all', 'All', () => true]];
    const tab = TABS.find((t) => t[0] === f.tab) || TABS[0];
    const s = await settingsSvc.get(req.schoolId);
    return {
        tab: tab[0], tabs: TABS.map(([key, label, fn]) => ({ key, label, count: all.filter(fn).length })),
        rows: all.filter(tab[2]).map(({ cases, log, notices, ...o }) => ({ ...o, ...span(o, cases) })),
        watching: s.outbreakWatch !== false, rules: rulesOf(s),
        defaults: Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, { label: r.label, cases: r.cases, days: r.days, scope: r.scope, advice: r.advice, words: r.words }])),
    };
}

async function detail(req, id) {
    const o = decorate(await find(req, id));
    const ids = [...new Set((o.cases || []).map((c) => c.student))];
    const cards = await access.studentCards(req.schoolId, ids);
    const cases = (o.cases || []).map((c) => ({ ...c, day: caseDay(c), onLabel: c.source === 'report' ? dayLabel(caseDay(c)) : instantLabel(c.on), name: cards.get(c.student)?.name || 'A student', classLabel: cards.get(c.student)?.classLabel || '', sourceLabel: { visit: 'Medical Room visit', exclusion: 'Kept off school', report: 'Reported by the family' }[c.source] || c.source }))
        .sort((a, b) => new Date(b.on) - new Date(a.on));
    audit.viewed(req, { entity: 'outbreak', entityId: id, summary: `Opened outbreak ${o.number} (${o.label})` });
    return { ...o, cases, ...span(o, o.cases), rule: rulesOf(await settingsSvc.get(req.schoolId)).find((r) => r.key === o.rule) || null };
}

/** The staff act: confirm, note, report to the health authority, close or reopen. */
async function act(req, id, body = {}) {
    const o = await find(req, id);
    const name = req.user?.name || '';
    const entry = (text) => ({ at: new Date(), by: S(req.userId), byName: name, text });
    let set = {}; let push = {}; let summary = '';
    if (body.action === 'confirm') {
        if (o.status !== 'watching') refuse('Only an outbreak being watched can be confirmed');
        set = { status: 'confirmed', confirmedAt: new Date(), confirmedBy: req.userId }; push = { log: [entry('Confirmed as an outbreak.')] }; summary = `Outbreak ${o.number} confirmed`;
    } else if (body.action === 'note') {
        const text = str(body.text, 1500);
        if (text.length < 3) refuse('Write the note');
        push = { log: [entry(text)] }; summary = `Note added to outbreak ${o.number}`;
    } else if (body.action === 'reported') {
        const on = toDay(body.on || todayStr());
        const to = str(body.to, 160);
        if (!on || !to) refuse('Say when and to whom it was reported');
        set = { reported: { on: dayStr(on), to, reference: str(body.reference, 120) } };
        push = { log: [entry(`Reported to ${to} on ${dayLabel(on)}${body.reference ? ` (ref. ${str(body.reference, 120)})` : ''}.`)] }; summary = `Outbreak ${o.number} reported to ${to}`;
    } else if (body.action === 'close') {
        if (o.status === 'closed') refuse('This outbreak is already closed');
        const note = str(body.note, 600);
        if (note.length < 3) refuse('Say why it is closed');
        set = { status: 'closed', closedAt: new Date(), closedBy: req.userId, closedByName: name, closeNote: note }; push = { log: [entry(`Closed: ${note}`)] }; summary = `Outbreak ${o.number} closed`;
    } else if (body.action === 'reopen') {
        if (o.status !== 'closed') refuse('Only a closed outbreak can be reopened');
        set = { status: 'watching', closedAt: null, closedBy: null, closedByName: '', closeNote: '' }; push = { log: [entry('Reopened.')] }; summary = `Outbreak ${o.number} reopened`;
    } else refuse('Unknown action');
    const row = await patch(MedicalOutbreak, id, set, { where: { school: req.schoolId, status: o.status }, push });
    if (!row) refuse('Someone else changed this outbreak — open it again', 409, 'MEDICAL_STALE');
    if (body.action === 'close') await forget(req.schoolId, o);
    if (body.action === 'reopen') await require('./medicalSweep').claim(req.schoolId, 'outbreak', `${o.rule}:${o.scope?.kind}:${o.scope?.id || ''}`, 'warning');
    audit.log(req, { action: `outbreak_${body.action}`, entity: 'outbreak', entityId: id, summary });
    return decorate(row);
}

/** The words a notice starts with, before the staff edit them. */
function noticeDraft(o, audience) {
    const where = audience === 'school' ? 'at school' : o.scope?.label ? `in ${o.scope.label}` : 'at school';
    return `Some children ${where} have had ${String(o.label || 'an illness').toLowerCase()} in the last few days. ${(RULES[o.rule] || {}).advice || ''}`.trim();
}

/** Who a notice reaches: the current students of the section, class or school. */
async function audienceOf(schoolId, o, audience) {
    const p = [S(schoolId)];
    let where = '';
    if (audience === 'section') {
        if (o.scope?.kind !== 'section') refuse('This outbreak is not about one section');
        p.push(o.scope.id); where = `AND sp."currentSection" = $2::uuid`;
    } else if (audience === 'class') {
        let classId = o.scope?.kind === 'class' ? o.scope.id : null;
        if (o.scope?.kind === 'section') classId = (await pool.query(`SELECT "class"::text AS c FROM "classsections" WHERE "_id" = $1`, [o.scope.id])).rows[0]?.c || null;
        if (!classId) refuse('This outbreak is not about one class');
        p.push(classId); where = `AND COALESCE(cs."class", sp."currentClass") = $2::uuid`;
    } else if (audience !== 'school') refuse('Choose who the notice goes to');
    const { rows } = await pool.query(
        `SELECT u."_id"::text AS id, sp."currentSection"::text AS section FROM "users" u JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE ${where}`, p);
    return rows;
}

/** Send a notice to families (and class teachers): it never names a child. */
async function notice(req, id, body = {}) {
    const o = await find(req, id);
    const audience = ['section', 'class', 'school'].includes(body.audience) ? body.audience : null;
    if (!audience) refuse('Choose who the notice goes to');
    const text = str(body.text, 1500) || noticeDraft(o, audience);
    if (text.length < 20) refuse('Write the notice');
    // A child's name in the notice would tell every family who is ill.
    const cards = await access.studentCards(req.schoolId, (o.cases || []).map((c) => c.student));
    // The whole name, first and last together, or the first name as it is written (capitalised,
    // four letters or more — so "will" or "rose" in a sentence is not mistaken for a child).
    const lower = `${text} ${str(body.textHi, 1500)}`.toLowerCase();
    const word = (w, flags = '') => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, `u${flags}`);
    for (const c of cards.values()) {
        const full = String(c.name || '').trim();
        const parts = full.split(/\s+/).filter(Boolean);
        if (!full) continue;
        const both = `${text} ${str(body.textHi, 1500)}`;
        const named = lower.includes(full.toLowerCase())
            || (parts.length > 1 && word(parts[0], 'i').test(both) && word(parts[parts.length - 1], 'i').test(both))
            || (parts[0].length >= 4 && word(parts[0]).test(both));
        if (named) refuse('The notice names one of the children — take the name out', 400, 'MEDICAL_NOTICE_NAMES');
    }
    const kids = await audienceOf(req.schoolId, o, audience);
    if (!kids.length) refuse('No current students are in that group');
    const { withParents } = require('./notifyService');
    const parents = (await withParents(kids.map((k) => k.id))).map(S).filter((pid) => !kids.some((k) => k.id === pid));
    const sections = [...new Set(kids.map((k) => k.section).filter(Boolean))];
    const { rows: tr } = sections.length ? await pool.query(
        `SELECT DISTINCT unnest(ARRAY["classTeacher","substituteTeacher"])::text AS id FROM "classsections" WHERE "_id" = ANY($1::uuid[])`, [sections]) : { rows: [] };
    const teachers = tr.map((t) => t.id).filter(Boolean);
    const title = `Health notice — ${o.label}`;
    // The staff may write it in Hindi too: each family gets the language they read (services/medicalLang).
    const textHi = str(body.textHi, 1500);
    if (parents.length && !textHi) tell.send(req, { to: parents, title, body: text, link: { type: 'medical.child', params: { tab: 'overview' } } });
    if (parents.length && textHi) {
        const lang = require('./medicalLang');
        for (const [l, ids] of await lang.groups(req.schoolId, parents)) {
            const t = l === 'hi' ? { title: `स्वास्थ्य सूचना — ${o.label}`, body: textHi } : l === 'both' ? { title, body: `${text}\n\n${textHi}` } : { title, body: text };
            tell.send(req, { to: ids, title: t.title, body: t.body, link: { type: 'medical.child', params: { tab: 'overview' } } });
        }
    }
    if (teachers.length) tell.send(req, { to: teachers, title, body: `${text} (Sent to the families of ${audience === 'school' ? 'the school' : o.scope?.label || 'the class'}.)`, link: { type: 'medical.mine' } });
    const row = await patch(MedicalOutbreak, id, {}, {
        where: { school: req.schoolId },
        push: {
            notices: [{ at: new Date(), by: S(req.userId), byName: req.user?.name || '', audience, scope: audience === 'school' ? null : (audience === 'section' ? o.scope.id : null), sections, families: parents.length, teachers: teachers.length, text }],
            log: [{ at: new Date(), by: S(req.userId), byName: req.user?.name || '', text: `Notice sent to ${parents.length} parent${parents.length === 1 ? '' : 's'} and ${teachers.length} teacher${teachers.length === 1 ? '' : 's'} (${audience}).` }],
        },
    });
    audit.log(req, { action: 'outbreak_notice', entity: 'outbreak', entityId: id, summary: `Health notice for ${o.number} sent to ${parents.length} parents (${audience})` });
    return { ...decorate(row), sent: { families: parents.length, teachers: teachers.length } };
}

/** The health notices that reached a child's family in the last month (none name a child). */
async function noticesFor(schoolId, studentId) {
    const card = await access.studentCard(schoolId, studentId);
    if (!card) return [];
    const { rows } = await pool.query(
        `SELECT o."label", n AS notice FROM "medicaloutbreaks" o, jsonb_array_elements(o."notices") n
          WHERE o."school" = $1 AND (n->>'at')::timestamptz > now() - interval '30 days'
          ORDER BY (n->>'at')::timestamptz DESC LIMIT 10`, [S(schoolId)]);
    return rows.filter((r) => r.notice.audience === 'school' || (r.notice.sections || []).includes(card.sectionId))
        .map((r) => ({ at: r.notice.at, title: `Health notice — ${r.label}`, text: r.notice.text }));
}

/* ── A family says: off sick ──────────────────────────────────────────────── */

async function reportIllness(req, body = {}) {
    if (req.userRole !== 'parent') refuse('Only a parent can report this', 403, 'MEDICAL_PARENT_ONLY');
    const child = await access.familyChild(req, body.child);
    const from = toDay(body.from || todayStr());
    if (!from) refuse('Choose the day the illness started');
    const today = todayStr();
    if (dayStr(from) < addDays(today, -14) || dayStr(from) > addDays(today, 1)) refuse('The illness started within the last two weeks');
    const to = body.to ? toDay(body.to) : null;
    if (body.to && !to) refuse('The day back is not a date');
    if (to && dayStr(to) < dayStr(from)) refuse('The day back is before the illness started');
    if (to && dayStr(to) > addDays(dayStr(from), 30)) refuse('Report at most 30 days at a time');
    const symptoms = [...new Set((Array.isArray(body.symptoms) ? body.symptoms : []).filter((k) => SYMPTOMS[k]))];
    if (!symptoms.length) refuse('Tick at least one sign');
    const note = str(body.note, 600);
    if (symptoms.includes('other') && note.length < 3) refuse('Say what the illness is');
    const card = await access.studentCard(req.schoolId, child);
    if (card?.isActive === false) refuse(`${card.name} has left the school`, 409, 'MEDICAL_STUDENT_LEFT');
    const row = await MedicalIllnessReport.create({
        school: req.schoolId, student: child, from, to, symptoms, note, reportedBy: req.userId, reportedByName: req.user?.name || '', status: 'new',
    });
    audit.log(req, { action: 'illness_reported', entity: 'illness', entityId: row._id, student: child, summary: `${req.user?.name || 'A parent'} reported ${card?.name || 'their child'} off sick (${symptoms.map((k) => SYMPTOMS[k].toLowerCase()).join(', ')})` });
    // The class teachers hear the child is away (never why); today's mark carries the remark.
    require('./medicalAttendance').onIllnessReport(req, row).catch((e) => console.error('[medical] illness → attendance:', e.message));
    tell.toStaff(req, {
        title: `Off sick — ${card?.name || 'a student'}`,
        body: `${req.user?.name || 'A parent'} says ${card?.name || 'their child'} (${card?.classLabel || ''}) is unwell from ${dayLabel(from)}: ${symptoms.map((k) => SYMPTOMS[k].toLowerCase()).join(', ')}${note ? ` — ${note}` : ''}.`,
        setting: 'staffParentUpdates', link: { type: 'medical.illness' },
    });
    return row.toObject ? row.toObject() : row;
}

async function withdrawIllness(req, id) {
    if (!isUuid(id)) refuse('Report not found', 404, 'MEDICAL_NOT_FOUND');
    const { rows } = await pool.query(`SELECT * FROM "medicalillnessreports" WHERE "_id" = $1 AND "school" = $2`, [id, S(req.schoolId)]);
    const r = rows[0];
    if (!r) refuse('Report not found', 404, 'MEDICAL_NOT_FOUND');
    if (req.userRole !== 'parent') refuse('Only a parent can withdraw this', 403, 'MEDICAL_PARENT_ONLY');
    await access.familyChild(req, S(r.student));
    if (r.status === 'withdrawn') refuse('This report was already withdrawn');
    const row = await patch(MedicalIllnessReport, id, { status: 'withdrawn' }, { where: { status: r.status } });
    if (!row) refuse('This report changed — open the page again', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'illness_withdrawn', entity: 'illness', entityId: id, student: r.student, summary: 'Illness report withdrawn by the family' });
    // The class teachers were told the child is off sick — they hear it was sent by mistake.
    const card = await access.studentCard(req.schoolId, r.student);
    const teachers = (await tell.classTeacherIds(req.schoolId, r.student)).map(S);
    if (card && teachers.length) {
        tell.send(req, {
            to: teachers, link: { type: 'medical.mine' },
            title: `Not off sick after all — ${card.name}`,
            body: `${card.name}'s family withdrew the "off sick" message they sent — it was sent by mistake.`,
        });
    }
    return row;
}

async function reports(req, f = {}) {
    const p = [S(req.schoolId)];
    const tab = ['new', 'seen', 'all'].includes(f.tab) ? f.tab : 'new';
    const { rows } = await pool.query(
        `SELECT r.*, r."_id"::text AS "_id", r."student"::text AS "studentId", u."name" AS "studentName", c."className", cs."sectionName", sp."admissionNumber"
           FROM "medicalillnessreports" r JOIN "users" u ON u."_id" = r."student" LEFT JOIN "studentprofiles" sp ON sp."user" = r."student"
           LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection" LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
          WHERE r."school" = $1 AND r."createdAt" > now() - interval '120 days'
          ORDER BY r."createdAt" DESC LIMIT 400`, p);
    const all = rows.map((r) => ({ ...r, classLabel: [r.className, r.sectionName].filter(Boolean).join(' – '), symptomLabels: (r.symptoms || []).map((k) => SYMPTOMS[k] || k) }));
    const TABS = [['new', 'New', (r) => r.status === 'new'], ['seen', 'Read', (r) => r.status === 'seen'], ['all', 'All', () => true]];
    const t = TABS.find((x) => x[0] === tab);
    return { tab, tabs: TABS.map(([key, label, fn]) => ({ key, label, count: all.filter(fn).length })), rows: all.filter(t[2]) };
}

async function markSeen(req, id) {
    if (!isUuid(id)) refuse('Report not found', 404, 'MEDICAL_NOT_FOUND');
    const row = await patch(MedicalIllnessReport, id, { status: 'seen', seenAt: new Date(), seenBy: req.userId, seenByName: req.user?.name || '' }, { where: { school: req.schoolId, status: 'new' } });
    if (!row) refuse('This report has already been read', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'illness_seen', entity: 'illness', entityId: id, student: row.student, summary: 'Illness report read' });
    return row;
}

async function familyReports(schoolId, studentId) {
    const { rows } = await pool.query(
        `SELECT "_id"::text AS "_id", "from", "to", "symptoms", "note", "status", "createdAt", "reportedByName", "seenAt"
           FROM "medicalillnessreports" WHERE "school" = $1 AND "student" = $2 AND "createdAt" > now() - interval '60 days' ORDER BY "createdAt" DESC LIMIT 20`,
        [S(schoolId), S(studentId)]);
    return rows.map((r) => ({ ...r, symptomLabels: (r.symptoms || []).map((k) => SYMPTOMS[k] || k) }));
}

module.exports = {
    RULES, SYMPTOMS, STATUS, rulesOf, validateRules, watch, list, detail, act, notice, noticeDraft, noticesFor,
    reportIllness, withdrawIllness, reports, markSeen, familyReports, casesSince,
};
