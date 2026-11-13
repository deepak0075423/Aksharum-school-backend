'use strict';
// Video Learning — School Admin (and a teacher whose designation makes them an
// administrator of the module). The school is always the signed-in user's own
// (req.schoolId); a school id in a body or a query is never read.
const { handle, ok, created, paged, audit } = require('../../services/lms/common');
const school = require('../../services/lms/school');
const settings = require('../../services/lms/settings');
const analytics = require('../../services/lms/analytics');

exports.setup = handle(async (req, res) => ok(res, await school.setup(req.schoolId, req.query.academicYear || null)));
exports.setBoard = handle(async (req, res) => {
    const r = await school.setBoard(req.schoolId, req.body, req.userId);
    if (r.changed) await audit(req, 'school.board_set', 'schoolConfig', null, 'Education board chosen', { board: req.body.board, academicYear: req.body.academicYear, ended: r.ended || 0 });
    ok(res, r);
});
exports.setClassSubjects = handle(async (req, res) => {
    const r = await school.setClassSubjects(req.schoolId, req.params.classId, req.body.subjects, req.userId);
    await audit(req, 'school.subjects_set', 'class', req.params.classId, `${r.subjects} subject(s) selected for a class`);
    ok(res, r);
});
exports.availableBooks = handle(async (req, res) => ok(res, await school.availableBooks(req.schoolId, req.params.classId, req.query.subject)));
exports.assignBook = handle(async (req, res) => {
    const r = await school.assignBook(req.schoolId, req.body, req.userId);
    await audit(req, r.scope === 'none' ? 'school.book_removed' : 'school.book_assigned', 'book', r.book,
        r.scope === 'none' ? `"${r.title}" is no longer followed by ${r.className}` : `"${r.title}" assigned to ${r.className} (${r.scope === 'all' ? 'all sections' : 'selected sections'})`,
        { class: r.class, added: r.added, ended: r.ended, sections: req.body.sections });
    ok(res, r);
});
exports.assignmentHistory = handle(async (req, res) => { const r = await school.assignmentHistory(req.schoolId, req.query); paged(res, r.rows, r.total, r.pg); });

exports.listRequests = handle(async (req, res) => { const r = await school.listRequests(req.query, req.schoolId); paged(res, r.rows, r.total, r.pg, { counts: r.counts }); });
exports.getRequest = handle(async (req, res) => ok(res, await school.getRequest(req.params.id, req.schoolId)));
exports.createRequest = handle(async (req, res) => {
    const r = await school.createRequest(req.schoolId, req.body, req.file, req.user);
    await audit(req, 'request.created', 'request', r._id, r.type === 'book' ? `Book requested: "${r.title}"` : `Chapter requested in "${r.bookTitle || r.title}"`);
    created(res, r);
});
exports.withdrawRequest = handle(async (req, res) => {
    const r = await school.withdrawRequest(req.params.id, req.schoolId);
    await audit(req, 'request.withdrawn', 'request', req.params.id, 'Request withdrawn');
    ok(res, r);
});
exports.requestAttachment = handle(async (req, res) => {
    const { file, name } = await school.requestAttachment(req.params.id, req.schoolId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(file, name);
});

exports.getSettings = handle(async (req, res) => ok(res, await settings.school(req.schoolId)));
exports.saveSettings = handle(async (req, res) => {
    const s = await settings.saveSchool(req.schoolId, req.body, req.userId);
    await audit(req, 'school.settings_saved', 'settings', null, 'Video Learning settings changed', s);
    ok(res, s);
});

exports.overview = handle(async (req, res) => {
    const { fresh, ...filters } = req.query;
    ok(res, await analytics.schoolOverview(req.schoolId, filters, { fresh: fresh === '1' }));
});
exports.students = handle(async (req, res) => {
    const { page, limit, search, status, ...filters } = req.query;
    const r = await analytics.students(req.schoolId, filters, null, { page, limit, search, status });
    paged(res, r.rows, r.total, r.pg);
});
exports.audit = handle(async (req, res) => { const r = await analytics.auditLog(req.query, req.schoolId); paged(res, r.rows, r.total, r.pg); });
