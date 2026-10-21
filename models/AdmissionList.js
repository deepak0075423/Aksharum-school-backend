const db = require('../db/orm');

/**
 * A selection list for one class of one round: the first list, the second,
 * a final list. Built from the school's criteria (weights over exam results
 * and interview scores, its own tie-breakers) into AdmissionListEntry rows,
 * then edited by hand where the office decides to, approved, and published —
 * on the spot or at a set time. Publishing issues the offers.
 *
 *   criteria   { weights: [{ source, weight, label }], tieBreakers: [...],
 *                filters: { statuses, requirePass, minScore } }
 *              `source` is 'exam:<id>' (percentage) or 'exam:<id>:raw'.
 *   seats      how many are selected (the rest who qualify are waitlisted,
 *              up to waitlistSize)
 *   visibility what the published list shows families
 */
const AdmissionListSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    round:        { type: db.Types.UUID, ref: 'AdmissionRound', required: true },
    class:        { type: db.Types.UUID, ref: 'Class', required: true },
    name:         { type: String, required: true, trim: true },
    listNo:       { type: Number, default: 1 },
    kind:         { type: String, enum: ['merit', 'waiting', 'final'], default: 'merit' },
    // How the list orders applicants: merit (scores), lottery (a random draw),
    // points_lottery (priority points, then a draw) — services/admission/lottery.js.
    method:       { type: String, enum: ['merit', 'lottery', 'points_lottery'], default: 'merit' },
    // The seat pool the list fills: a quota's key, or '' for the general seats.
    quota:        { type: String, default: '' },
    // A lottery's secret, made when the list is: only its hash (the
    // commitment) is shown until the draw, when the draw record reveals it.
    lotteryNonce:      { type: String, default: '' },
    lotteryCommitment: { type: String, default: '' },
    // The draw, once made — final: { algorithm, at, by, byName, phrase, witnesses,
    // nonce, commitment, input, inputHash, seed, poolSize, selected, waitlisted }.
    draw:         { type: db.Types.JSON, default: null },
    cancelReason: { type: String, default: '' },
    criteria:     { type: db.Types.JSON, default: () => ({ weights: [], tieBreakers: [], filters: {} }) },
    seats:        { type: Number, default: 0 },
    waitlistSize: { type: Number, default: 0 },
    status:       { type: String, enum: ['draft', 'pending_approval', 'approved', 'published', 'closed', 'cancelled'], default: 'draft' },
    publishAt:    { type: Date, default: null },
    publishedAt:  { type: Date, default: null },
    submittedBy:  { type: db.Types.UUID, ref: 'User', default: null },
    approvedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt:   { type: Date, default: null },
    acceptanceDeadline: { type: Date, default: null },
    paymentDeadline:    { type: Date, default: null },
    visibility:   { type: db.Types.JSON, default: () => ({ showRank: true, showScore: false, showNames: false }) },
    notes:        { type: String, default: '' },
    generatedAt:  { type: Date, default: null },
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

AdmissionListSchema.index({ round: 1, class: 1, listNo: 1 }, { unique: true });
AdmissionListSchema.index({ school: 1, status: 1 });

module.exports = db.model('AdmissionList', AdmissionListSchema);
