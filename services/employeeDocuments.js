'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee documents — what each one's state is, and what is still owed.
//
//  The files themselves live where they always have: as file names on
//  TeacherProfile (aadhaarFrontFile, panCardFile, …), uploaded by the office
//  through the teacher wizard or, now, by the employee from My Documents.
//  This file reads them together with the office's decisions
//  (EmployeeDocumentReview) and answers two questions everything else asks:
//
//    stateOf()        where one document stands —
//                       missing      nothing on file
//                       pending      on file, never reviewed
//                       resubmitted  a new file put in after a rejection
//                       verified     the office accepted THIS file
//                       rejected     the office turned THIS file down
//    outstanding()    what the employee still has to provide — a required
//                     document that is missing, or any document rejected
//
//  A decision describes the file it was made on (`fileName`). A different file
//  in the slot is a new submission, whoever put it there.
// ─────────────────────────────────────────────────────────────────────────────

const svc = require('./employeeDirectoryService');
const EmployeeDocumentReview   = require('../models/EmployeeDocumentReview');
const EmployeeDocumentReminder = require('../models/EmployeeDocumentReminder');
const EmployeeVerification     = require('../models/EmployeeVerification');

const { trim } = svc;

// Demanded of everyone by the intake wizard; the resignation letter only of an
// experienced hire (svc.COMPLETION_FIELDS / EXPERIENCED_ONLY say the same).
const ALWAYS_REQUIRED = ['aadhaarFrontFile', 'aadhaarBackFile', 'panCardFile'];
const EXPERIENCED_REQUIRED = ['resignationLetterFile'];
// Only an experienced hire has these to give.
const EXPERIENCED_ONLY = new Set(['resignationLetterFile', 'experienceCertificateFile']);

const DEFS = svc.DOCUMENT_DEFS;
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

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

/**
 * Where one document stands.
 *
 * With no decision on record, a document in a section the office has already
 * signed off counts as verified: that sign-off was made by looking at it,
 * before documents were reviewed one at a time. Without this, every section
 * verified before the feature existed would reappear as a pile of "pending".
 */
function stateOf(def, profile, review, sectionStatus) {
    const file = trim(profile?.[def.key]);
    if (!file) return review?.status === 'rejected' ? 'rejected' : 'missing';
    if (review) {
        if (review.fileName === file) return review.status;
        return review.status === 'rejected' ? 'resubmitted' : 'pending';
    }
    return sectionStatus === 'verified' ? 'verified' : 'pending';
}

/** One document, as every screen shows it. */
function documentView(def, profile, review, sectionStatus, names = new Map()) {
    const file = trim(profile?.[def.key]);
    const state = stateOf(def, profile, review, sectionStatus);
    const current = review && review.fileName === file;
    return {
        key: def.key,
        label: def.label,
        category: def.category,
        section: def.verification,
        sensitive: !!def.sensitive,
        required: isRequired(def.key, profile),
        state,
        fileName: file,
        url: file ? `${svc.STAFF_DOC_BASE}/${file}` : '',
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
 * `profiles` are TeacherProfile rows; reviews and section sign-offs are read here.
 */
async function documentsBySchool(schoolId, profiles, names = new Map()) {
    const [reviews, sections] = await Promise.all([
        EmployeeDocumentReview.find({ school: schoolId }).lean(),
        EmployeeVerification.find({ school: schoolId }).select('employee section status').lean(),
    ]);
    const reviewOf = new Map(reviews.map((r) => [`${r.employee}:${r.docKey}`, r]));
    const sectionOf = new Map(sections.map((s) => [`${s.employee}:${s.section}`, s.status]));

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
    const map = await documentsBySchool(schoolId, [profile], names);
    return map.get(String(profile.user)) || { documents: [], outstanding: [] };
}

/**
 * A reminder is open while anything it asked for is still owed. Worked out on
 * read, so an upload closes every reminder it answers.
 */
function reminderView(r, outstandingKeys, names = new Map()) {
    const asked = (r.documents || []).map((d) => ({
        ...d,
        label: DEF_BY_KEY.get(d.key)?.label || d.key,
        stillOwed: outstandingKeys.has(d.key),
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

module.exports = {
    ALWAYS_REQUIRED, DEF_BY_KEY,
    isRequired, slotsFor, stateOf, documentView, outstandingOf,
    documentsBySchool, documentsOf, reminderView,
    models: { EmployeeDocumentReview, EmployeeDocumentReminder },
};
