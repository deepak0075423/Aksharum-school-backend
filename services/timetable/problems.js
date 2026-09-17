'use strict';
/**
 * Conflicts → problems an administrator can act on.
 *
 * The solver and the validator speak in rows: one per slot, per subject, per
 * rule. A single cause fans out into many of them — a week asked to hold 88
 * periods when it has 44 produced a capacity error, a "could not be placed" row
 * for every subject and a teacher overload, all shown side by side as equals,
 * and the same shortfall arrived twice in two wordings (the engine's and the
 * validator's). This module folds that back into what actually happened:
 *
 *   - ROOT CAUSES first (the plan cannot fit, a teacher cannot cover their
 *     load, a subject has no teacher or no room). Consequences are listed
 *     under the cause as effects, not as problems of their own.
 *   - Repeats of one thing collapse: every double-booking of one teacher is one
 *     problem with a list of slots; one subject's shortfall is one problem
 *     however many rows reported it.
 *   - Every problem says what kind of change fixes it (`remedy`) and offers the
 *     concrete actions that make that change (`fixes`). In particular it says
 *     whether regenerating can help at all — a plan that cannot fit the week
 *     will not fit it on the next attempt either.
 *
 * Pure and DB-free: names come in through `names`, so both the web and the
 * mobile app read the same explanations from the API.
 */

