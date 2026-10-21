'use strict';
/**
 * Admission configuration, for school admins and teachers whose designation
 * administers admissions (routes/api/admission.js: allowModuleAdmin). Every
 * read and write is scoped to req.schoolId — the session's school — and every
 * referenced row (a class, a year, a form, a staff member) is checked to
 * belong to it before it is stored.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const AdmissionRound = require('../models/AdmissionRound');
const AdmissionForm = require('../models/AdmissionForm');
const AdmissionFormVersion = require('../models/AdmissionFormVersion');
const AdmissionDocumentType = require('../models/AdmissionDocumentType');
const AcademicYear = require('../models/AcademicYear');
const Class = require('../models/Class');
const User = require('../models/User');
const School = require('../models/School');
const settingsSvc = require('../services/admission/settings');
const workflow = require('../services/admission/workflow');
const formEngine = require('../services/admission/formEngine');
const defaultForm = require('../services/admission/defaultForm');
const mailer = require('../services/admission/mailer');
const catalog = require('../services/admission/emailCatalog');
const counters = require('../services/admission/counters');
const seats = require('../services/admission/seats');
const analytics = require('../services/admission/analytics');
const events = require('../services/admission/events');
const { textProblem } = require('../utils/textRules');
const { byClass, byYear } = require('../utils/listOrder');
const { handler, refuse, notFound, isId, str, num, bool, date, ids } = require('../services/admission/util');

const TAG = 'admission admin';

// ── First use ────────────────────────────────────────────────────────────────

/** A school's first visit: the default document types and form, once. */
async function ensureDefaults(schoolId, userId) {
    const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissiondocumenttypes" WHERE "school" = $1`, [String(schoolId)]);
    if (!t.n) {
        let order = 0;
        for (const d of defaultForm.DEFAULT_DOC_TYPES) {
            await AdmissionDocumentType.create({ ...d, school: schoolId, order: order++, createdBy: userId }).catch((e) => { if (e.code !== 11000) throw e; });
        }
    }
    const { rows: [f] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionforms" WHERE "school" = $1`, [String(schoolId)]);
    if (!f.n) {
        const form = await AdmissionForm.create({ school: schoolId, name: 'Admission application', description: 'The school\'s standard application form.', createdBy: userId });
        const v = await AdmissionFormVersion.create({ school: schoolId, form: form._id, version: 1, status: 'published', schema: defaultForm.defaultSchema(), changeNote: 'Starting form', publishedAt: new Date(), publishedBy: userId, createdBy: userId });
        await patch(AdmissionForm, form._id, { currentVersion: v._id });
    }
}

/** Everything the admission screens need to know about the school's setup. */
exports.bootstrap = handler(async (req, res) => {
    await ensureDefaults(req.schoolId, req.userId);
    const settings = await settingsSvc.getSettings(req.schoolId, { fresh: true });
    const [school, years, classes, staff, forms, docTypes, rounds] = await Promise.all([
        School.findById(req.schoolId).select('name code logo modules paymentGateway').lean(),
        AcademicYear.find({ school: req.schoolId }).select('yearName status startDate endDate').lean(),
        Class.find({ school: req.schoolId }).select('className classNumber').lean(),
        staffOf(req.schoolId),
        AdmissionForm.find({ school: req.schoolId }).select('name isActive currentVersion draftVersion').lean(),
        AdmissionDocumentType.find({ school: req.schoolId }).sort({ order: 1, name: 1 }).lean(),
        AdmissionRound.find({ school: req.schoolId }).select('name status academicYear classes form').lean(),
    ]);
    res.json({
        success: true,
        data: {
            settings,
            suggestedSlug: settings.slug ? '' : settingsSvc.suggestSlug(school?.name),
            portalUrl: settings.slug ? `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/${settings.slug}` : '',
            school: { _id: school?._id, name: school?.name, onlinePayment: !!(school?.paymentGateway?.enabled && school?.paymentGateway?.modules?.admission), modules: school?.modules || {} },
            academicYears: years.sort(byYear),
            classes: classes.sort(byClass),
            // Classes where the RTE rule bars screening: no tests, no merit lists — lotteries.
            screening: Object.fromEntries(classes.map((c) => [String(c._id), require('../services/admission/compliance').screeningRule(settings, c)])),
            staff, forms, documentTypes: docTypes, rounds,
            catalogs: {
                stages: workflow.STAGES, statuses: Object.entries(workflow.STATUSES).map(([key, m]) => ({ key, ...m })),
                checks: Object.entries(workflow.CHECKS).map(([key, label]) => ({ key, label })),
                fieldTypes: formEngine.FIELD_TYPES, textKinds: formEngine.ALLOWED_KINDS, conditionOps: formEngine.OPS,
                mapTargets: Object.entries(formEngine.MAP_TARGETS).map(([key, label]) => ({ key, label })),
                studentFileFields: Object.entries(defaultForm.STUDENT_FILE_FIELDS).map(([key, label]) => ({ key, label })),
                emailEvents: catalog.EVENT_KEYS.map((k) => ({ key: k, label: catalog.EVENTS[k].label, group: catalog.EVENTS[k].group })),
                tieBreakers: settingsSvc.TIE_BREAKERS, mailDriver: mailer.driver(),
            },
        },
    });
}, TAG);

async function staffOf(schoolId) {
    const { rows } = await pool.query(
        `SELECT u."_id", u."name", u."email", u."role", tp."designation" FROM "users" u
           LEFT JOIN "teacherprofiles" tp ON tp."user" = u."_id"
          WHERE u."school" = $1 AND u."role" IN ('school_admin', 'teacher') AND u."isActive" IS NOT FALSE ORDER BY u."name"`, [String(schoolId)]);
    return rows;
}
exports.staff = handler(async (req, res) => res.json({ success: true, data: await staffOf(req.schoolId) }), TAG);

// ── Settings ─────────────────────────────────────────────────────────────────

exports.saveSettings = handler(async (req, res) => {
    const before = await settingsSvc.getSettings(req.schoolId, { fresh: true });
    const saved = await settingsSvc.saveBlocks(req.schoolId, req.body || {}, req.userId);
    const blocks = Object.keys(req.body || {}).filter((k) => settingsSvc.BLOCKS[k]);
    if (before.portal.status !== saved.portal.status) {
        events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'portal_status', from: before.portal.status, to: saved.portal.status, message: `Portal set to ${saved.portal.status}` });
    }
    const rte0 = before.compliance?.rte || {}; const rte1 = saved.compliance?.rte || {};
    if (rte0.enabled !== rte1.enabled) {
        // Who switched the RTE rule off or on, and why, stays on record.
        events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'rte_rule', from: String(!!rte0.enabled), to: String(!!rte1.enabled),
            message: rte1.enabled ? 'RTE rule on screening switched on' : `RTE rule on screening switched off — ${rte1.exemptReason}: ${rte1.exemptNote}` });
    }
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'settings', message: `Settings saved: ${blocks.join(', ')}` });
    res.json({ success: true, data: saved });
}, TAG);

