'use strict';
/**
 * Seat counting for the transport fleet.
 *
 * `Vehicle.currentOccupancy` is a cached counter. Several paths move it
 * (assigning a child, suspending, cancelling) and several did not (editing an
 * assignment onto another vehicle, moving a route's vehicle, a bulk import), so
 * it drifted and the Vehicles screen showed buses that were full of nobody.
 *
 * Read screens count from live assignments with `occupancyByVehicle`; write
 * paths call `syncOccupancy` afterwards so the stored column catches up. The
 * two live here rather than in a controller because both controllers need them.
 */
const Vehicle = require('../models/Vehicle');
const TransportAssignment = require('../models/TransportAssignment');

/** Map of vehicleId → number of active assignments. */
async function occupancyByVehicle(schoolId) {
    const rows = await TransportAssignment.aggregate([
        { $match: { school: String(schoolId), status: 'active', vehicle: { $ne: null } } },
        { $group: { _id: '$vehicle', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Write the true count back onto the vehicles named (or the whole fleet).
 * Only rows whose number actually changed are written.
 */
async function syncOccupancy(schoolId, vehicleIds = null) {
    const counts = await occupancyByVehicle(schoolId);
    const q = { school: schoolId, isActive: true };
    const ids = vehicleIds ? [...new Set(vehicleIds.filter(Boolean).map(String))] : null;
    if (ids && !ids.length) return counts;
    if (ids) q._id = { $in: ids };
    const vehicles = await Vehicle.find(q).select('currentOccupancy').lean();
    await Promise.all(vehicles
        .filter((v) => (counts.get(String(v._id)) || 0) !== (v.currentOccupancy || 0))
        .map((v) => Vehicle.updateOne({ _id: v._id }, { $set: { currentOccupancy: counts.get(String(v._id)) || 0 } })));
    return counts;
}

module.exports = { occupancyByVehicle, syncOccupancy };