const sid = (v) => (v == null ? null : String(v._id ?? v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DAY_SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const listText = (items) => {
    const xs = [...new Set(items.filter(Boolean))];
    if (xs.length <= 1) return xs[0] || '';
    return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

/**
 * What kind of change clears a problem, most fundamental first. The order is
 * also the display order within a severity.
 */
const REMEDIES = {
    plan:       { rank: 0, label: 'Change the weekly plan' },
    setup:      { rank: 1, label: 'Fix the school setup' },
    regenerate: { rank: 2, label: 'May clear on regenerate' },
    grid:       { rank: 3, label: 'Fix in the grid' },
    review:     { rank: 4, label: 'Worth a look' },
};

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** Which arithmetic or placement check produced a row. Old rows carry no tag. */
function checkOf(c) {
    const m = c.meta || {};
    if (m.check) return m.check;
    if (c.type === 'SUBJECT_PERIOD_SHORTAGE') {
        if (m.missingPeriods != null) return 'unplaced';
        if (m.required != null) return 'weekly_count';
        if (m.demand != null && !c.subjectId) return 'section_week';
        if (m.demand != null) return 'daily_ceiling';
    }
    if (c.type === 'WEEKLY_LIMIT_EXCEEDED') {
        if (m.shortBy != null) return 'staff_supply';
        if (m.load != null) return 'teacher_load';
        if (c.teacherId) return 'teacher_week';
    }
    if (c.type === 'ROOM_UNAVAILABLE' && !c.roomId && m.demand != null) return 'room_supply';
    return '';
}

function normalise(raw) {
    return {
        id: sid(raw._id) || null,
        type: raw.type || 'OTHER',
        severity: String(raw.severity || 'ERROR').toLowerCase(),
        sectionId: sid(raw.sectionId ?? raw.section),
        subjectId: sid(raw.subjectId ?? raw.subject),
        teacherId: sid(raw.teacherId ?? raw.teacher),
        roomId: sid(raw.roomId ?? raw.room),
        day: raw.dayOfWeek || '',
        period: raw.periodNumber == null || raw.periodNumber === '' ? null : Number(raw.periodNumber),
        description: raw.description || '',
        suggestion: raw.suggestion || '',
        meta: raw.meta || {},
    };
}

/** Name lookups with honest fallbacks — a deleted record must not blank a title. */
function namer(names = {}) {
    const get = (map, id) => {
        if (!id || !map) return '';
        if (map instanceof Map) return map.get(String(id)) || '';
        if (typeof map === 'function') return map(String(id)) || '';
        return map[String(id)] || '';
    };
    return {
        section: (id) => get(names.sections, id) || 'a removed section',
        subject: (id) => get(names.subjects, id) || 'A deleted subject',
        teacher: (id) => get(names.teachers, id) || 'A removed teacher',
        room: (id) => get(names.rooms, id) || 'A removed room',
    };
}

const slotText = (day, period) => `${DAY_SHORT[day] || day}${period != null ? ` P${period}` : ''}`;
const sortSlots = (slots) => slots.sort((a, b) =>
    DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || (a.period ?? 0) - (b.period ?? 0));
const sortDays = (days) => [...new Set(days.filter(Boolean))].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));

/* ══════════════════════════════════════════════════════════════════════════
   The report
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Array}  conflicts  stored TimetableConflict rows or engine conflicts
 * @param {object} names      { sections, subjects, teachers, rooms } — Map, object or fn
 * @returns {{ summary: object, problems: Array }}
 */
function explainConflicts(conflicts, names) {
    const n = namer(names);
    const rows = (conflicts || []).map(normalise);
    const problems = new Map();

    /** Create-or-get a problem. `init` runs once, on creation. */
    const problem = (key, init) => {
        if (!problems.has(key)) {
            problems.set(key, {
                key,
                kind: 'other',
                severity: 'info',
                title: '',
                detail: '',
                remedy: 'review',
                figures: null,
                sections: [],
                subjects: [],
                teacher: null,
                room: null,
                slots: [],
                days: [],
                reasons: [],
                effects: [],
                fixes: [],
                count: 0,
                ...init(),
            });
        }
        return problems.get(key);
    };
    const bump = (p, c) => {
        p.count++;
        if (SEVERITY_RANK[c.severity] < SEVERITY_RANK[p.severity]) p.severity = c.severity;
        if (c.sectionId && !p.sections.some((s) => s._id === c.sectionId)) {
            p.sections.push({ _id: c.sectionId, label: n.section(c.sectionId) });
        }
        if (c.day && c.period != null && !p.slots.some((s) => s.day === c.day && s.period === c.period && s.sectionId === c.sectionId)) {
            p.slots.push({ day: c.day, period: c.period, sectionId: c.sectionId, text: slotText(c.day, c.period) });
        }
        if (c.day && !p.days.includes(c.day)) p.days.push(c.day);
        return p;
    };
    const subjectRef = (id) => (id ? { _id: id, name: n.subject(id) } : null);
    const teacherRef = (id) => (id ? { _id: id, name: n.teacher(id) } : null);
    const roomRef = (id) => (id ? { _id: id, name: n.room(id) } : null);

    const fix = {
        plan: (sectionId, subjectId, label = 'Edit weekly periods') => ({ type: 'plan', label, sectionId, subjectId: subjectId || null }),
        rules: (sectionId, subjectId, label) => ({ type: 'rules', label: label || `${n.subject(subjectId)} rules`, sectionId, subjectId }),
        availability: (teacherId, label) => ({ type: 'availability', label: label || `${n.teacher(teacherId)}'s availability`, teacherId }),
        rooms: (label = 'Manage rooms') => ({ type: 'rooms', label }),
        teachers: (sectionId, label = 'Assign a teacher') => ({ type: 'section_subjects', label, sectionId }),
        structure: (label = 'Period structure') => ({ type: 'configuration', label }),
        grid: (slot, label = 'Show in grid') => (slot ? { type: 'grid', label, sectionId: slot.sectionId, day: slot.day, period: slot.period } : null),
        regenerate: (label = 'Regenerate') => ({ type: 'regenerate', label }),
    };

    /* ── Pass 1: root causes ─────────────────────────────────────────────── */
    const symptoms = [];
    for (const c of rows) {
        const check = checkOf(c);
        const m = c.meta;

        if (check === 'section_week') {
            const S = n.section(c.sectionId);
            const p = problem(`week|${c.sectionId}`, () => ({
                kind: 'week_overbooked',
                remedy: 'plan',
                title: `The weekly plan for ${S} doesn't fit its week`,
                detail: `The plan asks for ${m.demand} periods, but ${S} only has ${m.capacity} teaching periods a week — ${m.demand - m.capacity} of them can never be placed.`,
                figures: { have: m.capacity, need: m.demand, haveLabel: 'Teaching periods', needLabel: 'Planned', unit: 'a week' },
                fixes: [fix.plan(c.sectionId, null, 'Reduce weekly periods'), fix.structure('Add periods to the week')],
            }));
            bump(p, c);
            continue;
        }

        if (check === 'daily_ceiling') {
            const S = n.section(c.sectionId);
            const Subj = n.subject(c.subjectId);
            const p = problem(`ceiling|${c.sectionId}|${c.subjectId}`, () => ({
                kind: 'daily_ceiling',
                remedy: 'plan',
                title: `${Subj} can't reach ${m.demand} periods a week in ${S}`,
                detail: `At most ${plural(m.maxPerDay ?? 1, 'period')} a day across ${plural(m.days ?? 0, 'working day')} allows only ${m.capacity}.${m.suggestedPerDay ? ` Allow ${m.suggestedPerDay} a day, or plan fewer periods.` : ''}`,
                figures: { have: m.capacity, need: m.demand, haveLabel: 'Possible', needLabel: 'Planned', unit: 'a week' },
                subjects: [subjectRef(c.subjectId)],
                fixes: [fix.rules(c.sectionId, c.subjectId, `Raise ${Subj}'s daily limit`), fix.plan(c.sectionId, c.subjectId, 'Lower its weekly periods')],
            }));
            bump(p, c);
            continue;
        }

        if (check === 'teacher_load') {
            const T = n.teacher(c.teacherId);
            const elsewhere = Number(m.elsewhere) || 0;
            const p = problem(`load|${c.teacherId}`, () => ({
                kind: 'teacher_overloaded',
                remedy: 'plan',
                title: `${T} has more periods than free time`,
                detail: [
                    `${T} would teach ${m.load} periods a week here but can only take ${m.capacity}.`,
                    elsewhere ? `${plural(elsewhere, 'period is', 'periods are')} already taken by other classes.` : '',
                    m.limitedBy === 'limit' && m.weeklyLimit ? `Their weekly limit is ${m.weeklyLimit}.` : '',
                ].filter(Boolean).join(' '),
                figures: { have: m.capacity, need: m.load, haveLabel: 'Can take', needLabel: 'Needed', unit: 'a week' },
                teacher: teacherRef(c.teacherId),
                fixes: [
                    fix.plan(null, null, 'Give a subject another teacher'),
                    fix.availability(c.teacherId, `Widen ${T}'s availability`),
                ],
            }));
            bump(p, c);
            continue;
        }

        if (check === 'staff_supply') {
            const p = problem('staff', () => ({
                kind: 'staff_shortage',
                remedy: 'plan',
                title: 'Not enough teachers for this plan',
                detail: `The plan needs ${m.demand} teacher-periods a week, and the staff can cover about ${m.supply} — roughly ${m.shortBy} short.`,
                figures: { have: m.supply, need: m.demand, haveLabel: 'Staff can cover', needLabel: 'Needed', unit: 'a week' },
                fixes: [fix.plan(null, null, 'Reduce weekly periods')],
            }));
            bump(p, c);
            continue;
        }

        if (check === 'room_supply') {
            const label = m.roomLabel || 'special room';
            const p = problem(`roomsupply|${label}`, () => ({
                kind: 'room_supply',
                remedy: 'setup',
                title: `Not enough ${label} time`,
                detail: `${plural(m.demand, 'period')} a week need a ${label}, but the rooms offer only ${m.capacity}.`,
                figures: { have: m.capacity, need: m.demand, haveLabel: 'Room periods', needLabel: 'Needed', unit: 'a week' },
                fixes: [fix.rooms('Add a room'), fix.plan(null, null, 'Reduce practical periods')],
            }));
            bump(p, c);
            continue;
        }

        if (c.type === 'PRACTICAL_ROOM_MISSING') {
            const Subj = n.subject(c.subjectId);
            const hard = c.severity === 'error';
            const p = problem(`noroom|${c.subjectId}|${hard ? 'hard' : 'soft'}`, () => ({
                kind: 'no_room',
                remedy: hard ? 'setup' : 'review',
                title: hard ? `No suitable room for ${Subj}` : `${Subj} is scheduled without a lab`,
                detail: hard
                    ? `${Subj} is set to need a special room, but no room of that type exists — its periods can't be placed.`
                    : `${Subj} is a practical subject and no lab is set up, so it was placed in the classroom.`,
                subjects: [subjectRef(c.subjectId)],
                fixes: [
                    fix.rooms(hard ? 'Add a room' : 'Set up labs'),
                    ...(hard ? [fix.rules(c.sectionId, c.subjectId, 'Clear the room requirement')] : []),
                ],
            }));
            bump(p, c);
            continue;
        }

        if (c.type === 'NO_TEACHER_ASSIGNED') {
            const S = n.section(c.sectionId);
            const Subj = n.subject(c.subjectId);
            const p = problem(`noteacher|${c.sectionId}|${c.subjectId}`, () => ({
                kind: 'no_teacher',
                remedy: 'setup',
                title: `No teacher for ${Subj} in ${S}`,
                detail: `Nobody is assigned to teach ${Subj} in ${S}.`,
                subjects: [subjectRef(c.subjectId)],
                fixes: [fix.teachers(c.sectionId), fix.rules(c.sectionId, c.subjectId, 'Pick a teacher in the plan')],
            }));
            bump(p, c);
            p.detail = p.severity === 'error'
                ? `Nobody is assigned to teach ${Subj} in ${S}, so its periods can't be placed.`
                : `${plural(p.slots.length || p.count, 'period')} of ${Subj} in ${S} ${p.slots.length === 1 ? 'has' : 'have'} nobody teaching.`;
            continue;
        }

        if (c.type === 'TEACHER_NOT_QUALIFIED') {
            const Subj = n.subject(c.subjectId);
            const merged = (m.sectionIds || []).map((x) => n.section(x));
            const p = problem(`mergeteacher|${c.subjectId}|${c.sectionId}`, () => ({
                kind: 'merge_teacher',
                remedy: 'setup',
                title: `No single teacher for combined ${Subj}`,
                detail: `${Subj} is taught to ${listText(merged) || 'several sections'} together, but no one teacher is assigned to it in all of them.`,
                subjects: [subjectRef(c.subjectId)],
                fixes: [fix.teachers(c.sectionId, 'Assign the same teacher')],
            }));
            bump(p, c);
            for (const x of m.sectionIds || []) {
                if (!p.sections.some((s) => s._id === x)) p.sections.push({ _id: x, label: n.section(x) });
            }
            continue;
        }

        symptoms.push({ c, check });
    }

    /* ── Pass 2: shortfalls, folded into their cause where there is one ──── */
    // The engine reports what it could not place ("unplaced") and the validator
    // re-counts the grid ("weekly_count"). Both describe one shortfall, and a
    // merged group reports once per member — gather them per section+subject
    // first, with every merged member pointing at the same entry.
    const shortfalls = new Map();
    const alias = new Map();
    const others = [];
    for (const item of symptoms) {
        const { c, check } = item;
        const isShort = c.type === 'SUBJECT_PERIOD_SHORTAGE' && c.severity === 'error'
            && (check === 'unplaced' || check === 'weekly_count');
        if (!isShort) { others.push(item); continue; }

        const members = (c.meta.subjectIds && c.meta.subjectIds.length) ? c.meta.subjectIds.map(String) : [c.subjectId];
        const sections = (c.meta.sectionIds && c.meta.sectionIds.length) ? c.meta.sectionIds.map(String) : [c.sectionId];
        let entry = null;
        for (const secId of sections) {
            for (const subj of members) {
                const hit = alias.get(`${secId}|${subj}`);
                if (hit) { entry = hit; break; }
            }
            if (entry) break;
        }
        if (!entry) {
            entry = {
                sectionId: c.sectionId, subjectId: c.subjectId, subjectIds: new Set(), sectionIds: new Set(),
                teacherId: null, missing: 0, scheduled: null, required: null, mergeLabel: '', reasons: null,
                slotsChecked: 0, size: 1, rows: [],
            };
            shortfalls.set(`${c.sectionId}|${c.subjectId}`, entry);
        }
        for (const secId of sections) {
            entry.sectionIds.add(secId);
            for (const subj of members) {
                entry.subjectIds.add(subj);
                alias.set(`${secId}|${subj}`, entry);
            }
        }
        entry.rows.push(c);
        entry.teacherId = entry.teacherId || c.teacherId;
        if (c.meta.mergeLabel) entry.mergeLabel = c.meta.mergeLabel;
        if (check === 'unplaced') {
            entry.missing = Math.max(entry.missing, Number(c.meta.missingPeriods) || 0);
            if (Array.isArray(c.meta.reasons)) {
                entry.reasons = c.meta.reasons;
                entry.slotsChecked = c.meta.slotsChecked || 0;
                entry.size = c.meta.size || 1;
            }
        } else {
            const req = Number(c.meta.required) || 0;
            const got = Number(c.meta.scheduled) || 0;
            entry.missing = Math.max(entry.missing, req - got);
            entry.required = Math.max(entry.required || 0, req);
            entry.scheduled = entry.scheduled == null ? got : Math.min(entry.scheduled, got);
        }
    }

    const causeFor = (entry) => {
        for (const secId of entry.sectionIds) {
            if (problems.has(`week|${secId}`)) return problems.get(`week|${secId}`);
        }
        for (const secId of entry.sectionIds) {
            for (const subj of entry.subjectIds) {
                for (const k of [`ceiling|${secId}|${subj}`, `noteacher|${secId}|${subj}`, `mergeteacher|${subj}|${secId}`]) {
                    if (problems.has(k)) return problems.get(k);
                }
            }
        }
        for (const subj of entry.subjectIds) {
            if (problems.has(`noroom|${subj}|hard`)) return problems.get(`noroom|${subj}|hard`);
        }
        if (entry.teacherId && problems.has(`load|${entry.teacherId}`)) return problems.get(`load|${entry.teacherId}`);
        return null;
    };

    // Shortfalls with no deeper cause. One subject short is one problem; several
    // short in the same section are one problem with a line per subject — a
    // crowded week reads as one thing, not as five near-identical cards.
    const TEACHER_CODES = ['TEACHER_CLASH', 'TEACHER_UNAVAILABLE', 'TEACHER_NOT_FREE', 'WEEKLY_LIMIT_EXCEEDED', 'DAILY_LIMIT_EXCEEDED'];
    const standalone = new Map();
    for (const entry of shortfalls.values()) {
        const S = [...entry.sectionIds].map((x) => n.section(x));
        const Subj = entry.mergeLabel || listText([...entry.subjectIds].map((x) => n.subject(x)));
        const missing = entry.missing || 0;
        const cause = causeFor(entry);
        if (cause) {
            cause.effects.push({
                text: `${Subj} in ${listText(S)}: ${plural(missing, 'period')} short`,
                sectionId: entry.sectionId, subjectId: entry.subjectId, missing,
            });
            cause.count += entry.rows.length;
            continue;
        }
        if (!standalone.has(entry.sectionId)) standalone.set(entry.sectionId, []);
        standalone.get(entry.sectionId).push({ entry, S, Subj, missing });
    }

    for (const [sectionId, items] of standalone) {
        const S = listText([...new Set(items.flatMap((x) => x.S))]);
        const total = items.reduce((sum, x) => sum + x.missing, 0);
        const freeNow = items.some((x) => (x.entry.reasons || []).some((r) => r.code === 'FREE'));
        const detail = freeNow
            ? `The search ran out of time before placing the rest — a fresh attempt usually finds room.`
            : `The remaining ${total === 1 ? 'period' : 'periods'} found no free slot.`;
        const teacherIds = [...new Set(items
            .filter((x) => x.entry.teacherId && (x.entry.reasons || []).some((r) => TEACHER_CODES.includes(r.code)))
            .map((x) => x.entry.teacherId))].slice(0, 2);
        const allCounted = items.every((x) => x.entry.required != null);

        let p;
        if (items.length === 1) {
            const { entry, Subj, missing } = items[0];
            p = problem(`short|${sectionId}|${entry.subjectId}`, () => ({
                kind: 'subject_short',
                title: `${Subj} is ${plural(missing, 'period')} short in ${S}`,
                figures: entry.required != null
                    ? { have: entry.scheduled, need: entry.required, haveLabel: 'Scheduled', needLabel: 'Planned', unit: 'a week' }
                    : null,
                subjects: [...entry.subjectIds].map(subjectRef),
                teacher: teacherRef(entry.teacherId),
                reasons: describeReasons(entry, n),
            }));
            p.fixes = [
                fix.regenerate(),
                ...teacherIds.map((t) => fix.availability(t)),
                fix.plan(sectionId, entry.subjectId, 'Lower its weekly periods'),
            ];
        } else {
            p = problem(`short|${sectionId}`, () => ({
                kind: 'section_short',
                title: `${S} is ${plural(total, 'period')} short across ${items.length} subjects`,
                figures: allCounted
                    ? {
                        have: items.reduce((sum, x) => sum + (x.entry.scheduled || 0), 0),
                        need: items.reduce((sum, x) => sum + (x.entry.required || 0), 0),
                        haveLabel: 'Scheduled', needLabel: 'Planned', unit: 'a week',
                    }
                    : null,
                subjects: items.flatMap((x) => [...x.entry.subjectIds]).map(subjectRef),
                effects: items.map(({ entry, Subj, missing }) => {
                    const top = describeReasons(entry, n).find((r) => r.code !== 'FREE');
                    return {
                        text: entry.required != null
                            ? `${Subj}: ${entry.scheduled} of ${entry.required} placed`
                            : `${Subj}: ${plural(missing, 'period')} short`,
                        reason: top ? top.text : '',
                        sectionId, subjectId: entry.subjectId, missing,
                    };
                }),
            }));
            p.fixes = [
                fix.regenerate(),
                ...teacherIds.map((t) => fix.availability(t)),
                fix.plan(sectionId, null, 'Lower weekly periods'),
            ];
        }
        p.remedy = 'regenerate';
        p.detail = detail;
        p.severity = 'error';
        for (const { entry } of items) {
            for (const secId of entry.sectionIds) {
                if (!p.sections.some((x) => x._id === secId)) p.sections.push({ _id: secId, label: n.section(secId) });
            }
            p.count += entry.rows.length;
        }
    }

    /* ── Pass 3: everything placed in the grid that breaks a rule ────────── */
    for (const { c, check } of others) {
        const m = c.meta;
        const S = n.section(c.sectionId);

        switch (c.type) {
        case 'SUBJECT_PERIOD_SHORTAGE': {
            if (check === 'section_merge_weekly') {
                const Subj = n.subject(c.subjectId);
                bump(problem(`mergecounts|${c.subjectId}`, () => ({
                    kind: 'merge_counts',
                    remedy: 'plan',
                    title: `Combined ${Subj} has different weekly counts`,
                    detail: `The sections sharing ${Subj} asked for ${listText((m.counts || []).map(String))} periods; all of them were given ${m.scheduled ?? 'the largest'}.`,
                    subjects: [subjectRef(c.subjectId)],
                    fixes: [fix.plan(c.sectionId, c.subjectId, 'Match the weekly counts')],
                })), c);
                break;
            }
            // More periods than planned (a hand edit, usually).
            const Subj = n.subject(c.subjectId);
            const p = bump(problem(`extra|${c.sectionId}|${c.subjectId}`, () => ({
                kind: 'subject_extra',
                remedy: 'grid',
                title: `${Subj} has extra periods in ${S}`,
                detail: `${m.scheduled ?? 'More'} periods are in the grid, but the plan asks for ${m.required ?? 'fewer'}.`,
                figures: m.required != null ? { have: m.scheduled, need: m.required, haveLabel: 'Scheduled', needLabel: 'Planned', unit: 'a week' } : null,
                subjects: [subjectRef(c.subjectId)],
                fixes: [fix.grid({ sectionId: c.sectionId, day: null, period: null }, `Open ${S}`)],
            })), c);
            p.fixes = p.fixes.filter(Boolean);
            break;
        }

        case 'TEACHER_CLASH': {
            const T = n.teacher(c.teacherId);
            const p = bump(problem(`tclash|${c.teacherId}`, () => ({
                kind: 'teacher_clash',
                remedy: 'grid',
                title: `${T} is double-booked`,
                teacher: teacherRef(c.teacherId),
                elsewhere: [],
            })), c);
            if (m.elsewhere && !p.elsewhere.includes(m.elsewhere)) p.elsewhere.push(m.elsewhere);
            if (m.withSectionId) {
                p.between = p.between || [];
                for (const x of [c.sectionId, m.withSectionId]) if (x && !p.between.includes(x)) p.between.push(x);
            }
            p.detail = [
                `${plural(p.slots.length || p.count, 'period')} where ${T} is expected in two classes at once`,
                p.between?.length > 1 ? ` — ${listText(p.between.map((x) => n.section(x)))}` : '',
                p.elsewhere.length ? ` — already teaching ${listText(p.elsewhere)} in the published timetable` : '',
                '.',
            ].join('');
            p.fixes = [fix.grid(sortSlots(p.slots)[0], 'Show the first one'), fix.regenerate()].filter(Boolean);
            break;
        }

        case 'CLASS_CLASH': {
            const p = bump(problem(`cclash|${c.sectionId}`, () => ({
                kind: 'class_clash',
                remedy: 'grid',
                title: `${S} has two lessons in the same period`,
            })), c);
            p.detail = `${plural(p.slots.length || p.count, 'period')} in ${S} ${p.slots.length === 1 ? 'holds' : 'hold'} more than one subject. Clear one of them, or merge the subjects if they are meant to run together.`;
            p.fixes = [fix.grid(sortSlots(p.slots)[0], 'Show the first one')].filter(Boolean);
            break;
        }

        case 'ROOM_CLASH': {
            const R = n.room(c.roomId);
            const p = bump(problem(`rclash|${c.roomId}`, () => ({
                kind: 'room_clash',
                remedy: 'grid',
                title: `${R} is double-booked`,
                room: roomRef(c.roomId),
                elsewhere: [],
            })), c);
            if (m.elsewhere && !p.elsewhere.includes(m.elsewhere)) p.elsewhere.push(m.elsewhere);
            p.detail = `${plural(p.slots.length || p.count, 'period')} where two classes are sent to ${R}${p.elsewhere.length ? ` — ${listText(p.elsewhere)} already uses it then` : ''}.`;
            p.fixes = [fix.grid(sortSlots(p.slots)[0], 'Show the first one'), fix.rooms()].filter(Boolean);
            break;
        }

        case 'TEACHER_UNAVAILABLE': {
            const T = n.teacher(c.teacherId);
            const p = bump(problem(`tunavail|${c.teacherId}`, () => ({
                kind: 'teacher_unavailable',
                remedy: 'grid',
                title: `${T} is scheduled while unavailable`,
                teacher: teacherRef(c.teacherId),
            })), c);
            p.detail = `${plural(p.slots.length || p.count, 'period')} fall${p.slots.length === 1 ? 's' : ''} in time ${T} has marked as unavailable.`;
            p.fixes = [fix.grid(sortSlots(p.slots)[0], 'Show the first one'), fix.availability(c.teacherId)].filter(Boolean);
            break;
        }

        case 'ROOM_UNAVAILABLE': {
            const R = n.room(c.roomId);
            const p = bump(problem(`runavail|${c.roomId}`, () => ({
                kind: 'room_unavailable',
                remedy: 'grid',
                title: `${R} is used while unavailable`,
                room: roomRef(c.roomId),
            })), c);
            p.detail = `${plural(p.slots.length || p.count, 'period')} use ${R} at a time it is blocked.`;
            p.fixes = [fix.grid(sortSlots(p.slots)[0], 'Show the first one'), fix.rooms()].filter(Boolean);
            break;
        }

        case 'SUBJECT_TEACHER_MISMATCH': {
            const T = n.teacher(c.teacherId);
            const Subj = n.subject(c.subjectId);
            const p = bump(problem(`mismatch|${c.teacherId}|${c.subjectId}`, () => ({
                kind: 'teacher_not_assigned',
                remedy: 'setup',
                title: `${T} isn't assigned to teach ${Subj}`,
                teacher: teacherRef(c.teacherId),
                subjects: [subjectRef(c.subjectId)],
            })), c);
            p.detail = `${plural(p.slots.length || p.count, 'period')} of ${Subj} name ${T}, who isn't one of its assigned teachers.`;
            p.fixes = [fix.teachers(c.sectionId, `Assign ${T} to ${Subj}`), fix.grid(sortSlots(p.slots)[0], 'Show the first one')].filter(Boolean);
            break;
        }

        case 'DAILY_LIMIT_EXCEEDED': {
            if (c.subjectId) {
                const Subj = n.subject(c.subjectId);
                const p = bump(problem(`dsubj|${c.sectionId}|${c.subjectId}`, () => ({
                    kind: 'subject_daily_limit',
                    remedy: 'regenerate',
                    title: `${Subj} runs too often on some days in ${S}`,
                    subjects: [subjectRef(c.subjectId)],
                })), c);
                p.detail = `More than ${plural(m.limit ?? 1, 'period')} of ${Subj} on ${listText(sortDays(p.days).map((d) => DAY_SHORT[d] || d))}.`;
                p.fixes = [
                    fix.grid({ sectionId: c.sectionId, day: sortDays(p.days)[0], period: null }, `Open ${S}`),
                    fix.rules(c.sectionId, c.subjectId, `${Subj}'s daily limit`),
                ].filter(Boolean);
            } else {
                const T = n.teacher(c.teacherId);
                const p = bump(problem(`dteacher|${c.teacherId}`, () => ({
                    kind: 'teacher_daily_limit',
                    remedy: 'regenerate',
                    title: `${T} has too many periods on some days`,
                    teacher: teacherRef(c.teacherId),
                })), c);
                p.detail = `Over the limit of ${m.limit ?? 'their daily'} a day on ${listText(sortDays(p.days).map((d) => DAY_SHORT[d] || d))}${m.elsewhere ? ', counting periods in other classes' : ''}.`;
                p.fixes = [fix.regenerate(), fix.availability(c.teacherId, `${T}'s limits`)];
            }
            break;
        }

        case 'WEEKLY_LIMIT_EXCEEDED': {
            if (c.teacherId && problems.has(`load|${c.teacherId}`)) {
                problems.get(`load|${c.teacherId}`).count++;
                break;
            }
            const T = n.teacher(c.teacherId);
            bump(problem(`tweek|${c.teacherId || 'x'}`, () => ({
                kind: 'teacher_weekly_limit',
                remedy: 'grid',
                title: `${T} is over their weekly limit`,
                detail: m.count != null
                    ? `${m.count} periods this week against a limit of ${m.limit}${m.elsewhere ? ` (${m.elsewhere} of them in other classes)` : ''}.`
                    : c.description,
                figures: m.count != null ? { have: m.limit, need: m.count, haveLabel: 'Limit', needLabel: 'Scheduled', unit: 'a week' } : null,
                teacher: teacherRef(c.teacherId),
                fixes: [fix.availability(c.teacherId, `${T}'s limits`), fix.regenerate()],
            })), c);
            break;
        }

        case 'CONSECUTIVE_PERIOD_ERROR': {
            const Subj = n.subject(c.subjectId);
            const p = bump(problem(`consec|${c.sectionId}|${c.subjectId}`, () => ({
                kind: 'not_back_to_back',
                remedy: 'regenerate',
                title: `${Subj} isn't back-to-back in ${S}`,
                subjects: [subjectRef(c.subjectId)],
            })), c);
            p.detail = `It needs ${plural(m.size ?? 2, 'period')} in a row but sits alone on ${listText(sortDays(p.days).map((d) => DAY_SHORT[d] || d))}.`;
            p.fixes = [fix.regenerate(), fix.grid({ sectionId: c.sectionId, day: sortDays(p.days)[0], period: null }, `Open ${S}`)];
            break;
        }

        case 'NON_TEACHING_SLOT': {
            const p = bump(problem(`outside|${c.sectionId}`, () => ({
                kind: 'outside_timetable',
                remedy: 'regenerate',
                title: `Periods fall outside ${S}'s timetable`,
            })), c);
            const k = p.slots.length || p.count;
            p.title = `${plural(k, 'period falls', 'periods fall')} outside ${S}'s timetable`;
            p.detail = `${k === 1 ? 'It sits' : 'They sit'} in a break, or in a period that no longer exists — the period structure most likely changed after this was generated. Regenerating rebuilds ${k === 1 ? 'it' : 'them'} on the current structure.`;
            p.fixes = [fix.regenerate(), fix.structure(), fix.grid(sortSlots(p.slots)[0], 'Show the first one')].filter(Boolean);
            break;
        }

        case 'MERGE_GROUP_MISMATCH': {
            if (check === 'merge_pin') {
                const Subj = n.subject(c.subjectId);
                const p = bump(problem(`mergepin|${c.sectionId}|${c.subjectId}`, () => ({
                    kind: 'merge_not_aligned',
                    remedy: 'plan',
                    title: `Combined ${Subj} couldn't line up in ${S}`,
                    subjects: [subjectRef(c.subjectId)],
                })), c);
                p.detail = `The lesson ${S} shares with another section is already fixed at ${listText(sortSlots(p.slots).map((s) => s.text))}, but ${S} can't take it there (${m.reason || 'the slot is not free'}). Generate the combined sections together.`;
                p.fixes = [fix.plan(c.sectionId, null, 'Select all combined sections')];
                break;
            }
            bump(problem(`mergemix|${c.sectionId}`, () => ({
                kind: 'merge_counts',
                remedy: 'plan',
                title: `Merged subjects in ${S} asked for different weekly counts`,
                detail: `${c.description} Give every subject in a merged group the same count.`,
                fixes: [fix.plan(c.sectionId, c.subjectId, 'Match the weekly counts')],
            })), c);
            break;
        }

        default: {
            if (check === 'dropped_pins') {
                const pins = m.pins || [];
                bump(problem('droppededits', () => ({
                    kind: 'dropped_edits',
                    remedy: 'grid',
                    title: `${plural(pins.length || 1, 'hand edit')} from the previous version ${pins.length === 1 ? "wasn't" : "weren't"} kept`,
                    detail: pins.length
                        ? pins.slice(0, 4).map((pin) => `${n.subject(pin.subjectId)} in ${n.section(pin.sectionId)} at ${slotText(pin.dayOfWeek, pin.periodNumber)} — ${pin.reason}`).join('; ') + (pins.length > 4 ? `; and ${pins.length - 4} more.` : '.')
                        : c.description,
                    fixes: [],
                })), c);
                break;
            }
            const p = bump(problem(`other|${c.type}|${c.description}`, () => ({
                kind: 'other',
                remedy: c.severity === 'error' ? 'grid' : 'review',
                title: c.description || 'Something needs attention',
                detail: c.suggestion || '',
                fixes: [],
            })), c);
            if (p.slots.length) p.fixes = [fix.grid(sortSlots(p.slots)[0])].filter(Boolean);
        }
        }
    }

    /* ── Finish ───────────────────────────────────────────────────────────── */
    const list = [...problems.values()].map((p) => {
        sortSlots(p.slots);
        p.days = sortDays(p.days);
        p.subjects = (p.subjects || []).filter(Boolean);
        p.fixes = (p.fixes || []).filter(Boolean);
        p.remedyLabel = REMEDIES[p.remedy]?.label || '';
        // A cause's effects, biggest shortfall first.
        p.effects.sort((a, b) => (b.missing || 0) - (a.missing || 0));
        return p;
    }).sort((a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        || (REMEDIES[a.remedy]?.rank ?? 9) - (REMEDIES[b.remedy]?.rank ?? 9)
        || b.count - a.count);

    return { summary: summarise(list, rows), problems: list };
}

/** Plain-language reasons a subject's remaining periods found no slot. */
function describeReasons(entry, n) {
    if (!entry.reasons || !entry.reasons.length) return [];
    const S = listText([...entry.sectionIds].map((x) => n.section(x)));
    const T = entry.teacherId ? n.teacher(entry.teacherId) : 'the teacher';
    const inA = (count) => `${count} of ${entry.slotsChecked || count} possible ${entry.slotsChecked === 1 ? 'slot' : 'slots'}`;
    const text = {
        CLASS_CLASH: (k) => `${inA(k)} already hold another lesson for ${S}`,
        TEACHER_CLASH: (k) => `in ${inA(k)}, ${T} is teaching another class`,
        TEACHER_UNAVAILABLE: (k) => `in ${inA(k)}, ${T} is marked unavailable`,
        TEACHER_NOT_FREE: (k) => `in ${inA(k)}, no teacher for it is free (unavailable or teaching elsewhere)`,
        DAILY_LIMIT_EXCEEDED: (k) => `${inA(k)} would break a per-day limit`,
        WEEKLY_LIMIT_EXCEEDED: (k) => `in ${inA(k)}, ${T} has already reached their weekly limit`,
        ROOM_CLASH: (k) => `in ${inA(k)}, every suitable room is already taken`,
        ROOM_UNAVAILABLE: (k) => `in ${inA(k)}, the room is unavailable`,
        PRACTICAL_ROOM_MISSING: () => 'no suitable room exists',
        CONSECUTIVE_PERIOD_ERROR: (k) => `${inA(k)} don't have ${entry.size} periods in a row`,
        SUBJECT_TEACHER_MISMATCH: (k) => `in ${inA(k)}, the free teacher isn't assigned to this subject`,
        NO_TEACHER_ASSIGNED: () => 'no teacher is assigned',
        NON_TEACHING_SLOT: (k) => `${inA(k)} are not teaching periods`,
        FREE: (k) => `${inA(k)} are free now — the search simply didn't get to them`,
    };
    return entry.reasons.map((r) => ({
        code: r.code,
        count: r.count,
        text: (text[r.code] || ((k) => `${inA(k)}: ${r.example || 'blocked'}`))(r.count),
        example: r.example || '',
    }));
}

function summarise(list, rows) {
    const errors = list.filter((p) => p.severity === 'error');
    const warnings = list.filter((p) => p.severity === 'warning');
    const info = list.filter((p) => p.severity === 'info');
    const needsChange = errors.filter((p) => p.remedy === 'plan' || p.remedy === 'setup');
    const retryable = errors.filter((p) => p.remedy === 'regenerate');
    const gridOnly = errors.filter((p) => p.remedy === 'grid');

    let headline;
    let advice = '';
    if (!errors.length) {
        headline = warnings.length
            ? `Ready to publish · ${plural(warnings.length, 'thing')} worth checking`
            : 'No problems — ready to publish';
    } else {
        headline = `${plural(errors.length, 'problem')} ${errors.length === 1 ? 'stops' : 'stop'} this timetable from being published`;
        if (needsChange.length && needsChange.length === errors.length) {
            advice = `${errors.length === 1 ? 'It needs' : 'Each needs'} a change to the plan or the school setup first — regenerating alone won't fix ${errors.length === 1 ? 'it' : 'them'}.`;
        } else if (needsChange.length) {
            advice = `Fix the ${plural(needsChange.length, 'problem')} marked "${REMEDIES.plan.label}" or "${REMEDIES.setup.label}" first; the rest may clear when you regenerate.`;
        } else if (retryable.length) {
            advice = 'These usually clear with a fresh attempt — regenerate to try a different arrangement.';
        } else if (gridOnly.length) {
            advice = 'Fix these periods in the grid, or regenerate to rebuild them.';
        }
    }

    return {
        errors: errors.length,
        warnings: warnings.length,
        info: info.length,
        total: list.length,
        rawErrors: rows.filter((r) => r.severity === 'error').length,
        rawWarnings: rows.filter((r) => r.severity === 'warning').length,
        canPublish: !rows.some((r) => r.severity === 'error'),
        needsChange: needsChange.length > 0,
        regenerateMayHelp: retryable.length > 0 || gridOnly.length > 0,
        headline,
        advice,
    };
}

module.exports = { explainConflicts, REMEDIES };
