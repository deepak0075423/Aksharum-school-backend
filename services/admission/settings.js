'use strict';
/**
 * A school's admission configuration: the defaults it starts from, the shape
 * every block must keep, and the portal address.
 *
 * Each block is normalised on the way in — unknown keys dropped, numbers
 * clamped to what the platform allows, text held to the platform's text rules
 * — so whatever is stored is something the engine can act on. OTP limits in
 * particular can only be set inside the platform's own bounds: a school may
 * make codes stricter, never weaker.
 */
const pool = require('../../db/pool');
const AdmissionSetting = require('../../models/AdmissionSetting');
const School = require('../../models/School');
const workflow = require('./workflow');
const counters = require('./counters');
const U = require('./util');

const { str, bool, num, oneOf, color, httpUrl, text, emailOrBlank, refuse } = U;

// ── Platform bounds ──────────────────────────────────────────────────────────
const OTP_BOUNDS = {
    expiryMinutes: { min: 5, max: 30, d: 10 },
    resendSeconds: { min: 30, max: 600, d: 60 },
    maxAttempts:   { min: 3, max: 10, d: 5 },
    maxSendsPerHour: { min: 3, max: 10, d: 5 },
};

// Addresses the app itself uses at the top level, and words a school's
// portal must never be able to impersonate. A slug is also kept to 3–40
// lowercase letters, digits and single hyphens, so it can never contain a
// dot (static files) or an @ (the dev server's own paths).
const RESERVED_SLUGS = new Set([
    'login', 'logout', 'register', 'signup', 'signin', 'admin', 'admins', 'teacher', 'teachers', 'student', 'students',
    'parent', 'parents', 'super-admin', 'superadmin', 'chat', 'profile', 'auth', 'api', 'uploads', 'upload', 'assets',
    'static', 'public', 'internal', 'health', 'choose-account', 'forgot-password', 'verify-otp', 'new-password',
    'reset-password', 'medical-kiosk', 'verify', 'applicant', 'applicants', 'admission', 'admissions', 'apply', 'portal',
    'www', 'app', 'mail', 'help', 'support', 'about', 'privacy', 'terms', 'dashboard', 'settings', 'null', 'undefined',
    'aksharum', 'school', 'schools', 'system', 'root', 'guest', 'guests', 'notifications', 'n', 'src', 'node-modules',
    'cookie-policy', 'cookies', 'g',
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;

function slugProblem(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!s) return 'Choose an address for the portal';
    if (s.length < 3 || s.length > 40) return 'The portal address must be 3 to 40 characters';
    if (!SLUG_RE.test(s)) return 'Use lowercase letters, digits and single hyphens — it cannot start or end with a hyphen';
    if (RESERVED_SLUGS.has(s)) return `"${s}" is reserved — choose another address`;
    return null;
}

/** A slug suggested from the school's name: "St. Mary's School" → "st-marys-school". */
function suggestSlug(name) {
    const base = String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return base.length >= 3 ? base : `${base}-school`.replace(/^-/, '');
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_PRIVACY = [
    'We collect the information in this application, and the documents you upload, only to process admission to our school.',
    'It is seen by the school\'s admission staff and is not shared outside the school except where the law requires.',
    'Documents are stored privately and opened only by the staff who check them. Aadhaar numbers are shown to staff only in part.',
    'If your child is not admitted, the application is erased once the school no longer needs it; you can ask for it to be erased sooner.',
    'Under "Your data" on this portal you can download a copy of your information, ask for it to be corrected or erased, withdraw your consent, or raise a grievance.',
].join('\n\n');

function defaults() {
    return {
        portal: {
            status: 'closed',
            title: 'Admissions',
            tagline: 'Begin your journey with us',
            description: '',
            instructions: 'Create an account, verify your email, fill in the application form and upload the documents asked for. You can save your application and come back to it at any time before you submit.',
            announcement: { enabled: false, tone: 'info', text: '' },
            maintenanceMessage: 'The admission portal is being updated. Please check back shortly.',
            closedMessage: 'Applications are not open at the moment. Please check back later or contact the admission office.',
            theme: { primary: '#4f46e5', accent: '#7c3aed' },
            header: { showSchoolName: true, links: [] },
            footer: { text: '', links: [] },
            contact: { phone: '', email: '', address: '', hours: '', website: '' },
            help: { name: 'Admission Office', phone: '', email: '', text: 'Questions about your application? We are happy to help.' },
            sections: [
                { key: 'about', type: 'text', title: 'About the school', body: '', items: [], enabled: false },
                { key: 'steps', type: 'steps', title: 'How to apply', body: '', enabled: true, items: [
                    { title: 'Create your account', text: 'Register with your email and verify it with the code we send.' },
                    { title: 'Fill in the application', text: 'Answer the questions and upload the documents asked for. Save and return any time.' },
                    { title: 'Track every step', text: 'See document checks, exam dates, results and offers on your dashboard.' },
                    { title: 'Confirm admission', text: 'Accept your offer and pay the admission fee to secure the seat.' },
                ] },
                { key: 'dates', type: 'dates', title: 'Important dates', body: '', items: [], enabled: true },
                { key: 'documents', type: 'documents', title: 'Documents you will need', body: '', items: [], enabled: true },
                { key: 'faq', type: 'faq', title: 'Frequently asked questions', body: '', items: [], enabled: false },
            ],
            loginText: { title: 'Welcome back', subtitle: 'Sign in to continue your application.' },
            registerText: { title: 'Create your applicant account', subtitle: 'One account lets you apply, upload documents and track every step.' },
            privacyNotice: DEFAULT_PRIVACY,
            privacyVersion: 1,
            declaration: 'I declare that the information given in this application is true and complete to the best of my knowledge, and I understand that admission may be cancelled if any of it is found to be incorrect.',
            enquiries: true,
        },
        numbering: {
            application: 'APP{YYYY}{#####}',
            receipt: 'ADR{YYYY}{#####}',
            admitCard: 'R{YY}{####}',
            offer: 'OFR{YYYY}{####}',
        },
        security: {
            otpExpiryMinutes: OTP_BOUNDS.expiryMinutes.d,
            otpResendSeconds: OTP_BOUNDS.resendSeconds.d,
            otpMaxAttempts: OTP_BOUNDS.maxAttempts.d,
            otpMaxSendsPerHour: OTP_BOUNDS.maxSendsPerHour.d,
            // The "not a robot" check on the portal's public forms, when the server has one (services/admission/captcha.js).
            captcha: true,
        },
        applications: {
            maxPerApplicant: 3,
            allowReapplyAfterRejection: true,
            applicationFeeTiming: 'before_submit',   // before_submit | after_submit
            requireDocumentsAtSubmit: true,
            draftMigration: 'migrate',               // migrate | keep
            duplicateCheck: true,
            allowWithdraw: true,
        },
        workflow: { stages: workflow.defaultStages() },
        selection: {
            tieBreakers: ['score_desc', 'dob_asc', 'submitted_asc'],
            autoPromoteWaitlist: true,
            offerValidityDays: 7,
            allowApplicantResponse: true,
            visibility: { showRank: true, showScore: false, showNames: false },
        },
        fees: { waivers: [], receiptNote: 'This is a computer-generated receipt and does not need a signature.' },
        conversion: {
            activation: 'immediate',                 // immediate | manual
            requireAdmissionFeePaid: true,
            requireDocumentsVerified: true,
            sendCredentials: true,
            transferDocuments: true,
            createFeeAssignment: true,
            transportRequest: true,
            hostelRequest: true,
            medicalRecord: true,
        },
        email: {
            replyTo: '',
            fromName: '',
            reminders: { examHoursBefore: 24, paymentDaysBefore: 2 },
        },
        // Data protection (services/admission/privacy.js): how long what is held
        // is kept, who answers privacy questions, how fast requests are answered.
        privacy: {
            retention: { enabled: true, unsuccessfulMonths: 12, abandonedDraftDays: 180, enquiryMonths: 12, deliveryLogMonths: 6 },
            officer: { name: '', email: '', phone: '' },
            requestDays: 30,
        },
        // The RTE Act's bar on screening (services/admission/compliance.js).
        compliance: {
            rte: { enabled: true, classNumbers: [1, 2, 3, 4, 5, 6, 7, 8], prePrimary: false, exemptReason: '', exemptNote: '' },
        },
        // Campus visits families book from the portal (services/admission/visits.js).
        visits: { enabled: false, maxPeople: 4, cancelUntilHours: 2, reminderHours: 24, intro: '' },
        // Asking the school to look again (services/admission/appeals.js).
        appeals: { enabled: false, recheckDays: 7, decisionDays: 15, answerDays: 10, maxPerApplication: 3, note: '' },
        // Documents fetched from DigiLocker (services/admission/digilocker.js), when the platform is a DigiLocker partner.
        digilocker: { enabled: true, autoVerify: false },
    };
}

// ── Normalisers, one per block ───────────────────────────────────────────────

function links(list, label) {
    return (Array.isArray(list) ? list : []).slice(0, 6).map((l, i) => {
        const url = httpUrl(l?.url);
        if (url === null) refuse(`${label} link ${i + 1} must start with http:// or https://`, 400, { field: 'portal' });
        return { label: text(l?.label, `${label} link ${i + 1}`, { max: 40, required: true }), url };
    }).filter((l) => l.url);
}

const SECTION_TYPES = ['text', 'steps', 'faq', 'highlights', 'dates', 'documents'];

function normalizePortal(p = {}, current = defaults().portal) {
    const d = { ...defaults().portal, ...current };
    const sections = (Array.isArray(p.sections) ? p.sections : d.sections).slice(0, 12).map((s, i) => {
        const type = oneOf(s?.type, SECTION_TYPES, 'text');
        const key = /^[a-z][a-z0-9_]{0,30}$/.test(String(s?.key || '')) ? s.key : `section_${i + 1}`;
        return {
            key, type,
            title: text(s?.title, `Section ${i + 1} title`, { max: 80 }),
            body: text(s?.body, `Section ${i + 1} text`, { max: 4000 }),
            enabled: bool(s?.enabled, true),
            items: (Array.isArray(s?.items) ? s.items : []).slice(0, 20).map((it, j) => ({
                title: text(it?.title, `Section ${i + 1}, item ${j + 1} title`, { max: 120 }),
                text: text(it?.text, `Section ${i + 1}, item ${j + 1} text`, { max: 1000 }),
            })).filter((it) => it.title || it.text),
        };
    });
    const privacyNotice = text(p.privacyNotice ?? d.privacyNotice, 'Privacy notice', { max: 8000 });
    // A changed notice is a new version: applicants agree to the version they saw.
    const privacyVersion = privacyNotice !== d.privacyNotice ? (Number(d.privacyVersion) || 1) + 1 : (Number(d.privacyVersion) || 1);
    return {
        status: oneOf(p.status ?? d.status, ['open', 'closed', 'maintenance'], 'closed'),
        title: text(p.title ?? d.title, 'Portal title', { max: 80, required: true }),
        tagline: text(p.tagline ?? d.tagline, 'Tagline', { max: 140 }),
        description: text(p.description ?? d.description, 'Description', { max: 4000 }),
        instructions: text(p.instructions ?? d.instructions, 'Instructions', { max: 4000 }),
        announcement: {
            enabled: bool(p.announcement?.enabled, d.announcement?.enabled),
            tone: oneOf(p.announcement?.tone ?? d.announcement?.tone, ['info', 'warning', 'success'], 'info'),
            text: text(p.announcement?.text ?? d.announcement?.text, 'Announcement', { max: 500 }),
        },
        maintenanceMessage: text(p.maintenanceMessage ?? d.maintenanceMessage, 'Maintenance message', { max: 500 }),
        closedMessage: text(p.closedMessage ?? d.closedMessage, 'Closed message', { max: 500 }),
        theme: {
            primary: color(p.theme?.primary, d.theme?.primary || '#4f46e5'),
            accent: color(p.theme?.accent, d.theme?.accent || '#7c3aed'),
        },
        header: { showSchoolName: bool(p.header?.showSchoolName, d.header?.showSchoolName ?? true), links: links(p.header?.links ?? d.header?.links, 'Header') },
        footer: { text: text(p.footer?.text ?? d.footer?.text, 'Footer text', { max: 300 }), links: links(p.footer?.links ?? d.footer?.links, 'Footer') },
        contact: {
            phone: text(p.contact?.phone ?? d.contact?.phone, 'Contact phone', { max: 20, kind: 'digits' }),
            email: emailOrBlank(p.contact?.email ?? d.contact?.email, 'Contact email'),
            address: text(p.contact?.address ?? d.contact?.address, 'Contact address', { max: 300 }),
            hours: text(p.contact?.hours ?? d.contact?.hours, 'Office hours', { max: 120 }),
            website: (() => { const u = httpUrl(p.contact?.website ?? d.contact?.website); if (u === null) refuse('Website must start with http:// or https://', 400, { field: 'portal' }); return u; })(),
        },
        help: {
            name: text(p.help?.name ?? d.help?.name, 'Help contact name', { max: 80 }),
            phone: text(p.help?.phone ?? d.help?.phone, 'Help phone', { max: 20, kind: 'digits' }),
            email: emailOrBlank(p.help?.email ?? d.help?.email, 'Help email'),
            text: text(p.help?.text ?? d.help?.text, 'Help text', { max: 500 }),
        },
        sections,
        loginText: { title: text(p.loginText?.title ?? d.loginText?.title, 'Login title', { max: 80 }), subtitle: text(p.loginText?.subtitle ?? d.loginText?.subtitle, 'Login subtitle', { max: 200 }) },
        registerText: { title: text(p.registerText?.title ?? d.registerText?.title, 'Registration title', { max: 80 }), subtitle: text(p.registerText?.subtitle ?? d.registerText?.subtitle, 'Registration subtitle', { max: 200 }) },
        privacyNotice,
        privacyVersion,
        declaration: text(p.declaration ?? d.declaration, 'Declaration', { max: 2000 }),
        enquiries: bool(p.enquiries, d.enquiries ?? true),
    };
}

function normalizeNumbering(n = {}, current = {}) {
    const d = { ...defaults().numbering, ...current };
    const out = {};
    for (const [k, label] of [['application', 'Application number format'], ['receipt', 'Receipt number format'], ['admitCard', 'Admit card number format'], ['offer', 'Offer number format']]) {
        const v = str(n[k] ?? d[k], 60);
        const bad = counters.templateProblem(v, label);
        if (bad) refuse(bad, 400, { field: `numbering.${k}` });
        out[k] = v;
    }
    return out;
}

function normalizeSecurity(s = {}, current = {}) {
    const d = { ...defaults().security, ...current };
    return {
        otpExpiryMinutes: num(s.otpExpiryMinutes ?? d.otpExpiryMinutes, { ...OTP_BOUNDS.expiryMinutes, int: true }),
        otpResendSeconds: num(s.otpResendSeconds ?? d.otpResendSeconds, { ...OTP_BOUNDS.resendSeconds, int: true }),
        otpMaxAttempts: num(s.otpMaxAttempts ?? d.otpMaxAttempts, { ...OTP_BOUNDS.maxAttempts, int: true }),
        otpMaxSendsPerHour: num(s.otpMaxSendsPerHour ?? d.otpMaxSendsPerHour, { ...OTP_BOUNDS.maxSendsPerHour, int: true }),
        captcha: bool(s.captcha ?? d.captcha, true),
    };
}

function normalizeApplications(a = {}, current = {}) {
    const d = { ...defaults().applications, ...current };
    return {
        maxPerApplicant: num(a.maxPerApplicant ?? d.maxPerApplicant, { min: 1, max: 20, d: 3, int: true }),
        allowReapplyAfterRejection: bool(a.allowReapplyAfterRejection, d.allowReapplyAfterRejection),
        applicationFeeTiming: oneOf(a.applicationFeeTiming ?? d.applicationFeeTiming, ['before_submit', 'after_submit'], 'before_submit'),
        requireDocumentsAtSubmit: bool(a.requireDocumentsAtSubmit, d.requireDocumentsAtSubmit),
        draftMigration: oneOf(a.draftMigration ?? d.draftMigration, ['migrate', 'keep'], 'migrate'),
        duplicateCheck: bool(a.duplicateCheck, d.duplicateCheck),
        allowWithdraw: bool(a.allowWithdraw, d.allowWithdraw),
    };
}

function normalizeWorkflow(w = {}, current = {}) {
    const stages = workflow.normalizeStages(w.stages ?? current.stages);
    for (const s of stages) {
        if (s.label) {
            const bad = require('../../utils/textRules').textProblem(s.label, `Stage name "${s.label}"`, 'title');
            if (bad) refuse(bad, 400, { field: 'workflow' });
        }
        s.assignees = s.assignees.filter(U.isId);
    }
    return { stages };
}

const TIE_BREAKERS = ['score_desc', 'dob_asc', 'dob_desc', 'submitted_asc', 'name_asc'];

function normalizeSelection(s = {}, current = {}) {
    const d = { ...defaults().selection, ...current };
    const ties = [...new Set((Array.isArray(s.tieBreakers) ? s.tieBreakers : d.tieBreakers).filter((t) => TIE_BREAKERS.includes(t)))];
    return {
        tieBreakers: ties.length ? ties : ['score_desc', 'submitted_asc'],
        autoPromoteWaitlist: bool(s.autoPromoteWaitlist, d.autoPromoteWaitlist),
        offerValidityDays: num(s.offerValidityDays ?? d.offerValidityDays, { min: 1, max: 60, d: 7, int: true }),
        allowApplicantResponse: bool(s.allowApplicantResponse, d.allowApplicantResponse),
        visibility: {
            showRank: bool(s.visibility?.showRank, d.visibility?.showRank ?? true),
            showScore: bool(s.visibility?.showScore, d.visibility?.showScore ?? false),
            showNames: bool(s.visibility?.showNames, d.visibility?.showNames ?? false),
        },
    };
}

function normalizeFees(f = {}, current = {}) {
    const d = { ...defaults().fees, ...current };
    const waivers = (Array.isArray(f.waivers) ? f.waivers : d.waivers).slice(0, 30).map((w, i) => {
        const type = oneOf(w?.type, ['percent', 'amount'], 'percent');
        const value = num(w?.value, { min: 0, max: type === 'percent' ? 100 : 10000000, d: 0 });
        return {
            key: /^[a-z][a-z0-9_]{1,30}$/.test(String(w?.key || '')) ? w.key : `waiver_${i + 1}`,
            name: text(w?.name, `Waiver ${i + 1} name`, { max: 60, required: true, kind: 'title' }),
            type, value,
            appliesTo: oneOf(w?.appliesTo, ['application', 'admission', 'both'], 'both'),
            requiresApproval: bool(w?.requiresApproval, true),
        };
    });
    const keys = new Set();
    for (const w of waivers) { if (keys.has(w.key)) refuse(`Two waivers share the key "${w.key}"`, 400, { field: 'fees' }); keys.add(w.key); }
    return { waivers, receiptNote: text(f.receiptNote ?? d.receiptNote, 'Receipt note', { max: 300 }) };
}

function normalizeConversion(c = {}, current = {}) {
    const d = { ...defaults().conversion, ...current };
    return {
        activation: oneOf(c.activation ?? d.activation, ['immediate', 'manual'], 'immediate'),
        requireAdmissionFeePaid: bool(c.requireAdmissionFeePaid, d.requireAdmissionFeePaid),
        requireDocumentsVerified: bool(c.requireDocumentsVerified, d.requireDocumentsVerified),
        sendCredentials: bool(c.sendCredentials, d.sendCredentials),
        transferDocuments: bool(c.transferDocuments, d.transferDocuments),
        createFeeAssignment: bool(c.createFeeAssignment, d.createFeeAssignment),
        transportRequest: bool(c.transportRequest, d.transportRequest),
        hostelRequest: bool(c.hostelRequest, d.hostelRequest),
        medicalRecord: bool(c.medicalRecord, d.medicalRecord),
    };
}

function normalizeEmail(e = {}, current = {}) {
    const d = { ...defaults().email, ...current };
    return {
        replyTo: emailOrBlank(e.replyTo ?? d.replyTo, 'Reply-to address', 'email.replyTo'),
        fromName: text(e.fromName ?? d.fromName, 'Sender name', { max: 80 }),
        reminders: {
            examHoursBefore: num(e.reminders?.examHoursBefore ?? d.reminders?.examHoursBefore, { min: 0, max: 168, d: 24, int: true }),
            paymentDaysBefore: num(e.reminders?.paymentDaysBefore ?? d.reminders?.paymentDaysBefore, { min: 0, max: 30, d: 2, int: true }),
        },
    };
}

function normalizePrivacy(p = {}, current = {}) {
    const d = { ...defaults().privacy, ...current };
    const r = { ...d.retention, ...(p.retention || {}) };
    const o = { ...d.officer, ...(p.officer || {}) };
    return {
        retention: {
            enabled: bool(r.enabled, true),
            unsuccessfulMonths: num(r.unsuccessfulMonths, { min: 1, max: 60, d: 12, int: true }),
            abandonedDraftDays: num(r.abandonedDraftDays, { min: 30, max: 730, d: 180, int: true }),
            enquiryMonths: num(r.enquiryMonths, { min: 1, max: 60, d: 12, int: true }),
            deliveryLogMonths: num(r.deliveryLogMonths, { min: 1, max: 24, d: 6, int: true }),
        },
        officer: {
            name: text(o.name, 'The privacy contact\'s name', { max: 80, kind: 'name', field: 'privacy.officer.name' }),
            email: emailOrBlank(o.email, 'The privacy contact\'s email', 'privacy.officer.email'),
            phone: text(o.phone, 'The privacy contact\'s phone', { max: 15, kind: 'digits', field: 'privacy.officer.phone' }),
        },
        // The DPDP Rules give 90 days at most for a grievance; a school may answer faster.
        requestDays: num(p.requestDays ?? d.requestDays, { min: 1, max: 90, d: 30, int: true }),
    };
}

const EXEMPT_REASONS = ['minority', 'not_applicable', 'other'];

function normalizeCompliance(c = {}, current = {}) {
    const d = { ...defaults().compliance.rte, ...(current.rte || {}) };
    const r = c.rte || {};
    const enabled = bool(r.enabled, d.enabled);
    const numbers = (Array.isArray(r.classNumbers) ? r.classNumbers : d.classNumbers)
        .map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 0 && n <= 12);
    const out = { enabled, classNumbers: [...new Set(numbers)].sort((a, b) => a - b), prePrimary: bool(r.prePrimary, d.prePrimary), exemptReason: '', exemptNote: '' };
    if (enabled && !out.classNumbers.length && !out.prePrimary) refuse('Choose the classes the rule covers, or switch it off and say why', 400, { field: 'compliance.rte.classNumbers' });
    if (!enabled) {
        out.exemptReason = oneOf(r.exemptReason ?? d.exemptReason, EXEMPT_REASONS, '');
        if (!out.exemptReason) refuse('Say why the RTE rule on screening does not apply to the school', 400, { field: 'compliance.rte.exemptReason' });
        out.exemptNote = text(r.exemptNote ?? d.exemptNote, 'The note on why it does not apply', { max: 500, required: true, field: 'compliance.rte.exemptNote' });
    }
    return { rte: out };
}

function normalizeVisits(v = {}, current = {}) {
    const d = { ...defaults().visits, ...current };
    return {
        enabled: bool(v.enabled ?? d.enabled, false),
        maxPeople: num(v.maxPeople ?? d.maxPeople, { min: 1, max: 10, d: 4, int: true }),
        cancelUntilHours: num(v.cancelUntilHours ?? d.cancelUntilHours, { min: 0, max: 72, d: 2, int: true }),
        reminderHours: num(v.reminderHours ?? d.reminderHours, { min: 0, max: 72, d: 24, int: true }),
        intro: text(v.intro ?? d.intro, 'The note on visits', { max: 600, kind: 'sentence', field: 'visits.intro' }),
    };
}

function normalizeAppeals(a = {}, current = {}) {
    const d = { ...defaults().appeals, ...current };
    return {
        enabled: bool(a.enabled ?? d.enabled, false),
        // 0 days: that kind of appeal is not offered.
        recheckDays: num(a.recheckDays ?? d.recheckDays, { min: 0, max: 60, d: 7, int: true }),
        decisionDays: num(a.decisionDays ?? d.decisionDays, { min: 0, max: 90, d: 15, int: true }),
        answerDays: num(a.answerDays ?? d.answerDays, { min: 1, max: 60, d: 10, int: true }),
        maxPerApplication: num(a.maxPerApplication ?? d.maxPerApplication, { min: 1, max: 10, d: 3, int: true }),
        note: text(a.note ?? d.note, 'The note on appeals', { max: 600, kind: 'sentence', field: 'appeals.note' }),
    };
}

function normalizeDigilocker(d = {}, current = {}) {
    const c = { ...defaults().digilocker, ...current };
    return { enabled: bool(d.enabled ?? c.enabled, true), autoVerify: bool(d.autoVerify ?? c.autoVerify, false) };
}

const BLOCKS = {
    portal: normalizePortal,
    numbering: normalizeNumbering,
    security: normalizeSecurity,
    applications: normalizeApplications,
    workflow: normalizeWorkflow,
    selection: normalizeSelection,
    fees: normalizeFees,
    conversion: normalizeConversion,
    email: normalizeEmail,
    privacy: normalizePrivacy,
    compliance: normalizeCompliance,
    visits: normalizeVisits,
    appeals: normalizeAppeals,
    digilocker: normalizeDigilocker,
};

/** A stored row brought to the full current shape (old rows miss newer keys). */
function complete(row) {
    const d = defaults();
    const out = { _id: row?._id || null, school: row?.school || null, slug: row?.slug || '', updatedAt: row?.updatedAt || null };
    for (const block of Object.keys(BLOCKS)) {
        const stored = row?.[block] && typeof row[block] === 'object' ? row[block] : {};
        out[block] = block === 'workflow'
            ? { stages: workflow.normalizeStages(stored.stages) }
            : deepMerge(d[block], stored);
    }
    return out;
}

function deepMerge(base, over) {
    if (Array.isArray(base)) return Array.isArray(over) ? over : base;
    if (!base || typeof base !== 'object') return over === undefined ? base : over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) {
        out[k] = (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) ? deepMerge(base[k], v) : v;
    }
    return out;
}

