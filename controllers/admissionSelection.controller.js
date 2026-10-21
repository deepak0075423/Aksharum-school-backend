'use strict';
/**
 * Selection lists, offers, confirmation and enrolment — administrators only.
 */
const pool = require('../db/pool');
const AdmissionList = require('../models/AdmissionList');
const access = require('../services/admission/access');
const selection = require('../services/admission/selection');
const conversion = require('../services/admission/conversion');
const settingsSvc = require('../services/admission/settings');
const seats = require('../services/admission/seats');
const exportsSvc = require('../services/admission/exports');
const workflow = require('../services/admission/workflow');
const pdf = require('../services/admission/pdf');
const events = require('../services/admission/events');
const { handler, refuse, isId } = require('../services/admission/util');

const TAG = 'admission selection';
const listOf = (req, id) => access.schoolRow(AdmissionList, req, id, 'List');

async function linesOf(listId) {
    const { rows } = await pool.query(
        `SELECT e."_id", e."rank", e."score", e."breakdown", e."decision", e."waitPosition", e."manual", e."reason", e."offer",
                a."_id" AS "applicationId", a."applicationNumber", a."studentName", a."studentDob", a."status", a."docStatus", a."submittedAt",
                o."status" AS "offerStatus", o."offerNumber", u."name" AS "changedByName"
           FROM "admissionlistentries" e JOIN "admissionapplications" a ON a."_id" = e."application"
           LEFT JOIN "admissionoffers" o ON o."_id" = e."offer" LEFT JOIN "users" u ON u."_id" = e."changedBy"
          WHERE e."list" = $1 ORDER BY e."rank" NULLS LAST, a."applicationNumber"`, [String(listId)]);
    return rows.map((r) => ({ ...r, statusLabel: workflow.STATUSES[r.status]?.label || r.status }));
}

exports.lists = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    let extra = '';
    if (req.query.round && isId(String(req.query.round))) { params.push(String(req.query.round)); extra += ` AND l."round" = $${params.length}`; }
    if (req.query.class && isId(String(req.query.class))) { params.push(String(req.query.class)); extra += ` AND l."class" = $${params.length}`; }
    const { rows } = await pool.query(
        `SELECT l.*, c."className", r."name" AS "roundName",
                (SELECT COUNT(*) FROM "admissionlistentries" e WHERE e."list" = l."_id" AND e."decision" = 'selected')::int AS selected,
                (SELECT COUNT(*) FROM "admissionlistentries" e WHERE e."list" = l."_id" AND e."decision" = 'waitlisted')::int AS waitlisted,
                (SELECT COUNT(*) FROM "admissionlistentries" e WHERE e."list" = l."_id")::int AS lines
           FROM "admissionlists" l LEFT JOIN "classes" c ON c."_id" = l."class" LEFT JOIN "admissionrounds" r ON r."_id" = l."round"
          WHERE l."school" = $1${extra} ORDER BY l."createdAt" DESC`, params);
    res.json({ success: true, data: rows.map(selection.publicList) });
}, TAG);

exports.create = handler(async (req, res) => {
    const r = await selection.createList(req, req.body || {});
    res.status(201).json({ success: true, data: r });
}, TAG);

exports.detail = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    const [lines, seat, cls, round] = await Promise.all([
        linesOf(list._id), seats.state(list.round, list.class),
        pool.query(`SELECT "className", "classNumber" FROM "classes" WHERE "_id" = $1`, [String(list.class)]).then((r) => r.rows[0]),
        pool.query(`SELECT "name" FROM "admissionrounds" WHERE "_id" = $1`, [String(list.round)]).then((r) => r.rows[0]),
    ]);
    const { rows: examOptions } = await pool.query(`SELECT "_id", "name", "mode", "maxMarks", "resultsStatus" FROM "admissionexams" WHERE "round" = $1 AND "status" <> 'cancelled'`, [String(list.round)]);
    const settings = await settingsSvc.getSettings(req.schoolId);
    // Earlier draws of this class that were cancelled stay visible beside this one.
    const { rows: cancelledDraws } = await pool.query(
        `SELECT "_id", "name", "cancelReason", "updatedAt", ("draw" IS NOT NULL) AS "drawn" FROM "admissionlists"
          WHERE "round" = $1 AND "class" = $2 AND "status" = 'cancelled' AND "_id" <> $3 ORDER BY "updatedAt" DESC`, [String(list.round), String(list.class), String(list._id)]);
    res.json({ success: true, data: {
        list: selection.publicList(list), lines, seats: seat, className: cls?.className, roundName: round?.name, exams: examOptions,
        screening: require('../services/admission/compliance').screeningRule(settings, cls), cancelledDraws,
    } });
}, TAG);

exports.update = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.updateList(req, list, req.body || {}) });
}, TAG);

exports.rebuild = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.build(list) });
}, TAG);

exports.decision = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.setDecision(req, list, req.params.entryId, req.body || {}) });
}, TAG);

exports.submit = handler(async (req, res) => res.json({ success: true, data: await selection.submitForApproval(req, await listOf(req, req.params.id)) }), TAG);
exports.approve = handler(async (req, res) => res.json({ success: true, data: await selection.approve(req, await listOf(req, req.params.id)) }), TAG);
exports.sendBack = handler(async (req, res) => res.json({ success: true, data: await selection.sendBack(req, await listOf(req, req.params.id), req.body?.note) }), TAG);

exports.publish = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.publish(req, list, { at: req.body?.at || null }) });
}, TAG);

exports.draw = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.drawLottery(req, list, req.body || {}) });
}, TAG);

