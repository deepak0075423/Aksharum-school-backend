'use strict';
/**
 * The parents' yearly consent (Oct 2026) — see models/MedicalConsent.
 *
 *   give        a parent (in the app, typing their name) or the medical staff
 *               (from a signed paper form) record what is allowed this year
 *   withdraw    a parent takes it back; the staff are told
 *   request     the school asks the parents who have not answered
 *   doseCheck   before an everyday medicine from the school's stock (not one
 *               on a medication plan, which has its own authorisation): is its
 *               category allowed this year? With the school's `consentRequired`
 *               on, no consent stops the dose unless a reason is given; off,
 *               it is a warning on the give screen.
 *   teacherShare whether a parent let the school share more than the
 *               critical alerts with teachers
 */
const pool = require('../db/pool');
const { patch, insert } = require('../db/patch');
const MedicalConsent = require('../models/MedicalConsent');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, bool, isUuid } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

// Medicine categories a consent never covers: a prescription has its own
// plan and authorisation, and an emergency medicine is given to save a life.
const NOT_OTC = new Set(['Prescribed medicine', 'Emergency (Adrenaline)', 'Other']);
const otcCategories = (settings) => (settings.medicineCategories || []).filter((c) => !NOT_OTC.has(c));

/** The school year consent is given for: the active one, else the one today falls in. */
async function currentYear(schoolId) {
    const [y] = await run(
        `SELECT "_id"::text AS "_id", "yearName" FROM "academicyears" WHERE "school" = $1
          ORDER BY ("status" = 'active') DESC, (now() BETWEEN "startDate" AND "endDate") DESC, "startDate" DESC LIMIT 1`,
        [S(schoolId)],
    );
    return y || null;
}

async function forStudent(schoolId, studentId, year = undefined) {
    const y = year === undefined ? await currentYear(schoolId) : year;
    const [row] = await run(
        `SELECT *, "_id"::text AS "_id" FROM "medicalconsents" WHERE "school" = $1 AND "student" = $2 AND "academicYear" IS NOT DISTINCT FROM $3::uuid`,
        [S(schoolId), S(studentId), y?._id || null],
    );
    return row || null;
}

/** What is written down: the consent rows as people read them. */
function summaryOf(c, settings) {
    const parts = [];
    parts.push(c.emergencyTreatment ? 'emergency treatment: yes' : 'emergency treatment: no');
    parts.push(c.otc?.length ? `medicines: ${c.otc.join(', ')}` : 'medicines: none');
    if (!c.shareWithTeachers) parts.push('teachers: critical alerts only');
    if (c.injuryPhotos) parts.push('injury photos: yes');
    if (c.selfCarry) parts.push('may carry own rescue medicine');
    return parts.join(' · ');
}

/**
 * Record consent for this year. body: { emergencyTreatment, otc: [categories],
 * shareWithTeachers, injuryPhotos, selfCarry, note, signedName, onPaper }.
 */
