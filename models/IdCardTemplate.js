const db = require('../db/orm');

/**
 * A school's design for one kind of ID card (Oct 2026) — student, teacher,
 * staff or parent. Created on first read with the defaults in
 * services/idCardDesign; `design` is validated there before it is stored.
 *
 * A card copies the design when it is issued (IdCard.design), so editing a
 * template changes the cards issued after it — and, only when the office
 * says so, the cards in use (services/idCardService.applyDesign). Cards from
 * years gone by always keep the look they were issued with.
 */
const IdCardTemplateSchema = new db.Schema({
    school:    { type: db.Types.UUID, ref: 'School', required: true },
    kind:      { type: String, enum: ['student', 'teacher', 'staff', 'parent'], required: true },
    design:    { type: Object, default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
});

IdCardTemplateSchema.index({ school: 1, kind: 1 }, { unique: true });

module.exports = db.model('IdCardTemplate', IdCardTemplateSchema);
