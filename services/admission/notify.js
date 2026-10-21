'use strict';
/**
 * Telling an applicant about their application — the values every
 * application email shares, and sending to the account that applied.
 * Always after the change is committed, and never able to fail it.
 */
const pool = require('../../db/pool');
const mailer = require('./mailer');
const workflow = require('./workflow');
const settingsSvc = require('./settings');

/** The placeholders an application email can show. */
async function applicationValues(app) {
    const { rows: [r] } = await pool.query(
        `SELECT c."className", y."yearName", rd."name" AS "roundName", u."name" AS "applicantName", u."email" AS "applicantEmail"
           FROM "admissionapplications" a
           LEFT JOIN "classes" c ON c."_id" = a."class"
           LEFT JOIN "academicyears" y ON y."_id" = a."academicYear"
           LEFT JOIN "admissionrounds" rd ON rd."_id" = a."round"
           LEFT JOIN "users" u ON u."_id" = a."applicant"
          WHERE a."_id" = $1`, [String(app._id)]);
    const settings = await settingsSvc.getSettings(app.school);
    const links = mailer.portalLinks(settings.slug);
    return {
        to: r?.applicantEmail || '',
        recipient: app.applicant,
        values: {
            applicant_name: r?.applicantName || 'Applicant',
            student_name: app.studentName || 'your child',
            application_number: app.applicationNumber || 'not yet numbered',
            applying_class: r?.className || '',
            academic_year: r?.yearName || '',
            round_name: r?.roundName || '',
            application_link: links.application(app._id),
            // Everything an applicant acts on lives on the application page.
            offer_link: links.application(app._id),
            result_link: links.application(app._id),
            exam_link: links.application(app._id),
            admit_card_link: links.application(app._id),
            receipt_link: links.application(app._id),
            status: workflow.STATUSES[app.status]?.label || app.status,
        },
    };
}

/** Send `event` about `app` to its applicant, after the response. */
function toApplicant(app, event, extra = {}) {
    setImmediate(async () => {
        try {
            const ctx = await applicationValues(app);
            if (ctx.to) await mailer.send(app.school, event, { to: ctx.to, recipient: ctx.recipient, application: app._id, values: { ...ctx.values, ...extra } });
        } catch (e) {
            console.error(`[admission notify] ${event}:`, e.message);
        }
    });
}

/** Send `event` to an applicant about their account rather than one application (privacy requests). */
function toApplicantUser(schoolId, userId, event, extra = {}) {
    setImmediate(async () => {
        try {
            const { rows: [u] } = await pool.query(`SELECT "name", "email" FROM "users" WHERE "_id" = $1`, [String(userId)]);
            if (!u?.email || /^erased\+/.test(u.email)) return;
            await mailer.send(schoolId, event, { to: u.email, recipient: userId, values: { applicant_name: u.name || 'Applicant', ...extra } });
        } catch (e) {
            console.error(`[admission notify] ${event}:`, e.message);
        }
    });
}

module.exports = { applicationValues, toApplicant, toApplicantUser };
