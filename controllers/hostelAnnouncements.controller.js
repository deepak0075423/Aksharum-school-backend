'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel → Announcements: write, schedule, send, archive.
//
//  The list itself is GET /hostel/admin/board/announcements. Sending goes
//  through services/hostelAnnouncements.publish(), which claims the row first,
//  so "Send now" and the minute sweep can never both deliver one notice.
//
//  Scope: an announcement covers `hostels` ([] = the whole school). A warden
//  may touch one only when every hostel it covers is one of theirs; a
//  school-wide notice belongs to the module's admins.
// ─────────────────────────────────────────────────────────────────────────────
const HostelAnnouncement = require('../models/HostelAnnouncement');
const { ok, bad, fail, visibleHostelIds, logAudit, diffFields } = require('../services/hostelService');
const A = require('../services/hostelAnnouncements');

const EDITABLE = ['title', 'message', 'category', 'audience', 'attachments', 'sendEmail', 'urgent', 'hostel', 'scheduledAt'];
/** A minute's grace, so "in a moment" is not refused for being in the past. */
const SOON = 60 * 1000;

/** The hostels a new or edited notice covers, or an error message. */
async function coverage(req, hostel) {
    const allowed = await visibleHostelIds(req);
    if (hostel) {
        if (allowed !== null && !allowed.includes(String(hostel))) return { error: 'You do not have access to this hostel' };
        return { hostel, hostels: [String(hostel)] };
    }
    if (allowed === null) return { hostel: null, hostels: [] };
    if (!allowed.length) return { error: 'You are not posted to any hostel' };
    return { hostel: null, hostels: allowed };
}

async function mayManage(req, ann) {
    const allowed = await visibleHostelIds(req);
    if (allowed === null) return true;
    const covers = (ann.hostels || []).map(String);
    return covers.length > 0 && covers.every((h) => allowed.includes(h));
}

/** Accepts the old send form's names (`body`, `email`) as well as the new ones. */
function readBody(b = {}) {
    const out = {
        title: String(b.title ?? '').trim(),
        message: String(b.message ?? b.body ?? '').trim(),
        category: A.CATEGORIES.includes(b.category) ? b.category : 'general',
        audience: b.audience || 'residents',
        attachments: Array.isArray(b.attachments) ? b.attachments.filter((f) => typeof f === 'string' && /^[\w.-]+$/.test(f)).slice(0, 10) : [],
        sendEmail: !!(b.sendEmail ?? b.email),
        urgent: !!b.urgent,
        hostel: b.hostel || null,
    };
    return out;
}

function checkMode(mode, scheduledAt) {
    if (!['send', 'draft', 'schedule'].includes(mode)) return 'Unknown action';
    if (mode === 'schedule') {
        const at = new Date(scheduledAt);
        if (!scheduledAt || Number.isNaN(at.getTime())) return 'Choose when it should go out';
        if (at.getTime() < Date.now() - SOON) return 'That time has already passed';
    }
    return null;
}

const out = (row) => row?.toObject?.() ?? row;

exports.getAnnouncement = async (req, res) => {
    try {
        const row = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('hostel', 'name').lean();
        if (!row) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, { hostels: row.hostels })) return bad(res, 'You do not have access to this announcement', 403);
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** How many people an audience is right now — the compose form shows it. */
exports.audienceSize = async (req, res) => {
    try {
        const c = await coverage(req, req.query.hostel || null);
        if (c.error) return bad(res, c.error, 403);
        const ids = await A.recipientsFor({ school: req.schoolId, hostels: c.hostels, audience: req.query.audience || 'residents' });
        ok(res, { count: ids.length });
    } catch (e) { e.status === 400 ? bad(res, e.message) : fail(res, e); }
};

/**
 * POST /admin/announcements — { …, mode: 'send' | 'draft' | 'schedule', scheduledAt }.
 * Without a mode it sends at once, as the old form did.
 */
exports.createAnnouncement = async (req, res) => {
    try {
        const b = readBody(req.body);
        const mode = req.body.mode || 'send';
        if (!b.title) return bad(res, 'A title is required');
        if (!b.message) return bad(res, 'A message is required');
        if (!A.AUDIENCES.includes(b.audience)) return bad(res, 'Unsupported audience');
        const wrong = checkMode(mode, req.body.scheduledAt);
        if (wrong) return bad(res, wrong);
        const c = await coverage(req, b.hostel);
        if (c.error) return bad(res, c.error, 403);

        // Refuse an empty audience before anything is written, so a failed send
        // does not leave a draft behind that nobody asked for.
        if (mode === 'send' && !(await A.recipientsFor({ school: req.schoolId, hostels: c.hostels, audience: b.audience })).length) {
            return bad(res, 'That audience has no one in it');
        }

        const row = await HostelAnnouncement.create({
            ...b, hostel: c.hostel, hostels: c.hostels, school: req.schoolId,
            status: mode === 'schedule' ? 'scheduled' : 'draft',
            scheduledAt: mode === 'schedule' ? new Date(req.body.scheduledAt) : null,
            createdBy: req.userId, createdByName: req.user?.name || '',
        });
        await logAudit(req, { action: 'create', entityType: 'HostelAnnouncement', entityId: row._id, hostel: c.hostel,
            description: mode === 'schedule' ? `Scheduled announcement "${row.title}" for ${new Date(row.scheduledAt).toLocaleString('en-IN')}`
                : mode === 'draft' ? `Saved announcement draft "${row.title}"` : `Created announcement "${row.title}"` });

        if (mode !== 'send') return ok(res, out(row));
        const sent = await A.publish(row._id, req);
        ok(res, { ...out(sent), sent: sent.recipients, audience: sent.audience });
    } catch (e) { e.status && e.status < 500 ? bad(res, e.message, e.status) : fail(res, e); }
};

