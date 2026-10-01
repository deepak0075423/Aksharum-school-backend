const db = require('../db/orm');

// One running number per school and series ("HF" invoices, "OP" outpasses …).
//
// Document numbers used to be `count of rows + 1`. That repeats a number as
// soon as a row is deleted (a visitor taken off a list), and two requests at
// the same instant read the same count. The counter is bumped in a single
// UPDATE, so a number is handed out once.
const HostelCounterSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    key: { type: String, required: true },
    value: { type: Number, default: 0 },
}, { timestamps: true });

HostelCounterSchema.index({ school: 1, key: 1 }, { unique: true });

module.exports = db.model('HostelCounter', HostelCounterSchema);
