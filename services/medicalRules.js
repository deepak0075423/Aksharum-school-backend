'use strict';
/**
 * The Medical Room's vocabulary, and the rules that are worked out rather
 * than stored (Oct 2026).
 *
 * Nothing that depends on the calendar is written to a row: a vaccination is
 * overdue, a batch is expiring, a follow-up is due because of the date it is
 * TODAY, so those states are computed here at read time and can never fall
 * out of step. The web kit mirrors the labels (pages/medical/mdMeta.js).
 *
 * Dates come in two kinds and are handled as two kinds:
 *   a DAY  (an expiry date, a date of birth, a vaccine's due date) is stored
 *          as UTC midnight of the day meant and read with UTC getters;
 *   an INSTANT (a visit's arrival, a dose given) is a real moment, read on
 *          the school's clock — the process zone, pinned by config/timezone.
 */
const ZONE = require('../config/timezone');

/* ── Errors the controllers turn into answers ─────────────────────────────── */

class MedicalError extends Error {
    constructor(message, status = 400, code = 'MEDICAL_INVALID', extra = {}) {
        super(message);
        this.name = 'MedicalError';
        this.status = status;
        this.code = code;
        Object.assign(this, extra);
    }
}
const refuse = (message, status = 400, code = 'MEDICAL_INVALID', extra) => { throw new MedicalError(message, status, code, extra); };
const notFound = (what = 'Record') => refuse(`${what} not found`, 404, 'MEDICAL_NOT_FOUND');

/* ── Vocabulary ───────────────────────────────────────────────────────────── */

const VISIT_STATUS = {
    in_room:     { label: 'In Medical Room',      tone: 'blue' },
    observation: { label: 'Under Observation',    tone: 'amber' },
    emergency:   { label: 'Emergency',            tone: 'red' },
    returned:    { label: 'Returned to Class',    tone: 'green' },
    sent_home:   { label: 'Sent Home',            tone: 'orange' },
    referred:    { label: 'Referred to Hospital', tone: 'rose' },
    closed:      { label: 'Closed',               tone: 'slate' },
};
// The student is in the room now.
const IN_ROOM = ['in_room', 'observation', 'emergency'];
// The student has left; the case may still have a follow-up.
const DEPARTED = ['returned', 'sent_home', 'referred'];

/**
 * Where a visit may go from where it is. A departed case can be corrected to
 * another way of leaving (sent home, not returned) and closed; a closed case
 * is reopened explicitly (medicalWorkflow.reopenVisit), never by a status edit.
 */
const VISIT_NEXT = {
    in_room:     ['observation', 'emergency', 'returned', 'sent_home', 'referred'],
    observation: ['in_room', 'emergency', 'returned', 'sent_home', 'referred'],
    emergency:   ['in_room', 'observation', 'returned', 'sent_home', 'referred'],
    returned:    ['sent_home', 'referred', 'closed'],
    sent_home:   ['returned', 'referred', 'closed'],
    referred:    ['returned', 'sent_home', 'closed'],
    closed:      [],
};

const REQUEST_STATUS = {
    requested: { label: 'Requested',            tone: 'amber' },
    accepted:  { label: 'Accepted',             tone: 'indigo' },
    arrived:   { label: 'Student Arrived',      tone: 'blue' },
    treatment: { label: 'Under Treatment',      tone: 'violet' },
    returned:  { label: 'Returned to Class',    tone: 'green' },
    sent_home: { label: 'Sent Home',            tone: 'orange' },
    referred:  { label: 'Referred to Hospital', tone: 'rose' },
    closed:    { label: 'Closed',               tone: 'slate' },
    cancelled: { label: 'Cancelled',            tone: 'gray' },
};
const OPEN_REQUEST = ['requested', 'accepted', 'arrived', 'treatment'];

/** What a teacher's request reads once the case is a visit. */
function requestStatusForVisit(visit) {
    if (!visit) return null;
    if (visit.status === 'closed') return 'closed';
    if (DEPARTED.includes(visit.status)) return visit.status;
    const treated = visit.status !== 'in_room' || visit.treatment || visit.firstAid
        || (visit.medicines || []).length || visit.vitals?.takenAt;
    return treated ? 'treatment' : 'arrived';
}

