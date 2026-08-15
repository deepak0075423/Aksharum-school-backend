'use strict';
/**
 * Resolve a school's logo to a file on disk so PDFs can embed it.
 * pdfkit can only draw local files/buffers, so remotely hosted logos (http URLs)
 * are skipped — callers fall back to the school name alone.
 */
const fs   = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const ALLOWED_EXT  = new Set(['.png', '.jpg', '.jpeg']);   // formats pdfkit can embed

/**
 * @param   {Object|String} school  School document (or the raw logo value)
 * @returns {String|null}           Absolute path to the logo, or null
 */
function schoolLogoPath(school) {
    const logo = typeof school === 'string' ? school : school?.logo;
    if (!logo || /^https?:\/\//i.test(logo)) return null;

    // Stored either as a bare filename or as "/uploads/images/<file>"
    const rel = logo.replace(/^\/+/, '').startsWith('uploads/')
        ? logo.replace(/^\/+/, '').slice('uploads/'.length)
        : path.join('images', logo);

    const full = path.join(UPLOADS_ROOT, rel);
    // Never let a crafted value walk outside the uploads directory
    if (!full.startsWith(UPLOADS_ROOT)) return null;
    if (!ALLOWED_EXT.has(path.extname(full).toLowerCase())) return null;

    try {
        return fs.existsSync(full) ? full : null;
    } catch {
        return null;
    }
}

module.exports = { schoolLogoPath };
