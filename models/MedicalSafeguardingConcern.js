const db = require('../db/orm');

/**
 * A concern about a child's welfare (Oct 2026) — what a member of staff saw
 * or was told, in their words, and what was done. Read only by the school's
 * designated safeguarding leads (settings.safeguardingLeads; the school admins
 * when none are named); the person who raised it sees only that it is being
 * dealt with. Kept apart from the medical record, the history, every list,
 * search and notification — and every reading is audited.
 */
const MedicalSafeguardingConcernSchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    number:   { type: String, required: true },              // SG-2610-0003
    student:  { type: db.Types.UUID, ref: 'User', required: true },
    category: { type: String, enum: ['physical', 'emotional', 'sexual', 'neglect', 'bullying', 'online', 'self_harm', 'disclosure', 'other'], default: 'other' },
    urgent:   { type: Boolean, default: false },             // the child may be in danger now
    description:     { type: String, required: true },       // what was seen or said, in the words used
    observedAt:      { type: Date, default: null },
    location:        { type: String, default: '' },
    injuries:        { type: Array, default: [] },           // body map, as on a visit
    actionTaken:     { type: String, default: '' },          // what the person who raised it did straight away
    raisedBy:     { type: db.Types.UUID, ref: 'User', required: true },
    raisedByName: { type: String, default: '' },
    raisedAt:     { type: Date, default: Date.now },

    status: { type: String, enum: ['open', 'monitoring', 'referred', 'closed'], default: 'open' },
    referral: { type: Object, default: null },               // { to, reference, at, byName, note }
    notes:    { type: Array, default: [] },                  // [{ at, by, byName, text }] — the leads' record
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: '' },
}, { timestamps: true });

MedicalSafeguardingConcernSchema.index({ school: 1, number: 1 }, { unique: true });
MedicalSafeguardingConcernSchema.index({ school: 1, status: 1, raisedAt: -1 });
MedicalSafeguardingConcernSchema.index({ school: 1, raisedBy: 1 });

module.exports = db.model('MedicalSafeguardingConcern', MedicalSafeguardingConcernSchema);
