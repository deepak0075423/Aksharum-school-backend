const db = require('../db/orm');

/**
 * What a student must not do, or needs, for a while (Oct 2026): no PE after a
 * sprain, extra water and toilet breaks, rest breaks, a seat near the door.
 * Teachers see `teacherText` — what to do, never why; the reason stays with
 * the medical staff and the family. It runs from `startsOn` to `endsOn`
 * (`null` = until the medical staff end it); `endedAt` ends it early.
 */
const MedicalRestrictionSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },
    visit:   { type: db.Types.UUID, ref: 'MedicalVisit', default: null },

    kind: {
        type: String,
        enum: ['no_pe', 'no_sports', 'no_outdoor', 'no_stairs', 'extra_water', 'toilet_access', 'rest_breaks', 'seating', 'diet', 'screen', 'other'],
        default: 'other',
    },
    teacherText: { type: String, required: true, trim: true },   // "No PE or games — may watch"
    reason:      { type: String, default: '', trim: true },      // "Sprained left ankle" — staff and family only
    startsOn:    { type: Date, required: true },
    endsOn:      { type: Date, default: null },

    endedAt:   { type: Date, default: null },
    endedBy:   { type: db.Types.UUID, ref: 'User', default: null },
    endedByName: { type: String, default: '' },
    endNote:   { type: String, default: '' },

    createdBy:     { type: db.Types.UUID, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalRestrictionSchema.index({ school: 1, student: 1 });
MedicalRestrictionSchema.index({ school: 1, startsOn: 1, endsOn: 1 });

module.exports = db.model('MedicalRestriction', MedicalRestrictionSchema);
