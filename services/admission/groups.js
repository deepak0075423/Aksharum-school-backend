'use strict';
/**
 * Groups of schools — branches of one trust or chain (Oct 2026).
 *
 *   /g/<slug>          one page for families: every listed branch, what each
 *                      has open, a link to apply there
 *   preferences        a family that applied at several branches puts them in
 *                      order; each branch's office sees that order (when the
 *                      group shares status)
 *   accept one         accepting a seat at one branch can withdraw the family's
 *                      other applications in the group — their choice, ticked
 *                      when they accept, never automatic
 *   transfer           a branch offers an application to another branch at the
 *                      family's request; that branch accepts or declines
 *
 * A person is their email address (services/accountIdentity.js): the family's
 * applicant accounts at each branch share it. A school outside the group, or a
 * branch that is not listed, is never shown; nothing crosses to a school that
 * is not a member.
 */
const pool = require('../../db/pool');
const { withTransaction, lock, buildInsert } = require('../dbTx');
const AdmissionGroup = require('../../models/AdmissionGroup');
const AdmissionTransfer = require('../../models/AdmissionTransfer');
const workflow = require('./workflow');
const events = require('./events');
const { refuse, isId, str, bool, color } = require('./util');
const { textProblem } = require('../../utils/textRules');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;
const ACTIVE = (status) => !workflow.isClosed(status);

// ── The platform sets groups up ──────────────────────────────────────────────

async function normalize(input = {}, current = null) {
    const name = str(input.name ?? current?.name, 120);
    if (!name) refuse('Name the group', 400, { field: 'name' });
    const badName = textProblem(name, 'Group name', 'title'); if (badName) refuse(badName, 400, { field: 'name' });
    const slug = String(input.slug ?? current?.slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) refuse('The address uses lowercase letters, digits and single hyphens (3–40)', 400, { field: 'slug' });
    const { rows: [taken] } = await pool.query(`SELECT "_id" FROM "admissiongroups" WHERE "slug" = $1 AND "_id" <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`, [slug, current?._id || null]);
    if (taken) refuse('Another group has that address', 409, { field: 'slug' });
    const intro = str(input.intro ?? current?.intro, 1500);
    const badIntro = textProblem(intro, 'Introduction'); if (badIntro) refuse(badIntro, 400, { field: 'intro' });
    const ids = [...new Set((Array.isArray(input.members) ? input.members.map((m) => String(m?.school || m)) : (current?.members || []).map((m) => String(m.school))))].filter((x) => isId(x));
    if (ids.length < 2) refuse('A group has at least two schools', 400, { field: 'members' });
    const { rows: found } = await pool.query(`SELECT "_id" FROM "schools" WHERE "_id" = ANY($1::uuid[])`, [ids]);
    if (found.length !== ids.length) refuse('Choose schools that exist', 400, { field: 'members' });
    const { rows: elsewhere } = await pool.query(
        `SELECT g."name", m->>'school' AS school FROM "admissiongroups" g, jsonb_array_elements(g."members") m
          WHERE g."isActive" AND m->>'school' = ANY($1::text[]) AND g."_id" <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`, [ids, current?._id || null]);
    if (elsewhere.length) refuse(`A school can be in one group only — one is already in ${elsewhere[0].name}`, 409, { field: 'members' });
    const before = new Map((current?.members || []).map((m) => [String(m.school), m]));
    return {
        name, slug, intro,
        theme: { primary: color(input.theme?.primary ?? current?.theme?.primary, '#4f46e5') },
        // A school keeps its own choice to be listed; a new member starts listed.
        members: ids.map((id) => ({ school: id, listed: before.has(id) ? before.get(id).listed !== false : true })),
        shareStatus: bool(input.shareStatus ?? current?.shareStatus, false),
        isActive: bool(input.isActive ?? current?.isActive, true),
    };
}

