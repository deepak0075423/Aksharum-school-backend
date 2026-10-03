'use strict';
/**
 * Asking for a paper to be checked again (Oct 2026).
 *
 * A student, or a parent for their child, may ask for one paper of a published
 * result to be re-checked — re-totalled, or looked at again — within the days
 * the school allows after the results reach them (Results → Settings; 0 turns
 * it off). The office (and the paper's subject teacher, who is told) looks at
 * it and answers: the marks stand, or they were wrong — corrected in place,
 * the result worked out again (resultExams.correctPublishedMark) — or the
 * request is declined. The family hears the answer.
 */
const pool = require('../db/pool');
const ResultRecheck = require('../models/ResultRecheck');
const FormalExam = require('../models/FormalExam');
const FormalResult = require('../models/FormalResult');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const settings = require('./resultSettings');
const exams = require('./resultExams');
const designations = require('./designationService');
const { notify } = require('./notifyService');

const { RuleError, visibleToFamilies, familyOf, withheldOf } = exams;
const fail = (status, message) => { throw new RuleError(status, message); };
const publishedOn = (e) => require('./resultBoard').publishedOn(e);

function safeNotify(opts) {
    try { if (opts.recipients?.length && opts.sender) notify(opts); } catch (e) { console.error('[recheck] notice failed:', e.message); }
}

/** A family asks for a paper to be checked again. */
async function request(ctx, { studentId, examId, subjectId, reason = '' } = {}) {
    if (![studentId, examId, subjectId].every((v) => isUuid(String(v || '')))) fail(400, 'Choose the exam and the paper');
    const exam = await FormalExam.findOne({ _id: examId, school: ctx.schoolId }).lean();
    if (!exam || !visibleToFamilies(exam) || withheldOf(exam).has(String(studentId))) fail(404, 'That result is not available');
    const result = await FormalResult.findOne({ exam: exam._id, student: studentId }).select('subjects').lean();
    const paper = (result?.subjects || []).find((x) => String(x.subject) === String(subjectId));
    if (!paper) fail(404, 'That paper is not part of the result');
    const conf = await settings.get(ctx.schoolId);
    if (!conf.recheckDays) fail(400, 'The school does not take re-check requests');
    const since = publishedOn(exam);
    if (!since || Date.now() > new Date(since).getTime() + conf.recheckDays * 864e5) {
        fail(400, `Re-checks can be asked for within ${conf.recheckDays} day${conf.recheckDays === 1 ? '' : 's'} of the results — that time has passed`);
    }
    const open = await ResultRecheck.findOne({ exam: exam._id, student: studentId, subject: subjectId, status: 'open' }).select('_id').lean();
    if (open) fail(409, 'A re-check of this paper is already being looked at');
    const why = String(reason || '').trim().slice(0, 500);
    if (!why) fail(400, 'Say what should be checked — a total, a question, a page');

    const row = await ResultRecheck.create({
        school: ctx.schoolId, exam: exam._id, student: studentId, subject: subjectId,
        requestedBy: ctx.userId, requestedByRole: ctx.userRole || '', reason: why,
        before: { marksObtained: paper.isAbsent ? null : paper.marksObtained, isAbsent: !!paper.isAbsent, grade: paper.grade || '' },
    });
    const [sub, stu, links, office, section] = await Promise.all([
        Subject.findById(subjectId).select('subjectName').lean(),
        User.findById(studentId).select('name').lean(),
        SectionSubjectTeacher.find({ section: exam.section, subject: subjectId }).select('teacher').lean(),
        designations.moduleAdminIds(ctx.schoolId, 'result').catch(() => []),
        ClassSection.findById(exam.section).select('sectionName class').lean(),
    ]);
    const cls = section?.class ? await Class.findById(section.class).select('className').lean() : null;
    const where = [cls?.className, section?.sectionName].filter(Boolean).join(' – ');
    safeNotify({
        school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
        title: `🔍 Re-check asked: ${sub?.subjectName || 'a paper'}, ${exam.title}`,
        body: `${stu?.name || 'A student'} (${where}) has asked for the ${sub?.subjectName || ''} paper of "${exam.title}" to be checked again.\n${why}`,
        recipients: [...new Set([...office, ...links.map((l) => String(l.teacher))])], link: { type: 'results.recheck', entityId: row._id },
    });
    return row;
}

