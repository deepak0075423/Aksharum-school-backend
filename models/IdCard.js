const db = require('../db/orm');

/**
 * One physical/digital ID card (Oct 2026).
 *
 * A card is a frozen record: `snapshot` holds everything printed on it, as it
 * was when it was issued, and `design` the look it was issued with — so a
 * student promoted from VII-A to VIII-B keeps a 2025-26 card that still says
 * VII-A, and a template edited next year does not repaint last year's cards.
 * Nothing about the holder is read live to draw a card.
 *
 *   student   one card per student per academic year (`academicYear` set)
 *   teacher   one card per teacher, kept across years
 *   staff     one card per non-teaching employee or school administrator
 *   parent    one card per parent, kept across years
 *
 * `status` holds only what someone decided — active, blocked, lost, damaged,
 * reissued (superseded by a newer card), cancelled. Whether a student card is
 * expired (its year is behind the school's current one) or not yet in force
 * (issued ahead for next year) is worked out from the school's academic years
 * when it is read — see services/idCardRules.effectiveStatus — so it can never
 * fall out of step with the year the school is in.
 *
 * At most one LIVE card (active or blocked) per holder and year: enforced by
 * the partial unique index "ux_idcards_live" (db/migrate.js) under the
 * advisory lock the service takes.
 */
const IdCardSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    kind:         { type: String, enum: ['student', 'teacher', 'staff', 'parent'], required: true },
    holder:       { type: db.Types.UUID, ref: 'User', required: true },
    // Student cards only — the year the card is for.
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },

    // Printed on the card ("ST2627-00042"), unique within the school.
    number:       { type: String, required: true },
    // What the QR code carries (/verify/id/<code>) — unguessable, never reused.
    code:         { type: String, required: true, unique: true },

    status:       { type: String, enum: ['active', 'blocked', 'lost', 'damaged', 'reissued', 'cancelled'], default: 'active' },
    statusReason: { type: String, default: '' },
    statusAt:     { type: Date, default: null },
    statusBy:     { type: db.Types.UUID, ref: 'User', default: null },

    // The chain of replacements: a lost card points forward to the card that
    // replaced it, and the replacement back to it. reissueNo counts the copies
    // (0 for an original), so "Duplicate 2" can be printed on the second.
    replaces:      { type: db.Types.UUID, ref: 'IdCard', default: null },
    replacedBy:    { type: db.Types.UUID, ref: 'IdCard', default: null },
    reissueNo:     { type: Number, default: 0 },
    reissueReason: { type: String, default: '' },   // lost | damaged | details | other

    // { name, photo, photoSource, holderCode, className, sectionName, rollNumber,
    //   yearName, dob, bloodGroup, designation, department, relationship,
    //   children:[{ _id, name }], phone, emergencyPhone, address, parentName, … }
    snapshot:     { type: Object, default: null },
    // The template and school identity the card was issued with.
    design:       { type: Object, default: null },

    // Student cards: the year's own dates, printed as the validity.
    validFrom:    { type: Date, default: null },
    validUntil:   { type: Date, default: null },

    issuedAt:     { type: Date, default: Date.now },
    issuedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    // Set when the card's details were brought up to date in place — allowed
    // only while the office has never printed it (services/idCardService).
    refreshedAt:  { type: Date, default: null },
    // The office's print queue: when it was last sent to print / downloaded
    // by the office, and how many times.
    printedAt:    { type: Date, default: null },
    printCount:   { type: Number, default: 0 },
    // QR scans, at the gate or anywhere.
    verifiedAt:   { type: Date, default: null },
    verifyCount:  { type: Number, default: 0 },

    createdAt:    { type: Date, default: Date.now },
});

IdCardSchema.index({ school: 1, number: 1 }, { unique: true });
IdCardSchema.index({ school: 1, kind: 1, academicYear: 1 });
IdCardSchema.index({ holder: 1, kind: 1 });
IdCardSchema.index({ school: 1, issuedAt: -1 });

module.exports = db.model('IdCard', IdCardSchema);