async function list() {
    const { rows } = await pool.query(`SELECT * FROM "admissiongroups" ORDER BY "name"`);
    const ids = [...new Set(rows.flatMap((g) => (g.members || []).map((m) => m.school)))];
    const { rows: schools } = ids.length ? await pool.query(`SELECT "_id", "name" FROM "schools" WHERE "_id" = ANY($1::uuid[])`, [ids]) : { rows: [] };
    const names = new Map(schools.map((s) => [String(s._id), s.name]));
    return rows.map((g) => ({ ...g, members: (g.members || []).map((m) => ({ ...m, name: names.get(String(m.school)) || '' })) }));
}

async function save(req, id, input) {
    const current = id ? (await pool.query(`SELECT * FROM "admissiongroups" WHERE "_id" = $1`, [String(id)])).rows[0] : null;
    if (id && !current) refuse('Group not found', 404);
    const data = await normalize(input, current);
    if (current) {
        const { rows: [r] } = await pool.query(
            `UPDATE "admissiongroups" SET "name" = $2, "slug" = $3, "intro" = $4, "theme" = $5::jsonb, "members" = $6::jsonb, "shareStatus" = $7, "isActive" = $8, "updatedAt" = now() WHERE "_id" = $1 RETURNING *`,
            [current._id, data.name, data.slug, data.intro, JSON.stringify(data.theme), JSON.stringify(data.members), data.shareStatus, data.isActive]);
        return r;
    }
    const { sql, params } = buildInsert(AdmissionGroup, { ...data, createdBy: req.userId });
    return (await pool.query(sql, params)).rows[0];
}

async function remove(id) {
    const { rowCount } = await pool.query(`DELETE FROM "admissiongroups" WHERE "_id" = $1 AND NOT EXISTS (SELECT 1 FROM "admissiontransfers" t WHERE t."group" = "admissiongroups"."_id" AND t."status" IN ('pending', 'accepted'))`, [String(id)]);
    if (!rowCount) refuse('Group not found, or it has transfers in progress', 409);
    return { deleted: true };
}

// ── Reading a school's group ─────────────────────────────────────────────────

/** The active group a school belongs to, or null. */
async function groupOf(schoolId) {
    const { rows: [g] } = await pool.query(
        `SELECT * FROM "admissiongroups" WHERE "isActive" AND "members" @> $1::jsonb LIMIT 1`, [JSON.stringify([{ school: String(schoolId) }])]);
    return g || null;
}

const memberIds = (g) => (g?.members || []).map((m) => String(m.school));
const listedIds = (g) => (g?.members || []).filter((m) => m.listed !== false).map((m) => String(m.school));

/** For the school's admin: its group, and whether it is listed. */
async function forSchool(schoolId) {
    const g = await groupOf(schoolId);
    if (!g) return null;
    const { rows: schools } = await pool.query(`SELECT s."_id", s."name", st."slug" FROM "schools" s LEFT JOIN "admissionsettings" st ON st."school" = s."_id" WHERE s."_id" = ANY($1::uuid[])`, [memberIds(g)]);
    return {
        _id: g._id, name: g.name, slug: g.slug, shareStatus: g.shareStatus,
        listed: g.members.find((m) => String(m.school) === String(schoolId))?.listed !== false,
        branches: schools.filter((s) => String(s._id) !== String(schoolId)).map((s) => ({ _id: s._id, name: s.name, slug: s.slug })),
    };
}

async function setListed(req, listed) {
    const g = await groupOf(req.schoolId);
    if (!g) refuse('This school is not in a group', 404);
    const members = g.members.map((m) => (String(m.school) === String(req.schoolId) ? { ...m, listed: !!listed } : m));
    await pool.query(`UPDATE "admissiongroups" SET "members" = $2::jsonb, "updatedAt" = now() WHERE "_id" = $1`, [g._id, JSON.stringify(members)]);
    events.recordQuietly(req.schoolId, { by: req, type: 'settings', action: 'group_listing', message: `${listed ? 'Listed on' : 'Taken off'} the ${g.name} group page` });
    return forSchool(req.schoolId);
}

