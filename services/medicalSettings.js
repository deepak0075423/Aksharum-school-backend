'use strict';
/**
 * A school's Medical Room settings — read with every default filled in, so a
 * school that never opened the Settings screen still has sensible lists,
 * rules and notifications (Oct 2026).
 *
 * Kept in memory for half a minute per school: every notification asks who
 * should be told, and a whole visit can ask several times. A save drops the
 * cached copy at once; another server picks the change up within the TTL.
 */
const MedicalSettings = require('../models/MedicalSettings');
const { refuse, str, num, bool } = require('./medicalRules');

const LISTS = {
    visitReasons: [
        'Fever', 'Headache', 'Stomach ache', 'Injury', 'Nausea / vomiting', 'Cough & cold', 'Dizziness',
        'Breathing difficulty', 'Allergic reaction', 'Toothache', 'Eye irritation', 'Menstrual pain', 'Fatigue', 'Other',
    ],
    locations: [
        'Classroom', 'Playground', 'Sports ground', 'Corridor', 'Staircase', 'Laboratory', 'Library', 'Canteen',
        'School bus', 'Assembly area', 'Washroom', 'Auditorium', 'Other',
    ],
    medicineCategories: [
        'Pain relief / Fever', 'Antihistamine', 'Antacid / Digestive', 'Oral rehydration', 'Inhaler / Respiratory',
        'Antiseptic', 'Ointment / Cream', 'Eye / Ear drops', 'Emergency (Adrenaline)', 'Prescribed medicine',
        'Vitamin / Supplement', 'Other',
    ],
    supplyCategories: [
        'Bandage', 'Gauze', 'Cotton', 'Antiseptic', 'Ice pack', 'Dressing', 'Gloves', 'Plaster / Tape', 'Splint',
        'First-aid kit', 'Mask', 'Other',
    ],
    vaccines: [
        'BCG', 'Hepatitis B', 'OPV / IPV (Polio)', 'DTaP / DPT', 'Hib', 'MMR', 'Typhoid', 'Varicella (Chickenpox)',
        'Hepatitis A', 'Tdap', 'HPV', 'Influenza', 'COVID-19', 'Td booster',
    ],
};

// Who is told about what. Each is a switch on the Settings screen.
const NOTIFY_DEFAULTS = {
    // parents
    parentVisit: true,           // child visited the Medical Room (sent when the visit ends)
    parentIncident: true,        // a medical incident (when the medical room confirms it)
    parentFirstAid: true,
    parentMedicine: true,        // a medicine was given
    parentSentHome: true,
    parentReferral: true,
    parentCheckup: true,
    parentVaccinationDue: true,
    parentFollowUp: true,
    parentCampaign: true,        // the result of a health campaign: given, refused, absent
    // students
    studentReminders: true,      // their medicine time; a limit on what they may do
    // teachers
    teacherStatus: true,         // request accepted, returned to class, sent home
    teacherClassAlert: true,     // their student was sent to / arrived at the room
    teacherNeedToKnow: true,     // a child's emergency card changed; who to watch today (cover, exams, bus, hostel, mess)
    // medical staff
    staffRequests: true,         // a teacher sent a student, or a student checked in at the kiosk
    staffMedicineRound: true,    // doses due now, and doses not recorded in time
    staffRecheck: true,          // a child in the room is due a recheck
    staffEmergency: true,
    staffLowStock: true,
    staffExpiry: true,
    staffFollowUp: true,
    staffVaccinationDue: true,
    staffParentUpdates: true,    // a parent sent an update for approval
    staffMaintenance: true,
    // channels (the school sends no text messages — live app notifications and email)
    emailUrgent: true,           // email parents for an emergency, sent home or a referral
};

