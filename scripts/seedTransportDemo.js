'use strict';
/**
 * Demo data for the Transport module.
 *
 *   node scripts/seedTransportDemo.js                  # seed the test school
 *   node scripts/seedTransportDemo.js --school="Name"  # a different school
 *   node scripts/seedTransportDemo.js --clear          # remove ALL transport
 *                                                      # rows for that school
 *
 * Written so every admin screen has something real to show: a fleet, crew who
 * are proper staff accounts, routes with coordinates around Kolkata, a day of
 * trips with stop events and a register, money, and a few things going wrong.
 *
 * It refuses to touch a school whose name does not look like a test school
 * unless --force is given, because --clear deletes transport data outright.
 */
require('dotenv').config();
/** Minutes past midnight as "HH:MM" — a stop 63 minutes into an hour is 15:03,
 *  not "14:63", which is what the string arithmetic here used to emit. */
const hhmm = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const bcrypt = require('bcryptjs');
const db = require('./../db/orm');

const MODELS = ['School', 'User', 'StudentProfile', 'TeacherProfile', 'AcademicYear', 'Class', 'ClassSection',
    'Vehicle', 'TransportStaff', 'TransportStaffLocation', 'TransportRoute', 'TransportAssignment', 'TransportTrip',
    'VehicleLocation', 'FuelLog', 'MaintenanceRecord', 'TransportIncident', 'TransportComplaint',
    'TransportFeePlan', 'TransportFeeInvoice', 'TransportRequest', 'TransportSettings', 'TransportAuditLog',
    'TransportReport'];
MODELS.forEach((m) => { try { require(`./../models/${m}`); } catch { /* optional */ } });
const M = (n) => db.model(n);

