'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee documents — the office's review and reminders, and the employee's
//  own uploads (Employee Directory module).
//
//  Office (Employee Directory admins):
//    GET  /document-desk                          every employee's documents,
//                                                 what is owed, reminders sent
//    PUT  /employees/:id/documents/:key/review    verify, or reject with a reason
//    POST /document-reminders                     remind employees of what they owe
//
//  Employee (any member of staff, whatever their designation):
//    GET  /me/documents                           my documents and their state
//    POST /me/documents/:key                      upload / re-upload one
//
//  Rejecting asks the employee to upload again; their new file notifies the
//  office that it is waiting for review. Nobody is sent an SMS or WhatsApp —
//  notifications are in-app and push, with email where the office ticks it.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const svc  = require('../services/employeeDirectoryService');
const docs = require('../services/employeeDocuments');
const designations = require('../services/designationService');
const { notify } = require('../services/notifyService');
const ActivityLog = require('../models/ActivityLog');

const { User, TeacherProfile, EmployeeChangeRequest } = svc.models;
const { EmployeeDocumentReview, EmployeeDocumentReminder } = docs.models;
const { CHANGE_AREAS } = require('../models/EmployeeChangeRequest');
const { trim } = svc;

const MODULE = 'employeeDirectory';
// A reminder that has had no answer for this long is due a follow-up.
const FOLLOW_UP_AFTER_DAYS = 3;
const REJECT_MIN = 5;
const VIEWABLE = /\.(pdf|jpe?g|png)$/i;
// The same person is not reminded twice inside this many hours: a second press
// of "Remind everyone due" should not send a second notification.
const REMIND_GAP_HOURS = 24;

/** The file a profile has no row for: an account whose record was never set up. */
const withStubs = (ids, profiles) => {
    const have = new Set(profiles.map((p) => String(p.user)));
    return [...profiles, ...ids.filter((id) => !have.has(String(id))).map((id) => ({ user: String(id) }))];
};

/**
 * Write the office's decision on one document. Two reviewers pressing at once
 * both find no row and both insert; the second insert meets the unique index,
 * and is turned into the update it should have been.
 */
async function saveReview(existing, payload) {
    if (existing) return EmployeeDocumentReview.findByIdAndUpdate(existing._id, { $set: payload });
    try { return await EmployeeDocumentReview.create(payload); }
    catch (e) {
        const row = await EmployeeDocumentReview.findOne({ employee: payload.employee, docKey: payload.docKey }).lean();
        if (!row) throw e;
        return EmployeeDocumentReview.findByIdAndUpdate(row._id, { $set: payload });
    }
}

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, e, status = 500) => {
    if (status >= 500) console.error('[employee-documents]', e);
    const message = typeof e === 'string' ? e : (status >= 500 ? 'Could not complete that' : (e?.message || 'Request failed'));
    return res.status(status).json({ success: false, message });
};

