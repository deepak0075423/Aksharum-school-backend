'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee documents — what each one's state is, and what is still owed.
//
//  The files themselves live where they always have: as file names on
//  TeacherProfile (aadhaarFrontFile, panCardFile, …), uploaded by the office
//  through the teacher wizard or the employee's profile, or by the employee
//  from My Documents. This file reads them together with the office's
//  decisions (EmployeeDocumentReview) and answers what everything else asks:
//
//    stateOf()        where one document stands —
//                       missing      nothing on file
//                       pending      on file, never reviewed
//                       resubmitted  a new file put in after a rejection
//                       verified     the office accepted THIS file
//                       rejected     the office turned THIS file down
//    outstanding()    what the employee still has to provide — a required
//                     document that is missing, or any document rejected
//    reopenSection()  a section's sign-off does not outlive what it was given
//                     for: a rejected scan, a new file or an edited value puts
//                     the section back to pending
//
//  A decision describes the file it was made on (`fileName`). A different file
//  in the slot is a new submission, whoever put it there.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const svc = require('./employeeDirectoryService');
const EmployeeDocumentReview   = require('../models/EmployeeDocumentReview');
const EmployeeDocumentReminder = require('../models/EmployeeDocumentReminder');
const EmployeeVerification     = require('../models/EmployeeVerification');
const EmployeeResponsibility   = require('../models/EmployeeResponsibility');
const ActivityLog              = require('../models/ActivityLog');

const { trim } = svc;
const { TeacherProfile, EmployeeDepartment, EmployeeChangeRequest } = svc.models;

// Demanded of everyone by the intake wizard; the resignation letter only of an
// experienced hire (svc.COMPLETION_FIELDS / EXPERIENCED_ONLY say the same).
const ALWAYS_REQUIRED = ['aadhaarFrontFile', 'aadhaarBackFile', 'panCardFile'];
const EXPERIENCED_REQUIRED = ['resignationLetterFile'];
// Only an experienced hire has these to give.
const EXPERIENCED_ONLY = new Set(['resignationLetterFile', 'experienceCertificateFile']);

const DEFS = svc.DOCUMENT_DEFS;
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));
const STAFF_DOCS_DIR = path.join(__dirname, '..', 'uploads', 'staff-docs');

const experienced = (profile) => profile?.employmentType === 'experienced';

/** Whether this document is demanded of this employee. */
function isRequired(key, profile) {
    return ALWAYS_REQUIRED.includes(key) || (experienced(profile) && EXPERIENCED_REQUIRED.includes(key));
}

/**
 * The document slots this employee has: every one, except the two that only an
 * experienced hire has — unless something is on file there anyway.
 */
function slotsFor(profile) {
    const p = profile || {};
    return DEFS.filter((d) => !EXPERIENCED_ONLY.has(d.key) || experienced(p) || trim(p[d.key]));
}

const sectionRow = (section) => (typeof section === 'string' ? { status: section } : (section || {}));

/**
 * Where one document stands.
 *
 * With no decision on record, a document in a section the office has already
 * signed off counts as verified — but only a file that was THERE when the
 * section was signed: that sign-off was made by looking at it, before
 * documents were reviewed one at a time. A file that arrived afterwards was
 * never looked at by anybody, so it is pending whatever the section says.
 */
function stateOf(def, profile, review, section) {
    const file = trim(profile?.[def.key]);
    if (!file) return review?.status === 'rejected' ? 'rejected' : 'missing';
    if (review) {
        if (review.fileName === file) return review.status;
        return review.status === 'rejected' ? 'resubmitted' : 'pending';
    }
    const sec = sectionRow(section);
    if (sec.status !== 'verified') return 'pending';
    const arrived = svc.uploadedAtOf(file);
    if (arrived && sec.verifiedAt && arrived > new Date(sec.verifiedAt)) return 'pending';
    return 'verified';
}

