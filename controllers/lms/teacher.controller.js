'use strict';
// Video Learning — Teacher: the books of the sections and subjects they take,
// releasing them, and how their students are getting on. A teacher never sees
// the central library, another teacher's subjects, or another school.
const { handle, ok, created, paged, bad } = require('../../services/lms/common');
const releases = require('../../services/lms/releases');
const analytics = require('../../services/lms/analytics');
const access = require('../../services/lms/access');

exports.workspace = handle(async (req, res) => ok(res, await releases.workspace(req.user)));
exports.book = handle(async (req, res) => ok(res, await releases.bookForTeacher(req.user, req.params.id, req.query.section || null)));
/** The students of one of the teacher's sections — to choose from when releasing to some of them. */
exports.sectionStudents = handle(async (req, res) => {
    const scope = await access.teacherScope(req.user);
    if (!scope.pairs.some((p) => String(p.section) === String(req.params.id))) throw bad('You do not teach in that section');
    ok(res, await access.roster(scope.schoolId, req.params.id));
});

exports.listReleases = handle(async (req, res) => { const r = await releases.list(req.user, req.query); paged(res, r.rows, r.total, r.pg, { counts: r.counts }); });
exports.getRelease = handle(async (req, res) => ok(res, await releases.get(req.user, req.params.id)));
exports.createRelease = handle(async (req, res) => created(res, { releases: await releases.create(req, req.body) }));
exports.updateRelease = handle(async (req, res) => ok(res, await releases.update(req, req.params.id, req.body)));
exports.unpublish = handle(async (req, res) => ok(res, await releases.unpublish(req, req.params.id)));
exports.publish = handle(async (req, res) => ok(res, await releases.publish(req, req.params.id)));
exports.revoke = handle(async (req, res) => ok(res, await releases.revoke(req, req.params.id, req.body)));
exports.rerelease = handle(async (req, res) => created(res, await releases.rerelease(req, req.params.id, req.body)));

const split = (query) => { const { page, limit, search, status, fresh, format, ...filters } = query; return { filters, list: { page, limit, search, status }, fresh: fresh === '1', format }; };

exports.dashboard = handle(async (req, res) => { const s = split(req.query); ok(res, await analytics.teacherDashboard(req.user, s.filters, { fresh: s.fresh })); });
exports.students = handle(async (req, res) => { const s = split(req.query); const r = await analytics.teacherStudents(req.user, s.filters, s.list); paged(res, r.rows, r.total, r.pg); });
exports.studentReport = handle(async (req, res) => ok(res, await analytics.studentReport(req.user, req.params.id, split(req.query).filters)));

const send = (res, file) => {
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.buffer);
};
const formatOf = (v) => { if (!['xlsx', 'pdf'].includes(v)) throw bad('format must be xlsx or pdf'); return v; };
exports.exportClass = handle(async (req, res) => { const s = split(req.query); send(res, await analytics.teacherExport(req.user, s.filters, formatOf(s.format))); });
exports.exportStudent = handle(async (req, res) => send(res, await analytics.studentExport(req.user, req.params.id, formatOf(req.query.format))));
