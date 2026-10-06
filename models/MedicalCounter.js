const db = require('../db/orm');

/** Running numbers for requests, visits and incidents, per school and month. */
const MedicalCounterSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    kind:   { type: String, required: true },
    period: { type: String, required: true },
    value:  { type: Number, default: 0 },
}, { timestamps: true });

MedicalCounterSchema.index({ school: 1, kind: 1, period: 1 }, { unique: true });

module.exports = db.model('MedicalCounter', MedicalCounterSchema);
