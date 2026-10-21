'use strict';
/**
 * Cookie policies (Oct 2026): what a school's portal and app store in the
 * browser, why, and what a visitor has agreed to.
 *
 * A school admin sets it up under School Settings → Privacy & cookies. The
 * policy is validated data, like every other school setting: the school names
 * a Google Analytics or Meta Pixel ID, never a script, and those tags load only
 * on the portal's public pages, only after the visitor agrees to their
 * category. Essential storage (signing in, the consent choice itself, opening
 * private files) is always on and is listed so the policy stays honest.
 *
 * `version` rises only when what a visitor agrees to changes — a category
 * switched on or off, a tag added, an item moved between categories. A
 * reworded paragraph does not make every visitor answer the banner again.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const CookiePolicy = require('../models/CookiePolicy');
const CookieConsent = require('../models/CookieConsent');
const { textProblem } = require('../utils/textRules');
const { isEmail } = require('../utils/validators');

const OPTIONAL = ['preferences', 'analytics', 'marketing'];
const CATEGORIES = ['essential', ...OPTIONAL];
const TYPES = ['cookie', 'local_storage', 'session_storage'];
const ACTIONS = ['accept_all', 'reject_all', 'custom', 'withdraw'];
const LABEL = { essential: 'Essential', preferences: 'Preferences', analytics: 'Analytics', marketing: 'Advertising' };
const GA4 = /^G-[A-Z0-9]{4,15}$/;
const PIXEL = /^\d{8,20}$/;
const VISITOR = /^[A-Za-z0-9-]{16,64}$/;

function refuse(message, status = 400, field = null) {
    const e = new Error(message);
    e.status = status;
    e.expose = true;
    if (field) e.field = field;
    throw e;
}

function text(v, label, { max = 200, kind = 'text', required = false, field = null } = {}) {
    const s = String(v ?? '').trim();
    if (!s) {
        if (required) refuse(`${label} is required`, 400, field);
        return '';
    }
    if (s.length > max) refuse(`${label} must be at most ${max} characters`, 400, field);
    const bad = textProblem(s, label, kind);
    if (bad) refuse(bad, 400, field);
    return s;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DESCRIPTIONS = {
    essential: 'Needed for the site to work: keeping you signed in, remembering your cookie choices and opening your documents securely. These cannot be switched off and are never used to track you.',
    preferences: 'Remember choices you make, such as how a page is laid out, so you do not have to make them again.',
    analytics: 'Count visits and see which pages are used, so the school can improve the portal. The information is combined and does not identify you.',
    marketing: 'Measure which advertisements bring families to the portal. Used only on the portal\'s public pages.',
};

/** What the platform itself stores — always listed, so the policy is never short of the truth. */
const PLATFORM_ITEMS = [
    { name: 'aks_cookie_consent', provider: 'This site', category: 'essential', type: 'local_storage', duration: 'As set below', purpose: 'Remembers the choices you made on the cookie banner.' },
    { name: 'token, refreshToken', provider: 'This site', category: 'essential', type: 'local_storage', duration: 'Until you sign out', purpose: 'Keep you signed in to your account.' },
    { name: 'portalSlug', provider: 'This site', category: 'essential', type: 'local_storage', duration: 'Until cleared', purpose: 'Remembers which school\'s admission portal you used.' },
    { name: 'aks_ft', provider: 'This site', category: 'essential', type: 'cookie', duration: '12 hours', purpose: 'Lets signed-in staff, students and parents open private documents securely. Not set on the admission portal.' },
    { name: 'schoolBranding', provider: 'This site', category: 'essential', type: 'local_storage', duration: 'Until cleared', purpose: 'Shows your school\'s name and logo on the sign-in page.' },
    { name: 'Checkout cookies', provider: 'Razorpay', category: 'essential', type: 'cookie', duration: 'Set by Razorpay', purpose: 'Set by the payment provider\'s checkout only when you pay online, to process the payment securely.' },
];

const INTEGRATION_ITEMS = {
    ga4: (id) => [
        { name: '_ga', provider: 'Google Analytics', category: 'analytics', type: 'cookie', duration: '2 years', purpose: 'Tells visits from different browsers apart.' },
        { name: `_ga_${id.replace(/^G-/, '')}`, provider: 'Google Analytics', category: 'analytics', type: 'cookie', duration: '2 years', purpose: 'Keeps the state of a visit.' },
    ],
    pixel: () => [
        { name: '_fbp', provider: 'Meta', category: 'marketing', type: 'cookie', duration: '3 months', purpose: 'Measures visits that came from Meta (Facebook, Instagram) advertisements.' },
    ],
};

