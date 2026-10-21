'use strict';
/**
 * The public side of a school's admission portal — no sign-in: what the
 * landing page shows, and the applicant's account: register, verify, sign in,
 * reset. The school is always the one behind the address (req.portal, set by
 * services/admission/access.publicPortal), never one a request names.
 */
const pool = require('../db/pool');
const AdmissionEnquiry = require('../models/AdmissionEnquiry');
const guestAuth = require('../services/admission/guestAuth');
const { sessionPayload } = require('./auth.controller');
const { schoolLogoUrl } = require('../utils/schoolMailer');
const { isEmail, isPhone, normalizePhone } = require('../utils/validators');
const { nameProblem, textProblem } = require('../utils/textRules');
const { clientIp } = require('../middleware/rateLimit');
const { handler, refuse, str, isId } = require('../services/admission/util');

const TAG = 'admission public';

/** Everything the landing page needs, and nothing that is not public. */
/**
 * A published lottery's draw record (Oct 2026) — open to anyone, as a draw
 * should be: who was in it (by application number, never by name), their
 * points, the values the order was made from, and the order. Anyone can
 * recompute it (scripts/verifyLottery.js). Draws of the same class that were
 * cancelled are listed too, with why.
 */
exports.lottery = handler(async (req, res) => {
    const { school } = req.portal;
    if (!isId(String(req.params.listId || ''))) refuse('Draw not found', 404);
    const { rows: [l] } = await pool.query(
        `SELECT l.*, c."className", r."name" AS "roundName", y."yearName" FROM "admissionlists" l
           LEFT JOIN "classes" c ON c."_id" = l."class" LEFT JOIN "admissionrounds" r ON r."_id" = l."round"
           LEFT JOIN "academicyears" y ON y."_id" = r."academicYear"
          WHERE l."_id" = $1 AND l."school" = $2 AND l."status" IN ('published', 'closed') AND l."method" <> 'merit' AND l."draw" IS NOT NULL`,
        [String(req.params.listId), String(school._id)]);
    if (!l) refuse('Draw not found', 404);
    const { rows: entries } = await pool.query(
        `SELECT e."rank", e."score", e."decision", e."waitPosition", e."breakdown"->>'drawKey' AS "drawKey", a."applicationNumber"
           FROM "admissionlistentries" e JOIN "admissionapplications" a ON a."_id" = e."application"
          WHERE e."list" = $1 AND e."rank" IS NOT NULL ORDER BY e."rank"`, [String(l._id)]);
    const { rows: cancelled } = await pool.query(
        `SELECT "name", "cancelReason", "updatedAt", ("draw" IS NOT NULL) AS "drawn" FROM "admissionlists"
          WHERE "school" = $1 AND "round" = $2 AND "class" = $3 AND "status" = 'cancelled' AND "draw" IS NOT NULL ORDER BY "updatedAt"`,
        [String(school._id), String(l.round), String(l.class)]);
    const d = l.draw || {};
    res.json({
        success: true,
        data: {
            _id: l._id, name: l.name, className: l.className, roundName: l.roundName, yearName: l.yearName, method: l.method, publishedAt: l.publishedAt,
            pointsRules: (l.criteria?.points || []).map((r) => ({ label: r.label, points: r.points })),
            draw: {
                algorithm: d.algorithm, at: d.at, phrase: d.phrase, witnesses: d.witnesses || [], nonce: d.nonce, commitment: d.commitment,
                inputHash: d.inputHash, seed: d.seed, poolSize: d.poolSize, seats: d.target, waitingPlaces: l.waitlistSize || 0,
            },
            entries: entries.map((e) => ({
                drawNo: e.rank, applicationNumber: e.applicationNumber, points: Number(e.score) || 0, drawKey: e.drawKey || '',
                decision: e.decision, waitPosition: e.waitPosition,
            })),
            cancelled: cancelled.map((c) => ({ name: c.name, reason: c.cancelReason, at: c.updatedAt })),
        },
    });
}, TAG);

