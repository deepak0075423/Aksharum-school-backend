'use strict';
const Subject             = require('../models/Subject');
const ClassSubject        = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Class               = require('../models/Class');
const ClassSection        = require('../models/ClassSection');
const AcademicYear        = require('../models/AcademicYear');
const TeacherProfile        = require('../models/TeacherProfile');
const User                  = require('../models/User');
const { syncSectionChatGroup } = require('../services/sectionChatService');
const { inactiveTeacherError } = require('../utils/activeTeacher');

/**
 * Adds department and designation to teachers already populated on a document.
 *
 * Both live on TeacherProfile, not on User, so `populate('teachers')` can never
 * reach them however many fields it is given — hence a second, bounded lookup.
 * Without it every teacher picker built on a Subject shows a name and an email,
 * which is exactly the pair that does not tell two Priya Sharmas apart.
 */
async function attachTeacherDetail(docs, key = 'teachers') {
    const rows = Array.isArray(docs) ? docs : [docs];
    const ids = [...new Set(rows.flatMap((d) =>
        (Array.isArray(d?.[key]) ? d[key] : [d?.[key]])
            .filter((t) => t && typeof t === 'object' && t._id)
            .map((t) => String(t._id))))];
    if (!ids.length) return docs;

    const profiles = await TeacherProfile.find({ user: { $in: ids } })
        .select('user designation department employeeId').lean();
    const byUser = new Map(profiles.map((p) => [String(p.user), p]));

    for (const d of rows) {
        const list = Array.isArray(d?.[key]) ? d[key] : (d?.[key] ? [d[key]] : []);
        for (const t of list) {
            if (!t || typeof t !== 'object' || !t._id) continue;
            const p = byUser.get(String(t._id));
            t.designation = p?.designation || '';
            t.department  = p?.department  || '';
            t.employeeId  = p?.employeeId  || '';
        }
    }
    return docs;
}

// `meta` rides alongside `data` in the envelope — useFetch on the client hands
// the whole envelope back as `meta`, so a caller can read counts without them
// having to be smuggled into the array.
const ok  = (res, d, s=200, meta=null) => res.status(s).json({ success: true, data: d, ...(meta || {}) });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

/**
 * One year's subjects.
 *
 * A Subject belongs to a single academic year, so this always filters by one.
 * `?academicYear=<id>` names it; without the parameter the school's ACTIVE year
 * is used, which is what every dropdown in the app wants — a timetable or an
 * exam is being built for the year the school is actually in.
 *
 * Passing the year explicitly also attaches a `usage` block per subject saying
 * where it is used that year, which is what lets the Subjects screen separate
 * "in use" from "not used yet". Dropdowns do not need that and do not pay for it.
 */
