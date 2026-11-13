'use strict';
/**
 * Video Learning — what a video file is and how long it runs, read from the
 * file itself with no outside tool.
 *
 * `readAt(offset, length)` returns a Buffer of the file's bytes: a disk read
 * for a local file, a ranged GET for an object in a bucket — so the same code
 * serves both without ever downloading the whole video.
 */

/** 'mp4' (MP4 / MOV / M4V), 'webm' (WebM / Matroska), or null — from the first bytes, not the name. */
function sniff(head) {
    if (!head || head.length < 12) return null;
    if (head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
    return null;
}

/**
 * The length of an MP4 / MOV in seconds, from its movie header (moov › mvhd),
 * or null when the file has none. The header may sit at the very end of the
 * file, so boxes are walked by their sizes rather than read through.
 */
async function mp4Duration(readAt, size) {
    let off = 0;
    for (let guard = 0; guard < 4096 && off + 8 <= size; guard++) {
        const h = await readAt(off, 16);
        if (!h || h.length < 8) return null;
        let boxSize = h.readUInt32BE(0);
        const type = h.toString('latin1', 4, 8);
        let header = 8;
        if (boxSize === 1) { if (h.length < 16) return null; boxSize = Number(h.readBigUInt64BE(8)); header = 16; }
        else if (boxSize === 0) boxSize = size - off;
        if (boxSize < header) return null;
        if (type === 'moov') {
            let c = off + header;
            const end = Math.min(size, off + boxSize);
            for (let inner = 0; inner < 4096 && c + 8 <= end; inner++) {
                const b = await readAt(c, 44);
                if (!b || b.length < 8) return null;
                const childSize = b.readUInt32BE(0);
                if (b.toString('latin1', 4, 8) === 'mvhd') {
                    if (b.length < 32) return null;
                    const v1 = b[8] === 1;
                    if (v1 && b.length < 40) return null;
                    const timescale = b.readUInt32BE(v1 ? 28 : 20);
                    const duration = v1 ? Number(b.readBigUInt64BE(32)) : b.readUInt32BE(24);
                    if (!timescale || !duration || (!v1 && duration === 0xffffffff)) return null;
                    return Math.round((duration / timescale) * 1000) / 1000;
                }
                if (childSize < 8) return null;
                c += childSize;
            }
            return null;
        }
        off += boxSize;
    }
    return null;
}

module.exports = { sniff, mp4Duration };
