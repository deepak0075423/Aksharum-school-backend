const db = require('../db/orm');

// A menu entry (spec §15). One row per mess per date per meal for a dated menu,
// or per weekday when `isTemplate` is set — the weekly template the daily menu
// is generated from. Monthly views are just a date-range read of the same rows.
const HostelMenuSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    mess: { type: db.Types.UUID, ref: 'HostelMess', required: true, index: true },

    isTemplate: { type: Boolean, default: false },
    dayOfWeek: { type: Number, default: null },                // 0=Sun … 6=Sat (templates)
    date: { type: Date, default: null },                       // local midnight (dated menus)

    meal: { type: String, enum: ['breakfast', 'lunch', 'snacks', 'dinner', 'special'], required: true },
    items: { type: [String], default: [] },
    description: { type: String, default: '' },
    isSpecial: { type: Boolean, default: false },
    specialOccasion: { type: String, default: '' },
    estimatedCost: { type: Number, default: 0 },

    status: { type: String, enum: ['draft', 'published', 'cancelled'], default: 'published' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMenuSchema.index({ school: 1, mess: 1, date: 1, meal: 1 });
HostelMenuSchema.index({ school: 1, mess: 1, isTemplate: 1, dayOfWeek: 1, meal: 1 });

module.exports = db.model('HostelMenu', HostelMenuSchema);