/** Edit a draft or a scheduled notice; `mode` may also move it on. */
exports.updateAnnouncement = async (req, res) => {
    try {
        const before = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, before)) return bad(res, 'You do not have access to this announcement', 403);
        if (!['draft', 'scheduled'].includes(before.status)) return bad(res, 'Only a draft or a scheduled announcement can be edited — a sent one has already reached people', 409);

        const b = readBody({ ...before, ...req.body });
        const mode = req.body.mode || (before.status === 'scheduled' ? 'schedule' : 'draft');
        if (!b.title) return bad(res, 'A title is required');
        if (!b.message) return bad(res, 'A message is required');
        if (!A.AUDIENCES.includes(b.audience)) return bad(res, 'Unsupported audience');
        const at = req.body.scheduledAt ?? before.scheduledAt;
        const wrong = checkMode(mode, at);
        if (wrong) return bad(res, wrong);
        const c = await coverage(req, b.hostel);
        if (c.error) return bad(res, c.error, 403);

        const set = {
            ...b, hostel: c.hostel, hostels: c.hostels, lastError: '',
            status: mode === 'schedule' ? 'scheduled' : 'draft',
            scheduledAt: mode === 'schedule' ? new Date(at) : null,
        };
        // Only while it is still what it was — the sweep may have taken it meanwhile.
        const row = await HostelAnnouncement.findOneAndUpdate({ _id: before._id, status: before.status }, { $set: set }, { new: true });
        if (!row) return bad(res, 'It was sent while you were editing it', 409);
        const d = diffFields(before, row, EDITABLE.concat('status'));
        await logAudit(req, { action: 'update', entityType: 'HostelAnnouncement', entityId: row._id, hostel: row.hostel,
            description: `Updated announcement "${row.title}"`, before: d.before, after: d.after });

        if (mode !== 'send') return ok(res, out(row));
        const sent = await A.publish(row._id, req);
        ok(res, { ...out(sent), sent: sent.recipients });
    } catch (e) { e.status && e.status < 500 ? bad(res, e.message, e.status) : fail(res, e); }
};

exports.sendAnnouncementNow = async (req, res) => {
    try {
        const row = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, row)) return bad(res, 'You do not have access to this announcement', 403);
        const sent = await A.publish(row._id, req);
        ok(res, { ...out(sent), sent: sent.recipients });
    } catch (e) { e.status && e.status < 500 ? bad(res, e.message, e.status) : fail(res, e); }
};

exports.archiveAnnouncement = async (req, res) => {
    try {
        const row = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, row)) return bad(res, 'You do not have access to this announcement', 403);
        if (['archived', 'sending'].includes(row.status)) return bad(res, row.status === 'archived' ? 'It is already archived' : 'It is being sent right now', 409);
        const next = await HostelAnnouncement.findOneAndUpdate({ _id: row._id, status: row.status },
            { $set: { status: 'archived', archivedFrom: row.status, archivedAt: new Date(), scheduledAt: row.status === 'scheduled' ? null : row.scheduledAt } }, { new: true });
        if (!next) return bad(res, 'It changed while you were looking at it — reload and try again', 409);
        await logAudit(req, { action: 'archive', entityType: 'HostelAnnouncement', entityId: row._id, hostel: row.hostel,
            description: `Archived announcement "${row.title}"`, before: { status: row.status }, after: { status: 'archived' } });
        ok(res, out(next));
    } catch (e) { fail(res, e); }
};

/** Back to where it was — except that an archived schedule comes back as a draft, its time gone. */
exports.restoreAnnouncement = async (req, res) => {
    try {
        const row = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, row)) return bad(res, 'You do not have access to this announcement', 403);
        if (row.status !== 'archived') return bad(res, 'Only an archived announcement can be restored', 409);
        const to = row.archivedFrom === 'published' ? 'published' : 'draft';
        const next = await HostelAnnouncement.findByIdAndUpdate(row._id, { $set: { status: to, archivedFrom: '', archivedAt: null } }, { new: true });
        await logAudit(req, { action: 'restore', entityType: 'HostelAnnouncement', entityId: row._id, hostel: row.hostel,
            description: `Restored announcement "${row.title}"`, before: { status: 'archived' }, after: { status: to } });
        ok(res, out(next));
    } catch (e) { fail(res, e); }
};

/** Only what never went out can be deleted; a sent notice is archived instead. */
exports.deleteAnnouncement = async (req, res) => {
    try {
        const row = await HostelAnnouncement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Announcement not found', 404);
        if (!await mayManage(req, row)) return bad(res, 'You do not have access to this announcement', 403);
        const unsent = ['draft', 'scheduled'].includes(row.status) || (row.status === 'archived' && row.archivedFrom !== 'published');
        if (!unsent) return bad(res, 'A sent announcement cannot be deleted — archive it instead', 409);
        await HostelAnnouncement.findOneAndDelete({ _id: row._id, status: row.status });
        await logAudit(req, { action: 'delete', entityType: 'HostelAnnouncement', entityId: row._id, hostel: row.hostel,
            description: `Deleted announcement "${row.title}" (${row.status})` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};