exports.verifyDraw = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.verifyDraw(list) });
}, TAG);

exports.cancel = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    res.json({ success: true, data: await selection.cancelList(req, list, req.body?.reason) });
}, TAG);

exports.close = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    if (list.status !== 'published') refuse('Only a published list can be closed', 409);
    const { patch } = require('../db/patch');
    const row = await patch(AdmissionList, list._id, { status: 'closed' }, { where: { status: 'published' } });
    events.recordQuietly(req.schoolId, { by: req, type: 'list', action: 'closed', message: `${list.name} closed` });
    res.json({ success: true, data: row });
}, TAG);

exports.remove = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    if (!['draft', 'pending_approval'].includes(list.status)) refuse('A published list cannot be deleted — close it instead', 409);
    if (list.draw) refuse('A drawn lottery cannot be deleted — cancel it instead, so the draw stays on record', 409, { code: 'ALREADY_DRAWN' });
    await pool.query(`DELETE FROM "admissionlists" WHERE "_id" = $1 AND "school" = $2`, [String(list._id), String(req.schoolId)]);
    events.recordQuietly(req.schoolId, { by: req, type: 'list', action: 'deleted', message: `${list.name} deleted` });
    res.json({ success: true });
}, TAG);

exports.exportList = handler(async (req, res) => {
    const list = await listOf(req, req.params.id);
    const lines = await linesOf(list._id);
    const { rows: [cls] } = await pool.query(`SELECT "className" FROM "classes" WHERE "_id" = $1`, [String(list.class)]);
    const { rows: [round] } = await pool.query(`SELECT "name" FROM "admissionrounds" WHERE "_id" = $1`, [String(list.round)]);
    if (req.query.format === 'pdf') {
        const school = (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows[0];
        const settings = await settingsSvc.getSettings(req.schoolId);
        return pdf.selectionList(res, { school, theme: settings.portal.theme?.primary, list, className: cls?.className || '', roundName: round?.name || '', lines, office: req.query.office !== '0' });
    }
    const drawn = selection.isLottery(list);
    const header = [drawn ? 'Draw no.' : 'Rank', 'Application', 'Student', drawn ? 'Points' : 'Score', ...(drawn ? ['Draw key'] : []), 'Decision', 'Waiting position', 'Changed by hand', 'Reason', 'Offer', 'Application status'];
    const body = lines.map((l) => [l.rank ?? '', l.applicationNumber, l.studentName, l.score ?? '', ...(drawn ? [l.breakdown?.drawKey || ''] : []), l.decision.replace('_', ' '), l.waitPosition ?? '', l.manual ? 'Yes' : '', l.reason || '', l.offerStatus || '', l.statusLabel]);
    return exportsSvc.send(res, { filename: `${list.name}-${cls?.className || ''}`.replace(/[^\w-]+/g, '_'), sheet: list.name, header, body, format: req.query.format === 'csv' ? 'csv' : 'xlsx' });
}, TAG);

// ── Offers ───────────────────────────────────────────────────────────────────

exports.offers = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    let extra = '';
    if (['issued', 'accepted', 'declined', 'expired', 'withdrawn', 'confirmed', 'cancelled'].includes(req.query.status)) { params.push(req.query.status); extra += ` AND o."status" = $${params.length}`; }
    if (req.query.round && isId(String(req.query.round))) { params.push(String(req.query.round)); extra += ` AND o."round" = $${params.length}`; }
    const { rows } = await pool.query(
        `SELECT o.*, a."applicationNumber", a."studentName", a."status" AS "applicationStatus", a."admissionFeeStatus", c."className", l."name" AS "listName"
           FROM "admissionoffers" o JOIN "admissionapplications" a ON a."_id" = o."application"
           LEFT JOIN "classes" c ON c."_id" = o."class" LEFT JOIN "admissionlists" l ON l."_id" = o."list"
          WHERE o."school" = $1${extra} ORDER BY o."issuedAt" DESC LIMIT 500`, params);
    res.json({ success: true, data: rows });
}, TAG);

exports.manualOffer = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const r = await selection.manualOffer(req, app, req.body || {});
    res.status(201).json({ success: true, data: { offer: r.offer, status: r.app.status } });
}, TAG);

exports.withdrawOffer = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await selection.withdrawOffer(req, app, req.body?.reason) });
}, TAG);

exports.extendOffer = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await selection.extendOffer(req, app, req.body?.date) });
}, TAG);

exports.respondOnBehalf = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const accept = req.body?.accept === true;
    const note = String(req.body?.note || '').trim();
    if (!note) refuse('Note how the family answered (a call, a letter)', 400, { field: 'note' });
    const row = await selection.respond(req, app, accept, `On behalf of the family: ${note}`);
    res.json({ success: true, data: { status: row.status } });
}, TAG);

// ── Confirmation and enrolment ───────────────────────────────────────────────

exports.confirmation = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const settings = await settingsSvc.getSettings(app.school);
    res.json({ success: true, data: { blockers: await selection.confirmationBlockers(app, settings), status: app.status } });
}, TAG);

exports.confirm = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const row = await selection.confirm(req, app);
    res.json({ success: true, data: { status: row.status } });
}, TAG);

exports.conversionPreview = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await conversion.preview(req, app) });
}, TAG);

exports.convert = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const r = await conversion.convert(req, app, req.body || {});
    res.json({ success: true, data: r, message: r.replay ? 'Already enrolled — nothing was created twice' : `Enrolled with admission number ${r.admissionNumber}` });
}, TAG);

exports.activate = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await conversion.activate(req, app) });
}, TAG);
