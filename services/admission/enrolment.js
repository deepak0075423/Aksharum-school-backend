'use strict';
/**
 * Enrolling many at once, and planning offers (Oct 2026).
 *
 *   bulk plan    every confirmed application of a class in a round, each with
 *                what enrolment needs: a section (suggested so the sections
 *                fill evenly — by headcount, then by boys and girls), the
 *                student's sign-in email (from the form when it asked; the
 *                office types the rest), and the parent from the form.
 *   bulk run     each row through the same enrolment as one at a time
 *                (services/admission/conversion.js) — idempotent, so a row
 *                sent twice is enrolled once; each row's result is reported.
 *   forecast     how many of the offers out are likely to become admissions,
 *                from the school's own record of offers accepted and
 *                confirmed, and how many more offers would fill the seats —
 *                an estimate the office reads, never acted on by itself.
 */
const pool = require('../../db/pool');
const conversion = require('./conversion');
const { refuse, isId, round2 } = require('./util');

const MAX_ROWS = 50;
const MIN_HISTORY = 10;

/**
 * Sections for a batch: each student to the section least full (as a share of
 * its room), then the one with fewer of that gender, then by name. A full
 * section takes no one; with every section full, no section is suggested.
 */
function suggestSections(sections, students) {
    const state = sections.map((s) => ({ ...s, occupied: Number(s.occupied) || 0, byGender: { ...(s.byGender || {}) } }));
    const out = {};
    for (const st of students) {
        const g = st.gender || '';
        const open = state.filter((s) => !s.capacity || s.occupied < s.capacity);
        if (!open.length) { out[st.id] = null; continue; }
        open.sort((a, b) => {
            const fa = a.capacity ? a.occupied / a.capacity : a.occupied / 1000;
            const fb = b.capacity ? b.occupied / b.capacity : b.occupied / 1000;
            if (Math.abs(fa - fb) > 1e-9) return fa - fb;
            const ga = (a.byGender[g] || 0); const gb = (b.byGender[g] || 0);
            if (ga !== gb) return ga - gb;
            return String(a.sectionName).localeCompare(String(b.sectionName), undefined, { numeric: true });
        });
        const pick = open[0];
        pick.occupied += 1;
        pick.byGender[g] = (pick.byGender[g] || 0) + 1;
        out[st.id] = String(pick._id);
    }
    return { bySection: out, after: state.map((s) => ({ _id: s._id, sectionName: s.sectionName, capacity: s.capacity, occupied: s.occupied, byGender: s.byGender })) };
}

/** The plan for a class in a round: one row per confirmed application. */
async function bulkPlan(req, { classId, roundId }) {
    if (!isId(String(classId || '')) || !isId(String(roundId || ''))) refuse('Choose the round and the class');
    const { rows: apps } = await pool.query(
        `SELECT * FROM "admissionapplications" WHERE "school" = $1 AND "round" = $2 AND "class" = $3 AND "status" = 'confirmed' ORDER BY "studentName" LIMIT 500`,
        [String(req.schoolId), String(roundId), String(classId)]);
    if (!apps.length) return { rows: [], sections: [], after: [] };
    const previews = [];
    for (const app of apps) previews.push({ app, p: await conversion.preview(req, app) });
    const first = previews.find((x) => !x.p.done)?.p;
    const sectionIds = (first?.placement?.sections || []).map((s) => String(s._id));
    // Who is already in each section, by gender — so the batch evens them out.
    const { rows: g } = sectionIds.length ? await pool.query(
        `SELECT sp."currentSection" AS s, COALESCE(NULLIF(sp."gender", ''), 'Unknown') AS g, COUNT(*)::int AS n FROM "studentprofiles" sp
          WHERE sp."currentSection" = ANY($1::uuid[]) GROUP BY 1, 2`, [sectionIds]) : { rows: [] };
    const sections = (first?.placement?.sections || []).map((s) => ({
        _id: s._id, sectionName: s.sectionName, capacity: s.capacity || 0, occupied: s.occupied,
        byGender: Object.fromEntries(g.filter((x) => String(x.s) === String(s._id)).map((x) => [x.g, x.n])),
    }));
    const live = previews.filter((x) => !x.p.done);
    const { bySection, after } = suggestSections(sections, live.map((x) => ({ id: String(x.app._id), gender: x.p.student.gender || 'Unknown' })));
    const rows = live.map(({ app, p }) => ({
        applicationId: app._id, applicationNumber: app.applicationNumber, studentName: p.student.name, gender: p.student.gender,
        section: bySection[String(app._id)], studentEmail: p.student.email || '', canUseApplicantAccount: p.student.canUseApplicantAccount, applicantEmail: p.student.applicantEmail,
        parent: { relation: p.parent.relation, name: p.parent.name, email: p.parent.email, phone: p.parent.phone, existing: p.parent.existing },
        blockers: p.blockers, warnings: p.warnings,
        hostelRequested: !!p.options?.hostel?.requested,
    }));
    return { rows, sections, after };
}

/**
 * Enrol the rows, one after another, each as if done on its own. A row that
 * fails says why and the others go on.
 */
