'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Section capacity.
//
//  ClassSection.maxStudents is the seat count. It was previously advisory —
//  the shuffle respected it, but adding or moving a student by hand did not, so
//  a section could quietly grow past its own limit.
//
//  `currentCount` is a denormalised counter and drifts, so the live roster
//  (enrolledStudents) is the authority here — a capacity check that trusts a
//  stale counter is worse than none.
// ─────────────────────────────────────────────────────────────────────────────
const ClassSection = require('../models/ClassSection');

const seatsOf = (section) => Number(section?.maxStudents) || 0;
const takenBy = (section, exclude) => {
    const roster = (section?.enrolledStudents || []).map(String);
    const skip = exclude ? String(exclude) : null;
    return roster.filter((id) => id !== skip).length;
};

/**
 * Seat maths for one section.
 * `excludeStudent` leaves a student out of the count, so re-saving a student
 * who is already in the section never reports it as full.
 */
function seatsFor(section, excludeStudent = null) {
    const capacity = seatsOf(section);
    const occupied = takenBy(section, excludeStudent);
    return { capacity, occupied, free: Math.max(0, capacity - occupied), isFull: capacity > 0 && occupied >= capacity };
}

/**
 * Returns a user-facing message when `section` cannot take another student, or
 * null when there is room. A section with no capacity set (0) is treated as
 * unlimited, which is how the shuffle has always read it.
 */
function capacityError(section, excludeStudent = null) {
    const { capacity, occupied, isFull } = seatsFor(section, excludeStudent);
    if (!isFull) return null;
    return `Section ${section.sectionName} is full — ${occupied} of ${capacity} seats are taken. `
         + `Raise the section's capacity or choose another section.`;
}

/** Same check, given a section id. Returns null when the section does not exist. */
async function capacityErrorById(sectionId, excludeStudent = null) {
    if (!sectionId) return null;
    const section = await ClassSection.findById(String(sectionId)).lean();
    if (!section) return null;
    return capacityError(section, excludeStudent);
}

module.exports = { seatsFor, capacityError, capacityErrorById, seatsOf };