exports.getSubjects = async (req, res) => {
    try {
        const yearId = req.query.academicYear;
        const year = yearId
            ? await AcademicYear.findOne({ _id: yearId, school: req.schoolId }).lean()
            : await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (yearId && !year) return err(res, 'Academic year not found', 404);

        // No year at all (a school mid-setup) can only mean "everything", or the
        // subject screen would be empty with no way to explain itself.
        const filter = { school: req.schoolId, ...(year ? { academicYear: year._id } : {}) };
        const subjects = await attachTeacherDetail(
            await Subject.find(filter).populate('teachers', 'name email').lean(),
        );

        if (!yearId) return ok(res, subjects);

        const classes  = await Class.find({ school: req.schoolId, academicYear: year._id })
            .select('className classNumber').lean();
        const sections = classes.length
            ? await ClassSection.find({ class: { $in: classes.map((c) => c._id) } })
                .select('sectionName class').lean()
            : [];
        const [links, assignments] = await Promise.all([
            classes.length
                ? ClassSubject.find({ class: { $in: classes.map((c) => c._id) } }).select('class subject').lean()
                : [],
            sections.length
                ? SectionSubjectTeacher.find({ section: { $in: sections.map((x) => x._id) } })
                    .select('section subject teacher').lean()
                : [],
        ]);

        const classById   = new Map(classes.map((c) => [String(c._id), c]));
        const sectionById = new Map(sections.map((x) => [String(x._id), x]));

        // subjectId -> { class labels, section labels, teacher ids }
        const usage = new Map();
        const slot = (sid) => {
            const k = String(sid);
            if (!usage.has(k)) usage.set(k, { classes: new Set(), sections: new Set(), teachers: new Set() });
            return usage.get(k);
        };
        for (const l of links) {
            const c = classById.get(String(l.class));
            if (c) slot(l.subject).classes.add(c.className);
        }
        for (const a of assignments) {
            const sec = sectionById.get(String(a.section));
            if (!sec) continue;
            const c = classById.get(String(sec.class));
            const u = slot(a.subject);
            if (c) u.classes.add(c.className);
            u.sections.add(`${c?.className || 'Class'} – ${sec.sectionName}`);
            if (a.teacher) u.teachers.add(String(a.teacher));
        }

        const withUsage = subjects.map((s) => {
            const u = usage.get(String(s._id));
            return {
                ...s,
                usage: {
                    inUse:        !!u,
                    classes:      u ? [...u.classes].sort() : [],
                    sections:     u ? [...u.sections].sort() : [],
                    classCount:   u ? u.classes.size : 0,
                    sectionCount: u ? u.sections.size : 0,
                    teacherCount: u ? u.teachers.size : 0,
                },
            };
        });

        ok(res, withUsage, 200, {
            academicYear: { _id: String(year._id), yearName: year.yearName },
            inUse:    withUsage.filter((s) => s.usage.inUse).length,
            notInUse: withUsage.filter((s) => !s.usage.inUse).length,
        });
    } catch (e) { err(res, e); }
};
/**
 * One subject, with everywhere it is actually used.
 *
 * The list already says whether a subject is in use; this says *where*. A
 * subject reaches a section two ways — the class carries it (ClassSubject) and
 * a section has a teacher for it (SectionSubjectTeacher) — and the two do not
 * have to agree: a class can carry a subject nobody teaches yet, and a stray
 * teacher assignment can outlive the class link. Both are folded into one tree
 * of classes → sections → teachers, and each node says which of the two it
 * came from, because that difference is the work still to be done.
 */
