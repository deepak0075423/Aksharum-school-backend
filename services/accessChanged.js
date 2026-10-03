'use strict';
/**
 * Telling an open session that what it may open has changed.
 *
 * Every client draws its menu, and guards its routes, from GET /{role}/modules,
 * which it fetches when the session starts. Much of what that payload reports
 * is decided by somebody else, later: the office makes a teacher class teacher
 * (My Section), enrols someone on a bus (Transport), gives a member of staff a
 * bed (My Hostel), activates another academic year. The answer on the server
 * changes at once — nothing there is cached — but a session that was already
 * open kept the old one, so the teacher who had just been given a class was
 * told the page was not theirs until they signed out and back in.
 *
 * So whoever changes it says so here, and the gateway hands `access:changed` to
 * that person's sockets — the same `user:<id>` room their notifications ride
 * (utils/redisPublisher → the gateway's chat.deliver channel, which forwards
 * any event name). The clients answer by asking /modules again.
 *
 * The event carries nothing a client is asked to believe: it is a nudge to ask
 * the server, never the answer. And it is fire-and-forget, like notify() — a
 * nudge that goes missing costs time, not correctness, because the clients also
 * re-ask when the tab or the app comes back to the front, when a page is
 * opened, and before any guard refuses.
 */
const publisher = require('../utils/redisPublisher');

/**
 * @param userIds  one id, a list of ids, or rows carrying `_id`
 * @param reason   a word for the logs and for anyone watching the socket
 * @returns        the ids that were told
 */
function accessChanged(userIds, reason = '') {
    const ids = [...new Set([].concat(userIds || [])
        .map((u) => (u && typeof u === 'object' && u._id ? u._id : u))
        .filter(Boolean)
        .map(String))];
    for (const id of ids) {
        Promise.resolve()
            .then(() => publisher.publishToUser(id, 'access:changed', { reason }))
            .catch(() => {});
    }
    return ids;
}

module.exports = { accessChanged };
