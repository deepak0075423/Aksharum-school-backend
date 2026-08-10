'use strict';
const ActivityLog = require('../models/ActivityLog');

exports.getLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50, school, action, from, to } = req.query;
        const filter = {};
        if (school) filter.school = school;
        if (action) filter.action = new RegExp(action, 'i');
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to)   filter.createdAt.$lte = new Date(to);
        }
        const [logs, total] = await Promise.all([
            ActivityLog.find(filter).sort({ createdAt: -1 }).skip((page-1)*+limit).limit(+limit)
                .populate('user', 'name email').lean(),
            ActivityLog.countDocuments(filter),
        ]);
        res.json({ success: true, data: { data: logs, total, page: +page, pages: Math.ceil(total/+limit) } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getLogsMore = exports.getLogs;

exports.exportCSV = async (req, res) => {
    res.json({ success: true, message: 'CSV export — implement as needed' });
};