/** When anything last happened to this slot — a file arriving, or a decision. */
function lastActivityOf(def, profile, review) {
    const times = [
        svc.uploadedAtOf(trim(profile?.[def.key])),
        review?.reviewedAt ? new Date(review.reviewedAt) : null,
        review?.resubmittedAt ? new Date(review.resubmittedAt) : null,
    ].filter(Boolean).map((d) => d.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
}

/** One document, as every screen shows it. */
function documentView(def, profile, review, section, names = new Map()) {
    const file = trim(profile?.[def.key]);
    const state = stateOf(def, profile, review, section);
    const current = review && review.fileName === file;
    return {
        key: def.key,
        label: def.label,
        category: def.category,
        section: def.verification,
        sensitive: !!def.sensitive,
        gate: def.gate || 'governmentId',
        required: isRequired(def.key, profile),
        state,
        fileName: file,
        url: file ? `${svc.STAFF_DOC_BASE}/${file}` : '',
        uploadedAt: svc.uploadedAtOf(file),
        lastActivityAt: lastActivityOf(def, profile, review),
        // The decision on record. For a re-submitted file it is the rejection
        // that the new file answers — the reason is what the reviewer needs.
        comment: review?.status === 'rejected' ? (review.comment || '') : '',
        reviewedAt: current || state === 'resubmitted' || state === 'rejected' ? (review?.reviewedAt || null) : null,
        reviewedBy: review?.reviewedBy ? (names.get(String(review.reviewedBy)) || '') : '',
        resubmittedAt: state === 'resubmitted' ? (review?.resubmittedAt || null) : null,
        history: (review?.history || []).map((h) => ({ ...h, byName: names.get(String(h.by)) || '' })),
    };
}

/** What the employee still owes: required and missing, or rejected. */
function outstandingOf(documents) {
    return documents
        .filter((d) => d.state === 'rejected' || (d.required && d.state === 'missing'))
        .map((d) => ({ key: d.key, label: d.label, reason: d.state === 'rejected' ? 'rejected' : 'missing', comment: d.comment }));
}

/**
 * Every employee's documents in one school, keyed by user id.
 * `profiles` are TeacherProfile rows — or `{ user }` alone for an account whose
 * record was never set up, which owes everything. Pass `preloaded` when the
 * caller already holds the reviews and section rows.
 */
async function documentsBySchool(schoolId, profiles, names = new Map(), preloaded = null) {
    const [reviews, sections] = preloaded ? [preloaded.reviews, preloaded.sections] : await Promise.all([
        EmployeeDocumentReview.find({ school: schoolId }).lean(),
        EmployeeVerification.find({ school: schoolId }).select('employee section status verifiedAt verifiedBy').lean(),
    ]);
    const reviewOf = new Map(reviews.map((r) => [`${r.employee}:${r.docKey}`, r]));
    const sectionOf = new Map(sections.map((s) => [`${s.employee}:${s.section}`, s]));

    const out = new Map();
    for (const p of profiles) {
        const uid = String(p.user);
        const documents = slotsFor(p).map((def) => documentView(
            def, p, reviewOf.get(`${uid}:${def.key}`), sectionOf.get(`${uid}:${def.verification}`), names,
        ));
        out.set(uid, { documents, outstanding: outstandingOf(documents) });
    }
    return out;
}

/** One employee's documents. */
async function documentsOf(schoolId, profile, names = new Map()) {
    if (!profile) return { documents: [], outstanding: [] };
    const uid = String(profile.user);
    const [reviews, sections] = await Promise.all([
        EmployeeDocumentReview.find({ school: schoolId, employee: uid }).lean(),
        EmployeeVerification.find({ school: schoolId, employee: uid }).select('employee section status verifiedAt verifiedBy').lean(),
    ]);
    const map = await documentsBySchool(schoolId, [profile], names, { reviews, sections });
    return map.get(uid) || { documents: [], outstanding: [] };
}

/**
 * A reminder is open while anything it asked for is still owed AND nothing has
 * happened to that document since it was sent. Worked out on read, so an upload
 * closes every reminder it answers — and stays closed if that upload is later
 * rejected: the rejection is a new thing to chase, not the old reminder again.
 */
function reminderView(r, outstandingKeys, names = new Map(), documents = []) {
    const sent = new Date(r.sentAt || r.createdAt).getTime();
    const activity = new Map(documents.map((d) => [d.key, d.lastActivityAt ? new Date(d.lastActivityAt).getTime() : 0]));
    const asked = (r.documents || []).map((d) => ({
        ...d,
        label: DEF_BY_KEY.get(d.key)?.label || d.key,
        stillOwed: outstandingKeys.has(d.key) && !((activity.get(d.key) || 0) > sent),
    }));
    return {
        _id: String(r._id),
        employee: String(r.employee),
        documents: asked,
        message: r.message || '',
        sequence: r.sequence || 1,
        email: !!r.email,
        sentAt: r.sentAt || r.createdAt,
        sentBy: r.sentBy ? String(r.sentBy) : null,
        sentByName: r.sentBy ? (names.get(String(r.sentBy)) || '') : '',
        open: asked.some((d) => d.stillOwed),
    };
}

// ── Sign-offs that no longer describe the record ─────────────────────────────

/**
 * Put a verified section back to pending, saying why.
 *
 * The documents in it that were accepted "with the section" (no decision of
 * their own) are given that decision first, so reopening the section for one
 * rejected scan does not turn the other five back into "awaiting review".
 * Returns true when a sign-off was actually withdrawn.
 */
async function reopenSection(schoolId, employeeId, section, reason, profile = null, by = null) {
    const row = await EmployeeVerification.findOne({ employee: String(employeeId), section }).lean();
    if (!row || row.status !== 'verified') return false;

    if (profile) {
        const reviews = await EmployeeDocumentReview.find({ employee: String(employeeId) }).select('docKey').lean();
        const decided = new Set(reviews.map((r) => r.docKey));
        for (const def of DEFS.filter((d) => d.verification === section)) {
            const file = trim(profile[def.key]);
            if (!file || decided.has(def.key) || stateOf(def, profile, null, row) !== 'verified') continue;
            await EmployeeDocumentReview.create({
                school: schoolId, employee: String(employeeId), docKey: def.key, fileName: file, status: 'verified',
                reviewedBy: row.verifiedBy || null, reviewedAt: row.verifiedAt || null,
                history: [{ action: 'verified', status: 'verified', fileName: file, by: row.verifiedBy ? String(row.verifiedBy) : '', at: row.verifiedAt || new Date(), note: 'Accepted with its section' }],
            }).catch(() => {});
        }
    }

    await EmployeeVerification.findByIdAndUpdate(row._id, {
        $set: { status: 'pending', note: String(reason || '').slice(0, 300), verifiedBy: null, verifiedAt: null },
    });
    await ActivityLog.create({
        user: by || row.verifiedBy || employeeId, school: schoolId,
        actionType: 'REOPEN_EMPLOYEE_VERIFICATION', entityType: 'EmployeeVerification', entityId: String(employeeId),
        oldValue: { section, status: 'verified' }, newValue: { section, status: 'pending', reason: String(reason || '') },
    }).catch(() => {});
    return true;
}

const LABELS = new Map([
    ...svc.COMPLETION_FIELDS, ...svc.EXPERIENCED_ONLY,
].map((f) => [f.key, f.label]));
const labelOf = (key) => DEF_BY_KEY.get(key)?.label || LABELS.get(key)
    || key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

const comparable = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
    const s = String(v).trim();
    // A stored date read back as text compares by its day.
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
};