// ── The group page ───────────────────────────────────────────────────────────

/** /g/<slug>: the listed branches with live portals, and what each has open. */
async function publicView(slug) {
    const { rows: [g] } = await pool.query(`SELECT * FROM "admissiongroups" WHERE "slug" = $1 AND "isActive"`, [String(slug || '').toLowerCase()]);
    if (!g) refuse('There is no group page at this address', 404);
    const settingsSvc = require('./settings');
    const branches = [];
    const { rows: schools } = await pool.query(`SELECT "_id", "name", "logo", "city", "state", "address" FROM "schools" WHERE "_id" = ANY($1::uuid[]) AND "isActive" IS NOT FALSE ORDER BY "name"`, [listedIds(g)]);
    for (const s of schools) {
        const st = await settingsSvc.getSettings(s._id);
        if (!st.slug || !['open', 'closed'].includes(st.portal?.status)) continue;
        const { rows: rounds } = await pool.query(
            `SELECT r."_id", r."name", r."closesAt", r."classes" FROM "admissionrounds" r
              WHERE r."school" = $1 AND r."status" = 'open' AND (r."opensAt" IS NULL OR r."opensAt" <= now()) AND (r."closesAt" IS NULL OR r."closesAt" >= now())`, [s._id]);
        const classIds = [...new Set(rounds.flatMap((r) => (r.classes || []).filter((c) => c.isOpen !== false).map((c) => String(c.class))))];
        const { rows: classes } = classIds.length ? await pool.query(`SELECT "_id", "className", "classNumber" FROM "classes" WHERE "_id" = ANY($1::uuid[]) ORDER BY "classNumber" NULLS LAST`, [classIds]) : { rows: [] };
        branches.push({
            name: s.name, logo: s.logo || '', city: s.city || '', state: s.state || '', slug: st.slug,
            accepting: st.portal.status === 'open' && rounds.length > 0,
            classes: classes.map((c) => c.className),
            closesAt: rounds.map((r) => r.closesAt).filter(Boolean).sort()[0] || null,
            visits: !!st.visits?.enabled,
        });
    }
    return { name: g.name, slug: g.slug, intro: g.intro, theme: g.theme, shareStatus: g.shareStatus, branches };
}

// ── The family across branches ───────────────────────────────────────────────

/** The family's applicant accounts in the group — the same email, active, at member schools. */
async function sameFamily(g, email) {
    const { rows } = await pool.query(
        `SELECT "_id", "school" FROM "users" WHERE lower("email") = lower($1) AND "role" = 'guest' AND "isActive" IS NOT FALSE AND "school" = ANY($2::uuid[])`,
        [String(email || ''), memberIds(g)]);
    return rows;
}

async function familyApplications(g, email) {
    const users = await sameFamily(g, email);
    if (!users.length) return [];
    const { rows } = await pool.query(
        `SELECT a."_id", a."school", a."applicationNumber", a."studentName", a."status", a."groupRank", a."submittedAt", a."applicant",
                c."className", s."name" AS "schoolName", st."slug"
           FROM "admissionapplications" a JOIN "schools" s ON s."_id" = a."school" LEFT JOIN "classes" c ON c."_id" = a."class"
           LEFT JOIN "admissionsettings" st ON st."school" = a."school"
          WHERE a."applicant" = ANY($1::uuid[]) AND a."status" <> 'draft' AND a."erasedAt" IS NULL
          ORDER BY a."groupRank" NULLS LAST, a."submittedAt"`, [users.map((u) => u._id)]);
    return rows.map((r) => ({ ...r, statusLabel: workflow.STATUSES[r.status]?.applicant || workflow.STATUSES[r.status]?.label || r.status, open: ACTIVE(r.status) }));
}