async function bulkEnrol(req, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) refuse('Choose who to enrol');
    if (list.length > MAX_ROWS) refuse(`At most ${MAX_ROWS} at a time`);
    const results = [];
    for (const r of list) {
        const id = String(r?.applicationId || '');
        if (!isId(id)) { results.push({ applicationId: id, ok: false, message: 'Application not found' }); continue; }
        const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1 AND "school" = $2`, [id, String(req.schoolId)]);
        if (!app) { results.push({ applicationId: id, ok: false, message: 'Application not found' }); continue; }
        try {
            const out = await conversion.convert(req, app, {
                section: r.section || undefined,
                studentAccount: r.studentAccount === 'applicant' ? 'applicant' : 'new',
                studentEmail: r.studentEmail,
                parent: r.parent?.mode === 'existing' ? { mode: 'existing', userId: r.parent.userId } : { mode: 'new', relation: r.parent?.relation, name: r.parent?.name, email: r.parent?.email, phone: r.parent?.phone },
            });
            results.push({ applicationId: id, ok: true, admissionNumber: out.admissionNumber, replay: !!out.replay });
        } catch (e) {
            results.push({ applicationId: id, ok: false, message: e.expose || e.status ? e.message : 'Could not be enrolled — try it on its own' });
            if (!e.status) console.error('[admission] bulk enrol:', e.message);
        }
    }
    return { enrolled: results.filter((x) => x.ok && !x.replay).length, failed: results.filter((x) => !x.ok).length, results };
}

// ── Forecast ─────────────────────────────────────────────────────────────────

/** From the school's own past offers: how often an offer is accepted, and an acceptance confirmed. */
async function rates(schoolId) {
    const { rows } = await pool.query(
        `SELECT c."classNumber", GROUPING(c."classNumber") AS "grand",
                COUNT(*) FILTER (WHERE o."status" IN ('accepted', 'confirmed', 'declined', 'expired') OR (o."status" = 'withdrawn' AND o."respondedAt" IS NOT NULL))::int AS decided,
                COUNT(*) FILTER (WHERE o."status" IN ('accepted', 'confirmed') OR (o."status" = 'withdrawn' AND o."respondedAt" IS NOT NULL))::int AS accepted,
                COUNT(*) FILTER (WHERE o."status" = 'confirmed')::int AS confirmed,
                COUNT(*) FILTER (WHERE o."status" = 'withdrawn' AND o."respondedAt" IS NOT NULL)::int AS "acceptedThenLost"
           FROM "admissionoffers" o LEFT JOIN "classes" c ON c."_id" = o."class"
          WHERE o."school" = $1 AND o."issuedAt" > now() - interval '3 years'
          GROUP BY ROLLUP (c."classNumber")`, [String(schoolId)]);
    const make = (r) => {
        if (!r) return null;
        const acceptRate = r.decided >= MIN_HISTORY ? round2(r.accepted / r.decided) : null;
        const settled = r.confirmed + r.acceptedThenLost;
        const confirmRate = settled >= MIN_HISTORY ? round2(r.confirmed / settled) : null;
        return { decided: r.decided, settled, acceptRate, confirmRate };
    };
    const all = make(rows.find((r) => Number(r.grand) === 1));
    const byClass = new Map(rows.filter((r) => Number(r.grand) === 0 && r.classNumber !== null).map((r) => [Number(r.classNumber), make(r)]));
    return { all, byClass };
}

/** For each class of a round: seats, where its offers stand, the expected admissions, and the gap. */
async function forecast(schoolId, roundId) {
    if (!isId(String(roundId || ''))) refuse('Choose a round');
    const { rows: [round] } = await pool.query(`SELECT * FROM "admissionrounds" WHERE "_id" = $1 AND "school" = $2`, [String(roundId), String(schoolId)]);
    if (!round) refuse('Round not found', 404);
    const r = await rates(schoolId);
    const out = [];
    for (const c of round.classes || []) {
        const { rows: [cls] } = await pool.query(`SELECT "className", "classNumber" FROM "classes" WHERE "_id" = $1`, [String(c.class)]);
        const { rows: [o] } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE "status" = 'issued')::int AS issued, COUNT(*) FILTER (WHERE "status" = 'accepted')::int AS accepted,
                    COUNT(*) FILTER (WHERE "status" = 'confirmed')::int AS confirmed
               FROM "admissionoffers" WHERE "round" = $1 AND "class" = $2`, [round._id, String(c.class)]);
        const { rows: [w] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionapplications" WHERE "round" = $1 AND "class" = $2 AND "status" = 'waitlisted'`, [round._id, String(c.class)]);
        const own = r.byClass.get(Number(cls?.classNumber));
        const useOwn = own && own.acceptRate != null && own.confirmRate != null;
        const basis = useOwn ? own : r.all;
        const acceptRate = basis?.acceptRate ?? null;
        const confirmRate = basis?.confirmRate ?? null;
        const known = acceptRate != null && confirmRate != null;
        const seats = Number(c.seats) || 0;
        const expected = known ? round2(o.confirmed + o.accepted * confirmRate + o.issued * acceptRate * confirmRate) : null;
        const gap = known && seats ? round2(seats - expected) : null;
        const yieldPerOffer = known ? acceptRate * confirmRate : null;
        out.push({
            class: c.class, className: cls?.className || '', seats, ...o, waitlisted: w.n,
            acceptRate, confirmRate, basis: known ? (useOwn ? 'class' : 'school') : 'not_enough', history: basis ? basis.decided : 0,
            expected, gap,
            moreOffers: gap != null && gap > 0 && yieldPerOffer > 0 ? Math.ceil(gap / yieldPerOffer) : 0,
        });
    }
    return { round: { _id: round._id, name: round.name }, minHistory: MIN_HISTORY, classes: out };
}

module.exports = { suggestSections, bulkPlan, bulkEnrol, forecast, rates };
