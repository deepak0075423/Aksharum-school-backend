const db = require('../db/orm');

const DocumentCategorySchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    name:     { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });

DocumentCategorySchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('DocumentCategory', DocumentCategorySchema);
