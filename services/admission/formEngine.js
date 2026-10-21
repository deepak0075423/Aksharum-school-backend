'use strict';
/**
 * Application forms: what a school may design, and what an applicant's
 * answers must satisfy. The same rules run on the server for every save and
 * submission — the browser's checks are a convenience, never the gate.
 *
 * A form is { sections: [{ key, title, description, fields: [field] }] }.
 * A field is
 *   { key, type, label, help, placeholder, required, width,
 *     options: [{ value, label }]            select · radio · multiselect
 *     validation: { minLength, maxLength,    text · textarea
 *                   kind,                    a text kind (utils/textRules): name, place, pincode …
 *                   min, max, integer,       number (and min/max selections for multiselect)
 *                   minDate, maxDate },      date: 'YYYY-MM-DD' or 'today'
 *     visibleIf: { mode: 'all'|'any', rules: [{ field, op, value }] },
 *     classes: [classId], rounds: [roundId], only for these (empty: all)
 *     docType: '<document type key>',       file
 *     text,                                  declaration · info
 *     sensitive, mapTo, defaultValue }
 *
 * A condition may only look at a field that comes EARLIER in the form, so
 * conditions can never chase each other in a circle.
 */
const { textProblem, KINDS: TEXT_KINDS } = require('../../utils/textRules');
const { isEmail, isPhone, normalizePhone } = require('../../utils/validators');
const { refuse } = require('./util');

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'phone', 'select', 'radio', 'checkbox', 'multiselect', 'file', 'declaration', 'info'];
const INPUT_TYPES = FIELD_TYPES.filter((t) => !['info', 'file'].includes(t));
const CHOICE_TYPES = ['select', 'radio', 'multiselect'];
const OPS = ['eq', 'neq', 'in', 'not_in', 'checked', 'not_checked', 'filled', 'empty', 'gt', 'lt', 'gte', 'lte'];
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,39}$/;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.,&'()/+-]{0,59}$/;
/**
 * School identifiers an Indian application asks for (Oct 2026) — checked here
 * for admission forms only, beside the ERP-wide text kinds:
 *   udise  the previous school's UDISE+ code — 11 digits
 *   pen    the student's Permanent Education Number (UDISE+) — 11 digits
 *   apaar  the student's APAAR ID ("One Nation One Student ID") — 12 digits
 */
const ID_KINDS = {
    udise: { ok: /^\d{11}$/, msg: (l) => `${l} must be the 11-digit UDISE+ code of the school` },
    pen:   { ok: /^\d{11}$/, msg: (l) => `${l} must be the 11-digit PEN (Permanent Education Number)` },
    apaar: { ok: /^\d{12}$/, msg: (l) => `${l} must be the 12-digit APAAR ID` },
};
const ALLOWED_KINDS = ['text', ...Object.keys(TEXT_KINDS).filter((k) => !['date', 'time', 'otp'].includes(k)), ...Object.keys(ID_KINDS)];

/**
 * Where an answer goes when the applicant is enrolled
 * (services/admission/conversion.js reads these).
 */
