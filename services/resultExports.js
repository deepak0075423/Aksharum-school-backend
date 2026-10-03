'use strict';
/**
 * Two documents printed from one exam (Oct 2026):
 *
 *   marksRegister   the exam's marks register as an Excel workbook — every
 *                   student on the roll against every paper, as entered (and,
 *                   once published, with the totals, grades, results and ranks
 *                   the results carry). The format a board return or a staff
 *                   meeting asks for; the screens only ever offered a CSV of
 *                   published results.
 *   admitCards      an admit card per student, two to an A4 page: the school,
 *                   the student, and the papers they sit — an elective's only
 *                   to its takers — with the day and time of each.
 *
 * Both read the exam as the office's own screens do (services/resultBoard),
 * so a register never disagrees with the drawer it was printed from.
 */
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const ExamMarksSheet = require('../models/ExamMarksSheet');
const board = require('./resultBoard');
const { RuleError } = require('./resultExams');
const { schoolLogoPath } = require('../utils/schoolLogoFile');

const fail = (status, message) => { throw new RuleError(status, message); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const valid = (d) => { const x = d ? new Date(d) : null; return x && !Number.isNaN(x.getTime()) ? x : null; };
/** A stored day (UTC midnight of the day meant), by its own parts. */
const fmtDay = (d) => { const x = valid(d); return x ? `${String(x.getUTCDate()).padStart(2, '0')} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}` : ''; };
const dowOf = (d) => { const x = valid(d); return x ? DOW[x.getUTCDay()] : ''; };
const classLine = (r) => [r?.className, r?.sectionName].filter(Boolean).join(' – ');
const fileSafe = (s) => String(s || '').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim();
const answered = (e) => !!e && (e.isAbsent || (e.marksObtained !== null && e.marksObtained !== undefined) || !!String(e.grade || '').trim()
    || (e.parts && Object.values(e.parts).some((v) => v !== null && v !== undefined && v !== '')));

/* ── The marks register ───────────────────────────────────────────────────── */

/** → { filename, buffer } */
async function marksRegister(schoolId, examId) {
    const d = await board.detail(schoolId, examId);
    if (!d) fail(404, 'Exam not found');
    const published = d.status === 'FINAL_APPROVED';
    const [roll, takers, sheets, res] = await Promise.all([
        board.rosterRows(d.section._id),
        board.takersBySubject(d.section._id),
        ExamMarksSheet.find({ exam: d._id }).select('subject entries').lean(),
        published ? board.results(schoolId, examId) : null,
    ]);
    const entryOf = new Map();
    sheets.forEach((sh) => (sh.entries || []).forEach((e) => entryOf.set(`${sh.subject}:${e.student}`, e)));
    const resultOf = new Map((res?.data || []).map((r) => [String(r.student._id), r]));
    // The roll, then anyone with a result (or a mark) who has left it since.
    const people = roll.map((u) => ({ _id: String(u._id), name: u.name, rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '', off: false }));
    const known = new Set(people.map((x) => x._id));
    for (const r of res?.data || []) {
        if (!known.has(String(r.student._id))) { people.push({ _id: String(r.student._id), name: r.student.name, rollNumber: r.student.rollNumber, admissionNumber: r.student.admissionNumber, off: true }); known.add(String(r.student._id)); }
    }
    const subjects = d.subjects;

    // Columns: who, then each paper (its parts, or its grade, or its marks), then the totals.
    const head = ['Roll No', 'Admission No', 'Student'];
    for (const s of subjects) {
        const name = s.subject.subjectName;
        if (s.gradeOnly) head.push(`${name} (grade)`);
        else if (s.components) { s.components.forEach((c) => head.push(`${name}: ${c.label} /${c.maxMarks}`)); head.push(`${name} /${s.maxMarks}`); }
        else head.push(`${name} /${s.maxMarks}`);
    }
    if (published) head.push('Total', 'Out of', 'Percentage', 'Grade', 'Result', 'Rank', 'Class rank', 'Grace', 'Note');
    else head.push('Marks so far', 'Out of', 'Papers blank');

    const rows = people.map((p) => {
        const out = [p.rollNumber, p.admissionNumber, p.name];
        const r = resultOf.get(p._id);
        let sum = 0; let max = 0; let blank = 0;
        for (const s of subjects) {
            const sid = String(s.subject._id);
            const t = takers.get(sid);
            const na = t && !t.has(p._id) && !entryOf.has(`${sid}:${p._id}`);
            const e = entryOf.get(`${sid}:${p._id}`);
            const fromResult = r ? (r.subjects || []).find((x) => String(x.subject._id) === sid) : null;
            const width = s.components ? s.components.length + 1 : 1;
            if (na) { for (let i = 0; i < width; i += 1) out.push('n/a'); continue; }
            if (!answered(e) && !fromResult) { blank += 1; for (let i = 0; i < width; i += 1) out.push(''); continue; }
            const absent = fromResult ? fromResult.isAbsent : !!e?.isAbsent;
            if (s.gradeOnly) { out.push(absent ? 'AB' : (fromResult?.grade || e?.grade || '')); continue; }
            if (s.components) {
                s.components.forEach((c) => {
                    const v = fromResult?.components?.find((x) => x.key === c.key)?.marks ?? e?.parts?.[c.key];
                    out.push(absent ? 'AB' : v === null || v === undefined || v === '' ? '' : Number(v));
                });
            }
            const marks = fromResult ? fromResult.marksObtained : e?.marksObtained;
            out.push(absent ? 'AB' : marks === null || marks === undefined ? '' : Number(marks));
            if (!absent && marks !== null && marks !== undefined) sum += Number(marks);
            max += Number(s.maxMarks) || 0;
        }
        if (published) {
            if (!r) out.push('', '', '', '', 'No result', '', '', '', p.off ? 'No longer on the roll' : '');
            else {
                const grace = (r.subjects || []).reduce((t2, x) => t2 + (Number(x.graceMarks) || 0), 0);
                out.push(r.totalMarks, r.totalMaxMarks, r.percentage, r.grade, r.isPassed ? 'Pass' : 'Fail', r.rank,
                    r.classOutOf && r.classOutOf > people.length ? r.classRank : '', grace || '',
                    [r.withheld ? `Withheld — ${r.withheld.reason || ''}` : '', p.off ? 'No longer on the roll' : ''].filter(Boolean).join('; '));
            }
        } else out.push(Math.round(sum * 100) / 100, max, blank || '');
        return out;
    });

    const school = (await require('./reportCard').letterhead(schoolId)) || {};
    const title = [
        [school.name || ''],
        [`${d.title}${d.code ? ` (${d.code})` : ''} — Marks Register`],
        [[classLine(d), d.yearName, d.examTypeLabel, d.termLabel, `${fmtDay(d.startDate)} – ${fmtDay(d.endDate)}`].filter(Boolean).join(' · ')],
        [published ? `Results published ${fmtDay(d.publishedOn || d.finalApprovedAt)} · ${d.summary ? `${d.summary.passed} of ${d.summary.students} passed, average ${d.summary.avgPct}%` : ''}`
            : `${d.statusLabel} — marks as entered so far (${d.sheetsSubmitted} of ${d.subjectCount} subjects submitted)`],
        [],
    ];
    const ws = XLSX.utils.aoa_to_sheet([...title, head, ...rows]);
    ws['!merges'] = title.slice(0, 4).map((_, i) => ({ s: { r: i, c: 0 }, e: { r: i, c: Math.max(0, head.length - 1) } }));
    ws['!cols'] = head.map((h, i) => ({ wch: i === 2 ? 26 : i < 2 ? 12 : Math.min(22, Math.max(8, String(h).length + 2)) }));
    ws['!freeze'] = { xSplit: 3, ySplit: title.length + 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Register');
    return {
        filename: `${fileSafe(`${d.title} ${classLine(d)} marks register`)}.xlsx`,
        buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    };
}

/* ── Admit cards ──────────────────────────────────────────────────────────── */

/** The cards' content: the exam, the school, and each student with their papers. */
async function admitCardData(schoolId, examId, { studentIds = null } = {}) {
    const d = await board.detail(schoolId, examId);
    if (!d) fail(404, 'Exam not found');
    const [roll, takers, school, conf] = await Promise.all([
        board.rosterRows(d.section._id), board.takersBySubject(d.section._id),
        require('./reportCard').letterhead(schoolId), require('./resultSettings').get(schoolId),
    ]);
    const wanted = studentIds ? new Set(studentIds.map(String)) : null;
    const list = roll.filter((u) => !wanted || wanted.has(String(u._id)));
    if (!list.length) fail(404, wanted ? 'That student is not on this exam\'s roll' : 'This section has no students on its roll');
    const { rows: extra } = await require('../db/pool').query(
        `SELECT u."_id"::text AS "_id", u."profileImage", sp."dob"
           FROM "users" u LEFT JOIN LATERAL (SELECT "dob" FROM "studentprofiles" p WHERE p."user" = u."_id" ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1) sp ON true
          WHERE u."_id" = ANY($1::uuid[])`, [list.map((u) => String(u._id))]);
    const more = new Map(extra.map((x) => [x._id, x]));
    const papers = [...d.subjects].sort((a, b) => (valid(a.examDate)?.getTime() || 9e15) - (valid(b.examDate)?.getTime() || 9e15)
        || String(a.startTime || '').localeCompare(String(b.startTime || '')) || (a.order - b.order));
    return {
        school: school || {}, principalTitle: conf.report.principalTitle, principalSignature: conf.report.principalSignature,
        exam: { title: d.title, code: d.code, yearName: d.yearName, examTypeLabel: d.examTypeLabel, className: d.className, sectionName: d.sectionName, startDate: d.startDate, endDate: d.endDate, classTeacher: d.classTeacher },
        students: list.map((u) => ({
            _id: String(u._id), name: u.name, rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '',
            dob: more.get(String(u._id))?.dob || null, photo: more.get(String(u._id))?.profileImage || '',
            papers: papers.filter((s) => { const t = takers.get(String(s.subject._id)); return !t || t.has(String(u._id)); })
                .map((s) => ({ subjectName: s.subject.subjectName, examDate: s.examDate, startTime: s.startTime, endTime: s.endTime })),
        })),
    };
}

const C = { ink: '#14183A', muted: '#5A6284', faint: '#8A93AD', line: '#D9DEEA', band: '#F1F3FA', primary: '#4038D0' };
const PAGE_W = 595.28; const PAGE_H = 841.89; const M = 24;
const fit = (doc, text, width) => {
    let t = String(text ?? '');
    if (doc.widthOfString(t) <= width) return t;
    while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
    return `${t}…`;
};
const timeText = (a, b) => [a, b].filter(Boolean).join(' – ');

function drawCard(doc, data, st, y0, h) {
    const x0 = M; const w = PAGE_W - 2 * M;
    doc.roundedRect(x0, y0, w, h, 8).lineWidth(1).strokeColor(C.line).stroke();
    let y = y0 + 12;
    const logo = schoolLogoPath(data.school);
    if (logo) { try { doc.image(logo, x0 + 12, y, { fit: [42, 42] }); } catch { /* the name alone */ } }
    // The student's photo, or a box for one to be pasted on.
    const px = x0 + w - 12 - 62; const pyTop = y;
    const photo = st.photo ? schoolLogoPath(st.photo) : null;
    doc.rect(px, pyTop, 62, 74).lineWidth(0.8).strokeColor(C.line).stroke();
    if (photo) { try { doc.image(photo, px + 1, pyTop + 1, { fit: [60, 72], align: 'center', valign: 'center' }); } catch { /* left as a box */ } }
    else doc.font('Helvetica').fontSize(7).fillColor(C.faint).text('Photograph', px, pyTop + 32, { width: 62, align: 'center', lineBreak: false });

    const tx = x0 + 62; const tw = w - 62 - 86;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(fit(doc, String(data.school.name || '').toUpperCase(), tw), tx, y, { width: tw, align: 'center', lineBreak: false });
    y += 17;
    if (data.school.address) { doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(fit(doc, data.school.address, tw), tx, y, { width: tw, align: 'center', lineBreak: false }); y += 11; }
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.primary).text('ADMIT CARD', tx, y + 3, { width: tw, align: 'center', characterSpacing: 2, lineBreak: false });
    y += 18;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink)
        .text(fit(doc, `${data.exam.title}${data.exam.code ? ` (${data.exam.code})` : ''} · ${data.exam.yearName}`, tw), tx, y, { width: tw, align: 'center', lineBreak: false });
    y = Math.max(y + 16, pyTop + 80);

    // Who.
    const facts = [['Student', st.name], ['Roll No.', st.rollNumber || '—'], ['Class & Section', classLine(data.exam) || '—'],
        ['Admission No.', st.admissionNumber || '—'], ['Date of Birth', st.dob ? fmtDay(st.dob) : '—'], ['Exam dates', `${fmtDay(data.exam.startDate)} – ${fmtDay(data.exam.endDate)}`]];
    const colW = (w - 24) / 2;
    facts.forEach(([k, v], i) => {
        const cx = x0 + 12 + (i % 2) * colW; const cy = y + Math.floor(i / 2) * 14;
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(k, cx, cy, { width: 72, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(fit(doc, v, colW - 80), cx + 74, cy - 0.5, { width: colW - 80, lineBreak: false });
    });
    y += Math.ceil(facts.length / 2) * 14 + 6;

    // The papers.
    const sigH = 34; const instH = 22;
    const room = y0 + h - 12 - sigH - instH - y - 14;
    const rowsMax = Math.max(1, Math.floor(room / 13));
    const cols = [['Date', 92], ['Day', 36], ['Time', 92], ['Subject', w - 24 - 220]];
    doc.rect(x0 + 12, y, w - 24, 14).fill(C.band);
    let cx = x0 + 12;
    cols.forEach(([label, cw]) => { doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text(label, cx + 5, y + 4, { width: cw - 10, lineBreak: false }); cx += cw; });
    y += 14;
    const shown = st.papers.slice(0, rowsMax);
    shown.forEach((p, i) => {
        if (i % 2) doc.rect(x0 + 12, y, w - 24, 13).fill('#FAFBFE');
        cx = x0 + 12;
        const cells = [p.examDate ? fmtDay(p.examDate) : 'To be told', p.examDate ? dowOf(p.examDate) : '', timeText(p.startTime, p.endTime) || '—', p.subjectName];
        cells.forEach((v, j) => { doc.font(j === 3 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(C.ink).text(fit(doc, v, cols[j][1] - 10), cx + 5, y + 3, { width: cols[j][1] - 10, lineBreak: false }); cx += cols[j][1]; });
        y += 13;
    });
    if (st.papers.length > shown.length) {
        doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(`… and ${st.papers.length - shown.length} more — see the exam timetable.`, x0 + 12, y + 2, { lineBreak: false });
        y += 11;
    }
    if (!st.papers.length) { doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('No papers yet.', x0 + 17, y + 3, { lineBreak: false }); }

    // Instructions and signatures, at the foot of the card.
    const fy = y0 + h - 12 - sigH - instH;
    doc.font('Helvetica').fontSize(7).fillColor(C.muted)
        .text('Bring this card to every paper. Reach the hall 15 minutes before the paper starts. No card, no entry without the class teacher\'s note.', x0 + 12, fy, { width: w - 24 });
    const sy = y0 + h - 12 - 12;
    const sig = data.principalSignature ? schoolLogoPath(data.principalSignature) : null;
    if (sig) { try { doc.image(sig, x0 + w - 12 - 130 + 15, sy - 30, { fit: [100, 26] }); } catch { /* the line alone */ } }
    [[x0 + 12, 'Class Teacher'], [x0 + w / 2 - 65, 'Student'], [x0 + w - 12 - 130, data.principalTitle || 'Principal']].forEach(([sx, label]) => {
        doc.moveTo(sx, sy).lineTo(sx + 130, sy).lineWidth(0.7).strokeColor(C.ink).stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text(label, sx, sy + 3, { width: 130, align: 'center', lineBreak: false });
    });
}

/** Write the admit cards as a PDF — to a response (`res`), or into a Buffer when there is none. */
function renderAdmitCards(data, res = null, filename = 'admit-cards.pdf') {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
    const done = new Promise((resolve, reject) => {
        if (res) { doc.on('end', resolve); return; }
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
    if (res) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileSafe(filename)}"`);
        doc.pipe(res);
    }
    const h = (PAGE_H - 3 * M) / 2;
    data.students.forEach((st, i) => {
        if (i % 2 === 0) doc.addPage();
        const y0 = i % 2 === 0 ? M : M * 2 + h;
        drawCard(doc, data, st, y0, h);
        // A cutting line between the two cards of a page.
        if (i % 2 === 0) doc.moveTo(M, M + h + M / 2).lineTo(PAGE_W - M, M + h + M / 2).dash(3, { space: 3 }).lineWidth(0.5).strokeColor(C.faint).stroke().undash();
    });
    doc.end();
    return done;
}

module.exports = { marksRegister, admitCardData, renderAdmitCards };
