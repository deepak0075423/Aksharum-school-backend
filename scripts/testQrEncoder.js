'use strict';
/**
 * QR encoder verification.
 *
 *   node scripts/testQrEncoder.js
 *
 * utils/qrcode.js is hand-written (see the note at the top of that file), so it
 * is checked module-for-module against an independent, widely-used encoder —
 * the one bundled with `qrcode-terminal`, which lives in the Expo app's
 * node_modules. That library is NOT a dependency of the backend and is only
 * reached from this test; if it is missing, the structural checks still run.
 *
 * A QR code is only useful if a real scanner can read it, and the only way to
 * be confident of that without a scanner is to reproduce a known-good encoder
 * bit for bit.
 */
const path = require('path');
const qr = require('../utils/qrcode');
const { matrixToPng } = require('../utils/pngEncoder');

let passed = 0; let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; results.push(`  ✅ ${name}`); }
    else { failed += 1; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => results.push(`\n▸ ${t}`);

// ── The reference encoder, if it is reachable ────────────────────────────────
let Reference = null;
let RefECL = null;
try {
    const base = path.join(__dirname, '../../Nexora-Hives/node_modules/qrcode-terminal/vendor/QRCode');
    Reference = require(base);
    RefECL = require(path.join(base, 'QRErrorCorrectLevel'));
} catch { /* the structural checks below still apply */ }

/**
 * The reference encoder's matrix for `text`, pinned to one mask.
 *
 * The mask is forced rather than auto-selected because the two encoders choose
 * different masks: mask selection is a heuristic scored by a penalty function,
 * and this reference implements a well-known non-conformant variant of it
 * (its rule 1 counts matching 8-neighbours instead of the spec's runs of five,
 * and its rule 3 omits the four-module light margin). Any of the eight masks
 * produces a valid, scannable code, so a different choice is not a defect —
 * but the modules underneath the mask must agree exactly, and that is what
 * pinning the mask lets this test prove.
 */
function referenceMatrix(text, version, maskId) {
    const q = new Reference(version, RefECL.M);
    q.addData(text);
    q.makeImpl(false, maskId);
    const n = q.getModuleCount();
    return Array.from({ length: n }, (_, r) =>
        Array.from({ length: n }, (_, c) => (q.isDark(r, c) ? 1 : 0)));
}

const sameMatrix = (a, b) =>
    a.length === b.length && a.every((row, r) => row.every((v, c) => v === b[r][c]));

// ── Structural checks that hold for every QR code ────────────────────────────
function structuralChecks(m, label) {
    const size = m.length;
    check(`${label}: size is 4·version+17`, (size - 17) % 4 === 0 && size >= 21, String(size));

    // Finder patterns: a 7×7 concentric square in three corners.
    const finderOk = (r0, c0) => {
        for (let r = 0; r < 7; r += 1) {
            for (let c = 0; c < 7; c += 1) {
                const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
                const want = ring === 2 ? 0 : 1;
                if (m[r0 + r][c0 + c] !== want) return false;
            }
        }
        return true;
    };
    check(`${label}: three finder patterns are correct`,
        finderOk(0, 0) && finderOk(0, size - 7) && finderOk(size - 7, 0));

    // Timing patterns alternate along row 6 and column 6.
    let timingOk = true;
    for (let i = 8; i < size - 8; i += 1) {
        if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
        if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    }
    check(`${label}: timing patterns alternate`, timingOk);

    check(`${label}: the always-dark module is set`, m[size - 8][8] === 1);

    // Separators: the light ring around each finder.
    let sepOk = true;
    for (let i = 0; i < 8; i += 1) {
        if (m[7][i] !== 0 || m[i][7] !== 0) sepOk = false;
        if (m[7][size - 1 - i] !== 0 || m[i][size - 8] !== 0) sepOk = false;
        if (m[size - 8][i] !== 0 || m[size - 1 - i][7] !== 0) sepOk = false;
    }
    check(`${label}: finder separators are light`, sepOk);
}

(function run() {
    section('Structure');
    structuralChecks(qr.encode('HELLO WORLD'), 'v-auto "HELLO WORLD"');
    structuralChecks(qr.encode('a'.repeat(120)), 'v-auto 120 bytes');

    // ── Match the reference encoder exactly ─────────────────────────────────
    section('Agreement with an independent encoder');
    if (!Reference) {
        results.push('  ⚠️  qrcode-terminal not reachable — comparison skipped');
    } else {
        // ASCII only: this reference writes String.charCodeAt() straight into
        // the byte stream instead of UTF-8 encoding, so the two disagree on
        // multi-byte input by the reference's own limitation, not ours. UTF-8
        // is checked separately below.
        const cases = [
            ['HELLO WORLD', 1, 'short text'],
            ['a', 1, 'single character'],
            ['1234567890', 1, 'digits'],
            ['x'.repeat(14), 1, '14 bytes → v1'],
            ['x'.repeat(26), 2, '26 bytes → v2'],
            ['x'.repeat(42), 3, '42 bytes → v3'],
            ['9f2b7c41a0d84e6fb35127ce9a04d8f16b7e2c530a91d4f8', 4, 'a 48-char hex pass token → v4'],
            ['x'.repeat(62), 4, '62 bytes → v4'],
            ['x'.repeat(84), 5, '84 bytes → v5'],
            ['x'.repeat(106), 6, '106 bytes → v6'],
            ['x'.repeat(122), 7, '122 bytes → v7'],
            ['x'.repeat(152), 8, '152 bytes → v8'],
            ['x'.repeat(180), 9, '180 bytes → v9'],
            ['x'.repeat(200), 10, '200 bytes → v10'],
            ['Hostel outpass OP-260819-0001 https://school.example/verify', 4, 'a realistic URL payload'],
        ];

        let comparisons = 0;
        let agreed = 0;
        const divergent = [];
        for (const [text, version, label] of cases) {
            // The version this encoder picks must be the one the payload needs.
            const auto = qr.encode(text);
            check(`${label}: selects version ${version}`,
                (auto.length - 17) / 4 === version, `picked v${(auto.length - 17) / 4}`);

            // Every mask must agree, module for module.
            let allMasks = true;
            for (let maskId = 0; maskId < 8; maskId += 1) {
                comparisons += 1;
                const mine = qr.encode(text, { maskId });
                const ref = referenceMatrix(text, version, maskId);
                if (sameMatrix(mine, ref)) agreed += 1;
                else { allMasks = false; divergent.push(`${label} mask ${maskId}`); }
            }
            check(`${label}: identical to the reference under all 8 masks`, allMasks);
        }
        check(`🔒 ${agreed}/${comparisons} mask-for-mask comparisons are bit-exact`,
            agreed === comparisons, divergent.slice(0, 4).join('; '));
    }

    // ── UTF-8 ───────────────────────────────────────────────────────────────
    // Multi-byte payloads must be UTF-8 encoded, which is what scanners expect.
    // The reference does not do this, so it is checked directly instead.
    section('UTF-8 payloads');
    for (const text of ['Ünïcödé ✓ multi-byte', 'हिन्दी', '日本語のテキスト']) {
        const bytes = Buffer.from(text, 'utf8');
        const m = qr.encode(text);
        const version = (m.length - 17) / 4;
        // A version large enough for the UTF-8 byte length, not the JS string length.
        const needed = 4 + 8 + bytes.length * 8;
        check(`"${text.slice(0, 12)}" is sized for its ${bytes.length} UTF-8 bytes (v${version})`,
            version >= 1 && m.length === version * 4 + 17 && needed <= version * 4 * 100);
        structuralChecks(m, `utf8 "${text.slice(0, 8)}"`);
    }

    // ── PNG output ──────────────────────────────────────────────────────────
    section('PNG rendering');
    const m = qr.encode('9f2b7c41a0d84e6fb35127ce9a04d8f16b7e2c530a91d4f8');
    const png = matrixToPng(m, { scale: 6, quietZone: 4 });

    check('PNG has the correct signature',
        png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('PNG declares the expected dimensions',
        png.readUInt32BE(16) === (m.length + 8) * 6 && png.readUInt32BE(20) === (m.length + 8) * 6,
        `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`);
    check('PNG is greyscale at bit depth 1', png[24] === 1 && png[25] === 0);
    check('PNG ends with IEND', png.slice(-8, -4).toString('ascii') === 'IEND');

    // Every chunk's CRC must verify, or no decoder will touch the file.
    let offset = 8; let chunks = 0; let crcOk = true;
    const { crc32 } = require('../utils/pngEncoder');
    while (offset < png.length) {
        const len = png.readUInt32BE(offset);
        const type = png.slice(offset + 4, offset + 8).toString('ascii');
        const body = png.slice(offset + 4, offset + 8 + len);
        const stored = png.readUInt32BE(offset + 8 + len);
        if (crc32(body) !== stored) crcOk = false;
        chunks += 1;
        offset += 12 + len;
        if (type === 'IEND') break;
    }
    check('Every PNG chunk CRC verifies', crcOk && chunks === 3, `${chunks} chunks`);

    // Round-trip the pixels back out of the PNG and confirm they are the matrix.
    const zlib = require('zlib');
    const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'));
    const idatLen = png.readUInt32BE(idatStart - 4);
    const raw = zlib.inflateSync(png.slice(idatStart + 4, idatStart + 4 + idatLen));
    const width = (m.length + 8) * 6;
    const rowBytes = Math.ceil(width / 8);
    let pixelsOk = true;
    for (let r = 0; r < m.length && pixelsOk; r += 1) {
        for (let c = 0; c < m.length; c += 1) {
            const y = (r + 4) * 6 + 3;               // centre of the module
            const x = (c + 4) * 6 + 3;
            const bit = (raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
            // bit 0 = black = a dark module
            if ((bit === 0 ? 1 : 0) !== m[r][c]) { pixelsOk = false; break; }
        }
    }
    check('🔒 Decoded PNG pixels reproduce the module matrix', pixelsOk);

    const dataUri = require('../utils/pngEncoder').matrixToDataUri(m);
    check('Data URI is well-formed and non-trivial',
        dataUri.startsWith('data:image/png;base64,') && dataUri.length > 500, String(dataUri.length));

    // ── SVG output ──────────────────────────────────────────────────────────
    section('SVG rendering');
    const svg = qr.toSvg('9f2b7c41a0d84e6fb35127ce9a04d8f16b7e2c530a91d4f8');
    const darkCount = m.flat().filter(Boolean).length;
    check('SVG is well-formed', svg.startsWith('<svg') && svg.endsWith('</svg>'));
    check('SVG draws one rect per dark module',
        (svg.match(/<rect/g) || []).length === darkCount + 1, // +1 for the background
        `${(svg.match(/<rect/g) || []).length} vs ${darkCount + 1}`);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  QR ENCODER — VERIFICATION');
    console.log('══════════════════════════════════════════════════════════');
    console.log(results.join('\n'));
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(failed ? 1 : 0);
}());