/** For the signed-in family: the group, and their applications at every branch. */
async function familyView(req) {
    const g = await groupOf(req.schoolId);
    if (!g) return null;
    const { rows: [me] } = await pool.query(`SELECT "email" FROM "users" WHERE "_id" = $1`, [String(req.userId)]);
    return { name: g.name, slug: g.slug, shareStatus: g.shareStatus, applications: await familyApplications(g, me?.email) };
}

/** The family puts its open applications across the group in order. */
async function setPreferences(req, order = []) {
    const g = await groupOf(req.schoolId);
    if (!g) refuse('This school is not in a group', 404);
    const { rows: [me] } = await pool.query(`SELECT "email" FROM "users" WHERE "_id" = $1`, [String(req.userId)]);
    const mine = await familyApplications(g, me?.email);
    const open = new Map(mine.filter((a) => a.open).map((a) => [String(a._id), a]));
    const ids = [...new Set((Array.isArray(order) ? order : []).map(String))];
    if (!ids.length || ids.some((id) => !open.has(id))) refuse('Put only your open applications in order', 400, { field: 'order' });
    await withTransaction(async (q) => {
        await q(`UPDATE "admissionapplications" SET "groupRank" = NULL WHERE "_id" = ANY($1::uuid[])`, [[...open.keys()]]);
        for (let i = 0; i < ids.length; i += 1) await q(`UPDATE "admissionapplications" SET "groupRank" = $2 WHERE "_id" = $1`, [ids[i], i + 1]);
    });
    for (let i = 0; i < ids.length; i += 1) {
        const a = open.get(ids[i]);
        events.recordQuietly(a.school, { application: a._id, by: req, type: 'group', action: 'preference', message: `The family put this branch ${i + 1} of ${ids.length} in their order of preference`, visibility: 'applicant' });
    }
    return familyView(req);
}

/**
 * Accepting a seat here: the family's other open applications in the group are
 * withdrawn — only because the family ticked it when accepting. Each is a
 * withdrawal by the family, recorded at its own branch.
 */
async function withdrawSiblings(req, keepApp) {
    const g = await groupOf(keepApp.school);
    if (!g) return 0;
    const { rows: [me] } = await pool.query(`SELECT "email" FROM "users" WHERE "_id" = $1`, [String(req.userId)]);
    const { rows: [here] } = await pool.query(`SELECT "name" FROM "schools" WHERE "_id" = $1`, [String(keepApp.school)]);
    const apps = require('./applications');
    let n = 0;
    for (const a of await familyApplications(g, me?.email)) {
        if (String(a._id) === String(keepApp._id) || !a.open || ['enrolled', 'confirmed'].includes(a.status)) continue;
        const { rows: [row] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [a._id]);
        try {
            await apps.move({ ...req, userId: row.applicant, schoolId: row.school }, row, 'withdrawn', { reason: `Accepted a seat at ${here?.name || 'another branch'}`, system: true, actorIsApplicant: true });
            n += 1;
        } catch (e) { console.error('[admission] withdraw sibling:', e.message); }
    }
    return n;
}

/** For the office: the same family's applications at the other branches (when the group shares status). */
async function officeSiblings(app) {
    const g = await groupOf(app.school);
    if (!g || !g.shareStatus) return null;
    const { rows: [u] } = await pool.query(`SELECT "email" FROM "users" WHERE "_id" = $1`, [String(app.applicant)]);
    const all = await familyApplications(g, u?.email);
    return {
        group: g.name,
        rank: all.find((x) => String(x._id) === String(app._id))?.groupRank ?? null,
        others: all.filter((x) => String(x._id) !== String(app._id)).map((x) => ({ schoolName: x.schoolName, applicationNumber: x.applicationNumber, className: x.className, status: x.status, statusLabel: workflow.STATUSES[x.status]?.label || x.status, groupRank: x.groupRank })),
    };
}