function defaults(school = {}) {
    const name = school.name || 'This school';
    return {
        enabled: true,
        bannerTitle: 'Cookies on this site',
        bannerText: '',
        sections: [
            { title: 'About this policy', body: `This policy explains the small files ("cookies") and the browser storage that ${name}'s admission portal and school app use, why they are used, and the choices you have.` },
            { title: 'Essential storage', body: 'Some storage is needed for the site to work: keeping you signed in, remembering your cookie choices and opening your documents securely. It cannot be switched off, and it is never used to track you or to show you advertisements.' },
            { title: 'Optional cookies', body: 'Optional cookies are used only if you agree to them. You can change your mind at any time from "Cookie settings" at the bottom of the portal; turning a category off stops it from the next page you open.' },
            { title: 'Payments', body: 'When you pay a fee online, the payment provider\'s checkout sets its own cookies to process the payment securely. They are governed by the provider\'s own policy.' },
            { title: 'Managing cookies in your browser', body: 'Most browsers let you see, block and delete cookies. If you block essential storage you will not be able to sign in.' },
        ],
        categories: Object.fromEntries(OPTIONAL.map((k) => [k, { enabled: false, description: DEFAULT_DESCRIPTIONS[k] }])),
        essentialDescription: DEFAULT_DESCRIPTIONS.essential,
        items: [],
        integrations: { ga4MeasurementId: '', metaPixelId: '' },
        contactEmail: school.email || '',
        consentDays: 180,
        version: 1,
    };
}

// ── Normalising what a school saves ──────────────────────────────────────────

function normalize(input = {}, current) {
    const d = current || defaults();
    const pick = (k) => (input[k] !== undefined ? input[k] : d[k]);

    const sections = (Array.isArray(pick('sections')) ? pick('sections') : []).slice(0, 20).map((s, i) => ({
        title: text(s?.title, `Section ${i + 1} heading`, { max: 120, required: true, kind: 'title', field: 'sections' }),
        body: text(s?.body, `Section ${i + 1} text`, { max: 4000, required: true, field: 'sections' }),
    }));
    if (!sections.length) refuse('The policy needs at least one section', 400, 'sections');

    const inCats = pick('categories') || {};
    const categories = {};
    for (const k of OPTIONAL) {
        const c = inCats[k] || d.categories?.[k] || {};
        categories[k] = {
            enabled: c.enabled === true,
            description: text(c.description ?? DEFAULT_DESCRIPTIONS[k], `${LABEL[k]} description`, { max: 600, field: `categories.${k}` }) || DEFAULT_DESCRIPTIONS[k],
        };
    }
    const essentialDescription = text(pick('essentialDescription') ?? DEFAULT_DESCRIPTIONS.essential, 'Essential description', { max: 600 }) || DEFAULT_DESCRIPTIONS.essential;

    const items = (Array.isArray(pick('items')) ? pick('items') : []).slice(0, 40).map((it, i) => {
        const category = CATEGORIES.includes(it?.category) ? it.category : null;
        if (!category) refuse(`Item ${i + 1}: choose its category`, 400, 'items');
        if (category !== 'essential' && !categories[category].enabled) refuse(`Item ${i + 1} is in ${LABEL[category]}, which is switched off — switch the category on or move the item`, 400, 'items');
        return {
            name: text(it?.name, `Item ${i + 1} name`, { max: 80, required: true, kind: 'token', field: 'items' }),
            provider: text(it?.provider, `Item ${i + 1} provider`, { max: 80, required: true, kind: 'title', field: 'items' }),
            category,
            type: TYPES.includes(it?.type) ? it.type : 'cookie',
            duration: text(it?.duration, `Item ${i + 1} duration`, { max: 60, required: true, kind: 'title', field: 'items' }),
            purpose: text(it?.purpose, `Item ${i + 1} purpose`, { max: 300, required: true, field: 'items' }),
        };
    });

    const integ = pick('integrations') || {};
    const ga = String(integ.ga4MeasurementId || '').trim().toUpperCase();
    const px = String(integ.metaPixelId || '').trim();
    if (ga && !GA4.test(ga)) refuse('A Google Analytics 4 measurement ID looks like G-XXXXXXXXXX', 400, 'integrations.ga4MeasurementId');
    if (px && !PIXEL.test(px)) refuse('A Meta Pixel ID is 8 to 20 digits', 400, 'integrations.metaPixelId');
    if (ga && !categories.analytics.enabled) refuse('Switch on Analytics to use a Google Analytics ID', 400, 'integrations.ga4MeasurementId');
    if (px && !categories.marketing.enabled) refuse('Switch on Advertising to use a Meta Pixel ID', 400, 'integrations.metaPixelId');

    const contactEmail = String(pick('contactEmail') || '').trim().toLowerCase();
    if (contactEmail && !isEmail(contactEmail)) refuse('The privacy contact must be a valid email address', 400, 'contactEmail');

    const consentDays = Math.round(Number(pick('consentDays')));
    if (!Number.isFinite(consentDays) || consentDays < 30 || consentDays > 365) refuse('Remember a choice for 30 to 365 days', 400, 'consentDays');

    const out = {
        enabled: pick('enabled') !== false,
        bannerTitle: text(pick('bannerTitle'), 'Banner heading', { max: 80, kind: 'title' }) || 'Cookies on this site',
        bannerText: text(pick('bannerText'), 'Banner text', { max: 600 }),
        sections, categories, essentialDescription, items,
        integrations: { ga4MeasurementId: ga, metaPixelId: px },
        contactEmail, consentDays,
    };
    // What a visitor agrees to: the switched-on categories, the tags, and
    // which category each stored item belongs to.
    const agreement = (p) => JSON.stringify({
        cats: OPTIONAL.filter((k) => p.categories?.[k]?.enabled),
        tags: [p.integrations?.ga4MeasurementId || '', p.integrations?.metaPixelId || ''],
        items: (p.items || []).map((x) => `${x.name}|${x.category}`).sort(),
    });
    out.version = (Number(d.version) || 1) + (agreement(out) !== agreement(d) ? 1 : 0);
    return out;
}