exports.slugCheck = handler(async (req, res) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    const problem = settingsSvc.slugProblem(slug) || await settingsSvc.slugTaken(slug, req.schoolId);
    res.json({ success: true, data: { slug, ok: !problem, problem } });
}, TAG);

exports.saveSlug = handler(async (req, res) => {
    const before = (await settingsSvc.getSettings(req.schoolId, { fresh: true })).slug;
    const slug = await settingsSvc.saveSlug(req.schoolId, req.body?.slug, req.userId);
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'slug', from: before, to: slug, message: `Portal address set to /${slug}` });
    res.json({ success: true, data: { slug } });
}, TAG);

exports.numberPreview = handler(async (req, res) => {
    const template = String(req.query.template || '');
    const problem = counters.templateProblem(template);
    const school = await School.findById(req.schoolId).select('name code').lean();
    res.json({ success: true, data: { problem, preview: problem ? '' : counters.preview(template, { school, year: new Date().getFullYear(), classDoc: { className: 'Class 5', classNumber: 5 } }) } });
}, TAG);

// ── Rounds ───────────────────────────────────────────────────────────────────

/** The admission fee in parts: 2 to 6 instalments adding to 100%, each due later than the one before. */
function instalmentPlan(b, current) {
    const given = b.instalments !== undefined ? b.instalments : current?.instalments || [];
    const list = (Array.isArray(given) ? given : []).slice(0, 6);
    const confirmWith = ['full', 'first'].includes(b.confirmWith ?? current?.confirmWith) ? (b.confirmWith ?? current.confirmWith) : 'full';
    if (!list.length) return { instalments: [], confirmWith: 'full' };
    if (list.length === 1) refuse('An instalment plan needs at least two instalments — or none', 400, { field: 'instalments' });
    let last = -1;
    const out = list.map((p, i) => {
        const label = str(p?.label, 40) || `Instalment ${i + 1}`;
        const bad = textProblem(label, `Instalment ${i + 1} name`, 'title'); if (bad) refuse(bad, 400, { field: 'instalments' });
        const percent = num(p?.percent, { min: 1, max: 99, d: 0 });
        const dueDays = i === 0 ? 0 : num(p?.dueDays, { min: 1, max: 365, d: 30, int: true });
        if (i > 0 && dueDays <= last) refuse(`Instalment ${i + 1} must fall due after instalment ${i}`, 400, { field: 'instalments' });
        last = dueDays;
        return { label, percent, dueDays };
    });
    const total = Math.round(out.reduce((s, p) => s + p.percent, 0) * 100) / 100;
    if (total !== 100) refuse(`The instalments add up to ${total}% — they must make 100%`, 400, { field: 'instalments' });
    return { instalments: out, confirmWith };
}

