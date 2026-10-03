'use strict';
/**
 * Promotion on a final exam's results.
 *
 * A final exam may be set to promote the students who pass it. On the day its
 * results reach families — the result date, or the moment of publishing when
 * there is none or it has passed — every student who passed moves up: to the
 * class numbered one higher in the NEXT academic year (a class is a row per
 * year here, so Class 6 of 2026-27 goes up to Class 7 of 2027-28), either into
 * the section of the same name (6-A → 7-A) or into the class alone, to be given
 * a section later. Students who did not pass, or have no result, stay put —
 * unless the exam says those who did not pass repeat the class
 * (`failedPlacement: 'repeat'`): they go into the SAME class in the next year,
 * by the same section rule. A re-exam pass (resultExams.saveReExam) later moves
 * a repeating student up after all (afterReExam).
 *
 * Who passed is the published result's own verdict, grace included, so the move
 * can never disagree with the scorecard. Each move is recorded in
 * StudentPromotionHistory against the exam: that is what the scorecard shows
 * beside the result, and what is taken back if the results are withdrawn.
 *
 * Last year's section roll is left as it was — it is that year's record, and
 * the exam's own results are worked out from it. What changes is the student's
 * record (StudentProfile) and next year's roll, through the one helper every
 * other move goes through (utils/sectionMembership).
 *
 * A run first claims the exam in SQL, so the scheduler on two servers, or a
 * publish landing while the scheduler ticks, can never move a student twice —
 * and a run is idempotent anyway: a student this exam already moved is "done".
 */
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const FormalResult = require('../models/FormalResult');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const StudentProfile = require('../models/StudentProfile');
const StudentPromotionHistory = require('../models/StudentPromotionHistory');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const { setStudentSection, syncCounts } = require('../utils/sectionMembership');
const { notify } = require('./notifyService');
const designations = require('./designationService');
const settings = require('./resultSettings');
// Lazily: resultExams requires this module too.
const rules = () => require('./resultExams');

const T = (M) => `"${M.tableName}"`;
const idOf = (v) => String(v?._id ?? v ?? '');
const same = (a, b) => !!idOf(a) && idOf(a) === idOf(b);
const SECTION_MODES = ['same', 'none'];
const repeats = (exam) => promotes(exam) && exam?.failedPlacement === 'repeat';
const WAIT_RETRY_MS = 60 * 60 * 1000;   // waiting for next year's class: look again hourly
const RETRY_MS = 10 * 60 * 1000;        // a run that failed: try again soon

/** Whether this exam moves the students who pass it (final exams only). */
function promotes(exam) { return exam?.examType === 'FINAL' && exam?.promoteOnPass === true; }
const modeOf = (exam) => (SECTION_MODES.includes(exam?.promoteSection) ? exam.promoteSection : 'same');
const sectionKey = (name) => String(name || '').trim().toUpperCase();
const where = (className, sectionName) => [className, sectionName].filter(Boolean).join(' – ');

/* ── Where a class goes up to ─────────────────────────────────────────────── */

/**
 * The next class up for every class of a school, worked out once:
 *   Map(classId → { from, year, class, sections: Map(NAME → section), last })
 *
 *   year null             there is no academic year after this class's yet
 *   class null, last      this is the school's highest class — nothing above it
 *   class null, !last     next year's class has not been set up yet
 */
async function targetsByClass(schoolId) {
    const [years, classes, sections] = await Promise.all([
        AcademicYear.find({ school: schoolId }).select('yearName startDate status').lean(),
        Class.find({ school: schoolId, status: { $ne: 'archived' } }).select('className classNumber academicYear').lean(),
        ClassSection.find({ school: schoolId, status: { $ne: 'archived' } })
            .select('sectionName class maxStudents enrolledStudents rollNumbersAssignedAt academicYear').lean(),
    ]);
    years.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    const nextYear = new Map(years.map((y, i) => [idOf(y), years[i + 1] || null]));
    const classIn = new Map(classes.map((c) => [`${idOf(c.academicYear)}:${Number(c.classNumber)}`, c]));
    const sectionsOf = new Map();
    sections.forEach((s) => {
        const k = idOf(s.class);
        if (!sectionsOf.has(k)) sectionsOf.set(k, new Map());
        sectionsOf.get(k).set(sectionKey(s.sectionName), s);
    });

    const out = new Map();
    for (const from of classes) {
        const year = nextYear.get(idOf(from.academicYear)) || null;
        const up = Number(from.classNumber) + 1;
        // Nothing numbered higher this year or next: this is the last class.
        const last = !classes.some((c) => Number(c.classNumber) >= up
            && (same(c.academicYear, from.academicYear) || (year && same(c.academicYear, year))));
        const cls = year ? classIn.get(`${idOf(year)}:${up}`) || null : null;
        // The same class next year, for a student who repeats it.
        const again = year ? classIn.get(`${idOf(year)}:${Number(from.classNumber)}`) || null : null;
        out.set(idOf(from), {
            from, year, class: cls, sections: cls ? sectionsOf.get(idOf(cls)) || new Map() : new Map(), last,
            same: again, sameSections: again ? sectionsOf.get(idOf(again)) || new Map() : new Map(),
        });
    }
    return out;
}