async function give(req, studentId, body = {}) {
    const isParent = req.userRole === 'parent';
    if (isParent) await access.familyChild(req, S(studentId));
    const student = await access.assertStudent(req.schoolId, studentId);
    const settings = await settingsSvc.get(req.schoolId);
    const allowed = new Set(otcCategories(settings));
    const otc = Array.isArray(body.otc) ? [...new Set(body.otc.map((x) => str(x, 80)))].filter((x) => allowed.has(x)) : [];
    const signedName = str(body.signedName, 120);
    if (isParent && signedName.length < 3) refuse('Type your full name to sign');
    const onPaper = !isParent && bool(body.onPaper);
    if (!isParent && !onPaper) refuse('The medical staff record consent from a signed paper form');
    if (onPaper && !signedName) refuse('Give the name of the parent who signed the form');
    const year = await currentYear(req.schoolId);
    const fields = {
        emergencyTreatment: bool(body.emergencyTreatment), otc, shareWithTeachers: body.shareWithTeachers === undefined ? true : bool(body.shareWithTeachers),
        injuryPhotos: bool(body.injuryPhotos), selfCarry: bool(body.selfCarry), note: str(body.note, 500),
        status: 'given', signedName, givenBy: req.userId, givenByName: who(req), givenAt: new Date(), onPaper, withdrawnAt: null, withdrawReason: '',
    };
    const entry = { at: new Date(), byName: who(req), status: 'given', summary: `${onPaper ? 'Paper form recorded' : 'Given in the app'} — ${summaryOf(fields, settings)}` };
    const prev = await forStudent(req.schoolId, student._id, year);
    const row = prev
        ? await patch(MedicalConsent, prev._id, fields, { push: { history: entry }, where: { school: req.schoolId } })
        : await insert(MedicalConsent, { school: req.schoolId, student: student._id, academicYear: year?._id || null, yearName: year?.yearName || '', ...fields, history: [entry] });
    audit.log(req, { action: prev?.status === 'given' ? 'consent_changed' : 'consent_given', entity: 'consent', entityId: row._id, student: student._id, summary: `${student.name}${year ? ` (${year.yearName})` : ''}: ${entry.summary}` });
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function withdraw(req, id, body = {}) {
    if (!isUuid(id)) notFound('Consent');
    const c = await MedicalConsent.findOne({ _id: id, school: req.schoolId }).lean();
    if (!c) notFound('Consent');
    if (req.userRole === 'parent') await access.familyChild(req, S(c.student));
    if (c.status !== 'given') refuse('There is no consent to withdraw');
    const reason = str(body.reason, 300);
    const row = await patch(MedicalConsent, id, {
        status: 'withdrawn', withdrawnAt: new Date(), withdrawReason: reason, emergencyTreatment: false, otc: [], injuryPhotos: false, selfCarry: false,
    }, { push: { history: { at: new Date(), byName: who(req), status: 'withdrawn', summary: `Withdrawn${reason ? ` — ${reason}` : ''}` } }, where: { school: req.schoolId } });
    audit.log(req, { action: 'consent_withdrawn', entity: 'consent', entityId: id, student: c.student, summary: `Consent withdrawn${reason ? ` — ${reason}` : ''}` });
    const card = await access.studentCard(req.schoolId, c.student);
    tell.toStaff(req, { title: `Consent withdrawn — ${card?.name || 'a student'}`, body: `${who(req)} withdrew the medical consent for this year${reason ? `: ${reason}` : ''}. No everyday medicine from the school's stock without asking first.`, urgent: true });
    return row;
}

/** Ask the parents who have not answered this year (once a week at most per child). */
async function request(req, { classId = null, sectionId = null } = {}) {
    const year = await currentYear(req.schoolId);
    const p = [S(req.schoolId), year?._id || null];
    let where = '';
    if (isUuid(sectionId)) { p.push(S(sectionId)); where = ` AND sp."currentSection" = $${p.length}`; }
    else if (isUuid(classId)) { p.push(S(classId)); where = ` AND sp."currentClass" = $${p.length}`; }
    const rows = await run(
        `SELECT u."_id"::text AS "_id", u."name", c."_id"::text AS "consent", c."status", c."requestedAt"
           FROM "users" u JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "medicalconsents" c ON c."student" = u."_id" AND c."school" = $1 AND c."academicYear" IS NOT DISTINCT FROM $2::uuid
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE${where}
            AND (c."_id" IS NULL OR c."status" <> 'given')
            AND (c."requestedAt" IS NULL OR c."requestedAt" < now() - interval '7 days')`,
        p,
    );
    for (const r of rows) {
        const entry = { at: new Date(), byName: who(req), status: 'requested', summary: 'The school asked for consent' };
        if (r.consent) await patch(MedicalConsent, r.consent, { requestedAt: new Date(), status: r.status === 'withdrawn' ? 'withdrawn' : 'requested' }, { push: { history: entry } });
        else await insert(MedicalConsent, { school: req.schoolId, student: r._id, academicYear: year?._id || null, yearName: year?.yearName || '', status: 'requested', requestedAt: new Date(), history: [entry] });
        tell.toParents(req, r._id, {
            title: `Medical consent for ${year?.yearName || 'this year'} — ${r.name}`,
            body: `Please tell the school's Medical Room what it may do for ${r.name} this year: emergency treatment, everyday medicines like paracetamol, and more. It takes a minute in the app.`,
            tab: 'overview',
            i18n: { key: 'consent_request', vars: { name: r.name, year: year?.yearName } },
        });
    }
    audit.log(req, { action: 'consent_requested', entity: 'consent', summary: `Asked the parents of ${rows.length} student${rows.length === 1 ? '' : 's'} for this year's medical consent` });
    return { asked: rows.length };
}

/**
 * Before an everyday medicine from the stock: { code, message, block } or null.
 * A plan dose, a family's own medicine and an emergency medicine are not checked here.
 */
async function doseCheck(schoolId, studentId, item, settings) {
    if (!item?.category || NOT_OTC.has(item.category)) return null;
    const c = await forStudent(schoolId, studentId);
    const block = settings?.consentRequired === true;
    if (!c || c.status !== 'given') {
        return { code: 'consent', block, message: c?.status === 'withdrawn' ? 'The parents withdrew their medical consent this year' : 'No medical consent from the parents this year' };
    }
    if (!(c.otc || []).includes(item.category)) {
        return { code: 'consent', block, message: `The parents have not agreed to ${item.category.toLowerCase()} medicines this year` };
    }
    return null;
}

/** Students whose parents asked that teachers see only the critical alerts. */
async function teacherLimited(schoolId, studentIds) {
    const ids = [...new Set((studentIds || []).map(S).filter(isUuid))];
    if (!ids.length) return new Set();
    const year = await currentYear(schoolId);
    const rows = await run(
        `SELECT "student"::text AS s FROM "medicalconsents" WHERE "school" = $1 AND "student" = ANY($2::uuid[])
            AND "academicYear" IS NOT DISTINCT FROM $3::uuid AND "status" = 'given' AND "shareWithTeachers" = false`,
        [S(schoolId), ids, year?._id || null],
    );
    return new Set(rows.map((r) => r.s));
}

module.exports = { NOT_OTC, otcCategories, currentYear, forStudent, summaryOf, give, withdraw, request, doseCheck, teacherLimited };