// ── Reading and writing ──────────────────────────────────────────────────────

function complete(row, school) {
    const d = defaults(school);
    if (!row) return { ...d, _id: null, updatedAt: null, publishedAt: null, saved: false };
    return {
        ...d, ...row,
        categories: Object.fromEntries(OPTIONAL.map((k) => [k, { ...d.categories[k], ...(row.categories?.[k] || {}) }])),
        essentialDescription: row.categories?.essentialDescription || row.essentialDescription || d.essentialDescription,
        integrations: { ...d.integrations, ...(row.integrations || {}) },
        sections: Array.isArray(row.sections) && row.sections.length ? row.sections : d.sections,
        saved: true,
    };
}

async function schoolOf(schoolId) {
    if (!schoolId) return null;
    const { rows } = await pool.query(`SELECT "_id", "name", "email" FROM "schools" WHERE "_id" = $1`, [String(schoolId)]);
    return rows[0] || null;
}

/** The school's policy, every key present — the defaults when it has never saved one. */
async function getPolicy(schoolId) {
    const school = await schoolOf(schoolId);
    const row = schoolId ? await CookiePolicy.findOne({ school: schoolId }).lean() : null;
    return { policy: complete(row, school || {}), school };
}

async function savePolicy(schoolId, input, userId) {
    const { policy: current } = await getPolicy(schoolId);
    const next = normalize(input, current);
    // essentialDescription travels inside `categories` so the stored row keeps one JSON for them.
    const categories = { ...next.categories, essentialDescription: next.essentialDescription };
    const set = {
        enabled: next.enabled, bannerTitle: next.bannerTitle, bannerText: next.bannerText, sections: next.sections,
        categories, items: next.items, integrations: next.integrations, contactEmail: next.contactEmail,
        consentDays: next.consentDays, version: next.version, publishedAt: new Date(), updatedBy: userId || null,
    };
    const existing = await CookiePolicy.findOne({ school: schoolId }).select('_id').lean();
    if (existing) await CookiePolicy.updateOne({ school: schoolId }, { $set: set });
    else {
        try { await CookiePolicy.create({ school: schoolId, ...set }); } catch (e) {
            if (e.code !== 11000 && e.code !== '23505') throw e;
            await CookiePolicy.updateOne({ school: schoolId }, { $set: set });
        }
    }
    return (await getPolicy(schoolId)).policy;
}

async function resetPolicy(schoolId, userId) {
    const school = await schoolOf(schoolId);
    const { policy: current } = await getPolicy(schoolId);
    const d = defaults(school || {});
    // Back to the defaults is a change of what visitors agreed to when tags were on.
    return savePolicy(schoolId, { ...d, version: current.version }, userId);
}

const hasOptional = (p) => OPTIONAL.some((k) => p.categories?.[k]?.enabled);

function autoBanner(p) {
    return hasOptional(p)
        ? 'We use essential storage to keep the site working. With your permission we would also like to use optional cookies — choose which, or accept or reject them all. You can change your mind at any time.'
        : 'This site uses only essential storage, to keep you signed in and remember your choices. No tracking or advertising cookies are used.';
}