async function normalizeRound(req, b, current = null) {
    const name = str(b.name ?? current?.name, 80);
    if (!name) refuse('Give the round a name', 400, { field: 'name' });
    const bad = textProblem(name, 'Round name', 'title'); if (bad) refuse(bad, 400, { field: 'name' });
    const yearId = String(b.academicYear ?? current?.academicYear ?? '');
    if (!isId(yearId) || !(await AcademicYear.exists({ _id: yearId, school: req.schoolId }))) refuse('Choose an academic year of the school', 400, { field: 'academicYear' });
    const opensAt = b.opensAt !== undefined ? date(b.opensAt) : current?.opensAt || null;
    const closesAt = b.closesAt !== undefined ? date(b.closesAt) : current?.closesAt || null;
    if (opensAt && closesAt && closesAt <= opensAt) refuse('The round must close after it opens', 400, { field: 'closesAt' });
    const formId = b.form !== undefined ? (b.form ? String(b.form) : null) : (current?.form || null);
    const formIds = new Set((await AdmissionForm.find({ school: req.schoolId }).select('_id').lean()).map((f) => String(f._id)));
    if (formId && !formIds.has(formId)) refuse('Choose one of the school\'s forms', 400, { field: 'form' });
    const classRows = await Class.find({ school: req.schoolId }).select('_id className').lean();
    const classIds = new Set(classRows.map((c) => String(c._id)));
    const classNameOf = new Map(classRows.map((c) => [String(c._id), c.className]));
    const classesIn = b.classes !== undefined ? b.classes : current?.classes || [];
    const seen = new Set();
    // The questions each form asks — a quota's claim must read one of them.
    const formFields = new Map();
    const fieldsOf = async (fid) => {
        if (!fid) return new Map();
        if (!formFields.has(fid)) {
            const f = await AdmissionForm.findById(fid).select('currentVersion').lean();
            const v = f?.currentVersion ? await AdmissionFormVersion.findById(f.currentVersion).select('schema').lean() : null;
            formFields.set(fid, new Map(formEngine.allFields(v?.schema || { sections: [] }).map((x) => [x.key, x])));
        }
        return formFields.get(fid);
    };
    const quotaFields = [];
    for (const c of Array.isArray(classesIn) ? classesIn : []) quotaFields.push((c?.quotas || []).some((q) => q?.claim?.field) ? await fieldsOf(c.form ? String(c.form) : formId) : null);
    const classes = (Array.isArray(classesIn) ? classesIn : []).map((c, i) => {
        const id = String(c?.class || '');
        if (!classIds.has(id)) refuse(`Class ${i + 1} is not a class of the school`, 400, { field: 'classes' });
        if (seen.has(id)) refuse('A class is listed twice', 400, { field: 'classes' });
        seen.add(id);
        const cf = c.form ? String(c.form) : null;
        if (cf && !formIds.has(cf)) refuse('A class uses a form that is not the school\'s', 400, { field: 'classes' });
        const e = c.eligibility || {};
        const notes = str(e.notes, 300); const nb = textProblem(notes, 'Eligibility notes'); if (nb) refuse(nb, 400, { field: 'classes' });
        const seatCount = num(c.seats, { min: 0, max: 5000, d: 0, int: true });
        const before = (current?.classes || []).find((x) => String(x.class) === id);
        return {
            ...(c._id && isId(String(c._id)) ? { _id: String(c._id) } : {}),
            class: id, seats: seatCount,
            quotas: require('../services/admission/quotas').normalizeQuotas(c.quotas, { classSeats: seatCount, current: before?.quotas || [], fields: quotaFields[i], label: classNameOf.get(id) || `Class ${i + 1}` }),
            applicationFee: c.applicationFee === '' || c.applicationFee == null ? null : num(c.applicationFee, { min: 0, max: 1000000, d: null }),
            admissionFee: c.admissionFee === '' || c.admissionFee == null ? null : num(c.admissionFee, { min: 0, max: 10000000, d: null }),
            form: cf, isOpen: c.isOpen !== false,
            eligibility: {
                ageOn: date(e.ageOn), minAgeYears: e.minAgeYears === '' || e.minAgeYears == null ? null : num(e.minAgeYears, { min: 0, max: 25, d: null }),
                maxAgeYears: e.maxAgeYears === '' || e.maxAgeYears == null ? null : num(e.maxAgeYears, { min: 0, max: 30, d: null }),
                dobFrom: date(e.dobFrom), dobTo: date(e.dobTo), notes,
            },
        };
    });
    const description = str(b.description ?? current?.description, 1500);
    const db = textProblem(description, 'Description'); if (db) refuse(db, 400, { field: 'description' });
    const campus = str(b.campus ?? current?.campus, 80);
    const cb = textProblem(campus, 'Campus', 'title'); if (cb) refuse(cb, 400, { field: 'campus' });
    return {
        name, academicYear: yearId, description, campus,
        type: ['regular', 'lateral', 'mid_year', 'special'].includes(b.type ?? current?.type) ? (b.type ?? current.type) : 'regular',
        opensAt, closesAt,
        documentDeadline: b.documentDeadline !== undefined ? date(b.documentDeadline) : current?.documentDeadline || null,
        form: formId,
        applicationFee: num(b.applicationFee ?? current?.applicationFee, { min: 0, max: 1000000, d: 0 }),
        admissionFee: num(b.admissionFee ?? current?.admissionFee, { min: 0, max: 10000000, d: 0 }),
        admissionFeeDueDays: num(b.admissionFeeDueDays ?? current?.admissionFeeDueDays, { min: 1, max: 90, d: 7, int: true }),
        ...instalmentPlan(b, current),
        maxApplicationsPerApplicant: b.maxApplicationsPerApplicant === '' || b.maxApplicationsPerApplicant == null ? (b.maxApplicationsPerApplicant === undefined ? current?.maxApplicationsPerApplicant ?? null : null) : num(b.maxApplicationsPerApplicant, { min: 1, max: 20, d: null, int: true }),
        classes,
    };
}

exports.rounds = handler(async (req, res) => {
    const rounds = await AdmissionRound.find({ school: req.schoolId }).sort({ createdAt: -1 }).lean();
    const { rows: counts } = await pool.query(
        `SELECT "round", COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "submittedAt" IS NOT NULL)::int AS submitted,
                COUNT(*) FILTER (WHERE "status" IN ('confirmed', 'enrolled'))::int AS confirmed
           FROM "admissionapplications" WHERE "school" = $1 GROUP BY "round"`, [String(req.schoolId)]);
    const byRound = new Map(counts.map((c) => [String(c.round), c]));
    const out = [];
    for (const r of rounds) out.push({ ...r, counts: byRound.get(String(r._id)) || { total: 0, submitted: 0, confirmed: 0 }, seats: await seats.roundState(r._id) });
    res.json({ success: true, data: out });
}, TAG);

exports.createRound = handler(async (req, res) => {
    const data = await normalizeRound(req, req.body || {});
    const row = await AdmissionRound.create({ ...data, school: req.schoolId, status: 'draft', createdBy: req.userId });
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'round_created', message: `Round "${row.name}" created` });
    res.status(201).json({ success: true, data: row });
}, TAG);

