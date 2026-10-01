'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Reading a hostel file.
//
//  The folder these live in (uploads/hostel-docs) is no longer served to the
//  public — see server.js. A file is read one of two ways:
//
//    GET /hostel/files/:name        with a login; this file decides whose it is
//    GET /hostel/file/:name?exp&sig a short-lived link the API handed to
//                                   someone it had already checked
//
//  Who may read a file with a login:
//    · the people who run the hostel — every file, or, for a teacher in on a
//      posting, the files of their own hostels (and ones tied to no hostel);
//    · a resident, or a parent for their child — a file registered to that
//      resident, one they uploaded themselves, or one attached to their own
//      leave, outpass, complaint, incident or disciplinary record.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');

const HostelDocument   = require('../models/HostelDocument');
const HostelLeave      = require('../models/HostelLeave');
const HostelOutpass    = require('../models/HostelOutpass');
const HostelComplaint  = require('../models/HostelComplaint');
const HostelIncident   = require('../models/HostelIncident');
const HostelDiscipline = require('../models/HostelDiscipline');
const designations = require('../services/designationService');
const { bad, fail, visibleHostelIds, childIdsOfParent, checkFileSig } = require('../services/hostelService');

const DIR = path.join(__dirname, '..', 'uploads', 'hostel-docs');

function send(res, name) {
    const file = path.join(DIR, path.basename(name));
    if (!fs.existsSync(file)) return bad(res, 'File not found', 404);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(file);
}

/** Is `name` attached to one of these residents' own records? */
async function attachedToTheirs(schoolId, name, studentIds) {
    for (const Model of [HostelLeave, HostelOutpass, HostelComplaint, HostelIncident, HostelDiscipline]) {
        const { rows } = await pool.query(
            `SELECT 1 FROM "${Model.tableName}" WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "attachments" @> $3::jsonb LIMIT 1`,
            [String(schoolId), studentIds, JSON.stringify([name])]);
        if (rows.length) return true;
    }
    return false;
}

exports.signedFile = (req, res) => {
    try {
        const name = path.basename(String(req.params.storedName || ''));
        if (!checkFileSig(name, req.query.exp, req.query.sig)) return bad(res, 'This link has expired — open the file again from the hostel screen', 403);
        return send(res, name);
    } catch (e) { return fail(res, e); }
};

exports.authedFile = async (req, res) => {
    try {
        const name = path.basename(String(req.params.storedName || ''));
        if (!name) return bad(res, 'Which file?');
        const doc = await HostelDocument.findOne({ storedName: name }).select('school hostel student uploadedBy').lean();
        // A registered file belongs to one school; nobody from another reads it.
        if (doc && String(doc.school) !== String(req.schoolId)) return bad(res, 'File not found', 404);

        const role = req.userRole;
        if (role === 'school_admin') return send(res, name);

        if (role === 'teacher') {
            const access = await designations.requestAccess(req);
            if (access.permissions?.hostel === designations.ADMIN) return send(res, name);
            const posted = await visibleHostelIds({ ...req, access });
            if (posted && posted.length && (!doc?.hostel || posted.includes(String(doc.hostel)))) return send(res, name);
        }

        // A resident (a student, or a teacher who lives in) or a parent.
        const mine = role === 'parent' ? await childIdsOfParent(req.userId) : [String(req.userId)];
        if (!mine.length) return bad(res, 'File not found', 404);
        if (doc && (mine.includes(String(doc.student)) || String(doc.uploadedBy) === String(req.userId))) return send(res, name);
        if (await attachedToTheirs(req.schoolId, name, mine)) return send(res, name);
        return bad(res, 'File not found', 404);
    } catch (e) { return fail(res, e); }
};
