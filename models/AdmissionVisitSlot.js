const db = require('../db/orm');

/**
 * A time families may book to visit the school (Oct 2026) — a campus tour, an
 * open house. `capacity` counts people, not bookings; what is left is counted
 * from the bookings under a lock (services/admission/visits.js), never stored.
 *
 *   status   open | cancelled (the families who booked are told why)
 */
const AdmissionVisitSlotSchema = new db.Schema({
    school:          { type: db.Types.UUID, ref: 'School', required: true },
    title:           { type: String, default: 'Campus visit', trim: true },
    startsAt:        { type: Date, required: true },
    durationMinutes: { type: Number, default: 60 },
    capacity:        { type: Number, default: 10 },
    location:        { type: String, default: '' },
    notes:           { type: String, default: '' },
    status:          { type: String, enum: ['open', 'cancelled'], default: 'open' },
    cancelReason:    { type: String, default: '' },
    createdBy:       { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionVisitSlotSchema.index({ school: 1, startsAt: 1 });

module.exports = db.model('AdmissionVisitSlot', AdmissionVisitSlotSchema);
