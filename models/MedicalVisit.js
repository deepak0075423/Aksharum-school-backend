const db = require('../db/orm');

/**
 * One visit to the Medical Room — the record of a case from the moment the
 * student walks in to the moment it is closed (Oct 2026).
 *
 * Status is where the case stands:
 *   in_room, observation, emergency     the student is in the room now
 *   returned, sent_home, referred       they have left; `departedAt` says when
 *   closed                              nothing further to do
 *
 * `emergency` stays true once a case has been an emergency, so "emergency
 * cases today" still counts it after the ambulance has left.
 *
 * Medicines given here are MedicationDose rows (status given, `visit` set) —
 * `medicines` is only the list shown on the visit, so the administration
 * history and the stock ledger have one source each. First aid with supplies
 * is a MedicalFirstAid row (`firstAidRecord`) for the same reason.
 */
const step = new db.Schema({
    status: { type: String },
    at:     { type: Date },
    by:     { type: db.Types.UUID, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note:   { type: String, default: '' },
}, { _id: false });

const followUp = {
    required: { type: Boolean, default: false },
    on:       { type: Date, default: null },
    note:     { type: String, default: '' },
    status:   { type: String, default: '' },            // '' | pending | done | cancelled
    doneAt:   { type: Date, default: null },
    doneBy:   { type: db.Types.UUID, ref: 'User', default: null },
    outcome:  { type: String, default: '' },
};

const referral = {
    referred:      { type: Boolean, default: false },
    hospital:      { type: String, default: '' },
    reason:        { type: String, default: '' },
    transport:     { type: String, default: '' },        // ambulance | parent | school vehicle | …
    accompaniedBy: { type: String, default: '' },
    at:            { type: Date, default: null },
};

const MedicalVisitSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    number:  { type: String, required: true },            // MV-2610-0042
    student: { type: db.Types.UUID, ref: 'User', required: true },
    request:  { type: db.Types.UUID, ref: 'MedicalRequest', default: null },
    incident: { type: db.Types.UUID, ref: 'MedicalIncident', default: null },
    location: { type: db.Types.UUID, ref: 'MedicalLocation', default: null },   // which room (null = the main one)
    // The attendance mark the room changed when the child left (services/medicalAttendance):
    // { date, section, was, wasRemarks, set, at } — so a correction the same day can put it back.
    attendanceMark: { type: Object, default: null },

    arrivedAt: { type: Date, required: true, default: Date.now },
    reason:    { type: String, required: true, trim: true },
    symptoms:  { type: String, default: '', trim: true },

    vitals: {
        temperature: { type: Number, default: null },
        tempUnit:    { type: String, default: 'F' },
        bpSystolic:  { type: Number, default: null },
        bpDiastolic: { type: Number, default: null },
        pulse:       { type: Number, default: null },
        spo2:        { type: Number, default: null },
        weightKg:    { type: Number, default: null },
        respRate:    { type: Number, default: null },
        painScore:   { type: Number, default: null },
        glucose:     { type: Number, default: null },
        avpu:        { type: String, default: null },
        pupils:      { type: String, default: null },
        takenAt:     { type: Date, default: null },
    },
    // Every set of readings taken, oldest first: [{ _id, at, by, byName,
    // temperature, tempUnit, pulse, spo2, bpSystolic, bpDiastolic, respRate,
    // painScore, avpu (A|V|P|U), pupils (equal|unequal|sluggish), glucose,
    // weightKg, note, flags, struck: { at, by, byName, reason } }].
    // `vitals` above stays the latest value of each — what every list shows.
    readings: { type: Array, default: [] },
    // How urgent: { level red|orange|yellow|green|blue, suggested, reasons,
    // by, byName, at } — `suggested` from the protocol and the readings, `level`
    // the nurse's call (services/medicalProtocols).
    triage: { type: Object, default: null },
    // The complaint protocol followed: { key, redFlags: [keys], stepsDone: [i], at, by }.
    protocol: { type: Object, default: null },
    // When the student is next due a look, while in the room.
    nextCheckAt: { type: Date, default: null },
    // Body map: [{ id, view front|back, region, kind, note }].
    injuries: { type: Array, default: [] },
    observation: { type: String, default: '', trim: true },   // initial observation
    treatment:   { type: String, default: '', trim: true },   // treatment provided
    firstAid:    { type: String, default: '', trim: true },   // first aid provided
    firstAidRecord: { type: db.Types.UUID, ref: 'MedicalFirstAid', default: null },
    medicines: { type: Array, default: [] },                  // [{ dose, name, dosage, quantity, at }]

    restAdvised: { type: Boolean, default: false },
    restMinutes: { type: Number, default: null },
    bed:    { type: db.Types.UUID, ref: 'MedicalBed', default: null },
    bedIn:  { type: Date, default: null },
    bedOut: { type: Date, default: null },

    parentContacted:   { type: Boolean, default: false },
    parentContactedAt: { type: Date, default: null },
    parentContactNote: { type: String, default: '' },
    // Sent home: who collected the child, checked against the people on record.
    // `contact` names the match ('parent:<userId>', 'emergency', 'alternate') or
    // 'other' for someone who is not on record — then `note` says who allowed it.
    collection: {
        name:      { type: String, default: '' },
        relation:  { type: String, default: '' },
        phone:     { type: String, default: '' },
        contact:   { type: String, default: '' },
        verified:  { type: Boolean, default: false },
        idChecked: { type: Boolean, default: false },
        idNote:    { type: String, default: '' },
        note:      { type: String, default: '' },
        at:        { type: Date, default: null },
        by:        { type: db.Types.UUID, ref: 'User', default: null },
        byName:    { type: String, default: '' },
    },
    referral,
    followUp,

    handledBy:     { type: db.Types.UUID, ref: 'User', default: null },
    handledByName: { type: String, default: '' },
    remarks:       { type: String, default: '', trim: true },
    privateNotes:  { type: String, default: '' },

    status: {
        type: String,
        enum: ['in_room', 'observation', 'emergency', 'returned', 'sent_home', 'referred', 'closed'],
        default: 'in_room',
    },
    emergency: { type: Boolean, default: false },
    history:   { type: [step], default: [] },
    departedAt: { type: Date, default: null },
    closedAt:   { type: Date, default: null },
    closedBy:   { type: db.Types.UUID, ref: 'User', default: null },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalVisitSchema.index({ school: 1, number: 1 }, { unique: true });
MedicalVisitSchema.index({ school: 1, arrivedAt: -1 });
MedicalVisitSchema.index({ school: 1, status: 1 });
MedicalVisitSchema.index({ school: 1, student: 1, arrivedAt: -1 });

module.exports = db.model('MedicalVisit', MedicalVisitSchema);
