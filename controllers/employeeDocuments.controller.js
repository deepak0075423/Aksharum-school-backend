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

const { User, TeacherProfile } = svc.models;
const { EmployeeDocumentReview, EmployeeDocumentReminder } = docs.models;
const { trim } = svc;

const MODULE = 'employeeDirectory';
// A reminder that has had no answer for this long is due a follow-up.
const FOLLOW_UP_AFTER_DAYS = 3;
const REJECT_MIN = 5;
const VIEWABLE = /\.(pdf|jpe?g|png)$/i;

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
        const byUser = await docs.documentsBySchool(req.schoolId, profiles, names);
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
            const history = (remindersOf.get(uid) || []).map((r) => docs.reminderView(r, owed, names));
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
        if (existing) await EmployeeDocumentReview.findByIdAndUpdate(existing._id, { $set: payload });
        else await EmployeeDocumentReview.create(payload);

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
        const byUser = await docs.documentsBySchool(req.schoolId, profiles);
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

            // A follow-up when an earlier reminder is still unanswered.
            const owedKeys = new Set(owed.map((o) => o.key));
            const stillOpen = (priorBy.get(uid) || []).filter((r) => (r.documents || []).some((d) => owedKeys.has(d.key)));
            const sequence = stillOpen.length + 1;

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
            if (!users.some((u) => String(u._id) === id)) skipped.push({ name: id, reason: 'Not an active employee of this school' });
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
        documents: view.documents.map(({ history, reviewedBy, ...d }) => d),
        outstanding: view.outstanding,
        reminders: reminders.map((r) => docs.reminderView(r, owed, names)).filter((r) => r.open).slice(0, 5),
    };
}

exports.myDocuments = async (req, res) => {
    try { ok(res, await mine(req)); } catch (e) { fail(res, e); }
};

exports.uploadMyDocument = async (req, res) => {
    const drop = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };
    try {
        const key = String(req.params.key || '');
        const def = docs.DEF_BY_KEY.get(key);
        if (!def) { drop(); return fail(res, 'Unknown document', 400); }
        if (!req.file) return fail(res, 'Choose a file to upload', 400);
        // The office reads these where they are, so they must be something a
        // browser can show: a PDF or a photo.
        if (!VIEWABLE.test(req.file.originalname || '')) {
            drop();
            return fail(res, 'Upload a PDF, JPG or PNG — the office reviews the document on screen', 400);
        }

        const profile = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        if (!profile) { drop(); return fail(res, 'Your staff record has not been set up yet — ask the school office', 400); }
        if (!docs.slotsFor(profile).some((d) => d.key === key)) {
            drop();
            return fail(res, `${def.label} is only collected from staff who joined with previous experience`, 400);
        }

        const review = await EmployeeDocumentReview.findOne({ employee: req.userId, docKey: key }).lean();
        const sectionRow = await svc.models.EmployeeVerification
            .findOne({ employee: req.userId, section: def.verification }).select('status').lean();
        const before = docs.stateOf(def, profile, review, sectionRow?.status);
        if (before === 'verified') {
            drop();
            return fail(res, `Your ${def.label} has already been verified. Ask the school office if it needs to change.`, 409);
        }

        const fileName = req.file.filename;
        await TeacherProfile.findByIdAndUpdate(profile._id, { $set: { [key]: fileName } });

        const now = new Date();
        const wasRejected = review?.status === 'rejected';
        if (review) {
            await EmployeeDocumentReview.findByIdAndUpdate(review._id, {
                $set: {
                    resubmittedAt: wasRejected ? now : review.resubmittedAt || null,
                    history: [...(review.history || []), { action: 'uploaded', fileName, by: String(req.userId), at: now }].slice(-50),
                },
            });
        }

        await audit(req, {
            actionType: wasRejected ? 'RESUBMIT_EMPLOYEE_DOCUMENT' : 'UPLOAD_EMPLOYEE_DOCUMENT',
            entityId: String(req.userId),
            oldValue: { state: before },
            newValue: { document: def.label, fileName },
        });

        const me = await User.findById(req.userId).select('name').lean();
        const office = await designations.moduleAdminIds(req.schoolId, MODULE);
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
    } catch (e) { drop(); fail(res, e); }
};