async function audit(req, { actionType, entityId, oldValue = null, newValue }) {
    await ActivityLog.create({
        user: req.userId, school: req.schoolId, actionType, entityType: 'EmployeeDocumentReview', entityId,
        oldValue, newValue: { ...newValue, ip: req.ip || '', userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
    }).catch(() => {});
}

/** Names for a set of user ids, as a Map. */
async function namesOf(ids) {
    const list = [...new Set([...ids].filter(Boolean).map(String))];
    if (!list.length) return new Map();
    const users = await User.find({ _id: { $in: list } }).select('name').lean();
    return new Map(users.map((u) => [String(u._id), u.name]));
}

const listOf = (items) => (items.length <= 1 ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// ─────────────────────────────────────────────────────────────────────────────
//  The office
// ─────────────────────────────────────────────────────────────────────────────

exports.getDocumentDesk = async (req, res) => {
    try {
        const users = await User.find({ school: req.schoolId, role: 'teacher', isActive: true })
            .select('name profileImage').lean();
        const ids = users.map((u) => String(u._id));
        const [profiles, reminders, reviews] = await Promise.all([
            ids.length ? TeacherProfile.find({ school: req.schoolId, user: { $in: ids } }).lean() : [],
            EmployeeDocumentReminder.find({ school: req.schoolId }).sort({ sentAt: -1 }).lean(),
            EmployeeDocumentReview.find({ school: req.schoolId }).select('reviewedBy history').lean(),
        ]);
        const names = await namesOf([
            ...reminders.map((r) => r.sentBy),
            ...reviews.flatMap((r) => [r.reviewedBy, ...(r.history || []).map((h) => h.by)]),
        ]);
        // An account with no staff record owes every required document — it
        // must not read as "nothing owed" because there was no row to look at.
        const byUser = await docs.documentsBySchool(req.schoolId, withStubs(ids, profiles), names);
        const profileOf = new Map(profiles.map((p) => [String(p.user), p]));
        const remindersOf = new Map();
        for (const r of reminders) {
            const k = String(r.employee);
            if (!remindersOf.has(k)) remindersOf.set(k, []);
            remindersOf.get(k).push(r);
        }

        const now = Date.now();
        const employees = users.map((u) => {
            const uid = String(u._id);
            const p = profileOf.get(uid) || {};
            const { documents, outstanding } = byUser.get(uid) || { documents: [], outstanding: [] };
            const owed = new Set(outstanding.map((o) => o.key));
            const history = (remindersOf.get(uid) || []).map((r) => docs.reminderView(r, owed, names, documents));
            const last = history[0] || null;
            const openCount = history.filter((h) => h.open).length;
            const lastAgeDays = last ? (now - new Date(last.sentAt).getTime()) / 86400000 : null;
            // Where the chase stands for this person.
            const reminderState = !outstanding.length ? (history.length ? 'resolved' : 'clear')
                : !last || !last.open ? 'not_reminded'
                    : lastAgeDays >= FOLLOW_UP_AFTER_DAYS ? 'follow_up_due' : 'awaiting';
            return {
                _id: uid,
                name: u.name,
                profileImage: u.profileImage || '',
                employeeId: p.employeeId || '',
                designation: p.designation || '',
                department: p.department || '',
                hasProfile: !!profileOf.get(uid),
                documents,
                outstanding,
                reminders: {
                    state: reminderState,
                    open: openCount,
                    total: history.length,
                    last,
                    history,
                },
            };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const all = employees.flatMap((e) => e.documents.map((d) => ({ ...d, employee: e._id })));
        ok(res, {
            employees,
            followUpAfterDays: FOLLOW_UP_AFTER_DAYS,
            counts: {
                awaitingReview: all.filter((d) => d.state === 'pending' || d.state === 'resubmitted').length,
                resubmitted:    all.filter((d) => d.state === 'resubmitted').length,
                rejected:       all.filter((d) => d.state === 'rejected').length,
                verified:       all.filter((d) => d.state === 'verified').length,
                missing:        all.filter((d) => d.state === 'missing' && d.required).length,
                owing:          employees.filter((e) => e.outstanding.length).length,
                notReminded:    employees.filter((e) => e.reminders.state === 'not_reminded').length,
                awaiting:       employees.filter((e) => e.reminders.state === 'awaiting').length,
                followUpDue:    employees.filter((e) => e.reminders.state === 'follow_up_due').length,
                sent:           reminders.length,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.reviewDocument = async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const key = String(req.params.key || '');
        const def = docs.DEF_BY_KEY.get(key);
        if (!def) return fail(res, 'Unknown document', 400);

        const status  = trim(req.body?.status);
        const comment = trim(req.body?.comment);
        if (!['verified', 'rejected'].includes(status)) return fail(res, 'Choose verify or reject', 400);
        if (status === 'rejected' && comment.length < REJECT_MIN) {
            return fail(res, 'Say why the document is rejected — the employee is shown this when they upload it again', 400);
        }

        const user = await User.findOne({ _id: id, school: req.schoolId, role: 'teacher' }).select('name').lean().catch(() => null);
        if (!user) return fail(res, 'Employee not found', 404);
        // Nobody signs off their own paperwork, whatever their designation.
        if (String(req.userId) === id) {
            return fail(res, 'You cannot review your own documents — another administrator has to', 403);
        }
        // A bank document sits behind the same gate as the account number.
        if (def.gate === 'bank') {
            const viewer = await svc.resolveViewer(req);
            if (!svc.visibilityFor(viewer, id).bank) {
                return fail(res, 'Bank documents are reviewed by the school administrator or a payroll administrator', 403);
            }
        }
        const profile = await TeacherProfile.findOne({ user: id, school: req.schoolId }).lean();
        const file = trim(profile?.[key]);
        if (!file) return fail(res, `${def.label} has not been uploaded, so there is nothing to review`, 400);

        const existing = await EmployeeDocumentReview.findOne({ employee: id, docKey: key }).lean();
        // The decision is about the file on screen. If a different one has
        // arrived since the reviewer opened the page, they have not seen it.
        if (req.body?.fileName && trim(req.body.fileName) !== file) {
            return fail(res, `${user.name} has uploaded a new ${def.label} since this page was opened — look at the new file first`, 409);
        }

        const now = new Date();
        const entry = { action: status, status, comment: status === 'rejected' ? comment : '', fileName: file, by: String(req.userId), at: now };
        const payload = {
            school: req.schoolId, employee: id, docKey: key, fileName: file, status,
            comment: status === 'rejected' ? comment : '',
            reviewedBy: req.userId, reviewedAt: now,
            // A fresh decision answers the re-submission, if there was one.
            resubmittedAt: null,
            history: [...(existing?.history || []), entry].slice(-50),
        };
        await saveReview(existing, payload);
        // A section signed off with this scan in it is no longer signed off.
        if (status === 'rejected') {
            await docs.reopenSection(req.schoolId, id, def.verification,
                `Reopened — ${def.label} was rejected`, profile, req.userId);
        }

        await audit(req, {
            actionType: status === 'verified' ? 'VERIFY_EMPLOYEE_DOCUMENT' : 'REJECT_EMPLOYEE_DOCUMENT',
            entityId: id,
            oldValue: existing ? { status: existing.status, fileName: existing.fileName } : null,
            newValue: { document: def.label, status, comment: payload.comment, employeeName: user.name },
        });

        if (status === 'rejected') {
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: `Please upload your ${def.label} again`,
                body: `The school office could not accept your ${def.label}: ${comment}. Upload a new copy from My Documents.`,
                recipients: [id],
                link: { type: 'directory.mydocs' },
            });
        } else if (existing?.status !== 'verified' || existing?.fileName !== file) {
            // The other half of the conversation: they are told when it is accepted too.
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: `Your ${def.label} was accepted`,
                body: `The school office has checked and accepted your ${def.label}.`,
                recipients: [id],
                link: { type: 'directory.mydocs' },
            });
        }

        const view = await docs.documentsOf(req.schoolId, profile, await namesOf([req.userId]));
        ok(res, { document: view.documents.find((d) => d.key === key) || null, outstanding: view.outstanding });
    } catch (e) { fail(res, e); }
};

exports.sendReminders = async (req, res) => {
    try {
        const b = req.body || {};
        const ids = [...new Set((Array.isArray(b.employeeIds) ? b.employeeIds : []).map(String).filter(Boolean))].slice(0, 500);
        if (!ids.length) return fail(res, 'Choose who to remind', 400);
        const message = trim(b.message).slice(0, 500);
        const onlyKeys = Array.isArray(b.keys) && b.keys.length ? new Set(b.keys.map(String)) : null;

        const [users, profiles] = await Promise.all([
            User.find({ _id: { $in: ids }, school: req.schoolId, role: 'teacher', isActive: true }).select('name').lean(),
            TeacherProfile.find({ school: req.schoolId, user: { $in: ids } }).lean(),
        ]);
        const byUser = await docs.documentsBySchool(req.schoolId, withStubs(users.map((u) => String(u._id)), profiles));
        const priorBy = new Map();
        for (const r of await EmployeeDocumentReminder.find({ school: req.schoolId, employee: { $in: ids } }).lean()) {
            const k = String(r.employee);
            if (!priorBy.has(k)) priorBy.set(k, []);
            priorBy.get(k).push(r);
        }

        const sent = [];
        const skipped = [];
        for (const u of users) {
            const uid = String(u._id);
            const owed = (byUser.get(uid)?.outstanding || []).filter((o) => !onlyKeys || onlyKeys.has(o.key));
            if (!owed.length) { skipped.push({ name: u.name, reason: 'Nothing outstanding' }); continue; }

            // A follow-up when an earlier reminder is still unanswered — one
            // that asked for something still owed, with nothing uploaded or
            // decided on it since (reminderView holds that rule).
            const owedKeys = new Set(owed.map((o) => o.key));
            const views = (priorBy.get(uid) || []).map((r) => docs.reminderView(r, owedKeys, undefined, byUser.get(uid)?.documents || []));
            const stillOpen = views.filter((v) => v.open);
            const sequence = stillOpen.length + 1;
            const latest = Math.max(0, ...views.map((v) => new Date(v.sentAt).getTime()));
            if (!b.force && latest && Date.now() - latest < REMIND_GAP_HOURS * 3600000) {
                skipped.push({ name: u.name, reason: `Already reminded in the last ${REMIND_GAP_HOURS} hours` });
                continue;
            }

            await EmployeeDocumentReminder.create({
                school: req.schoolId, employee: uid,
                documents: owed.map((o) => ({ key: o.key, reason: o.reason })),
                message, sequence, email: !!b.email, sentBy: req.userId, sentAt: new Date(),
            });

            const missing  = owed.filter((o) => o.reason === 'missing').map((o) => o.label);
            const rejected = owed.filter((o) => o.reason === 'rejected').map((o) => o.label);
            const lines = [
                missing.length  ? `Still to upload: ${listOf(missing)}.` : '',
                rejected.length ? `To upload again (not accepted): ${listOf(rejected)}.` : '',
                message,
            ].filter(Boolean);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: sequence > 1 ? `Reminder ${sequence}: your documents are still needed` : 'The school office needs your documents',
                body: `${lines.join(' ')} Upload them from My Documents.`,
                recipients: [uid],
                email: !!b.email,
                link: { type: 'directory.mydocs' },
            });
            sent.push({ name: u.name, sequence, documents: owed.length });
        }
        for (const id of ids) {
            if (!users.some((u) => String(u._id) === id)) skipped.push({ name: 'Someone no longer on the staff', reason: 'Not an active employee of this school' });
        }

        await audit(req, {
            actionType: 'SEND_EMPLOYEE_DOCUMENT_REMINDERS',
            entityId: String(req.schoolId),
            newValue: { sent: sent.length, skipped: skipped.length, employees: sent.map((s) => s.name), email: !!b.email },
        });
        ok(res, { sent, skipped });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  The employee
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The school has the module on. My Documents is the employee's own paperwork,
 * so it does not wait on their designation granting the directory — only on
 * the school using it.
 */
exports.schoolUsesModule = async (req, res, next) => {
    try {
        const access = await designations.requestAccess(req);
        if (!access.moduleFlags?.[MODULE]) {
            return res.status(403).json({ success: false, code: 'MODULE_DISABLED', message: 'Your school does not collect staff documents here' });
        }
        next();
    } catch (e) { next(e); }
};

async function mine(req) {
    const profile = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
    const [view, reminders] = await Promise.all([
        docs.documentsOf(req.schoolId, profile),
        EmployeeDocumentReminder.find({ school: req.schoolId, employee: req.userId }).sort({ sentAt: -1 }).limit(20).lean(),
    ]);
    const names = await namesOf(reminders.map((r) => r.sentBy));
    const owed = new Set(view.outstanding.map((o) => o.key));
    return {
        hasProfile: !!profile,
        documents: view.documents.map(({ history, reviewedBy, lastActivityAt, gate, ...d }) => d),
        outstanding: view.outstanding,
        reminders: reminders.map((r) => docs.reminderView(r, owed, names, view.documents)).filter((r) => r.open).slice(0, 5),
    };
}

exports.myDocuments = async (req, res) => {
    try { ok(res, await mine(req)); } catch (e) { fail(res, e); }
};

/**
 * Put an uploaded file into one of an employee's document slots — the employee
 * doing it for themselves, or the office doing it for them.
 *
 * Returns `{ error, status }` (the file already discarded) or
 * `{ def, fileName, before, wasRejected, review }`.
 */
async function placeFile(req, { userId, profile, byOffice }) {
    const drop = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };
    const key = String(req.params.key || '');
    const def = docs.DEF_BY_KEY.get(key);
    if (!def) { drop(); return { error: 'Unknown document', status: 400 }; }
    if (!req.file) return { error: 'Choose a file to upload', status: 400 };
    // The office reads these where they are, so they must be something a
    // browser can show: a PDF or a photo — by what the file IS, not its name.
    if (!VIEWABLE.test(req.file.originalname || '') || !docs.contentKind(req.file.path, req.file.originalname)) {
        drop();
        return { error: 'Upload a real PDF, JPG or PNG — the office reviews the document on screen', status: 400 };
    }
    if (!profile) {
        drop();
        return { error: byOffice ? 'This employee has no staff record yet — complete it on the teacher form first'
            : 'Your staff record has not been set up yet — ask the school office', status: 400 };
    }
    if (!byOffice && !docs.slotsFor(profile).some((d) => d.key === key)) {
        drop();
        return { error: `${def.label} is only collected from staff who joined with previous experience`, status: 400 };
    }

    const review = await EmployeeDocumentReview.findOne({ employee: String(userId), docKey: key }).lean();
    const section = await svc.models.EmployeeVerification
        .findOne({ employee: String(userId), section: def.verification }).select('status verifiedAt verifiedBy').lean();
    const before = docs.stateOf(def, profile, review, section);
    if (!byOffice && before === 'verified') {
        drop();
        return { error: `Your ${def.label} has already been verified. Ask the school office if it needs to change.`, status: 409 };
    }

    const fileName = req.file.filename;
    const previous = trim(profile[key]);
    await TeacherProfile.findByIdAndUpdate(profile._id, { $set: { [key]: fileName } });
    const after = { ...profile, [key]: fileName };
    // The scan this one replaces is not kept: nothing points at it any more.
    docs.removeIfUnused(previous, after);

    const now = new Date();
    const wasRejected = review?.status === 'rejected';
    if (review) {
        await EmployeeDocumentReview.findByIdAndUpdate(review._id, {
            $set: {
                resubmittedAt: wasRejected ? now : review.resubmittedAt || null,
                history: [...(review.history || []), { action: 'uploaded', fileName, by: String(req.userId), at: now, byOffice: !!byOffice }].slice(-50),
            },
        });
    }
    // A section signed off before this file existed has not seen it.
    await docs.reopenSection(req.schoolId, userId, def.verification,
        `Reopened — a new ${def.label} was uploaded`, after, req.userId);

    return { def, fileName, before, wasRejected, review };
}

exports.uploadMyDocument = async (req, res) => {
    try {
        const profile = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        const out = await placeFile(req, { userId: req.userId, profile, byOffice: false });
        if (out.error) return fail(res, out.error, out.status);
        const { def, fileName, before, wasRejected, review } = out;

        await audit(req, {
            actionType: wasRejected ? 'RESUBMIT_EMPLOYEE_DOCUMENT' : 'UPLOAD_EMPLOYEE_DOCUMENT',
            entityId: String(req.userId),
            oldValue: { state: before },
            newValue: { document: def.label, fileName },
        });

        const me = await User.findById(req.userId).select('name').lean();
        // The uploader is never asked to review their own file.
        const office = (await designations.moduleAdminIds(req.schoolId, MODULE)).filter((id) => String(id) !== String(req.userId));
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: wasRejected ? 'Document re-submitted for review' : 'New document awaiting review',
            body: wasRejected
                ? `${me?.name || 'An employee'} uploaded a new ${def.label} after it was rejected${review?.comment ? ` (“${review.comment}”)` : ''}. It is waiting for your review.`
                : `${me?.name || 'An employee'} uploaded their ${def.label}. It is waiting for your review.`,
            recipients: office,
            link: { type: 'directory.review', entityId: String(req.userId) },
        });

        ok(res, await mine(req), 201);
    } catch (e) { if (req.file?.path) fs.unlink(req.file.path, () => {}); fail(res, e); }
};