const URGENCY = {
    low:       { label: 'Low',       tone: 'slate' },
    normal:    { label: 'Normal',    tone: 'blue' },
    high:      { label: 'High',      tone: 'orange' },
    emergency: { label: 'Emergency', tone: 'red' },
};

const INCIDENT_TYPE = {
    playground: 'Playground injury',
    sports:     'Sports injury',
    fall:       'Fall',
    cut:        'Cut / Wound',
    fracture:   'Fracture',
    fainting:   'Fainting',
    fever:      'Fever',
    allergic:   'Allergic reaction',
    breathing:  'Breathing problem',
    accident:   'Accident',
    other:      'Other',
};
const INCIDENT_SEVERITY = {
    minor:    { label: 'Minor',    tone: 'green' },
    moderate: { label: 'Moderate', tone: 'amber' },
    serious:  { label: 'Serious',  tone: 'orange' },
    critical: { label: 'Critical', tone: 'red' },
};
const INCIDENT_STATUS = {
    reported:    { label: 'Reported',    tone: 'amber' },
    in_progress: { label: 'In Progress', tone: 'blue' },
    resolved:    { label: 'Resolved',    tone: 'green' },
    closed:      { label: 'Closed',      tone: 'slate' },
};

const ALLERGY_CATEGORY = { food: 'Food', medicine: 'Medicine', environmental: 'Environmental', insect: 'Insect', other: 'Other' };
const ALLERGY_SEVERITY = {
    mild:             { label: 'Mild',             tone: 'green' },
    moderate:         { label: 'Moderate',         tone: 'amber' },
    severe:           { label: 'Severe',           tone: 'orange' },
    life_threatening: { label: 'Life-threatening', tone: 'red' },
};
const CONDITION_TYPE = {
    asthma: 'Asthma', diabetes: 'Diabetes', epilepsy: 'Epilepsy', heart: 'Heart condition',
    vision: 'Vision problem', hearing: 'Hearing problem', orthopedic: 'Orthopedic condition',
    chronic: 'Chronic illness', other: 'Other',
};
const CONDITION_SEVERITY = {
    mild:     { label: 'Mild',     tone: 'green' },
    moderate: { label: 'Moderate', tone: 'amber' },
    severe:   { label: 'Severe',   tone: 'orange' },
    critical: { label: 'Critical', tone: 'red' },
};
const CONDITION_STATUS = {
    active:   { label: 'Active',   tone: 'red' },
    managed:  { label: 'Managed',  tone: 'blue' },
    resolved: { label: 'Resolved', tone: 'slate' },
};

const DOSE_STATUS = {
    scheduled: { label: 'Scheduled', tone: 'indigo' },
    given:     { label: 'Given',     tone: 'green' },
    missed:    { label: 'Missed',    tone: 'red' },
    refused:   { label: 'Refused',   tone: 'orange' },
    cancelled: { label: 'Cancelled', tone: 'gray' },
};
const PLAN_FREQUENCY = {
    once: 'Once a day', twice: 'Twice a day', thrice: 'Three times a day', as_needed: 'As needed', custom: 'Custom times',
};
const PLAN_STATUS = {
    active:    { label: 'Active',    tone: 'green' },
    paused:    { label: 'Paused',    tone: 'amber' },
    completed: { label: 'Completed', tone: 'slate' },
    cancelled: { label: 'Cancelled', tone: 'gray' },
};

const VACCINATION_STATUS = {
    completed: { label: 'Completed', tone: 'green' },
    pending:   { label: 'Pending',   tone: 'slate' },
    due_soon:  { label: 'Due Soon',  tone: 'amber' },
    overdue:   { label: 'Overdue',   tone: 'red' },
};