const DEFAULTS = {
    roomName: 'Medical Room', roomLocation: '', roomPhone: '', roomHours: '', hasBeds: true, temperatureUnit: 'F',
    ...LISTS,
    incidentTypes: [],
    teacherAlerts: true, teacherEmergencyInfo: true,
    // Any member of staff may open a child's emergency card in an emergency, giving a reason —
    // audited, and the medical staff are told at once.
    breakGlass: true,
    // An everyday medicine from the stock without this year's parental consent: stopped (true) or a warning (false).
    consentRequired: false,
    // The designated safeguarding leads (user ids). None named: the school admins.
    safeguardingLeads: [],
    // The medical staff confirm who they are with an emailed code, every 12 hours.
    requireStepUp: false,
    // Opening this many students' records within an hour tells the school admins.
    accessAlertThreshold: 30,
    // Years a former student's medical record is kept before it may be purged (never by itself).
    retentionYears: 8,
    studentAccess: true, studentVisits: true, studentCheckups: true, studentVaccinations: true, studentDocuments: true,
    parentUpdates: true, parentUpdatesNeedApproval: true,
    expiryAlertDays: 60, vaccinationDueDays: 30, maintenanceDueDays: 14, documentExpiryDays: 30, missedDoseAfterMinutes: 120,
    // Nobody has answered an urgent notice in this many minutes: the next contact is tried.
    urgentEscalateMinutes: 10,
    // Changes to the return-to-school rules: { fever: { hours: 24, needsCertificate: false, off: false } … }.
    exclusionRules: {},
    // The school's vaccination schedule (services/medicalSchedule): off until a template is chosen.
    vaccineSchedule: {},
    // The outbreak watch, and the school's changes to what it looks for (services/medicalOutbreak).
    outbreakWatch: true,
    outbreakRules: {},
    // A child sent home who was marked present that day: left as it is ('off'), or Half-Day (services/medicalAttendance).
    attendanceOnSentHome: 'off',
    // The language families are written to when a parent has not chosen (services/medicalLang).
    noticeLanguage: 'en',
};

const RANGES = {
    expiryAlertDays: [1, 365], vaccinationDueDays: [1, 180], maintenanceDueDays: [1, 180],
    documentExpiryDays: [1, 180], missedDoseAfterMinutes: [15, 720], urgentEscalateMinutes: [3, 60], accessAlertThreshold: [10, 200], retentionYears: [1, 30],
};

const TTL = 30 * 1000;
const cache = new Map();

/** The stored row with every default filled in (a plain object). */
function complete(row) {
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        const v = row?.[k];
        if (v === undefined || v === null) continue;
        // An empty list means "never set" for the lists the forms offer.
        if (Array.isArray(DEFAULTS[k]) && Array.isArray(v) && !v.length && k !== 'incidentTypes') continue;
        out[k] = v;
    }
    out.notify = { ...NOTIFY_DEFAULTS, ...(row?.notify || {}) };
    out._id = row?._id ? String(row._id) : null;
    out.updatedAt = row?.updatedAt || null;
    return out;
}

async function get(schoolId) {
    const key = String(schoolId);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    let row = await MedicalSettings.findOne({ school: schoolId }).lean();
    if (!row) {
        try { row = (await MedicalSettings.create({ school: schoolId })).toObject?.() || null; }
        catch { row = await MedicalSettings.findOne({ school: schoolId }).lean(); }   // created by a racing request
    }
    const value = complete(row);
    cache.set(key, { value, until: Date.now() + TTL });
    return value;
}

const invalidate = (schoolId) => cache.delete(String(schoolId));

