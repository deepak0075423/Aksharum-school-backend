'use strict';
/**
 * Demo data for the ID Card module — every screen with something real on it.
 *
 *   node scripts/seedIdCardDemo.js            # (re)build "Aksharum Public School (ID Card Demo)"
 *   node scripts/seedIdCardDemo.js --clear    # remove it and everything it holds
 *
 * The school has three academic years (2024-25, 2025-26 and the current
 * 2026-27), six classes in each with two sections, students promoted year on
 * year, teachers, other staff, the office and parents — among them the
 * people of the module's brief:
 *
 *   Aarav Sharma    VI-A in 2024-25, VII-A in 2025-26, VIII-B now — a card
 *                   for each year: two expired, one active
 *   Ananya Sharma   V-A now, her first year
 *   Rahul Sharma    their father, parent ID PAR10245
 *   Priya Sharma    teacher, employee ID EMP1024
 *
 * Cards are issued through services/idCardService — the same calls the
 * screens make — year by year, with the year in question made the school's
 * current one while its cards are issued, and dated to the start of that
 * year. Then a few things happen to them so every status has a row: a card
 * lost and replaced, one damaged and waiting for its replacement, one
 * blocked, a student who moved section after printing (needs reissue), new
 * admissions still waiting for a card.
 *
 * Photos are illustrated portraits (no real faces), drawn as SVG and turned
 * into PNG with headless Chrome when it is installed (CHROME_PATH, else the
 * usual macOS / Linux places); without Chrome the SVGs are used as they are,
 * which the screens show and the PDF replaces with initials.
 *
 * Logins (password IdCardDemo@123): admin@idcarddemo.test,
 * aarav.sharma@idcarddemo.test, rahul.sharma@idcarddemo.test,
 * priya.sharma@idcarddemo.test. Nothing it writes touches any other school.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../db/orm');
const { query, end } = require('../db/pool');

for (const file of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
    if (file.endsWith('.js')) require(path.join(__dirname, '..', 'models', file));
}
const M = (n) => db.model(n);
const has = (k) => process.argv.includes(`--${k}`);

const NAME = 'Aksharum Public School (ID Card Demo)';
const DOMAIN = 'idcarddemo.test';
const PASSWORD = 'IdCardDemo@123';
const UPLOADS = path.join(__dirname, '..', 'uploads');

const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
let seed = 20261004;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/* ── Portraits ───────────────────────────────────────────────────────────── */

const SKINS = ['#f1c7a5', '#e8b48f', '#d9a17a', '#c68a62', '#a8704b', '#8d5a3b'];
const HAIRS = ['#1f1611', '#2b1d14', '#3a2718', '#151515', '#4a3221'];