const CHECKUP_TYPE = {
    general: 'General health', vision: 'Vision', dental: 'Dental', hearing: 'Hearing', height: 'Height',
    weight: 'Weight', bmi: 'BMI', bp: 'Blood pressure', physical: 'Physical examination',
};
const CHECKUP_OUTCOME = {
    normal:    { label: 'Normal',          tone: 'green' },
    attention: { label: 'Needs attention', tone: 'amber' },
    referred:  { label: 'Referred',        tone: 'rose' },
};

const DOC_TYPE = {
    prescription: 'Prescription', medical_certificate: 'Medical certificate', fitness_certificate: 'Fitness certificate',
    vaccination_certificate: 'Vaccination certificate', lab_report: 'Lab report', doctor_report: 'Doctor report',
    hospital_document: 'Hospital document', history: 'Medical history document', incident_photo: 'Incident photo', other: 'Other',
};
const DOC_VISIBILITY = {
    family:       { label: 'Family can see',     tone: 'green' },
    staff:        { label: 'Medical staff only', tone: 'amber' },
    confidential: { label: 'Confidential',       tone: 'red' },
};
// A prescription is the clinical record of a medicine — never on a family
// default it did not choose, never anywhere near a teacher.
// A photo of an injury is a picture of a child's body: the medical staff's, unless they choose to share it.
const DEFAULT_VISIBILITY = { prescription: 'staff', doctor_report: 'staff', lab_report: 'staff', hospital_document: 'staff', history: 'staff', incident_photo: 'staff' };

const BED_STATUS = {
    available:      { label: 'Available',      tone: 'green' },
    occupied:       { label: 'Occupied',       tone: 'red' },
    cleaning:       { label: 'Being cleaned',  tone: 'amber' },
    out_of_service: { label: 'Out of service', tone: 'slate' },
};
const BED_KIND = { bed: 'Bed', rest_area: 'Rest area', isolation: 'Isolation' };

const EQUIP_TYPE = {
    thermometer: 'Thermometer', bp_monitor: 'BP monitor', pulse_oximeter: 'Pulse oximeter', weighing_machine: 'Weighing machine',
    wheelchair: 'Wheelchair', stretcher: 'Stretcher', nebulizer: 'Nebulizer', first_aid_box: 'First-aid box',
    glucometer: 'Glucometer', oxygen_cylinder: 'Oxygen cylinder', defibrillator: 'Defibrillator (AED)', other: 'Other',
};
const EQUIP_STATUS = {
    available:         { label: 'Available',         tone: 'green' },
    in_use:            { label: 'In use',            tone: 'blue' },
    under_maintenance: { label: 'Under maintenance', tone: 'amber' },
    out_of_service:    { label: 'Out of service',    tone: 'red' },
    retired:           { label: 'Retired',           tone: 'gray' },
};
const EQUIP_CONDITION = {
    good:    { label: 'Good',    tone: 'green' },
    fair:    { label: 'Fair',    tone: 'blue' },
    poor:    { label: 'Poor',    tone: 'amber' },
    damaged: { label: 'Damaged', tone: 'red' },
};

const MOVE_TYPE = {
    stock_in:     { label: 'Stock in',      tone: 'green' },
    stock_out:    { label: 'Stock out',     tone: 'blue' },
    administered: { label: 'Administered',  tone: 'indigo' },
    first_aid:    { label: 'First aid',     tone: 'violet' },
    adjustment:   { label: 'Adjustment',    tone: 'slate' },
    expired:      { label: 'Expired',       tone: 'red' },
    damaged:      { label: 'Damaged',       tone: 'orange' },
    returned:     { label: 'Returned',      tone: 'emerald' },
    disposed:     { label: 'Disposed',      tone: 'gray' },
    transfer_out: { label: 'Moved out',     tone: 'slate' },
    transfer_in:  { label: 'Moved in',      tone: 'teal' },
};
const BATCH_STATUS = {
    active:   { label: 'In stock', tone: 'green' },
    expiring: { label: 'Expiring soon', tone: 'amber' },
    expired:  { label: 'Expired', tone: 'red' },
    damaged:  { label: 'Damaged', tone: 'orange' },
    depleted: { label: 'Used up', tone: 'slate' },
    disposed: { label: 'Disposed', tone: 'gray' },
};

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// Where a rescue medicine is kept (services/medicalCare RESCUE_PLACE), for alert lines.
const RESCUE_PLACE_LABEL = {
    bag: 'school bag', medical_room: 'Medical Room', classroom: 'classroom', bus: 'school bus',
    staff_room: 'staff room', hostel: 'hostel', sports: 'sports room', other: 'other',
};