exports.updateRound = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const current = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    const data = await normalizeRound(req, req.body || {}, current);
    // A class with applications stays in the round.
    const { rows } = await pool.query(`SELECT DISTINCT "class" FROM "admissionapplications" WHERE "round" = $1`, [String(current._id)]);
    const kept = new Set(data.classes.map((c) => c.class));
    const dropped = rows.filter((r) => !kept.has(String(r.class)));
    if (dropped.length) refuse('A class that already has applications cannot be taken out of the round — close it instead', 409, { field: 'classes' });
    if (String(data.academicYear) !== String(current.academicYear) && rows.length) refuse('The academic year of a round with applications cannot change', 409, { field: 'academicYear' });
    const row = await patch(AdmissionRound, current._id, { ...data, updatedBy: req.userId });
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'round_updated', message: `Round "${row.name}" updated` });
    res.json({ success: true, data: row });
}, TAG);

exports.roundStatus = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    const status = req.body?.status;
    if (!['draft', 'open', 'closed', 'archived'].includes(status)) refuse('Choose open, closed or archived');
    if (status === 'open') {
        if (!(round.classes || []).length) refuse('Add at least one class before opening the round', 409);
        const apps = require('../services/admission/applications');
        const missing = [];
        for (const c of round.classes) if (!(await apps.formFor(round, c.class))) missing.push(c.class);
        if (missing.length) refuse('Every class needs a published application form — set the round\'s form, or the class\'s own', 409);
    }
    const row = await patch(AdmissionRound, round._id, { status, updatedBy: req.userId });
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'round_status', from: round.status, to: status, message: `Round "${round.name}" ${status}` });
    res.json({ success: true, data: row });
}, TAG);