/** Every item the policy declares: the platform's own, the school's, and the tags' — tags only when switched on. */
function declaredItems(p) {
    const out = [...PLATFORM_ITEMS.map((x) => ({ ...x, duration: x.name === 'aks_cookie_consent' ? `${p.consentDays} days` : x.duration, auto: true }))];
    if (p.integrations?.ga4MeasurementId && p.categories?.analytics?.enabled) out.push(...INTEGRATION_ITEMS.ga4(p.integrations.ga4MeasurementId).map((x) => ({ ...x, auto: true })));
    if (p.integrations?.metaPixelId && p.categories?.marketing?.enabled) out.push(...INTEGRATION_ITEMS.pixel().map((x) => ({ ...x, auto: true })));
    return [...out, ...(p.items || []).map((x) => ({ ...x, auto: false }))];
}

/** What the portal's banner needs — no more. */
function bannerView(p) {
    const cats = OPTIONAL.filter((k) => p.categories?.[k]?.enabled).map((k) => ({ key: k, label: LABEL[k], description: p.categories[k].description }));
    return {
        enabled: p.enabled !== false,
        version: p.version,
        title: p.bannerTitle || 'Cookies on this site',
        text: p.bannerText || autoBanner(p),
        essential: { label: LABEL.essential, description: p.essentialDescription },
        categories: cats,
        hasOptional: cats.length > 0,
        consentDays: p.consentDays,
        // Tags only for switched-on categories; the browser loads them only after consent, on public pages.
        tags: {
            ga4: p.categories?.analytics?.enabled ? p.integrations?.ga4MeasurementId || '' : '',
            metaPixel: p.categories?.marketing?.enabled ? p.integrations?.metaPixelId || '' : '',
        },
    };
}

/** The whole policy as a page shows it. */
function pageView(p, school) {
    return {
        schoolName: school?.name || '',
        updatedAt: p.publishedAt || p.updatedAt || null,
        version: p.version,
        sections: p.sections,
        essential: { label: LABEL.essential, description: p.essentialDescription },
        categories: OPTIONAL.map((k) => ({ key: k, label: LABEL[k], description: p.categories[k].description, enabled: !!p.categories[k].enabled })),
        items: declaredItems(p).map(({ auto, ...x }) => ({ ...x, categoryLabel: LABEL[x.category] })),
        contactEmail: p.contactEmail,
        consentDays: p.consentDays,
    };
}

// ── Consent ──────────────────────────────────────────────────────────────────

const ipHash = (ip) => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'aks'}|${ip || ''}`).digest('hex').slice(0, 32);

async function recordConsent(schoolId, input = {}, { userId = null, ip = '', userAgent = '', surface = 'portal' } = {}) {
    const visitor = String(input.visitor || '');
    if (!VISITOR.test(visitor)) refuse('Missing visitor id');
    const action = ACTIONS.includes(input.action) ? input.action : null;
    if (!action) refuse('Unknown choice');
    const { policy } = await getPolicy(schoolId);
    const version = Math.round(Number(input.version));
    if (version !== Number(policy.version)) refuse('The cookie policy has changed — please choose again', 409);
    const choices = {};
    for (const k of OPTIONAL) {
        const allowed = !!policy.categories[k]?.enabled;
        choices[k] = allowed && (action === 'accept_all' || (action === 'custom' && input.choices?.[k] === true));
    }
    await CookieConsent.create({
        school: schoolId, visitor, version, action, choices, surface: surface === 'app' ? 'app' : 'portal',
        user: userId || null, ipHash: ip ? ipHash(ip) : '', userAgent: String(userAgent || '').slice(0, 200),
    });
    return { version, choices };
}

/** The last `days` days of answers: how many of each, and the latest ones. */
async function consentStats(schoolId, { days = 30, limit = 50 } = {}) {
    const d = Math.min(365, Math.max(1, Math.round(Number(days)) || 30));
    const { rows: counts } = await pool.query(
        `SELECT "action", COUNT(*)::int AS n FROM "${CookieConsent.tableName}"
          WHERE "school" = $1 AND "createdAt" >= now() - make_interval(days => $2) GROUP BY "action"`, [String(schoolId), d]);
    const { rows: recent } = await pool.query(
        `SELECT "_id", "action", "choices", "version", "surface", "createdAt" FROM "${CookieConsent.tableName}"
          WHERE "school" = $1 ORDER BY "createdAt" DESC LIMIT $2`, [String(schoolId), Math.min(500, Math.max(1, Number(limit) || 50))]);
    const by = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    for (const r of counts) by[r.action] = r.n;
    return { days: d, total: Object.values(by).reduce((s, n) => s + n, 0), byAction: by, recent };
}

module.exports = {
    OPTIONAL, CATEGORIES, LABEL, GA4, PIXEL,
    defaults, normalize, getPolicy, savePolicy, resetPolicy, bannerView, pageView, declaredItems, recordConsent, consentStats,
};
