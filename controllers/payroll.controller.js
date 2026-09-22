'use strict';
/**
 * Payroll — the teacher's own view, plus the compatibility surface.
 *
 * Every admin action now lives in payrollAdmin.controller.js, which is where
 * the raw-SQL read models and the corrected writers are. This file keeps the
 * employee-facing endpoints and re-exports the admin handlers under their old
 * names, so the mobile app's existing routes keep working unchanged while the
 * web screens move to the new ones.
 *
 * The salary maths that used to live here — computeSalaryBreakdown — is gone.
 * It ignored the employee's CTC entirely (see services/payrollCalc.js), so a
 * teacher's "My CTC" screen showed the same figures as every colleague on the
 * same structure. It now reads the same engine the payroll run does.
 */
const EmployeeSalaryAssignment = require('../models/EmployeeSalaryAssignment');
const PayrollEntry             = require('../models/PayrollEntry');
const SalaryStructure          = require('../models/SalaryStructure');
const TeacherProfile           = require('../models/TeacherProfile');
const User                     = require('../models/User');
const admin                    = require('./payrollAdmin.controller');
const calc                     = require('../services/payrollCalc');

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2  = (n) => Math.round(num(n) * 100) / 100;
const trim = (s) => String(s ?? '').trim();

/** "XXXX XXXX 4521" — enough to tell which account, and nothing more. */
const maskAccount = (v) => {
    const raw = trim(v).replace(/\s+/g, '');
    if (!raw) return '';
    if (raw.length <= 4) return 'X'.repeat(raw.length);
    return `XXXX XXXX ${raw.slice(-4)}`;
};

// ── Teacher: my CTC ──────────────────────────────────────────────────────────