const MAP_TARGETS = {
    'student.name': 'Student — full name', 'student.dob': 'Student — date of birth', 'student.gender': 'Student — gender',
    'student.bloodGroup': 'Student — blood group', 'student.religion': 'Student — religion', 'student.category': 'Student — category',
    'student.nationality': 'Student — nationality', 'student.aadhaarNumber': 'Student — Aadhaar number',
    'student.email': 'Student — email', 'student.phone': 'Student — mobile',
    'address.line': 'Current address', 'address.city': 'Current address — city', 'address.state': 'Current address — state',
    'address.pincode': 'Current address — PIN code', 'address.country': 'Current address — country',
    'permanent.line': 'Permanent address', 'permanent.city': 'Permanent address — city', 'permanent.state': 'Permanent address — state',
    'permanent.pincode': 'Permanent address — PIN code', 'permanent.sameAsCurrent': 'Permanent address same as current',
    'father.name': 'Father — name', 'father.email': 'Father — email', 'father.phone': 'Father — mobile', 'father.occupation': 'Father — occupation',
    'father.qualification': 'Father — qualification', 'father.organization': 'Father — organisation', 'father.annualIncome': 'Father — annual income',
    'mother.name': 'Mother — name', 'mother.email': 'Mother — email', 'mother.phone': 'Mother — mobile', 'mother.occupation': 'Mother — occupation',
    'mother.qualification': 'Mother — qualification', 'mother.organization': 'Mother — organisation', 'mother.annualIncome': 'Mother — annual income',
    'guardian.name': 'Guardian — name', 'guardian.email': 'Guardian — email', 'guardian.phone': 'Guardian — mobile',
    'guardian.relation': 'Guardian — relation', 'guardian.occupation': 'Guardian — occupation',
    'contact.primary': 'Primary contact (father / mother / guardian)',
    'emergency.name': 'Emergency contact — name', 'emergency.phone': 'Emergency contact — mobile', 'emergency.relation': 'Emergency contact — relation',
    'previous.attended': 'Attended a previous school', 'previous.name': 'Previous school — name', 'previous.board': 'Previous school — board',
    'previous.class': 'Previous school — last class', 'previous.year': 'Previous school — academic year', 'previous.city': 'Previous school — city',
    'previous.tcNumber': 'Previous school — TC number', 'previous.tcDate': 'Previous school — TC date',
    'previous.udise': 'Previous school — UDISE+ code', 'previous.state': 'Previous school — state', 'previous.pincode': 'Previous school — PIN code',
    'previous.leavingDate': 'Previous school — date of leaving', 'previous.medium': 'Previous school — medium of instruction',
    'student.pen': 'Student — PEN (Permanent Education Number)', 'student.apaar': 'Student — APAAR ID',
    'medical.allergies': 'Allergies', 'medical.conditions': 'Medical conditions', 'medical.medicines': 'Regular medicines',
    'medical.doctorName': 'Family doctor — name', 'medical.doctorPhone': 'Family doctor — mobile', 'medical.dietary': 'Dietary needs', 'medical.notes': 'Medical notes',
    'sibling.studying': 'Sibling studying here', 'sibling.name': 'Sibling — name', 'sibling.admissionNumber': 'Sibling — admission number',
    'transport.required': 'Needs school transport', 'transport.address': 'Transport — pickup address',
    'hostel.required': 'Needs hostel', 'hostel.notes': 'Hostel — notes',
};

// ── Designing a form ─────────────────────────────────────────────────────────

const s = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Check and tidy a form as the builder sends it.
 * ctx: { docTypeKeys: Set, classIds: Set, roundIds: Set } — what may be referenced.
 * Returns the normalised schema, or throws a refusal listing every problem.
 */
function validateSchema(input, ctx = {}) {
    const errors = [];
    const err = (path, message) => { if (errors.length < 50) errors.push({ path, message }); };
    const sectionsIn = Array.isArray(input?.sections) ? input.sections : [];
    if (!sectionsIn.length) err('sections', 'Add at least one section');
    if (sectionsIn.length > 30) err('sections', 'A form can have at most 30 sections');

    const seenKeys = new Map();       // key → field (in order), for conditions and uniqueness
    const seenTargets = new Set();
    let total = 0;
    const sections = [];
    sectionsIn.slice(0, 30).forEach((sec, si) => {
        const path = `sections[${si}]`;
        const key = s(sec?.key, 40) || `section${si + 1}`;
        if (!KEY_RE.test(key)) err(`${path}.key`, `Section ${si + 1} has an invalid key`);
        const title = s(sec?.title, 80);
        if (!title) err(`${path}.title`, `Section ${si + 1} needs a title`);
        const titleBad = textProblem(title, `Section ${si + 1} title`); if (titleBad) err(`${path}.title`, titleBad);
        const description = s(sec?.description, 600);
        const descBad = textProblem(description, `Section ${si + 1} description`); if (descBad) err(`${path}.description`, descBad);
        const fieldsIn = Array.isArray(sec?.fields) ? sec.fields : [];
        if (fieldsIn.length > 60) err(`${path}.fields`, `Section "${title}" has more than 60 fields`);
        const fields = [];
        fieldsIn.slice(0, 60).forEach((f, fi) => {
            total += 1;
            const fpath = `${path}.fields[${fi}]`;
            const field = normalizeField(f, fpath, err, { seenKeys, seenTargets, ctx });
            if (field) { fields.push(field); seenKeys.set(field.key, field); }
        });
        const sectionVisible = normalizeCondition(sec?.visibleIf, `${path}.visibleIf`, err, seenKeys, `Section "${title}"`);
        sections.push({
            key, title, description, fields,
            visibleIf: sectionVisible,
            classes: idList(sec?.classes, ctx.classIds),
            rounds: idList(sec?.rounds, ctx.roundIds),
        });
    });
    if (total > 300) err('sections', 'A form can have at most 300 fields');
    const sectionKeys = new Set();
    for (const sec of sections) { if (sectionKeys.has(sec.key)) err('sections', `Two sections share the key "${sec.key}"`); sectionKeys.add(sec.key); }
    if (errors.length) refuse(errors[0].message, 400, { errors, field: errors[0].path });
    return { sections };
}

