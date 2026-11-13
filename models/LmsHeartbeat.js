const db = require('../db/orm');

// Every heartbeat a player sent, as it arrived and as it was judged: the raw
// record behind LmsWatchSession and LmsProgress. (session, seq) is unique —
// that is what makes a heartbeat sent twice count once. Old rows are pruned
// by the sweep; the totals they produced live on in the session and progress.
const LmsHeartbeatSchema = new db.Schema({
    session:     { type: db.Types.UUID, ref: 'LmsWatchSession', required: true },
    student:     { type: db.Types.UUID, ref: 'User', required: true },
    video:       { type: db.Types.UUID, ref: 'LmsVideo', required: true },
    seq:         { type: Number, required: true },
    positionSec: { type: Number, default: 0 },
    state:       { type: String, default: 'playing' },
    elapsedSec:  { type: Number, default: 0 },     // what the player said had passed
    creditedSec: { type: Number, default: 0 },     // what the server counted
    accepted:    { type: Boolean, default: true },
    reason:      { type: String, default: '' },
}, { timestamps: true });

LmsHeartbeatSchema.index({ session: 1, seq: 1 }, { unique: true });
LmsHeartbeatSchema.index({ createdAt: 1 });

module.exports = db.model('LmsHeartbeat', LmsHeartbeatSchema);
