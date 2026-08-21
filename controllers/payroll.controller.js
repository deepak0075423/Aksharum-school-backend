'use strict';
const SalaryStructure          = require('../models/SalaryStructure');
const EmployeeSalaryAssignment = require('../models/EmployeeSalaryAssignment');
const PayrollRun               = require('../models/PayrollRun');
const PayrollEntry             = require('../models/PayrollEntry');
const PayrollAuditLog          = require('../models/PayrollAuditLog');
const Payslip                  = require('../models/Payslip');
const User                     = require('../models/User');
const TeacherProfile           = require('../models/TeacherProfile');
const School                   = require('../models/School');
const { notify }               = require('../services/notifyService');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Salary calculation ────────────────────────────────────────────────────────

/**
 * Unpaid leave days per employee for a pay month, keyed by employee id.
 *
 * Returns an EMPTY object when the Leave module is off for the school, so every
 * caller falls straight back to the hand-entered figure and payroll behaves
 * exactly as it did before this link existed. Any failure does the same — a
 * leave lookup must never be the reason a payroll run cannot be processed.
 */
async function leaveLopDaysFor(schoolId, year, month) {
    try {
        const School = require('../models/School');
        const { schoolModuleFlags } = require('../config/modules');
        const school = await School.findById(schoolId).select('modules').lean();
        if (!schoolModuleFlags(school).leave) return {};

        const LeaveApplication = require('../models/LeaveApplication');
        const monthStart = new Date(Date.UTC(year, month - 1, 1));
        const monthEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

        const apps = await LeaveApplication.find({
            school: schoolId, status: 'approved',
            lopDays: { $gt: 0 },
            fromDate: { $lte: monthEnd }, toDate: { $gte: monthStart },
        }).select('teacher lopDays fromDate toDate totalDays').lean();

        const out = {};
        for (const a of apps) {
            // A leave spanning a month boundary is charged pro-rata to the part
            // that falls inside this pay month, so no day is deducted twice.
            const from = new Date(Math.max(new Date(a.fromDate), monthStart));
            const to   = new Date(Math.min(new Date(a.toDate), monthEnd));
            const inMonth = Math.max(0, Math.round((to - from) / 86400000) + 1);
            const span    = Math.max(1, Math.round((new Date(a.toDate) - new Date(a.fromDate)) / 86400000) + 1);
            const share   = span > 0 ? (a.lopDays * inMonth) / span : a.lopDays;
            out[String(a.teacher)] = Math.round(((out[String(a.teacher)] || 0) + share) * 100) / 100;
        }
        return out;
    } catch (err) {
        console.error('[payroll←leave] LOP lookup failed:', err.message);
        return {};
    }
}

function computeSalaryBreakdown(structure, monthlyCtc, overrides = [], lopDays = 0) {
    const workingDays = 26;
    const resolved    = { CTC: monthlyCtc };

    const overrideMap = Object.fromEntries(overrides.map(o => [o.componentName, o.value]));

    const earnings    = [];
    const deductions  = [];

    const components = [...(structure.components || [])].sort((a, b) => a.order - b.order);

    for (const comp of components) {
        if (!comp.isActive) continue;
        let amount = overrideMap[comp.name] ?? 0;

        if (!overrideMap.hasOwnProperty(comp.name)) {
            if (comp.calculationType === 'fixed') {
                amount = comp.value || 0;
            } else {
                const base = resolved[comp.percentageOf] ?? 0;
                amount = ((comp.percentage || 0) / 100) * base;
            }
        }
        amount = Math.round(amount * 100) / 100;
        resolved[comp.name] = amount;

        if (comp.type === 'earning')    earnings.push({ name: comp.name, amount });
        else if (comp.type === 'deduction') deductions.push({ name: comp.name, amount });
    }

    let grossSalary     = earnings.reduce((s, e) => s + e.amount, 0);
    let totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

    let lopAmount = 0;
    if (lopDays > 0) {
        lopAmount = Math.round((grossSalary / workingDays) * lopDays * 100) / 100;
        grossSalary -= lopAmount;
    }

    return { earnings, deductions, grossSalary: Math.round(grossSalary * 100) / 100, totalDeductions: Math.round(totalDeductions * 100) / 100, netSalary: Math.round((grossSalary - totalDeductions) * 100) / 100, lopAmount };
}

