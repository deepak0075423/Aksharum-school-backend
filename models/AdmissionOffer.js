const db = require('../db/orm');

/**
 * A seat offered to an applicant. An offer that is issued, accepted or
 * confirmed holds a seat in its class (services/admission/seats.js); one that
 * is declined, expires, is withdrawn or cancelled gives it back — and the
 * waiting list moves up when the school has asked for that.
 *
 * At most one live offer per application: partial unique index in
 * db/migrate.js.
 */
const AdmissionOfferSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    application:  { type: db.Types.UUID, ref: 'AdmissionApplication', required: true },
    round:        { type: db.Types.UUID, ref: 'AdmissionRound', required: true },
    class:        { type: db.Types.UUID, ref: 'Class', required: true },
    list:         { type: db.Types.UUID, ref: 'AdmissionList', default: null },
    offerNumber:  { type: String, default: '' },
    status:       { type: String, enum: ['issued', 'accepted', 'declined', 'expired', 'withdrawn', 'confirmed', 'cancelled'], default: 'issued' },
    issuedAt:     { type: Date, default: Date.now },
    respondBy:    { type: Date, default: null },
    respondedAt:  { type: Date, default: null },
    responseNote: { type: String, default: '' },
    feeAmount:    { type: Number, default: 0 },
    feeDueAt:     { type: Date, default: null },
    issuedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    closedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    reason:       { type: String, default: '' },
    remindedAt:   { type: Date, default: null },
    // The seat pool the offer holds: a quota's key, or '' for the general seats.
    quota:        { type: String, default: '' },
    // The admission fee in instalments (the round's plan), fixed when the offer
    // is made: [{ label, amount, dueAt, remindedAt }]. null: one payment.
    schedule:     { type: db.Types.JSON, default: null },
}, { timestamps: true });

AdmissionOfferSchema.index({ school: 1, status: 1 });
AdmissionOfferSchema.index({ school: 1, application: 1 });

module.exports = db.model('AdmissionOffer', AdmissionOfferSchema);