exports.portal = handler(async (req, res) => {
    const { school, settings, slug } = req.portal;
    const p = settings.portal;
    const now = new Date();
    const { rows: rounds } = await pool.query(
        `SELECT r."_id", r."name", r."type", r."description", r."campus", r."opensAt", r."closesAt", r."documentDeadline",
                r."applicationFee", r."admissionFee", r."classes", r."status", y."yearName"
           FROM "admissionrounds" r LEFT JOIN "academicyears" y ON y."_id" = r."academicYear"
          WHERE r."school" = $1 AND r."status" = 'open' ORDER BY r."opensAt" NULLS FIRST, r."name"`, [String(school._id)]);
    const classIds = [...new Set(rounds.flatMap((r) => (r.classes || []).map((c) => String(c.class))))];
    const { rows: classes } = classIds.length
        ? await pool.query(`SELECT "_id", "className", "classNumber" FROM "classes" WHERE "_id" = ANY($1::uuid[])`, [classIds])
        : { rows: [] };
    const className = new Map(classes.map((c) => [String(c._id), c]));
    const { rows: docTypes } = await pool.query(
        `SELECT "key", "name", "description", "required", "accept", "maxSizeMB" FROM "admissiondocumenttypes"
          WHERE "school" = $1 AND "isActive" ORDER BY "order", "name"`, [String(school._id)]);
    const { rows: exams } = await pool.query(
        `SELECT e."name", e."mode", e."startsAt" FROM "admissionexams" e JOIN "admissionrounds" r ON r."_id" = e."round" AND r."status" = 'open'
          WHERE e."school" = $1 AND e."status" = 'scheduled' AND e."startsAt" > now() ORDER BY e."startsAt" LIMIT 10`, [String(school._id)]);
    const gateway = await require('../services/admission/payments').gatewayInfo(school._id);
    const cookiePolicy = require('../services/cookiePolicy');
    const cookieBanner = cookiePolicy.bannerView((await cookiePolicy.getPolicy(school._id)).policy);
    res.json({
        success: true,
        data: {
            slug,
            school: {
                _id: school._id, name: school.name, logo: schoolLogoUrl(school), board: school.board || '',
                address: [school.address, school.city, school.state, school.pincode].filter(Boolean).join(', '),
                website: school.website || '',
            },
            portal: {
                status: p.status, title: p.title, tagline: p.tagline, description: p.description, instructions: p.instructions,
                announcement: p.announcement?.enabled ? p.announcement : null,
                maintenanceMessage: p.status === 'maintenance' ? p.maintenanceMessage : '',
                closedMessage: p.status === 'closed' ? p.closedMessage : '',
                theme: p.theme, header: p.header, footer: p.footer, contact: p.contact, help: p.help,
                sections: (p.sections || []).filter((s) => s.enabled),
                loginText: p.loginText, registerText: p.registerText,
                privacyNotice: p.privacyNotice, privacyVersion: p.privacyVersion, declaration: p.declaration,
                privacyContact: settings.privacy?.officer?.email || settings.privacy?.officer?.phone ? settings.privacy.officer : null,
                enquiries: !!p.enquiries,
                visits: !!settings.visits?.enabled,
                captcha: require('../services/admission/captcha').forPortal(settings),
            },
            rounds: rounds.map((r) => ({
                _id: r._id, name: r.name, type: r.type, description: r.description, campus: r.campus, yearName: r.yearName,
                opensAt: r.opensAt, closesAt: r.closesAt, documentDeadline: r.documentDeadline,
                open: (!r.opensAt || new Date(r.opensAt) <= now) && (!r.closesAt || new Date(r.closesAt) >= now),
                classes: (r.classes || []).filter((c) => c.isOpen !== false).map((c) => ({
                    _id: String(c.class), className: className.get(String(c.class))?.className || 'Class',
                    classNumber: className.get(String(c.class))?.classNumber ?? null,
                    applicationFee: Number(c.applicationFee ?? r.applicationFee) || 0,
                    eligibility: c.eligibility ? {
                        minAgeYears: c.eligibility.minAgeYears, maxAgeYears: c.eligibility.maxAgeYears, ageOn: c.eligibility.ageOn,
                        dobFrom: c.eligibility.dobFrom, dobTo: c.eligibility.dobTo, notes: c.eligibility.notes,
                    } : null,
                })).sort((a, b) => (a.classNumber ?? 999) - (b.classNumber ?? 999)),
            })),
            documents: docTypes,
            upcomingExams: exams,
            onlinePayment: !!gateway.enabled,
            cookies: cookieBanner,
        },
    });
}, TAG);

const ip = (req) => clientIp(req);

exports.register = handler(async (req, res) => {
    const r = await guestAuth.register(req.portal, req.body || {}, { ip: ip(req), source: req.body?.source });
    res.json({ success: true, ...r });
}, TAG);

exports.resend = handler(async (req, res) => {
    const r = await guestAuth.resendRegistration(req.portal, req.body || {}, { ip: ip(req) });
    res.json({ success: true, ...r });
}, TAG);