const idList = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String))].filter((id) => !allowed || allowed.has(id));

function normalizeField(f, path, err, { seenKeys, seenTargets, ctx }) {
    const type = String(f?.type || '');
    if (!FIELD_TYPES.includes(type)) { err(`${path}.type`, `"${type}" is not a field type`); return null; }
    const key = s(f?.key, 40);
    const label = s(f?.label, 160);
    const name = label || key || 'A field';
    if (!KEY_RE.test(key)) err(`${path}.key`, `${name}: the key must start with a letter and use letters, digits or _ (2–40 characters)`);
    if (seenKeys.has(key)) err(`${path}.key`, `Two fields share the key "${key}"`);
    if (!label && type !== 'info') err(`${path}.label`, `${key || 'A field'} needs a label`);
    for (const [prop, max] of [['label', 160], ['help', 300], ['placeholder', 120]]) {
        const bad = textProblem(s(f?.[prop], max), `${name}: ${prop}`);
        if (bad) err(`${path}.${prop}`, bad);
    }
    const out = {
        key, type, label,
        help: s(f?.help, 300),
        placeholder: s(f?.placeholder, 120),
        required: type === 'info' ? false : !!f?.required,
        width: f?.width === 'half' ? 'half' : 'full',
        sensitive: !!f?.sensitive,
    };
    if (CHOICE_TYPES.includes(type)) {
        const opts = (Array.isArray(f?.options) ? f.options : []).slice(0, 80).map((o) => ({
            value: s(typeof o === 'string' ? o : o?.value, 60),
            label: s(typeof o === 'string' ? o : (o?.label ?? o?.value), 120),
        })).filter((o) => o.value);
        if (opts.length < (type === 'multiselect' ? 1 : 2)) err(`${path}.options`, `${name}: give at least ${type === 'multiselect' ? 'one option' : 'two options'}`);
        const values = new Set();
        for (const o of opts) {
            if (!VALUE_RE.test(o.value)) err(`${path}.options`, `${name}: option "${o.value}" may use letters, digits, spaces and . , & ' ( ) / + - _`);
            if (values.has(o.value.toLowerCase())) err(`${path}.options`, `${name}: option "${o.value}" is listed twice`);
            values.add(o.value.toLowerCase());
            const bad = textProblem(o.label, `${name}: option`); if (bad) err(`${path}.options`, bad);
        }
        out.options = opts;
    }
    const v = f?.validation || {};
    const validation = {};
    if (type === 'text' || type === 'textarea') {
        const maxDefault = type === 'textarea' ? 2000 : 200;
        validation.minLength = clampInt(v.minLength, 0, maxDefault, 0);
        validation.maxLength = clampInt(v.maxLength, 1, type === 'textarea' ? 5000 : 500, maxDefault);
        if (validation.minLength > validation.maxLength) err(`${path}.validation`, `${name}: the minimum length is more than the maximum`);
        const kind = ALLOWED_KINDS.includes(v.kind) ? v.kind : 'text';
        validation.kind = kind;
    }
    if (type === 'number') {
        validation.min = Number.isFinite(Number(v.min)) && v.min !== '' && v.min !== null ? Number(v.min) : null;
        validation.max = Number.isFinite(Number(v.max)) && v.max !== '' && v.max !== null ? Number(v.max) : null;
        validation.integer = !!v.integer;
        if (validation.min !== null && validation.max !== null && validation.min > validation.max) err(`${path}.validation`, `${name}: the minimum is more than the maximum`);
    }
    if (type === 'multiselect') {
        validation.min = clampInt(v.min, 0, 80, 0);
        validation.max = clampInt(v.max, 0, 80, 0);   // 0: no limit
    }
    if (type === 'date') {
        validation.minDate = dateBound(v.minDate);
        validation.maxDate = dateBound(v.maxDate);
        if (v.minDate && validation.minDate === null) err(`${path}.validation`, `${name}: the earliest date must be YYYY-MM-DD or "today"`);
        if (v.maxDate && validation.maxDate === null) err(`${path}.validation`, `${name}: the latest date must be YYYY-MM-DD or "today"`);
    }
    if (Object.keys(validation).length) out.validation = validation;

    if (type === 'file') {
        const docType = s(f?.docType, 60);
        if (!docType) err(`${path}.docType`, `${name}: choose which document this upload is`);
        else if (ctx.docTypeKeys && !ctx.docTypeKeys.has(docType)) err(`${path}.docType`, `${name}: document type "${docType}" does not exist — add it under Documents first`);
        out.docType = docType;
    }
    if (type === 'declaration' || type === 'info') {
        out.text = s(f?.text, 3000);
        const bad = textProblem(out.text, `${name}: text`); if (bad) err(`${path}.text`, bad);
        if (type === 'declaration' && !out.text && !label) err(`${path}.text`, `${name}: write the declaration`);
    }
    if (f?.mapTo) {
        const target = s(f.mapTo, 60);
        if (!MAP_TARGETS[target]) err(`${path}.mapTo`, `${name}: "${target}" is not a student-record field`);
        else if (seenTargets.has(target)) err(`${path}.mapTo`, `${name}: another field already fills "${MAP_TARGETS[target]}"`);
        else { seenTargets.add(target); out.mapTo = target; }
    }
    out.visibleIf = normalizeCondition(f?.visibleIf, `${path}.visibleIf`, err, seenKeys, name);
    out.classes = idList(f?.classes, ctx.classIds);
    out.rounds = idList(f?.rounds, ctx.roundIds);
    if (f?.defaultValue !== undefined && f?.defaultValue !== null && f.defaultValue !== '' && INPUT_TYPES.includes(type)) {
        const r = checkValue(out, f.defaultValue);
        if (r.error) err(`${path}.defaultValue`, `${name}: the default value — ${r.error}`);
        else out.defaultValue = r.value;
    }
    return out;
}