function shadeHex(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const m = (c) => Math.max(0, Math.min(255, Math.round(a < 0 ? c * (1 + a) : c + (255 - c) * a)));
    return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => m(c).toString(16).padStart(2, '0')).join('')}`;
}

/** A flat, illustrated head-and-shoulders portrait. */
function portrait(o) {
    const skin = o.skin || pick(SKINS);
    const hairC = o.hairColor || pick(HAIRS);
    const child = o.age === 'child';
    const f = o.gender === 'f';
    const W = 300; const H = 360; const cx = 150;
    const headW = child ? 104 : 108; const headH = child ? 126 : 134;
    const headY = child ? 148 : 144;
    const neckY = headY + headH / 2 - 10;
    const bd = o.backdrop || pick(['#dfe7f2', '#e4e9f0', '#e7e2ee', '#dde9e7', '#ece6dd']);
    const shirt = o.shirt || pick(['#2f4f7f', '#5b6b7f', '#7a4b5c', '#3f6b5a', '#8a6a3c', '#495a8c']);
    const hair = o.hair || (f ? pick(['long', 'bun', 'braid', 'ponytail']) : pick(['short', 'side', 'curly', 'short']));
    const p = [];
    p.push(`<defs><radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="${shadeHex(bd, 0.45)}"/><stop offset="1" stop-color="${shadeHex(bd, -0.06)}"/></radialGradient><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shadeHex(skin, 0.06)}"/><stop offset="1" stop-color="${shadeHex(skin, -0.06)}"/></linearGradient></defs>`);
    p.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
    if (hair === 'long' || hair === 'braid') {
        p.push(`<path d="M${cx - headW / 2 - 8} ${headY - 10} Q${cx - headW / 2 - 20} ${headY + 120} ${cx - 58} ${headY + 150} L${cx + 58} ${headY + 150} Q${cx + headW / 2 + 20} ${headY + 120} ${cx + headW / 2 + 8} ${headY - 10} Z" fill="${hairC}"/>`);
    }
    const sy = neckY + 34;
    const body = `M${cx - 132} ${H} L${cx - 128} ${sy + 44} Q${cx - 120} ${sy + 4} ${cx - 62} ${sy - 4} L${cx + 62} ${sy - 4} Q${cx + 120} ${sy + 4} ${cx + 128} ${sy + 44} L${cx + 132} ${H} Z`;
    p.push(`<path d="M${cx - 24} ${neckY - 10} L${cx - 26} ${sy + 6} Q${cx} ${sy + 22} ${cx + 26} ${sy + 6} L${cx + 24} ${neckY - 10} Z" fill="${shadeHex(skin, -0.12)}"/>`);
    if (o.attire === 'saree') {
        p.push(`<path d="${body}" fill="${shirt}"/><path d="M${cx + 70} ${sy - 2} L${cx - 40} ${H} L${cx + 20} ${H} L${cx + 112} ${sy + 20} Z" fill="${shadeHex(shirt, 0.25)}" opacity=".9"/><path d="M${cx - 30} ${sy - 2} Q${cx} ${sy + 26} ${cx + 30} ${sy - 2}" fill="none" stroke="${shadeHex(shirt, -0.2)}" stroke-width="5"/>`);
    } else if (o.attire === 'kurta') {
        p.push(`<path d="${body}" fill="${shirt}"/><path d="M${cx} ${sy + 8} L${cx} ${sy + 78}" stroke="${shadeHex(shirt, -0.25)}" stroke-width="4"/><circle cx="${cx}" cy="${sy + 32}" r="3" fill="${shadeHex(shirt, 0.5)}"/><circle cx="${cx}" cy="${sy + 52}" r="3" fill="${shadeHex(shirt, 0.5)}"/><path d="M${cx - 26} ${sy - 4} Q${cx} ${sy + 14} ${cx + 26} ${sy - 4}" fill="none" stroke="${shadeHex(shirt, -0.25)}" stroke-width="5"/>`);
    } else if (o.attire === 'blazer') {
        p.push(`<path d="${body}" fill="${shirt}"/><path d="M${cx - 30} ${sy - 4} L${cx} ${sy + 70} L${cx + 30} ${sy - 4} Z" fill="#f8fafc"/>`);
        if (!f) p.push(`<path d="M${cx - 7} ${sy + 8} L${cx + 7} ${sy + 8} L${cx + 10} ${sy + 62} L${cx} ${sy + 74} L${cx - 10} ${sy + 62} Z" fill="${o.tie || '#7f1d1d'}"/>`);
        p.push(`<path d="M${cx - 30} ${sy - 4} L${cx - 6} ${sy + 84} L${cx - 54} ${sy + 30} Z" fill="${shadeHex(shirt, -0.18)}"/><path d="M${cx + 30} ${sy - 4} L${cx + 6} ${sy + 84} L${cx + 54} ${sy + 30} Z" fill="${shadeHex(shirt, -0.18)}"/>`);
    } else if (o.attire === 'uniform') {
        const tie = o.tie || '#1e3a8a';
        p.push(`<path d="${body}" fill="#ffffff"/><path d="${body}" fill="none" stroke="#dfe3ea" stroke-width="2"/>`);
        p.push(`<path d="M${cx - 30} ${sy - 6} L${cx - 4} ${sy + 22} L${cx - 40} ${sy + 22} Z" fill="#f4f6fa" stroke="#d5dae3" stroke-width="2"/><path d="M${cx + 30} ${sy - 6} L${cx + 4} ${sy + 22} L${cx + 40} ${sy + 22} Z" fill="#f4f6fa" stroke="#d5dae3" stroke-width="2"/>`);
        p.push(`<path d="M${cx - 8} ${sy + 8} L${cx + 8} ${sy + 8} L${cx + 6} ${sy + 20} L${cx + 12} ${sy + 86} L${cx} ${sy + 100} L${cx - 12} ${sy + 86} L${cx - 6} ${sy + 20} Z" fill="${tie}"/><path d="M${cx - 9} ${sy + 40} L${cx + 11} ${sy + 32} M${cx - 11} ${sy + 60} L${cx + 12} ${sy + 52}" stroke="${shadeHex(tie, 0.45)}" stroke-width="3"/>`);
    } else {
        p.push(`<path d="${body}" fill="${shirt}"/><path d="M${cx - 28} ${sy - 6} L${cx - 2} ${sy + 24} L${cx - 38} ${sy + 20} Z" fill="${shadeHex(shirt, 0.18)}"/><path d="M${cx + 28} ${sy - 6} L${cx + 2} ${sy + 24} L${cx + 38} ${sy + 20} Z" fill="${shadeHex(shirt, 0.18)}"/>`);
    }
    p.push(`<ellipse cx="${cx - headW / 2 + 2}" cy="${headY + 8}" rx="10" ry="15" fill="${shadeHex(skin, -0.08)}"/><ellipse cx="${cx + headW / 2 - 2}" cy="${headY + 8}" rx="10" ry="15" fill="${shadeHex(skin, -0.08)}"/>`);
    p.push(`<ellipse cx="${cx}" cy="${headY}" rx="${headW / 2}" ry="${headH / 2}" fill="url(#sk)"/>`);
    const top = headY - headH / 2;
    if (hair === 'short' || hair === 'side') {
        p.push(`<path d="M${cx - headW / 2 - 2} ${headY - 6} Q${cx - headW / 2 - 6} ${top - 14} ${cx - 6} ${top - 10} Q${cx + headW / 2 + 10} ${top - 12} ${cx + headW / 2 + 2} ${headY - 4} Q${cx + 30} ${top + 18} ${hair === 'side' ? cx - 22 : cx - 4} ${top + 22} Q${cx - 30} ${top + 18} ${cx - headW / 2 - 2} ${headY - 6} Z" fill="${hairC}"/>`);
    } else if (hair === 'curly') {
        for (let i = 0; i < 11; i += 1) {
            const a = Math.PI * (0.95 + (i / 10) * 1.1);
            p.push(`<circle cx="${cx + Math.cos(a) * (headW / 2 - 4)}" cy="${headY - 10 + Math.sin(a) * (headH / 2 - 6)}" r="18" fill="${hairC}"/>`);
        }
    } else if (hair !== 'bald') {
        p.push(`<path d="M${cx - headW / 2 - 4} ${headY + 10} Q${cx - headW / 2 - 8} ${top - 16} ${cx} ${top - 12} Q${cx + headW / 2 + 8} ${top - 16} ${cx + headW / 2 + 4} ${headY + 10} Q${cx + headW / 2 - 6} ${top + 16} ${cx + 4} ${top + 16} Q${cx - 18} ${top + 30} ${cx - headW / 2 + 6} ${headY - 2} Z" fill="${hairC}"/>`);
        if (hair === 'bun') p.push(`<circle cx="${cx}" cy="${top - 14}" r="23" fill="${hairC}"/>`);
        if (hair === 'ponytail') p.push(`<path d="M${cx + headW / 2 - 6} ${headY - 30} Q${cx + headW / 2 + 40} ${headY + 10} ${cx + headW / 2 + 14} ${headY + 70} Q${cx + headW / 2 + 4} ${headY + 20} ${cx + headW / 2 - 10} ${headY - 10} Z" fill="${hairC}"/>`);
    }
    const ey = headY + 2;
    p.push(`<path d="M${cx - 32} ${ey - 17} Q${cx - 22} ${ey - 23} ${cx - 11} ${ey - 18}" stroke="${shadeHex(hairC, 0.1)}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M${cx + 11} ${ey - 18} Q${cx + 22} ${ey - 23} ${cx + 32} ${ey - 17}" stroke="${shadeHex(hairC, 0.1)}" stroke-width="4" fill="none" stroke-linecap="round"/>`);
    p.push(`<ellipse cx="${cx - 21}" cy="${ey}" rx="5.4" ry="6" fill="#2a1d17"/><ellipse cx="${cx + 21}" cy="${ey}" rx="5.4" ry="6" fill="#2a1d17"/><circle cx="${cx - 19.4}" cy="${ey - 1.9}" r="1.7" fill="#fff"/><circle cx="${cx + 22.6}" cy="${ey - 1.9}" r="1.7" fill="#fff"/>`);
    p.push(`<path d="M${cx - 2} ${ey + 8} Q${cx - 6} ${ey + 23} ${cx + 4} ${ey + 23}" stroke="${shadeHex(skin, -0.22)}" stroke-width="3" fill="none" stroke-linecap="round"/>`);
    p.push(`<path d="M${cx - 17} ${ey + 36} Q${cx} ${ey + 48} ${cx + 17} ${ey + 36}" stroke="#a24a4a" stroke-width="4" fill="none" stroke-linecap="round"/>`);
    p.push(`<ellipse cx="${cx - 34}" cy="${ey + 23}" rx="9" ry="5" fill="#e88a7a" opacity=".22"/><ellipse cx="${cx + 34}" cy="${ey + 23}" rx="9" ry="5" fill="#e88a7a" opacity=".22"/>`);
    if (f && !child) p.push(`<circle cx="${cx}" cy="${ey - 25}" r="3.3" fill="#b91c1c" opacity=".85"/>`);
    if (o.glasses) p.push(`<g fill="none" stroke="#1f2937" stroke-width="3"><rect x="${cx - 38}" y="${ey - 12}" width="29" height="23" rx="7"/><rect x="${cx + 9}" y="${ey - 12}" width="29" height="23" rx="7"/><path d="M${cx - 9} ${ey - 2} L${cx + 9} ${ey - 2}"/></g>`);
    if (o.beard) p.push(`<path d="M${cx - headW / 2 + 6} ${headY + 16} Q${cx - 30} ${headY + headH / 2 + 12} ${cx} ${headY + headH / 2 + 10} Q${cx + 30} ${headY + headH / 2 + 12} ${cx + headW / 2 - 6} ${headY + 16} Q${cx + 20} ${headY + 46} ${cx} ${headY + 48} Q${cx - 20} ${headY + 46} ${cx - headW / 2 + 6} ${headY + 16} Z" fill="${hairC}" opacity=".92"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${p.join('')}</svg>`;
}