/** The same, for one class — plus what the form and the drawer say about it. */
function describeTarget(t) {
    if (!t) return null;
    return {
        year: t.year ? { _id: idOf(t.year), yearName: t.year.yearName } : null,
        class: t.class ? { _id: idOf(t.class), className: t.class.className } : null,
        sections: [...t.sections.values()].map((s) => s.sectionName).sort(),
        last: !!t.last,
        // What is missing, said plainly; null when the class above is there.
        missing: t.class ? null : t.last ? 'last' : !t.year ? 'year' : 'class',
    };
}

/* ── Planning ─────────────────────────────────────────────────────────────── */

/**
 * What the promotion would do for each student of the exam, without doing it.
 *
 *   promote   passed, and has somewhere to go — also a student this exam
 *             placed to repeat, who has since passed a re-exam
 *   repeat    did not pass, and the exam places them in the same class next year
 *   done      this exam already moved them (`kind` says up, or to repeat)
 *   stay      did not pass
 *   noResult  no result in the exam (joined after it, or nothing entered)
 *   wait      passed, but next year's class is not there yet
 *   final     passed the school's highest class — there is nothing above it
 *   skip      no longer here to move: left the school, or moved on since
 */
async function plan(exam, targets = null) {
    const section = await ClassSection.findById(exam.section).select('class sectionName enrolledStudents').lean();
    const all = targets || await targetsByClass(exam.school);
    const target = section?.class ? all.get(idOf(section.class)) || null : null;
    const mode = modeOf(exam);
    const conf = await settings.get(exam.school);

    const results = await FormalResult.find({ exam: exam._id }).select('student isPassed').lean();
    const resultOf = new Map(results.map((r) => [idOf(r.student), r]));
    const roster = (section?.enrolledStudents || []).map(String).filter(isUuid);
    const ids = [...new Set([...roster, ...results.map((r) => idOf(r.student))])];
    if (!ids.length) return { target, items: [] };

    const [users, profiles, moved] = await Promise.all([
        User.find({ _id: { $in: ids } }).select('name role school isActive').lean(),
        StudentProfile.find({ user: { $in: ids } }).select('user currentClass currentSection rollNumber').lean(),
        StudentPromotionHistory.find({ exam: exam._id, revertedAt: null }).select('student newClass newSection kind').lean(),
    ]);
    const userOf = new Map(users.map((u) => [idOf(u), u]));
    const profileOf = new Map(profiles.map((p) => [idOf(p.user), p]));
    const movedOf = new Map(moved.map((m) => [idOf(m.student), m]));
    const nowClassIds = [...new Set(profiles.map((p) => idOf(p.currentClass)).filter(isUuid))];
    const nowClasses = nowClassIds.length ? await Class.find({ _id: { $in: nowClassIds } }).select('className classNumber').lean() : [];
    const classOf = new Map(nowClasses.map((c) => [idOf(c), c]));
    const overrideOf = new Map((Array.isArray(exam.promotionOverrides) ? exam.promotionOverrides : []).map((o) => [String(o.student), o]));

    const fromNumber = Number(target?.from?.classNumber);
    // A no-detention class promotes everybody, whatever the result.
    const noDetention = conf.noDetentionUpTo !== null && conf.noDetentionUpTo !== undefined && Number.isFinite(fromNumber) && fromNumber <= conf.noDetentionUpTo;
    const repeat = repeats(exam);
    const items = ids.map((id) => {
        const user = userOf.get(id);
        const r = resultOf.get(id);
        const p = profileOf.get(id);
        const base = { student: id, name: user?.name || 'Student', from: p?.currentSection || null, fromClass: p?.currentClass || null, rollNumber: p?.rollNumber || '' };
        // Roster ids that name no student account are nobody to report on.
        if (!user || user.role !== 'student') return r ? { ...base, outcome: 'skip', reason: 'No longer a student of the school' } : null;
        // What decides this student: the result's verdict, unless the office
        // decided otherwise for them, or the class detains nobody.
        const o = overrideOf.get(id);
        let up = !!r?.isPassed; let basis = up ? 'passed' : '';
        if (r && o?.decision === 'promote' && !up) { up = true; basis = 'condition'; }
        else if (r && o?.decision === 'detain' && up) { up = false; basis = 'detained'; }
        else if (r && !up && noDetention) { up = true; basis = 'noDetention'; }
        const prior = movedOf.get(id);
        // Placed to repeat, and moving up since (a re-exam, or a decision): up after all, from where they are.
        const upAfterAll = prior?.kind === 'repeated' && up;
        if (prior && !upAfterAll) return { ...base, outcome: 'done', kind: prior.kind || 'promoted', basis };
        if (!r) return { ...base, outcome: 'noResult', reason: 'No result in this exam' };
        if (!up && !repeat) return { ...base, outcome: 'stay', reason: basis === 'detained' ? `Kept back by the school${o?.reason ? ` — ${o.reason}` : ''}` : 'Did not pass', basis };
        if (!same(user.school, exam.school)) return { ...base, outcome: 'skip', reason: 'No longer a student of the school' };
        // An account switched off has left: there is nobody to move up.
        if (user.isActive === false) return { ...base, outcome: 'skip', reason: 'The student\'s account is switched off' };
        if (!target) return { ...base, outcome: 'skip', reason: 'The exam\'s section no longer belongs to a class' };

        // Moved on since the exam — by hand, or by another promotion.
        const now = p?.currentClass ? classOf.get(idOf(p.currentClass)) : null;
        if (now && Number(now.classNumber) !== fromNumber && !(upAfterAll && prior)) {
            return { ...base, outcome: 'skip', reason: `Now in ${now.className}` };
        }
        // Did not pass (or kept back), and repeats: the same class in the next year.
        if (!up) {
            if (!target.same) {
                return { ...base, outcome: 'wait', reason: target.year ? `${target.from.className} has not been set up in ${target.year.yearName} yet` : 'There is no academic year after this one yet' };
            }
            let again = null; let note = basis === 'detained' ? `Kept back by the school${o?.reason ? ` — ${o.reason}` : ''}` : '';
            if (mode === 'same') {
                const want = sectionKey(section.sectionName);
                again = target.sameSections.get(want) || null;
                if (!again) note = [note, `${target.same.className} has no section ${want} — placed without a section`].filter(Boolean).join(' · ');
            }
            return { ...base, outcome: 'repeat', toClass: target.same, toSection: again, note, basis: basis || 'failed' };
        }
        if (!target.class) {
            // The school's highest class: nothing to move up to — they have passed out.
            if (target.last) return { ...base, outcome: 'final', reason: `${target.from.className} is the highest class — passed out`, basis };
            const next = `Class ${fromNumber + 1}`;
            return { ...base, outcome: 'wait', reason: target.year ? `${next} has not been set up in ${target.year.yearName} yet` : `There is no academic year after this one yet` };
        }

        let toSection = null; let note = basis === 'condition' ? `Promoted on condition${o?.reason ? ` — ${o.reason}` : ''}` : basis === 'noDetention' ? 'Promoted — the class detains nobody' : '';
        if (mode === 'same') {
            const want = sectionKey(section.sectionName);
            toSection = target.sections.get(want) || null;
            if (!toSection) note = [note, `${target.class.className} has no section ${want} — placed without a section`].filter(Boolean).join(' · ');
        }
        return { ...base, outcome: 'promote', toClass: target.class, toSection, note, supersedes: upAfterAll ? prior._id : null, basis: upAfterAll && basis === 'passed' ? 'reExam' : basis };
    }).filter(Boolean);
    return { target, items };
}