exports.deleteRound = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    const { rows: [n] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM "admissionapplications" WHERE "round" = $1)::int + (SELECT COUNT(*) FROM "admissionexams" WHERE "round" = $1)::int + (SELECT COUNT(*) FROM "admissionlists" WHERE "round" = $1)::int AS n`, [String(round._id)]);
    if (n.n) refuse('This round has applications, exams or lists — archive it instead', 409);
    await pool.query(`DELETE FROM "admissionrounds" WHERE "_id" = $1 AND "school" = $2`, [String(round._id), String(req.schoolId)]);
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'round_deleted', message: `Round "${round.name}" deleted` });
    res.json({ success: true });
}, TAG);

exports.roundSeats = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    res.json({ success: true, data: await seats.roundState(round._id) });
}, TAG);

// ── Forms ────────────────────────────────────────────────────────────────────

async function schemaContext(schoolId) {
    const [types, classes, rounds] = await Promise.all([
        AdmissionDocumentType.find({ school: schoolId }).select('key').lean(),
        Class.find({ school: schoolId }).select('_id').lean(),
        AdmissionRound.find({ school: schoolId }).select('_id').lean(),
    ]);
    return { docTypeKeys: new Set(types.map((t) => t.key)), classIds: new Set(classes.map((c) => String(c._id))), roundIds: new Set(rounds.map((r) => String(r._id))) };
}

exports.forms = handler(async (req, res) => {
    const forms = await AdmissionForm.find({ school: req.schoolId }).sort({ createdAt: 1 }).lean();
    const { rows: versions } = await pool.query(`SELECT "_id", "form", "version", "status", "publishedAt", "changeNote" FROM "admissionformversions" WHERE "school" = $1 ORDER BY "version" DESC`, [String(req.schoolId)]);
    const { rows: usage } = await pool.query(`SELECT "form", COUNT(*)::int AS n FROM "admissionapplications" WHERE "school" = $1 GROUP BY "form"`, [String(req.schoolId)]);
    const rounds = await AdmissionRound.find({ school: req.schoolId }).select('name form classes').lean();
    const used = new Map(usage.map((u) => [String(u.form), u.n]));
    res.json({
        success: true,
        data: forms.map((f) => ({
            ...f,
            current: versions.find((v) => String(v._id) === String(f.currentVersion)) || null,
            draft: versions.find((v) => String(v._id) === String(f.draftVersion)) || null,
            versions: versions.filter((v) => String(v.form) === String(f._id)).length,
            applications: used.get(String(f._id)) || 0,
            rounds: rounds.filter((r) => String(r.form) === String(f._id) || (r.classes || []).some((c) => String(c.form) === String(f._id))).map((r) => r.name),
        })),
    });
}, TAG);

exports.createForm = handler(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 80);
    if (!name) refuse('Name the form', 400, { field: 'name' });
    const bad = textProblem(name, 'Form name', 'title'); if (bad) refuse(bad, 400, { field: 'name' });
    let schema = { sections: [] };
    if (b.from === 'default') schema = defaultForm.defaultSchema();
    else if (b.from && isId(String(b.from))) {
        const src = await AdmissionForm.findOne({ _id: b.from, school: req.schoolId }).lean();
        if (!src) notFound('Form');
        const v = await AdmissionFormVersion.findById(src.draftVersion || src.currentVersion).lean();
        schema = v?.schema || schema;
    } else {
        schema = { sections: [{ key: 'student', title: 'Student details', description: '', fields: [
            { key: 'studentName', type: 'text', label: "Student's full name", required: true, mapTo: 'student.name', validation: { kind: 'name', maxLength: 80 } },
            { key: 'studentDob', type: 'date', label: 'Date of birth', required: true, mapTo: 'student.dob', validation: { maxDate: 'today' } },
        ] }] };
    }
    const form = await AdmissionForm.create({ school: req.schoolId, name, description: str(b.description, 300), createdBy: req.userId });
    const v = await AdmissionFormVersion.create({ school: req.schoolId, form: form._id, version: 1, status: 'draft', schema, createdBy: req.userId });
    const row = await patch(AdmissionForm, form._id, { draftVersion: v._id });
    events.recordQuietly(req.schoolId, { by: req, type: 'form', action: 'created', message: `Form "${name}" created` });
    res.status(201).json({ success: true, data: row });
}, TAG);

exports.form = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    const versions = await AdmissionFormVersion.find({ form: form._id }).select('version status publishedAt publishedBy changeNote updatedAt').sort({ version: -1 }).lean();
    const [current, draft] = await Promise.all([
        form.currentVersion ? AdmissionFormVersion.findById(form.currentVersion).lean() : null,
        form.draftVersion ? AdmissionFormVersion.findById(form.draftVersion).lean() : null,
    ]);
    res.json({ success: true, data: { form, current, draft, versions } });
}, TAG);

exports.updateForm = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    const set = {};
    if (req.body?.name !== undefined) {
        const name = str(req.body.name, 80);
        if (!name) refuse('Name the form', 400, { field: 'name' });
        const bad = textProblem(name, 'Form name', 'title'); if (bad) refuse(bad, 400, { field: 'name' });
        set.name = name;
    }
    if (req.body?.description !== undefined) set.description = str(req.body.description, 300);
    if (req.body?.isActive !== undefined) set.isActive = bool(req.body.isActive, true);
    const row = await patch(AdmissionForm, form._id, { ...set, updatedBy: req.userId });
    res.json({ success: true, data: row });
}, TAG);

/** Save the builder's work to the form's draft — a new draft from the published version if there is none. */
exports.saveDraft = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    const schema = formEngine.validateSchema(req.body?.schema, await schemaContext(req.schoolId));
    let draftId = form.draftVersion;
    if (draftId) {
        await patch(AdmissionFormVersion, draftId, { schema, updatedBy: req.userId }, { where: { status: 'draft' } });
    } else {
        const { rows: [m] } = await pool.query(`SELECT COALESCE(MAX("version"), 0) AS v FROM "admissionformversions" WHERE "form" = $1`, [String(form._id)]);
        const v = await AdmissionFormVersion.create({ school: req.schoolId, form: form._id, version: Number(m.v) + 1, status: 'draft', schema, createdBy: req.userId });
        draftId = v._id;
        await patch(AdmissionForm, form._id, { draftVersion: draftId });
    }
    res.json({ success: true, data: await AdmissionFormVersion.findById(draftId).lean() });
}, TAG);

exports.publishForm = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    if (!form.draftVersion) refuse('There are no changes to publish', 409);
    const draft = await AdmissionFormVersion.findById(form.draftVersion).lean();
    // Checked again: a document type may have been removed since the draft was saved.
    formEngine.validateSchema(draft.schema, await schemaContext(req.schoolId));
    const note = str(req.body?.changeNote, 300);
    const { withTransaction } = require('../services/dbTx');
    await withTransaction(async (q) => {
        if (form.currentVersion) await patch(AdmissionFormVersion, form.currentVersion, { status: 'archived' }, { q, where: { status: 'published' } });
        const pub = await patch(AdmissionFormVersion, draft._id, { status: 'published', publishedAt: new Date(), publishedBy: req.userId, changeNote: note }, { q, where: { status: 'draft' } });
        if (!pub) refuse('The draft changed — refresh and try again', 409);
        await patch(AdmissionForm, form._id, { currentVersion: draft._id, draftVersion: null, updatedBy: req.userId }, { q });
    });
    events.recordQuietly(req.schoolId, { by: req, type: 'form', action: 'published', message: `Form "${form.name}" version ${draft.version} published${note ? ` — ${note}` : ''}` });
    res.json({ success: true, data: { version: draft.version } });
}, TAG);

exports.discardDraft = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    if (!form.draftVersion) refuse('There is no draft', 409);
    if (!form.currentVersion) refuse('This form has never been published — the draft is all there is', 409);
    await pool.query(`DELETE FROM "admissionformversions" WHERE "_id" = $1 AND "status" = 'draft'`, [String(form.draftVersion)]);
    await patch(AdmissionForm, form._id, { draftVersion: null });
    res.json({ success: true });
}, TAG);

exports.version = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    if (!isId(String(req.params.versionId))) notFound('Version');
    const v = await AdmissionFormVersion.findOne({ _id: req.params.versionId, form: form._id }).lean();
    if (!v) notFound('Version');
    res.json({ success: true, data: v });
}, TAG);

/** Try the form: answers checked exactly as a real submission would be. */
exports.testForm = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    const schema = req.body?.schema
        ? formEngine.validateSchema(req.body.schema, await schemaContext(req.schoolId))
        : (await AdmissionFormVersion.findById(form.draftVersion || form.currentVersion).lean())?.schema;
    if (!schema) refuse('The form has no version yet', 409);
    const scope = { classId: isId(String(req.body?.classId || '')) ? String(req.body.classId) : null, roundId: isId(String(req.body?.roundId || '')) ? String(req.body.roundId) : null };
    const docs = Object.fromEntries((Array.isArray(req.body?.uploaded) ? req.body.uploaded : []).map((k) => [String(k), true]));
    const r = formEngine.validateAnswers(schema, req.body?.answers || {}, { ...scope, partial: !!req.body?.partial, docs });
    res.json({
        success: true,
        data: {
            errors: r.errors, firstError: r.firstError, missingDocs: r.missingDocs, data: r.data,
            applicable: formEngine.applicableFields(schema, r.data, scope).map((f) => f.key),
            summary: formEngine.summaryOf(schema, r.data),
        },
    });
}, TAG);

exports.duplicateForm = handler(async (req, res) => {
    req.body = { name: str(req.body?.name, 80), from: req.params.id };
    return exports.createForm(req, res);
}, TAG);

exports.deleteForm = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const form = await access.schoolRow(AdmissionForm, req, req.params.id, 'Form');
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissionapplications" WHERE "form" = $1`, [String(form._id)]);
    if (n.n) refuse('Applications were made on this form — switch it off instead', 409);
    const rounds = await AdmissionRound.find({ school: req.schoolId }).select('form classes name').lean();
    const using = rounds.filter((r) => String(r.form) === String(form._id) || (r.classes || []).some((c) => String(c.form) === String(form._id)));
    if (using.length) refuse(`Round "${using[0].name}" uses this form — choose another form there first`, 409);
    await pool.query(`DELETE FROM "admissionforms" WHERE "_id" = $1 AND "school" = $2`, [String(form._id), String(req.schoolId)]);
    events.recordQuietly(req.schoolId, { by: req, type: 'form', action: 'deleted', message: `Form "${form.name}" deleted` });
    res.json({ success: true });
}, TAG);

