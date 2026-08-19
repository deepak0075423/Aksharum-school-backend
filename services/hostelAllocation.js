'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Bed allocation engine (spec §10, §31).
//
//  Allocating, releasing and transferring a bed each move three tables — the
//  bed, the room's occupancy counter and the allocation row — plus an
//  append-only history entry. All of it runs inside ONE transaction, guarded by
//  a per-hostel advisory lock, so two wardens clicking "allocate" on the same
//  bed at the same instant cannot both win.
//
//  Two DB-level partial unique indexes are the last line of defence and hold
//  even if this code were bypassed entirely:
//    hostelbeds        unique(student) WHERE status = 'occupied'
//    hostelallocations unique(student) WHERE status IN ('pending','active')
//
//  The pre-flight validations below exist to produce a readable message before
//  the database has to say "duplicate key".
// ─────────────────────────────────────────────────────────────────────────────
const Hostel                  = require('../models/Hostel');
const HostelRoom              = require('../models/HostelRoom');
const HostelBed               = require('../models/HostelBed');
const HostelAllocation        = require('../models/HostelAllocation');
const HostelAllocationHistory = require('../models/HostelAllocationHistory');
const HostelSettings          = require('../models/HostelSettings');
const User                    = require('../models/User');
const StudentProfile          = require('../models/StudentProfile');

const { withTransaction, lock, insertRow, qi } = require('./hostelTx');
const { getSettings, genderOf } = require('./hostelService');

const BED   = qi(HostelBed.tableName);
const ROOM  = qi(HostelRoom.tableName);
const ALLOC = qi(HostelAllocation.tableName);

/** A validation failure the caller should surface as a 400, not a 500. */
class RuleError extends Error {
    constructor(message) { super(message); this.name = 'RuleError'; this.status = 400; }
}

