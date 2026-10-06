'use strict';
/**
 * Demo data for the Medical Room — every screen with something real on it.
 *
 *   node scripts/seedMedicalDemo.js            # (re)build "Aksharum Public School (Medical Demo)"
 *   node scripts/seedMedicalDemo.js --clear    # remove it and everything it holds
 *
 * Everything is written through the module's own services (services/medical*)
 * — the calls the screens make — so the stock ledger balances, the doses are
 * real doses, the audit trail and the notifications are the ones a school
 * would see. Past visits are back-dated after they are made.
 *
 * Logins (password MedicalDemo@123):
 *   admin@medicaldemo.test           school admin
 *   mary.joseph@medicaldemo.test     the school nurse (designation "Nurse" → Medical admin)
 *   priya.sharma@medicaldemo.test    class teacher of VIII-B (Aarav's class)
 *   aarav.sharma@medicaldemo.test    a student with a life-threatening allergy and asthma
 *   rahul.sharma@medicaldemo.test    parent of Aarav and Ananya
 *
 * Nothing it writes touches any other school.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db/orm');
const { query, end } = require('../db/pool');

for (const file of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
    if (file.endsWith('.js')) require(path.join(__dirname, '..', 'models', file));
}
const M = (n) => db.model(n);
const has = (k) => process.argv.includes(`--${k}`);

const NAME = 'Aksharum Public School (Medical Demo)';
const DOMAIN = 'medicaldemo.test';
const PASSWORD = 'MedicalDemo@123';
const UPLOADS = path.join(__dirname, '..', 'uploads', 'medical-docs');

let seed = 20261004;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysFrom = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); };
/** A local instant n days ago at hh:mm. */
const at = (n, hh, mm) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(hh, mm, 0, 0); return d; };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

