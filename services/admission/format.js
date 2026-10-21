'use strict';
/**
 * How dates, times and money read in admission emails, PDFs and messages.
 * The process clock is the platform's zone (config/timezone), so local
 * getters are the school's day.
 */

const DAY = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

function fmtDate(d, { weekday = false } = {}) {
    if (!d) return '';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toLocaleDateString('en-IN', weekday ? DAY : { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTime(d) {
    if (!d) return '';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
}

const fmtDateTime = (d) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : '');

/** "HH:MM" (24h) → "9:30 AM". */
function fmtClock(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return String(hhmm || '');
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

function money(amount, symbol = '₹') {
    const n = Number(amount) || 0;
    return `${symbol}${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Plain-ASCII amount for PDFs, whose standard fonts have no rupee sign. */
function moneyPlain(amount) {
    const n = Number(amount) || 0;
    return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const minutes = (m) => {
    const n = Number(m) || 0;
    if (n < 60) return `${n} minutes`;
    const h = Math.floor(n / 60);
    const r = n % 60;
    return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minutes` : ''}`;
};

module.exports = { fmtDate, fmtTime, fmtDateTime, fmtClock, money, moneyPlain, minutes };
