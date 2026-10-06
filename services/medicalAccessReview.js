'use strict';
/**
 * Who opened which medical records (Oct 2026) — for the school's admins.
 *
 *   review     per member of staff over a period: records opened, students,
 *              downloads, emergency (break-glass) openings, changes made, the
 *              busiest hour, openings out of hours
 *   watch      after every opening: someone who has opened the records of more
 *              students in the last hour than the school's accessAlertThreshold
 *              is reported to the school admins at once — once a day per person
 *   digest     on Monday morning (the sweep): last week's figures to the admins
 *
 * Safeguarding entries are never counted here (they are the leads' own).
 */
const pool = require('../db/pool');
const settingsSvc = require('./medicalSettings');
const R = require('./medicalRules');

const S = (v) => String(v);
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

async function review(req, { days = 30 } = {}) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    const tz = R.ZONE;
    const rows = await run(
        `WITH l AS (
            SELECT * FROM "medicalauditlogs" WHERE "school" = $1 AND "createdAt" > now() - make_interval(days => $2::int) AND "entity" <> 'safeguarding' AND "actor" IS NOT NULL
         ), hours AS (
            SELECT "actor", date_trunc('hour', "createdAt") AS h, count(DISTINCT "student") AS n FROM l WHERE "action" = 'viewed' GROUP BY 1, 2
         )
         SELECT l."actor"::text AS "actor", max(l."actorName") AS "name", max(l."actorRole") AS "role",
                count(*) FILTER (WHERE l."action" = 'viewed')::int AS "views",
                count(DISTINCT l."student") FILTER (WHERE l."action" = 'viewed')::int AS "students",
                count(*) FILTER (WHERE l."action" = 'downloaded')::int AS "downloads",
                count(*) FILTER (WHERE l."action" = 'break_glass')::int AS "breakGlass",
                count(*) FILTER (WHERE l."action" NOT IN ('viewed','downloaded','break_glass'))::int AS "changes",
                count(*) FILTER (WHERE l."action" = 'viewed' AND (EXTRACT(hour FROM l."createdAt" AT TIME ZONE '${tz}') NOT BETWEEN 7 AND 19
                                 OR EXTRACT(isodow FROM l."createdAt" AT TIME ZONE '${tz}') = 7))::int AS "outOfHours",
                COALESCE((SELECT max(n) FROM hours WHERE hours."actor" = l."actor"), 0)::int AS "busiestHour",
                max(l."createdAt") AS "last"
           FROM l GROUP BY l."actor" ORDER BY 5 DESC, 4 DESC`,
        [S(req.schoolId), d],
    );
    const s = await settingsSvc.get(req.schoolId);
    const threshold = Number(s.accessAlertThreshold) || 30;
    return {
        days: d, threshold,
        rows: rows.map((r) => ({ ...r, flags: [r.busiestHour >= threshold && `${r.busiestHour} students in one hour`, r.breakGlass && `${r.breakGlass} emergency opening${r.breakGlass === 1 ? '' : 's'}`, r.outOfHours >= 5 && `${r.outOfHours} openings out of hours`].filter(Boolean) })),
    };
}

/** After an opening: the person's last hour, against the school's threshold. */
async function watch(req) {
    try {
        if (!req?.schoolId || !req?.userId) return;
        const s = await settingsSvc.get(req.schoolId);
        const threshold = Number(s.accessAlertThreshold) || 30;
        const [r] = await run(
            `SELECT count(DISTINCT "student")::int AS n FROM "medicalauditlogs"
              WHERE "school" = $1 AND "actor" = $2 AND "action" = 'viewed' AND "student" IS NOT NULL AND "createdAt" > now() - interval '1 hour'`,
            [S(req.schoolId), S(req.userId)],
        );
        if (r.n < threshold) return;
        const { claim } = require('./medicalSweep');
        if (!(await claim(req.schoolId, 'access_anomaly', `${S(req.userId)}:${R.todayStr()}`, 'warning', { n: r.n }))) return;
        const { schoolAdminIds } = require('./notifyService');
        const admins = (await schoolAdminIds(req.schoolId)).map(S).filter((id) => id !== S(req.userId));
        await require('./medicalNotify').system(req.schoolId, {
            to: admins, priority: 'high', link: { type: 'medical.access' },
            title: 'Unusual access to medical records',
            body: `${req.user?.name || 'A member of staff'} opened the medical records of ${r.n} students in the last hour. Check the Access Review — it may be routine (a class checkup), or not.`,
        });
    } catch (e) { console.error('[medical] access watch failed:', e.message); }
}

/** Monday from 8 am: last week's figures to the admins, once. */
async function digest(schoolId, claim) {
    const now = new Date();
    if (now.getDay() !== 1 || now.getHours() < 8) return;
    if (!(await claim(schoolId, 'access_digest', R.todayStr(), 'info'))) return;
    const out = await review({ schoolId }, { days: 7 });
    if (!out.rows.length) return;
    const flagged = out.rows.filter((r) => r.flags.length);
    const top = out.rows.slice(0, 5).map((r) => `${r.name}: ${r.students} student${r.students === 1 ? '' : 's'}${r.flags.length ? ` (${r.flags.join(', ')})` : ''}`).join('; ');
    const { schoolAdminIds } = require('./notifyService');
    const admins = (await schoolAdminIds(schoolId)).map(S);
    await require('./medicalNotify').system(schoolId, {
        to: admins, link: { type: 'medical.access' },
        title: `Medical records last week${flagged.length ? ` — ${flagged.length} to look at` : ''}`,
        body: `Who opened students' medical records in the last 7 days — ${top}. The Access Review has the detail.`,
    });
}

module.exports = { review, watch, digest };