const arg = (k, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const at = (hh, mm, dayOffset = 0) => { const d = day(dayOffset); d.setHours(hh, mm, 0, 0); return d; };
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
const pick = (a, i) => a[i % a.length];

// Real places, so the map shows a route through a city instead of a smear.
const PLACES = {
    school: { latitude: 22.5448, longitude: 88.3426 },
    south: [['Lake Gardens', 22.4972, 88.3505], ['Ballygunge', 22.5290, 88.3650], ['Gariahat', 22.5185, 88.3673],
            ['Kalighat', 22.5185, 88.3430], ['Tollygunge', 22.4954, 88.3462]],
    north: [['Shyambazar', 22.5960, 88.3720], ['Hatibagan', 22.5915, 88.3690], ['Sealdah', 22.5675, 88.3707],
            ['College Street', 22.5760, 88.3639], ['Esplanade', 22.5645, 88.3510]],
    east:  [['Salt Lake Sector V', 22.5760, 88.4330], ['Bidhannagar', 22.5900, 88.4100], ['Ultadanga', 22.5930, 88.3980],
            ['Phoolbagan', 22.5760, 88.3960], ['Park Circus', 22.5390, 88.3690]],
    west:  [['Behala', 22.4980, 88.3130], ['New Alipore', 22.5100, 88.3300], ['Taratala', 22.5170, 88.3130],
            ['Kidderpore', 22.5380, 88.3200], ['Hastings', 22.5470, 88.3320]],
    airport: [['Kaikhali', 22.6310, 88.4400], ['VIP Road', 22.6140, 88.4300], ['Lake Town', 22.6050, 88.4080],
              ['Dum Dum', 22.6200, 88.4200], ['Jessore Road', 22.6400, 88.4300]],
};

async function main() {
    await db.connect();
    const schoolName = arg('school', 'Aksharum');
    const school = await M('School').findOne({ name: new RegExp(schoolName, 'i') }).lean();
    if (!school) throw new Error(`No school matching "${schoolName}"`);
    if (!/test|demo|sample/i.test(school.name) && !has('force')) {
        throw new Error(`"${school.name}" does not look like a test school. Re-run with --force if you are sure.`);
    }
    const S = school._id;
    console.log(`school: ${school.name} (${S})\n`);

    const wipe = async () => {
        for (const n of ['TransportStaffLocation', 'TransportTrip', 'VehicleLocation', 'TransportAssignment',
            'FuelLog', 'MaintenanceRecord', 'TransportIncident', 'TransportComplaint', 'TransportFeeInvoice',
            'TransportFeePlan', 'TransportRequest', 'TransportRoute', 'TransportStaff', 'Vehicle',
            'TransportAuditLog', 'TransportReport']) {
            const r = await M(n).deleteMany({ school: S });
            console.log(`  cleared ${n}: ${r?.deletedCount ?? '—'}`);
        }
        // The staff accounts this script created are marked by department.
        const profiles = await M('TeacherProfile').find({ school: S, department: 'Transport' }).select('user').lean();
        if (profiles.length) {
            const ids = profiles.map((p) => p.user);
            await M('TeacherProfile').deleteMany({ school: S, department: 'Transport' });
            await M('User').deleteMany({ _id: { $in: ids }, school: S, role: 'teacher' });
            console.log(`  cleared transport staff accounts: ${ids.length}`);
        }
    };

    if (has('clear')) { await wipe(); console.log('\ndone — transport data removed.'); return; }
    await wipe();   // a reseed replaces, so running it twice is safe
    console.log('');

    /* ── Settings: the campus pin every map opens on ─────────────────────── */
    await M('TransportSettings').findOneAndUpdate({ school: S }, {
        $set: {
            schoolLatitude: PLACES.school.latitude, schoolLongitude: PLACES.school.longitude,
            contactEmail: 'transport@aksharum.edu.in', contactPhone: '+91 98765 43210',
            officeAddress: '123 School Road, Kolkata, West Bengal - 700029',
            mapProvider: 'osm', delayThresholdMin: 10, maxStudentsPerBus: 52,
        },
    }, { new: true, upsert: true });
    console.log('settings: campus pin set');

    /* ── Fleet ───────────────────────────────────────────────────────────── */
    const fleet = [
        ['WB-01', 'WB 01 AB 1234', 'Tata Starbus', 'bus', 52, 'active'],
        ['WB-02', 'WB 02 CD 5678', 'Ashok Leyland', 'bus', 52, 'active'],
        ['WB-03', 'WB 03 EF 9012', 'Eicher Skyline', 'mini_bus', 32, 'active'],
        ['WB-04', 'WB 04 GH 3456', 'Tata LP 909', 'bus', 48, 'active'],
        ['WB-05', 'WB 05 IJ 7890', 'Force Traveller', 'van', 17, 'active'],
        ['WB-06', 'WB 06 KL 2468', 'Mahindra Cruzio', 'mini_bus', 28, 'maintenance'],
    ];
    const vehicles = [];
    for (let i = 0; i < fleet.length; i++) {
        const [vehicleNumber, registrationNumber, busName, vehicleType, capacity, status] = fleet[i];
        vehicles.push(await M('Vehicle').create({
            school: S, vehicleNumber, registrationNumber, busName, manufacturer: busName,
            vehicleType, capacity, status, fuelType: 'diesel', mileage: 6.2 + i * 0.3,
            odometer: 11000 + i * 1800, modelYear: 2020 + (i % 4),
            engineNumber: `ENG${1000 + i}`, chassisNumber: `CHS${5000 + i}`,
            gpsDeviceId: `GPS-00${i + 1}`, purchaseDate: new Date(2021, i, 12), purchaseCost: 1850000,
            insuranceExpiry: day(40 + i * 25), fitnessExpiry: day(120 + i * 20),
            permitExpiry: day(200 + i * 15), pollutionExpiry: day(i === 2 ? -6 : 25 + i * 30),
            roadTaxExpiry: day(300),
        }));
    }
    console.log(`vehicles: ${vehicles.length}`);

    /* ── Crew, as proper staff accounts ──────────────────────────────────── */
    const CREW = [
        ['driver', 'Ravi Kumar', 'ravi.kumar', '9876543210', 'WB14 2015001234', 8],
        ['driver', 'Suresh Patil', 'suresh.patil', '9876543211', 'WB02 2014005678', 12],
        ['driver', 'Deepak Singh', 'deepak.singh', '9876543213', 'WB18 2013009876', 6],
        ['driver', 'Manoj Tiwari', 'manoj.tiwari', '9876543214', 'WB10 2017002222', 4],
        ['conductor', 'Amit Kumar', 'amit.kumar', '9876543212', '', 0],
        ['conductor', 'Rohit Jaiswal', 'rohit.jaiswal', '9876543216', '', 0],
        ['helper', 'Pankaj Kumar', 'pankaj.kumar', '9876543215', '', 0],
        ['helper', 'Sandeep Nair', 'sandeep.nair', '9876543217', '', 0],
    ];
    const password = await bcrypt.hash('Transport@123', 12);
    const crew = [];
    for (let i = 0; i < CREW.length; i++) {
        const [staffType, name, handle, phone, licenseNumber, experienceYears] = CREW[i];
        const designation = { driver: 'Driver', conductor: 'Conductor', helper: 'Crew Member' }[staffType];
        const email = `${handle}@aksharum.edu.in`;
        const user = await M('User').create({
            name, email, phone, role: 'teacher', school: S, password,
            isFirstLogin: true, isActive: true, designation,
        });
        await M('TeacherProfile').create({
            user: user._id, school: S, employeeId: `TRP${String(i + 1).padStart(3, '0')}`,
            designation, department: 'Transport', staffType: 'non_teaching',
            gender: 'male', dob: new Date(1985 + i, (i * 2) % 12, 12 + i),
            joiningDate: new Date(2021, i % 12, 5),
            currentAddress: 'Kalighat, Kolkata', currentCity: 'Kolkata',
            emergencyContactName: 'Family contact', emergencyContactPhone: `98765 1234${i}`,
        });
        crew.push(await M('TransportStaff').create({
            school: S, user: user._id, staffType, employeeId: `TRP${String(i + 1).padStart(3, '0')}`,
            name, phone, licenseNumber, licenseType: staffType === 'driver' ? 'HMV' : '',
            licenseExpiry: staffType === 'driver' ? day(400 + i * 40) : null,
            medicalCertExpiry: day(i === 7 ? -10 : 180 + i * 30),
            experienceYears, status: i === 2 ? 'on_leave' : 'active',
            policeVerification: { status: 'verified', date: new Date(2024, 3, 2) },
            emergencyContact: { name: 'Family contact', phone: `98765 1234${i}`, relation: 'Spouse' },
            locationSharing: i < 3,
            leaves: i === 2 ? [{ fromDate: day(-1), toDate: day(2), leaveType: 'sick', reason: 'Fever', status: 'approved' }] : [],
        }));
    }
    console.log(`crew: ${crew.length} (staff accounts created; one-time password "Transport@123")`);

    // A live position for the three who are sharing.
    for (let i = 0; i < 3; i++) {
        const base = pick([PLACES.south, PLACES.north, PLACES.east], i)[i % 5];
        const point = { latitude: base[1] + 0.004, longitude: base[2] + 0.004 };
        for (let k = 8; k >= 0; k--) {
            await M('TransportStaffLocation').create({
                school: S, staff: crew[i]._id, user: crew[i].user,
                latitude: point.latitude - k * 0.0025, longitude: point.longitude - k * 0.003,
                speed: 18 + k, accuracy: 9 + k, source: 'device', recordedAt: hoursAgo(k * 0.25),
            });
        }
        await M('TransportStaff').updateOne({ _id: crew[i]._id }, {
            $set: { lastLocation: { ...point, accuracy: 11, speed: 26, source: 'device', at: hoursAgo(i === 2 ? 4 : 0.05) } },
        });
    }

    /* ── Routes ──────────────────────────────────────────────────────────── */
    const ROUTES = [
        ['R1', 'South Zone', 'South Kolkata', '#2563eb', PLACES.south, 'both', 'active'],
        ['R2', 'North Zone', 'North Kolkata', '#16a34a', PLACES.north, 'both', 'active'],
        ['R3', 'East Zone', 'East Kolkata', '#d97706', PLACES.east, 'morning', 'active'],
        ['R4', 'West Zone', 'West Kolkata', '#7c3aed', PLACES.west, 'both', 'active'],
        ['R5', 'Airport Route', 'Airport', '#dc2626', PLACES.airport, 'both', 'maintenance'],
    ];
    const routes = [];
    for (let i = 0; i < ROUTES.length; i++) {
        const [code, name, zone, color, places, shift, status] = ROUTES[i];
        routes.push(await M('TransportRoute').create({
            school: S, routeCode: code, name, zone, color, shift, status, routeType: 'regular',
            description: `Covers ${zone} — ${places.slice(0, 3).map((p) => p[0]).join(', ')} and nearby areas.`,
            vehicle: vehicles[i]._id,
            driver: crew[i % 4]._id,
            attendant: crew[4 + (i % 4)]._id,
            startPoint: places[0][0], endPoint: 'School',
            distanceKm: 14 + i * 2.4, estimatedDurationMin: 55 + i * 6, geofenceRadiusM: 200,
            schedule: { morningStart: '07:00', morningEnd: '08:05', eveningStart: '14:30', eveningEnd: '15:40' },
            stops: places.map(([nm, lat, lng], j) => ({
                name: nm, sequence: j + 1, latitude: lat, longitude: lng,
                arrivalTime: hhmm(7 * 60 + j * 12),
                eveningTime: hhmm(14 * 60 + 30 + j * 11),
                distanceFromStart: +(j * 3.2).toFixed(1), landmark: `${nm} crossing`,
            })),
        }));
    }
    console.log(`routes: ${routes.length}`);

    /* ── Fee plans ───────────────────────────────────────────────────────── */
    const plans = [];
    for (let i = 0; i < 4; i++) {
        plans.push(await M('TransportFeePlan').create({
            school: S, name: `${ROUTES[i][0]} - ${ROUTES[i][1]}`, basis: 'route', frequency: 'monthly',
            amount: 2500 - i * 200, route: routes[i]._id, zoneLabel: ROUTES[i][2],
            vehicleType: i === 2 ? 'mini_bus' : 'bus',
            approvalStatus: i === 3 ? 'pending' : 'approved',
            renewalDate: day(12 + i * 5), effectiveFrom: day(-120),
            description: `Monthly transport fee for ${ROUTES[i][2]}.`,
        }));
    }
    console.log(`fee plans: ${plans.length}`);

    /* ── Students on routes ──────────────────────────────────────────────── */
    const students = await M('User').find({ school: S, role: 'student', isActive: true }).select('name').lean();
    const assignments = [];
    for (let i = 0; i < students.length; i++) {
        const route = routes[i % 4];
        assignments.push(await M('TransportAssignment').create({
            school: S, student: students[i]._id, route: route._id, vehicle: route.vehicle,
            pickupStop: route.stops[i % route.stops.length]._id,
            dropStop: route.stops[i % route.stops.length]._id,
            seatNumber: `${10 + i}A`, shift: 'both', feePlan: plans[i % plans.length]._id,
            status: 'active', effectiveDate: day(-90),
        }));
    }
    console.log(`assignments: ${assignments.length} (the school has ${students.length} students)`);

    /* ── Today's trips ───────────────────────────────────────────────────── */
    let tripSeq = 0;
    const trips = [];
    for (const route of routes.filter((r) => r.status === 'active')) {
        for (const shift of (route.shift === 'both' ? ['morning', 'evening'] : [route.shift])) {
            const direction = shift === 'morning' ? 'pickup' : 'drop';
            const mine = assignments.filter((a) => String(a.route) === String(route._id));
            const done = shift === 'morning';
            const late = route.routeCode === 'R3';
            tripSeq++;
            const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
            trips.push(await M('TransportTrip').create({
                school: S, tripCode: `TRP-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(tripSeq).padStart(4, '0')}`,
                route: route._id, vehicle: route.vehicle, driver: route.driver, attendant: route.attendant,
                date: day(0), shift, direction, tripType: 'regular',
                status: late ? 'started' : done ? 'completed' : 'scheduled',
                startTime: (done || late) ? at(7, 0) : null, endTime: (done && !late) ? at(8, 5) : null,
                delayMinutes: late ? 18 : (done && route.routeCode === 'R2' ? 12 : 0),
                stopEvents: stops.map((s, j) => ({
                    stop: s._id, name: s.name, sequence: s.sequence,
                    plannedTime: shift === 'morning' ? s.arrivalTime : s.eveningTime,
                    status: done ? 'reached' : 'pending',
                    reachedAt: done ? at(7, j * 12 + (late ? 12 : 0)) : null,
                    latitude: s.latitude, longitude: s.longitude,
                })),
                studentAttendance: mine.map((a) => ({
                    student: a.student, assignment: a._id,
                    stop: direction === 'pickup' ? a.pickupStop : a.dropStop,
                    status: done ? 'boarded' : 'pending',
                    method: done ? 'manual' : '', boardTime: done ? at(7, 15) : null,
                })),
                lastLocation: done ? {} : { latitude: route.stops[1].latitude, longitude: route.stops[1].longitude, speed: 28, updatedAt: hoursAgo(0.05) },
            }));
        }
    }
    // A bus on the road right now, so the live map has something moving.
    if (trips.length > 2) {
        await M('TransportTrip').updateOne({ _id: trips[2]._id }, { $set: { status: 'started', startTime: hoursAgo(0.6) } });
        await M('VehicleLocation').create({
            school: S, vehicle: trips[2].vehicle, trip: trips[2]._id,
            latitude: PLACES.north[2][1], longitude: PLACES.north[2][2], speed: 31, heading: 120,
        });
    }
    console.log(`trips: ${trips.length}`);

    /* ── Fuel, maintenance, incidents, complaints, requests ──────────────── */
    const stations = ['IOCL, Kalighat', 'BPCL, Tollygunge', 'HP, Gariahat', 'IOCL, Park Circus', 'BPCL, EM Bypass'];
    for (let i = 0; i < 14; i++) {
        const v = vehicles[i % vehicles.length];
        const litres = 42 + (i % 5) * 6;
        await M('FuelLog').create({
            school: S, vehicle: v._id, driver: crew[i % 4]._id, date: hoursAgo(i * 48 + 4),
            litres, pricePerLitre: 90, totalCost: litres * 90,
            odometer: v.odometer - (13 - i) * 320, previousOdometer: v.odometer - (14 - i) * 320,
            // One vehicle is left thirsty on purpose, so the Fuel screen's
            // low-mileage alert has a real row to show.
            distance: i % 6 === 3 ? 180 : 320, mileage: +((i % 6 === 3 ? 180 : 320) / litres).toFixed(2),
            vendor: pick(stations, i), receipt: `BILL${4000 + i}`, fuelType: 'diesel',
        });
    }
    const jobs = [
        ['Routine Service', 'service', 'completed', -12, -12, 5400],
        ['Tyre Replacement', 'tyres', 'completed', -9, -9, 18600],
        ['Brake Service', 'brakes', 'scheduled', -3, null, 0],
        ['AC Repair', 'ac', 'scheduled', -1, null, 0],
        ['General Checkup', 'service', 'scheduled', 4, null, 0],
        ['Engine Service', 'engine', 'in_progress', 0, null, 0],
    ];
    for (let i = 0; i < jobs.length; i++) {
        const [title, category, status, sched, done, cost] = jobs[i];
        await M('MaintenanceRecord').create({
            school: S, vehicle: vehicles[i % vehicles.length]._id, title, category,
            maintenanceType: category === 'service' ? 'preventive' : 'corrective',
            scheduledDate: day(sched), completedDate: done == null ? null : day(done),
            status, cost, odometer: 12000 + i * 900, vendor: 'Kolkata Motors',
            description: `${title} for the fleet.`, nextDueDate: day(sched + 90),
        });
    }
    const incidents = [
        ['breakdown', 'minor', 'Engine overheated during the morning trip. Students moved to a backup bus.', 'Gariahat', 'reported', 0],
        ['delay', 'minor', 'Heavy traffic on EM Bypass held the bus for 20 minutes.', 'Park Circus', 'resolved', 0],
        ['accident', 'minor', 'Minor collision with a two-wheeler at the crossing. No injuries.', 'Kalighat', 'resolved', 0],
        ['behavior', 'minor', 'Two students were standing while the bus was moving; spoken to.', 'Tollygunge', 'resolved', 0],
        ['route_deviation', 'minor', 'Driver took an alternate route because of a road closure.', 'Behala', 'investigating', 0],
    ];
    for (let i = 0; i < incidents.length; i++) {
        const [type, severity, description, place, status, injuredCount] = incidents[i];
        const coords = Object.values(PLACES).flat().find((p) => Array.isArray(p) && p[0] === place);
        await M('TransportIncident').create({
            school: S, incidentCode: `INC-${String(i + 1).padStart(4, '0')}`,
            vehicle: vehicles[i % vehicles.length]._id, driver: crew[i % 4]._id,
            date: hoursAgo(i * 36 + 6), type, severity, description, status, injuredCount,
            location: { address: place, latitude: coords ? coords[1] : null, longitude: coords ? coords[2] : null },
            repairCost: type === 'accident' ? 8500 : 0,
            resolvedAt: status === 'resolved' ? hoursAgo(i * 30) : null,
        });
    }
    const raiser = (await M('User').findOne({ school: S, role: 'parent' }).lean())
        || (await M('User').findOne({ school: S, role: 'school_admin' }).lean());
    const complaints = [
        ['late_bus', 'Bus arrived 20 minutes late', 'open', null],
        ['driver_behavior', 'Driver was abrupt with a student', 'in_progress', null],
        ['bus_condition', 'AC was not working in the afternoon', 'resolved', 4],
        ['safety', 'Bus was overcrowded in the morning', 'resolved', 5],
        ['route_deviation', 'Bus took a different route without notice', 'closed', 4],
    ];
    for (let i = 0; i < complaints.length; i++) {
        const [category, subject, status, rating] = complaints[i];
        await M('TransportComplaint').create({
            school: S, complaintCode: `CMP-${String(i + 1).padStart(4, '0')}`,
            raisedBy: raiser?._id, raisedByRole: raiser?.role || 'parent',
            category, subject, description: `${subject}. Reported by a family on ${ROUTES[i % 5][1]}.`,
            route: routes[i % routes.length]._id, vehicle: vehicles[i % vehicles.length]._id,
            status, rating, priority: i === 0 ? 'high' : 'medium',
            resolvedAt: ['resolved', 'closed'].includes(status) ? hoursAgo(i * 20) : null,
            timeline: [{ action: 'created', note: subject, at: hoursAgo(i * 26 + 10) }],
            createdAt: hoursAgo(i * 26 + 10),
        });
    }
    if (students.length) {
        const kinds = ['pickup_change', 'leave_request', 'drop_change', 'special_trip', 'route_change'];
        for (let i = 0; i < 5; i++) {
            await M('TransportRequest').create({
                school: S, requestCode: `REQ-${String(i + 1).padStart(4, '0')}`,
                requestedBy: raiser?._id, student: students[i % students.length]._id,
                requestType: kinds[i], status: ['pending', 'approved', 'pending', 'rejected', 'approved'][i],
                requiresAction: i === 0,
                details: {
                    route: routes[i % routes.length]._id,
                    fromDate: day(i + 1), reason: ['Moving house', 'Medical', 'Grandparents', 'Inter-school event', 'New address'][i],
                },
                createdAt: hoursAgo(i * 22 + 5),
            });
        }
    }
    console.log('fuel: 14 · maintenance: 6 · incidents: 5 · complaints: 5 · requests: 5');

    /* ── Invoices ────────────────────────────────────────────────────────── */
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let inv = 0;
    for (let back = 2; back >= 0; back--) {
        const when = new Date(); when.setMonth(when.getMonth() - back);
        for (let i = 0; i < assignments.length; i++) {
            const a = assignments[i];
            const plan = plans.find((p) => String(p._id) === String(a.feePlan)) || plans[0];
            inv++;
            const row = new (M('TransportFeeInvoice'))({
                school: S, invoiceNumber: `TF-${String(inv).padStart(4, '0')}`,
                student: a.student, assignment: a._id, feePlan: plan._id, route: a.route,
                period: { month: when.getMonth() + 1, year: when.getFullYear(), label: `${MONTHS[when.getMonth()]} ${when.getFullYear()}` },
                amount: plan.amount, dueDate: new Date(when.getFullYear(), when.getMonth(), 10),
                createdAt: new Date(when.getFullYear(), when.getMonth(), 1),
            });
            // Older months paid, this month a mix.
            if (back > 0 || i % 3 === 0) {
                row.payments = [{ amount: plan.amount, mode: 'upi', reference: `UPI${9000 + inv}`,
                    receiptNumber: `TRC-${String(inv).padStart(4, '0')}`, paidAt: new Date(when.getFullYear(), when.getMonth(), 6) }];
            }
            await row.save();
        }
    }
    console.log(`invoices: ${inv}`);

    console.log('\ndone. Every transport screen now has data.');
    console.log('Crew sign-in: <first.last>@aksharum.edu.in / Transport@123');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
