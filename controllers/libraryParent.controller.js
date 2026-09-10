'use strict';
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryFine        = require('../models/LibraryFine');
const LibraryReservation = require('../models/LibraryReservation');
const ParentProfile      = require('../models/ParentProfile');
const StudentProfile     = require('../models/StudentProfile');
const User               = require('../models/User');
const ClassSection       = require('../models/ClassSection');
const Class              = require('../models/Class');
const AcademicYear       = require('../models/AcademicYear');
const { ACTIVE_ISSUANCE, sweepOverdue, attachFineSummary } = require('../services/libraryRules');

const ACTIVE_HOLD = ['pending', 'ready'];

/**
 * The library, one child at a time.
 *
 * A parent can have more than one child and their borrowing is nothing alike,
 * so this answers per child rather than merging them — a shelf of books with no
 * name against them tells a parent nothing about who has to return what.
 *
 * The link between parent and child has two sources of truth that drift: the
 * parent's own `children` list and the student profile's `parent` pointer. Both
 * are read, then the users are re-read school-scoped so a stale id cannot reach
 * into another school.
 */
exports.getOverview = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);

        const [parent, owned, year] = await Promise.all([
            ParentProfile.findOne({ user: req.userId, school: req.schoolId }).lean(),
            StudentProfile.find({ parent: req.userId, school: req.schoolId }).select('user').lean(),
            AcademicYear.findOne({ school: req.schoolId, status: 'active' })
                .select('yearName startDate endDate').lean(),
        ]);

        const listed   = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);
        const childIds = [...new Set([...listed, ...owned.map((p) => p.user)].filter(Boolean).map(String))];
        if (!childIds.length) return res.json({ success: true, data: { children: [], academicYear: year || null } });

        const kids = await User.find({ _id: { $in: childIds }, role: 'student', school: req.schoolId })
            .select('name profileImage').lean();
        if (!kids.length) return res.json({ success: true, data: { children: [], academicYear: year || null } });
        kids.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        const ids = kids.map((k) => String(k._id));

        // Where each child sits, for the switch across the top.
        const profiles = await StudentProfile.find({ user: { $in: ids } })
            .select('user currentSection currentClass rollNumber admissionNumber').lean();
        const sectionIds = [...new Set(profiles.map((p) => p.currentSection).filter(Boolean).map(String))];
        const sections   = sectionIds.length
            ? await ClassSection.find({ _id: { $in: sectionIds } }).select('sectionName class').lean() : [];
        const classIds   = [...new Set([
            ...sections.map((s) => String(s.class)),
            ...profiles.map((p) => p.currentClass).filter(Boolean).map(String),
        ])];
        const classes = classIds.length
            ? await Class.find({ _id: { $in: classIds } }).select('className classNumber').lean() : [];
        const classById   = Object.fromEntries(classes.map((c) => [String(c._id), c]));
        const sectionById = Object.fromEntries(sections.map((s) => [String(s._id), s]));
        const profileByUser = Object.fromEntries(profiles.map((p) => [String(p.user), p]));

        // Three queries for every child at once rather than three per child.
        const [loansRaw, fines, holds] = await Promise.all([
            LibraryIssuance.find({ school: req.schoolId, issuedTo: { $in: ids } })
                .populate('book', 'title isbn authors category coverImage')
                .populate('bookCopy', 'uniqueCode')
                .sort({ issueDate: -1 }).lean(),
            LibraryFine.find({ school: req.schoolId, user: { $in: ids } })
                .select('user amount waivedAmount paidAmount status paidAt').lean(),
            LibraryReservation.find({ school: req.schoolId, reservedBy: { $in: ids }, status: { $in: ACTIVE_HOLD } })
                .populate('book', 'title authors coverImage')
                .sort({ createdAt: -1 }).lean(),
        ]);

        const loans = await attachFineSummary(loansRaw);
        const now   = Date.now();
        const owedOf = (f) => Math.max(
            0, Number(f.amount || 0) - Number(f.waivedAmount || 0) - Number(f.paidAmount || 0),
        );
        const yearStart = year?.startDate ? new Date(year.startDate).getTime() : 0;

        const children = kids.map((kid) => {
            const key  = String(kid._id);
            const prof = profileByUser[key] || {};
            const sec  = prof.currentSection ? sectionById[String(prof.currentSection)] : null;
            const cls  = sec ? classById[String(sec.class)]
                : (prof.currentClass ? classById[String(prof.currentClass)] : null);

            const mine = loans.filter((l) => String(l.issuedTo) === key).map((l) => ({
                ...l,
                isOverdue: ACTIVE_ISSUANCE.includes(l.status) && now > new Date(l.dueDate).getTime(),
            }));
            const myFines = fines.filter((f) => String(f.user) === key);

            return {
                _id:             kid._id,
                name:            kid.name,
                profileImage:    kid.profileImage || '',
                className:       cls?.className || (cls?.classNumber != null ? `Class ${cls.classNumber}` : ''),
                sectionName:     sec?.sectionName || '',
                rollNumber:      prof.rollNumber || '',
                admissionNumber: prof.admissionNumber || '',
                loans:           mine,
                reservations:    holds.filter((h) => String(h.reservedBy) === key),
                stats: {
                    borrowed: mine.filter((l) => ACTIVE_ISSUANCE.includes(l.status)).length,
                    overdue:  mine.filter((l) => l.isOverdue || l.status === 'overdue').length,
                    returned: mine.filter((l) => l.status === 'returned'
                        && (!yearStart || new Date(l.returnDate || l.issueDate).getTime() >= yearStart)).length,
                    reserved: holds.filter((h) => String(h.reservedBy) === key).length,
                    finesOutstanding: myFines.filter((f) => f.status === 'pending').reduce((s, f) => s + owedOf(f), 0),
                    finesPaid: myFines.filter((f) => f.status === 'paid'
                        && (!yearStart || new Date(f.paidAt || 0).getTime() >= yearStart)).length,
                },
            };
        });

        res.json({ success: true, data: { children, academicYear: year || null } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