function cleanList(v, label) {
    if (!Array.isArray(v)) refuse(`${label} must be a list`);
    const seen = new Set();
    const out = [];
    for (const raw of v) {
        const s = str(raw, 80);
        if (!s || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
    }
    if (out.length > 80) refuse(`${label} can hold at most 80 entries`);
    return out;
}

/**
 * Save what the screen sent. Unknown keys are ignored, every number is range
 * checked and every list is trimmed and de-duplicated. Returns the full,
 * defaulted settings and the names of what changed.
 */
async function save(schoolId, body = {}, userId = null) {
    const before = await get(schoolId);
    const set = {};
    for (const k of ['roomName', 'roomLocation', 'roomPhone', 'roomHours']) {
        if (body[k] !== undefined) set[k] = str(body[k], 160);
    }
    if (body.roomName !== undefined && !set.roomName) refuse('The room needs a name');
    if (body.temperatureUnit !== undefined) set.temperatureUnit = body.temperatureUnit === 'C' ? 'C' : 'F';
    for (const k of ['hasBeds', 'teacherAlerts', 'teacherEmergencyInfo', 'breakGlass', 'consentRequired', 'requireStepUp', 'studentAccess', 'studentVisits', 'studentCheckups',
        'studentVaccinations', 'studentDocuments', 'parentUpdates', 'parentUpdatesNeedApproval']) {
        if (body[k] !== undefined) set[k] = bool(body[k]);
    }
    const LABELS = { visitReasons: 'Visit reasons', locations: 'Locations', medicineCategories: 'Medicine categories', supplyCategories: 'Supply categories', vaccines: 'Vaccines' };
    for (const [k, label] of Object.entries(LABELS)) {
        if (body[k] !== undefined) {
            set[k] = cleanList(body[k], label);
            if (!set[k].length) refuse(`${label} needs at least one entry`);
        }
    }
    if (body.incidentTypes !== undefined) {
        const { INCIDENT_TYPE } = require('./medicalRules');
        set.incidentTypes = cleanList(body.incidentTypes, 'Incident types').filter((t) => INCIDENT_TYPE[t]);
    }
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
        if (body[k] === undefined) continue;
        const n = num(body[k]);
        if (n === null || n < lo || n > hi || !Number.isInteger(n)) refuse(`${k.replace(/([A-Z])/g, ' $1').toLowerCase()} must be a whole number from ${lo} to ${hi}`);
        set[k] = n;
    }
    if (body.exclusionRules !== undefined) set.exclusionRules = require('./medicalRestrictions').cleanRules(body.exclusionRules);
    // Checked and allowed by the controller (a school admin only).
    if (body.safeguardingLeads !== undefined) set.safeguardingLeads = body.safeguardingLeads;
    if (body.vaccineSchedule !== undefined) set.vaccineSchedule = require('./medicalSchedule').validate(body.vaccineSchedule);
    if (body.outbreakWatch !== undefined) set.outbreakWatch = bool(body.outbreakWatch);
    if (body.noticeLanguage !== undefined) set.noticeLanguage = ['en', 'hi', 'both'].includes(body.noticeLanguage) ? body.noticeLanguage : 'en';
    if (body.attendanceOnSentHome !== undefined) set.attendanceOnSentHome = body.attendanceOnSentHome === 'half_day' ? 'half_day' : 'off';
    if (body.outbreakRules !== undefined) set.outbreakRules = require('./medicalOutbreak').validateRules(body.outbreakRules);
    if (body.notify !== undefined) {
        if (!body.notify || typeof body.notify !== 'object') refuse('Notifications must be a set of switches');
        const n = { ...before.notify };
        for (const k of Object.keys(NOTIFY_DEFAULTS)) if (body.notify[k] !== undefined) n[k] = bool(body.notify[k]);
        set.notify = n;
    }

    const changed = Object.keys(set).filter((k) => JSON.stringify(set[k]) !== JSON.stringify(before[k]));
    if (!changed.length) return { settings: before, changed: [] };
    const write = Object.fromEntries(changed.map((k) => [k, set[k]]));
    await MedicalSettings.updateOne({ school: schoolId }, { $set: { ...write, updatedBy: userId } }, { upsert: true });
    invalidate(schoolId);
    return { settings: await get(schoolId), changed };
}

module.exports = { get, save, invalidate, complete, DEFAULTS, NOTIFY_DEFAULTS, LISTS, RANGES };