const clampInt = (v, min, max, d) => {
    const n = Number(v);
    if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
};
const dateBound = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (v === 'today') return 'today';
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime()) ? String(v) : null;
};

function normalizeCondition(c, path, err, seenKeys, name) {
    if (!c || !Array.isArray(c.rules) || !c.rules.length) return null;
    const rules = [];
    for (const r of c.rules.slice(0, 10)) {
        const field = s(r?.field, 40);
        const op = OPS.includes(r?.op) ? r.op : null;
        if (!op) { err(path, `${name}: a condition has no valid comparison`); continue; }
        const target = seenKeys.get(field);
        if (!target) { err(path, `${name}: a condition refers to "${field}", which is not an earlier field`); continue; }
        if (['info', 'file'].includes(target.type)) { err(path, `${name}: a condition cannot look at "${target.label}"`); continue; }
        let value = r?.value;
        if (['in', 'not_in'].includes(op)) value = (Array.isArray(value) ? value : [value]).map((x) => s(x, 60)).filter(Boolean).slice(0, 30);
        else if (['checked', 'not_checked', 'filled', 'empty'].includes(op)) value = null;
        else if (['gt', 'lt', 'gte', 'lte'].includes(op)) value = target.type === 'date' ? s(value, 10) : Number(value);
        else value = s(value, 60);
        rules.push({ field, op, value });
    }
    return rules.length ? { mode: c.mode === 'any' ? 'any' : 'all', rules } : null;
}

// ── Answering a form ─────────────────────────────────────────────────────────

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function testRule(rule, answers) {
    const v = answers[rule.field];
    switch (rule.op) {
        case 'eq': return String(v ?? '') === String(rule.value ?? '');
        case 'neq': return String(v ?? '') !== String(rule.value ?? '');
        case 'in': return Array.isArray(v) ? v.some((x) => rule.value.includes(String(x))) : rule.value.includes(String(v ?? ''));
        case 'not_in': return Array.isArray(v) ? !v.some((x) => rule.value.includes(String(x))) : !rule.value.includes(String(v ?? ''));
        case 'checked': return v === true;
        case 'not_checked': return v !== true;
        case 'filled': return !isEmpty(v);
        case 'empty': return isEmpty(v);
        case 'gt': return !isEmpty(v) && (typeof rule.value === 'string' ? String(v) > rule.value : Number(v) > rule.value);
        case 'lt': return !isEmpty(v) && (typeof rule.value === 'string' ? String(v) < rule.value : Number(v) < rule.value);
        case 'gte': return !isEmpty(v) && (typeof rule.value === 'string' ? String(v) >= rule.value : Number(v) >= rule.value);
        case 'lte': return !isEmpty(v) && (typeof rule.value === 'string' ? String(v) <= rule.value : Number(v) <= rule.value);
        default: return true;
    }
}
const conditionHolds = (cond, answers) => {
    if (!cond) return true;
    const results = cond.rules.map((r) => testRule(r, answers));
    return cond.mode === 'any' ? results.some(Boolean) : results.every(Boolean);
};
const scoped = (item, { classId, roundId }) =>
    (!item.classes?.length || (classId && item.classes.includes(String(classId))))
    && (!item.rounds?.length || (roundId && item.rounds.includes(String(roundId))));

