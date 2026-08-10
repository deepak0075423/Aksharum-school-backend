'use strict';
const Payslip = require('../models/Payslip');
const { generatePayslipPDF } = require('../utils/payslipPdf');

const MONTH_NAMES = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Admin: Download specific payslip ─────────────────────────────────────────

exports.adminDownloadPayslip = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, school: req.schoolId });
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

        const name     = payslip.employeeSnapshot?.name?.replace(/\s+/g, '_') || 'employee';
        const filename = `payslip_${name}_${MONTH_NAMES[payslip.month]}_${payslip.year}.pdf`;
        generatePayslipPDF(res, payslip, filename);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: My payslips ──────────────────────────────────────────────────────

exports.getMyPayslips = async (req, res) => {
    try {
        const { year } = req.query;
        const filter = { employee: req.userId, school: req.schoolId };
        if (year) filter.year = +year;

        const payslips = await Payslip.find(filter)
            .sort({ year: -1, month: -1 })
            .lean();
        res.json({ success: true, data: payslips });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getPayslipDetail = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, employee: req.userId, school: req.schoolId }).lean();
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });
        res.json({ success: true, data: payslip });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.downloadPayslip = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, employee: req.userId, school: req.schoolId });
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

        const filename = `payslip_${MONTH_NAMES[payslip.month]}_${payslip.year}.pdf`;
        generatePayslipPDF(res, payslip, filename);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