const CREST = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
 <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#172554"/></linearGradient></defs>
 <path d="M100 8 L176 34 V96 C176 146 142 178 100 194 C58 178 24 146 24 96 V34 Z" fill="url(#g)" stroke="#c99a2e" stroke-width="7"/>
 <path d="M100 40 L120 78 L162 82 L130 110 L140 152 L100 130 L60 152 L70 110 L38 82 L80 78 Z" fill="#c99a2e" opacity=".95"/>
 <path d="M64 124 Q100 104 136 124 L136 146 Q100 128 64 146 Z" fill="#ffffff"/><path d="M100 112 V140" stroke="#1e3a8a" stroke-width="3"/></svg>`;

const SIGNATURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 120" width="360" height="120">
 <path d="M18 86 C40 30 62 22 66 44 C70 66 44 92 56 92 C70 92 84 52 96 50 C106 48 98 84 110 84 C122 84 130 58 142 58 C152 58 146 82 158 82 C172 82 178 44 196 40 C214 36 206 82 222 80 C240 78 246 50 262 52 C276 54 266 80 282 80 C300 80 318 60 340 56"
  fill="none" stroke="#1c2b6b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
 <path d="M60 104 C140 96 240 96 330 100" fill="none" stroke="#1c2b6b" stroke-width="3" stroke-linecap="round"/></svg>`;

