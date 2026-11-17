'use strict';
/**
 * A document is never a picture (Nov 2026).
 *
 * A student's "photo" slot used to take any admission paper, so a PDF saved
 * there became the student's profile picture. Every list then asked the browser
 * to draw that PDF in an <img>; uploads come from the API's own origin, and
 * Chrome blocks a cross-origin PDF read as an image (CORB) — the console filled
 * with "Response was blocked by CORB" and the avatar broke.
 *
 * The photo slots now take pictures only (middleware/upload.js). These guard
 * the places that turn a stored file into a picture:
 *
 *   isDocument(path)   plainly a document — pdf, Word, Excel, PowerPoint,
 *                      text. Only documents are refused: a picture can arrive
 *                      with an unusual name (a phone's "IMG_0001.HEIC" holding
 *                      a JPEG) and a sign-in picture is a URL with no extension
 *                      at all, and both must still show.
 *   photoOf(...paths)  the first candidate that is not a document, else ''.
 */
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)(\?.*)?$/i;

const isDocument = (path) => DOCUMENT.test(String(path || ''));

const photoOf = (...candidates) => candidates.find((c) => c && !isDocument(c)) || '';

module.exports = { isDocument, photoOf, DOCUMENT };
