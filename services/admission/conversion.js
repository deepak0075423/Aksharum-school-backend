'use strict';
/**
 * Confirm admission → the student and parent accounts.
 *
 * One transaction creates (or links) everything that makes the applicant a
 * student of the school: the student's account and record, the admission
 * number, the place in a section, the parent's account (an existing one is
 * linked, never duplicated), the fee assignment, and the application's own
 * "enrolled" state. Either all of it is written or none of it is: a failure
 * anywhere rolls the lot back, and files copied in for it are removed.
 *
 * Idempotent: the application row is locked first and carries the result, so
 * a second request — a double click, a retry after a timeout — waits, sees the
 * conversion done, and returns the same student rather than making another.
 *
 * What follows the commit is best-effort and recorded step by step on the
 * application (conversion.steps): fee charges due so far, the transport
 * request, the hostel application, the health record, welcome emails. A step
 * that fails says so, and can be done from its own module.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, buildInsert, lock } = require('../dbTx');
const AdmissionApplication = require('../../models/AdmissionApplication');
const User = require('../../models/User');
const StudentProfile = require('../../models/StudentProfile');
const ParentProfile = require('../../models/ParentProfile');
const ClassSection = require('../../models/ClassSection');
const School = require('../../models/School');
const Class = require('../../models/Class');
const AcademicYear = require('../../models/AcademicYear');
const FeeStructure = require('../../models/FeeStructure');
const StudentFeeAssignment = require('../../models/StudentFeeAssignment');
const identity = require('../accountIdentity');
const authCache = require('../../utils/authCache');
const admissionNo = require('../../utils/admissionNumber');
const { identityClash } = require('../../utils/identityNumbers');
const { isEmail, isPhone, normalizePhone } = require('../../utils/validators');
const { nameProblem } = require('../../utils/textRules');
const formEngine = require('./formEngine');
const documents = require('./documents');
const settingsSvc = require('./settings');
const events = require('./events');
const notify = require('./notify');
const workflow = require('./workflow');
const { refuse, isId, str } = require('./util');
const { isDocument } = require('../../utils/webImage');

const STUDENT_DOCS = path.join(__dirname, '..', '..', 'uploads', 'student-docs');
const RELATIONS = ['Father', 'Mother', 'Guardian'];

// ── Reading the application ──────────────────────────────────────────────────

/** The answers mapped to student-record fields: { 'student.name': value, … }. */
function mappedValues(schema, data) {
    const out = {};
    for (const f of formEngine.allFields(schema)) if (f.mapTo && data?.[f.key] !== undefined) out[f.mapTo] = data[f.key];
    return out;
}

const textOf = (v) => (v === undefined || v === null ? '' : String(v).trim());
// A state as the ERP spells it ("uttar pradesh" → "Uttar Pradesh"); '' when it is not one.
const { stateName } = require('../pincodes');
// A YYYY-MM-DD answer as a date, or null.
const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(textOf(v)) ? new Date(`${textOf(v)}T00:00:00Z`) : null);
const sanitizeName = (v) => textOf(v).replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

function guardianBlocks(m) {
    const block = (who) => ({
        name: textOf(m[`${who}.name`]), email: textOf(m[`${who}.email`]).toLowerCase(), phone: textOf(m[`${who}.phone`]),
        occupation: textOf(m[`${who}.occupation`]), organization: textOf(m[`${who}.organization`]),
        qualification: textOf(m[`${who}.qualification`]), annualIncome: textOf(m[`${who}.annualIncome`]),
        ...(who === 'guardian' ? { relation: textOf(m['guardian.relation']) } : {}),
    });
    return { father: block('father'), mother: block('mother'), guardian: block('guardian') };
}

/** Which guardian the parent account should be, from the form's primary contact. */
function primaryOf(m, blocks) {
    const said = textOf(m['contact.primary']);
    if (RELATIONS.includes(said) && (blocks[said.toLowerCase()].email || blocks[said.toLowerCase()].name)) return said;
    if (blocks.father.email) return 'Father';
    if (blocks.mother.email) return 'Mother';
    if (blocks.guardian.email) return 'Guardian';
    return blocks.father.name ? 'Father' : blocks.mother.name ? 'Mother' : 'Guardian';
}

// ── What enrolment reads besides the form ───────────────────────────────────

/**
 * The family's other applications on this account that are still alive. The
 * applicant's account can become the student's only when there are none:
 * turned into a student it can no longer open the admission portal, and a
 * sibling's application (or this child's for another class) would be cut off.
 */
async function otherLiveApplications(app) {
    const { rows } = await pool.query(
        `SELECT "applicationNumber", "studentName", "status" FROM "${AdmissionApplication.tableName}"
          WHERE "school" = $1 AND "applicant" = $2 AND "_id" <> $3 AND "status" NOT IN ('withdrawn', 'cancelled', 'rejected', 'ineligible', 'declined', 'enrolled')`,
        [String(app.school), String(app.applicant), String(app._id)]);
    return rows;
}

/**
 * A sign-in address for a child who has none of their own: the parent's, with
 * the child's name after a "+" (anita@gmail.com → anita+riya@gmail.com). Mail
 * to it arrives in the parent's inbox on Gmail, Outlook and most providers,
 * and it is a different address as far as signing in goes. A suggestion the
 * office accepts or types over — never used without being shown.
 */