/**
 * POST /employees/:id/documents/:key — the office puts a document on an
 * employee's record (a paper handed in at the desk). It still has to be
 * reviewed like any other: uploading is not accepting.
 */
exports.uploadForEmployee = async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const user = await User.findOne({ _id: id, school: req.schoolId, role: 'teacher' }).select('name').lean().catch(() => null);
        if (!user) { if (req.file?.path) fs.unlink(req.file.path, () => {}); return fail(res, 'Employee not found', 404); }
        const profile = await TeacherProfile.findOne({ user: id, school: req.schoolId }).lean();
        const out = await placeFile(req, { userId: id, profile, byOffice: true });
        if (out.error) return fail(res, out.error, out.status);
        await audit(req, {
            actionType: 'UPLOAD_EMPLOYEE_DOCUMENT',
            entityId: id,
            oldValue: { state: out.before },
            newValue: { document: out.def.label, fileName: out.fileName, employeeName: user.name, byOffice: true },
        });
        const view = await docs.documentsOf(req.schoolId, { ...profile, [out.def.key]: out.fileName });
        ok(res, { document: view.documents.find((d) => d.key === out.def.key) || null, outstanding: view.outstanding }, 201);
    } catch (e) { if (req.file?.path) fs.unlink(req.file.path, () => {}); fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  "Please correct my details" — the employee asks, the office answers.
// ─────────────────────────────────────────────────────────────────────────────

const AREA_LABEL = {
    personal: 'Personal details', contact: 'Contact details', government_id: 'Government ID',
    education: 'Education', employment: 'Employment details', bank: 'Bank details', other: 'Something else',
};

const requestView = (r, names = new Map()) => ({
    _id: String(r._id),
    employee: String(r.employee),
    employeeName: names.get(String(r.employee)) || '',
    area: r.area, areaLabel: AREA_LABEL[r.area] || 'Something else',
    message: r.message, status: r.status, reply: r.reply || '',
    createdAt: r.createdAt, closedAt: r.closedAt || null,
    closedByName: r.closedBy ? (names.get(String(r.closedBy)) || '') : '',
});

exports.myRequests = async (req, res) => {
    try {
        const rows = await EmployeeChangeRequest.find({ school: req.schoolId, employee: req.userId }).sort({ createdAt: -1 }).limit(30).lean();
        ok(res, {
            requests: rows.map((r) => requestView(r, new Map())),
            areas: CHANGE_AREAS.map((a) => ({ value: a, label: AREA_LABEL[a] })),
        });
    } catch (e) { fail(res, e); }
};

exports.createMyRequest = async (req, res) => {
    try {
        const area = CHANGE_AREAS.includes(trim(req.body?.area)) ? trim(req.body.area) : 'other';
        const message = trim(req.body?.message).slice(0, 600);
        if (message.length < 10) return fail(res, 'Say what needs correcting, and what it should be', 400);
        const open = await EmployeeChangeRequest.countDocuments({ school: req.schoolId, employee: req.userId, status: 'open' });
        if (open >= 5) return fail(res, 'You already have five requests waiting with the office — wait for an answer to those first', 409);

        const row = await EmployeeChangeRequest.create({ school: req.schoolId, employee: req.userId, area, message });
        const me = await User.findById(req.userId).select('name').lean();
        const office = (await designations.moduleAdminIds(req.schoolId, MODULE)).filter((id) => String(id) !== String(req.userId));
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: 'A correction was requested on a staff record',
            body: `${me?.name || 'An employee'} asked for a change to their ${AREA_LABEL[area].toLowerCase()}: “${message.slice(0, 140)}”`,
            recipients: office,
            link: { type: 'directory.requests' },
        });
        ok(res, { request: requestView(row.toObject ? row.toObject() : row) }, 201);
    } catch (e) { fail(res, e); }
};