/* ── Moving them ──────────────────────────────────────────────────────────── */

/**
 * Move every student the plan says to promote. Seats are spent in roll order
 * as students are placed, so a section that fills up takes the first and the
 * rest go into the class without a section — said, not silently over-filled.
 * Into a section that has been numbered, a student keeps their roll number if
 * nobody there holds it, and otherwise continues the sequence.
 */
async function apply(exam, items, actor, target = null) {
    const touched = new Set();
    const seats = new Map();
    const rolls = new Map();
    const now = new Date();
    const moved = [];
    const promote = items.filter((x) => x.outcome === 'promote' || x.outcome === 'repeat')
        .sort((a, b) => (Number(a.rollNumber) || 1e9) - (Number(b.rollNumber) || 1e9) || a.name.localeCompare(b.name));

    for (const it of promote) {
        let section = it.toSection;
        let note = it.note;
        if (section) {
            const sid = idOf(section);
            const roll = (section.enrolledStudents || []).map(String);
            if (!seats.has(sid)) {
                const capacity = Number(section.maxStudents) || 0;
                seats.set(sid, capacity ? capacity - roll.length : Infinity);
            }
            if (!roll.includes(it.student)) {
                if (seats.get(sid) <= 0) {
                    note = `${where(it.toClass.className, section.sectionName)} is full — placed without a section`;
                    section = null;
                } else seats.set(sid, seats.get(sid) - 1);
            }
        }

        let extra = null;
        if (section?.rollNumbersAssignedAt) {
            const sid = idOf(section);
            if (!rolls.has(sid)) {
                const peers = (section.enrolledStudents || []).map(String);
                const held = peers.length ? await StudentProfile.find({ user: { $in: peers } }).select('rollNumber').lean() : [];
                const used = new Set(held.map((h) => String(h.rollNumber || '').trim()).filter(Boolean));
                rolls.set(sid, { used, next: Math.max(0, ...[...used].map(Number).filter(Number.isFinite)) });
            }
            const st = rolls.get(sid);
            const mine = String(it.rollNumber || '').trim();
            if (mine && !st.used.has(mine)) {
                st.used.add(mine);
            } else {
                st.next += 1;
                extra = { rollNumber: String(st.next) };
                st.used.add(String(st.next));
            }
        }

        const { removedFrom } = await setStudentSection({
            studentId: it.student, sectionId: section ? idOf(section) : null, schoolId: exam.school,
            classId: idOf(it.toClass), academicYear: idOf(it.toClass.academicYear), extra, deferCounts: true,
        });
        removedFrom.forEach((s) => touched.add(String(s)));
        if (section) touched.add(idOf(section));

        const repeating = it.outcome === 'repeat';
        const why = repeating ? (it.basis === 'detained' ? `Kept back after ${exam.title} — repeats ${it.toClass.className}` : `Did not pass ${exam.title} — repeats ${it.toClass.className}`)
            : it.basis === 'condition' ? `Promoted on condition after ${exam.title}`
                : it.basis === 'noDetention' ? `Promoted after ${exam.title} — the class detains nobody`
                    : `Passed ${exam.title}${it.supersedes ? ' (after a re-exam)' : ''}`;
        await StudentPromotionHistory.create({
            student: it.student, school: exam.school, exam: exam._id, source: 'result', kind: repeating ? 'repeated' : 'promoted',
            basis: it.basis || (repeating ? 'failed' : 'passed'), supersedes: it.supersedes || null,
            oldClass: it.fromClass || null, oldSection: it.from || null,
            newClass: idOf(it.toClass), newSection: section ? idOf(section) : null,
            promotionDate: now, promotedBy: actor, academicYear: idOf(it.toClass.academicYear),
            remarks: [why, note].filter(Boolean).join(' · '),
        });
        // A repeat that a re-exam pass has overtaken is no longer where they are.
        if (it.supersedes) {
            await StudentPromotionHistory.updateOne({ _id: it.supersedes }, { $set: { revertedAt: now, revertedBy: actor || null } });
        }
        it.outcome = repeating ? 'repeated' : 'promoted';
        it.toSection = section;
        it.note = note;
        moved.push(it);
    }
    if (touched.size) await syncCounts([...touched]);

    // Passed the school's highest class: nothing to move them to, but the
    // record says they passed out — on the scorecard, the report card and the
    // office's list — once.
    for (const it of items.filter((x) => x.outcome === 'final')) {
        const fromClassId = idOf(it.fromClass) || idOf(target?.from);
        if (!isUuid(fromClassId)) continue;
        await StudentPromotionHistory.create({
            student: it.student, school: exam.school, exam: exam._id, source: 'result', kind: 'passedOut', basis: it.basis || 'passed',
            oldClass: fromClassId, oldSection: it.from || null, newClass: fromClassId, newSection: null,
            promotionDate: now, promotedBy: actor, academicYear: idOf(exam.academicYear),
            remarks: `Passed ${exam.title} — passed out of the school's highest class`,
        });
        it.outcome = 'passedOut';
        moved.push(it);
    }
    return moved;
}