/**
 * The fields that apply to this application right now — for this class and
 * round, with every condition met by the answers so far. Order is the form's.
 */
function applicableFields(schema, answers = {}, scope = {}) {
    const out = [];
    for (const sec of schema?.sections || []) {
        if (!scoped(sec, scope) || !conditionHolds(sec.visibleIf, answers)) continue;
        for (const f of sec.fields || []) {
            if (!scoped(f, scope) || !conditionHolds(f.visibleIf, answers)) continue;
            out.push({ ...f, section: sec.key });
        }
    }
    return out;
}

const allFields = (schema) => (schema?.sections || []).flatMap((sec) => (sec.fields || []).map((f) => ({ ...f, section: sec.key })));

/** One value checked and tidied for its field: { value } or { error }. */
function checkValue(field, raw) {
    const label = field.label || field.key;
    const v = field.validation || {};
    switch (field.type) {
        case 'text':
        case 'textarea': {
            if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} must be text` };
            const t = String(raw).trim();
            if (v.minLength && t.length < v.minLength) return { error: `${label} must be at least ${v.minLength} characters` };
            if (t.length > (v.maxLength || (field.type === 'textarea' ? 2000 : 200))) return { error: `${label} must be at most ${v.maxLength || 200} characters` };
            const id = ID_KINDS[v.kind];
            const bad = textProblem(t, label, id ? 'digits' : (v.kind || 'text')) || (id && !id.ok.test(t) ? id.msg(label) : null);
            if (bad) return { error: bad };
            const upper = TEXT_KINDS[v.kind]?.upper;
            return { value: upper ? t.toUpperCase() : t };
        }
        case 'number': {
            const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
            if (String(raw).trim() === '' || !Number.isFinite(n)) return { error: `${label} must be a number` };
            if (v.integer && !Number.isInteger(n)) return { error: `${label} must be a whole number` };
            if (v.min !== null && v.min !== undefined && n < v.min) return { error: `${label} must be at least ${v.min}` };
            if (v.max !== null && v.max !== undefined && n > v.max) return { error: `${label} must be at most ${v.max}` };
            return { value: n };
        }
        case 'date': {
            const t = String(raw).trim().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(new Date(`${t}T00:00:00`).getTime())) return { error: `${label} must be a date` };
            const min = v.minDate === 'today' ? today() : v.minDate;
            const max = v.maxDate === 'today' ? today() : v.maxDate;
            if (min && t < min) return { error: `${label} cannot be before ${min}` };
            if (max && t > max) return { error: `${label} cannot be after ${max}` };
            return { value: t };
        }
        case 'email': {
            const t = String(raw).trim().toLowerCase();
            if (!isEmail(t) || t.length > 200) return { error: `${label} must be a valid email address` };
            return { value: t };
        }
        case 'phone': {
            const t = normalizePhone(raw);
            if (!isPhone(t)) return { error: `${label} must be a valid 10-digit mobile number` };
            return { value: t };
        }
        case 'select':
        case 'radio': {
            const t = String(raw).trim();
            const hit = (field.options || []).find((o) => o.value === t);
            if (!hit) return { error: `${label}: choose one of the options` };
            return { value: hit.value };
        }
        case 'multiselect': {
            const list = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : [String(raw).trim()];
            const allowed = new Set((field.options || []).map((o) => o.value));
            const chosen = [...new Set(list.filter(Boolean))];
            if (chosen.some((x) => !allowed.has(x))) return { error: `${label}: choose from the options given` };
            if (v.min && chosen.length < v.min) return { error: `${label}: choose at least ${v.min}` };
            if (v.max && chosen.length > v.max) return { error: `${label}: choose at most ${v.max}` };
            return { value: chosen };
        }
        case 'checkbox':
        case 'declaration':
            return { value: raw === true || raw === 'true' || raw === 1 || raw === '1' };
        default:
            return { value: undefined };
    }
}

/**
 * Check an applicant's answers.
 *
 *   partial   a draft save: only what was filled in is checked, nothing is
 *             required yet, and answers to fields hidden right now are kept
 *             (the applicant may change the condition back)
 *   docs      for a full check: { docKey: true } for every document type
 *             with a current upload — a required file field needs one
 *
 * Returns { data, errors: { key: message }, firstError, missingDocs }.
 * `data` holds only fields the form has, tidied; on a full check, only the
 * fields that apply.
 */
function validateAnswers(schema, answers = {}, { classId = null, roundId = null, partial = false, docs = {} } = {}) {
    const input = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
    const scope = { classId, roundId };
    const known = allFields(schema);
    const byKey = new Map(known.map((f) => [f.key, f]));
    const errors = {};
    const data = {};

    // Tidy every answer to a known field first, so conditions see clean values.
    for (const [key, raw] of Object.entries(input)) {
        const f = byKey.get(key);
        if (!f || !INPUT_TYPES.includes(f.type) || isEmpty(raw)) continue;
        if ((f.type === 'checkbox' || f.type === 'declaration') && !(raw === true || raw === 'true' || raw === 1 || raw === '1')) { data[key] = false; continue; }
        const r = checkValue(f, raw);
        if (r.error) errors[key] = r.error;
        else if (r.value !== undefined) data[key] = r.value;
    }

    const applicable = applicableFields(schema, data, scope);
    const applies = new Set(applicable.map((f) => f.key));
    const missingDocs = [];
    if (!partial) {
        for (const f of applicable) {
            if (f.type === 'info') continue;
            if (f.type === 'file') {
                if (f.required && !docs[f.docType]) { errors[f.key] = `${f.label} — upload the document`; missingDocs.push(f.docType); }
                continue;
            }
            if (!f.required) continue;
            const v = data[f.key];
            if (f.type === 'declaration' || f.type === 'checkbox') {
                if (v !== true) errors[f.key] = errors[f.key] || (f.type === 'declaration' ? `Please accept: ${f.label}` : `${f.label} must be ticked`);
            } else if (isEmpty(v) && !errors[f.key]) {
                errors[f.key] = `${f.label} is required`;
            }
        }
        // A submitted application keeps only the answers that apply to it.
        for (const key of Object.keys(data)) if (!applies.has(key)) delete data[key];
        for (const key of Object.keys(errors)) if (!applies.has(key)) delete errors[key];
    }
    const firstKey = Object.keys(errors)[0];
    return { data, errors, firstError: firstKey ? errors[firstKey] : null, missingDocs };
}

/** The document types a form asks for, for this class/round with these answers. */
function fileFields(schema, answers = {}, scope = {}) {
    return applicableFields(schema, answers, scope).filter((f) => f.type === 'file');
}

// ── Moving a draft to a newer version of its form ────────────────────────────

/**
 * Carry `data` from one version of a form to another: an answer moves when
 * the new version still asks the same question (same key and kind of answer,
 * and for a choice, the chosen option still exists); anything else is kept in
 * `retired`, never thrown away.
 */
function migrateAnswers(fromSchema, toSchema, data = {}) {
    const toFields = new Map(allFields(toSchema).map((f) => [f.key, f]));
    const kept = {};
    const retired = {};
    for (const [key, value] of Object.entries(data || {})) {
        const f = toFields.get(key);
        if (!f || !INPUT_TYPES.includes(f.type)) { retired[key] = value; continue; }
        const r = checkValue(f, value);
        if (r.error || r.value === undefined) retired[key] = value;
        else kept[key] = r.value;
    }
    return { data: kept, retired };
}

// ── What the office reads off an application ────────────────────────────────

/** Value of the field mapped to `target`, or undefined. */
function mapped(schema, data, target) {
    const f = allFields(schema).find((x) => x.mapTo === target);
    return f ? data?.[f.key] : undefined;
}

/**
 * The columns copied onto the application row for search and duplicates:
 * the child, and the family's main contact (guardian, else father, else
 * mother — unless the form asked who the primary contact is).
 */
function summaryOf(schema, data = {}) {
    const m = (t) => mapped(schema, data, t);
    const primary = String(m('contact.primary') || '').toLowerCase();
    const order = primary === 'mother' ? ['mother', 'father', 'guardian'] : primary === 'guardian' ? ['guardian', 'father', 'mother'] : primary === 'father' ? ['father', 'mother', 'guardian'] : ['guardian', 'father', 'mother'];
    const who = order.find((p) => m(`${p}.name`) || m(`${p}.phone`) || m(`${p}.email`)) || null;
    const dob = m('student.dob');
    return {
        studentName: String(m('student.name') || '').trim().slice(0, 160),
        studentDob: dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00Z`) : null,
        studentGender: String(m('student.gender') || '').slice(0, 20),
        guardianName: who ? String(m(`${who}.name`) || '').trim().slice(0, 160) : '',
        guardianEmail: who ? String(m(`${who}.email`) || '').trim().toLowerCase().slice(0, 200) : '',
        guardianPhone: who ? String(m(`${who}.phone`) || '').trim().slice(0, 20) : '',
    };
}