exports.listRequests = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (['open', 'done', 'declined'].includes(String(req.query.status))) filter.status = String(req.query.status);
        const rows = await EmployeeChangeRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean();
        const names = await namesOf(rows.flatMap((r) => [r.employee, r.closedBy]));
        const all = await EmployeeChangeRequest.find({ school: req.schoolId }).select('status').lean();
        ok(res, {
            requests: rows.filter((r) => names.has(String(r.employee))).map((r) => requestView(r, names)),
            counts: {
                open: all.filter((r) => r.status === 'open').length,
                done: all.filter((r) => r.status === 'done').length,
                declined: all.filter((r) => r.status === 'declined').length,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.closeRequest = async (req, res) => {
    try {
        const row = await EmployeeChangeRequest.findOne({ _id: String(req.params.id), school: req.schoolId }).lean().catch(() => null);
        if (!row) return fail(res, 'Request not found', 404);
        const status = trim(req.body?.status);
        const reply = trim(req.body?.reply).slice(0, 400);
        if (!['done', 'declined'].includes(status)) return fail(res, 'Mark the request done, or decline it', 400);
        if (status === 'declined' && reply.length < 5) return fail(res, 'Say why it is declined — the employee is shown this', 400);
        if (row.status !== 'open') return fail(res, 'This request has already been answered', 409);
        if (String(row.employee) === String(req.userId)) return fail(res, 'Another administrator has to answer your own request', 403);

        await EmployeeChangeRequest.findByIdAndUpdate(row._id, {
            $set: { status, reply, closedBy: req.userId, closedAt: new Date() },
        });
        await audit(req, {
            actionType: 'CLOSE_EMPLOYEE_CHANGE_REQUEST',
            entityId: String(row.employee),
            oldValue: { status: 'open', area: row.area },
            newValue: { status, reply, request: row.message.slice(0, 200) },
        });
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: status === 'done' ? 'Your staff record was corrected' : 'Your correction request was declined',
            body: status === 'done'
                ? `The school office has dealt with your request about your ${AREA_LABEL[row.area].toLowerCase()}.${reply ? ` “${reply}”` : ''}`
                : `The school office could not make the change you asked for: “${reply}”`,
            recipients: [String(row.employee)],
            link: { type: 'directory.mydocs' },
        });
        ok(res, { _id: String(row._id), status });
    } catch (e) { fail(res, e); }
};