/** The office's list of requests: open first, newest first. */
async function officeList(schoolId, { status = '' } = {}) {
    const params = [String(schoolId)];
    let w = '';
    if (['open', 'resolved', 'declined'].includes(status)) { params.push(status); w = `AND rc."status" = $2`; }
    const { rows } = await pool.query(`
        SELECT rc."_id", rc."exam", rc."student", rc."subject", rc."reason", rc."status", rc."outcome", rc."response",
               rc."before", rc."after", rc."createdAt", rc."resolvedAt", rc."requestedByRole",
               e."title" AS "examTitle", e."status" AS "examStatus", e."gradeBands", sub."subjectName", u."name" AS "studentName",
               rq."name" AS "requestedByName", rv."name" AS "resolvedByName",
               s."sectionName", c."className",
               (SELECT p FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r."subjects") = 'array' THEN r."subjects" ELSE '[]'::jsonb END) p
                 WHERE p->>'subject' = rc."subject"::text LIMIT 1) AS "paper"
          FROM "${ResultRecheck.tableName}" rc
          JOIN "${FormalExam.tableName}" e ON e."_id" = rc."exam"
          LEFT JOIN "${FormalResult.tableName}" r ON r."exam" = rc."exam" AND r."student" = rc."student"
          LEFT JOIN "${Subject.tableName}" sub ON sub."_id" = rc."subject"
          LEFT JOIN "${User.tableName}" u ON u."_id" = rc."student"
          LEFT JOIN "${User.tableName}" rq ON rq."_id" = rc."requestedBy"
          LEFT JOIN "${User.tableName}" rv ON rv."_id" = rc."resolvedBy"
          LEFT JOIN "${ClassSection.tableName}" s ON s."_id" = e."section"
          LEFT JOIN "${Class.tableName}" c ON c."_id" = s."class"
         WHERE rc."school" = $1::uuid ${w}
         ORDER BY (rc."status" = 'open') DESC, rc."createdAt" DESC
         LIMIT 300`, params);
    const { rows: [counts] } = await pool.query(
        `SELECT count(*) FILTER (WHERE "status" = 'open')::int AS "open", count(*)::int AS "all" FROM "${ResultRecheck.tableName}" WHERE "school" = $1::uuid`, [String(schoolId)]);
    return {
        counts: counts || { open: 0, all: 0 },
        data: rows.map((r) => ({
            _id: r._id, exam: { _id: r.exam, title: r.examTitle, published: r.examStatus === 'FINAL_APPROVED' },
            student: { _id: r.student, name: r.studentName || 'Student' }, className: r.className || '', sectionName: r.sectionName || '',
            subject: { _id: r.subject, subjectName: r.subjectName || 'Subject' },
            paper: r.paper ? {
                marksObtained: r.paper.isAbsent ? null : Number(r.paper.marksObtained), isAbsent: !!r.paper.isAbsent, maxMarks: Number(r.paper.maxMarks),
                grade: r.paper.grade || '', components: Array.isArray(r.paper.components) ? r.paper.components : null, gradeOnly: !!r.paper.gradeOnly,
            } : null,
            // A graded paper's grades: the scale the exam was published on.
            grades: Array.isArray(r.gradeBands?.bands) ? r.gradeBands.bands.map((b) => b.grade) : [],
            reason: r.reason, status: r.status, outcome: r.outcome || '', response: r.response || '',
            before: r.before || null, after: r.after || null,
            requestedBy: r.requestedByName || '', requestedByRole: r.requestedByRole || '',
            createdAt: r.createdAt, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedByName || '',
        })),
    };
}

/**
 * The office answers: 'unchanged' (the marks stand), 'change' (they were
 * wrong — corrected in place, with the mark given), or 'decline'.
 */
async function resolve(ctx, id, body = {}) {
    if (!isUuid(String(id || ''))) fail(404, 'Request not found');
    const rc = await ResultRecheck.findOne({ _id: id, school: ctx.schoolId }).lean();
    if (!rc) fail(404, 'Request not found');
    if (rc.status !== 'open') fail(409, 'This request has already been answered');
    const action = String(body.action || '');
    if (!['unchanged', 'change', 'decline'].includes(action)) fail(400, 'Choose an answer: the marks stand, they change, or the request is declined');
    const response = String(body.response || '').trim().slice(0, 500);
    if (action !== 'unchanged' && !response) fail(400, 'Say why — the family reads it');

    let after = null;
    if (action === 'change') {
        const out = await exams.correctPublishedMark(ctx, rc.exam, {
            student: rc.student, subject: rc.subject,
            marksObtained: body.marksObtained, isAbsent: body.isAbsent, parts: body.parts, grade: body.grade,
            reason: `Re-check: ${response}`,
        });
        after = { text: out.change.after };
    }
    const { rows: [row] } = await pool.query(
        `UPDATE "${ResultRecheck.tableName}" SET "status" = $2, "outcome" = $3, "response" = $4, "after" = $5::jsonb,
                "resolvedBy" = $6::uuid, "resolvedAt" = now(), "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "status" = 'open' RETURNING *`,
        [String(rc._id), action === 'decline' ? 'declined' : 'resolved', action === 'decline' ? '' : action === 'change' ? 'changed' : 'unchanged',
            response, after ? JSON.stringify(after) : null, String(ctx.userId)]);
    if (!row) fail(409, 'This request has already been answered');

    const [exam, sub] = await Promise.all([
        FormalExam.findById(rc.exam).select('title school').lean(),
        Subject.findById(rc.subject).select('subjectName').lean(),
    ]);
    familyOf(ctx.schoolId, [String(rc.student)]).then((recipients) => safeNotify({
        school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
        title: `🔍 Re-check answered: ${sub?.subjectName || 'a paper'}, ${exam?.title || ''}`,
        body: action === 'change' ? `The paper was checked again and the marks have been corrected (now ${after.text}). The scorecard shows the new result.${response ? `\n${response}` : ''}`
            : action === 'unchanged' ? `The paper was checked again and the marks stand as they were.${response ? `\n${response}` : ''}`
                : `The request was not taken up: ${response}`,
        recipients, link: { type: 'results.mine', entityId: rc.exam },
    })).catch(() => {});
    return row;
}

module.exports = { request, officeList, resolve };