function chromePath() {
    const list = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
    return list.find((p) => fs.existsSync(p)) || null;
}

/** Write an image under uploads/<folder>, as PNG through Chrome when there is one. Returns its /uploads path. */
function writeImage(folder, base, svg, w, h, transparent = false) {
    const dir = path.join(UPLOADS, folder);
    fs.mkdirSync(dir, { recursive: true });
    const chrome = chromePath();
    if (chrome) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idcdemo-'));
        const html = path.join(tmp, 'a.html');
        const png = path.join(dir, `${base}.png`);
        fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
        try {
            execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${png}`, `--window-size=${w},${h}`,
                ...(transparent ? ['--default-background-color=00000000'] : []), `file://${html}`], { stdio: 'ignore', timeout: 30000 });
            fs.rmSync(tmp, { recursive: true, force: true });
            if (fs.existsSync(png)) return `/uploads/${folder}/${base}.png`;
        } catch { /* fall back to the SVG */ }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(dir, `${base}.svg`), svg);
    return `/uploads/${folder}/${base}.svg`;
}

/* ── Clearing ────────────────────────────────────────────────────────────── */

async function clear() {
    const { rows } = await query('SELECT "_id", "name" FROM "schools" WHERE "name" = $1', [NAME]);
    for (const { _id } of rows) {
        const S = [String(_id)];
        const { rows: photos } = await query(`SELECT "snapshot"->>'photo' AS p FROM "idcards" WHERE "school" = $1`, S);
        for (const { p } of photos) if (p) fs.rmSync(path.join(UPLOADS, p.replace(/^\/uploads\//, '')), { force: true });
        fs.rmSync(path.join(UPLOADS, 'id-cards', S[0]), { recursive: true, force: true });
        fs.rmSync(path.join(UPLOADS, 'idcard-demo'), { recursive: true, force: true });
        for (const t of ['idcards', 'idcardlogs', 'idcardcounters', 'idcardtemplates', 'idcardsettingses', 'notificationreceipts', 'notifications',
            'parentprofiles', 'studentprofiles', 'teacherprofiles', 'classsections', 'classes', 'academicyears', 'designations', 'users']) {
            await query(`DELETE FROM "${t}" WHERE "school" = $1`, S).catch(() => {});
        }
        await query('DELETE FROM "schools" WHERE "_id" = $1', S);
        console.log(`  removed ${NAME} (${S[0]})`);
    }
}

/* ── Building ────────────────────────────────────────────────────────────── */

const FIRST_M = ['Aarav', 'Arjun', 'Kabir', 'Vihaan', 'Ishaan', 'Rohan', 'Dhruv', 'Aditya', 'Reyansh', 'Krish', 'Advik', 'Shaurya', 'Atharv', 'Ayaan', 'Vivaan', 'Laksh', 'Yash', 'Om'];
const FIRST_F = ['Ananya', 'Diya', 'Saanvi', 'Ira', 'Myra', 'Aadhya', 'Kiara', 'Pari', 'Anika', 'Navya', 'Riya', 'Tara', 'Meera', 'Avni', 'Siya', 'Kavya', 'Isha', 'Zara'];
const LAST = ['Mehta', 'Iyer', 'Nair', 'Kulkarni', 'Deshpande', 'Rao', 'Patel', 'Joshi', 'Reddy', 'Kapoor', 'Gupta', 'Bose', 'Menon', 'Pillai', 'Chopra', 'Sethi', 'Jain', 'Verma'];
const BLOOD = ['A+', 'B+', 'O+', 'AB+', 'A-', 'B-', 'O-', 'O+', 'B+', 'A+'];
const TIE = '#1e3a8a';

async function main() {
    await db.connect();
    await clear();
    if (has('clear')) { console.log('done (cleared)'); return; }

    const service = require('../services/idCardService');
    const design = require('../services/idCardDesign');
    const password = await bcrypt.hash(PASSWORD, 10);

    const logo = writeImage('idcard-demo', 'crest', CREST, 200, 200, true);
    const signature = writeImage('idcard-demo', 'signature', SIGNATURE, 360, 120, true);
    const school = await M('School').create({
        name: NAME, code: 'APS', email: `office@${DOMAIN}`, phone: '+91 20 2543 1100', address: '12, MG Road, Kothrud',
        city: 'Pune', state: 'Maharashtra', board: 'CBSE', website: 'www.aksharum.edu.in', logo, isActive: true,
        modules: { idCard: true, attendance: true, notification: true, holiday: true, document: true, result: true, employeeDirectory: true },
    });
    const S = String(school._id);
    console.log(`school: ${NAME} (${S})`);

    const usedEmails = new Set();
    const emailOf = (name) => {
        const baseName = name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
        let e = `${baseName}@${DOMAIN}`; let n = 2;
        while (usedEmails.has(e)) { e = `${baseName}.${n}@${DOMAIN}`; n += 1; }
        usedEmails.add(e);
        return e;
    };
    let photoNo = 0;
    const photoFor = (opts) => {
        photoNo += 1;
        return writeImage('idcard-demo', `p${String(photoNo).padStart(3, '0')}`, portrait({ ...opts, seed: photoNo }), 300, 360);
    };
    const person = async (role, name, extra = {}) => M('User').create({
        school: S, role, name, password, isActive: true, isFirstLogin: false, email: emailOf(name), ...extra,
    });

    const admin = await person('school_admin', 'Office Admin', { email: `admin@${DOMAIN}`, phone: '+91 98200 10001', profileImage: photoFor({ gender: 'm', attire: 'shirt', shirt: '#3f4f6b', hair: 'short' }) });
    const ctx = { schoolId: S, userId: String(admin._id), userRole: 'school_admin' };

    /* Settings: what every card says about the school. */
    await design.saveSettings(S, {
        displayName: 'Aksharum Public School', tagline: 'Affiliated to CBSE · Affiliation No. 1130256',
        address: '12, MG Road, Kothrud, Pune, Maharashtra 411038', phone: '+91 20 2543 1100', email: 'office@aksharum.edu.in',
        website: 'www.aksharum.edu.in', signatoryName: 'Dr. Meera Kulkarni', signatoryTitle: 'Principal',
    }, ctx.userId);
    await design.setImage(S, 'signature', signature, ctx.userId);

    /* Years. */
    const Y = {};
    for (const [name, a, b, status] of [['2024-25', 2024, 2025, 'archived'], ['2025-26', 2025, 2026, 'inactive'], ['2026-27', 2026, 2027, 'active']]) {
        Y[name] = await M('AcademicYear').create({ school: S, yearName: name, startDate: day(a, 4, 1), endDate: day(b, 3, 31), status });
    }

    /* Teachers, staff, the office. */
    const STAFF = [
        ['Priya Sharma', 'f', 'Teacher', 'Mathematics', 'teaching', 'EMP1024', { attire: 'saree', shirt: '#0f766e', hair: 'bun' }],
        ['Rakesh Iyer', 'm', 'Senior Teacher', 'Science', 'teaching', 'EMP1031', { attire: 'blazer', shirt: '#334155', glasses: true }],
        ['Neha Kapoor', 'f', 'Teacher', 'English', 'teaching', 'EMP1042', { attire: 'kurta', shirt: '#9d174d', hair: 'long' }],
        ['Sanjay Deshmukh', 'm', 'Class Teacher', 'Social Science', 'teaching', 'EMP1047', { attire: 'shirt', shirt: '#475569', beard: true }],
        ['Farah Khan', 'f', 'Teacher', 'Computer Science', 'teaching', 'EMP1053', { attire: 'blazer', shirt: '#1f2937', hair: 'ponytail' }],
        ['Vivek Menon', 'm', 'Teacher', 'Hindi', 'teaching', 'EMP1058', { attire: 'kurta', shirt: '#7c2d12', hair: 'side' }],
        ['Lata Joshi', 'f', 'Accountant', 'Accounts', 'non_teaching', 'EMP2011', { attire: 'saree', shirt: '#6d28d9', hair: 'bun', glasses: true }],
        ['Anil Pawar', 'm', 'Librarian', 'Library', 'non_teaching', 'EMP2016', { attire: 'shirt', shirt: '#365314', glasses: true }],
        ['Sunita More', 'f', 'Receptionist', 'Front Office', 'non_teaching', 'EMP2022', { attire: 'kurta', shirt: '#be185d', hair: 'braid' }],
        ['Ramesh Gaikwad', 'm', 'Driver', 'Transport', 'non_teaching', 'EMP2030', { attire: 'shirt', shirt: '#1e40af', beard: true }],
        ['Kamala Devi', 'f', 'Hostel Warden', 'Hostel', 'non_teaching', '', { attire: 'saree', shirt: '#b45309', hair: 'bun' }],
    ];
    const staff = {};
    for (const [i, [name, g, designation, department, staffType, employeeId, look]] of STAFF.entries()) {
        const u = await person('teacher', name, { phone: `+91 98500 ${String(11000 + i * 37).slice(-5)}`, profileImage: photoFor({ gender: g, age: 'adult', ...look }) });
        await M('TeacherProfile').create({
            user: u._id, school: S, employeeId, designation, department, staffType, gender: g === 'f' ? 'Female' : 'Male',
            bloodGroup: BLOOD[i % BLOOD.length], joiningDate: day(2012 + (i % 9), 6, 1 + i), emergencyContactPhone: `+91 99220 ${String(30000 + i * 41).slice(-5)}`,
            subjects: staffType === 'teaching' ? [department] : [],
        });
        staff[name] = u;
    }

    /* Classes and sections, every year; students promoted up a class each year. */
    const CLASSES = [5, 6, 7, 8, 9, 10];
    const structure = {};
    for (const yn of Object.keys(Y)) {
        structure[yn] = {};
        for (const n of CLASSES) {
            const c = await M('Class').create({ school: S, academicYear: Y[yn]._id, classNumber: n, className: `Class ${ROMAN[n]}` });
            const secs = {};
            for (const sn of ['A', 'B']) secs[sn] = { doc: await M('ClassSection').create({ school: S, class: c._id, academicYear: Y[yn]._id, sectionName: sn, maxStudents: 40 }), students: [] };
            structure[yn][n] = { doc: c, secs };
        }
    }

    // Each student: the class and section they were in each year (null = not yet admitted).
    const students = [];
    const addStudent = (name, g, path3, extra = {}) => students.push({ name, g, path: path3, ...extra });
    addStudent('Aarav Sharma', 'm', { '2024-25': [6, 'A'], '2025-26': [7, 'A'], '2026-27': [8, 'B'] }, { blood: 'B+', dob: day(2013, 5, 14), look: { hair: 'side' } });
    addStudent('Ananya Sharma', 'f', { '2026-27': [5, 'A'] }, { blood: 'O+', dob: day(2016, 8, 2), look: { hair: 'ponytail' } });
    const taken = new Set(students.map((x) => x.name));
    for (let i = 0; i < 34; i += 1) {
        const g = i % 2 ? 'f' : 'm';
        // Every name different: walk the surnames until the pair is new.
        const first = g === 'f' ? FIRST_F[Math.floor(i / 2) % FIRST_F.length] : FIRST_M[Math.floor(i / 2) % FIRST_M.length];
        let li = (i * 7) % LAST.length;
        while (taken.has(`${first} ${LAST[li]}`)) li = (li + 1) % LAST.length;
        const last = LAST[li];
        taken.add(`${first} ${last}`);
        const nowClass = CLASSES[i % CLASSES.length];
        const sec = i % 3 === 0 ? 'B' : 'A';
        const p3 = { '2026-27': [nowClass, sec] };
        // Most were here last year and the year before, a class lower each time.
        if (i % 7 !== 3 && nowClass > 5) p3['2025-26'] = [nowClass - 1, i % 4 === 0 ? (sec === 'A' ? 'B' : 'A') : sec];
        if (i % 5 !== 2 && nowClass > 6 && p3['2025-26']) p3['2024-25'] = [nowClass - 2, sec];
        addStudent(`${first} ${last}`, g, p3, { blood: BLOOD[i % BLOOD.length], dob: day(2026 - nowClass - 6, 1 + (i % 12), 3 + (i % 25)) });
    }

    const PARENT_LOOKS = [{ attire: 'shirt', glasses: true, hair: 'short' }, { attire: 'kurta', beard: true }, { attire: 'saree', hair: 'bun' }, { attire: 'shirt', hair: 'side' }, { attire: 'kurta', hair: 'long' }];
    const parents = {};
    let adm = 0;
    for (const [i, st] of students.entries()) {
        adm += 1;
        const u = await person('student', st.name, { profileImage: '' });
        st.user = u;
        const photo = i % 9 === 8 ? '' : photoFor({ gender: st.g, age: 'child', attire: 'uniform', tie: TIE, ...(st.look || {}) });
        const yrs = Object.keys(st.path).sort();
        const nowYear = yrs[yrs.length - 1];
        const [n, sn] = st.path[nowYear];
        const now = structure[nowYear][n];
        for (const yn of yrs) {
            const [cn, secName] = st.path[yn];
            structure[yn][cn].secs[secName].students.push(u._id);
        }
        // The family: the Sharmas share Rahul; everyone else has their own parent.
        const surname = st.name.split(' ').slice(-1)[0];
        let parent;
        if (st.name.endsWith('Sharma')) {
            parent = parents.Sharma || (parents.Sharma = await person('parent', 'Rahul Sharma', { phone: '+91 98220 41234', profileImage: photoFor({ gender: 'm', age: 'adult', attire: 'shirt', shirt: '#334e68', glasses: true, hair: 'short' }) }));
        } else if (i % 4 !== 1) {
            const g = i % 3 ? 'm' : 'f';
            const pname = `${g === 'm' ? pick(['Rajesh', 'Amit', 'Sunil', 'Vikas', 'Manoj', 'Prakash']) : pick(['Pooja', 'Sneha', 'Kavita', 'Anjali', 'Rekha', 'Shalini'])} ${surname}`;
            parent = await person('parent', pname, { phone: `+91 97${String(10000000 + i * 7919).slice(-8)}`, profileImage: i % 6 === 0 ? '' : photoFor({ gender: g, age: 'adult', ...PARENT_LOOKS[i % PARENT_LOOKS.length] }) });
            parent.relationship = g === 'm' ? 'Father' : 'Mother';
        }
        const photoFile = photo ? path.basename(photo) : '';
        if (photo) {
            // Admission photos live in student-docs; the profile picture mirrors it.
            fs.copyFileSync(path.join(UPLOADS, photo.replace(/^\/uploads\//, '')), path.join(UPLOADS, 'student-docs', `idcdemo-${photoFile}`));
            await M('User').updateOne({ _id: u._id }, { $set: { profileImage: `/uploads/student-docs/idcdemo-${photoFile}` } });
        }
        await M('StudentProfile').create({
            user: u._id, school: S, currentClass: now.doc._id, currentSection: now.secs[sn].doc._id,
            admissionNumber: `APS${2016 + (adm % 9)}${String(adm).padStart(3, '0')}`, rollNumber: '',
            bloodGroup: st.blood, dob: st.dob, gender: st.g === 'f' ? 'Female' : 'Male',
            photoFile: photo ? `idcdemo-${photoFile}` : '', parent: parent?._id || null,
            emergencyContactPhone: parent?.phone || '', address: `${10 + i}, Lane ${1 + (i % 6)}, Kothrud`, city: 'Pune', state: 'Maharashtra', pincode: '411038',
        });
        if (parent) {
            const pp = await M('ParentProfile').findOne({ user: parent._id }).lean();
            if (pp) await M('ParentProfile').updateOne({ _id: pp._id }, { $set: { children: [...(pp.children || []), u._id] } });
            else await M('ParentProfile').create({ user: parent._id, school: S, relationship: parent.relationship || 'Father', children: [u._id] });
        }
    }
    // Rolls, by name within each section; rosters written once.
    for (const yn of Object.keys(Y)) {
        for (const n of CLASSES) {
            for (const sn of ['A', 'B']) {
                const sec = structure[yn][n].secs[sn];
                await M('ClassSection').updateOne({ _id: sec.doc._id }, { $set: { enrolledStudents: sec.students, currentCount: sec.students.length } });
            }
        }
    }
    const nowSecs = Object.values(structure['2026-27']).flatMap((c) => Object.values(c.secs));
    for (const sec of nowSecs) {
        const names = students.filter((s) => sec.students.some((id) => String(id) === String(s.user._id))).sort((a, b) => a.name.localeCompare(b.name));
        for (const [r, s] of names.entries()) await M('StudentProfile').updateOne({ user: s.user._id }, { $set: { rollNumber: String(r + 1) } });
    }

    /* Cards, year by year — each year made current while its cards are issued. */
    const setCurrent = async (yn) => {
        for (const [name, y] of Object.entries(Y)) await M('AcademicYear').updateOne({ _id: y._id }, { $set: { status: name === yn ? 'active' : (name < yn ? 'inactive' : 'inactive') } });
    };
    const backdate = async (when) => query(`UPDATE "idcards" SET "issuedAt" = $2, "createdAt" = $2, "printedAt" = $2, "printCount" = 1 WHERE "school" = $1 AND "issuedAt" > now() - interval '1 hour'`, [S, when]);
    const rollFor = async (yn) => {
        // Past years' roll numbers, as they were: by name in each section.
        for (const n of CLASSES) {
            for (const sn of ['A', 'B']) {
                const sec = structure[yn][n].secs[sn];
                const names = students.filter((s) => sec.students.some((id) => String(id) === String(s.user._id))).sort((a, b) => a.name.localeCompare(b.name));
                for (const [r, s] of names.entries()) {
                    await M('StudentProfile').updateOne({ user: s.user._id }, { $set: { currentClass: structure[yn][n].doc._id, currentSection: sec.doc._id, rollNumber: String(r + 1) } });
                }
            }
        }
    };
    // Past years first: students sat in that year's section, so their cards say so.
    const saved = await M('StudentProfile').find({ school: S }).select('user currentClass currentSection rollNumber').lean();
    for (const yn of ['2024-25', '2025-26']) {
        await setCurrent(yn);
        await rollFor(yn);
        const r = await service.issue(ctx, { kind: 'student', yearId: String(Y[yn]._id), notify: false });
        await backdate(day(Number(yn.slice(0, 4)), 4, 10 + (yn === '2025-26' ? 3 : 0)));
        console.log(`  ${yn}: ${r.issued} student cards`);
    }
    for (const p of saved) await M('StudentProfile').updateOne({ user: p.user }, { $set: { currentClass: p.currentClass, currentSection: p.currentSection, rollNumber: p.rollNumber } });
    await setCurrent('2026-27');
    await M('AcademicYear').updateOne({ _id: Y['2024-25']._id }, { $set: { status: 'archived' } });

    // This year: everyone but the newest admissions.
    const waiting = new Set(students.filter((s, i) => i >= 2 && i % 8 === 5).map((s) => String(s.user._id)));
    const issueNow = students.filter((s) => !waiting.has(String(s.user._id))).map((s) => String(s.user._id));
    const r26 = await service.issue(ctx, { kind: 'student', holderIds: issueNow, notify: false });
    await backdate(day(2026, 4, 15));
    console.log(`  2026-27: ${r26.issued} student cards, ${waiting.size} new admissions still waiting`);

    const teachersOut = await service.issue(ctx, { kind: 'teacher', notify: false });
    const staffIds = Object.entries(staff).filter(([n]) => n !== 'Sunita More').map(([, u]) => String(u._id));
    const staffOut = await service.issue(ctx, { kind: 'staff', holderIds: [...staffIds, String(admin._id)], notify: false });
    await backdate(day(2026, 6, 20));
    // Rahul gets the parent ID from the brief.
    await query(`INSERT INTO "idcardcounters" ("_id","school","kind","series","value","createdAt","updatedAt") VALUES (gen_random_uuid(), $1, 'parentId', 'all', 244, now(), now())
                 ON CONFLICT ("school","kind","series") DO UPDATE SET "value" = 244`, [S]);
    const rahul = parents.Sharma;
    await service.issue(ctx, { kind: 'parent', holderIds: [String(rahul._id)], notify: false });
    const parentsOut = await service.issue(ctx, { kind: 'parent', notify: false });
    await backdate(day(2026, 7, 2));
    console.log(`  teachers ${teachersOut.issued}, staff ${staffOut.issued}, parents ${parentsOut.issued + 1}`);

    /* Things that happen to cards. */
    const cardOf = async (name, kind = 'student') => {
        const u = await M('User').findOne({ school: S, name }).lean();
        return M('IdCard').findOne({ school: S, holder: u._id, kind, status: { $in: ['active', 'blocked'] }, ...(kind === 'student' ? { academicYear: Y['2026-27']._id } : {}) }).lean();
    };
    const someone = (i) => students[i + 2];
    // Lost on the school bus, replaced the same day.
    const lostCard = await cardOf(someone(4).name);
    await service.report(ctx, lostCard._id, { status: 'lost', note: 'Lost on the school bus', replace: true });
    // Damaged, replacement not yet issued.
    const dmg = await cardOf(someone(10).name);
    await service.report(ctx, dmg._id, { status: 'damaged', note: 'Card cracked — student to collect a new one', replace: false });
    // Blocked for now.
    const blk = await cardOf(someone(14).name);
    await service.block(ctx, blk._id, { reason: 'Fee and ID verification pending' });
    // Moved section after the card was printed: the list flags it for reissue.
    const mover = someone(20);
    const moverProfile = await M('StudentProfile').findOne({ user: mover.user._id }).lean();
    const moverSec = await M('ClassSection').findById(moverProfile.currentSection).lean();
    const otherSec = await M('ClassSection').findOne({ class: moverSec.class, _id: { $ne: moverSec._id } }).lean();
    await M('ClassSection').updateOne({ _id: moverSec._id }, { $set: { enrolledStudents: (moverSec.enrolledStudents || []).filter((id) => String(id) !== String(mover.user._id)) } });
    await M('ClassSection').updateOne({ _id: otherSec._id }, { $set: { enrolledStudents: [...(otherSec.enrolledStudents || []), mover.user._id] } });
    await M('StudentProfile').updateOne({ user: mover.user._id }, { $set: { currentSection: otherSec._id, rollNumber: String((otherSec.enrolledStudents || []).length + 1) } });
    // A teacher's card damaged and replaced; Priya's department renamed (needs reissue).
    const tdmg = await cardOf('Neha Kapoor', 'teacher');
    await service.report(ctx, tdmg._id, { status: 'damaged', note: 'Lamination peeled', replace: true });
    await M('TeacherProfile').updateOne({ user: staff['Rakesh Iyer']._id }, { $set: { department: 'Physics' } });
    // A few cards never printed (issued this week).
    await query(`UPDATE "idcards" SET "printedAt" = NULL, "printCount" = 0, "issuedAt" = now() - interval '2 days'
                  WHERE "school" = $1 AND "_id" IN (SELECT "_id" FROM "idcards" WHERE "school" = $1 AND "kind" = 'parent' ORDER BY "number" DESC LIMIT 4)`, [S]);

    console.log('\nLogins (password IdCardDemo@123):');
    console.log(`  admin@${DOMAIN}            the office`);
    console.log(`  aarav.sharma@${DOMAIN}     student — three years of cards`);
    console.log(`  rahul.sharma@${DOMAIN}     parent — Aarav and Ananya`);
    console.log(`  priya.sharma@${DOMAIN}     teacher`);
}

main()
    .then(() => end())
    .then(() => process.exit(0))
    .catch(async (e) => { console.error(e); await end().catch(() => {}); process.exit(1); });