async function logAudit(schoolId, userId, actionType, entityType, entityId, note) {
    try {
        await PayrollAuditLog.create({ school: schoolId, user: userId, actionType, entityType, entityId });
    } catch { /* non-critical */ }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        const now     = new Date();
        const month   = now.getMonth() + 1;
        const year    = now.getFullYear();

        const [totalEmployees, activeAssignments, currentRun, recentRuns] = await Promise.all([
            User.countDocuments({ school: req.schoolId, role: 'teacher', isActive: true }),
            EmployeeSalaryAssignment.countDocuments({ school: req.schoolId, isActive: true }),
            PayrollRun.findOne({ school: req.schoolId, year, month }).lean(),
            PayrollRun.find({ school: req.schoolId }).sort({ year: -1, month: -1 }).limit(6).lean(),
        ]);

        res.json({ success: true, data: { totalEmployees, activeAssignments, currentRun, recentRuns } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Salary Structures ─────────────────────────────────────────────────────────

exports.getStructures = async (req, res) => {
    try {
        const structures = await SalaryStructure.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        res.json({ success: true, data: structures });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createStructure = async (req, res) => {
    try {
        const { name, description, components } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });

        const structure = await SalaryStructure.create({
            school: req.schoolId, name: name.trim(),
            description: description || '',
            components: components || [],
            createdBy: req.userId,
        });
        logAudit(req.schoolId, req.userId, 'STRUCTURE_CREATED', 'SalaryStructure', structure._id);
        res.status(201).json({ success: true, data: structure });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Structure name already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateStructure = async (req, res) => {
    try {
        const { name, description, components } = req.body;
        const update = {};
        if (name        !== undefined) update.name        = name.trim();
        if (description !== undefined) update.description = description;
        if (components  !== undefined) update.components  = components;

        const structure = await SalaryStructure.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            update,
            { new: true, runValidators: true }
        ).lean();
        if (!structure) return res.status(404).json({ success: false, message: 'Structure not found' });
        logAudit(req.schoolId, req.userId, 'STRUCTURE_UPDATED', 'SalaryStructure', structure._id);
        res.json({ success: true, data: structure });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleStructure = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        s.isActive = !s.isActive;
        await s.save();
        res.json({ success: true, data: s });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStructureComponents = async (req, res) => {
    try {
        const s = await SalaryStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        res.json({ success: true, data: s.components });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Assignments ───────────────────────────────────────────────────────────────

exports.getAssignments = async (req, res) => {
    try {
        const { isActive } = req.query;
        const filter = { school: req.schoolId };
        if (isActive !== undefined) filter.isActive = isActive !== 'false';

        const assignments = await EmployeeSalaryAssignment.find(filter)
            .populate('employee',  'name email employeeId')
            .populate('structure', 'name')
            .populate('assignedBy','name')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: assignments });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.assignEmployee = async (req, res) => {
    try {
        const { employeeId, structureId, effectiveDate, annualCtc, notes } = req.body;
        if (!employeeId || !structureId || !effectiveDate || annualCtc === undefined)
            return res.status(400).json({ success: false, message: 'employeeId, structureId, effectiveDate and annualCtc are required' });

        const effDate = new Date(effectiveDate);
        const month   = effDate.getMonth() + 1;
        const year    = effDate.getFullYear();

        const assignment = await EmployeeSalaryAssignment.create({
            employee: employeeId, school: req.schoolId, structure: structureId,
            effectiveDate: effDate, ctc: annualCtc,
            ctcRevisions: [{ annualCtc, previousCtc: 0, incrementType: 'initial', incrementValue: 0, effectiveMonth: month, effectiveYear: year, updatedBy: req.userId }],
            assignedBy: req.userId, notes: notes || '',
        });
        logAudit(req.schoolId, req.userId, 'ASSIGNMENT_CREATED', 'EmployeeSalaryAssignment', assignment._id);
        res.status(201).json({ success: true, data: assignment });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateAssignment = async (req, res) => {
    try {
        const { structureId, componentOverrides, notes } = req.body;
        const update = {};
        if (structureId         !== undefined) update.structure          = structureId;
        if (componentOverrides  !== undefined) update.componentOverrides = componentOverrides;
        if (notes               !== undefined) update.notes              = notes;

        const asgn = await EmployeeSalaryAssignment.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            update,
            { new: true }
        ).populate('employee', 'name').populate('structure', 'name').lean();
        if (!asgn) return res.status(404).json({ success: false, message: 'Assignment not found' });
        res.json({ success: true, data: asgn });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deactivateAssignment = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { isActive: false },
            { new: true }
        ).lean();
        if (!asgn) return res.status(404).json({ success: false, message: 'Assignment not found' });
        res.json({ success: true, data: asgn });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getUpdateCtc = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('employee', 'name email employeeId').lean();
        if (!asgn) return res.status(404).json({ success: false, message: 'Assignment not found' });
        res.json({ success: true, data: asgn });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateCtc = async (req, res) => {
    try {
        const { annualCtc, incrementType, effectiveMonth, effectiveYear, note } = req.body;
        if (!annualCtc || !effectiveMonth || !effectiveYear)
            return res.status(400).json({ success: false, message: 'annualCtc, effectiveMonth and effectiveYear are required' });

        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asgn) return res.status(404).json({ success: false, message: 'Assignment not found' });

        const prevCtc = asgn.ctc || 0;
        const diff    = annualCtc - prevCtc;
        asgn.ctc      = annualCtc;
        asgn.ctcRevisions.push({
            annualCtc, previousCtc: prevCtc,
            incrementType: incrementType || 'manual',
            incrementValue: diff,
            effectiveMonth: +effectiveMonth, effectiveYear: +effectiveYear,
            note: note || '', updatedBy: req.userId,
        });
        await asgn.save();
        logAudit(req.schoolId, req.userId, 'CTC_UPDATED', 'EmployeeSalaryAssignment', asgn._id, `CTC updated to ${annualCtc}`);
        res.json({ success: true, data: asgn });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getCtcHistory = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('employee', 'name').lean();
        if (!asgn) return res.status(404).json({ success: false, message: 'Assignment not found' });
        res.json({ success: true, data: asgn.ctcRevisions });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Payroll Runs ──────────────────────────────────────────────────────────────

exports.getPayrollRuns = async (req, res) => {
    try {
        const { year, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (year) filter.year = +year;

        const [runs, total] = await Promise.all([
            PayrollRun.find(filter)
                .populate('processedBy','name')
                .populate('approvedBy', 'name')
                .sort({ year: -1, month: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            PayrollRun.countDocuments(filter),
        ]);
        res.json({ success: true, data: runs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createRun = async (req, res) => {
    try {
        const { month, year, notes } = req.body;
        if (!month || !year) return res.status(400).json({ success: false, message: 'month and year are required' });

        const existing = await PayrollRun.findOne({ school: req.schoolId, year: +year, month: +month });
        if (existing) return res.status(400).json({ success: false, message: 'Payroll run for this month already exists' });

        // Compute entries for all active assignments
        const assignments = await EmployeeSalaryAssignment.find({ school: req.schoolId, isActive: true })
            .populate('structure').lean();

        const run = await PayrollRun.create({
            school: req.schoolId, month: +month, year: +year,
            status: 'draft', processedBy: req.userId, processedAt: new Date(), notes: notes || '',
        });

        let totalGross = 0, totalDeductions = 0, totalNet = 0;
        const entryDocs = [];

        // Loss-of-pay days come from approved leave when the Leave module is on
        // for this school. Without it — or for an employee with no unpaid leave
        // — the figure falls back to whatever the payroll form supplied, which
        // is exactly how this worked before leave was wired in.
        const lopFromLeave = await leaveLopDaysFor(req.schoolId, +year, +month);

        for (const asgn of assignments) {
            if (!asgn.structure) continue;
            const annualCtc  = asgn.getActiveCTC ? asgn.getActiveCTC(+year, +month) : (asgn.ctc || 0);
            const monthlyCtc = annualCtc / 12;
            const lopDays    = lopFromLeave[String(asgn.employee)] ?? (req.body[`lop_${asgn.employee}`] || 0);
            const breakdown  = computeSalaryBreakdown(asgn.structure, monthlyCtc, asgn.componentOverrides || [], lopDays);

            totalGross      += breakdown.grossSalary;
            totalDeductions += breakdown.totalDeductions;
            totalNet        += breakdown.netSalary;

            entryDocs.push({
                payrollRun: run._id, employee: asgn.employee, school: req.schoolId,
                month: +month, year: +year, salaryAssignment: asgn._id,
                earnings: breakdown.earnings, deductions: breakdown.deductions,
                grossSalary: breakdown.grossSalary, totalDeductions: breakdown.totalDeductions,
                netSalary: breakdown.netSalary, lopAmount: breakdown.lopAmount, lopDays,
            });
        }

        if (entryDocs.length) await PayrollEntry.insertMany(entryDocs);
        await PayrollRun.updateOne({ _id: run._id }, {
            totalEmployees: entryDocs.length,
            totalGross:     Math.round(totalGross * 100) / 100,
            totalDeductions:Math.round(totalDeductions * 100) / 100,
            totalNet:       Math.round(totalNet * 100) / 100,
        });

        const updated = await PayrollRun.findById(run._id).lean();
        logAudit(req.schoolId, req.userId, 'RUN_CREATED', 'PayrollRun', run._id);
        res.status(201).json({ success: true, data: updated });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getRunDetail = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('processedBy','name')
            .populate('approvedBy', 'name')
            .lean();
        if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found' });

        const entries = await PayrollEntry.find({ payrollRun: run._id })
            .populate('employee','name email employeeId')
            .lean();

        // Attach payslip ids (exist once the run is published) so the admin can download PDFs
        const payslips = await Payslip.find({ payrollEntry: { $in: entries.map(e => e._id) } })
            .select('payrollEntry status').lean();
        const slipByEntry = Object.fromEntries(payslips.map(p => [p.payrollEntry.toString(), p]));
        const withSlips = entries.map(e => ({
            ...e,
            payslip: slipByEntry[e._id.toString()] || null,
        }));

        res.json({ success: true, data: { ...run, entries: withSlips } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateRunStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const allowed = ['reviewed', 'approved'];
        if (!allowed.includes(status)) return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });

        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId });
        if (!run) return res.status(404).json({ success: false, message: 'Run not found' });

        const update = { status };
        if (status === 'reviewed') { update.reviewedBy = req.userId; update.reviewedAt = new Date(); }
        if (status === 'approved') { update.approvedBy = req.userId; update.approvedAt = new Date(); }

        const updated = await PayrollRun.findByIdAndUpdate(run._id, update, { new: true }).lean();
        logAudit(req.schoolId, req.userId, `RUN_${status.toUpperCase()}`, 'PayrollRun', run._id);
        res.json({ success: true, data: updated });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.publishRun = async (req, res) => {
    try {
        const run = await PayrollRun.findOne({ _id: req.params.id, school: req.schoolId });
        if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
        if (run.status !== 'approved') return res.status(400).json({ success: false, message: 'Run must be approved before publishing' });

        run.status      = 'published';
        run.publishedBy = req.userId;
        run.publishedAt = new Date();
        await run.save();

        // Generate payslips for all entries
        const entries = await PayrollEntry.find({ payrollRun: run._id }).lean();
        const school  = await School.findById(req.schoolId).lean();

        // Batch employee + profile lookups (was 2 round trips per staff member)
        const employeeIds = [...new Set(entries.map(e => String(e.employee)))];
        const [emps, profiles] = await Promise.all([
            User.find({ _id: { $in: employeeIds } }).lean(),
            TeacherProfile.find({ user: { $in: employeeIds } }).lean(),
        ]);
        const empById     = new Map(emps.map(u => [String(u._id), u]));
        const profileById = new Map(profiles.map(p => [String(p.user), p]));

        for (const entry of entries) {
            const emp     = empById.get(String(entry.employee));
            const profile = profileById.get(String(entry.employee));

            const payslip = await Payslip.create({
                payrollEntry: entry._id, employee: entry.employee, school: req.schoolId,
                month: run.month, year: run.year,
                employeeSnapshot: {
                    name:        emp?.name || '',
                    email:       emp?.email || '',
                    employeeId:  emp?.employeeId || '',
                    designation: profile?.designation || '',
                    department:  profile?.department || '',
                    joiningDate: profile?.joiningDate || null,
                },
                schoolSnapshot: {
                    name:    school?.name    || '',
                    address: school?.address || '',
                    email:   school?.email   || '',
                    phone:   school?.phone   || '',
                },
                earnings:        entry.earnings,
                deductions:      entry.deductions,
                grossSalary:     entry.grossSalary,
                totalDeductions: entry.totalDeductions,
                netSalary:       entry.netSalary,
                lopDays:         entry.lopDays,
                lopAmount:       entry.lopAmount,
                generatedBy:     req.userId,
            });
            await PayrollEntry.updateOne({ _id: entry._id }, { payslip: payslip._id });

            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '💵 Payslip published',
                body: `Your payslip for ${MONTHS[(run.month || 1) - 1]} ${run.year} is now available.\nNet salary: ₹${(entry.netSalary || 0).toLocaleString('en-IN')}`,
                recipients: [entry.employee],
                email: true,
            });
        }

        logAudit(req.schoolId, req.userId, 'RUN_PUBLISHED', 'PayrollRun', run._id);
        res.json({ success: true, data: run });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateEntry = async (req, res) => {
    try {
        const { lopDays, arrears, bonus, earnings, deductions } = req.body;
        const entry = await PayrollEntry.findOne({ _id: req.params.entryId, payrollRun: req.params.id, school: req.schoolId });
        if (!entry) return res.status(404).json({ success: false, message: 'Entry not found' });

        if (earnings    !== undefined) entry.earnings    = earnings;
        if (deductions  !== undefined) entry.deductions  = deductions;
        if (lopDays     !== undefined) entry.lopDays     = +lopDays;
        if (arrears     !== undefined) entry.arrears     = +arrears;
        if (bonus       !== undefined) entry.bonus       = +bonus;

        entry.grossSalary     = entry.earnings.reduce((s, e) => s + e.amount, 0);
        entry.totalDeductions = entry.deductions.reduce((s, d) => s + d.amount, 0);
        entry.netSalary       = entry.grossSalary - entry.totalDeductions + (entry.arrears || 0) + (entry.bonus || 0);
        await entry.save();
        res.json({ success: true, data: entry });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Reports & Audit ───────────────────────────────────────────────────────────

exports.getReports = async (req, res) => {
    try {
        const { year } = req.query;
        const filter = { school: req.schoolId };
        if (year) filter.year = +year;

        const runs = await PayrollRun.find(filter).sort({ year: -1, month: -1 }).lean();
        res.json({ success: true, data: runs });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 30 } = req.query;
        const [logs, total] = await Promise.all([
            PayrollAuditLog.find({ school: req.schoolId })
                .populate('user','name')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            PayrollAuditLog.countDocuments({ school: req.schoolId }),
        ]);
        res.json({ success: true, data: logs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: My CTC ───────────────────────────────────────────────────────────

exports.getMyCtc = async (req, res) => {
    try {
        const asgn = await EmployeeSalaryAssignment.findOne({ employee: req.userId, school: req.schoolId, isActive: true })
            .populate('structure', 'name components')
            .lean();
        if (!asgn) return res.json({ success: true, data: null });

        const monthlyCtc  = (asgn.ctc || 0) / 12;
        const breakdown   = computeSalaryBreakdown(asgn.structure, monthlyCtc, asgn.componentOverrides || []);

        res.json({ success: true, data: { assignment: asgn, monthlyCtc, breakdown } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
