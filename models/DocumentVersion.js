const db = require('../db/orm');

const FileSchema = new db.Schema({
    originalName: { type: String, required: true },
    storedName:   { type: String, required: true },
    filePath:     { type: String, required: true },
    mimeType:     { type: String, required: true },
    fileSize:     { type: Number, required: true },
}, { _id: false });

const DocumentVersionSchema = new db.Schema({
    document: {
        type: db.Types.UUID,
        ref: 'Document',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    versionNumber: {
        type: Number,
        required: true,
    },
    files: {
        type: [FileSchema],
        default: [],
    },
    uploadedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    changeNote: {
        type: String,
        default: '',
    },
}, { timestamps: true });

DocumentVersionSchema.index({ document: 1, versionNumber: 1 });

module.exports = db.model('DocumentVersion', DocumentVersionSchema);
