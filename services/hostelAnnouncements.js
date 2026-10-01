'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel announcements — who an announcement reaches, and sending it.
//
//  Sending is the one step that must not happen twice (a scheduled notice
//  published by the minute sweep AND by someone pressing Send now), so it
//  starts with a claim: one conditional UPDATE moves the row to 'sending', and
//  only the caller that got the row back goes on to notify anyone.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const HostelAnnouncement = require('../models/HostelAnnouncement');
const HostelStaffAssignment = require('../models/HostelStaffAssignment');
const { TBL, T } = require('./hostelQuery');
const { logAudit } = require('./hostelService');

const CATEGORIES = ['general', 'mess', 'maintenance', 'medical', 'discipline', 'leave', 'documents', 'safety', 'fees', 'events', 'other'];
const AUDIENCES = ['residents', 'new_residents', 'parents', 'residents_and_parents', 'staff'];
/** A resident is "new" for this long after moving in. */
const NEW_DAYS = 30;
const TABLE = T(HostelAnnouncement);
const DOC_DIR = path.join(__dirname, '..', 'uploads', 'hostel-docs');

/** `hostels` [] means the whole school. */
const hostelClause = (col, hostels, list) => {
    if (!hostels?.length) return '';
    list.push(hostels.map(String));
    return ` AND ${col} = ANY($${list.length}::uuid[])`;
};

/** The user ids an audience stands for, now. */
async function recipientsFor({ school, hostels = [], audience }) {
    if (!AUDIENCES.includes(audience)) throw Object.assign(new Error('Unsupported audience'), { status: 400 });

    const students = async (recentOnly) => {
        const list = [school];
        let sql = `SELECT DISTINCT a."student"::text AS id FROM ${TBL.allocations} a
                    WHERE a."school" = $1 AND a."status" = 'active'${hostelClause('a."hostel"', hostels, list)}`;
        if (recentOnly) { list.push(new Date(Date.now() - NEW_DAYS * 864e5)); sql += ` AND COALESCE(a."fromDate", a."createdAt") >= $${list.length}`; }
        return (await pool.query(sql, list)).rows.map((r) => r.id);
    };

    if (audience === 'residents') return students(false);
    if (audience === 'new_residents') return students(true);
    if (audience === 'parents' || audience === 'residents_and_parents') {
        const { withParents } = require('./notifyService');
        const kids = await students(false);
        const all = (await withParents(kids)).map(String);
        return audience === 'parents' ? all.filter((id) => !kids.includes(id)) : [...new Set(all)];
    }
    // Staff: everyone posted to the hostel, and its wardens.
    const list = [school];
    const posts = await pool.query(
        `SELECT DISTINCT s."staff"::text AS id FROM ${T(HostelStaffAssignment)} s
          WHERE s."school" = $1 AND s."status" = 'active'${hostelClause('s."hostel"', hostels, list)}`, list);
    const list2 = [school];
    const heads = await pool.query(
        `SELECT h."warden"::text AS w, h."assistantWarden"::text AS aw FROM ${TBL.hostels} h
          WHERE h."school" = $1 AND h."isActive"${hostelClause('h."_id"', hostels, list2)}`, list2);
    return [...new Set([...posts.rows.map((r) => r.id), ...heads.rows.flatMap((r) => [r.w, r.aw])].filter(Boolean))];
}

/** Take the row for sending, if it is still in one of `from`. */
async function claim(id, from = ['draft', 'scheduled']) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE} SET "status" = 'sending', "updatedAt" = now()
          WHERE "_id" = $1 AND "status" = ANY($2::text[]) RETURNING "_id"`, [String(id), from]);
    return rows.length > 0;
}

/**
 * Send one announcement. `req` is the person sending it — or, for the minute
 * sweep, a stand-in carrying the author as the sender. Returns the updated row;
 * throws (and puts the row back) when there is no one to send it to.
 */
async function publish(id, req, { from = ['draft', 'scheduled'] } = {}) {
    if (!await claim(id, from)) {
        const e = new Error('This announcement has already been sent or is being sent'); e.status = 409; throw e;
    }
    const ann = await HostelAnnouncement.findById(id).lean();
    // A send that cannot happen leaves a draft with the reason on it — never a
    // scheduled row the sweep would retry every minute.
    const giveBack = async (why) => HostelAnnouncement.findByIdAndUpdate(id, { $set: { status: 'draft', lastError: why } });
    let ids = [];
    try {
        ids = await recipientsFor({ school: ann.school, hostels: ann.hostels, audience: ann.audience });
    } catch (e) { await giveBack(e.message); throw e; }
    if (!ids.length) {
        await giveBack('Nobody was in that audience when it was due to go out.');
        const e = new Error('That audience has no one in it'); e.status = 400; throw e;
    }

    // Files ride on the email; the in-app notice names them.
    const files = (ann.attachments || []).map((f) => path.join(DOC_DIR, path.basename(f))).filter((f) => fs.existsSync(f));
    const { notify } = require('./notifyService');
    notify({
        school: ann.school, sender: req.userId || ann.createdBy, senderRole: req.userRole || 'system',
        title: ann.urgent ? `🚨 ${ann.title}` : ann.title,
        body: files.length ? `${ann.message}\n\nAttached: ${files.map((f) => path.basename(f)).join(', ')}` : ann.message,
        recipients: ids, email: !!ann.sendEmail || !!ann.urgent,
        link: { type: 'hostel' },
        attachmentFor: files.length ? () => files.map((f) => ({ filename: path.basename(f), path: f })) : null,
    });
    const row = await HostelAnnouncement.findByIdAndUpdate(id, { $set: {
        status: 'published', publishedAt: new Date(), recipients: ids.length, lastError: '',
        publishedBy: req.userId || ann.createdBy || null, publishedByName: req.user?.name || ann.createdByName || '',
    } }, { new: true });
    await logAudit(req, { action: 'announce', entityType: 'HostelAnnouncement', entityId: id, hostel: ann.hostel,
        description: `Announcement "${ann.title}" sent to ${ids.length} recipient(s) (${ann.audience.replace(/_/g, ' ')})`,
        meta: { audience: ann.audience, recipients: ids.length, urgent: ann.urgent, scheduled: !!ann.scheduledAt } });
    return row;
}

/**
 * The minute sweep: send what is due, and let go of any row left in 'sending'
 * by a process that died mid-send — back to a draft, never re-sent blind.
 */
async function sweepScheduled() {
    const due = await pool.query(
        `SELECT "_id", "school", "createdBy", "createdByName" FROM ${TABLE}
          WHERE "status" = 'scheduled' AND "scheduledAt" <= now() ORDER BY "scheduledAt" LIMIT 50`);
    let sent = 0;
    for (const a of due.rows) {
        const req = { schoolId: a.school, userId: a.createdBy, userRole: 'system', user: { name: a.createdByName || 'Scheduler' }, headers: {}, ip: '' };
        try { await publish(a._id, req, { from: ['scheduled'] }); sent += 1; }
        catch (e) { if (e.status !== 409) console.error(`[Hostel] scheduled announcement ${a._id}:`, e.message); }
    }
    await pool.query(
        `UPDATE ${TABLE} SET "status" = 'draft', "lastError" = 'Sending was interrupted. Check whether it reached anyone before sending it again.'
          WHERE "status" = 'sending' AND "updatedAt" < now() - interval '10 minutes'`);
    return sent;
}

module.exports = { CATEGORIES, AUDIENCES, NEW_DAYS, recipientsFor, publish, claim, sweepScheduled };