// ── Reading and writing ──────────────────────────────────────────────────────

const cache = new Map();   // schoolId → { at, value }
const TTL = 15 * 1000;

/** The school's settings, every block complete. Created with defaults on first read. */
async function getSettings(schoolId, { fresh = false } = {}) {
    const key = String(schoolId);
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
    let row = await AdmissionSetting.findOne({ school: schoolId }).lean();
    if (!row) {
        try {
            row = (await AdmissionSetting.create({ school: schoolId, ...defaults() })).toObject();
        } catch (e) {
            if (e.code !== 11000) throw e;
            row = await AdmissionSetting.findOne({ school: schoolId }).lean();
        }
    }
    const value = complete(row);
    cache.set(key, { at: Date.now(), value });
    return value;
}

const invalidate = (schoolId) => cache.delete(String(schoolId));

/** Save one block (or several), each normalised against what is stored. */
async function saveBlocks(schoolId, patch, userId) {
    const current = await getSettings(schoolId, { fresh: true });
    const set = {};
    for (const [block, value] of Object.entries(patch || {})) {
        if (!BLOCKS[block]) continue;
        set[block] = BLOCKS[block](value || {}, current[block]);
    }
    if (!Object.keys(set).length) refuse('Nothing to save');
    await AdmissionSetting.updateOne({ school: schoolId }, { $set: { ...set, updatedBy: userId || null } });
    invalidate(schoolId);
    return getSettings(schoolId, { fresh: true });
}

