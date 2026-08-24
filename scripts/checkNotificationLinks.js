'use strict';
/**
 * Every `link: { type: '…' }` written at a notify() call site must name a
 * destination the registry knows, and every destination must produce a real
 * path for each role. A typo here is invisible at runtime — the notification
 * just quietly falls back to the inbox — so it is caught here instead.
 *
 *   node scripts/checkNotificationLinks.js
 */
const fs   = require('fs');
const path = require('path');
const { ROUTES, INBOX, resolve } = require('../services/notificationLinks');

const ROOT  = path.join(__dirname, '..');
const DIRS  = ['controllers', 'services'];
const ROLES = Object.keys(INBOX);

// A `link:` value can be one object, a ternary between two, or spread over
// several lines — so the scan reads from `link:` to the end of that value
// rather than trusting one line to hold it all.
const used = new Map();   // type → [file:line]
for (const dir of DIRS) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(n => n.endsWith('.js'))) {
        const rel  = `${dir}/${f}`;
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const m of text.matchAll(/\blink:\s*(?![:=])/g)) {
            // Take everything up to the comma that ends this property, tracking
            // braces so a nested `params: { … }` does not cut the value short.
            let depth = 0, end = m.index + m[0].length;
            for (; end < text.length; end++) {
                const c = text[end];
                if (c === '{') depth++;
                else if (c === '}') { if (depth === 0) break; depth--; }
                else if (c === ',' && depth === 0) break;
                else if (c === '\n' && depth === 0 && /[,;)]\s*$/.test(text.slice(m.index, end))) break;
            }
            const value = text.slice(m.index, end);
            const line  = text.slice(0, m.index).split('\n').length;
            for (const q of value.matchAll(/\btype:\s*[^,}]*?'([a-zA-Z][\w.]*)'/g)) {
                if (!used.has(q[1])) used.set(q[1], []);
                used.get(q[1]).push(`${rel}:${line}`);
            }
            // The ternary form names a second type after the colon
            for (const q of value.matchAll(/:\s*'([a-zA-Z][\w.]+\.[\w.]+)'/g)) {
                if (!used.has(q[1])) used.set(q[1], []);
                if (!used.get(q[1]).includes(`${rel}:${line}`)) used.get(q[1]).push(`${rel}:${line}`);
            }
        }
    }
}

let bad = 0;

for (const [type, where] of used) {
    if (!ROUTES[type]) {
        console.error(`✗ unknown link type "${type}"  ← ${where.join(', ')}`);
        bad++;
    }
}

// Every registered destination must resolve to a usable path for every role,
// with no template slot left unfilled.
for (const type of Object.keys(ROUTES)) {
    for (const role of ROLES) {
        const r = resolve({ type, entityId: 'ID', params: { sectionId: 'SEC' } }, role, 'RCPT');
        if (!r.web || !r.mobile || r.web.includes('{') || r.mobile.includes('{')) {
            console.error(`✗ "${type}" produces a broken path for ${role}: ${r.web} | ${r.mobile}`);
            bad++;
        }
    }
}

const unused = Object.keys(ROUTES).filter(t => !used.has(t));
console.log(`${used.size} link types used across ${DIRS.join(', ')}; ${Object.keys(ROUTES).length} registered.`);
if (unused.length) console.log(`  (registered but unused: ${unused.join(', ')})`);

if (bad) { console.error(`\n${bad} problem(s).`); process.exit(1); }
console.log('All notification links resolve.');