exports.getMyCtc = async (req, res) => {
    try {
        const [asgn, user, profile] = await Promise.all([
            EmployeeSalaryAssignment.findOne({ employee: req.userId, school: req.schoolId, isActive: true })
                .populate('structure', 'name type description components payBasis rate rateUnit')
                .lean(),
            User.findById(req.userId).select('name email').lean(),
            TeacherProfile.findOne({ user: req.userId, school: req.schoolId })
                .select('employeeId designation department joiningDate bankAccountNumber bankIfsc bankBranch panNumber uanNumber').lean(),
        ]);
        const who = {
            name: user?.name || '', email: user?.email || '',
            employeeId: profile?.employeeId || '', designation: profile?.designation || '',
            department: profile?.department || '', joiningDate: profile?.joiningDate || null,
            bankAccount: maskAccount(profile?.bankAccountNumber), bankIfsc: profile?.bankIfsc || '',
            bankBranch: profile?.bankBranch || '',
            panNumber: profile?.panNumber ? `XXXXX${trim(profile.panNumber).slice(-4)}` : '',
            uanNumber: profile?.uanNumber || '',
        };
        /**
         * Someone with no assignment still gets their own details back, so the
         * screen can say who it could not find a salary for rather than
         * rendering an anonymous empty state.
         *
         * `data` is an OBJECT, never null. hooks/useFetch does
         * `res?.data ?? res`, and `??` only falls through on null — so an
         * endpoint that answers `data: null` hands the caller the whole
         * envelope instead, and every `if (!data)` guard downstream reads
         * false. `hasSalary` is the flag to test.
         */
        if (!asgn || !asgn.structure) {
            return res.json({ success: true, data: { hasSalary: false, employee: who } });
        }

        const settings = await admin.settingsFor(req.schoolId);
        const now   = new Date();
        const year  = now.getFullYear(), month = now.getMonth() + 1;
        // The CTC in force THIS month, not whatever the current column holds —
        // a revision dated next April must not show up in March's figures.
        const annualCtc = EmployeeSalaryAssignment.activeCtc(asgn, year, month);
        const workingDays = await calc.workingDaysFor(req.schoolId, year, month, settings);

        const breakdown = calc.computePay({
            structure: asgn.structure,
            annualCtc,
            overrides: asgn.componentOverrides || [],
            workingDays,
            roundTo: settings.roundTo,
        });

        // What this person was actually PAID — entries of runs that have been
        // published, which is exactly the ones that issued a payslip. Reading
        // every entry would have put a draft month the office is still working
        // on under a heading that says "what you were actually paid".
        const recent = await PayrollEntry.find({
            employee: req.userId, school: req.schoolId, payslip: { $ne: null },
        }).sort({ year: -1, month: -1 }).limit(6).lean();

        // A revision already on the timeline but not yet in force. Showing the
        // stored CTC beside a breakdown built from a different one is how the
        // admin panel used to contradict itself.
        const pending = [...(asgn.ctcRevisions || [])]
            .filter(r => r.effectiveYear > year || (r.effectiveYear === year && r.effectiveMonth > month))
            .sort((a, b) => (a.effectiveYear - b.effectiveYear) || (a.effectiveMonth - b.effectiveMonth))[0] || null;

        // Six months of net pay, oldest first and zero-filled, for the chart.
        const byKey = new Map(recent.map(e => [`${e.year}-${e.month}`, e]));
        const series = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(Date.UTC(year, month - 1 - i, 1));
            const m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
            const e = byKey.get(`${y}-${m}`);
            series.push({
                month: m, year: y, label: `${MONTHS_SHORT[m - 1]} ${y}`,
                gross: r2(e?.grossSalary), deductions: r2(e?.totalDeductions), net: r2(e?.netSalary),
            });
        }

        res.json({
            success: true,
            data: {
                hasSalary: true,
                employee: who,
                assignment: asgn,
                structure: {
                    _id: asgn.structure._id, name: asgn.structure.name, type: asgn.structure.type || 'general',
                    description: asgn.structure.description || '',
                    payBasis: asgn.structure.payBasis || 'monthly',
                    rate: r2(asgn.structure.rate), rateUnit: asgn.structure.rateUnit || 'class',
                },
                annualCtc,
                monthlyCtc: breakdown.monthlyCtc,
                monthLabel: `${['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1]} ${year}`,
                effectiveDate: asgn.effectiveDate, endDate: asgn.endDate,
                paymentMode: asgn.paymentMode || 'bank_transfer',
                pendingRevision: pending ? {
                    annualCtc: r2(pending.annualCtc),
                    effectiveLabel: `${['January','February','March','April','May','June','July','August','September','October','November','December'][pending.effectiveMonth - 1]} ${pending.effectiveYear}`,
                    note: pending.note || '',
                } : null,
                breakdown,
                series,
                revisions: [...(asgn.ctcRevisions || [])].sort((a, b) =>
                    (b.effectiveYear - a.effectiveYear) || (b.effectiveMonth - a.effectiveMonth))
                    .map(r => ({
                        ...r,
                        effectiveLabel: `${MONTHS_SHORT[r.effectiveMonth - 1]} ${r.effectiveYear}`,
                    })),
                recent: recent.map(e => ({
                    month: e.month, year: e.year, label: `${MONTHS_SHORT[e.month - 1]} ${e.year}`,
                    gross: r2(e.grossSalary), deductions: r2(e.totalDeductions), net: r2(e.netSalary),
                    lopDays: num(e.lopDays),
                })),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Compatibility: the admin handlers under their previous names ─────────────

exports.getDashboard            = admin.getDashboard;
exports.getStructures           = admin.listStructures;
exports.createStructure         = admin.createStructure;
exports.updateStructure         = admin.updateStructure;
exports.toggleStructure         = admin.toggleStructure;
exports.getAssignments          = admin.listAssignments;
exports.assignEmployee          = admin.assignEmployee;
exports.updateAssignment        = admin.updateAssignment;
exports.deactivateAssignment    = admin.setAssignmentActive;
exports.getUpdateCtc            = admin.getAssignment;
exports.updateCtc               = admin.updateCtc;
exports.getCtcHistory           = admin.getCtcHistory;
exports.getPayrollRuns          = admin.listRuns;
exports.createRun               = admin.createRun;
exports.getRunDetail            = admin.getRun;
exports.updateRunStatus         = admin.updateRunStatus;
exports.publishRun              = admin.publishRun;
exports.updateEntry             = admin.updateEntry;
exports.getReports              = admin.listReports;
exports.getAuditLog             = admin.getAuditLog;

exports.getStructureComponents = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        res.json({ success: true, data: s.components || [] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