/** The answers, field by field, for the office's view — sensitive ones only when allowed. */
// ── Aadhaar numbers ──────────────────────────────────────────────────────────
// Shown masked everywhere ("XXXX XXXX 1234"), as UIDAI's rules ask; the office
// reveals one deliberately, and the reveal is logged (services/admission/privacy).
const isAadhaarField = (f) => f?.validation?.kind === 'aadhaar';
const MASKED = /^XXXX XXXX (\d{4}|XXXX)$/;
function maskAadhaar(v) {
    const d = String(v ?? '').replace(/\D/g, '');
    if (!d) return '';
    return d.length >= 4 ? `XXXX XXXX ${d.slice(-4)}` : 'XXXX XXXX XXXX';
}
/** A copy of the answers with every Aadhaar field masked, and the keys masked. */
function maskData(schema, data = {}) {
    const keys = allFields(schema).filter((f) => isAadhaarField(f) && data?.[f.key] !== undefined && data[f.key] !== '').map((f) => f.key);
    if (!keys.length) return { data, masked: [] };
    const out = { ...data };
    for (const k of keys) out[k] = maskAadhaar(out[k]);
    return { data: out, masked: keys };
}

function answerRows(schema, data = {}, { includeSensitive = false, scope = {}, maskIds = true } = {}) {
    const rows = [];
    for (const sec of schema?.sections || []) {
        const fields = [];
        for (const f of sec.fields || []) {
            if (f.type === 'info' || f.type === 'file') continue;
            if (!scoped(f, scope)) continue;
            const v = data[f.key];
            if (v === undefined) continue;
            if (f.sensitive && !includeSensitive) { fields.push({ key: f.key, label: f.label, value: null, hidden: true }); continue; }
            let shown = v;
            if (CHOICE_TYPES.includes(f.type)) {
                const lab = (x) => (f.options || []).find((o) => o.value === x)?.label || x;
                shown = Array.isArray(v) ? v.map(lab).join(', ') : lab(v);
            } else if (f.type === 'checkbox' || f.type === 'declaration') shown = v ? 'Yes' : 'No';
            if (maskIds && isAadhaarField(f) && shown) { fields.push({ key: f.key, label: f.label, value: maskAadhaar(shown), sensitive: !!f.sensitive, masked: true }); continue; }
            fields.push({ key: f.key, label: f.label, value: shown, sensitive: !!f.sensitive });
        }
        if (fields.length) rows.push({ section: sec.key, title: sec.title, fields });
    }
    return rows;
}

/** The schema with sensitive fields removed — what a reviewer without access is sent. */
function withoutSensitive(schema) {
    return { sections: (schema?.sections || []).map((sec) => ({ ...sec, fields: (sec.fields || []).filter((f) => !f.sensitive) })) };
}

module.exports = {
    FIELD_TYPES, INPUT_TYPES, CHOICE_TYPES, OPS, MAP_TARGETS, ALLOWED_KINDS, ID_KINDS,
    validateSchema, validateAnswers, applicableFields, allFields, fileFields, checkValue, conditionHolds,
    migrateAnswers, mapped, summaryOf, answerRows, withoutSensitive,
    isAadhaarField, maskAadhaar, maskData, MASKED,
};
