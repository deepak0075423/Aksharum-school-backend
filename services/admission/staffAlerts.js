'use strict';
/**
 * Telling the school's own people about admission work that is waiting for
 * them (Nov 2026): the bell in the app, and each person's phone or browser
 * notification — never an email, never to a family. Until now staff heard
 * about a freed seat, a stage running late and a privacy request, and nothing
 * else: a new application, an approval waiting, an application assigned, an
 * appeal filed, an offer answered and money received all sat unseen until
 * somebody opened the right screen.
 *
 * Always after the change is committed, and never able to fail it.
 */
const designations = require('../designationService');

function send(schoolId, recipients, { title, body, link = null, by = null }) {
    try {
        const list = [...new Set((recipients || []).map((r) => String(r?._id ?? r)).filter(Boolean))];
        if (!list.length || !title || !body) return;
        require('../notifyService').notify({
            school: schoolId, sender: by || list[0], senderRole: 'system', recipients: list, includeSender: !by,
            title: String(title).slice(0, 160), body: String(body).slice(0, 600), link,
        });
    } catch (e) { console.error('[admission staff alert]', e.message); }
}

/** The admission administrators of the school (school admins + module-admin teachers), less `except`. */
function toAdmins(schoolId, { except = null, also = [], ...msg }) {
    setImmediate(async () => {
        try {
            const admins = await designations.moduleAdminIds(schoolId, 'admission');
            const list = [...new Set([...admins, ...also].map(String))].filter((id) => !except || id !== String(except));
            send(schoolId, list, msg);
        } catch (e) { console.error('[admission staff alert]', e.message); }
    });
}

/** Named members of staff — an application's assignee, a stage's handlers. */
function toUsers(schoolId, userIds, msg) {
    setImmediate(() => send(schoolId, userIds, msg));
}

/** The person an application is assigned to, else the administrators. */
function aboutApplication(app, msg) {
    const link = msg.link || { type: 'admission.application', entityId: String(app._id) };
    if (app.assignedTo) toUsers(app.school, [app.assignedTo], { ...msg, link });
    else toAdmins(app.school, { ...msg, link });
}

module.exports = { toAdmins, toUsers, aboutApplication };