// ── Moving an application to another branch ──────────────────────────────────

async function offerTransfer(req, app, input = {}) {
    const g = await groupOf(app.school);
    if (!g) refuse('This school is not in a group', 409);
    if (!ACTIVE(app.status) || app.status === 'draft') refuse('Only an open, submitted application can be moved', 409);
    const toSchool = String(input.toSchool || '');
    if (!memberIds(g).includes(toSchool) || toSchool === String(app.school)) refuse('Choose another branch of the group', 400, { field: 'toSchool' });
    const reason = str(input.reason, 500);
    if (reason.length < 5) refuse('Say why — usually, what the family asked for', 400, { field: 'reason' });
    const bad = textProblem(reason, 'Reason'); if (bad) refuse(bad, 400, { field: 'reason' });
    const { rows: [open] } = await pool.query(`SELECT 1 FROM "admissiontransfers" WHERE "fromApplication" = $1 AND "status" IN ('pending', 'accepted')`, [String(app._id)]);
    if (open) refuse('A move of this application is already in progress', 409);
    const { sql, params } = buildInsert(AdmissionTransfer, { group: g._id, fromSchool: app.school, fromApplication: app._id, toSchool, reason, status: 'pending', requestedBy: req.userId });
    const { rows: [t] } = await pool.query(sql, params);
    const { rows: [to] } = await pool.query(`SELECT "name" FROM "schools" WHERE "_id" = $1`, [toSchool]);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'group', action: 'transfer_offered', message: `Offered to ${to?.name || 'another branch'} — ${reason}` });
    return t;
}

async function transfers(req) {
    const { rows } = await pool.query(
        `SELECT t.*, fs."name" AS "fromSchoolName", ts."name" AS "toSchoolName", a."applicationNumber", a."studentName", c."className", c."classNumber"
           FROM "admissiontransfers" t JOIN "schools" fs ON fs."_id" = t."fromSchool" JOIN "schools" ts ON ts."_id" = t."toSchool"
           JOIN "admissionapplications" a ON a."_id" = t."fromApplication" LEFT JOIN "classes" c ON c."_id" = a."class"
          WHERE t."fromSchool" = $1 OR t."toSchool" = $1 ORDER BY t."createdAt" DESC LIMIT 200`, [String(req.schoolId)]);
    return rows.map((t) => ({ ...t, direction: String(t.toSchool) === String(req.schoolId) ? 'in' : 'out' }));
}

/**
 * The receiving branch answers. Accepting copies the answers (those its form
 * asks) and the documents into a draft for the family — under the family's
 * applicant account there, made with the same email and password if they have
 * none — and the family checks and submits it. Their first application is
 * withdrawn when they do (completeTransfer).
 */
