'use strict';
/**
 * Every phone number a request carries, checked and stored the same way.
 *
 * The platform is India-only: a phone number is a 10-digit mobile number with
 * no country code (utils/validators isPhone). Phone fields live in a dozen
 * modules, several of which store what they are sent as it is, so the rule is
 * applied here, to every request body, rather than trusted to each handler:
 *
 *   - a phone field ("phone", "guardianPhone", "doctor.phone" …) is rewritten
 *     to its ten digits — "+91 98765 43210" or "098765-43210" from an older
 *     app or a pasted number arrives as 9876543210;
 *   - one that is not a valid number is refused with a 400 naming the field;
 *   - an empty one passes — whether it is required is the handler's business.
 *
 * It runs after the JSON and form parsers (server.js), and after multer for a
 * multipart form (middleware/upload.js), whose fields only exist once the
 * upload has been read. A field sent as a JSON string inside a multipart form,
 * and the rows of an Excel/CSV import, are not seen here — their handlers
 * check them (normalizePhone / isPhone).
 */
const { normalizePhone, isPhone } = require('../utils/validators');

// Keys that hold a phone number wherever they appear in a body.
const FIELDS = {
    phone: 'Phone number',
    mobile: 'Mobile number',
    guardianPhone: 'Guardian phone',
    emergencyContactPhone: 'Emergency contact phone',
    alternatePhone: 'Secondary phone',
    contactNumber: 'Contact number',
    contactPhone: 'Contact number',
    doctorPhone: 'Doctor\'s phone',
    roomPhone: 'The room\'s phone',
    vendorContact: 'Vendor contact',
    previousSchoolContact: 'Previous school contact',
    fatherPhone: 'Father\'s phone',
    motherPhone: 'Mother\'s phone',
    parentPhone: 'Parent\'s phone',
    officialPhone: 'Official phone',
    emergencyPhone: 'Emergency phone',
};
// A plain "phone" inside one of these is named after it.
const OWNER = {
    father: 'Father\'s phone', mother: 'Mother\'s phone', guardian: 'Guardian\'s phone',
    doctor: 'Doctor\'s phone', hospital: 'Hospital phone',
    emergencyContact: 'Emergency contact phone', alternateContact: 'Alternate contact phone',
    driver: 'Driver\'s phone', attendant: 'Attendant\'s phone',
};
const MAX_DEPTH = 8;

/** Rewrites the phone fields of `node` in place; returns the first refusal, or null. */
function check(node, owner = null, depth = 0) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
    if (Array.isArray(node)) {
        for (const x of node) { const bad = check(x, owner, depth + 1); if (bad) return bad; }
        return null;
    }
    for (const [key, value] of Object.entries(node)) {
        if (Object.prototype.hasOwnProperty.call(FIELDS, key) && (typeof value === 'string' || typeof value === 'number')) {
            if (String(value).trim() === '') continue;
            if (!isPhone(value)) return `${(key === 'phone' && OWNER[owner]) || FIELDS[key]} must be a valid 10-digit mobile number`;
            node[key] = normalizePhone(value);
        } else if (value && typeof value === 'object') {
            const bad = check(value, key, depth + 1);
            if (bad) return bad;
        }
    }
    return null;
}

function phoneFields(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const bad = check(req.body);
    if (bad) return res.status(400).json({ success: false, message: bad, code: 'INVALID_PHONE' });
    return next();
}

module.exports = { phoneFields, checkPhoneFields: check, PHONE_FIELDS: FIELDS };
