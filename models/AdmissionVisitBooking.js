const db = require('../db/orm');

/**
 * A family's place on a campus visit (Oct 2026). Made by a signed-in
 * applicant; `people` is how many are coming. Name, email and phone are copied
 * from the account when booked, for the office's list on the day.
 *
 *   status       booked | cancelled | attended | no_show
 *   cancelledBy  family | school
 */
const AdmissionVisitBookingSchema = new db.Schema({
    school:      { type: db.Types.UUID, ref: 'School', required: true },
    slot:        { type: db.Types.UUID, ref: 'AdmissionVisitSlot', required: true },
    applicant:   { type: db.Types.UUID, ref: 'User', required: true },
    name:        { type: String, default: '' },
    email:       { type: String, default: '' },
    phone:       { type: String, default: '' },
    people:      { type: Number, default: 1 },
    note:        { type: String, default: '' },
    status:      { type: String, enum: ['booked', 'cancelled', 'attended', 'no_show'], default: 'booked' },
    cancelledBy: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    remindedAt:  { type: Date, default: null },
}, { timestamps: true });

AdmissionVisitBookingSchema.index({ slot: 1, status: 1 });
AdmissionVisitBookingSchema.index({ school: 1, applicant: 1 });

module.exports = db.model('AdmissionVisitBooking', AdmissionVisitBookingSchema);