/** Is this slug free for this school? Returns the problem, or null. */
async function slugTaken(slug, schoolId) {
    const { rows } = await pool.query(
        `SELECT "school" FROM "${AdmissionSetting.tableName}" WHERE lower(btrim("slug")) = $1 AND "school" <> $2::uuid LIMIT 1`,
        [String(slug).trim().toLowerCase(), String(schoolId)],
    );
    return rows.length ? 'That address is already used by another school' : null;
}

async function saveSlug(schoolId, slug, userId) {
    const s = String(slug || '').trim().toLowerCase();
    const bad = slugProblem(s) || await slugTaken(s, schoolId);
    if (bad) refuse(bad, 400, { field: 'slug' });
    await getSettings(schoolId, { fresh: true });   // the row exists
    try {
        await AdmissionSetting.updateOne({ school: schoolId }, { $set: { slug: s, updatedBy: userId || null } });
    } catch (e) {
        if (e.code === 11000) refuse('That address is already used by another school', 409, { field: 'slug' });
        throw e;
    }
    invalidate(schoolId);
    return s;
}

/**
 * The portal behind an address — the school, its settings and whether the
 * admission module is switched on for it. The SCHOOL decides here: a client
 * never names a school id on the public side, only the address.
 */
async function portalBySlug(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(s)) return null;
    const { rows } = await pool.query(
        `SELECT st."school" FROM "${AdmissionSetting.tableName}" st WHERE lower(btrim(st."slug")) = $1 LIMIT 1`, [s]);
    if (!rows.length) return null;
    const school = await School.findById(rows[0].school)
        .select('name code logo email phone address city state pincode website board isActive modules paymentGateway').lean();
    if (!school) return null;
    const settings = await getSettings(school._id);
    return {
        school,
        settings,
        slug: s,
        live: school.isActive !== false && !!school.modules?.admission,
    };
}

module.exports = {
    OTP_BOUNDS, RESERVED_SLUGS, SLUG_RE, TIE_BREAKERS, BLOCKS,
    defaults, complete, getSettings, invalidate, saveBlocks, saveSlug, slugProblem, slugTaken, suggestSlug, portalBySlug,
};