async function suggestStudentEmail(schoolId, parentEmail, studentName) {
    const m = /^([^@+\s]+)(?:\+[^@]*)?@([^@\s]+\.[^@\s]+)$/.exec(String(parentEmail || '').trim().toLowerCase());
    if (!m) return '';
    const tag = String(studentName || '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim().split(/\s+/)[0] || 'student';
    for (const candidate of [`${m[1]}+${tag}@${m[2]}`, `${m[1]}+${tag}2@${m[2]}`, `${m[1]}+${tag}3@${m[2]}`]) {
        const link = await identity.linkTarget(candidate, { schoolId, role: 'student' }).catch(() => null);
        if (link?.mode === 'create') return candidate;
    }
    return '';
}

/** The quota the application's seat came from — its offer's pool, else its verified claim. */
async function seatQuota(app, q = null) {
    const run = q || ((sql, p) => pool.query(sql, p));
    const { rows: [offer] } = await run(`SELECT "quota" FROM "admissionoffers" WHERE "application" = $1 AND "status" = 'confirmed' ORDER BY "issuedAt" DESC LIMIT 1`, [String(app._id)]);
    const key = offer ? (offer.quota || '') : (['verified', 'allotted'].includes(app.quotaStatus) ? app.quota : '');
    if (!key) return null;
    const def = require('./quotas').quotaDef((await require('./quotas').classOf(app.round, app.class, q)).quotas, key);
    return def ? { key, name: def.name, kind: def.kind, feeRule: def.feeRule || { type: 'normal' }, free: def.kind === 'rte' || def.feeRule?.type === 'free' } : { key, name: key, kind: 'other', feeRule: { type: 'normal' }, free: false };
}

/** The head of a fee structure that charges the admission fee again, if it has one: { item, head }. */
async function admissionHead(structure) {
    const items = (structure?.items || []).filter((i) => i.isActive !== false && Number(i.amount) > 0);
    if (!items.length) return null;
    const heads = await require('../../models/FeeHead').find({ _id: { $in: items.map((i) => i.feeHead) } }).select('name type').lean();
    const byId = new Map(heads.map((h) => [String(h._id), h]));
    const item = items.find((i) => /\badmission\b/i.test(byId.get(String(i.feeHead))?.name || '') && ['one_time', 'yearly'].includes(byId.get(String(i.feeHead))?.type));
    return item ? { item, head: byId.get(String(item.feeHead)) } : null;
}

// ── Preview: what would be created, and what stands in the way ───────────────

async function preview(req, app) {
    const settings = await settingsSvc.getSettings(app.school);
    const schema = await require('./applications').schemaOf(app);
    const m = mappedValues(schema, app.data);
    const blocks = guardianBlocks(m);
    const relation = primaryOf(m, blocks);
    const primary = blocks[relation.toLowerCase()];
    const blockers = [];
    const warnings = [];
    if (app.status === 'enrolled') return { done: true, conversion: app.conversion, studentUser: app.studentUser, parentUser: app.parentUser, admissionNumber: app.admissionNumber };
    if (app.status !== 'confirmed') blockers.push('Confirm the admission first');

    const [school, cls, year, sections, applicant] = await Promise.all([
        School.findById(app.school).select('name code admissionNumberFormat modules').lean(),
        Class.findById(app.class).select('className classNumber').lean(),
        AcademicYear.findById(app.academicYear).select('yearName status startDate').lean(),
        ClassSection.find({ school: app.school, class: app.class, academicYear: app.academicYear, status: { $ne: 'archived' } }).select('sectionName maxStudents enrolledStudents').lean(),
        User.findById(app.applicant).select('name email').lean(),
    ]);
    if (!year) blockers.push('The application\'s academic year no longer exists');
    if (!sections.length) warnings.push(`No section of ${cls?.className || 'the class'} exists for ${year?.yearName || 'the year'} yet — the student will be placed in the class and given a section later`);

    // Existing parents the office may mean: same email or phone, at this school.
    const contacts = [blocks.father, blocks.mother, blocks.guardian];
    const emails = [...new Set(contacts.map((c) => c.email).filter(Boolean))];
    const phones = [...new Set(contacts.map((c) => c.phone).filter(Boolean))];
    const { rows: parents } = emails.length || phones.length ? await pool.query(
        `SELECT u."_id", u."name", u."email", u."phone",
                (SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(pp."children", '[]'::jsonb)))::int AS "childCount"
           FROM "users" u LEFT JOIN "parentprofiles" pp ON pp."user" = u."_id"
          WHERE u."school" = $1 AND u."role" = 'parent' AND (u."email" = ANY($2::text[]) OR u."phone" = ANY($3::text[]))`,
        [String(app.school), emails, phones]) : { rows: [] };

    // The applicant's own account becoming the student's: only for an address
    // that holds nothing else (a student is never linked).
    const applicantRows = applicant ? await identity.membershipsByEmail(applicant.email) : [];
    const others = await otherLiveApplications(app);
    const canUseApplicant = applicantRows.length === 1 && applicantRows[0].role === 'guest' && !others.length;

    const docsAll = await documents.currentDocs(app._id);
    const types = await documents.typesOf(app.school);
    const transfer = docsAll.filter((d) => types.get(d.docKey)?.mapsTo).map((d) => ({ docKey: d.docKey, name: types.get(d.docKey)?.name || d.docKey, mapsTo: types.get(d.docKey).mapsTo, status: d.status }));
    const unverified = transfer.filter((d) => d.status !== 'verified');
    if (unverified.length) warnings.push(`${unverified.map((d) => d.name).join(', ')} ${unverified.length === 1 ? 'is' : 'are'} not verified — only verified documents are copied to the student record`);

    const feeStructure = school?.modules?.fees ? await structureFor(app.school, app.academicYear, app.class, null) : null;
    // What the seat's quota and the admission fee already paid mean for Fees.
    const quota = await seatQuota(app);
    const paidAtAdmission = (await require('./payments').balance(app, 'admission_fee')).paid;
    const again = feeStructure && paidAtAdmission > 0 ? await admissionHead(feeStructure) : null;
    if (quota?.free && feeStructure) warnings.push(`${quota.name}: a free seat — no fee structure is assigned unless you tick it`);
    else if (quota?.feeRule?.type === 'percent') warnings.push(`${quota.name} carries a ${quota.feeRule.percent}% concession on the admission fee — give the matching concession in Fees if it applies to the school fee too`);
    if (again) warnings.push(`"${feeStructure.name}" charges ${again.head.name} (₹${Number(again.item.amount).toLocaleString('en-IN')}) — ₹${Number(paidAtAdmission).toLocaleString('en-IN')} was already received at admission and is credited to the student's fee account`);
    const studentEmailFromForm = textOf(m['student.email']).toLowerCase();
    const suggestedEmail = studentEmailFromForm ? '' : await suggestStudentEmail(app.school, primary.email || applicant?.email, textOf(m['student.name']) || app.studentName);
    const hostels = school?.modules?.hostel && m['hostel.required'] === true
        ? (await pool.query(`SELECT "_id", "name" FROM "hostels" WHERE "school" = $1 ORDER BY "name"`, [String(app.school)]).catch(() => ({ rows: [] }))).rows : [];

    return {
        done: false,
        ready: !blockers.length,
        blockers, warnings,
        student: {
            name: textOf(m['student.name']) || app.studentName, dob: textOf(m['student.dob']), gender: textOf(m['student.gender']),
            email: studentEmailFromForm, phone: textOf(m['student.phone']),
            // For a child with no address of their own: the parent's, with the child's name after a "+".
            suggestedEmail,
            canUseApplicantAccount: canUseApplicant, applicantEmail: applicant?.email || '',
            applicantBusy: others.length ? `${others.length} other application${others.length === 1 ? '' : 's'} (${others.map((o) => o.applicationNumber || o.studentName || 'a draft').join(', ')}) ${others.length === 1 ? 'is' : 'are'} still open on the applicant's account` : '',
        },
        placement: {
            academicYear: { _id: app.academicYear, yearName: year?.yearName || '' },
            class: { _id: app.class, className: cls?.className || '' },
            sections: sections.map((s) => ({ _id: s._id, sectionName: s.sectionName, capacity: s.maxStudents || 0, occupied: (s.enrolledStudents || []).length, free: s.maxStudents ? Math.max(0, s.maxStudents - (s.enrolledStudents || []).length) : null }))
                .sort((a, b) => String(a.sectionName).localeCompare(String(b.sectionName), undefined, { numeric: true })),
            // What the next number would be now — taken for real only at conversion.
            admissionNumberPreview: school ? await admissionNo.nextAdmissionNumber(school, cls).catch(() => '') : '',
        },
        parent: {
            relation, name: primary.name, email: primary.email || (applicant?.email || ''), phone: primary.phone,
            applicantEmail: applicant?.email || '',
            existing: parents.map((p) => ({ _id: p._id, name: p.name, email: p.email, phone: p.phone, childCount: p.childCount })),
            blocks,
        },
        options: {
            activation: settings.conversion.activation,
            fees: {
                available: !!school?.modules?.fees && settings.conversion.createFeeAssignment, structure: feeStructure ? { _id: feeStructure._id, name: feeStructure.name, totalAmount: feeStructure.totalAmount } : null,
                freeSeat: !!quota?.free, quota: quota ? { key: quota.key, name: quota.name, kind: quota.kind } : null,
                paidAtAdmission, admissionHead: again ? { name: again.head.name, amount: again.item.amount, credit: Math.min(paidAtAdmission, Number(again.item.amount) || 0) } : null,
            },
            transport: { available: !!school?.modules?.transport && settings.conversion.transportRequest, requested: m['transport.required'] === true, address: textOf(m['transport.address']) },
            hostel: { available: !!school?.modules?.hostel && settings.conversion.hostelRequest, requested: m['hostel.required'] === true, hostels },
            medical: { available: !!school?.modules?.medical && settings.conversion.medicalRecord, has: !!(m['medical.allergies'] || m['medical.conditions'] || m['medical.medicines'] || m['medical.doctorName'] || m['medical.dietary']) },
            documents: { available: settings.conversion.transferDocuments, list: transfer },
        },
    };
}

/** The fee structure that charges a student of this class (section first) this year. */
async function structureFor(schoolId, yearId, classId, sectionId) {
    if (sectionId) {
        const s = await FeeStructure.findOne({ school: schoolId, academicYear: yearId, level: 'section', section: sectionId, isActive: true }).lean();
        if (s) return s;
    }
    return FeeStructure.findOne({ school: schoolId, academicYear: yearId, level: 'class', class: classId, isActive: true }).lean();
}

// ── Converting ───────────────────────────────────────────────────────────────

function cleanParentInput(p = {}, fallback = {}) {
    const mode = p.mode === 'existing' ? 'existing' : 'new';
    if (mode === 'existing') {
        if (!isId(String(p.userId || ''))) refuse('Choose the parent account to link', 400, { field: 'parent' });
        return { mode, userId: String(p.userId) };
    }
    const relation = RELATIONS.includes(p.relation) ? p.relation : (fallback.relation || 'Father');
    const name = str(p.name ?? fallback.name, 100);
    const email = str(p.email ?? fallback.email, 200).toLowerCase();
    const phone = normalizePhone(str(p.phone ?? fallback.phone, 20));
    if (!name) refuse('The parent\'s name is required', 400, { field: 'parent.name' });
    const bad = nameProblem(name, 'Parent\'s name'); if (bad) refuse(bad, 400, { field: 'parent.name' });
    if (!isEmail(email)) refuse('The parent\'s sign-in email is required', 400, { field: 'parent.email' });
    if (phone && !isPhone(phone)) refuse('The parent\'s mobile must be a valid 10-digit number', 400, { field: 'parent.phone' });
    return { mode, relation, name, email, phone };
}

/**
 * Copy the verified documents that map to student-record fields into the
 * student's document folder, ahead of the transaction. Returns { fields,
 * copied } — `copied` is removed again if the transaction rolls back.
 */
async function stageDocuments(app, settings) {
    if (!settings.conversion.transferDocuments) return { fields: {}, copied: [] };
    const types = await documents.typesOf(app.school);
    const docs = await documents.currentDocs(app._id);
    await fs.promises.mkdir(STUDENT_DOCS, { recursive: true });
    const fields = {};
    const copied = [];
    for (const d of docs) {
        const t = types.get(d.docKey);
        if (!t?.mapsTo || d.status !== 'verified' || fields[t.mapsTo]) continue;
        const name = `${Date.now()}-${crypto.randomInt(0, 1e9)}${path.extname(d.file)}`;
        const target = path.join(STUDENT_DOCS, name);
        await require('./fileStore').copyToFile(d.file, target);
        copied.push(target);
        fields[t.mapsTo] = name;
    }
    return { fields, copied };
}

/**
 * A document verified after the student was enrolled (a transfer certificate
 * that came late) is copied to the student's record like the ones that were
 * there on the day — when its type maps to a student-record field that is
 * still empty.
 */
async function lateDocument(app, doc) {
    if (app.status !== 'enrolled' || !app.studentUser || doc.status !== 'verified') return null;
    const settings = await settingsSvc.getSettings(app.school);
    if (!settings.conversion.transferDocuments) return null;
    const type = (await documents.typesOf(app.school)).get(doc.docKey);
    if (!type?.mapsTo || !require('./defaultForm').STUDENT_FILE_FIELDS[type.mapsTo]) return null;
    await fs.promises.mkdir(STUDENT_DOCS, { recursive: true });
    const name = `${Date.now()}-${crypto.randomInt(0, 1e9)}${path.extname(doc.file)}`;
    const target = path.join(STUDENT_DOCS, name);
    await require('./fileStore').copyToFile(doc.file, target);
    const { rowCount } = await pool.query(
        `UPDATE "${StudentProfile.tableName}" SET "${type.mapsTo}" = $2, "updatedAt" = now() WHERE "user" = $1 AND COALESCE("${type.mapsTo}", '') = ''`,
        [String(app.studentUser), name]).catch((e) => { console.error('[admission] late document:', e.message); return { rowCount: 0 }; });
    if (!rowCount) { fs.promises.unlink(target).catch(() => {}); return null; }
    events.recordQuietly(app.school, { application: app._id, type: 'conversion', action: 'document_added', message: `${type.name} added to the student record` });
    return { field: type.mapsTo };
}

/**
 * Convert. input: { section, admissionNumber, studentAccount: 'new'|'applicant',
 * studentEmail, parent: { mode, userId | relation, name, email, phone },
 * options: { fees, transport, hostel: { hostelId }, medical } }.
 */
async function convert(req, app, input = {}) {
    if (app.status === 'enrolled' && app.conversion?.status === 'completed') return { replay: true, ...resultOf(app) };
    if (app.status !== 'confirmed') refuse('Confirm the admission before creating the student account', 409, { code: 'NOT_CONFIRMED' });
    const settings = await settingsSvc.getSettings(app.school);
    const schema = await require('./applications').schemaOf(app);
    const m = mappedValues(schema, app.data);
    const blocks = guardianBlocks(m);

    const [school, cls, year] = await Promise.all([
        School.findById(app.school).select('name code admissionNumberFormat modules').lean(),
        Class.findById(app.class).select('className classNumber').lean(),
        AcademicYear.findById(app.academicYear).select('yearName startDate endDate').lean(),
    ]);
    if (!year) refuse('The application\'s academic year no longer exists', 409);

    // Section: of this class, this year.
    let section = null;
    if (input.section) {
        if (!isId(String(input.section))) refuse('Choose a section', 400, { field: 'section' });
        section = await ClassSection.findOne({ _id: input.section, school: app.school, class: app.class, academicYear: app.academicYear }).lean();
        if (!section) refuse('That section is not part of this class and year', 400, { field: 'section' });
    }

    // Student account.
    const applicantUser = await User.findById(app.applicant).select('name email password').lean();
    const useApplicant = input.studentAccount === 'applicant';
    let studentEmail = str(input.studentEmail, 200).toLowerCase();
    if (useApplicant) {
        const rows = await identity.membershipsByEmail(applicantUser?.email);
        if (!(rows.length === 1 && rows[0].role === 'guest')) refuse('The applicant\'s account also signs in elsewhere, so it cannot become the student\'s — give the student their own email', 400, { field: 'studentEmail' });
        const others = await otherLiveApplications(app);
        if (others.length) refuse(`The applicant's account still has ${others.length === 1 ? 'another application' : `${others.length} other applications`} open (${others.map((o) => o.applicationNumber || o.studentName || 'a draft').join(', ')}) — as the student's account it could no longer open them. Give the student their own email.`, 409, { field: 'studentEmail', code: 'APPLICANT_BUSY' });
        studentEmail = applicantUser.email;
    } else {
        if (!isEmail(studentEmail)) refuse('Give the student a sign-in email of their own', 400, { field: 'studentEmail' });
        const link = await identity.linkTarget(studentEmail, { schoolId: app.school, role: 'student' });
        if (link.mode !== 'create') refuse(link.message || `${studentEmail} is already registered — a student needs an email address of their own`, 400, { field: 'studentEmail' });
    }
    const studentName = sanitizeName(m['student.name'] || app.studentName);
    if (!studentName) refuse('The application has no student name', 409);

    // Admission number: typed (must be free) or the school's next.
    const typed = str(input.admissionNumber, 40);
    if (typed) {
        const taken = await StudentProfile.findOne({ school: app.school, admissionNumber: typed }).select('_id').lean();
        if (taken) refuse(`Admission number ${typed} is already in use`, 400, { field: 'admissionNumber' });
    }

    // Aadhaar must not belong to someone else at the school.
    const aadhaar = textOf(m['student.aadhaarNumber']).replace(/\s+/g, '');
    if (aadhaar) {
        const clash = await identityClash(app.school, [{ type: 'aadhaar', value: aadhaar, label: "Student's Aadhaar number", owner: { kind: 'student', ref: null } }]);
        if (clash) refuse(clash, 409, { field: 'aadhaar' });
    }

    // Parent account.
    const relationGuess = primaryOf(m, blocks);
    const parentIn = cleanParentInput(input.parent, { relation: relationGuess, ...blocks[relationGuess.toLowerCase()], email: blocks[relationGuess.toLowerCase()].email || applicantUser?.email });
    let parentPlan;
    if (parentIn.mode === 'existing') {
        const p = await User.findOne({ _id: parentIn.userId, school: app.school, role: 'parent' }).select('name email').lean();
        if (!p) refuse('That parent account was not found at this school', 404, { field: 'parent' });
        parentPlan = { mode: 'existing', user: p };
    } else {
        const link = await identity.linkTarget(parentIn.email, { schoolId: app.school, role: 'parent' });
        if (link.mode === 'error') refuse(link.message, 400, { field: 'parent.email' });
        if (link.mode === 'reuse') parentPlan = { mode: 'existing', user: { _id: link.row._id, name: link.row.name, email: link.row.email } };
        else parentPlan = { mode: link.mode, link, input: parentIn };
        if (useApplicant && parentIn.email === studentEmail) refuse('The parent needs a different email from the student', 400, { field: 'parent.email' });
    }
    if (!useApplicant && parentPlan.mode !== 'existing' && parentIn.email === studentEmail) refuse('The parent and the student need different emails', 400, { field: 'parent.email' });

    const immediate = (input.activation || settings.conversion.activation) !== 'manual';
    const staged = await stageDocuments(app, settings);
    const studentOtp = require('../../controllers/admin.controller')._generateOTP();
    const parentOtp = require('../../controllers/admin.controller')._generateOTP();
    const [studentHash, parentHash] = await Promise.all([bcrypt.hash(studentOtp, 12), bcrypt.hash(parentOtp, 12)]);
    const after = [];

    let outcome;
    try {
        outcome = await withTransaction(async (q) => {
            const { rows: [locked] } = await q(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1 AND "school" = $2 FOR UPDATE`, [String(app._id), String(app.school)]);
            if (!locked) refuse('Application not found', 404);
            if (locked.status === 'enrolled' && locked.conversion?.status === 'completed') return { replay: true, row: locked };
            if (locked.status !== 'confirmed') refuse('The application changed — refresh and try again', 409);
            // The school's admission-number lock — the same one the Students screen takes (utils/admissionNumber).
            await lock(q, admissionNo.lockKey(app.school));
            if (typed) {
                const { rows: [takenNow] } = await q(`SELECT 1 FROM "${StudentProfile.tableName}" WHERE "school" = $1 AND "admissionNumber" = $2 LIMIT 1`, [String(app.school), typed]);
                if (takenNow) refuse(`Admission number ${typed} is already in use`, 400, { field: 'admissionNumber' });
            }
            const quota = await seatQuota(locked, q);

            if (section) {
                const { rows: [sec] } = await q(`SELECT "maxStudents", "enrolledStudents", "sectionName" FROM "${ClassSection.tableName}" WHERE "_id" = $1 FOR UPDATE`, [String(section._id)]);
                const occupied = (sec?.enrolledStudents || []).length;
                if (sec?.maxStudents && occupied >= sec.maxStudents) refuse(`Section ${sec.sectionName} is full — ${occupied} of ${sec.maxStudents} seats are taken`, 409, { field: 'section' });
            }
            const admissionNumber = typed || await admissionNo.nextAdmissionNumber(school, cls);

            // The student.
            let studentId;
            if (useApplicant) {
                const r = await q(`UPDATE "users" SET "role" = 'student', "name" = $2, "isActive" = $3 WHERE "_id" = $1 AND "role" = 'guest' RETURNING "_id"`, [String(app.applicant), studentName, immediate]);
                if (!r.rowCount) refuse('The applicant\'s account changed — refresh and try again', 409);
                studentId = String(app.applicant);
            } else {
                const { sql, params } = buildInsert(User, {
                    name: studentName, email: studentEmail, phone: isPhone(m['student.phone']) ? normalizePhone(m['student.phone']) : '',
                    password: studentHash, role: 'student', school: app.school, isFirstLogin: true, isActive: immediate, createdBy: req.userId,
                    // A document never becomes the profile picture (utils/webImage).
                    ...(staged.fields.photoFile && !isDocument(staged.fields.photoFile) ? { profileImage: `/uploads/student-docs/${staged.fields.photoFile}` } : {}),
                });
                studentId = (await q(sql, params)).rows[0]._id;
            }

            // The parent: linked, or created (sharing an existing sign-in's password).
            let parentId; let parentCreated = false; let parentLinked = false;
            if (parentPlan.mode === 'existing') {
                parentId = String(parentPlan.user._id);
            } else {
                const creds = parentPlan.mode === 'link'
                    ? identity.inheritedCredentials(parentPlan.link.donor)
                    : { password: parentHash, isFirstLogin: true };
                const { sql, params } = buildInsert(User, {
                    name: parentPlan.input.name, email: parentPlan.input.email, phone: parentPlan.input.phone || '', role: 'parent', school: app.school,
                    // Off until activation even when the address signs in elsewhere —
                    // manual activation means no portal access before the office says so.
                    ...creds, isActive: immediate, createdBy: req.userId,
                });
                parentId = (await q(sql, params)).rows[0]._id;
                parentCreated = parentPlan.mode === 'create';
                parentLinked = parentPlan.mode === 'link';
            }

            // The student record.
            const profile = {
                user: studentId, school: app.school, admissionNumber, parent: parentId,
                admissionDate: new Date(), admissionQuota: quota?.key || '', admissionQuotaName: quota?.name || '', isRteSeat: quota?.kind === 'rte',
                gender: ['Male', 'Female', 'Other'].includes(textOf(m['student.gender'])) ? textOf(m['student.gender']) : '',
                dob: /^\d{4}-\d{2}-\d{2}$/.test(textOf(m['student.dob'])) ? new Date(`${m['student.dob']}T00:00:00Z`) : (app.studentDob || null),
                bloodGroup: textOf(m['student.bloodGroup']) === 'Not known' ? '' : textOf(m['student.bloodGroup']),
                religion: textOf(m['student.religion']), category: textOf(m['student.category']),
                nationality: textOf(m['student.nationality']) || 'Indian', aadhaarNumber: aadhaar,
                address: textOf(m['address.line']), city: textOf(m['address.city']), state: stateName(textOf(m['address.state'])) || textOf(m['address.state']),
                pincode: textOf(m['address.pincode']), country: textOf(m['address.country']) || 'India',
                sameAsCurrent: m['permanent.sameAsCurrent'] === true,
                permanentAddress: m['permanent.sameAsCurrent'] === true ? textOf(m['address.line']) : textOf(m['permanent.line']),
                permanentCity: m['permanent.sameAsCurrent'] === true ? textOf(m['address.city']) : textOf(m['permanent.city']),
                permanentState: stateName(m['permanent.sameAsCurrent'] === true ? textOf(m['address.state']) : textOf(m['permanent.state'])) || (m['permanent.sameAsCurrent'] === true ? textOf(m['address.state']) : textOf(m['permanent.state'])),
                permanentPincode: m['permanent.sameAsCurrent'] === true ? textOf(m['address.pincode']) : textOf(m['permanent.pincode']),
                emergencyContactName: textOf(m['emergency.name']), emergencyContactPhone: isPhone(m['emergency.phone']) ? normalizePhone(m['emergency.phone']) : '',
                emergencyContactRelation: textOf(m['emergency.relation']),
                isTransferStudent: textOf(m['previous.attended']) === 'Yes',
                previousSchoolName: textOf(m['previous.name']), previousSchoolBoard: textOf(m['previous.board']), previousClass: textOf(m['previous.class']),
                previousAcademicYear: textOf(m['previous.year']), previousSchoolCity: textOf(m['previous.city']), tcNumber: textOf(m['previous.tcNumber']),
                previousSchoolState: stateName(textOf(m['previous.state'])), previousSchoolPincode: /^[1-9]\d{5}$/.test(textOf(m['previous.pincode'])) ? textOf(m['previous.pincode']) : '',
                previousSchoolMedium: textOf(m['previous.medium']), previousSchoolUdise: /^\d{11}$/.test(textOf(m['previous.udise'])) ? textOf(m['previous.udise']) : '',
                tcDate: dayOf(m['previous.tcDate']), previousSchoolLeavingDate: dayOf(m['previous.leavingDate']),
                penNumber: /^\d{11}$/.test(textOf(m['student.pen'])) ? textOf(m['student.pen']) : '',
                apaarId: /^\d{12}$/.test(textOf(m['student.apaar'])) ? textOf(m['student.apaar']) : '',
                ...staged.fields,
            };
            const sp = buildInsert(StudentProfile, profile);
            await q(sp.sql, sp.params);

            // The parent record: created with the family's details, or — when it
            // exists — given the child, and only the blocks it did not have.
            const { rows: [pp] } = await q(`SELECT * FROM "${ParentProfile.tableName}" WHERE "user" = $1 LIMIT 1 FOR UPDATE`, [String(parentId)]);
            const relation = parentPlan.mode === 'existing' ? null : parentPlan.input.relation;
            if (!pp) {
                const ins = buildInsert(ParentProfile, {
                    user: parentId, school: app.school, children: [studentId], relationship: relation || 'Father',
                    father: blocks.father, mother: blocks.mother, guardian: blocks.guardian,
                    fatherOccupation: blocks.father.occupation, motherOccupation: blocks.mother.occupation, guardianOccupation: blocks.guardian.occupation,
                });
                await q(ins.sql, ins.params);
            } else {
                const fill = (have, given) => (have?.name || have?.phone ? have : given);
                await q(
                    `UPDATE "${ParentProfile.tableName}" SET
                        "children" = (CASE WHEN jsonb_typeof("children") = 'array' THEN "children" ELSE '[]'::jsonb END) || to_jsonb($2::text),
                        "father" = $3::jsonb, "mother" = $4::jsonb, "guardian" = $5::jsonb
                      WHERE "_id" = $1 AND NOT (COALESCE("children", '[]'::jsonb) @> to_jsonb($2::text))`,
                    [pp._id, String(studentId), JSON.stringify(fill(pp.father, blocks.father)), JSON.stringify(fill(pp.mother, blocks.mother)), JSON.stringify(fill(pp.guardian, blocks.guardian))]);
            }

            // Their placement for the admission's year — the class (and section,
            // when one was given): the row, the roster and the record's pointer,
            // in this same transaction, through the one placement writer.
            await require('../enrollment').place({
                studentId, schoolId: app.school, classId: app.class, sectionId: section?._id || null,
                rollNumber: '', source: 'admission', actorId: req.userId || null,
            }, q);

            // Fees: the structure that charges this student, from this month.
            // A free seat (RTE, or a quota the school made free) is not put on the
            // class's fee structure unless the office asks for it outright — it
            // used to be charged like any other.
            let feeAssignment = null;
            const freeSeat = !!quota?.free && input.options?.fees !== true;
            if (!freeSeat && input.options?.fees !== false && settings.conversion.createFeeAssignment && school?.modules?.fees) {
                const structure = await structureFor(app.school, app.academicYear, app.class, section?._id);
                if (structure) {
                    const Sched = require('../feeSchedule');
                    const bounds = Sched.yearBounds(year);
                    let fromMonth = Sched.monthKey(new Date());
                    if (fromMonth < bounds.first) fromMonth = bounds.first;
                    if (fromMonth > bounds.last) fromMonth = bounds.last;
                    const fa = buildInsert(StudentFeeAssignment, {
                        school: app.school, student: studentId, academicYear: app.academicYear, feeStructure: structure._id,
                        fromMonth, totalAmount: structure.totalAmount, createdBy: req.userId, remarks: `From admission ${locked.applicationNumber}`,
                    });
                    await q(fa.sql, fa.params);
                    feeAssignment = { structure, fromMonth };
                }
            }

            const conversion = {
                status: 'completed', at: new Date(), by: String(req.userId), byName: req.user?.name || '',
                studentEmail, parentEmail: parentPlan.mode === 'existing' ? parentPlan.user.email : parentPlan.input.email,
                parentMode: parentPlan.mode === 'existing' ? 'linked_existing' : parentLinked ? 'linked_sign_in' : 'created',
                studentAccount: useApplicant ? 'applicant' : 'new', activation: immediate ? 'immediate' : 'manual',
                section: section ? { _id: String(section._id), name: section.sectionName } : null,
                feeStructure: feeAssignment ? { _id: String(feeAssignment.structure._id), name: feeAssignment.structure.name, fromMonth: feeAssignment.fromMonth } : null,
                documents: Object.keys(staged.fields), steps: {},
                quota: quota ? { key: quota.key, name: quota.name, kind: quota.kind, free: quota.free } : null,
                feesSkipped: freeSeat ? `${quota.name}: a free seat — no fee structure assigned` : '',
            };
            const row = await require('./applications').move(req, locked, 'enrolled', {
                system: true, q, after, quiet: true,
                set: { studentUser: studentId, parentUser: parentId, admissionNumber, conversion },
            });
            await events.record(app.school, {
                application: app._id, by: req, type: 'conversion', action: 'enrolled',
                message: `Enrolled as a student — admission number ${admissionNumber}`, visibility: 'applicant',
                meta: { studentUser: String(studentId), parentUser: String(parentId), parentMode: conversion.parentMode },
            }, q);
            return { row, studentId: String(studentId), parentId: String(parentId), admissionNumber, parentCreated, parentLinked, feeAssignment, immediate };
        });
    } catch (e) {
        for (const f of staged.copied) fs.promises.unlink(f).catch(() => {});
        if (e.code === '23505' || e.code === 11000) {
            // Say what actually clashed — it used to be "one of these emails" whatever it was.
            const what = `${e.constraint || ''} ${e.detail || ''} ${e.message || ''}`;
            if (/email/i.test(what)) refuse('Another account already uses one of these emails — refresh and check the details', 409);
            if (/admission/i.test(what)) refuse('That admission number has just been given to another student — try again', 409, { field: 'admissionNumber' });
            if (/aadhaar/i.test(what)) refuse('Another student at the school already has this Aadhaar number', 409, { field: 'aadhaar' });
            refuse('A record with the same details already exists — refresh and check the student, the parent and the section', 409);
        }
        throw e;
    }
    if (outcome.replay) {
        for (const f of staged.copied) fs.promises.unlink(f).catch(() => {});
        return { replay: true, ...resultOf(outcome.row) };
    }
    for (const fn of after) await fn();
    await authCache.invalidateMany([outcome.studentId, outcome.parentId]).catch(() => {});

    // ── After the commit: each step on its own, each recorded ────────────────
    const steps = {};
    const run = async (name, fn) => {
        try { steps[name] = { ok: true, ...(await fn() || {}) }; } catch (e) { steps[name] = { ok: false, error: e.message }; console.error(`[admission conversion] ${name}:`, e.message); }
    };
    if (outcome.feeAssignment?.structure?.periodicSince) {
        await run('fees', async () => {
            const r = await require('../feeCharging').postDueCharges({ schoolId: app.school, structure: outcome.feeAssignment.structure, studentIds: [outcome.studentId], userId: req.userId });
            return { charged: r.amount, entries: r.entries };
        });
    } else if (outcome.feeAssignment) steps.fees = { ok: true, charged: 0, note: 'The structure charges when its demand is generated' };
    else if (outcome.row.conversion?.feesSkipped) steps.fees = { ok: true, charged: 0, note: outcome.row.conversion.feesSkipped };
    // The admission fee taken at admission, where the structure charges it again:
    // credited to the student's fee account, so it is not asked for twice.
    if (outcome.feeAssignment && input.options?.creditAdmissionFee !== false) {
        const again = await admissionHead(outcome.feeAssignment.structure).catch(() => null);
        const paid = again ? (await require('./payments').balance(outcome.row, 'admission_fee')).paid : 0;
        const credit = again ? Math.round(Math.min(paid, Number(again.item.amount) || 0) * 100) / 100 : 0;
        if (credit > 0) {
            await run('admissionFee', async () => {
                const { rows: receipts } = await pool.query(`SELECT "receiptNumber" FROM "admissionpayments" WHERE "application" = $1 AND "kind" = 'admission_fee' AND "status" = 'paid' ORDER BY "paidAt"`, [String(app._id)]);
                await require('../feeConcessions').appendLedger({
                    school: app.school, student: outcome.studentId, academicYear: app.academicYear,
                    entryType: 'credit', category: 'adjustment', amount: credit,
                    description: `${again.head.name} received at admission — ${receipts.map((r) => r.receiptNumber).filter(Boolean).join(', ') || outcome.row.applicationNumber}`,
                    referenceType: 'Manual', referenceId: app._id, feeItemId: again.item._id, feeHeadName: again.head.name || '', createdBy: req.userId,
                });
                return { credited: credit, head: again.head.name };
            });
        }
    }
    if (school?.modules?.transport && settings.conversion.transportRequest && input.options?.transport !== false && m['transport.required'] === true) {
        await run('transport', async () => {
            const TransportRequest = require('../../models/TransportRequest');
            const r = await numbered(TransportRequest, app.school, 'TRQ', (code) => TransportRequest.create({
                school: app.school, requestCode: code, requestedBy: outcome.parentId, student: outcome.studentId, requestType: 'new_transport',
                details: { address: textOf(m['transport.address']).slice(0, 300), reason: `Asked for on admission application ${outcome.row.applicationNumber}` },
                priority: 'normal', status: 'pending',
            }));
            return { request: r.requestCode };
        });
    }
    if (school?.modules?.hostel && settings.conversion.hostelRequest && m['hostel.required'] === true && isId(String(input.options?.hostel?.hostelId || ''))) {
        await run('hostel', async () => {
            const HostelAdmission = require('../../models/HostelAdmission');
            const hostel = await require('../../models/Hostel').findOne({ _id: input.options.hostel.hostelId, school: app.school }).select('name').lean();
            if (!hostel) throw new Error('Hostel not found');
            const primary = blocks[(parentPlan.input?.relation || 'Father').toLowerCase()] || {};
            const r = await numbered(HostelAdmission, app.school, 'HA', (code) => HostelAdmission.create({
                school: app.school, applicationNumber: code, student: outcome.studentId, academicYear: app.academicYear, hostel: hostel._id,
                reason: `From admission application ${outcome.row.applicationNumber}`, guardianName: primary.name || '', guardianPhone: primary.phone || '',
                specialRequirements: textOf(m['hostel.notes']).slice(0, 500), status: 'applied', appliedBy: req.userId, appliedAt: new Date(),
            }));
            return { application: r.applicationNumber, hostel: hostel.name };
        });
    }
    if (school?.modules?.medical && settings.conversion.medicalRecord && input.options?.medical !== false) {
        const health = healthFrom(m);
        if (health) {
            await run('medical', async () => {
                const intake = require('../medicalIntake');
                const checked = intake.check(health);
                if (!checked) return { note: 'Nothing to record' };
                const r = await intake.fromAdmission({ schoolId: app.school, userId: req.userId, userRole: req.userRole, user: req.user }, outcome.studentId, checked);
                return { allergies: r?.allergies || 0, conditions: r?.conditions || 0, profile: !!r?.profile };
            });
        }
    }
    if (outcome.immediate && settings.conversion.sendCredentials) {
        await run('emails', async () => {
            // Waited for: "emailed" is said only of an email the mail server took
            // (it used to be recorded as sent the moment it was handed over).
            const admin = require('../../controllers/admin.controller');
            const failed = [];
            let student = false; let parent = outcome.parentLinked ? 'added-to-school' : 'existing';
            if (!useApplicant) {
                student = !!(await admin._sendWelcomeEmail(studentEmail, studentName, studentEmail, studentOtp, school.name, app.school));
                if (!student) failed.push(`student (${studentEmail})`);
            }
            if (outcome.parentCreated) {
                const ok = !!(await admin._sendWelcomeEmail(parentPlan.input.email, parentPlan.input.name, parentPlan.input.email, parentOtp, school.name, app.school));
                parent = ok ? 'credentials' : 'not-sent';
                if (!ok) failed.push(`parent (${parentPlan.input.email})`);
            } else if (outcome.parentLinked) require('../../utils/schoolMailer').sendSchoolAddedEmail(parentPlan.input.email, parentPlan.input.name, 'parent', school.name, app.school);
            if (failed.length) {
                events.recordQuietly(app.school, { application: app._id, by: req, type: 'conversion', action: 'email_failed', message: `Sign-in details could not be emailed to the ${failed.join(' and the ')} — reset the password from the Students screen and hand it over` });
                return { student, parent, failed, note: `Not emailed: ${failed.join(', ')}` };
            }
            return { student, parent };
        });
    }
    const stored = { ...outcome.row.conversion, steps };
    const final = await patch(AdmissionApplication, app._id, { conversion: stored }, { touch: false });
    notify.toApplicant(final, 'enrollment_complete', {
        admission_number: outcome.admissionNumber, student_login_email: studentEmail,
        parent_login_email: stored.parentEmail, sign_in_note: signInNote(stored),
    });
    return { replay: false, ...resultOf(final) };
}

/** Transport and hostel number their requests "TRQ-YYMM-####"; the same counter style, read from their own rows. */
async function nextNumberFor(Model, schoolId, prefix) {
    const d = new Date();
    const stem = `${prefix}-${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}-`;
    const field = Model.modelName === 'HostelAdmission' ? 'applicationNumber' : 'requestCode';
    const { rows } = await pool.query(`SELECT "${field}" AS v FROM "${Model.tableName}" WHERE "school" = $1 AND "${field}" LIKE $2 ORDER BY "${field}" DESC LIMIT 1`, [String(schoolId), `${stem}%`]);
    const last = rows[0] ? Number(String(rows[0].v).slice(stem.length)) || 0 : 0;
    return `${stem}${String(last + 1).padStart(4, '0')}`;
}

/**
 * Take the next code and write the row that carries it as one step per school:
 * the code is read from the rows already there, so two enrolments finishing
 * together used to be able to read the same "last" and write the same code.
 */
function numbered(Model, schoolId, prefix, create) {
    return withTransaction(async (q) => {
        await lock(q, `admission-code:${prefix}:${schoolId}`);
        return create(await nextNumberFor(Model, schoolId, prefix));
    });
}

/** The form's health answers in the Medical Room's intake shape. */
function healthFrom(m) {
    const split = (t) => textOf(t).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
    const allergies = split(m['medical.allergies']).map((a) => ({ allergen: a.slice(0, 120), category: 'other', severity: /severe|anaphyla/i.test(a) ? 'severe' : 'moderate' }));
    const conditions = split(m['medical.conditions']).map((c) => ({ condition: c.slice(0, 120), type: 'other', severity: 'mild' }));
    const h = {
        allergies, conditions, medicines: textOf(m['medical.medicines']).slice(0, 600),
        doctor: { name: textOf(m['medical.doctorName']).slice(0, 120), phone: textOf(m['medical.doctorPhone']) },
        dietary: textOf(m['medical.dietary']).slice(0, 600), notes: '',
    };
    return (allergies.length || conditions.length || h.medicines || h.doctor.name || h.dietary) ? h : null;
}

function resultOf(row) {
    return {
        application: row._id, status: row.status, admissionNumber: row.admissionNumber,
        studentUser: row.studentUser, parentUser: row.parentUser, conversion: row.conversion,
    };
}

/**
 * What the family is told about signing in, from what the conversion recorded:
 * "emailed" only for an account whose details were actually sent, never
 * because the school's settings would normally send them.
 */
function signInNote(conv) {
    if (conv?.status !== 'completed') return '';
    if (conv.activation === 'manual' && !conv.activatedAt) return 'The school will switch the accounts on and tell you how to sign in.';
    const sent = conv.steps?.emails?.ok ? conv.steps.emails : {};
    const emailed = conv.activation === 'manual'
        ? (conv.activationEmailed || [])
        : [sent.student && 'student', sent.parent === 'credentials' && 'parent'].filter(Boolean);
    const kept = [conv.studentAccount === 'applicant' && 'student', conv.parentMode && conv.parentMode !== 'created' && 'parent'].filter((r) => r && !emailed.includes(r));
    const waiting = ['student', 'parent'].filter((r) => !emailed.includes(r) && !kept.includes(r));
    const who = (list) => (list.length === 2 ? 'student and parent' : list[0]);
    const lines = [];
    if (emailed.length) lines.push(`Sign-in details for the ${who(emailed)} account${emailed.length > 1 ? 's' : ''} have been emailed.`);
    if (kept.includes('student')) lines.push('The student signs in with the email and password used for this application.');
    if (kept.includes('parent')) lines.push('The parent signs in with the password already used for that email.');
    if (waiting.length) lines.push(`The school will give you the ${who(waiting)} sign-in details.`);
    return lines.join(' ');
}

/** Open accounts created inactive ("manual" activation) and send their sign-in details. */
async function activate(req, app) {
    if (app.status !== 'enrolled' || !app.studentUser) refuse('Create the student account first', 409);
    if (app.conversion?.activation !== 'manual' || app.conversion?.activatedAt) refuse('These accounts are already active', 409);
    // Claimed before anything is sent: a second click finds the activation
    // already under way (two clicks used to send two different passwords).
    const { rowCount: claimed } = await pool.query(
        `UPDATE "${AdmissionApplication.tableName}" SET "conversion" = jsonb_set("conversion", '{activatedAt}', to_jsonb(now()::text))
          WHERE "_id" = $1 AND "status" = 'enrolled' AND ("conversion"->>'activatedAt') IS NULL`, [String(app._id)]);
    if (!claimed) refuse('These accounts are already active', 409);
    const school = await School.findById(app.school).select('name').lean();
    const admin = require('../../controllers/admin.controller');
    const sent = [];
    const emailed = [];
    for (const [id, label] of [[app.studentUser, 'student'], [app.parentUser, 'parent']]) {
        if (!id) continue;
        const u = await User.findById(id).select('name email isActive isFirstLogin role').lean();
        if (!u) continue;
        const rows = await identity.membershipsByEmail(u.email);
        const shared = rows.length > 1;
        if (!shared && u.isFirstLogin) {
            const otp = admin._generateOTP();
            await pool.query(`UPDATE "users" SET "password" = $2, "isActive" = true WHERE "_id" = $1`, [String(id), await bcrypt.hash(otp, 12)]);
            if (await admin._sendWelcomeEmail(u.email, u.name, u.email, otp, school.name, app.school)) {
                sent.push(`${label}: sign-in details sent to ${u.email}`);
                emailed.push(label);
            } else sent.push(`${label}: switched on, but the email to ${u.email} could not be sent — reset the password from the Students screen`);
        } else {
            await pool.query(`UPDATE "users" SET "isActive" = true WHERE "_id" = $1`, [String(id)]);
            sent.push(`${label}: switched on (keeps the password already used with ${u.email})`);
        }
        await authCache.invalidate(String(id)).catch(() => {});
    }
    const row = await patch(AdmissionApplication, app._id, { conversion: { ...app.conversion, activatedAt: new Date(), activatedBy: String(req.userId), activationEmailed: emailed } }, { touch: false });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'conversion', action: 'activated', message: `Accounts activated — ${sent.join('; ')}` });
    return { application: row, sent };
}

module.exports = { preview, convert, activate, signInNote, mappedValues, guardianBlocks, primaryOf, structureFor, healthFrom, suggestStudentEmail, seatQuota, admissionHead, lateDocument };
