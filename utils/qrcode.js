'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Minimal QR Code encoder — byte mode, error-correction level M, versions 1–10.
//
//  Written in-tree rather than pulled in as a dependency: the only thing this
//  app encodes is a short opaque pass token (48 hex chars, comfortably inside
//  version 3), and a QR library would have to be added to three separate
//  codebases — backend, web and the Expo app — to render the same square.
//  Generating it here means the web client and the mobile client both just
//  display an image (see pngEncoder.js), and neither needs to know what a QR
//  code is.
//
//  Implements ISO/IEC 18004: byte-mode encoding, Reed–Solomon ECC over GF(256),
//  block interleaving, function patterns, format/version information and the
//  eight data masks with the standard penalty scoring.
//
//  Verified against an independent encoder — see scripts/testQrEncoder.js.
// ─────────────────────────────────────────────────────────────────────────────

// ── Per-version tables, error-correction level M ─────────────────────────────
// [total codewords, EC codewords per block, group-1 blocks, group-1 data
//  codewords, group-2 blocks, group-2 data codewords]
const VERSIONS_M = {
    1:  [26,  10, 1, 16, 0, 0],
    2:  [44,  16, 1, 28, 0, 0],
    3:  [70,  26, 1, 44, 0, 0],
    4:  [100, 18, 2, 32, 0, 0],
    5:  [134, 24, 2, 43, 0, 0],
    6:  [172, 16, 4, 27, 0, 0],
    7:  [196, 18, 4, 31, 0, 0],
    8:  [242, 22, 2, 38, 2, 39],
    9:  [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
};

// Alignment-pattern centre coordinates per version (empty for version 1).
const ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EC_LEVEL_M_BITS = 0b00;   // L=01, M=00, Q=11, H=10

// ── GF(256) arithmetic, primitive polynomial 0x11D ───────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}());

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of degree `degree`, as coefficients high-order first. */
function generatorPoly(degree) {
    let poly = [1];
    for (let d = 0; d < degree; d += 1) {
        const next = new Array(poly.length + 1).fill(0);
        for (let i = 0; i < poly.length; i += 1) {
            next[i] ^= poly[i];
            next[i + 1] ^= gfMul(poly[i], EXP[d]);
        }
        poly = next;
    }
    return poly;
}

/** Reed–Solomon error-correction codewords for one data block. */
function ecCodewords(data, ecLength) {
    const gen = generatorPoly(ecLength);
    const buf = [...data, ...new Array(ecLength).fill(0)];
    for (let i = 0; i < data.length; i += 1) {
        const coef = buf[i];
        if (coef === 0) continue;
        for (let j = 0; j < gen.length; j += 1) buf[i + j] ^= gfMul(gen[j], coef);
    }
    return buf.slice(data.length);
}

// ── Bit buffer ───────────────────────────────────────────────────────────────
class BitBuffer {
    constructor() { this.bits = []; }
    put(value, length) {
        for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
    }
    get length() { return this.bits.length; }
    toBytes() {
        const out = [];
        for (let i = 0; i < this.bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] || 0);
            out.push(byte);
        }
        return out;
    }
}

// ── BCH codes for format and version information ─────────────────────────────
function bchDigit(data) {
    let digit = 0;
    let v = data;
    while (v !== 0) { digit += 1; v >>>= 1; }
    return digit;
}

function formatInfo(maskId) {
    const data = (EC_LEVEL_M_BITS << 3) | maskId;
    let d = data << 10;
    while (bchDigit(d) - bchDigit(0b10100110111) >= 0) {
        d ^= 0b10100110111 << (bchDigit(d) - bchDigit(0b10100110111));
    }
    return ((data << 10) | d) ^ 0b101010000010010;
}

function versionInfo(version) {
    let d = version << 12;
    while (bchDigit(d) - bchDigit(0b1111100100101) >= 0) {
        d ^= 0b1111100100101 << (bchDigit(d) - bchDigit(0b1111100100101));
    }
    return (version << 12) | d;
}

