'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Minimal 1-bit-per-pixel PNG writer, built on Node's own zlib.
//
//  Exists so a QR code can be handed to both clients as a plain data URI: the
//  web app puts it in an <img>, and React Native puts it in an <Image> — neither
//  needs an SVG renderer or a QR library. PNG is the one raster format both
//  understand natively from a data URI.
//
//  Greyscale, bit depth 1 (0 = black, 1 = white), which is exactly what a QR
//  module matrix is.
// ─────────────────────────────────────────────────────────────────────────────
const zlib = require('zlib');

// ── CRC-32, as PNG requires it ───────────────────────────────────────────────
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/**
 * Render a 0/1 module matrix as a PNG.
 *
 * @param {number[][]} matrix   rows of 0 (light) / 1 (dark)
 * @param {object}    [opts]
 * @param {number}    [opts.scale=6]      pixels per module
 * @param {number}    [opts.quietZone=4]  light border, in modules (the spec's minimum)
 * @returns {Buffer} PNG bytes
 */
function matrixToPng(matrix, { scale = 6, quietZone = 4 } = {}) {
    const modules = matrix.length;
    const sizeModules = modules + quietZone * 2;
    const width = sizeModules * scale;
    const height = width;

    // One scanline per pixel row: a filter byte, then ceil(width/8) packed bytes.
    const rowBytes = Math.ceil(width / 8);
    const raw = Buffer.alloc((rowBytes + 1) * height);

    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (rowBytes + 1);
        raw[rowStart] = 0;                                  // filter type 0 (none)
        const moduleRow = Math.floor(y / scale) - quietZone;
        for (let x = 0; x < width; x += 1) {
            const moduleCol = Math.floor(x / scale) - quietZone;
            const inside = moduleRow >= 0 && moduleRow < modules
                        && moduleCol >= 0 && moduleCol < modules;
            const isDark = inside && matrix[moduleRow][moduleCol] === 1;
            // Bit depth 1 greyscale: 1 is white, 0 is black. Start white and
            // clear the bit only where the module is dark.
            if (!isDark) raw[rowStart + 1 + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 1;    // bit depth
    ihdr[9] = 0;    // colour type: greyscale
    ihdr[10] = 0;   // compression: deflate
    ihdr[11] = 0;   // filter method
    ihdr[12] = 0;   // interlace: none

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),   // PNG signature
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The same PNG as a `data:` URI, ready to drop into an <img> or RN <Image>. */
function matrixToDataUri(matrix, opts) {
    return `data:image/png;base64,${matrixToPng(matrix, opts).toString('base64')}`;
}

module.exports = { matrixToPng, matrixToDataUri, crc32 };
