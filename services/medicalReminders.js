'use strict';
/**
 * What is due now, said on the minute (Oct 2026) — live on the web and the
 * phone, from the same ticker as the urgent notices (server.js):
 *
 *   doses     a scheduled dose's time has come: the medical staff get one
 *             notice per school and time ("Medicine round — 12:30 pm"), and
 *             the student a reminder to come to the Medical Room — never which
 *             medicine (a student's page never shows medicines), and only when
 *             the school lets students open their Medical Room page
 *   rechecks  a child in the room is due their next readings (the protocol's
 *             recheck, visit.nextCheckAt)
 *
 * Each is claimed in medicalalerts before anyone is told, so a second server
 * or a restart tells nobody twice. Each sits behind its switch in the
 * school's settings (staffMedicineRound, studentReminders, staffRecheck).
 */
const pool = require('../db/pool');
const tell = require('./medicalNotify');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const { claim } = require('./medicalSweep');

const S = (v) => String(v);
const timeOf = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
const list = (lines, max = 8) => (lines.length > max ? `${lines.slice(0, max).join('; ')}; and ${lines.length - max} more` : lines.join('; '));

/** Doses whose time came in the last ten minutes (the window survives a ticker that paused). */
async function doses() {
    const { rows } = await pool.query(
        `SELECT d."_id"::text AS id, d."school"::text AS school, d."student"::text AS student, d."scheduledFor",
                d."medicineName", d."dosage", u."name" AS "studentName"
           FROM "medicationdoses" d JOIN "users" u ON u."_id" = d."student" AND u."isActive" IS NOT FALSE
          WHERE d."status" = 'scheduled' AND d."scheduledFor" <= now() AND d."scheduledFor" > now() - interval '10 minutes'
          ORDER BY d."school", d."scheduledFor"`,
    );
    const bySchool = new Map();
    for (const r of rows) {
        if (!bySchool.has(r.school)) bySchool.set(r.school, []);
        bySchool.get(r.school).push(r);
    }
    let told = 0;
    for (const [school, due] of bySchool) {
        try {
            const s = await settingsSvc.get(school);
            const fresh = [];
            for (const d of due) if (await claim(school, 'dose_due', d.id, 'info')) fresh.push(d);
            if (!fresh.length) continue;
            told += fresh.length;
            if (s.notify?.staffMedicineRound !== false) {
                const cards = await access.studentCards(school, fresh.map((d) => d.student));
                const times = [...new Set(fresh.map((d) => timeOf(d.scheduledFor)))].join(', ');
                await tell.system(school, {
                    to: await tell.staffIds(school), link: { type: 'medical.round' },
                    title: `Medicine round — ${times}`,
                    body: `${fresh.length === 1 ? 'A dose is' : `${fresh.length} doses are`} due now: ${list(fresh.map((d) => `${d.studentName}${cards.get(d.student)?.classLabel ? ` (${cards.get(d.student).classLabel})` : ''} — ${d.medicineName}${d.dosage ? `, ${d.dosage}` : ''}`))}.`,
                });
            }
            if (s.notify?.studentReminders !== false && s.studentAccess !== false) {
                const byStudent = new Map();
                for (const d of fresh) if (!byStudent.has(d.student)) byStudent.set(d.student, d);
                for (const [student, d] of byStudent) {
                    const time = timeOf(d.scheduledFor);
                    await tell.system(school, {
                        to: [student], link: { type: 'medical.child', params: { child: student } },
                        title: `Medical Room at ${time}`,
                        body: `Time for your medicine: please go to the Medical Room now (${time}).`,
                        i18n: { key: 'dose_due_student', vars: { time } },
                    });
                }
            }
        } catch (e) { console.error('[medical] dose reminders failed:', e.message); }
    }
    return told;
}

/** Children in the room whose next readings are due (a recheck fallen due in the last half hour). */
async function rechecks() {
    const { rows } = await pool.query(
        `SELECT v."_id"::text AS id, v."school"::text AS school, v."student"::text AS student, v."number", v."reason",
                v."nextCheckAt", v."protocol", v."triage", u."name" AS "studentName"
           FROM "medicalvisits" v JOIN "users" u ON u."_id" = v."student"
          WHERE v."status" IN ('in_room','observation','emergency') AND v."archivedAt" IS NULL
            AND v."nextCheckAt" <= now() AND v."nextCheckAt" > now() - interval '30 minutes'`,
    );
    let told = 0;
    for (const v of rows) {
        try {
            if (!(await claim(v.school, 'recheck', `${v.id}:${new Date(v.nextCheckAt).toISOString()}`, 'warning'))) continue;
            const s = await settingsSvc.get(v.school);
            if (s.notify?.staffRecheck === false) continue;
            told += 1;
            const what = v.protocol?.title || v.reason || 'their visit';
            const red = ['red', 'orange'].includes(v.triage?.level);
            await tell.system(v.school, {
                to: await tell.staffIds(v.school), link: { type: 'medical.room' }, priority: red ? 'high' : null,
                title: `Recheck due — ${v.studentName}`,
                body: `${v.number}: ${v.studentName} (${what}) is due their next readings now (${timeOf(v.nextCheckAt)}).`,
            });
        } catch (e) { console.error('[medical] recheck reminder failed:', e.message); }
    }
    return told;
}

let lastPrune = 0;
/** Once an hour: forget the claims of reminders long past. */
async function prune() {
    if (Date.now() - lastPrune < 3600000) return;
    lastPrune = Date.now();
    await pool.query(`DELETE FROM "medicalalerts" WHERE "kind" IN ('dose_due','recheck') AND "notifiedAt" < now() - interval '2 days'`).catch(() => {});
}

async function tick() {
    const d = await doses().catch((e) => { console.error('[medical] dose reminders failed:', e.message); return 0; });
    const r = await rechecks().catch((e) => { console.error('[medical] recheck reminders failed:', e.message); return 0; });
    await prune();
    return { doses: d, rechecks: r };
}

module.exports = { tick, doses, rechecks, timeOf };