exports.verify = handler(async (req, res) => {
    const r = await guestAuth.verifyRegistration(req.portal, req.body || {});
    if (r.status === 'exists') return res.json({ success: true, status: 'exists', message: r.message });
    if (r.status === 'linked' && !r.session) return res.json({ success: true, status: 'linked', message: r.message });
    const session = await sessionPayload(r.row);
    if (!session) refuse('Your account could not be opened — please sign in', 409);
    return res.json({ success: true, status: r.status, message: r.message || 'Your email is verified and your account is ready.', ...session });
}, TAG);

exports.login = handler(async (req, res) => {
    const row = await guestAuth.login(req.portal, req.body || {});
    const session = await sessionPayload(row);
    if (!session) refuse('Invalid email or password', 401);
    res.json({ success: true, ...session });
}, TAG);

exports.forgot = handler(async (req, res) => {
    const r = await guestAuth.forgot(req.portal, req.body || {}, { ip: ip(req) });
    res.json({ success: true, ...r });
}, TAG);

exports.reset = handler(async (req, res) => {
    const row = await guestAuth.reset(req.portal, req.body || {});
    const session = await sessionPayload(row);
    res.json({ success: true, message: 'Your password has been changed.', ...(session || {}) });
}, TAG);

/** An enquiry from someone not yet registered. */
exports.enquiry = handler(async (req, res) => {
    const { school, settings } = req.portal;
    if (!settings.portal.enquiries) refuse('Enquiries are not taken online — please contact the school', 403);
    const b = req.body || {};
    const name = str(b.name, 100);
    const badName = name ? nameProblem(name, 'Your name') : 'Your name is required';
    if (badName) refuse(badName, 400, { field: 'name' });
    const email = str(b.email, 200).toLowerCase();
    const phone = normalizePhone(str(b.phone, 20));
    if (!email && !phone) refuse('Give an email or a mobile number so the school can reply', 400, { field: 'email' });
    if (email && !isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    if (phone && !isPhone(phone)) refuse('Enter a valid 10-digit mobile number', 400, { field: 'phone' });
    const message = str(b.message, 1000);
    const bad = textProblem(message, 'Your message'); if (bad) refuse(bad, 400, { field: 'message' });
    let classId = null;
    if (b.class && isId(String(b.class))) {
        const { rows } = await pool.query(`SELECT "_id" FROM "classes" WHERE "_id" = $1 AND "school" = $2`, [String(b.class), String(school._id)]);
        classId = rows[0]?._id || null;
    }
    // A form re-sent in a hurry does not make two enquiries.
    const { rows: dup } = await pool.query(
        `SELECT "_id" FROM "admissionenquiries" WHERE "school" = $1 AND ("email" = $2 AND $2 <> '' OR "phone" = $3 AND $3 <> '') AND "createdAt" > now() - interval '10 minutes' LIMIT 1`,
        [String(school._id), email, phone]);
    if (!dup.length) {
        await AdmissionEnquiry.create({ school: school._id, name, email, phone, class: classId, message, source: str(b.source, 60) });
        const admins = await require('../services/designationService').moduleAdminIds(school._id, 'admission');
        if (admins.length) {
            require('../services/notifyService').notify({
                school: school._id, sender: admins[0], senderRole: 'system', recipients: admins, includeSender: true,
                title: `New admission enquiry from ${name}`, body: message || 'An enquiry was left on the admission portal.', link: { type: 'admission.enquiries' },
            });
        }
    }
    res.json({ success: true, message: 'Thank you — the admission office will get back to you.' });
}, TAG);


// ── Paying by link (services/admission/payLink.js) ───────────────────────────

async function linkedApplication(req) {
    const link = require('../services/admission/payLink').read(req.params.token, req.portal.school._id);
    const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1 AND "school" = $2`, [link.applicationId, String(req.portal.school._id)]);
    if (!app) refuse('This payment link is not valid', 404);
    return { app, link };
}

exports.payLink = handler(async (req, res) => {
    const { app, link } = await linkedApplication(req);
    const payments = require('../services/admission/payments');
    const b = await payments.balance(app, link.kind);
    const plan = link.kind === 'admission_fee' ? await payments.scheduleOf(app, b) : null;
    const gateway = await payments.gatewayInfo(app.school);
    res.set('Cache-Control', 'no-store').json({
        success: true,
        data: {
            schoolName: req.portal.school.name, applicationNumber: app.applicationNumber, studentFirstName: String(app.studentName || '').split(/\s+/)[0],
            kind: link.kind, kindLabel: payments.LABEL[link.kind], due: b.due, expiresAt: link.expiresAt,
            nextInstalment: plan ? plan.find((x) => x.owing > 0) || null : null,
            online: !!gateway.enabled, keyId: gateway.enabled ? gateway.keyId || null : null,
        },
    });
}, TAG);

// Who the history names for a payment made by a link: the family's side, no account.
const VIA_LINK = { userId: null, role: 'guest', name: 'Payment link' };

exports.payLinkOrder = handler(async (req, res) => {
    const { app, link } = await linkedApplication(req);
    const payments = require('../services/admission/payments');
    res.json({ success: true, data: await payments.createOrder(VIA_LINK, app, link.kind, { part: req.body?.part === 'instalment' ? 'instalment' : 'all' }) });
}, TAG);

exports.payLinkVerify = handler(async (req, res) => {
    const { app } = await linkedApplication(req);
    const b = req.body || {};
    const pay = await require('../services/admission/payments').verifyOnline(VIA_LINK, app, {
        orderId: b.razorpay_order_id || b.orderId, paymentId: b.razorpay_payment_id || b.paymentId, signature: b.razorpay_signature || b.signature,
    });
    res.json({ success: true, data: { receiptNumber: pay.receiptNumber, amount: pay.amount, paidAt: pay.paidAt, paymentId: pay._id } });
}, TAG);

exports.payLinkReceipt = handler(async (req, res) => {
    const { app } = await linkedApplication(req);
    await require('../services/admission/receipts').send(req, res, app, req.params.paymentId);
}, TAG);

/** PIN code → state, district and post offices (the ERP's own lookup, services/pincodes.js). */
exports.pincode = handler(async (req, res) => {
    const pin = String(req.params.pincode || '').trim();
    if (!/^[1-9]\d{5}$/.test(pin)) refuse('A PIN code is six digits', 400);
    const r = await require('../services/pincodes').lookup(pin);
    if (!r || (!r.state && !r.district)) refuse(`No place found for PIN code ${pin}`, 404);
    res.set('Cache-Control', 'public, max-age=86400').json({ success: true, data: { pincode: r.pincode, state: r.state, district: r.district, city: r.city, areas: r.areas.slice(0, 30), source: r.source } });
}, TAG);

// ── The portal as an app on a phone's home screen (Oct 2026) ─────────────────

const front = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const initialsOf = (name) => String(name || 'School').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).map((w) => w[0].toUpperCase()).slice(0, 2).join('') || 'S';

/** A web app manifest for this school's portal: its name, colour and start page; installable on its own. */
exports.manifest = handler(async (req, res) => {
    const { school, settings } = req.portal;
    const p = settings.portal || {};
    const base = `${front()}/${settings.slug}/`;
    const name = `${school.name} Admissions`.slice(0, 60);
    res.set('Content-Type', 'application/manifest+json; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify({
        id: base, name, short_name: `${initialsOf(school.name)} Admissions`.slice(0, 20),
        description: `Apply to ${school.name} and follow every step of the admission.`.slice(0, 200),
        start_url: `${base}dashboard`, scope: base, display: 'standalone', orientation: 'portrait',
        theme_color: p.theme?.primary || '#4f46e5', background_color: '#f6f7fb',
        icons: [
            // Served by this API, wherever it lives (its own origin, as receipts do).
            { src: `${req.protocol}://${req.get('host')}/api/admission/public/portals/${encodeURIComponent(settings.slug)}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: `${front()}/android-chrome-192x192.png`, sizes: '192x192', type: 'image/png' },
            { src: `${front()}/android-chrome-512x512.png`, sizes: '512x512', type: 'image/png' },
        ],
    }));
}, TAG);

/** The app icon: the school's initials on its own colours. Letters and colours only — nothing typed is drawn as markup. */
exports.icon = handler(async (req, res) => {
    const { school, settings } = req.portal;
    const t = settings.portal?.theme || {};
    const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : d);
    const a = hex(t.primary, '#4f46e5');
    const b = hex(t.accent, '#7c3aed');
    const text = initialsOf(school.name).replace(/[^A-Z]/g, '');
    res.set('Content-Type', 'image/svg+xml; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`
        + `<rect width="512" height="512" rx="112" fill="url(#g)"/><text x="256" y="300" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${text.length > 1 ? 200 : 240}" font-weight="800" fill="#fff">${text}</text></svg>`);
}, TAG);
