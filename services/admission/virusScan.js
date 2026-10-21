'use strict';
/**
 * Virus scanning of admission uploads (Oct 2026) through ClamAV's daemon
 * (clamd), over its INSTREAM command: the file is sent in length-prefixed
 * chunks and clamd answers "stream: OK" or "stream: <signature> FOUND".
 *
 *   CLAMAV_HOST         clamd's address — scanning is off without it
 *   CLAMAV_PORT         default 3310
 *   CLAMAV_REQUIRED     true: refuse uploads while clamd cannot be reached
 *                       (otherwise they are kept, marked "not scanned")
 *   CLAMAV_TIMEOUT_MS   default 15000
 *
 * The answer is recorded on the document as it came. A file is never called
 * clean unless clamd said so.
 */
const fs = require('fs');
const net = require('net');

function config() {
    const host = String(process.env.CLAMAV_HOST || '').trim();
    return {
        enabled: !!host, host, port: Number(process.env.CLAMAV_PORT) || 3310,
        required: /^(1|true|yes)$/i.test(String(process.env.CLAMAV_REQUIRED || '')),
        timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS) || 15000,
    };
}

/** Talk to clamd: send `writeBody(socket)`, read the reply up to its NUL. */
function talk(c, writeBody) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: c.host, port: c.port });
        let reply = '';
        let done = false;
        const finish = (fn, v) => { if (done) return; done = true; sock.destroy(); fn(v); };
        sock.setTimeout(c.timeoutMs, () => finish(reject, new Error('clamd did not answer in time')));
        sock.on('error', (e) => finish(reject, e));
        sock.on('data', (d) => {
            reply += d.toString('utf8');
            if (reply.includes('\0')) finish(resolve, reply.split('\0')[0].trim());
        });
        sock.on('end', () => finish(resolve, reply.replace(/\0/g, '').trim()));
        sock.on('connect', () => { writeBody(sock).catch((e) => finish(reject, e)); });
    });
}

/** Stream a file's bytes in INSTREAM frames, waiting when the socket is full. */
async function sendFile(sock, filePath) {
    sock.write('zINSTREAM\0');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        const ok = sock.write(Buffer.concat([len, chunk]));
        if (!ok) await new Promise((r) => sock.once('drain', r));
    }
    sock.write(Buffer.alloc(4));   // a zero-length frame ends the stream
}

/**
 * Scan a file. Returns { status, signature }:
 *   clean        clamd found nothing
 *   infected     clamd found `signature`
 *   unavailable  clamd could not be asked, or answered with an error
 *   off          scanning is not set up
 */
async function scanFile(filePath) {
    const c = config();
    if (!c.enabled) return { status: 'off', signature: '' };
    try {
        const reply = await talk(c, (sock) => sendFile(sock, filePath));
        const found = /^stream:\s*(.+)\s+FOUND$/i.exec(reply);
        if (found) return { status: 'infected', signature: found[1].trim().slice(0, 120) };
        if (/^stream:\s*OK$/i.test(reply)) return { status: 'clean', signature: '' };
        return { status: 'unavailable', signature: '', error: reply.slice(0, 200) || 'No answer' };
    } catch (e) {
        return { status: 'unavailable', signature: '', error: String(e.message || e).slice(0, 200) };
    }
}

/** For the health card: is scanning on, and does clamd answer? */
async function status() {
    const c = config();
    if (!c.enabled) return { on: false };
    try {
        const reply = await talk({ ...c, timeoutMs: Math.min(c.timeoutMs, 3000) }, async (sock) => { sock.write('zPING\0'); });
        return { on: true, reachable: reply === 'PONG', required: c.required };
    } catch (e) {
        return { on: true, reachable: false, required: c.required, error: String(e.message || e).slice(0, 200) };
    }
}

module.exports = { config, scanFile, status };