// ── Document types ───────────────────────────────────────────────────────────

const FORMATS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

async function normalizeDocType(req, b, current = null) {
    const name = str(b.name ?? current?.name, 80);
    if (!name) refuse('Name the document', 400, { field: 'name' });
    const bad = textProblem(name, 'Document name', 'title'); if (bad) refuse(bad, 400, { field: 'name' });
    const key = current?.key || (str(b.key, 40).toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40));
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) refuse('The key must start with a letter and use lowercase letters, digits or _', 400, { field: 'key' });
    const accept = [...new Set((Array.isArray(b.accept ?? current?.accept) ? (b.accept ?? current.accept) : []).map((x) => String(x).toLowerCase()).filter((x) => FORMATS.includes(x)))];
    if (!accept.length) refuse('Allow at least one file format', 400, { field: 'accept' });
    const reviewers = ids(b.reviewers ?? current?.reviewers);
    if (reviewers.length) {
        const n = await User.countDocuments({ _id: { $in: reviewers }, school: req.schoolId, role: { $in: ['teacher', 'school_admin'] }, isActive: true });
        if (n !== reviewers.length) refuse('Reviewers must be active staff of the school', 400, { field: 'reviewers' });
    }
    const classIds = new Set((await Class.find({ school: req.schoolId }).select('_id').lean()).map((c) => String(c._id)));
    const roundIds = new Set((await AdmissionRound.find({ school: req.schoolId }).select('_id').lean()).map((r) => String(r._id)));
    const reasons = (Array.isArray(b.rejectionReasons ?? current?.rejectionReasons) ? (b.rejectionReasons ?? current.rejectionReasons) : []).map((r) => str(r, 150)).filter(Boolean).slice(0, 15);
    for (const r of reasons) { const rb = textProblem(r, 'Rejection reason'); if (rb) refuse(rb, 400, { field: 'rejectionReasons' }); }
    const mapsTo = str(b.mapsTo ?? current?.mapsTo, 40);
    if (mapsTo && !defaultForm.STUDENT_FILE_FIELDS[mapsTo]) refuse('Choose a student-record document field', 400, { field: 'mapsTo' });
    const description = str(b.description ?? current?.description, 300);
    const db = textProblem(description, 'Description'); if (db) refuse(db, 400, { field: 'description' });
    return {
        key, name, description, accept,
        maxSizeMB: num(b.maxSizeMB ?? current?.maxSizeMB, { min: 1, max: 20, d: 5 }),
        required: bool(b.required ?? current?.required, false),
        appliesTo: { classes: ids(b.appliesTo?.classes ?? current?.appliesTo?.classes).filter((x) => classIds.has(x)), rounds: ids(b.appliesTo?.rounds ?? current?.appliesTo?.rounds).filter((x) => roundIds.has(x)) },
        verification: bool(b.verification ?? current?.verification, true),
        gate: ['none', 'submission', 'before_exam', 'before_confirmation'].includes(b.gate ?? current?.gate) ? (b.gate ?? current.gate) : 'before_confirmation',
        reviewers, rejectionReasons: reasons,
        allowResubmission: bool(b.allowResubmission ?? current?.allowResubmission, true),
        maxResubmissions: num(b.maxResubmissions ?? current?.maxResubmissions, { min: 0, max: 10, d: 3, int: true }),
        deadlineDays: b.deadlineDays === '' || b.deadlineDays == null ? (b.deadlineDays === undefined ? current?.deadlineDays ?? null : null) : num(b.deadlineDays, { min: 1, max: 120, d: null, int: true }),
        mapsTo, sensitive: bool(b.sensitive ?? current?.sensitive, false),
        isActive: bool(b.isActive ?? current?.isActive, true),
    };
}

exports.docTypes = handler(async (req, res) => {
    const rows = await AdmissionDocumentType.find({ school: req.schoolId }).sort({ order: 1, name: 1 }).lean();
    const { rows: counts } = await pool.query(
        `SELECT "docKey", COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "status" IN ('uploaded', 'under_review'))::int AS pending
           FROM "admissiondocuments" WHERE "school" = $1 AND "current" GROUP BY "docKey"`, [String(req.schoolId)]);
    const byKey = new Map(counts.map((c) => [c.docKey, c]));
    res.json({ success: true, data: rows.map((r) => ({ ...r, uploads: byKey.get(r.key)?.n || 0, pending: byKey.get(r.key)?.pending || 0 })) });
}, TAG);

exports.createDocType = handler(async (req, res) => {
    const data = await normalizeDocType(req, req.body || {});
    const { rows: [o] } = await pool.query(`SELECT COALESCE(MAX("order"), 0) AS n FROM "admissiondocumenttypes" WHERE "school" = $1`, [String(req.schoolId)]);
    try {
        const row = await AdmissionDocumentType.create({ ...data, school: req.schoolId, order: Number(o.n) + 1, createdBy: req.userId });
        events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'doctype_created', message: `Document type "${row.name}" added` });
        res.status(201).json({ success: true, data: row });
    } catch (e) {
        if (e.code === 11000) refuse(`A document type with the key "${data.key}" already exists`, 409, { field: 'key' });
        throw e;
    }
}, TAG);