async function clear() {
    const { rows } = await query('SELECT "_id" FROM "schools" WHERE "name" = $1', [NAME]);
    for (const { _id } of rows) {
        const S = String(_id);
        const { rows: docs } = await query('SELECT "storedName" FROM "medicaldocuments" WHERE "school" = $1', [S]).catch(() => ({ rows: [] }));
        for (const d of docs) fs.rmSync(path.join(UPLOADS, path.basename(d.storedName)), { force: true });
        const { rows: tables } = await query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'school' AND table_schema = 'public'`);
        for (const { table_name: t } of tables) await query(`DELETE FROM "${t}" WHERE "school" = $1`, [S]).catch(() => {});
        await query('DELETE FROM "schools" WHERE "_id" = $1', [S]);
        console.log(`  removed ${NAME} (${S})`);
    }
}

/** A one-page PDF that says what it is, for the demo documents. */
function pdfFile(title, lines) {
    fs.mkdirSync(UPLOADS, { recursive: true });
    const text = [title, '', ...lines, '', 'Demo document — Aksharum Medical Room'].map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 60 ${740 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const name = `${Date.now()}-${Math.round(rnd() * 1e9)}.pdf`;
    fs.writeFileSync(path.join(UPLOADS, name), out);
    return { path: path.join(UPLOADS, name), filename: name, originalname: `${title}.pdf`, mimetype: 'application/pdf', size: out.length };
}

async function main() {
    await db.connect();
    await clear();
    if (has('clear')) { console.log('done (cleared)'); return; }
    const password = await bcrypt.hash(PASSWORD, 10);

    const school = await M('School').create({
        name: NAME, code: 'APM', email: `office@${DOMAIN}`, phone: '+91 20 2543 1100', address: '12, MG Road, Kothrud', city: 'Pune', state: 'Maharashtra',
        board: 'CBSE', isActive: true, modules: { medical: true, notification: true, attendance: true, holiday: true, document: true },
    });
    const S = String(school._id);
    console.log(`school: ${NAME} (${S})`);

    const used = new Set();
    const emailOf = (name) => {
        const base = name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
        let e = `${base}@${DOMAIN}`; let n = 2;
        while (used.has(e)) { e = `${base}.${n}@${DOMAIN}`; n += 1; }
        used.add(e); return e;
    };
    const person = (role, name, extra = {}) => M('User').create({ school: S, role, name, password, isActive: true, isFirstLogin: false, email: emailOf(name), ...extra });

    const admin = await person('school_admin', 'Office Admin', { email: `admin@${DOMAIN}`, phone: '+91 98200 10001' });
    used.add(`admin@${DOMAIN}`);
    const nurse = await person('teacher', 'Mary Joseph', { phone: '+91 98200 10012' });
    await M('TeacherProfile').create({ user: nurse._id, school: S, designation: 'Nurse', department: 'Medical Room', staffType: 'non_teaching', employeeId: 'EMP3012', gender: 'Female' });
    const teachers = {};
    for (const [n, g] of [['Priya Sharma', 'Female'], ['Rakesh Iyer', 'Male'], ['Neha Kapoor', 'Female'], ['Sanjay Deshmukh', 'Male'], ['Farah Khan', 'Female'], ['Vivek Menon', 'Male']]) {
        teachers[n] = await person('teacher', n, { phone: `+91 98500 1${String(Object.keys(teachers).length).padStart(4, '0')}` });
        await M('TeacherProfile').create({ user: teachers[n]._id, school: S, designation: 'Teacher', staffType: 'teaching', gender: g });
    }
    await M('Designation').create({ school: S, name: 'Nurse', permissions: { medical: 'admin', attendance: 'user', leave: 'user', payroll: 'user', holiday: 'user', notification: 'user', document: 'user' }, isActive: true, description: 'Runs the medical room: visits, first aid, medicines and health records' }).catch(() => {});
    await M('Designation').create({ school: S, name: 'Teacher', permissions: { medical: 'user', attendance: 'user', notification: 'user', holiday: 'user', document: 'user', leave: 'user' }, isActive: true }).catch(() => {});

    const year = await M('AcademicYear').create({ school: S, yearName: '2026-27', startDate: new Date('2026-04-01T00:00:00Z'), endDate: new Date('2027-03-31T00:00:00Z'), status: 'active' });
    const classTeacher = { '8B': 'Priya Sharma', '6A': 'Neha Kapoor', '7A': 'Rakesh Iyer', '9A': 'Sanjay Deshmukh', '10A': 'Farah Khan', '8A': 'Vivek Menon' };
    const secs = {};
    for (const n of [6, 7, 8, 9, 10]) {
        const c = await M('Class').create({ school: S, academicYear: year._id, classNumber: n, className: `Class ${ROMAN[n]}` });
        for (const sn of ['A', 'B']) {
            const ct = classTeacher[`${n}${sn}`];
            secs[`${n}${sn}`] = { cls: c, doc: await M('ClassSection').create({ school: S, class: c._id, academicYear: year._id, sectionName: sn, maxStudents: 40, classTeacher: ct ? teachers[ct]._id : null }), students: [] };
        }
    }

    const NAMES = [
        ['Aarav Sharma', 'm', '8B', 'B+'], ['Ananya Sharma', 'f', '6A', 'O+'], ['Diya Iyer', 'f', '8B', 'A+'], ['Kabir Nair', 'm', '8B', 'O-'], ['Ira Menon', 'f', '9A', 'AB+'],
        ['Rohan Kulkarni', 'm', '8B', 'B+'], ['Myra Patel', 'f', '7A', 'A-'], ['Vihaan Rao', 'm', '8B', 'O+'], ['Saanvi Joshi', 'f', '8A', 'B-'], ['Arjun Gupta', 'm', '10A', 'A+'],
        ['Kiara Bose', 'f', '8B', 'O+'], ['Ishaan Reddy', 'm', '7B', 'B+'], ['Navya Kapoor', 'f', '9B', ''], ['Dhruv Chopra', 'm', '6B', 'A+'], ['Tara Pillai', 'f', '10B', 'O+'],
        ['Krish Sethi', 'm', '7A', 'AB-'], ['Meera Jain', 'f', '9A', 'B+'], ['Advik Verma', 'm', '6A', ''], ['Avni Deshpande', 'f', '10A', 'A+'], ['Reyansh Mehta', 'm', '8A', 'O+'],
        ['Zara Khan', 'f', '7B', 'B+'], ['Laksh Bose', 'm', '9B', 'A-'], ['Siya Rao', 'f', '6B', 'O+'], ['Om Kulkarni', 'm', '10B', 'B+'],
    ];
    const S2 = {};
    const parents = {};
    let adm = 0;
    for (const [name, g, sec, blood] of NAMES) {
        adm += 1;
        const u = await person('student', name);
        S2[name] = u;
        secs[sec].students.push(u._id);
        const surname = name.split(' ')[1];
        let parent = null;
        if (surname === 'Sharma') parent = parents.Sharma || (parents.Sharma = await person('parent', 'Rahul Sharma', { phone: '+91 98220 41234' }));
        else if (['Vihaan Rao', 'Diya Iyer', 'Kabir Nair', 'Ira Menon'].includes(name)) parent = await person('parent', `${pick(['Rajesh', 'Amit', 'Sunil', 'Vikas'])} ${surname}`, { phone: `+91 97${String(10000000 + adm * 7919).slice(-8)}` });
        await M('StudentProfile').create({
            user: u._id, school: S, currentClass: secs[sec].cls._id, currentSection: secs[sec].doc._id, admissionNumber: `APM${String(2016 + (adm % 8))}${String(adm).padStart(3, '0')}`,
            rollNumber: String(secs[sec].students.length), bloodGroup: blood, dob: new Date(Date.UTC(2026 - Number(sec.replace(/\D/g, '')) - 6, adm % 12, 3 + (adm % 25))),
            gender: g === 'f' ? 'Female' : 'Male', parent: parent?._id || null,
            emergencyContactName: name === 'Aarav Sharma' ? 'Raj Malhotra' : '', emergencyContactPhone: name === 'Aarav Sharma' ? '+91 98220 77881' : '', emergencyContactRelation: name === 'Aarav Sharma' ? 'Uncle' : '',
        });
        if (parent) {
            const pp = await M('ParentProfile').findOne({ user: parent._id }).lean();
            if (pp) await M('ParentProfile').updateOne({ _id: pp._id }, { $set: { children: [...(pp.children || []), u._id] } });
            else {
                await M('ParentProfile').create({
                    user: parent._id, school: S, relationship: 'Father', children: [u._id],
                    father: { name: parent.name, phone: parent.phone }, mother: { name: surname === 'Sharma' ? 'Sunita Sharma' : `Pooja ${surname}`, phone: `+91 98111 ${String(40000 + adm * 37).slice(-5)}` },
                });
            }
        }
    }
    for (const s of Object.values(secs)) await M('ClassSection').updateOne({ _id: s.doc._id }, { $set: { enrolledStudents: s.students, currentCount: s.students.length } });

    // The services, as the nurse.
    const ctx = { schoolId: S, userId: String(nurse._id), userRole: 'teacher', user: { name: 'Mary Joseph' }, headers: {}, ip: '127.0.0.1' };
    const tctx = (n) => ({ schoolId: S, userId: String(teachers[n]._id), userRole: 'teacher', user: { name: n }, headers: {}, ip: '127.0.0.1' });
    const pctx = { schoolId: S, userId: String(parents.Sharma._id), userRole: 'parent', user: { name: 'Rahul Sharma' }, headers: {}, ip: '127.0.0.1' };
    const settings = require('../services/medicalSettings');
    const cases = require('../services/medicalCase');
    const health = require('../services/medicalHealth');
    const meds = require('../services/medicalMeds');
    const equip = require('../services/medicalEquipment');
    const id = (n) => String(S2[n]._id);

    await settings.save(S, { roomName: 'Medical Room', roomLocation: 'Ground floor, next to the main office', roomPhone: '+91 20 2543 1199 (ext. 12)', roomHours: '7:45 AM – 3:30 PM' }, ctx.userId);
    const beds = {};
    for (const [label, kind] of [['Bed 1', 'bed'], ['Bed 2', 'bed'], ['Rest area A', 'rest_area'], ['Isolation', 'isolation']]) beds[label] = await cases.saveBed(ctx, null, { label, kind });

    /* Stock: medicines and supplies, some low, some expiring, one expired on the shelf. */
    const item = async (kind, body, batches) => {
        const it = await meds.createItem(ctx, { kind, ...body });
        for (const b of batches) await meds.stockIn(ctx, it._id, b);
        return it;
    };
    const I = {};
    I.pcm = await item('medicine', { name: 'Paracetamol', genericName: 'Acetaminophen', strength: '500 mg', form: 'Tablet', unit: 'tablet', category: 'Pain relief / Fever', minStock: 50, storageLocation: 'Cabinet A, shelf 1', supplier: 'Pune Medical Agencies' },
        [{ quantity: 120, batchNumber: 'PCM2611', expiryDate: daysFrom(420), unitCost: 1.2 }, { quantity: 30, batchNumber: 'PCM2604', expiryDate: daysFrom(40), unitCost: 1.1 }]);
    I.cet = await item('medicine', { name: 'Cetirizine', strength: '10 mg', form: 'Tablet', unit: 'tablet', category: 'Antihistamine', minStock: 20, storageLocation: 'Cabinet A, shelf 1' },
        [{ quantity: 14, batchNumber: 'CTZ2609', expiryDate: daysFrom(300), unitCost: 2 }]);
    I.ors = await item('medicine', { name: 'ORS', strength: '21.8 g', form: 'Sachet', unit: 'sachet', category: 'Oral rehydration', minStock: 30, storageLocation: 'Cabinet B' },
        [{ quantity: 60, batchNumber: 'ORS2608', expiryDate: daysFrom(500), unitCost: 6 }]);
    I.salb = await item('medicine', { name: 'Salbutamol inhaler', strength: '100 mcg', form: 'Inhaler', unit: 'inhaler', category: 'Inhaler / Respiratory', minStock: 2, storageLocation: 'Emergency shelf' },
        [{ quantity: 3, batchNumber: 'SAL2605', expiryDate: daysFrom(260), unitCost: 140 }]);
    I.antacid = await item('medicine', { name: 'Antacid syrup', form: 'Syrup', unit: 'bottle', category: 'Antacid / Digestive', minStock: 2, storageLocation: 'Cabinet B' },
        [{ quantity: 4, batchNumber: 'ANT2610', expiryDate: daysFrom(330), unitCost: 85 }]);
    I.adr = await item('medicine', { name: 'Adrenaline auto-injector', strength: '0.3 mg', form: 'Injection', unit: 'pen', category: 'Emergency (Adrenaline)', minStock: 2, prescriptionOnly: true, storageLocation: 'Emergency shelf (red box)' },
        [{ quantity: 2, batchNumber: 'EPI2603', expiryDate: daysFrom(200), unitCost: 3200 }]);
    I.ibu = await item('medicine', { name: 'Ibuprofen', strength: '200 mg', form: 'Tablet', unit: 'tablet', category: 'Pain relief / Fever', minStock: 20, storageLocation: 'Cabinet A, shelf 2' },
        [{ quantity: 10, batchNumber: 'IBU2602', expiryDate: daysFrom(25), unitCost: 1.5 }]);
    I.calamine = await item('medicine', { name: 'Calamine lotion', form: 'Cream / Ointment', unit: 'bottle', category: 'Ointment / Cream', minStock: 1, storageLocation: 'Cabinet B' },
        [{ quantity: 2, batchNumber: 'CAL2511', expiryDate: daysFrom(15), unitCost: 95 }]);
    // An old antacid batch left on the shelf past its date — written straight in, as
    // stock-in rightly refuses an expired batch.
    await query(`INSERT INTO "medicalbatches" ("_id","school","item","batchNumber","quantity","received","status","expiryDate","unitCost","createdAt","updatedAt")
                 VALUES (gen_random_uuid(),$1,$2,'ANT2508',1,1,'active',$3,80, now() - interval '200 days', now())`, [S, String(I.antacid._id), new Date(`${daysFrom(-10)}T00:00:00Z`)]);
    await require('../services/medicalStock').retotal(query, I.antacid._id);
    await query(`INSERT INTO "medicalstockmoves" ("_id","school","item","batch","kind","type","quantity","itemBalance","batchBalance","reason","refKind","by","byName","createdAt")
                 SELECT gen_random_uuid(), $1, $2, b."_id", 'medicine', 'stock_in', 1, 5, 1, 'Opening stock', 'batch', $3, 'Mary Joseph', now() - interval '200 days'
                   FROM "medicalbatches" b WHERE b."batchNumber" = 'ANT2508' AND b."school" = $1`, [S, String(I.antacid._id), ctx.userId]);

    const sup = {};
    for (const [key, name, unit, min, qty, cat] of [
        ['crepe', 'Crepe bandage 10 cm', 'roll', 5, 18, 'Bandage'], ['gauze', 'Sterile gauze pads', 'pack', 20, 85, 'Gauze'], ['cotton', 'Cotton roll', 'roll', 3, 6, 'Cotton'],
        ['antiseptic', 'Antiseptic solution', 'bottle', 2, 4, 'Antiseptic'], ['ice', 'Instant ice pack', 'piece', 5, 4, 'Ice pack'], ['plaster', 'Adhesive plasters', 'piece', 50, 240, 'Plaster / Tape'],
        ['gloves', 'Disposable gloves', 'pair', 50, 160, 'Gloves'], ['triangle', 'Triangular bandage', 'piece', 4, 8, 'Bandage'],
    ]) {
        sup[key] = await item('supply', { name, unit, minStock: min, category: cat, storageLocation: 'First-aid cupboard' }, [{ quantity: qty, batchNumber: `${key.toUpperCase().slice(0, 3)}-26`, expiryDate: ['antiseptic', 'gauze'].includes(key) ? daysFrom(380) : undefined }]);
    }

    for (const [name, type, extra] of [
        ['Digital thermometer', 'thermometer', { quantity: 3, condition: 'good', lastMaintenanceOn: daysFrom(-60), nextMaintenanceOn: daysFrom(120) }],
        ['BP monitor (Omron)', 'bp_monitor', { serialNumber: 'OMR-HEM7120-5531', condition: 'good', lastMaintenanceOn: daysFrom(-170), nextMaintenanceOn: daysFrom(10) }],
        ['Pulse oximeter', 'pulse_oximeter', { serialNumber: 'POX-88231', condition: 'fair', nextMaintenanceOn: daysFrom(5) }],
        ['Weighing scale', 'weighing_machine', { serialNumber: 'WS-2020-14', condition: 'fair', lastMaintenanceOn: daysFrom(-400), nextMaintenanceOn: daysFrom(-35) }],
        ['Wheelchair', 'wheelchair', { condition: 'good' }], ['Folding stretcher', 'stretcher', { condition: 'good', location: 'Corridor store, ground floor' }],
        ['Nebulizer', 'nebulizer', { serialNumber: 'NEB-4410', condition: 'good', nextMaintenanceOn: daysFrom(90) }],
        ['First-aid box (sports)', 'first_aid_box', { quantity: 4, location: 'Sports room', condition: 'good' }], ['Glucometer', 'glucometer', { serialNumber: 'GLU-7781', condition: 'good' }],
    ]) await equip.create(ctx, { name, type, location: 'Medical Room', purchaseDate: daysFrom(-700), ...extra });

    /* Health records. */
    const prof = (n, body) => health.saveProfile(ctx, id(n), body);
    await prof('Aarav Sharma', { heightCm: 152, weightKg: 44, dietaryRestrictions: 'No peanuts or tree nuts in any form', instructions: 'Carries an inhaler in his school bag. If he is wheezing, let him use it and send him to the Medical Room.',
        emergencyMedication: { required: true, name: 'Adrenaline auto-injector 0.3 mg', location: 'School bag (front pocket); spare in the Medical Room red box', instructions: 'Inject into the outer thigh at the first sign of anaphylaxis, then call an ambulance.' },
        doctor: { name: 'Dr. Anil Kulkarni', phone: '+91 98230 11122', clinic: 'Kothrud Children’s Clinic' }, hospital: { name: 'Deenanath Mangeshkar Hospital', phone: '+91 20 4015 1000', address: 'Erandwane, Pune' },
        alternateContact: { name: 'Sunita Sharma', phone: '+91 98111 40037', relation: 'Mother' }, privateNotes: 'Anaphylaxis at age 6 (hospitalised). Review the action plan each June.', reviewed: true });
    await health.addHealthRecord(ctx, 'allergy', id('Aarav Sharma'), { allergen: 'Peanuts', category: 'food', severity: 'life_threatening', reaction: 'Lip and throat swelling, wheezing, hives', emergencyInstructions: 'Use the adrenaline auto-injector immediately, call an ambulance, then the parents', medication: 'Adrenaline auto-injector 0.3 mg', doctor: 'Dr. Anil Kulkarni' });
    await health.addHealthRecord(ctx, 'condition', id('Aarav Sharma'), { type: 'asthma', condition: 'Asthma', severity: 'moderate', chronic: true, diagnosedOn: '2018-07-10', treatment: 'Reliever inhaler as needed; preventer at home', medication: 'Salbutamol inhaler 100 mcg', emergencyInstructions: 'Sit him up, 4 puffs of the reliever; if no better in 10 minutes call an ambulance' });
    await health.addHealthRecord(ctx, 'allergy', id('Diya Iyer'), { allergen: 'Penicillin', category: 'medicine', severity: 'severe', reaction: 'Widespread rash and swelling', emergencyInstructions: 'Never give penicillin-group antibiotics. Antihistamine for a rash; ambulance if breathing is affected.' });
    await health.addHealthRecord(ctx, 'condition', id('Kabir Nair'), { type: 'diabetes', condition: 'Type 1 diabetes', severity: 'severe', chronic: true, diagnosedOn: '2021-02-01', treatment: 'Insulin at home; checks his sugar before lunch', medication: 'Glucose tablets for a low', emergencyInstructions: 'If shaky, pale or confused: glucose tablets or sugary drink now, recheck in 15 minutes; call parents.' });
    await prof('Kabir Nair', { instructions: 'May eat a snack in class at any time. Lets the teacher know if he feels low.', heightCm: 158, weightKg: 47 });
    await health.addHealthRecord(ctx, 'condition', id('Ira Menon'), { type: 'epilepsy', condition: 'Epilepsy', severity: 'critical', chronic: true, diagnosedOn: '2019-11-20', treatment: 'Daily medication at home', medication: 'Rescue medication (buccal midazolam)', emergencyInstructions: 'Time the seizure, protect her head, do not restrain. If over 5 minutes give the rescue medication and call an ambulance.' });
    await prof('Ira Menon', { emergencyMedication: { required: true, name: 'Buccal midazolam 10 mg', location: 'Medical Room red box', instructions: 'For a seizure lasting over 5 minutes.' } });
    await health.addHealthRecord(ctx, 'allergy', id('Rohan Kulkarni'), { allergen: 'Dust mites', category: 'environmental', severity: 'mild', reaction: 'Sneezing, itchy eyes' });
    await health.addHealthRecord(ctx, 'condition', id('Myra Patel'), { type: 'vision', condition: 'Short sight (myopia)', severity: 'mild', treatment: 'Wears glasses', emergencyInstructions: 'Seat her near the board.' });
    await health.addHealthRecord(ctx, 'allergy', id('Vihaan Rao'), { allergen: 'Bee and wasp stings', category: 'insect', severity: 'severe', reaction: 'Large swelling, faintness', emergencyInstructions: 'Remove the sting, cold compress, antihistamine; ambulance if breathing changes' });
    await health.addHealthRecord(ctx, 'allergy', id('Saanvi Joshi'), { allergen: 'Lactose', category: 'food', severity: 'moderate', reaction: 'Stomach cramps' });
    await health.addHealthRecord(ctx, 'condition', id('Arjun Gupta'), { type: 'hearing', condition: 'Mild hearing loss (left ear)', severity: 'moderate', treatment: 'Hearing aid', emergencyInstructions: 'Speak to him on his right side.' });
    await health.addHealthRecord(ctx, 'condition', id('Kiara Bose'), { type: 'other', condition: 'Anxiety', severity: 'mild', treatment: 'Counselling' });
    for (const [n, h, w] of [['Diya Iyer', 149, 41], ['Rohan Kulkarni', 154, 46], ['Vihaan Rao', 151, 43], ['Saanvi Joshi', 150, 42], ['Kiara Bose', 147, 39], ['Myra Patel', 143, 36]]) await prof(n, { heightCm: h, weightKg: w });

    /* Medication plans: one waiting for the parent's consent. */
    await meds.createPlan(ctx, { student: id('Aarav Sharma'), source: 'school', item: String(I.salb._id), dosage: '2 puffs', quantityPerDose: 0, frequency: 'as_needed', startDate: daysFrom(-60), reason: 'Asthma — reliever', instructions: 'When wheezing or short of breath', parentAuthorized: true, authorizedBy: 'Rahul Sharma (father) — signed form' });
    await meds.createPlan(ctx, { student: id('Kabir Nair'), source: 'parent', medicineName: 'Glucose tablets', dosage: '3 tablets', frequency: 'as_needed', startDate: daysFrom(-90), reason: 'Low blood sugar', parentAuthorized: true, authorizedBy: 'Parent consent form' });
    await meds.createPlan(ctx, { student: id('Diya Iyer'), source: 'parent', medicineName: 'Iron supplement (ferrous sulphate)', dosage: '1 tablet', frequency: 'once', times: ['08:00'], days: [1, 2, 3, 4, 5, 6], startDate: daysFrom(-20), endDate: daysFrom(40), reason: 'Low iron', instructions: 'With water, after breakfast break', parentAuthorized: true, authorizedBy: 'Mother — note in diary' });
    await meds.createPlan(ctx, { student: id('Myra Patel'), source: 'parent', medicineName: 'Amoxicillin 250 mg', dosage: '1 capsule', frequency: 'twice', times: ['09:00', '13:00'], days: [0, 1, 2, 3, 4, 5, 6], startDate: daysFrom(-2), endDate: daysFrom(4), reason: 'Throat infection (doctor’s prescription)', parentAuthorized: true, authorizedBy: 'Father — prescription attached' });
    await meds.createPlan(ctx, { student: id('Vihaan Rao'), source: 'school', item: String(I.cet._id), dosage: '1 tablet', quantityPerDose: 1, frequency: 'once', times: ['12:30'], days: [1, 2, 3, 4, 5, 6], startDate: daysFrom(0), endDate: daysFrom(14), reason: 'Seasonal allergy (doctor advised)' });
    await meds.ensureDoses(S, daysFrom(0));
    const due = await query(`SELECT "_id", "scheduledFor" FROM "medicationdoses" WHERE "school" = $1 AND "status" = 'scheduled' AND "scheduledFor" < now() ORDER BY "scheduledFor"`, [S]);
    for (const [i, d] of due.rows.entries()) await meds.recordDose(ctx, d._id, i === due.rows.length - 1 && due.rows.length > 1 ? { status: 'refused', note: 'Said she had taken it at home' } : { status: 'given' });

    /* Past visits — back-dated after they are made. */
    const REASONS = [['Headache', 'Mild headache since morning', 'Rest and water'], ['Stomach ache', 'Pain after lunch', 'Antacid, rest 20 min'], ['Fever', 'Feeling hot, tired', 'Paracetamol'],
        ['Injury', 'Grazed elbow on the stairs', 'Cleaned and dressed'], ['Cough & cold', 'Running nose', 'Steam, warm water'], ['Nausea / vomiting', 'Vomited once in class', 'ORS, rest'],
        ['Dizziness', 'Felt dizzy in assembly', 'Rested, ORS'], ['Toothache', 'Pain in a lower tooth', 'Cold compress, told to see a dentist'], ['Eye irritation', 'Dust in the eye', 'Eye washed']];
    const others = NAMES.map((x) => x[0]).filter((n) => !['Aarav Sharma', 'Saanvi Joshi', 'Arjun Gupta', 'Kiara Bose'].includes(n));
    let k = 0;
    for (let dAgo = 13; dAgo >= 1; dAgo -= 1) {
        const count = dAgo % 7 === 0 ? 1 : 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < count; j += 1) {
            k += 1;
            const [reason, symptoms, treatment] = pick(REASONS);
            const n = pick(others);
            const when = at(dAgo, 8 + Math.floor(rnd() * 6), Math.floor(rnd() * 60));
            const outcome = k % 9 === 0 ? 'sent_home' : 'returned';
            const fever = reason === 'Fever';
            const meds2 = fever ? [{ item: String(I.pcm._id), dosage: '1 tablet (500 mg)', quantity: 1 }] : reason === 'Stomach ache' ? [{ item: String(I.antacid._id), dosage: '10 ml', quantity: 0.1 }] : [];
            const supplies = reason === 'Injury' ? [{ item: String(sup.gauze._id), quantity: 1 }, { item: String(sup.plaster._id), quantity: 2 }] : [];
            const v = await cases.createVisit(ctx, { student: id(n), arrivedAt: when.toISOString(), reason, symptoms, treatment, firstAid: reason === 'Injury' ? 'Wound cleaned with antiseptic and dressed' : '',
                vitals: { temperature: fever ? 100.6 + Math.round(rnd() * 10) / 10 : 98.4, tempUnit: 'F', pulse: 78 + Math.floor(rnd() * 20) }, medicines: meds2, supplies, restAdvised: true, restMinutes: 15 + Math.floor(rnd() * 3) * 5 });
            await cases.setVisitStatus(ctx, v._id, { status: outcome, outcomeNote: outcome === 'returned' ? 'Rested; fine to continue' : 'Collected by a parent', notifyParents: false });
            if (dAgo > 3) await cases.setVisitStatus(ctx, v._id, { status: 'closed' }).catch(() => {});
            const left = new Date(when.getTime() + (20 + Math.floor(rnd() * 25)) * 60000);
            await query(`UPDATE "medicalvisits" SET "createdAt" = $2::timestamptz, "departedAt" = $3::timestamptz, "closedAt" = CASE WHEN "closedAt" IS NULL THEN NULL ELSE $3::timestamptz END,
                           "history" = (SELECT jsonb_agg(jsonb_set(h, '{at}', to_jsonb($3::timestamptz))) FROM jsonb_array_elements("history") h) WHERE "_id" = $1`, [v._id, when, left]);
            await query(`UPDATE "medicationdoses" SET "givenAt" = $2, "createdAt" = $2 WHERE "visit" = $1`, [v._id, when]);
            await query(`UPDATE "medicalstockmoves" SET "createdAt" = $1 WHERE "student" = $2 AND "createdAt" > now() - interval '2 minutes' AND "type" IN ('administered','first_aid')`, [when, id(n)]);
            await query(`UPDATE "medicalfirstaids" SET "at" = $2, "createdAt" = $2 WHERE "visit" = $1`, [v._id, when]);
        }
    }

    /* Last week: a bee sting that became an emergency, and a sports injury referred to hospital. */
    const sting = await cases.createIncident(ctx, { student: id('Vihaan Rao'), occurredAt: at(6, 11, 5).toISOString(), type: 'allergic', severity: 'serious', location: 'Playground',
        description: 'Stung by a bee near the garden during break; swelling spread up the arm within minutes.', injury: 'Swelling of the right forearm', bodyPart: 'Right forearm', witnesses: 'Ms. Neha Kapoor (duty teacher)', firstAid: 'Sting removed, cold compress', notifyParents: true });
    const sv = await cases.treatIncident(ctx, sting._id, { arrivedAt: at(6, 11, 10).toISOString(), status: 'emergency', vitals: { temperature: 98.8, pulse: 118, spo2: 96 },
        treatment: 'Antihistamine given; observed for 45 minutes', medicines: [{ item: String(I.cet._id), dosage: '1 tablet (10 mg)', quantity: 1 }], parentContacted: true, parentContactNote: 'Father informed by phone; came to school' });
    await cases.setVisitStatus(ctx, sv._id, { status: 'sent_home', outcomeNote: 'Swelling settling; went home with his father', notifyParents: false });
    await cases.setIncidentStatus(ctx, sting._id, { status: 'resolved' });
    const fall = await cases.createIncident(ctx, { student: id('Ishaan Reddy'), occurredAt: at(4, 15, 20).toISOString(), type: 'sports', severity: 'serious', location: 'Sports ground',
        description: 'Fell awkwardly while playing football and could not put weight on the left ankle.', injury: 'Painful, swollen left ankle', bodyPart: 'Left ankle', witnesses: 'PE teacher', firstAid: 'Ice pack, ankle supported with a triangular bandage',
        referral: { referred: true, hospital: 'Sahyadri Hospital, Kothrud', transport: 'Parent', reason: 'Suspected fracture — X-ray advised' }, followUp: { required: true, on: daysFrom(0), note: 'Check the X-ray result and sports restrictions' }, notifyParents: true });
    await cases.recordFirstAid(ctx, { student: id('Ishaan Reddy'), incident: fall._id, at: at(4, 15, 25).toISOString(), reason: 'Injury', injury: 'Swollen left ankle', treatment: 'Ice pack and triangular bandage support', supplies: [{ item: String(sup.ice._id), quantity: 1 }, { item: String(sup.triangle._id), quantity: 1 }] });
    await cases.recordFirstAid(ctx, { student: id('Om Kulkarni'), at: at(2, 10, 40).toISOString(), reason: 'Injury', injury: 'Small cut on the finger (art class)', treatment: 'Cleaned, plaster applied', supplies: [{ item: String(sup.plaster._id), quantity: 1 }, { item: String(sup.gloves._id), quantity: 1 }] });
    await cases.createIncident(tctx('Neha Kapoor'), { student: id('Ananya Sharma'), occurredAt: at(0, 10, 15).toISOString(), type: 'playground', severity: 'minor', location: 'Playground', description: 'Tripped while running at break and scraped her knee.', injury: 'Grazed right knee', firstAid: 'Washed with water' }, { teacher: true });

    /* Today in the room. */
    const req1 = await cases.createRequest(tctx('Priya Sharma'), { student: id('Aarav Sharma'), reason: 'Breathing difficulty', symptoms: 'Wheezing after the PE lesson; used his inhaler once', location: 'Classroom', urgency: 'high' });
    await cases.acceptRequest(ctx, req1._id, { note: 'Bring him now' });
    const v1 = await cases.arriveRequest(ctx, req1._id, { vitals: { temperature: 98.6, tempUnit: 'F', pulse: 112, spo2: 94 }, observation: 'Mild wheeze, speaking in full sentences', treatment: 'Reliever inhaler, sitting upright, monitored', status: 'observation', bed: String(beds['Bed 1']._id),
        medicines: [{ plan: (await M('MedicationPlan').findOne({ student: id('Aarav Sharma') }).lean())._id, dosage: '2 puffs', quantity: 0 }], parentContacted: true, parentContactNote: 'Mother informed; will call back at noon' });
    await query(`UPDATE "medicalvisits" SET "arrivedAt" = now() - interval '35 minutes' WHERE "_id" = $1`, [v1._id]);
    const v2 = await cases.createVisit(ctx, { student: id('Saanvi Joshi'), reason: 'Stomach ache', symptoms: 'Cramps after the morning snack', vitals: { temperature: 98.2, pulse: 90 }, status: 'in_room', bed: String(beds['Rest area A']._id), restAdvised: true, restMinutes: 30 });
    await query(`UPDATE "medicalvisits" SET "arrivedAt" = now() - interval '18 minutes' WHERE "_id" = $1`, [v2._id]);
    const v3 = await cases.createVisit(ctx, { student: id('Arjun Gupta'), arrivedAt: at(0, 9, 5).toISOString(), reason: 'Fever', symptoms: 'Headache and body ache', vitals: { temperature: 101.4, tempUnit: 'F', pulse: 104 }, treatment: 'Paracetamol, tepid sponging',
        medicines: [{ item: String(I.pcm._id), dosage: '1 tablet (500 mg)', quantity: 1 }], parentContacted: true, parentContactNote: 'Mother collecting at 10:30', followUp: { required: true, on: daysFrom(2), note: 'Check he is fever-free before sports' } });
    await cases.setVisitStatus(ctx, v3._id, { status: 'sent_home', outcomeNote: 'Fever — sent home with his mother' });
    const v4 = await cases.createVisit(ctx, { student: id('Rohan Kulkarni'), arrivedAt: at(0, 8, 40).toISOString(), reason: 'Headache', symptoms: 'Mild headache', vitals: { temperature: 98.4, pulse: 82 }, treatment: 'Rest and water', restAdvised: true, restMinutes: 15 });
    await cases.setVisitStatus(ctx, v4._id, { status: 'returned', outcomeNote: 'Rested 15 minutes; back to class' });
    await cases.createRequest(tctx('Priya Sharma'), { student: id('Kiara Bose'), reason: 'Dizziness', symptoms: 'Says she feels light-headed', location: 'Classroom', urgency: 'normal', escortedBy: 'Class monitor' });

    /* Vaccinations: done, due soon, overdue. */
    const vac = (n, body) => health.addVaccination(ctx, id(n), body);
    await vac('Aarav Sharma', { vaccine: 'Typhoid', dose: 'Dose 1', givenOn: daysFrom(-1090), provider: 'Kothrud Children’s Clinic', nextDueOn: daysFrom(12) });
    await vac('Aarav Sharma', { vaccine: 'Tdap', dose: 'Booster', givenOn: daysFrom(-400), provider: 'Kothrud Children’s Clinic' });
    await vac('Diya Iyer', { vaccine: 'HPV', dose: 'Dose 1', givenOn: daysFrom(-200), nextDueOn: daysFrom(-12), provider: 'City Clinic' });
    await vac('Kabir Nair', { vaccine: 'Influenza', dose: '2026', dueOn: daysFrom(20) });
    await vac('Myra Patel', { vaccine: 'MMR', dose: 'Dose 2', givenOn: daysFrom(-1500), provider: 'Govt. Health Centre' });
    await vac('Ira Menon', { vaccine: 'Hepatitis A', dose: 'Dose 2', dueOn: daysFrom(-5) });
    await vac('Ananya Sharma', { vaccine: 'Typhoid', dose: 'Booster', dueOn: daysFrom(8) });

    /* Checkups: last month's for VIII-B, and a dental camp booked for VI-A. */
    const sess = await health.scheduleCheckups(ctx, { sectionId: String(secs['8B'].doc._id), type: 'general', scheduledOn: daysFrom(0), sessionName: 'Annual health check — VIII-B', professional: 'Dr. S. Rao (school doctor)' });
    const sheet = sess.map((r, i) => ({ id: String(r._id), results: { heightCm: 146 + i * 2, weightKg: 37 + i, visionLeft: '6/6', visionRight: i === 3 ? '6/12' : '6/6' }, outcome: i === 3 ? 'attention' : 'normal', findings: i === 3 ? 'Right eye vision reduced — eye test advised' : '' }));
    await health.saveCheckupSheet(ctx, { checkedOn: daysFrom(0), professional: 'Dr. S. Rao (school doctor)', rows: sheet });
    await query(`UPDATE "medicalcheckups" SET "checkedOn" = $2 WHERE "school" = $1 AND "sessionName" = 'Annual health check — VIII-B'`, [S, new Date(`${daysFrom(-24)}T00:00:00Z`)]);
    await health.scheduleCheckups(ctx, { sectionId: String(secs['6A'].doc._id), type: 'dental', scheduledOn: daysFrom(6), sessionName: 'Dental camp — VI-A', professional: 'Smile Dental Care' });

    /* Documents. */
    await health.addDocument(ctx, id('Aarav Sharma'), { type: 'doctor_report', title: 'Allergy action plan', documentDate: daysFrom(-120), expiresOn: daysFrom(20) }, pdfFile('Allergy action plan - Aarav Sharma', ['Peanut allergy: anaphylaxis risk.', 'Adrenaline 0.3 mg IM at first signs.', 'Dr. Anil Kulkarni']));
    await health.addDocument(ctx, id('Aarav Sharma'), { type: 'fitness_certificate', title: 'Sports fitness certificate', documentDate: daysFrom(-60), visibility: 'family' }, pdfFile('Fitness certificate - Aarav Sharma', ['Fit for school sports with his inhaler at hand.']));
    await health.addDocument(ctx, id('Myra Patel'), { type: 'prescription', title: 'Amoxicillin prescription', documentDate: daysFrom(-2) }, pdfFile('Prescription - Myra Patel', ['Amoxicillin 250 mg, twice daily for 7 days.']));
    await health.addDocument(ctx, id('Diya Iyer'), { type: 'vaccination_certificate', title: 'HPV dose 1 certificate', documentDate: daysFrom(-200), visibility: 'family' }, pdfFile('Vaccination certificate - Diya Iyer', ['HPV vaccine, dose 1.']));

    /* Parents' updates waiting for the room. */
    await health.submitChange(pctx, id('Ananya Sharma'), { kind: 'allergy', action: 'add', payload: { allergen: 'Shellfish', category: 'food', severity: 'moderate', reaction: 'Hives around the mouth' }, note: 'Found out at a wedding last month' });
    await health.submitChange(pctx, id('Aarav Sharma'), { kind: 'contact', payload: { slot: 'alternate', name: 'Raj Malhotra', phone: '+91 98220 77881', relation: 'Uncle (lives nearby)' }, note: 'Please call him if we cannot be reached' });

    console.log(`done.\n  logins (password ${PASSWORD}): admin@${DOMAIN}, mary.joseph@${DOMAIN} (nurse), priya.sharma@${DOMAIN} (class teacher VIII-B), aarav.sharma@${DOMAIN} (student), rahul.sharma@${DOMAIN} (parent)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await new Promise((r) => setTimeout(r, 1500)); await end(); process.exit(); });
