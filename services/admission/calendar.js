'use strict';
/**
 * A calendar file (RFC 5545 .ics) for one appointment — an exam or interview
 * time, a campus visit — so a family can put it in their phone's calendar.
 *
 * Every text value is escaped (backslash, comma, semicolon, line breaks), so a
 * school's or family's words can never add a line of their own to the file;
 * long lines are folded at 75 bytes as the standard asks.
 */

const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

/** One content line, folded so no physical line is longer than 75 bytes. */
function fold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
        const b = Buffer.byteLength(ch);
        if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
        cur += ch;
        bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
}

/**
 * ics({ uid, start, minutes, summary, location, description, url })
 * → the file's text. `uid` must be stable for the appointment, so a calendar
 * that imports it twice updates the one event.
 */
function ics({ uid, start, minutes = 60, summary, location = '', description = '', url = '' }) {
    const end = new Date(new Date(start).getTime() + Math.max(5, Number(minutes) || 60) * 60000);
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aksharum//Admissions//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${esc(uid)}@aksharum`,
        `DTSTAMP:${utc(new Date())}`,
        `DTSTART:${utc(start)}`,
        `DTEND:${utc(end)}`,
        `SUMMARY:${esc(summary)}`,
        ...(location ? [`LOCATION:${esc(location)}`] : []),
        ...(description ? [`DESCRIPTION:${esc(description)}`] : []),
        ...(/^https?:\/\//.test(url) ? [`URL:${url.replace(/[\r\n]/g, '')}`] : []),
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(summary)}`, 'TRIGGER:-PT2H', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR',
    ];
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Send it as a download. */
function send(res, name, text) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${String(name).replace(/[^A-Za-z0-9._-]/g, '-')}.ics"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(text);
}

module.exports = { ics, send, esc, fold };
