'use strict';
/**
 * The Medical Room, live (Oct 2026). When a request, a visit, a dose or an
 * urgent notice changes, the medical staff's screens hear it through the
 * websocket gateway (the chat broker's per-user channel) and reload, instead
 * of waiting for their next poll; the teacher who sent a student hears the
 * changes to their request. Without Redis or the gateway this does nothing —
 * the screens' polling still works.
 *
 *   'medical:changed'  { kind: request|visit|dose|incident|urgent, id?, urgent? }  → medical staff
 *   'medical:request'  { id, status }                                             → the requesting teacher
 */
const tell = require('./medicalNotify');

const broker = () => require('./chatBrokerService');
const quietly = (p) => Promise.resolve(p).catch(() => {});

/** Tell every member of the medical staff of a school. */
async function toStaff(schoolId, data) {
    try {
        const ids = await tell.staffIds(schoolId);
        for (const id of ids) quietly(broker().publishToUser(String(id), 'medical:changed', { at: Date.now(), ...data }));
    } catch { /* live is a nicety */ }
}

// A bulk job (an import of hundreds of rows) sets req.quietLive and sends one nudge when it is done.
const changed = (req, kind, data = {}) => { if (!req?.quietLive) toStaff(req.schoolId, { kind, ...data }); };
const toUser = (userId, event, data) => { if (userId) quietly(broker().publishToUser(String(userId), event, data)); };

module.exports = { changed, toStaff, toUser };