// ── Data masks ───────────────────────────────────────────────────────────────
const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i, _j) => i % 2 === 0,
    (_i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

// ── Matrix construction ──────────────────────────────────────────────────────
function blankMatrix(size) {
    return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, row, col) {
    const size = m.length;
    for (let r = -1; r <= 7; r += 1) {
        for (let c = -1; c <= 7; c += 1) {
            const rr = row + r; const cc = col + c;
            if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
            const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
                        || (c >= 0 && c <= 6 && (r === 0 || r === 6));
            const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            m[rr][cc] = onRing || inCore ? 1 : 0;
        }
    }
}

function placeAlignment(m, version) {
    const centres = ALIGNMENT[version];
    for (const r of centres) {
        for (const c of centres) {
            // Skip the three corners already covered by the finder patterns.
            if (m[r][c] !== null) continue;
            for (let dr = -2; dr <= 2; dr += 1) {
                for (let dc = -2; dc <= 2; dc += 1) {
                    const ring = Math.max(Math.abs(dr), Math.abs(dc));
                    m[r + dr][c + dc] = ring === 1 ? 0 : 1;
                }
            }
        }
    }
}

function placeTiming(m) {
    const size = m.length;
    for (let i = 8; i < size - 8; i += 1) {
        if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
        if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
    }
}

/** Reserve the format/version areas so data placement skips them. */
function reserveInfoAreas(m, version) {
    const size = m.length;
    for (let i = 0; i < 9; i += 1) {
        if (m[8][i] === null) m[8][i] = 0;
        if (m[i][8] === null) m[i][8] = 0;
    }
    for (let i = 0; i < 8; i += 1) {
        if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
        if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;                       // the always-dark module
    if (version >= 7) {
        for (let i = 0; i < 6; i += 1) {
            for (let j = 0; j < 3; j += 1) {
                if (m[size - 11 + j][i] === null) m[size - 11 + j][i] = 0;
                if (m[i][size - 11 + j] === null) m[i][size - 11 + j] = 0;
            }
        }
    }
}

function writeFormatInfo(m, maskId) {
    const size = m.length;
    const bits = formatInfo(maskId);
    for (let i = 0; i < 15; i += 1) {
        const bit = (bits >>> i) & 1;
        // Copy 1 — around the top-left finder.
        if (i < 6) m[i][8] = bit;
        else if (i < 8) m[i + 1][8] = bit;
        else if (i === 8) m[8][7] = bit;
        else m[8][14 - i] = bit;
        // Copy 2 — split between the other two finders.
        if (i < 8) m[8][size - 1 - i] = bit;
        else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = 1;
}

function writeVersionInfo(m, version) {
    if (version < 7) return;
    const size = m.length;
    const bits = versionInfo(version);
    for (let i = 0; i < 18; i += 1) {
        const bit = (bits >>> i) & 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
}

/** Zig-zag data placement, right to left, skipping the vertical timing column. */
function placeData(m, bits) {
    const size = m.length;
    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;            // the timing column is not a data column
        for (let vert = 0; vert < size; vert += 1) {
            const row = upward ? size - 1 - vert : vert;
            for (let c = 0; c < 2; c += 1) {
                const col = right - c;
                if (m[row][col] !== null) continue;
                m[row][col] = bitIndex < bits.length ? bits[bitIndex] : 0;
                bitIndex += 1;
            }
        }
        upward = !upward;
    }
}

// ── Mask penalty scoring (ISO/IEC 18004 §8.8.2) ──────────────────────────────
function penalty(m) {
    const size = m.length;
    let score = 0;

    // Rule 1 — runs of five or more same-coloured modules in a row or column.
    for (const byRow of [true, false]) {
        for (let a = 0; a < size; a += 1) {
            let run = 1;
            for (let b = 1; b < size; b += 1) {
                const cur  = byRow ? m[a][b]     : m[b][a];
                const prev = byRow ? m[a][b - 1] : m[b - 1][a];
                if (cur === prev) { run += 1; continue; }
                if (run >= 5) score += 3 + (run - 5);
                run = 1;
            }
            if (run >= 5) score += 3 + (run - 5);
        }
    }

    // Rule 2 — 2×2 blocks of one colour.
    for (let r = 0; r < size - 1; r += 1) {
        for (let c = 0; c < size - 1; c += 1) {
            const v = m[r][c];
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
        }
    }

    // Rule 3 — the 1:1:3:1:1 finder-like pattern with four light modules either side.
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (get, start) => {
        let hitA = true; let hitB = true;
        for (let i = 0; i < 11; i += 1) {
            const v = get(start + i);
            if (v !== A[i]) hitA = false;
            if (v !== B[i]) hitB = false;
        }
        return (hitA ? 1 : 0) + (hitB ? 1 : 0);
    };
    for (let a = 0; a < size; a += 1) {
        for (let b = 0; b <= size - 11; b += 1) {
            score += 40 * matches((i) => m[a][i], b);
            score += 40 * matches((i) => m[i][a], b);
        }
    }

    // Rule 4 — deviation of the dark-module proportion from 50%.
    let dark = 0;
    for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) dark += m[r][c];
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Encode `text` as a QR module matrix.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maskId]  force a specific mask (0–7) instead of scoring
 *   all eight. Only used by the verification script, which compares this
 *   encoder against another one mask-for-mask — the two implementations pick
 *   different masks because the penalty rule is a heuristic, so pinning the
 *   mask is what isolates the encoding itself.
 * @returns {number[][]} rows of 0 (light) / 1 (dark), no quiet zone
 */
function encode(text, opts = {}) {
    const bytes = Buffer.from(String(text), 'utf8');

    // Smallest version that fits, at error-correction level M.
    let version = 0;
    for (let v = 1; v <= 10; v += 1) {
        const [, ecLen, g1, dc1, g2, dc2] = VERSIONS_M[v];
        const dataCapacity = g1 * dc1 + g2 * dc2;
        const countBits = v <= 9 ? 8 : 16;
        const needed = Math.ceil((4 + countBits + bytes.length * 8) / 8);
        if (needed <= dataCapacity) { version = v; break; }
        void ecLen;
    }
    if (!version) throw new Error('Payload too large for this QR encoder (max ~213 bytes)');

    const [, ecLen, g1, dc1, g2, dc2] = VERSIONS_M[version];
    const dataCapacity = g1 * dc1 + g2 * dc2;
    const countBits = version <= 9 ? 8 : 16;

    // ── Bit stream: mode, length, payload, terminator, padding ──────────────
    const bb = new BitBuffer();
    bb.put(0b0100, 4);                        // byte mode
    bb.put(bytes.length, countBits);
    for (const b of bytes) bb.put(b, 8);

    const capacityBits = dataCapacity * 8;
    for (let i = 0; i < 4 && bb.length < capacityBits; i += 1) bb.put(0, 1);
    while (bb.length % 8 !== 0) bb.put(0, 1);

    const dataBytes = bb.toBytes();
    const PAD = [0xec, 0x11];
    for (let i = 0; dataBytes.length < dataCapacity; i += 1) dataBytes.push(PAD[i % 2]);

    // ── Split into blocks, compute ECC, interleave ──────────────────────────
    const dataBlocks = []; const ecBlocks = [];
    let offset = 0;
    for (let b = 0; b < g1 + g2; b += 1) {
        const len = b < g1 ? dc1 : dc2;
        const block = dataBytes.slice(offset, offset + len);
        offset += len;
        dataBlocks.push(block);
        ecBlocks.push(ecCodewords(block, ecLen));
    }

    const finalBytes = [];
    const maxData = Math.max(dc1, dc2);
    for (let i = 0; i < maxData; i += 1) {
        for (const block of dataBlocks) if (i < block.length) finalBytes.push(block[i]);
    }
    for (let i = 0; i < ecLen; i += 1) {
        for (const block of ecBlocks) finalBytes.push(block[i]);
    }

    const finalBits = [];
    for (const byte of finalBytes) {
        for (let i = 7; i >= 0; i -= 1) finalBits.push((byte >>> i) & 1);
    }

    // ── Build the matrix and pick the best mask ─────────────────────────────
    const size = version * 4 + 17;
    const base = blankMatrix(size);
    placeFinder(base, 0, 0);
    placeFinder(base, 0, size - 7);
    placeFinder(base, size - 7, 0);
    placeAlignment(base, version);
    placeTiming(base);

    // Remember which cells are function patterns before data goes in.
    const reserved = blankMatrix(size);
    reserveInfoAreas(base, version);
    for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) reserved[r][c] = base[r][c] !== null;
    }

    placeData(base, finalBits);

    let best = null; let bestScore = Infinity;
    const candidates = opts.maskId != null ? [opts.maskId] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const maskId of candidates) {
        const m = base.map((row) => [...row]);
        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) {
                if (reserved[r][c]) continue;
                if (MASKS[maskId](r, c)) m[r][c] ^= 1;
            }
        }
        writeFormatInfo(m, maskId);
        writeVersionInfo(m, version);
        const score = penalty(m);
        if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
}

/**
 * Encode `text` as an SVG string. Used where a vector is preferable to a raster
 * (printing an outpass, for instance).
 */
function toSvg(text, { moduleSize = 4, quietZone = 4, dark = '#000000', light = '#ffffff', maskId } = {}) {
    const m = encode(text, { maskId });
    const size = m.length;
    const total = (size + quietZone * 2) * moduleSize;
    const rects = [];
    for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
            if (!m[r][c]) continue;
            rects.push(`<rect x="${(c + quietZone) * moduleSize}" y="${(r + quietZone) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`);
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
         + `<rect width="${total}" height="${total}" fill="${light}"/>`
         + `<g fill="${dark}">${rects.join('')}</g></svg>`;
}

module.exports = { encode, toSvg };
