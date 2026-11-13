'use strict';
// Video Learning — Student: their books, what has been released to them, and
// watching it. Who the student is comes from the session token; a student,
// class or section id in a request is never read.
const { handle, ok, paged } = require('../../services/lms/common');
const student = require('../../services/lms/student');
const tracking = require('../../services/lms/tracking');

exports.dashboard = handle(async (req, res) => ok(res, await student.dashboard(req.user)));
exports.book = handle(async (req, res) => ok(res, await student.book(req.user, req.params.id)));
exports.chapter = handle(async (req, res) => ok(res, await student.chapter(req.user, req.params.id)));
exports.video = handle(async (req, res) => ok(res, await student.video(req.user, req.params.id)));
exports.history = handle(async (req, res) => { const r = await student.history(req.user, req.query); paged(res, r.rows, r.total, r.pg); });

exports.authorize = handle(async (req, res) => ok(res, await tracking.authorize(req, req.params.id)));
exports.renew = handle(async (req, res) => ok(res, await tracking.renew(req, req.params.id)));
exports.heartbeat = handle(async (req, res) => ok(res, await tracking.heartbeat(req, req.params.id, req.body || {})));
exports.end = handle(async (req, res) => ok(res, await tracking.end(req, req.params.id)));