exports.updateDocType = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const current = await access.schoolRow(AdmissionDocumentType, req, req.params.id, 'Document type');
    const data = await normalizeDocType(req, req.body || {}, current);
    const row = await patch(AdmissionDocumentType, current._id, data);
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'doctype_updated', message: `Document type "${row.name}" updated` });
    res.json({ success: true, data: row });
}, TAG);

exports.deleteDocType = handler(async (req, res) => {
    const access = require('../services/admission/access');
    const current = await access.schoolRow(AdmissionDocumentType, req, req.params.id, 'Document type');
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "admissiondocuments" WHERE "docType" = $1`, [String(current._id)]);
    const { rows: forms } = await pool.query(`SELECT "_id" FROM "admissionformversions" WHERE "school" = $1 AND "status" IN ('draft', 'published') AND "schema"::text LIKE $2 LIMIT 1`, [String(req.schoolId), `%"docType": "${current.key}"%`]);
    const { rows: forms2 } = await pool.query(`SELECT "_id" FROM "admissionformversions" WHERE "school" = $1 AND "status" IN ('draft', 'published') AND "schema"::text LIKE $2 LIMIT 1`, [String(req.schoolId), `%"docType":"${current.key}"%`]);
    if (n.n || forms.length || forms2.length) {
        await patch(AdmissionDocumentType, current._id, { isActive: false });
        return res.json({ success: true, data: { archived: true }, message: 'It is in use, so it was switched off instead of deleted' });
    }
    await pool.query(`DELETE FROM "admissiondocumenttypes" WHERE "_id" = $1 AND "school" = $2`, [String(current._id), String(req.schoolId)]);
    res.json({ success: true, data: { deleted: true } });
}, TAG);

exports.orderDocTypes = handler(async (req, res) => {
    const list = ids(req.body?.ids);
    for (let i = 0; i < list.length; i++) await pool.query(`UPDATE "admissiondocumenttypes" SET "order" = $3 WHERE "_id" = $1 AND "school" = $2`, [list[i], String(req.schoolId), i]);
    res.json({ success: true });
}, TAG);

// ── Workflow ─────────────────────────────────────────────────────────────────

exports.workflow = handler(async (req, res) => {
    const settings = await settingsSvc.getSettings(req.schoolId);
    const { rows } = await pool.query(`SELECT "status", COUNT(*)::int AS n FROM "admissionapplications" WHERE "school" = $1 GROUP BY "status"`, [String(req.schoolId)]);
    res.json({
        success: true,
        data: {
            stages: settings.workflow.stages,
            catalog: { stages: workflow.STAGES, statuses: Object.entries(workflow.STATUSES).map(([key, m]) => ({ key, ...m })), checks: Object.entries(workflow.CHECKS).map(([key, label]) => ({ key, label })), movable: workflow.MOVABLE },
            counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
        },
    });
}, TAG);

exports.saveWorkflow = handler(async (req, res) => {
    const before = await settingsSvc.getSettings(req.schoolId, { fresh: true });
    const saved = await settingsSvc.saveBlocks(req.schoolId, { workflow: { stages: req.body?.stages } }, req.userId);
    const was = new Map(before.workflow.stages.map((s) => [s.key, s.enabled]));
    const changed = saved.workflow.stages.filter((s) => was.get(s.key) !== s.enabled).map((s) => `${s.label} ${s.enabled ? 'on' : 'off'}`);
    events.recordQuietly(req.schoolId, { by: req, type: 'config', action: 'workflow', message: `Workflow saved${changed.length ? ` — ${changed.join(', ')}` : ''}` });
    res.json({ success: true, data: saved.workflow });
}, TAG);

// ── Emails ───────────────────────────────────────────────────────────────────

const eventOf = (req) => {
    const e = String(req.params.event || '');
    if (!catalog.EVENTS[e]) notFound('Email');
    return e;
};

exports.emails = handler(async (req, res) => res.json({ success: true, data: await mailer.listTemplates(req.schoolId) }), TAG);

exports.saveEmail = handler(async (req, res) => {
    const event = eventOf(req);
    const row = await mailer.saveTemplate(req.schoolId, event, req.body || {}, req.userId);
    events.recordQuietly(req.schoolId, { by: req, type: 'email', action: 'template_saved', message: `Email "${catalog.EVENTS[event].label}" saved (version ${row.version})` });
    res.json({ success: true, data: row });
}, TAG);

exports.previewEmail = handler(async (req, res) => {
    res.json({ success: true, data: await mailer.preview(req.schoolId, eventOf(req), { subject: req.body?.subject, body: req.body?.body }) });
}, TAG);

exports.testEmail = handler(async (req, res) => {
    const event = eventOf(req);
    const to = str(req.body?.to, 200).toLowerCase() || req.user.email;
    if (!require('../utils/validators').isEmail(to)) refuse('Enter a valid address to send the test to', 400, { field: 'to' });
    const tpl = await mailer.templateFor(req.schoolId, event);
    const subject = req.body?.subject ?? tpl.subject;
    const body = req.body?.body ?? tpl.body;
    const p = await mailer.preview(req.schoolId, event, { subject, body });
    if (p.problems.length) refuse(p.problems[0], 400);
    const r = await mailer.send(req.schoolId, event, { to, isTest: true, values: catalog.sampleValues(), template: { subject: `[Test] ${subject}`, body } });
    res.json({ success: true, data: r, message: r.status === 'sent' ? `Test sent to ${to}` : r.status === 'logged' ? 'The mail driver is "log" — the test was recorded, not sent' : `The mail server refused it: ${r.error}` });
}, TAG);

exports.toggleEmail = handler(async (req, res) => {
    const event = eventOf(req);
    const row = await mailer.setEnabled(req.schoolId, event, req.body?.enabled === true, req.userId);
    events.recordQuietly(req.schoolId, { by: req, type: 'email', action: 'template_toggled', message: `Email "${catalog.EVENTS[event].label}" switched ${row.enabled ? 'on' : 'off'}` });
    res.json({ success: true, data: row });
}, TAG);

exports.emailVersions = handler(async (req, res) => res.json({ success: true, data: await mailer.versions(req.schoolId, eventOf(req)) }), TAG);

exports.restoreEmail = handler(async (req, res) => {
    const event = eventOf(req);
    const row = await mailer.restore(req.schoolId, event, req.body?.version, req.userId);
    res.json({ success: true, data: row });
}, TAG);

exports.resetEmail = handler(async (req, res) => {
    const event = eventOf(req);
    res.json({ success: true, data: await mailer.resetToDefault(req.schoolId, event, req.userId) });
}, TAG);

exports.emailLogs = handler(async (req, res) => {
    const r = await mailer.logs(req.schoolId, req.query);
    res.json({ success: true, data: r.rows, total: r.total, last30: r.last30 });
}, TAG);

exports.retryEmail = handler(async (req, res) => {
    if (!isId(String(req.params.id))) notFound('Email');
    res.json({ success: true, data: await mailer.retry(req.schoolId, req.params.id) });
}, TAG);

// ── Enquiries ────────────────────────────────────────────────────────────────

// Enquiries: controllers/admissionCrm.controller.js (services/admission/crm.js).

// ── Applicant accounts ───────────────────────────────────────────────────────

exports.applicants = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    let filter = '';
    if (req.query.q) { params.push(`%${String(req.query.q).toLowerCase()}%`); filter = `AND (lower(u."name") LIKE $2 OR lower(u."email") LIKE $2 OR u."phone" LIKE $2)`; }
    const limit = Math.min(100, Number(req.query.limit) || 25);
    const offset = (Math.max(1, Number(req.query.page) || 1) - 1) * limit;
    const { rows } = await pool.query(
        `SELECT u."_id", u."name", u."email", u."phone", u."isActive", u."createdAt", ap."lastLoginAt", ap."source", ap."linkedExisting",
                (SELECT COUNT(*) FROM "admissionapplications" a WHERE a."applicant" = u."_id")::int AS applications
           FROM "users" u LEFT JOIN "admissionapplicants" ap ON ap."user" = u."_id"
          WHERE u."school" = $1 AND u."role" = 'guest' ${filter} ORDER BY u."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM "users" u WHERE u."school" = $1 AND u."role" = 'guest' ${filter}`, params);
    res.json({ success: true, data: rows, total: c.n });
}, TAG);