// Room status follows occupancy unless the room is deliberately held back
// (reserved / maintenance / inactive are set by hand and never overwritten).
function roomStatusFor(occupied, capacity, current) {
    if (['maintenance', 'inactive', 'reserved'].includes(current)) return current;
    if (occupied <= 0) return 'available';
    if (occupied >= capacity) return 'full';
    return 'partially_occupied';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-flight validation (spec §10)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Everything that must hold before a bed may be given to a student. Runs outside
 * the transaction for a friendly error; the transaction re-checks the two facts
 * that can change underneath it (bed still free, student still unallocated).
 */
async function validateAllocation({ schoolId, studentId, bedId, settings, ignoreAllocationId = null }) {
    const s = settings || await getSettings(schoolId);

    const bed = await HostelBed.findOne({ _id: bedId, school: schoolId }).lean();
    if (!bed) throw new RuleError('Bed not found');
    if (!bed.isActive) throw new RuleError('This bed is inactive');
    if (bed.status === 'occupied') throw new RuleError('This bed is already occupied');
    if (bed.status === 'maintenance') throw new RuleError('This bed is under maintenance');
    if (bed.status === 'inactive') throw new RuleError('This bed is not in service');

    const [hostel, room, student, profile] = await Promise.all([
        Hostel.findOne({ _id: bed.hostel, school: schoolId }).lean(),
        HostelRoom.findOne({ _id: bed.room, school: schoolId }).lean(),
        User.findOne({ _id: studentId, school: schoolId, role: 'student' }).lean(),
        StudentProfile.findOne({ user: studentId, school: schoolId }).select('gender').lean(),
    ]);

    if (!student) throw new RuleError('Student not found in this school');
    if (!student.isActive) throw new RuleError('This student account is inactive');

    if (!hostel) throw new RuleError('Hostel not found');
    if (!hostel.isActive || hostel.status !== 'active') throw new RuleError('This hostel is not active — allocations are not allowed');

    if (!room) throw new RuleError('Room not found');
    if (!room.isActive) throw new RuleError('This room is inactive');
    if (['maintenance', 'inactive'].includes(room.status)) throw new RuleError(`This room is marked ${room.status}`);

    // Gender restriction — the room narrows the hostel when it states one.
    if (s.enforceGenderRestriction) {
        const want = String(room.gender || '') || String(hostel.gender || '');
        const have = genderOf(profile);
        if (want && !['any', 'co_ed'].includes(want)) {
            if (!have) throw new RuleError('The student has no gender on record, so the hostel gender restriction cannot be checked');
            if (have !== want) throw new RuleError(`This is a ${want} hostel — the student cannot be allocated here`);
        }
    }

    // Room capacity.
    const occupied = await HostelBed.countDocuments({ school: schoolId, room: bed.room, status: 'occupied' });
    if (!s.allowOvercapacityAllocation && occupied >= (room.capacity || 0)) {
        throw new RuleError(`Room ${room.roomNumber} is at its capacity of ${room.capacity}`);
    }
    if (s.maxRoomCapacity && (room.capacity || 0) > s.maxRoomCapacity) {
        throw new RuleError(`Room capacity ${room.capacity} exceeds the configured maximum of ${s.maxRoomCapacity}`);
    }

    // Hostel capacity.
    if (hostel.capacity) {
        const inHostel = await HostelAllocation.countDocuments({ school: schoolId, hostel: bed.hostel, status: 'active' });
        if (!s.allowOvercapacityAllocation && inHostel >= hostel.capacity) {
            throw new RuleError(`${hostel.name} is at its capacity of ${hostel.capacity}`);
        }
    }

    // One active allocation per student.
    const existing = await HostelAllocation.findOne({
        school: schoolId, student: studentId, status: { $in: ['pending', 'active'] },
    }).lean();
    if (existing && String(existing._id) !== String(ignoreAllocationId || '')) {
        throw new RuleError('This student already has an active hostel allocation — transfer them instead');
    }

    return { bed, room, hostel, student, profile };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Allocate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Give `bedId` to `studentId` and open an allocation. Atomic.
 * @returns {Promise<{allocation: object, bed: object, room: object, hostel: object}>}
 */
async function allocateBed({ schoolId, studentId, bedId, academicYearId, admissionId = null, actorId = null, actorName = '', allocationType = 'permanent', allocationMode = 'manual', fromDate = null, toDate = null, remarks = '', settings = null }) {
    const s = settings || await getSettings(schoolId);
    const { bed, room, hostel, student } = await validateAllocation({ schoolId, studentId, bedId, settings: s });

    const result = await withTransaction(async (q) => {
        await lock(q, `hostel-alloc:${bed.hostel}`);

        // Claim the bed. The WHERE clause is the race guard: if another
        // transaction took it first, this updates zero rows and we bail out.
        const claimed = await q(
            `UPDATE ${BED} SET "status" = 'occupied', "student" = $1::uuid, "allocationDate" = $2, "updatedAt" = now()
              WHERE "_id" = $3::uuid AND "school" = $4::uuid AND "status" IN ('available', 'reserved')
              RETURNING *`,
            [String(studentId), fromDate ? new Date(fromDate) : new Date(), String(bedId), String(schoolId)],
        );
        if (!claimed.rowCount) throw new RuleError('That bed was just taken by someone else — pick another');

        const allocation = await insertRow(q, HostelAllocation, {
            school: schoolId,
            student: studentId,
            academicYear: academicYearId,
            admission: admissionId,
            hostel: bed.hostel,
            building: bed.building,
            floor: bed.floor,
            room: bed.room,
            bed: bed._id,
            allocationType,
            allocationMode,
            fromDate: fromDate ? new Date(fromDate) : new Date(),
            toDate: toDate ? new Date(toDate) : null,
            status: 'active',
            presence: 'in',
            remarks,
            allocatedBy: actorId,
            createdBy: actorId,
        });

        await q(`UPDATE ${BED} SET "allocation" = $1::uuid WHERE "_id" = $2::uuid`, [allocation._id, String(bedId)]);

        // Recount rather than increment — the count stays correct even if a bed
        // was fixed up outside this path.
        const { rows: [cnt] } = await q(
            `SELECT COUNT(*)::int AS n FROM ${BED} WHERE "room" = $1::uuid AND "status" = 'occupied'`,
            [String(bed.room)],
        );
        await q(
            `UPDATE ${ROOM} SET "occupiedBeds" = $1, "status" = $2, "updatedAt" = now() WHERE "_id" = $3::uuid`,
            [cnt.n, roomStatusFor(cnt.n, room.capacity || 0, room.status), String(bed.room)],
        );

        await insertRow(q, HostelAllocationHistory, {
            school: schoolId,
            student: studentId,
            allocation: allocation._id,
            academicYear: academicYearId,
            action: 'allocated',
            toHostel: bed.hostel, toRoom: bed.room, toBed: bed._id,
            toLabel: `${hostel.name} · Room ${room.roomNumber} · Bed ${bed.bedNumber}`,
            studentName: student.name,
            reason: remarks,
            effectiveDate: fromDate ? new Date(fromDate) : new Date(),
            performedBy: actorId,
            performedByName: actorName,
        });

        return allocation;
    });

    return { allocation: result, bed, room, hostel, student };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Release / vacate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * End an allocation and free its bed. The allocation row is closed, never
 * deleted, so the occupancy history survives (spec §31).
 */
async function releaseBed({ schoolId, allocationId, actorId = null, actorName = '', reason = '', status = 'vacated', vacatedDate = null }) {
    const allocation = await HostelAllocation.findOne({ _id: allocationId, school: schoolId }).lean();
    if (!allocation) throw new RuleError('Allocation not found');
    if (!['pending', 'active'].includes(allocation.status)) throw new RuleError('This allocation is already closed');

    const [room, hostel, bed, student] = await Promise.all([
        HostelRoom.findById(allocation.room).lean(),
        Hostel.findById(allocation.hostel).lean(),
        HostelBed.findById(allocation.bed).lean(),
        User.findById(allocation.student).select('name').lean(),
    ]);

    return withTransaction(async (q) => {
        await lock(q, `hostel-alloc:${allocation.hostel}`);

        const when = vacatedDate ? new Date(vacatedDate) : new Date();
        const { rowCount } = await q(
            `UPDATE ${ALLOC} SET "status" = $1, "vacatedDate" = $2, "vacatedBy" = $3::uuid, "updatedAt" = now()
              WHERE "_id" = $4::uuid AND "status" IN ('pending', 'active')`,
            [status, when, actorId ? String(actorId) : null, String(allocationId)],
        );
        if (!rowCount) throw new RuleError('This allocation was closed by someone else');

        // Free the bed only if it is still this student's — a bed already
        // re-issued to someone else must not be reset.
        await q(
            `UPDATE ${BED} SET "status" = 'available', "student" = NULL, "allocation" = NULL,
                    "allocationDate" = NULL, "updatedAt" = now()
              WHERE "_id" = $1::uuid AND "allocation" = $2::uuid`,
            [String(allocation.bed), String(allocationId)],
        );

        const { rows: [cnt] } = await q(
            `SELECT COUNT(*)::int AS n FROM ${BED} WHERE "room" = $1::uuid AND "status" = 'occupied'`,
            [String(allocation.room)],
        );
        await q(
            `UPDATE ${ROOM} SET "occupiedBeds" = $1, "status" = $2, "updatedAt" = now() WHERE "_id" = $3::uuid`,
            [cnt.n, roomStatusFor(cnt.n, room?.capacity || 0, room?.status), String(allocation.room)],
        );

        await insertRow(q, HostelAllocationHistory, {
            school: schoolId,
            student: allocation.student,
            allocation: allocation._id,
            academicYear: allocation.academicYear,
            action: status === 'cancelled' ? 'cancelled' : 'released',
            fromHostel: allocation.hostel, fromRoom: allocation.room, fromBed: allocation.bed,
            fromLabel: `${hostel?.name || 'Hostel'} · Room ${room?.roomNumber || '?'} · Bed ${bed?.bedNumber || '?'}`,
            studentName: student?.name || '',
            reason,
            effectiveDate: when,
            performedBy: actorId,
            performedByName: actorName,
        });

        return { ...allocation, status, vacatedDate: when };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Transfer (bed / room / floor / hostel — all the same move)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Move a student from their current bed to `toBedId` in one transaction: the old
 * allocation closes as 'transferred', a new one opens, both beds and both room
 * counters settle, and one history row records the whole hop.
 */
async function transferBed({ schoolId, allocationId, toBedId, actorId = null, actorName = '', reason = '', effectiveDate = null, settings = null }) {
    const s = settings || await getSettings(schoolId);

    const current = await HostelAllocation.findOne({ _id: allocationId, school: schoolId }).lean();
    if (!current) throw new RuleError('Allocation not found');
    if (!['pending', 'active'].includes(current.status)) throw new RuleError('Only an active allocation can be transferred');
    if (String(current.bed) === String(toBedId)) throw new RuleError('The student is already in that bed');

    // The student legitimately holds an allocation right now, so it is excluded
    // from the "already allocated" check.
    const { bed: toBed, room: toRoom, hostel: toHostel, student } = await validateAllocation({
        schoolId, studentId: current.student, bedId: toBedId, settings: s, ignoreAllocationId: allocationId,
    });

    if (String(current.hostel) !== String(toBed.hostel) && !s.allowTransferBetweenHostels) {
        throw new RuleError('Transfers between hostels are switched off in hostel settings');
    }

    const [fromRoom, fromHostel, fromBed] = await Promise.all([
        HostelRoom.findById(current.room).lean(),
        Hostel.findById(current.hostel).lean(),
        HostelBed.findById(current.bed).lean(),
    ]);

    return withTransaction(async (q) => {
        // Lock both hostels in a stable order so two crossing transfers can't deadlock.
        for (const h of [String(current.hostel), String(toBed.hostel)].sort()) {
            if (h) await lock(q, `hostel-alloc:${h}`);
        }
        const when = effectiveDate ? new Date(effectiveDate) : new Date();

        // 1. Close the old allocation, freeing its bed first so the unique
        //    "one occupied bed per student" index is satisfied when the new
        //    bed is claimed below.
        const closed = await q(
            `UPDATE ${ALLOC} SET "status" = 'transferred', "vacatedDate" = $1, "vacatedBy" = $2::uuid, "updatedAt" = now()
              WHERE "_id" = $3::uuid AND "status" IN ('pending', 'active')`,
            [when, actorId ? String(actorId) : null, String(allocationId)],
        );
        if (!closed.rowCount) throw new RuleError('This allocation changed while the transfer was being prepared');

        await q(
            `UPDATE ${BED} SET "status" = 'available', "student" = NULL, "allocation" = NULL,
                    "allocationDate" = NULL, "updatedAt" = now()
              WHERE "_id" = $1::uuid AND "allocation" = $2::uuid`,
            [String(current.bed), String(allocationId)],
        );

        // 2. Claim the destination bed.
        const claimed = await q(
            `UPDATE ${BED} SET "status" = 'occupied', "student" = $1::uuid, "allocationDate" = $2, "updatedAt" = now()
              WHERE "_id" = $3::uuid AND "school" = $4::uuid AND "status" IN ('available', 'reserved')
              RETURNING *`,
            [String(current.student), when, String(toBedId), String(schoolId)],
        );
        if (!claimed.rowCount) throw new RuleError('That bed was just taken by someone else — pick another');

        // 3. Open the new allocation.
        const allocation = await insertRow(q, HostelAllocation, {
            school: schoolId,
            student: current.student,
            academicYear: current.academicYear,
            admission: current.admission,
            hostel: toBed.hostel,
            building: toBed.building,
            floor: toBed.floor,
            room: toBed.room,
            bed: toBed._id,
            allocationType: current.allocationType,
            allocationMode: 'manual',
            fromDate: when,
            toDate: current.toDate,
            status: 'active',
            presence: current.presence,
            remarks: reason,
            allocatedBy: actorId,
            createdBy: actorId,
        });
        await q(`UPDATE ${BED} SET "allocation" = $1::uuid WHERE "_id" = $2::uuid`, [allocation._id, String(toBedId)]);

        // 4. Settle both room counters.
        for (const [roomId, cap, st] of [
            [String(current.room), fromRoom?.capacity || 0, fromRoom?.status],
            [String(toBed.room),   toRoom?.capacity   || 0, toRoom?.status],
        ]) {
            const { rows: [cnt] } = await q(
                `SELECT COUNT(*)::int AS n FROM ${BED} WHERE "room" = $1::uuid AND "status" = 'occupied'`, [roomId]);
            await q(`UPDATE ${ROOM} SET "occupiedBeds" = $1, "status" = $2, "updatedAt" = now() WHERE "_id" = $3::uuid`,
                [cnt.n, roomStatusFor(cnt.n, cap, st), roomId]);
        }

        // 5. One history row describing the whole move.
        await insertRow(q, HostelAllocationHistory, {
            school: schoolId,
            student: current.student,
            allocation: allocation._id,
            academicYear: current.academicYear,
            action: 'transferred',
            fromHostel: current.hostel, fromRoom: current.room, fromBed: current.bed,
            toHostel: toBed.hostel, toRoom: toBed.room, toBed: toBed._id,
            fromLabel: `${fromHostel?.name || 'Hostel'} · Room ${fromRoom?.roomNumber || '?'} · Bed ${fromBed?.bedNumber || '?'}`,
            toLabel: `${toHostel.name} · Room ${toRoom.roomNumber} · Bed ${toBed.bedNumber}`,
            studentName: student.name,
            reason,
            effectiveDate: when,
            performedBy: actorId,
            performedByName: actorName,
        });

        return { allocation, from: { hostel: current.hostel, room: current.room, bed: current.bed }, to: { hostel: toBed.hostel, room: toBed.room, bed: toBed._id } };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reserve / maintenance (bed state changes that are not allocations)
// ─────────────────────────────────────────────────────────────────────────────
async function setBedState({ schoolId, bedId, status, actorId = null, actorName = '', remarks = '' }) {
    if (!['available', 'reserved', 'maintenance', 'inactive'].includes(status)) {
        throw new RuleError('Unsupported bed state');
    }
    const bed = await HostelBed.findOne({ _id: bedId, school: schoolId }).lean();
    if (!bed) throw new RuleError('Bed not found');
    if (bed.status === 'occupied') throw new RuleError('Release the student from this bed first');

    const room = await HostelRoom.findById(bed.room).lean();

    return withTransaction(async (q) => {
        await lock(q, `hostel-alloc:${bed.hostel}`);
        const { rowCount } = await q(
            `UPDATE ${BED} SET "status" = $1, "remarks" = $2, "updatedAt" = now()
              WHERE "_id" = $3::uuid AND "status" <> 'occupied'`,
            [status, remarks, String(bedId)],
        );
        if (!rowCount) throw new RuleError('This bed is now occupied — release it first');

        const { rows: [cnt] } = await q(
            `SELECT COUNT(*)::int AS n FROM ${BED} WHERE "room" = $1::uuid AND "status" = 'occupied'`, [String(bed.room)]);
        await q(`UPDATE ${ROOM} SET "occupiedBeds" = $1, "status" = $2, "updatedAt" = now() WHERE "_id" = $3::uuid`,
            [cnt.n, roomStatusFor(cnt.n, room?.capacity || 0, room?.status), String(bed.room)]);

        await insertRow(q, HostelAllocationHistory, {
            school: schoolId,
            student: null,
            action: status === 'reserved' ? 'reserved' : status === 'maintenance' ? 'maintenance' : 'released',
            fromBed: bed._id, fromRoom: bed.room, fromHostel: bed.hostel,
            fromLabel: `Bed ${bed.bedNumber}`,
            reason: remarks,
            performedBy: actorId,
            performedByName: actorName,
        });
        return { ...bed, status };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Automatic allocation (spec §10)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The best free bed for a student under the current rules: preferred room type
 * first, then a room that already has occupants (filling rooms beats scattering
 * students), then the lowest room number for a stable, explainable choice.
 *
 * @returns {Promise<object|null>} the bed, or null when nothing fits.
 */
async function findBestBed({ schoolId, studentId, hostelId = null, preferredRoomType = '', settings = null }) {
    const s = settings || await getSettings(schoolId);
    const profile = await StudentProfile.findOne({ user: studentId, school: schoolId }).select('gender').lean();
    const gender = genderOf(profile);

    const hostelQ = { school: schoolId, isActive: true, status: 'active' };
    if (hostelId) hostelQ._id = hostelId;
    let hostels = await Hostel.find(hostelQ).lean();
    if (s.enforceGenderRestriction && gender) {
        hostels = hostels.filter((h) => ['any', 'co_ed', gender].includes(String(h.gender || 'any')));
    }
    if (!hostels.length) return null;

    const hostelIds = hostels.map((h) => String(h._id));
    const roomQ = {
        school: schoolId,
        hostel: { $in: hostelIds },
        isActive: true,
        status: { $in: ['available', 'partially_occupied'] },
    };
    if (preferredRoomType) roomQ.roomType = preferredRoomType;

    let rooms = await HostelRoom.find(roomQ).lean();
    // Fall back to any room type when the preference cannot be met.
    if (!rooms.length && preferredRoomType) {
        delete roomQ.roomType;
        rooms = await HostelRoom.find(roomQ).lean();
    }
    if (s.enforceGenderRestriction && gender) {
        rooms = rooms.filter((r) => !r.gender || ['any', gender].includes(String(r.gender)));
    }
    if (!rooms.length) return null;

    const beds = await HostelBed.find({
        school: schoolId,
        room: { $in: rooms.map((r) => String(r._id)) },
        status: 'available',
        isActive: true,
    }).lean();
    if (!beds.length) return null;

    const roomById = Object.fromEntries(rooms.map((r) => [String(r._id), r]));
    const candidates = beds.filter((b) => {
        const r = roomById[String(b.room)];
        return r && (s.allowOvercapacityAllocation || (r.occupiedBeds || 0) < (r.capacity || 0));
    });
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
        const ra = roomById[String(a.room)]; const rb = roomById[String(b.room)];
        if (preferredRoomType) {
            const pa = ra.roomType === preferredRoomType ? 0 : 1;
            const pb = rb.roomType === preferredRoomType ? 0 : 1;
            if (pa !== pb) return pa - pb;
        }
        // Prefer a room already partly filled, then a lower room number.
        const oa = ra.occupiedBeds || 0; const ob = rb.occupiedBeds || 0;
        if (oa !== ob) return ob - oa;
        return String(ra.roomNumber).localeCompare(String(rb.roomNumber), undefined, { numeric: true });
    });
    return candidates[0];
}

module.exports = {
    RuleError, roomStatusFor,
    validateAllocation, allocateBed, releaseBed, transferBed, setBedState, findBestBed,
};
