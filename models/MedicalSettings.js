const db = require('../db/orm');

/**
 * How one school runs its Medical Room (Oct 2026): the room itself, the lists
 * its forms offer, who may see what, when alerts fire and who is told. One
 * row per school, created on first read with these defaults
 * (services/medicalSettings).
 */
const MedicalSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },

    // ── The room ──────────────────────────────────────────────────────────────
    roomName:     { type: String, default: 'Medical Room', trim: true },
    roomLocation: { type: String, default: '', trim: true },
    roomPhone:    { type: String, default: '', trim: true },
    roomHours:    { type: String, default: '', trim: true },
    hasBeds:      { type: Boolean, default: true },
    temperatureUnit: { type: String, enum: ['F', 'C'], default: 'F' },

    // ── The lists the forms offer ─────────────────────────────────────────────
    visitReasons:       { type: [String], default: [] },
    locations:          { type: [String], default: [] },
    medicineCategories: { type: [String], default: [] },
    supplyCategories:   { type: [String], default: [] },
    vaccines:           { type: [String], default: [] },
    incidentTypes:      { type: [String], default: [] },   // enabled incident types; [] = all

    // ── Who sees what ─────────────────────────────────────────────────────────
    teacherAlerts:        { type: Boolean, default: true },   // a teacher sees the critical alerts of their students
    teacherEmergencyInfo: { type: Boolean, default: true },   // …and can open their emergency profile
    breakGlass: { type: Boolean, default: true },             // any staff member may open any child's card in an emergency, with a reason
    consentRequired: { type: Boolean, default: false },       // an everyday medicine without the parents' consent this year is stopped (else a warning)
    safeguardingLeads: { type: [String], default: [] },       // the designated safeguarding leads (user ids); named by a school admin only
    requireStepUp:   { type: Boolean, default: false },       // the medical staff confirm with an emailed code every 12 h
    accessAlertThreshold: { type: Number, default: 30 },      // students' records opened in an hour that tells the admins
    retentionYears: { type: Number, default: 8 },             // years a former student's record is kept before it may be purged
    studentAccess:        { type: Boolean, default: true },   // students may open "My Health"
    studentVisits:        { type: Boolean, default: true },
    studentCheckups:      { type: Boolean, default: true },
    studentVaccinations:  { type: Boolean, default: true },
    studentDocuments:     { type: Boolean, default: true },
    parentUpdates:        { type: Boolean, default: true },   // parents may send updates
    parentUpdatesNeedApproval: { type: Boolean, default: true },

    // ── When things fall due ──────────────────────────────────────────────────
    expiryAlertDays:      { type: Number, default: 60 },
    vaccinationDueDays:   { type: Number, default: 30 },
    maintenanceDueDays:   { type: Number, default: 14 },
    documentExpiryDays:   { type: Number, default: 30 },
    missedDoseAfterMinutes: { type: Number, default: 120 },
    urgentEscalateMinutes:  { type: Number, default: 10 },    // nobody answered an urgent notice → the next contact
    exclusionRules: { type: Object, default: {} },          // changes to the return-to-school rules (services/medicalRestrictions)

    // ── Health programmes ─────────────────────────────────────────────────────
    // { programme: 'uip'|'iap'|'custom'|'', remind: bool, entries: [...] } — services/medicalSchedule
    vaccineSchedule: { type: Object, default: {} },
    outbreakWatch: { type: Boolean, default: true },        // the sweep looks for clusters of illness
    outbreakRules: { type: Object, default: {} },           // changes to the clusters it looks for (services/medicalOutbreak)
    // A child sent home (or to hospital) who was marked present: 'off' leaves the register, 'half_day' marks Half-Day.
    attendanceOnSentHome: { type: String, default: 'off' },

    // The language of the messages to families when a parent has not chosen: 'en' | 'hi' | 'both' (services/medicalLang).
    noticeLanguage: { type: String, default: 'en' },

    // ── Who is told ───────────────────────────────────────────────────────────
    notify: { type: Object, default: {} },   // see services/medicalSettings NOTIFY_DEFAULTS

    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('MedicalSettings', MedicalSettingsSchema);