const COUNTS = ['promoted', 'repeated', 'passedOut', 'stay', 'noResult', 'wait', 'final', 'skip'];

/** Counts, the target, and every student not moved (and why) — what the drawer shows. */
function statsOf(exam, target, items, earlier) {
    const n = Object.fromEntries(COUNTS.map((k) => [k, 0]));
    // 'promote' / 'repeat' are a preview's "will move"; 'done' moved on an earlier run.
    const again = (it) => it.outcome === 'repeated' || it.outcome === 'repeat' || (it.outcome === 'done' && it.kind === 'repeated');
    const up = (it) => !again(it) && (it.outcome === 'promoted' || it.outcome === 'promote' || (it.outcome === 'done' && it.kind !== 'passedOut'));
    items.forEach((it) => {
        const k = again(it) ? 'repeated' : up(it) ? 'promoted' : (it.outcome === 'done' && it.kind === 'passedOut') ? 'passedOut' : it.outcome;
        if (k in n) n[k] += 1;
    });
    const decided = (b) => items.filter((it) => it.basis === b && it.outcome !== 'noResult').length;
    return {
        ...n,
        // Moved (or kept) other than by the result: the office's decisions, and a class that detains nobody.
        onCondition: decided('condition'), detained: decided('detained'), noDetention: decided('noDetention'),
        withoutSection: items.filter((it) => (up(it) || again(it)) && !it.toSection && modeOf(exam) === 'same' && it.note).length,
        mode: modeOf(exam),
        placement: repeats(exam) ? 'repeat' : 'stay',
        target: describeTarget(target),
        // Where the ones who repeat go: the same class, next year.
        repeatTarget: target?.same ? { class: { _id: idOf(target.same), className: target.same.className }, year: target.year ? { _id: idOf(target.year), yearName: target.year.yearName } : null } : null,
        exceptions: items
            .filter((it) => !(up(it) || again(it)) || it.note)
            .map((it) => ({ student: it.student, name: it.name, outcome: it.outcome, reason: it.note || it.reason || '' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        earlier: earlier || 0,
    };
}

async function setPromotion(examId, set) {
    const cols = Object.keys(set);
    const vals = cols.map((c) => (c === 'promotionStats' && set[c] !== null ? JSON.stringify(set[c]) : set[c]));
    await pool.query(
        `UPDATE ${T(FormalExam)} SET ${cols.map((c, i) => `"${c}" = $${i + 2}${c === 'promotionStats' ? '::jsonb' : ''}`).join(', ')}, "updatedAt" = now()
          WHERE "_id" = $1::uuid`,
        [String(examId), ...vals]);
}

/** A notice never makes a step fail. */
function safeNotify(opts) {
    try { notify(opts); } catch (e) { console.error('[promotion] notice failed:', e.message); }
}

/**
 * Tell the promoted students and their parents, one notice per class and
 * section they went to.
 */
async function announceMoves(exam, moved, actor) {
    if (exam.notifyOnPublish === false || !moved.length) return;
    const groups = new Map();
    moved.forEach((it) => {
        const k = `${it.outcome}:${idOf(it.toClass)}:${idOf(it.toSection)}`;
        if (!groups.has(k)) groups.set(k, { cls: it.toClass, section: it.toSection, again: it.outcome === 'repeated', students: [] });
        groups.get(k).students.push(it.student);
    });
    const yearName = moved[0].toClass?.yearName || '';
    for (const g of groups.values()) {
        const to = g.section ? where(g.cls.className, g.section.sectionName) : g.cls.className;
        safeNotify({
            school: exam.school, sender: actor, senderRole: 'school_admin',
            title: g.again ? `📘 Class for ${yearName || 'next year'}: ${to}` : `🎓 Promoted to ${to}`,
            body: g.again
                ? `Following the results of "${exam.title}", you will continue in ${to}${yearName ? ` in ${yearName}` : ''}.${g.section ? '' : ' Your section will be given by the school.'}`
                : `Following "${exam.title}", you have been promoted to ${to}${yearName ? ` for ${yearName}` : ''}.${g.section ? '' : ' Your section will be given by the school.'}`,
            recipients: await rules().familyOf(exam.school, g.students).catch(() => g.students),
            link: { type: 'results.mine', entityId: exam._id },
        });
    }
}

/* ── Running ──────────────────────────────────────────────────────────────── */

/**
 * Run an exam's promotion if it is due, and nobody else is running it.
 * Returns the stats, or null when there was nothing to claim.
 *   system   the scheduler is running it: the office is told what happened,
 *            since nobody was watching
 */
async function run(examId, { actor = null, system = false } = {}) {
    const { rows } = await pool.query(
        `UPDATE ${T(FormalExam)} SET "promotionState" = 'running', "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "status" = 'FINAL_APPROVED' AND "examType" = 'FINAL' AND "promoteOnPass" IS TRUE
            AND "promotionDueAt" <= now()
            AND ("promotionState" IN ('scheduled', 'waiting')
                 OR ("promotionState" = 'running' AND "updatedAt" < now() - interval '30 minutes'))
          RETURNING "_id"`, [String(examId)]);
    if (!rows.length) return null;

    const exam = await FormalExam.findById(examId).lean();
    const by = actor || exam.finalApprovedBy || exam.createdBy;
    try {
        const { target, items } = await plan(exam);
        const yearName = target?.year?.yearName || '';
        items.forEach((it) => { if (it.toClass) it.toClass = { ...it.toClass, yearName }; });
        const moved = await apply(exam, items, by, target);
        const stats = statsOf(exam, target, items);
        const waiting = stats.wait > 0;
        await setPromotion(exam._id, {
            promotionState: waiting ? 'waiting' : 'done',
            promotionDueAt: waiting ? new Date(Date.now() + WAIT_RETRY_MS) : null,
            promotedAt: moved.length || !exam.promotedAt ? new Date() : exam.promotedAt,
            promotionStats: stats,
        });
        announceMoves(exam, moved, by).catch(() => {});
        if (system && (moved.length || !exam.promotedAt)) tellOffice(exam, stats, by);
        return { ...stats, state: waiting ? 'waiting' : 'done', movedNow: moved.length };
    } catch (e) {
        // Put it back so the next tick tries again; the moves already made are
        // recorded, and a rerun counts those students as done.
        await setPromotion(exam._id, { promotionState: 'scheduled', promotionDueAt: new Date(Date.now() + RETRY_MS) }).catch(() => {});
        throw e;
    }
}

/** What happened, for the office — a scheduled run had nobody watching it. */
function tellOffice(exam, s, by) {
    // Whoever runs Results — admins and any teacher whose designation administers it.
    designations.moduleAdminIds(exam.school, 'result').then((admins) => {
        const parts = [`${s.promoted} promoted${s.target?.class ? ` to ${s.target.class.className}` : ''}`];
        if (s.repeated) parts.push(`${s.repeated} repeat${s.repeated === 1 ? 's' : ''} ${s.repeatTarget?.class?.className || 'the class'}`);
        if (s.stay) parts.push(`${s.stay} did not pass`);
        if (s.wait) parts.push(`${s.wait} waiting for ${s.target?.year ? `the class in ${s.target.year.yearName}` : 'next year'} to be set up`);
        if (s.skip) parts.push(`${s.skip} not moved (see the exam)`);
        safeNotify({
            school: exam.school, sender: by, senderRole: 'school_admin', includeSender: true,
            title: `🎓 Promotion: ${exam.title}`,
            body: `${parts.join(', ')}.`,
            recipients: admins, link: { type: 'results.exam', entityId: exam._id },
        });
    }).catch(() => {});
}

/**
 * Called as an exam is published. A final exam set to promote is scheduled for
 * the day its results reach families, and run at once when that day has come.
 */
async function schedule(exam, { actor } = {}) {
    if (!promotes(exam) || exam.status !== 'FINAL_APPROVED') {
        if (exam.promotionState === 'scheduled' || exam.promotionState === 'waiting') {
            await setPromotion(exam._id, { promotionState: null, promotionDueAt: null });
        }
        return null;
    }
    if (exam.promotionState === 'done') return { state: 'done' };
    // The day the results reach families begins at the school's midnight
    // (resultExams.releaseAt) — not at UTC midnight, which is 5:30 in the morning.
    const at = rules().releaseAt(exam);
    const now = new Date();
    const due = at && at > now ? at : now;
    await setPromotion(exam._id, { promotionState: 'scheduled', promotionDueAt: due });
    if (due <= now) return run(exam._id, { actor });
    return { state: 'scheduled', dueAt: due };
}

/**
 * The results are being withdrawn: a promotion not yet run is called off, and
 * one that has run is taken back — every student this exam moved returns to
 * the class and section they came from, unless they have been moved again
 * since, in which case they are left where somebody deliberately put them.
 */
async function undo(exam, { actor, reason = '' } = {}) {
    const moves = await StudentPromotionHistory.find({ exam: exam._id, revertedAt: null }).lean();
    if (!moves.length) {
        if (exam.promotionState) await setPromotion(exam._id, { promotionState: null, promotionDueAt: null });
        return { back: 0, kept: 0 };
    }
    const profiles = await StudentProfile.find({ user: { $in: moves.map((m) => m.student) } }).select('user currentClass currentSection').lean();
    const profileOf = new Map(profiles.map((p) => [idOf(p.user), p]));
    // Where each student was before this exam moved them at all: the first of
    // its moves. A student placed to repeat and moved up after a re-exam has
    // two, and goes back past both.
    const every = await StudentPromotionHistory.find({ exam: exam._id, student: { $in: moves.map((m) => m.student) } })
        .select('student oldClass oldSection academicYear promotionDate').lean();
    every.sort((a, b) => new Date(a.promotionDate) - new Date(b.promotionDate));
    const firstOf = new Map();
    every.forEach((r) => { if (!firstOf.has(idOf(r.student))) firstOf.set(idOf(r.student), r); });
    const touched = new Set();
    let back = 0; let kept = 0;
    const at = new Date();
    for (const m of moves) {
        const p = profileOf.get(idOf(m.student));
        const still = p && same(p.currentClass, m.newClass)
            && (same(p.currentSection, m.newSection) || (!idOf(p.currentSection) && !idOf(m.newSection)));
        if (!still) { kept += 1; continue; }
        const origin = firstOf.get(idOf(m.student)) || m;
        const { removedFrom } = await setStudentSection({
            studentId: m.student, sectionId: origin.oldSection ? idOf(origin.oldSection) : null, schoolId: exam.school,
            classId: origin.oldClass ? idOf(origin.oldClass) : null, academicYear: idOf(origin.academicYear), deferCounts: true,
        });
        removedFrom.forEach((s) => touched.add(String(s)));
        if (origin.oldSection) touched.add(idOf(origin.oldSection));
        await StudentPromotionHistory.updateOne({ _id: m._id }, { $set: { revertedAt: at, revertedBy: actor || null } });
        back += 1;
    }
    if (touched.size) await syncCounts([...touched]);
    const before = exam.promotionStats || {};
    await setPromotion(exam._id, {
        promotionState: 'reverted', promotionDueAt: null,
        promotionStats: { ...before, reverted: back, keptMoved: kept, revertedAt: at, revertReason: String(reason || '').slice(0, 300) },
    });
    return { back, kept };
}

/**
 * Take back one move this exam made (a promotion a corrected re-exam mark, or
 * the office keeping the student back, no longer supports): the student goes
 * back to where that move found them, and the move it had taken the place of
 * — a repeat a re-exam pass overtook — stands again.
 */
async function takeBack(exam, row, actor, touched) {
    const at = new Date();
    if (row.kind !== 'passedOut') {
        const p = await StudentProfile.findOne({ user: row.student }).select('currentClass currentSection').lean();
        const still = p && same(p.currentClass, row.newClass)
            && (same(p.currentSection, row.newSection) || (!idOf(p.currentSection) && !idOf(row.newSection)));
        if (!still) return false;   // moved again since, by somebody — left where they were put
        const { removedFrom } = await setStudentSection({
            studentId: row.student, sectionId: row.oldSection ? idOf(row.oldSection) : null, schoolId: exam.school,
            classId: row.oldClass ? idOf(row.oldClass) : null, academicYear: idOf(row.academicYear), deferCounts: true,
        });
        removedFrom.forEach((x) => touched.add(String(x)));
        if (row.oldSection) touched.add(idOf(row.oldSection));
    }
    await StudentPromotionHistory.updateOne({ _id: row._id }, { $set: { revertedAt: at, revertedBy: actor || null } });
    if (row.supersedes) await StudentPromotionHistory.updateOne({ _id: row.supersedes }, { $set: { revertedAt: null, revertedBy: null } });
    return true;
}

/**
 * These students' verdicts have changed since the promotion ran — a re-exam
 * passed or a re-exam mark taken back, a published mark corrected, or the
 * office deciding for one of them. Each is put where the exam now says: moved
 * up, taken back, or placed to repeat. A promotion not yet run needs nothing:
 * it will see the new verdicts when it runs. Claimed like a run, so it never
 * overlaps one.
 */
async function reconsider(examId, studentIds, actor) {
    const ids = new Set((studentIds || []).map(String));
    if (!ids.size) return null;
    const { rows: [was] } = await pool.query(`SELECT "promotionState" FROM ${T(FormalExam)} WHERE "_id" = $1::uuid`, [String(examId)]);
    if (!['done', 'waiting'].includes(was?.promotionState)) return null;
    const { rows } = await pool.query(
        `UPDATE ${T(FormalExam)} SET "promotionState" = 'running', "updatedAt" = now()
          WHERE "_id" = $1::uuid AND "status" = 'FINAL_APPROVED' AND "examType" = 'FINAL' AND "promoteOnPass" IS TRUE
            AND "promotionState" = $2 RETURNING "_id"`, [String(examId), was.promotionState]);
    if (!rows.length) return null;
    const exam = await FormalExam.findById(examId).lean();
    const by = actor || exam.finalApprovedBy || exam.createdBy;
    try {
        // First take back what no longer holds: a move up for a student who is
        // now kept back, or a repeat for one who now goes up is handled by the
        // plan (it supersedes the repeat).
        const first = await plan(exam);
        const verdict = new Map(first.items.map((it) => [it.student, it]));
        const active = await StudentPromotionHistory.find({ exam: exam._id, revertedAt: null, student: { $in: [...ids] } }).lean();
        const touched = new Set();
        let back = 0;
        for (const row of active) {
            const it = verdict.get(String(row.student));
            const shouldBeUp = it && (it.basis === 'passed' || it.basis === 'reExam' || it.basis === 'condition' || it.basis === 'noDetention');
            const isUp = row.kind === 'promoted' || row.kind === 'passedOut';
            if (isUp && !shouldBeUp) { if (await takeBack(exam, row, by, touched)) back += 1; }
        }
        if (touched.size) await syncCounts([...touched]);

        // Then place them as the exam now says.
        const { target, items } = await plan(exam);
        const yearName = target?.year?.yearName || '';
        items.forEach((it) => { if (it.toClass) it.toClass = { ...it.toClass, yearName }; });
        const mine = items.filter((it) => ids.has(it.student) && ['promote', 'repeat', 'final'].includes(it.outcome));
        const moved = await apply(exam, mine, by, target);
        const stats = statsOf(exam, target, items);
        await setPromotion(exam._id, { promotionState: was.promotionState, promotionStats: stats, ...(moved.length || back ? { promotedAt: new Date() } : null) });
        announceMoves(exam, moved, by).catch(() => {});
        return { movedNow: moved.length, takenBack: back, ...stats };
    } catch (e) {
        await setPromotion(exam._id, { promotionState: was.promotionState }).catch(() => {});
        throw e;
    }
}

/**
 * After a re-exam (or a published mark corrected): who passes now may move
 * up, where the final has already moved the others — and who no longer passes
 * goes back to where the exam left them.
 *   changed — { passed: [ids], failed: [ids] }, or (older callers) a list of the newly passing
 */
async function afterReExam(examId, changed, actor) {
    const list = Array.isArray(changed) ? changed : [...(changed?.passed || []), ...(changed?.failed || [])];
    return reconsider(examId, list, actor);
}

/** The scheduler's tick: run every promotion whose day has come. */
async function sweepDue() {
    const { rows } = await pool.query(
        `SELECT "_id" FROM ${T(FormalExam)}
          WHERE "status" = 'FINAL_APPROVED' AND "examType" = 'FINAL' AND "promoteOnPass" IS TRUE
            AND "promotionDueAt" <= now()
            AND ("promotionState" IN ('scheduled', 'waiting')
                 OR ("promotionState" = 'running' AND "updatedAt" < now() - interval '30 minutes'))
          ORDER BY "promotionDueAt" LIMIT 50`);
    let moved = 0;
    for (const r of rows) {
        try {
            const out = await run(r._id, { system: true });
            moved += out?.movedNow || 0;
        } catch (e) {
            console.error(`[Results] promotion of exam ${r._id} failed:`, e.message);
        }
    }
    return { exams: rows.length, moved };
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/**
 * The promotion as the exam drawer shows it. Before it has run (published and
 * waiting for its day, or not yet published) the plan is worked out live, so
 * the office sees who WILL move before anybody does.
 */
async function summary(exam) {
    if (exam?.examType !== 'FINAL') return null;
    const on = exam.promoteOnPass === true;
    const targets = await targetsByClass(exam.school);
    const section = await ClassSection.findById(exam.section).select('class sectionName').lean();
    const target = section?.class ? targets.get(idOf(section.class)) : null;
    const out = {
        enabled: on, mode: modeOf(exam), placement: repeats(exam) ? 'repeat' : 'stay', state: exam.promotionState || null,
        dueAt: exam.promotionDueAt || null, ranAt: exam.promotedAt || null,
        target: describeTarget(target),
        sameSection: section ? sectionKey(section.sectionName) : '',
        stats: exam.promotionStats || null,
        preview: null,
    };
    if (on && exam.status === 'FINAL_APPROVED' && (!exam.promotionState || exam.promotionState === 'scheduled')) {
        const { items } = await plan(exam, targets);
        out.preview = statsOf(exam, target, items);
    }
    return out;
}

/**
 * Every move a result made for these students, newest first, with names —
 * what a scorecard says under a final exam ("Promoted to Class 7 – A").
 */
async function movesFor(studentIds) {
    const ids = [...new Set((studentIds || []).map(String).filter(isUuid))];
    if (!ids.length) return [];
    const { rows } = await pool.query(
        `SELECT h."student", h."exam", h."promotionDate", h."remarks", h."kind",
                nc."className" AS "toClass", ns."sectionName" AS "toSection", y."yearName" AS "toYear",
                oc."className" AS "fromClass", os."sectionName" AS "fromSection"
           FROM ${T(StudentPromotionHistory)} h
           LEFT JOIN ${T(Class)} nc ON nc."_id" = h."newClass"
           LEFT JOIN ${T(ClassSection)} ns ON ns."_id" = h."newSection"
           LEFT JOIN ${T(AcademicYear)} y ON y."_id" = h."academicYear"
           LEFT JOIN ${T(Class)} oc ON oc."_id" = h."oldClass"
           LEFT JOIN ${T(ClassSection)} os ON os."_id" = h."oldSection"
          WHERE h."student" = ANY($1::uuid[]) AND h."revertedAt" IS NULL AND h."source" = 'result'
          ORDER BY h."promotionDate" DESC`, [ids]);
    return rows.map((r) => ({
        student: idOf(r.student), exam: idOf(r.exam), at: r.promotionDate, kind: ['repeated', 'passedOut'].includes(r.kind) ? r.kind : 'promoted',
        to: { className: r.toClass || '', sectionName: r.toSection || '', yearName: r.toYear || '' },
        from: { className: r.fromClass || '', sectionName: r.fromSection || '' },
        note: r.remarks || '',
    }));
}

module.exports = {
    SECTION_MODES, promotes, repeats, modeOf, targetsByClass, describeTarget,
    plan, run, schedule, undo, sweepDue, summary, movesFor, afterReExam, reconsider,
};
