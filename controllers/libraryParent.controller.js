'use strict';
const LibraryIssuance    = require('../models/LibraryIssuance');
const LibraryFine        = require('../models/LibraryFine');
const LibraryReservation = require('../models/LibraryReservation');
const ParentProfile      = require('../models/ParentProfile');

exports.getOverview = async (req, res) => {
    try {
        const parent = await ParentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        const childIds = parent?.children || [];
        if (!childIds.length) return res.json({ success: true, data: { children: [] } });

        const result = await Promise.all(childIds.map(async childId => {
            const [issuances, fines, reservations] = await Promise.all([
                LibraryIssuance.find({ school: req.schoolId, issuedTo: childId, status: 'issued' })
                    .populate('book', 'title isbn')
                    .lean(),
                LibraryFine.find({ school: req.schoolId, user: childId, status: 'pending' }).lean(),
                LibraryReservation.find({ school: req.schoolId, reservedBy: childId, status: { $in: ['pending','ready'] } })
                    .populate('book', 'title')
                    .lean(),
            ]);
            return { childId, issuances, fines, reservations };
        }));

        res.json({ success: true, data: { children: result } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