exports.getSubject = async (req, res) => {
    try {
        const subject = await attachTeacherDetail(
            await Subject.findOne({ _id: req.params.id, school: req.schoolId })
                .populate('teachers', 'name email').lean(),
        );
        if (!subject) return err(res, 'Subject not found', 404);

        const year = subject.academicYear
            ? await AcademicYear.findOne({ _id: subject.academicYear, school: req.schoolId })
                .select('yearName status').lean()
            : null;

        const [links, assignments] = await Promise.all([
            ClassSubject.find({ subject: subject._id }).select('class').lean(),
            SectionSubjectTeacher.find({ subject: subject._id }).select('section teacher').lean(),
        ]);

        // The sections named by the teacher assignments, and the classes named
        // by either side. Loaded once each rather than per row.
        const sections = assignments.length
            ? await ClassSection.find({ _id: { $in: [...new Set(assignments.map((a) => String(a.section)))] } })
                .select('sectionName class currentCount status').lean()
            : [];
        const classIds = [...new Set([
            ...links.map((l) => String(l.class)),
            ...sections.map((x) => String(x.class)),
        ])];
        const classes = classIds.length
            ? await Class.find({ _id: { $in: classIds }, school: req.schoolId })
                .select('className classNumber').lean()
            : [];

        const teacherIds = [...new Set(assignments.map((a) => String(a.teacher)).filter(Boolean))];
        const teacherRows = teacherIds.length
            ? await User.find({ _id: { $in: teacherIds } }).select('name email').lean()
            : [];
        const teacherById = new Map(teacherRows.map((t) => [String(t._id), t]));

        // section id -> the teachers assigned to teach this subject there
        const bySection = new Map();
        for (const a of assignments) {
            const k = String(a.section);
            if (!bySection.has(k)) bySection.set(k, []);
            const t = teacherById.get(String(a.teacher));
            if (t) bySection.get(k).push({ _id: String(t._id), name: t.name, email: t.email });
        }

        const carried = new Set(links.map((l) => String(l.class)));
        const sectionsOfClass = new Map();
        for (const sec of sections) {
            const k = String(sec.class);
            if (!sectionsOfClass.has(k)) sectionsOfClass.set(k, []);
            sectionsOfClass.get(k).push({
                _id: String(sec._id),
                sectionName: sec.sectionName,
                studentCount: sec.currentCount || 0,
                status: sec.status || 'active',
                teachers: (bySection.get(String(sec._id)) || [])
                    .sort((a, b) => String(a.name).localeCompare(String(b.name))),
            });
        }

        const tree = classes.map((c) => ({
            _id: String(c._id),
            className: c.className,
            classNumber: c.classNumber,
            carried: carried.has(String(c._id)),   // the class list says it teaches this
            sections: (sectionsOfClass.get(String(c._id)) || [])
                .sort((a, b) => String(a.sectionName).localeCompare(String(b.sectionName), 'en', { numeric: true })),
        })).sort((a, b) => (a.classNumber ?? 999) - (b.classNumber ?? 999)
            || String(a.className).localeCompare(String(b.className), 'en', { numeric: true }));

        const sectionCount = sections.length;

        /*
         * Everyone the subject touches, in one list.
         *
         * There are two different populations and neither is a subset of the
         * other: `subject.teachers` is the catalogue pool — the shortlist a
         * section picks from — while SectionSubjectTeacher is who is actually
         * in front of a class. A teacher can be in the pool and teach nothing,
         * and a section can be handed to somebody who was never added to the
         * pool. Listing only the pool is what made a subject with five staffed
         * sections read as "nobody is listed against this subject yet", so the
         * two are merged and each person says which of the two they are.
         */
        const people = new Map();
        const person = (id) => {
            const k = String(id);
            if (!people.has(k)) people.set(k, { _id: k, name: '', email: '', inPool: false, sections: [] });
            return people.get(k);
        };
        for (const t of subject.teachers || []) {
            Object.assign(person(t._id), {
                name: t.name || '', email: t.email || '',
                designation: t.designation || '', department: t.department || '',
                employeeId: t.employeeId || '', inPool: true,
            });
        }
        for (const t of teacherRows) {
            const p = person(t._id);
            if (!p.name) { p.name = t.name || ''; p.email = t.email || ''; }
        }
        for (const c of tree) {
            for (const sec of c.sections) {
                for (const t of sec.teachers) person(t._id).sections.push(`${c.className} – ${sec.sectionName}`);
            }
        }
        // The assignment-only names arrived from User and carry no profile, so
        // they need the same second lookup the pool got.
        await attachTeacherDetail({ teachers: [...people.values()].filter((p) => !p.inPool) });

        const roster = [...people.values()].sort((a, b) =>
            b.sections.length - a.sections.length || String(a.name).localeCompare(String(b.name)));

        ok(res, {
            ...subject,
            academicYear: year
                ? { _id: String(year._id), yearName: year.yearName, status: year.status }
                : null,
            usage: {
                inUse:        !!(links.length || assignments.length),
                classCount:   tree.length,
                sectionCount,
                teacherCount: teacherIds.length,
                classes:      tree.map((c) => c.className).sort(),
                sections:     tree.flatMap((c) => c.sections.map((x) => `${c.className} – ${x.sectionName}`)),
            },
            classes: tree,
            people: roster,
        });
    } catch (e) { err(res, e); }
};
exports.createSubject = async (req, res) => {
    try {
        const { name, subjectName, code, subjectCode, type, description, teachers } = req.body;
        if (!(subjectName || name)?.trim()) return err(res, 'Subject name is required', 400);
        // A subject is created INTO a year — the one the screen is showing, or
        // the active one when the caller does not say.
        let yearId = req.body.academicYear;
        if (yearId) {
            const y = await AcademicYear.findOne({ _id: yearId, school: req.schoolId }).lean();
            if (!y) return err(res, 'Academic year not found', 404);
        } else {
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (!active) return err(res, 'No active academic year. Please set one first.', 400);
            yearId = active._id;
        }
        if (type && !['theory', 'practical', 'elective'].includes(type)) return err(res, 'Subject type must be theory, practical or elective', 400);
        // A deactivated teacher cannot be listed against a subject.
        const inactive = await inactiveTeacherError(teachers, req.schoolId);
        if (inactive) return err(res, inactive, 400);
        const s = await Subject.create({
            subjectName: subjectName || name,
            subjectCode: subjectCode || code || null,
            type:        type || 'theory',
            description: description || '',
            teachers:    Array.isArray(teachers) ? teachers : [],
            school:      req.schoolId,
            academicYear: yearId,
        });
        const populated = await s.populate('teachers', 'name email');
        ok(res, await attachTeacherDetail(populated.toObject?.() ?? populated), 201);
    } catch (e) { err(res, e, 400); }
};
exports.updateSubject = async (req, res) => {
    try {
        const { name, subjectName, code, subjectCode, type, description, teachers } = req.body;
        const update = {};
        if (subjectName || name)           update.subjectName = subjectName || name;
        if (subjectCode || code)           update.subjectCode = subjectCode || code;
        if (type)                          update.type        = type;
        if (description !== undefined)     update.description = description;
        if (Array.isArray(teachers))       update.teachers    = teachers;
        if (update.teachers) {
            const inactive = await inactiveTeacherError(update.teachers, req.schoolId);
            if (inactive) return err(res, inactive, 400);
        }
        const s = await Subject.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true })
            .populate('teachers', 'name email');
        if (!s) return err(res, 'Subject not found', 404);
        ok(res, await attachTeacherDetail(s.toObject?.() ?? s));
    } catch (e) { err(res, e, 400); }
};
exports.deleteSubject = async (req, res) => {
    try {
        const subject = await Subject.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!subject) return err(res, 'Subject not found', 404);

        // A subject is referenced by the classes that carry it (ClassSubject)
        // and by every section that has a teacher for it — and nothing in the
        // database cascades, so deleting one underneath them leaves rows
        // pointing at a subject that no longer exists. Refused, with what is in
        // the way, the same shape as the other academic deletes.
        const [links, assignments] = await Promise.all([
            ClassSubject.find({ subject: subject._id }).select('class').lean(),
            SectionSubjectTeacher.find({ subject: subject._id }).select('section teacher').lean(),
        ]);

        if (links.length || assignments.length) {
            const classIds = [...new Set(links.map((l) => String(l.class)))];
            const sections = assignments.length
                ? await ClassSection.find({ _id: { $in: assignments.map((a) => a.section) } })
                    .select('sectionName class').lean()
                : [];
            const classes = await Class.find({
                _id: { $in: [...new Set([...classIds, ...sections.map((x) => String(x.class))])] },
            }).select('className').lean();
            const names = [...new Set(classes.map((c) => c.className))].sort();
            const teachers = new Set(assignments.map((a) => String(a.teacher)).filter(Boolean));

            const parts = [
                names.length && `${names.length} class${names.length === 1 ? '' : 'es'}`,
                sections.length && `${sections.length} section${sections.length === 1 ? '' : 's'}`,
                teachers.size && `${teachers.size} teacher assignment${teachers.size === 1 ? '' : 's'}`,
            ].filter(Boolean);

            return res.status(400).json({
                success: false,
                code: 'SUBJECT_IN_USE',
                message: `Cannot delete "${subject.subjectName}" — it is still used by ${parts.join(', ')}. `
                    + 'Remove it from those classes and sections first.',
                subjectName: subject.subjectName,
                counts: {
                    classCount:   names.length,
                    sectionCount: sections.length,
                    teacherCount: teachers.size,
                },
                classes: names,
            });
        }

        await Subject.findByIdAndDelete(subject._id);
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.getClassSubjects = async (req, res) => {
    try {
        const subjects = await ClassSubject.find({ class: req.params.classId }).populate('subject').lean();
        ok(res, subjects);
    } catch (e) { err(res, e); }
};
exports.assignSubjectToClass = async (req, res) => {
    try {
        const cs = await ClassSubject.create({ class: req.params.classId, ...req.body });
        ok(res, cs, 201);
    } catch (e) { err(res, e, 400); }
};
exports.removeSubjectFromClass = async (req, res) => {
    try {
        await ClassSubject.deleteOne({ class: req.params.classId, subject: req.body.subjectId });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
/**
 * Make sure "this class teaches this subject" is on record.
 *
 * Two tables describe the same fact at different grains: ClassSubject says the
 * CLASS teaches a subject, SectionSubjectTeacher says who teaches it in a given
 * SECTION. Assigning a teacher to a section obviously implies the first, but
 * nothing ever wrote it — no screen on either platform posts to the class-level
 * endpoint — so ClassSubject sat empty while assignments piled up.
 *
 * That is not cosmetic. The parent portal reads a child's subject list from
 * ClassSubject alone (parent.controller), the timetable generator folds it in
 * alongside the section rows, and the year-structure import copies it. All three
 * were reading a table nothing filled.
 *
 * So the link is written here, as a consequence of the assignment. Idempotent:
 * the pair is unique, and an existing link is left alone.
 */
async function ensureClassSubject(sectionId, subjectId) {
    if (!sectionId || !subjectId) return;
    const section = await ClassSection.findById(sectionId).select('class').lean();
    if (!section?.class) return;
    const exists = await ClassSubject.findOne({ class: section.class, subject: subjectId }).lean();
    if (!exists) await ClassSubject.create({ class: section.class, subject: subjectId });
}

exports.getSectionSubjectTeachers = async (req, res) => {
    try {
        const sst = await attachTeacherDetail(
            await SectionSubjectTeacher.find({ section: req.params.sectionId })
                .populate('subject teacher').lean(),
            'teacher',
        );
        ok(res, sst);
    } catch (e) { err(res, e); }
};
exports.assignSubjectTeacher = async (req, res) => {
    try {
        // The picker leaves deactivated teachers out; this is what a stale tab
        // or a direct call hits.
        const inactive = await inactiveTeacherError(req.body.teacher, req.schoolId);
        if (inactive) return err(res, inactive, 400);
        const sst = await SectionSubjectTeacher.create({ section: req.params.sectionId, ...req.body });
        // The class teaches this subject — record that too, or the parent portal
        // and the year import never learn about it. See ensureClassSubject.
        await ensureClassSubject(req.params.sectionId, req.body.subject);
        // Subject teachers belong to the section's teacher group chat
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        ok(res, sst, 201);
    } catch (e) { err(res, e, 400); }
};
// ─────────────────────────────────────────────────────────────────────────────
//  One subject + teacher onto SEVERAL sections of the same class.
//
//  Hindi in Class 5 is almost never Hindi in section A alone — it is A, B, C and
//  D, and doing that a section at a time is the same four-field form four times.
//  This takes the sections as a list and writes them in one action.
//
//  Additive like the rest of the setup tooling: a section that already has this
//  exact subject-and-teacher pairing is reported as already done rather than
//  failing the call, so a partly-finished class can be topped up by re-running
//  with every section ticked.
//
//  Sections must all belong to `classId` — the screen only offers siblings, and
//  the server holds that line so a hand-made call cannot fan a subject out
//  across unrelated classes.
// ─────────────────────────────────────────────────────────────────────────────
exports.assignSubjectToSections = async (req, res) => {
    try {
        const { subject, teacher, sectionIds, preview } = req.body;

        const cls = await Class.findOne({ _id: req.params.classId, school: req.schoolId }).lean();
        if (!cls) return err(res, 'Class not found', 404);
        if (!subject) return err(res, 'Pick a subject', 400);
        if (!teacher) return err(res, 'Pick a teacher', 400);

        const wanted = Array.isArray(sectionIds) ? [...new Set(sectionIds.map(String))] : [];
        if (!wanted.length) return err(res, 'Pick at least one section', 400);

        const subjectDoc = await Subject.findOne({ _id: subject, school: req.schoolId }).select('subjectName').lean();
        if (!subjectDoc) return err(res, 'Subject not found', 404);

        // A deactivated teacher cannot be assigned anywhere — same rule the
        // single-section path enforces.
        const inactive = await inactiveTeacherError(teacher, req.schoolId);
        if (inactive) return err(res, inactive, 400);

        const siblings = await ClassSection.find({ class: cls._id, school: req.schoolId })
            .select('sectionName').lean();
        const byId = new Map(siblings.map((x) => [String(x._id), x]));
        const stray = wanted.filter((sid) => !byId.has(sid));
        if (stray.length) return err(res, `Those sections are not in ${cls.className}`, 400);

        const already = await SectionSubjectTeacher.find({
            section: { $in: wanted }, subject, teacher,
        }).select('section').lean();
        const doneIds = new Set(already.map((r) => String(r.section)));

        const toCreate = wanted.filter((sid) => !doneIds.has(sid));
        const payload = {
            classId:     String(cls._id),
            className:   cls.className,
            subjectName: subjectDoc.subjectName,
            toCreate:    toCreate.map((sid) => byId.get(sid).sectionName),
            alreadyDone: wanted.filter((sid) => doneIds.has(sid)).map((sid) => byId.get(sid).sectionName),
        };
        if (preview) return ok(res, { ...payload, preview: true });

        for (const sid of toCreate) {
            await SectionSubjectTeacher.create({ section: sid, subject, teacher });
            await ensureClassSubject(sid, subject);
        }
        // Subject teachers belong to each section's teacher group chat.
        for (const sid of toCreate) {
            syncSectionChatGroup(sid, req.schoolId, req.userId).catch(() => {});
        }

        ok(res, { ...payload, preview: false, created: toCreate.length }, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, 'That teacher is already assigned to this subject in one of those sections.', 400);
        err(res, e, 400);
    }
};

/**
 * The other half of ensureClassSubject.
 *
 * Assigning a teacher writes the class-level link as a consequence; removing
 * the last one has to take it away again, or the class goes on carrying a
 * subject nobody teaches anywhere in it. That is not cosmetic — ClassSubject is
 * what the parent portal lists as the child's subjects, what the timetable
 * generator plans around, and what the year import copies forward, so a
 * left-behind link seeds next year with a subject that was dropped.
 *
 * Scoped to the whole CLASS, not the section: Hindi is still taught in Class 5
 * while any of its sections has a teacher for it. Only when the last one goes
 * does the class stop carrying it.
 *
 * Returns what happened so the caller can say so rather than leaving the admin
 * to notice a second change they did not ask for.
 */
async function pruneClassSubject(sectionId, subjectId) {
    const none = { unassigned: false, className: '', remaining: 0 };
    if (!sectionId || !subjectId) return none;

    const section = await ClassSection.findById(sectionId).select('class').lean();
    if (!section?.class) return none;

    const siblings = await ClassSection.find({ class: section.class }).select('_id').lean();
    const remaining = await SectionSubjectTeacher.countDocuments({
        section: { $in: siblings.map((x) => x._id) },
        subject: subjectId,
    });
    if (remaining > 0) return { ...none, remaining };

    const cls = await Class.findById(section.class).select('className').lean();
    await ClassSubject.deleteOne({ class: section.class, subject: subjectId });
    return { unassigned: true, className: cls?.className || '', remaining: 0 };
}

exports.removeSectionSubject = async (req, res) => {
    try {
        await SectionSubjectTeacher.deleteMany({ section: req.params.sectionId, subject: req.params.subjectId });
        const pruned = await pruneClassSubject(req.params.sectionId, req.params.subjectId);
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        res.json({ success: true, ...pruned });
    } catch (e) { err(res, e); }
};
exports.removeSectionSubjectTeacher = async (req, res) => {
    try {
        await SectionSubjectTeacher.deleteOne({
            section: req.params.sectionId,
            subject: req.params.subjectId,
            teacher: req.params.teacherId,
        });
        // Was that the last teacher this subject had anywhere in the class? Then
        // the class no longer teaches it either.
        const pruned = await pruneClassSubject(req.params.sectionId, req.params.subjectId);
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        res.json({ success: true, ...pruned });
    } catch (e) { err(res, e); }
};
