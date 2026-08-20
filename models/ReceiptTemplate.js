const db = require('../db/orm');

// One saved receipt design, per school, per module ('fees' | 'library'), per
// payment mode ('online' | 'offline'). A school that wants one design for both
// modes saves the same choice twice — which the controller does for them when
// "use the same for both" is ticked — so the render path never has to ask which
// case it is in.
const ReceiptTemplateSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
        index: true,
    },
    module: {
        type: String,
        enum: ['fees', 'library'],
        required: true,
    },
    // Which payments this design is used for.
    paymentMode: {
        type: String,
        enum: ['online', 'offline'],
        required: true,
    },
    // Which of the shipped designs this is based on.
    preset: {
        type: String,
        enum: ['classic', 'modern', 'compact', 'formal', 'minimal'],
        default: 'classic',
    },
    accentColor: { type: String, default: '#4F46E5', trim: true },
    headerText:  { type: String, default: '', trim: true },
    footerText:  { type: String, default: 'This is a computer-generated receipt.', trim: true },
    notes:       { type: String, default: '', trim: true },
    signatoryName: { type: String, default: '', trim: true },

    showLogo:        { type: Boolean, default: true },
    showBreakdown:   { type: Boolean, default: true },
    showSignature:   { type: Boolean, default: true },
    showPaymentMode: { type: Boolean, default: true },

    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

// One design per school + module + mode.
ReceiptTemplateSchema.index({ school: 1, module: 1, paymentMode: 1 }, { unique: true });

module.exports = db.model('ReceiptTemplate', ReceiptTemplateSchema);