/**
 * The record was edited: withdraw the sign-off of every verified section one
 * of whose values (or files) is no longer what it was. `before` / `after` are
 * `{ user, profile }` pairs. Returns the sections reopened.
 */
async function reopenForChanges(schoolId, userId, before, after, by = null) {
    const reopened = [];
    for (const [section, def] of Object.entries(svc.SECTION_FIELDS)) {
        const changed = def.all.filter((k) => {
            const from = svc.USER_FIELDS.has(k) ? before.user?.[k] : before.profile?.[k];
            const to   = svc.USER_FIELDS.has(k) ? after.user?.[k]  : after.profile?.[k];
            return to !== undefined && comparable(from) !== comparable(to);
        });
        if (!changed.length) continue;
        const reason = `Reopened — ${changed.slice(0, 4).map(labelOf).join(', ')}${changed.length > 4 ? '…' : ''} changed after it was verified`;
        if (await reopenSection(schoolId, userId, section, reason, after.profile, by)) reopened.push(section);
    }
    return reopened;
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Remove one stored staff document from disk. Never throws. */
function removeFile(fileName) {
    const name = path.basename(String(fileName || ''));
    if (!name || name.startsWith('.')) return;
    fs.unlink(path.join(STAFF_DOCS_DIR, name), () => {});
}

/**
 * A replaced file: gone from disk once no record points at it any more. The
 * same scan can sit in two slots (one upload attached twice), so it is only
 * removed when nothing on the profile still names it.
 */
function removeIfUnused(fileName, profile) {
    const name = trim(fileName);
    if (!name) return;
    if (DEFS.some((d) => trim(profile?.[d.key]) === name)) return;
    removeFile(name);
}

/**
 * What the bytes are, against what the name claims: 'pdf' | 'jpeg' | 'png', or
 * null when the file is not what its extension says (a renamed .exe, a web
 * page saved as .pdf). Reads the first few bytes only.
 */
function contentKind(filePath, originalName) {
    let buf;
    try {
        const fd = fs.openSync(filePath, 'r');
        buf = Buffer.alloc(12);
        fs.readSync(fd, buf, 0, 12, 0);
        fs.closeSync(fd);
    } catch { return null; }
    const kind = buf.slice(0, 5).toString('latin1') === '%PDF-' ? 'pdf'
        : (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ? 'jpeg'
            : buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : null;
    const ext = path.extname(String(originalName || '')).toLowerCase().replace('.', '');
    const claims = { pdf: 'pdf', jpg: 'jpeg', jpeg: 'jpeg', png: 'png' }[ext];
    return kind && kind === claims ? kind : null;
}

/**
 * An employee's account is being deleted: everything the directory kept about
 * them goes too — sign-offs, document decisions, reminders, responsibilities,
 * their requests, the scans themselves — and nobody is left reporting to, or a
 * department headed by, an account that no longer exists.
 */
async function purgeEmployee(schoolId, userId) {
    const uid = String(userId);
    const profile = await TeacherProfile.findOne({ user: uid, school: schoolId }).lean().catch(() => null);
    const run = (p) => p.catch((e) => console.error('[employee-documents] purge:', e.message));
    await Promise.all([
        run(EmployeeVerification.deleteMany({ employee: uid })),
        run(EmployeeDocumentReview.deleteMany({ employee: uid })),
        run(EmployeeDocumentReminder.deleteMany({ employee: uid })),
        run(EmployeeResponsibility.deleteMany({ employee: uid })),
        run(EmployeeChangeRequest.deleteMany({ employee: uid })),
        run(TeacherProfile.updateMany({ school: schoolId, reportingManager: uid }, { $set: { reportingManager: null } })),
        run(EmployeeDepartment.updateMany({ school: schoolId, head: uid }, { $set: { head: null } })),
    ]);
    if (profile) for (const d of DEFS) if (trim(profile[d.key])) removeFile(profile[d.key]);
}

module.exports = {
    ALWAYS_REQUIRED, DEF_BY_KEY,
    isRequired, slotsFor, stateOf, documentView, outstandingOf,
    documentsBySchool, documentsOf, reminderView,
    reopenSection, reopenForChanges, labelOf,
    removeFile, removeIfUnused, contentKind, purgeEmployee,
    models: { EmployeeDocumentReview, EmployeeDocumentReminder },
};
