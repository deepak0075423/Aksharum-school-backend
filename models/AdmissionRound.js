const db = require('../db/orm');

/**
 * An admission session / round: "2027-28 — Main Admissions", "Class XI —
 * Second Round". Applications are made to one class of one round.
 *
 * `classes` is the round's class-wise configuration: how many seats, fees that
 * differ from the round's own, who is eligible (age on a date, a date-of-birth
 * window), and a form other than the round's default where one class needs it.
 * Seats are counted, never decremented: an offer or a confirmed admission holds
 * a seat because its row says so (services/admission/seats.js), and every seat
 * change takes an advisory lock on (round, class) so two offers cannot both
 * take the last seat.
 */
const RoundClassSchema = new db.Schema({
    class:          { type: db.Types.UUID, ref: 'Class', required: true },
    seats:          { type: Number, default: 0 },
    applicationFee: { type: Number, default: null },     // null: the round's fee
    admissionFee:   { type: Number, default: null },
    form:           { type: db.Types.UUID, ref: 'AdmissionForm', default: null },
    eligibility: {
        ageOn:       { type: Date, default: null },      // age is reckoned on this date
        minAgeYears: { type: Number, default: null },
        maxAgeYears: { type: Number, default: null },
        dobFrom:     { type: Date, default: null },
        dobTo:       { type: Date, default: null },
        notes:       { type: String, default: '' },
    },
    isOpen: { type: Boolean, default: true },            // a class can stop taking applications on its own
    // Seats set aside within the class (Oct 2026): [{ key, name, kind, seats,
    // released, feeRule: { type: normal|free|percent, percent }, claim }] —
    // services/admission/quotas.js. General seats are what is left.
    quotas: { type: db.Types.JSON, default: () => [] },
}, { _id: true });

const AdmissionRoundSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    name:         { type: String, required: true, trim: true },
    type:         { type: String, enum: ['regular', 'lateral', 'mid_year', 'special'], default: 'regular' },
    description:  { type: String, default: '' },
    campus:       { type: String, trim: true, default: '' },
    status:       { type: String, enum: ['draft', 'open', 'closed', 'archived'], default: 'draft' },
    opensAt:      { type: Date, default: null },
    closesAt:     { type: Date, default: null },
    documentDeadline: { type: Date, default: null },
    form:         { type: db.Types.UUID, ref: 'AdmissionForm', default: null },
    applicationFee: { type: Number, default: 0 },
    admissionFee:   { type: Number, default: 0 },
    // How long a family has to pay the admission fee once the offer is accepted.
    admissionFeeDueDays: { type: Number, default: 7 },
    // The admission fee in instalments (Oct 2026): [{ label, percent, dueDays }],
    // the first due with the fee date, each later one dueDays after it; and
    // whether the admission can be confirmed once the first is paid.
    instalments:  { type: db.Types.JSON, default: () => [] },
    confirmWith:  { type: String, enum: ['full', 'first'], default: 'full' },
    maxApplicationsPerApplicant: { type: Number, default: null },   // null: the school's setting
    classes:      [RoundClassSchema],
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionRoundSchema.index({ school: 1, status: 1 });
AdmissionRoundSchema.index({ school: 1, academicYear: 1 });

module.exports = db.model('AdmissionRound', AdmissionRoundSchema);