exports.setApplicantActive = handler(async (req, res) => {
    if (!isId(String(req.params.userId))) notFound('Applicant');
    const active = req.body?.isActive === true;
    const { rows } = await pool.query(`UPDATE "users" SET "isActive" = $3 WHERE "_id" = $1 AND "school" = $2 AND "role" = 'guest' RETURNING "_id", "name"`, [String(req.params.userId), String(req.schoolId), active]);
    if (!rows[0]) notFound('Applicant');
    await require('../utils/authCache').invalidate(String(rows[0]._id)).catch(() => {});
    events.recordQuietly(req.schoolId, { by: req, type: 'account', action: active ? 'applicant_on' : 'applicant_off', message: `Applicant account of ${rows[0].name} switched ${active ? 'on' : 'off'}` });
    res.json({ success: true });
}, TAG);

// ── Dashboard, audit ─────────────────────────────────────────────────────────

exports.analytics = handler(async (req, res) => res.json({ success: true, data: await analytics.overview(req.schoolId, req.query) }), TAG);

exports.audit = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    const where = ['e."school" = $1'];
    if (req.query.type) { params.push(String(req.query.type)); where.push(`e."type" = $${params.length}`); }
    if (req.query.q) { params.push(`%${String(req.query.q).toLowerCase()}%`); where.push(`(lower(e."message") LIKE $${params.length} OR lower(e."actorName") LIKE $${params.length} OR lower(COALESCE(a."applicationNumber", '')) LIKE $${params.length})`); }
    if (req.query.application && isId(String(req.query.application))) { params.push(String(req.query.application)); where.push(`e."application" = $${params.length}`); }
    if (req.query.from && date(req.query.from)) { params.push(date(req.query.from)); where.push(`e."createdAt" >= $${params.length}`); }
    if (req.query.to && date(req.query.to)) { params.push(new Date(date(req.query.to).getTime() + 86400000)); where.push(`e."createdAt" < $${params.length}`); }
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const offset = (Math.max(1, Number(req.query.page) || 1) - 1) * limit;
    const [{ rows }, { rows: [c] }] = await Promise.all([
        pool.query(`SELECT e."_id", e."type", e."action", e."from", e."to", e."message", e."visibility", e."actorName", e."actorRole", e."createdAt", e."application", a."applicationNumber", a."studentName"
                      FROM "admissionevents" e LEFT JOIN "admissionapplications" a ON a."_id" = e."application"
                     WHERE ${where.join(' AND ')} ORDER BY e."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`, params),
        pool.query(`SELECT COUNT(*)::int AS n FROM "admissionevents" e LEFT JOIN "admissionapplications" a ON a."_id" = e."application" WHERE ${where.join(' AND ')}`, params),
    ]);
    res.json({ success: true, data: rows, total: c.n });
}, TAG);

exports._ensureDefaults = ensureDefaults;