const CHANGE_KIND = {
    allergy: 'Allergy', condition: 'Medical condition', contact: 'Emergency contact', doctor: 'Family doctor',
    hospital: 'Preferred hospital', profile: 'Medical profile', vaccination: 'Vaccination', document: 'Medical document',
};

/* ── Days ─────────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today on the school's clock, as 'YYYY-MM-DD'. */
function todayStr(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A stored DAY as 'YYYY-MM-DD' (UTC getters — it is UTC midnight of the day meant). */
function dayStr(v) {
    if (!v) return '';
    if (typeof v === 'string' && DAY_RE.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A stored DAY for people to read — '04 Oct 2026', as the web app writes it.
 *  dayStr is for comparing and storing; this is for sentences. */
function dayLabel(v) {
    const s = dayStr(v);
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: '2-digit', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-IN', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true });

/** An instant for people to read, on the school's clock — '04 Oct 2026, 8:06 pm'. */
function instantLabel(v) {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return `${DAY_FMT.format(d)}, ${TIME_FMT.format(d).toLowerCase()}`;
}

/** The day an instant falls on, on the school's clock — '04 Oct 2026'. (dayLabel reads a STORED day, in UTC:
 *  given an instant before 5:30 am IST it names the day before.) */
function instantDayLabel(v) {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? '' : dayLabel(todayStr(d));
}

/** Whatever a form posted as a day → the Date it is stored as, or null. */
function toDay(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string' && DAY_RE.test(v.slice(0, 10))) return new Date(`${v.slice(0, 10)}T00:00:00Z`);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whatever a form posted as an instant → a Date, or null. 'YYYY-MM-DDTHH:MM' is read on the school's clock. */
function toInstant(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from day `a` to day `b` (both 'YYYY-MM-DD'). */
function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 'YYYY-MM-DD' + n days. */
function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return dayStr(d);
}

/** The local instant at the start of a 'YYYY-MM-DD' on the school's clock. */
function startOfDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function ageYears(dob, now = new Date()) {
    const d = dob ? dayStr(dob) : '';
    if (!d) return null;
    const [y, m, dd] = d.split('-').map(Number);
    let age = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < dd)) age -= 1;
    return age >= 0 && age < 120 ? age : null;
}

/* ── Measurements ─────────────────────────────────────────────────────────── */

const round1 = (n) => Math.round(n * 10) / 10;

/** BMI in kg/m², or null. For a child this is a number to chart against age, not a category. */
function bmi(heightCm, weightKg) {
    const h = Number(heightCm); const w = Number(weightKg);
    if (!(h > 30 && h < 250) || !(w > 2 && w < 300)) return null;
    return round1(w / ((h / 100) ** 2));
}

function isFever(temp, unit = 'F') {
    const t = Number(temp);
    if (!Number.isFinite(t)) return false;
    return unit === 'C' ? t >= 38 : t >= 100.4;
}

/**
 * Readings worth a second look. Hints for the person at the bedside — never a
 * diagnosis, and deliberately conservative for children.
 */
/**
 * What a reading says, each flag with a level (warning | critical) and, for
 * the ones that make a case an emergency, the triage colour (red | orange).
 * Pulse and breathing are judged for the child's age when it is known.
 */
function vitalFlags(v = {}, { age = null } = {}) {
    const out = [];
    const unit = v.tempUnit === 'C' ? 'C' : 'F';
    const t = Number(v.temperature);
    if (v.temperature != null && Number.isFinite(t)) {
        const high = unit === 'C' ? 39.4 : 103;
        const low = unit === 'C' ? 35 : 95;
        if (t >= high) out.push({ key: 'temperature', level: 'critical', label: 'High fever' });
        else if (isFever(t, unit)) out.push({ key: 'temperature', level: 'warning', label: 'Fever' });
        else if (t <= low) out.push({ key: 'temperature', level: 'warning', label: 'Low temperature' });
    }
    const s = Number(v.spo2);
    if (v.spo2 != null && Number.isFinite(s)) {
        if (s < 90) out.push({ key: 'spo2', level: 'critical', label: 'Low oxygen', triage: 'red' });
        else if (s < 95) out.push({ key: 'spo2', level: 'warning', label: 'Oxygen below 95%' });
    }
    // Normal ranges by age (paediatric life-support tables, rounded).
    const band = age == null ? null : age < 5 ? 'small' : age < 12 ? 'child' : 'teen';
    const PULSE = { small: [80, 150, 70, 170], child: [60, 130, 50, 150], teen: [55, 120, 45, 140], none: [55, 120, 45, 140] };
    const RESP = { small: [18, 40, 15, 50], child: [15, 30, 12, 40], teen: [10, 24, 8, 30], none: [10, 30, 8, 40] };
    const p = Number(v.pulse);
    if (v.pulse != null && Number.isFinite(p)) {
        const [lo, hi, clo, chi] = PULSE[band || 'none'];
        if (p > chi || p < clo) out.push({ key: 'pulse', level: 'critical', label: p > chi ? 'Very fast pulse' : 'Very slow pulse' });
        else if (p > hi || p < lo) out.push({ key: 'pulse', level: 'warning', label: p > hi ? 'Fast pulse' : 'Slow pulse' });
    }
    const rr = Number(v.respRate);
    if (v.respRate != null && Number.isFinite(rr)) {
        const [lo, hi, clo, chi] = RESP[band || 'none'];
        if (rr > chi || rr < clo) out.push({ key: 'respRate', level: 'critical', label: rr > chi ? 'Breathing very fast' : 'Breathing very slowly', triage: 'orange' });
        else if (rr > hi || rr < lo) out.push({ key: 'respRate', level: 'warning', label: rr > hi ? 'Breathing fast' : 'Breathing slowly' });
    }
    const sys = Number(v.bpSystolic); const dia = Number(v.bpDiastolic);
    if (v.bpSystolic != null && Number.isFinite(sys)) {
        if (sys >= 160 || (Number.isFinite(dia) && dia >= 100)) out.push({ key: 'bp', level: 'critical', label: 'Very high blood pressure' });
        else if (sys >= 140 || (Number.isFinite(dia) && dia >= 90)) out.push({ key: 'bp', level: 'warning', label: 'High blood pressure' });
        else if (sys < 85) out.push({ key: 'bp', level: 'warning', label: 'Low blood pressure' });
    }
    if (v.avpu && v.avpu !== 'A') {
        out.push({ key: 'avpu', level: 'critical', label: v.avpu === 'V' ? 'Responds to voice only' : v.avpu === 'P' ? 'Responds to pain only' : 'Unresponsive', triage: 'red' });
    }
    if (v.pupils === 'unequal') out.push({ key: 'pupils', level: 'critical', label: 'Pupils unequal', triage: 'red' });
    else if (v.pupils === 'sluggish') out.push({ key: 'pupils', level: 'warning', label: 'Pupils slow to react' });
    const g = Number(v.glucose);
    if (v.glucose != null && Number.isFinite(g)) {
        if (g < 54) out.push({ key: 'glucose', level: 'critical', label: 'Very low blood sugar', triage: 'orange' });
        else if (g < 70) out.push({ key: 'glucose', level: 'warning', label: 'Low blood sugar' });
        else if (g > 300) out.push({ key: 'glucose', level: 'warning', label: 'High blood sugar' });
    }
    const pain = Number(v.painScore);
    if (v.painScore != null && Number.isFinite(pain) && pain >= 7) out.push({ key: 'painScore', level: 'warning', label: pain >= 9 ? 'Severe pain' : 'Bad pain' });
    return out;
}

/* ── Derived states ───────────────────────────────────────────────────────── */

/** completed | overdue | due_soon | pending, for a vaccination on `today`. */
function vaccinationStatus(v, today = todayStr(), dueDays = 30) {
    if (!v) return 'pending';
    if (v.givenOn) return 'completed';
    const due = dayStr(v.dueOn);
    if (!due) return 'pending';
    if (due < today) return 'overdue';
    return daysBetween(today, due) <= dueDays ? 'due_soon' : 'pending';
}

/** For a batch: its stored status, or for an active one ok | expiring | expired by date. */
function batchState(b, today = todayStr(), alertDays = 60) {
    if (!b) return 'active';
    if (b.status && b.status !== 'active') return b.status;
    const exp = dayStr(b.expiryDate);
    if (!exp) return 'active';
    if (exp < today) return 'expired';
    return daysBetween(today, exp) <= alertDays ? 'expiring' : 'active';
}

/** Is a follow-up waiting, and is it due? '' | 'upcoming' | 'due' | 'overdue' */
function followUpState(f, today = todayStr()) {
    if (!f?.required || (f.status && f.status !== 'pending')) return '';
    const on = dayStr(f.on);
    if (!on) return 'due';
    if (on < today) return 'overdue';
    if (on === today) return 'due';
    return 'upcoming';
}

const SEVERE_ALLERGY = ['severe', 'life_threatening'];
const SEVERE_CONDITION = ['severe', 'critical'];
// Conditions a teacher has to act on in class — the inhaler, the seat at the
// front, the sugar in the bag — shared with them unless the room says not.
const SHARED_CONDITION_TYPES = ['asthma', 'diabetes', 'epilepsy', 'heart', 'vision', 'hearing', 'orthopedic'];

/** Whether a new record is shown to the student's teachers when nobody said. */
function defaultShare(kind, rec = {}) {
    if (kind === 'allergy') return true;
    if (kind === 'condition') return SHARED_CONDITION_TYPES.includes(rec.type) || SEVERE_CONDITION.includes(rec.severity);
    return false;
}

const live = (r) => r && !r.archivedAt;

/**
 * The alert area of a student: what anyone caring for them must see first.
 *
 *   critical  a severe or life-threatening allergy, a severe or critical
 *             condition, an emergency medication
 *   warning   any other allergy or condition still in force, medicine taken
 *             at school
 *
 * `forTeacher` keeps only what the medical room shares with teachers, and
 * leaves out the medicines a child takes (that is the family's business,
 * unless it is the emergency medication).
 */
function alertsFor({ allergies = [], conditions = [], profile = null, plans = [], rescueMeds = [], carePlans = [] }, { forTeacher = false } = {}) {
    const out = [];
    for (const a of allergies) {
        if (!live(a) || a.status === 'resolved') continue;
        if (forTeacher && a.shareWithTeachers === false) continue;
        const severe = SEVERE_ALLERGY.includes(a.severity);
        out.push({
            level: severe ? 'critical' : 'warning',
            kind: 'allergy',
            id: String(a._id),
            label: severe ? `Severe allergy: ${a.allergen}` : `Allergy: ${a.allergen}`,
            severity: a.severity,
            detail: a.reaction || '',
            instructions: a.emergencyInstructions || '',
            medication: a.medication || '',
        });
    }
    for (const c of conditions) {
        if (!live(c) || c.status === 'resolved') continue;
        if (forTeacher && c.shareWithTeachers === false) continue;
        const severe = SEVERE_CONDITION.includes(c.severity);
        out.push({
            level: severe ? 'critical' : 'warning',
            kind: 'condition',
            id: String(c._id),
            label: c.condition || CONDITION_TYPE[c.type] || 'Medical condition',
            severity: c.severity,
            detail: c.treatment || '',
            instructions: c.emergencyInstructions || '',
            medication: c.medication || '',
        });
    }
    // Rescue medicines are tracked one by one; the profile's single "emergency
    // medication" is read only for a child who has none tracked yet.
    const today = todayStr();
    const rescue = rescueMeds.filter((r) => live(r) && (r.status || 'active') === 'active');
    for (const r of rescue) {
        const exp = dayStr(r.expiresOn);
        const expired = exp && exp < today;
        const places = (r.locations || []).map((l) => RESCUE_PLACE_LABEL[l.place] || l.place).filter(Boolean);
        out.push({
            level: 'critical',
            kind: 'rescue_med',
            id: String(r._id),
            label: expired ? `${r.name} — EXPIRED ${dayLabel(exp)}` : `Emergency medicine: ${r.name}`,
            detail: [places.length ? `Kept: ${places.join(', ')}` : '', r.selfCarry ? 'Carried by the student' : '',
                !expired && exp && daysBetween(today, exp) <= 30 ? `Expires ${dayLabel(exp)}` : ''].filter(Boolean).join(' · '),
            instructions: r.instructions || r.dose || '',
            medication: r.name,
            expired: !!expired,
        });
    }
    for (const p of carePlans.filter((x) => live(x) && (x.status || 'active') === 'active')) {
        const steps = (p.steps || []).filter((s) => s.critical).map((s) => s.text);
        out.push({
            level: 'critical',
            kind: 'care_plan',
            id: String(p._id),
            label: `Care plan: ${p.title}`,
            detail: steps.slice(0, 3).join(' → '),
            instructions: p.ambulanceWhen ? `Ambulance: ${p.ambulanceWhen}` : '',
            medication: '',
        });
    }
    const em = profile?.emergencyMedication;
    if (em?.required && !rescue.length) {
        out.push({
            level: 'critical',
            kind: 'emergency_medication',
            id: 'emergency_medication',
            label: `Emergency medication${em.name ? `: ${em.name}` : ''}`,
            detail: em.location ? `Kept: ${em.location}` : '',
            instructions: em.instructions || '',
            medication: em.name || '',
        });
    }
    if (!forTeacher) {
        const regular = plans.filter((p) => p.status === 'active');
        if (regular.length) {
            out.push({
                level: 'warning',
                kind: 'medication',
                id: 'medication',
                label: 'Regular medication',
                detail: regular.map((p) => `${p.medicineName} ${p.dosage}`.trim()).join(', '),
                instructions: '',
                medication: '',
            });
        }
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

const str = (v, max = 2000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const oneOf = (v, map, fallback) => (Object.prototype.hasOwnProperty.call(map, v) ? v : fallback);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const labelOf = (map, key) => (typeof map[key] === 'string' ? map[key] : map[key]?.label) || key || '';

/** 'HH:MM' or null. */
function clock(v) {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]); const mm = Number(m[2]);
    return h < 24 && mm < 60 ? `${pad(h)}:${pad(mm)}` : null;
}

module.exports = {
    ZONE, MedicalError, refuse, notFound,
    VISIT_STATUS, IN_ROOM, DEPARTED, VISIT_NEXT, REQUEST_STATUS, OPEN_REQUEST, requestStatusForVisit, URGENCY,
    INCIDENT_TYPE, INCIDENT_SEVERITY, INCIDENT_STATUS,
    ALLERGY_CATEGORY, ALLERGY_SEVERITY, CONDITION_TYPE, CONDITION_SEVERITY, CONDITION_STATUS,
    DOSE_STATUS, PLAN_FREQUENCY, PLAN_STATUS, VACCINATION_STATUS, CHECKUP_TYPE, CHECKUP_OUTCOME,
    DOC_TYPE, DOC_VISIBILITY, DEFAULT_VISIBILITY, BED_STATUS, BED_KIND, EQUIP_TYPE, EQUIP_STATUS, EQUIP_CONDITION,
    MOVE_TYPE, BATCH_STATUS, BLOOD_GROUPS, CHANGE_KIND,
    SEVERE_ALLERGY, SEVERE_CONDITION, SHARED_CONDITION_TYPES, defaultShare,
    todayStr, dayStr, dayLabel, instantLabel, instantDayLabel, toDay, toInstant, daysBetween, addDays, startOfDay, ageYears,
    bmi, isFever, vitalFlags, vaccinationStatus, batchState, followUpState, alertsFor,
    str, num, oneOf, bool, isUuid, labelOf, clock, pad,
};