async function decideTransfer(req, id, { accept, round, class: classId, answer }) {
    if (!isId(String(id || ''))) refuse('Transfer not found', 404);
    const reply = str(answer, 500);
    const t0 = (await pool.query(`SELECT * FROM "admissiontransfers" WHERE "_id" = $1 AND "toSchool" = $2`, [String(id), String(req.schoolId)])).rows[0];
    if (!t0) refuse('Transfer not found', 404);
    if (t0.status !== 'pending') refuse('This transfer has been answered', 409);
    if (!accept) {
        if (!reply) refuse('Say why — the other branch is told', 400, { field: 'answer' });
        const { rows: [t] } = await pool.query(`UPDATE "admissiontransfers" SET "status" = 'declined', "answer" = $2, "decidedBy" = $3, "decidedAt" = now(), "updatedAt" = now() WHERE "_id" = $1 AND "status" = 'pending' RETURNING *`, [t0._id, reply, req.userId]);
        events.recordQuietly(t0.fromSchool, { application: t0.fromApplication, by: req, type: 'group', action: 'transfer_declined', message: `The other branch declined the move — ${reply}` });
        return t;
    }
    if (!isId(String(round || '')) || !isId(String(classId || ''))) refuse('Choose the round and class it joins', 400, { field: 'round' });
    const { rows: [src] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [t0.fromApplication]);
    if (!src || !ACTIVE(src.status)) refuse('The application has closed since the move was offered', 409);
    const { rows: [srcUser] } = await pool.query(`SELECT * FROM "users" WHERE "_id" = $1`, [src.applicant]);
    const apps = require('./applications');
    const settingsSvc = require('./settings');
    const portal = { school: { _id: req.schoolId }, settings: await settingsSvc.getSettings(req.schoolId) };

    const result = await withTransaction(async (q) => {
        await lock(q, `admission-transfer:${t0._id}`);
        // The family's applicant account at this branch: theirs already, or made with the same email and password.
        let { rows: [guest] } = await q(`SELECT * FROM "users" WHERE lower("email") = lower($1) AND "school" = $2 AND "role" = 'guest'`, [srcUser.email, String(req.schoolId)]);
        if (!guest) {
            const User = require('../../models/User');
            const ins = buildInsert(User, { name: srcUser.name, email: srcUser.email, phone: srcUser.phone || '', role: 'guest', school: req.schoolId, password: srcUser.password, isFirstLogin: false, isActive: true });
            guest = (await q(ins.sql, ins.params)).rows[0];
            const AdmissionApplicant = require('../../models/AdmissionApplicant');
            // Not consented here yet: the consent gate asks them to agree to this branch's notice first.
            const ap = buildInsert(AdmissionApplicant, { school: req.schoolId, user: guest._id, phone: srcUser.phone || '', verifiedAt: new Date(), consentVersion: 0, source: 'transfer', linkedExisting: true });
            await q(ap.sql, ap.params);
        }
        return { guest };
    });
    const draft = await apps.createDraft({ ...req, userId: result.guest._id }, portal, { roundId: round, classId, source: 'transfer' });
    // The answers this branch's form also asks — copied as given; the family checks them before submitting.
    const schema = await apps.schemaOf(draft);
    const keys = new Set(require('./formEngine').allFields(schema).map((f) => f.key));
    const data = Object.fromEntries(Object.entries(src.data || {}).filter(([k]) => keys.has(k)));
    await pool.query(`UPDATE "admissionapplications" SET "data" = $2::jsonb, "studentName" = $3, "studentDob" = $4, "transferFrom" = $5, "updatedAt" = now() WHERE "_id" = $1`,
        [draft._id, JSON.stringify({ ...(draft.data || {}), ...data }), src.studentName, src.studentDob, src._id]);
    // The documents, copied file by file into this branch's storage.
    const fileStore = require('./fileStore');
    const { rows: docs } = await pool.query(`SELECT * FROM "admissiondocuments" WHERE "application" = $1 AND "current"`, [src._id]);
    const { rows: types } = await pool.query(`SELECT "_id", "key" FROM "admissiondocumenttypes" WHERE "school" = $1 AND "isActive" IS NOT FALSE`, [String(req.schoolId)]);
    const typeByKey = new Map(types.map((x) => [x.key, x]));
    const os = require('os'); const path = require('path'); const crypto = require('crypto'); const fs = require('fs');
    const AdmissionDocument = require('../../models/AdmissionDocument');
    let copied = 0;
    for (const d of docs) {
        const type = typeByKey.get(d.docKey);
        if (!type) continue;
        const tmp = path.join(os.tmpdir(), `adm-transfer-${crypto.randomUUID()}`);
        try {
            await fileStore.copyToFile(d.file, tmp);
            const ext = path.extname(d.file) || '';
            const key = `${req.schoolId}/${crypto.randomUUID()}${ext}`;
            await fileStore.save(tmp, key, d.mime);
            const { sql, params } = buildInsert(AdmissionDocument, {
                school: req.schoolId, application: draft._id, applicant: result.guest._id, docType: type._id, docKey: d.docKey, fieldKey: d.fieldKey,
                file: key, originalName: d.originalName, mime: d.mime, size: d.size, sha256: d.sha256, status: 'uploaded', version: 1, current: true,
                uploadedBy: req.userId, scanStatus: d.scanStatus || '', scannedAt: d.scannedAt || null,
                history: [{ status: 'uploaded', by: String(req.userId), at: new Date(), note: 'Copied from the other branch' }],
            });
            await pool.query(sql, params);
            copied += 1;
        } catch (e) {
            console.error('[admission] transfer document:', e.message);
        } finally { fs.promises.unlink(tmp).catch(() => {}); }
    }
    const { rows: [t] } = await pool.query(
        `UPDATE "admissiontransfers" SET "status" = 'accepted', "toRound" = $2, "toClass" = $3, "toApplication" = $4, "answer" = $5, "decidedBy" = $6, "decidedAt" = now(), "updatedAt" = now()
          WHERE "_id" = $1 AND "status" = 'pending' RETURNING *`, [t0._id, round, classId, draft._id, reply, req.userId]);
    const { rows: [here] } = await pool.query(`SELECT "name" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)]);
    events.recordQuietly(req.schoolId, { application: draft._id, by: req, type: 'group', action: 'transfer_in', message: `Moved here from another branch — answers and ${copied} document(s) copied. Check and submit it to finish the move.`, visibility: 'applicant' });
    events.recordQuietly(t0.fromSchool, { application: src._id, by: req, type: 'group', action: 'transfer_accepted', visibility: 'applicant', message: `${here?.name || 'The other branch'} has taken the application — check and submit it there to finish the move` });
    require('./notify').toApplicant(src, 'status_update', { remarks: `${here?.name || 'The other branch'} has taken your application. Sign in to its admission portal with the same email and password, check the application and submit it; this one is then withdrawn.` });
    return t;
}

/** The branch that offered a move takes it back, before the other branch answers. */
async function cancelTransfer(req, id) {
    if (!isId(String(id || ''))) refuse('Transfer not found', 404);
    const { rows: [t] } = await pool.query(`UPDATE "admissiontransfers" SET "status" = 'cancelled', "updatedAt" = now() WHERE "_id" = $1 AND "fromSchool" = $2 AND "status" = 'pending' RETURNING *`, [String(id), String(req.schoolId)]);
    if (!t) refuse('Only a move not yet answered can be taken back', 409);
    events.recordQuietly(req.schoolId, { application: t.fromApplication, by: req, type: 'group', action: 'transfer_cancelled', message: 'The offer to move the application was taken back' });
    return t;
}

/** The family submitted the moved application: the first one is withdrawn, the move is done. */
async function completeTransfer(req, app) {
    if (!app.transferFrom) return;
    const { rows: [t] } = await pool.query(`UPDATE "admissiontransfers" SET "status" = 'completed', "updatedAt" = now() WHERE "toApplication" = $1 AND "status" = 'accepted' RETURNING *`, [String(app._id)]);
    if (!t) return;
    const { rows: [src] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [t.fromApplication]);
    const { rows: [here] } = await pool.query(`SELECT "name" FROM "schools" WHERE "_id" = $1`, [String(app.school)]);
    if (src && ACTIVE(src.status)) {
        await require('./applications').move({ ...req, userId: src.applicant, schoolId: src.school }, src, 'withdrawn', { reason: `Moved to ${here?.name || 'another branch'}`, system: true, actorIsApplicant: true }).catch((e) => console.error('[admission] transfer withdraw:', e.message));
    }
}

module.exports = {
    normalize, list, save, remove, groupOf, forSchool, setListed, publicView, familyView, setPreferences, withdrawSiblings, officeSiblings,
    offerTransfer, transfers, decideTransfer, cancelTransfer, completeTransfer,
};
