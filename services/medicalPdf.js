'use strict';
/**
 * The Medical Room's printable documents (Oct 2026), drawn with pdfkit in one
 * house style: the school's band at the top, "Confidential" on every page,
 * the page count at the foot.
 *
 *   healthSummary   one student's record for the family or the next school:
 *                   identity, blood group, allergies, conditions, care plans,
 *                   rescue medicines, medicines, vaccinations, the last
 *                   checkup, the people to call
 *
 * A builder is given `res` and streams to it; it never reads the database —
 * the caller gathers what the reader may see.
 */
const PDFDocument = require('pdfkit');
const { schoolLogoPath } = require('../utils/schoolLogoFile');
const { instantDayLabel } = require('./medicalRules');

const C = { band: '#7F1D1D', ink: '#1E293B', muted: '#64748B', line: '#E2E8F0', red: '#B91C1C', soft: '#FEF2F2', head: '#F8FAFC' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d) => { if (!d) return ''; const x = new Date(d); return Number.isNaN(x.getTime()) ? '' : `${String(x.getUTCDate()).padStart(2, '0')} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };

/** A document with the band, the confidential line and room for the body. */
function start(res, { school, title, subtitle, filename }) {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: title } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // The caller waits for this: the response is finished only when the last byte is out
    // (a handler that returned earlier had its JSON envelope sent over the PDF).
    const done = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('close', resolve); doc.on('error', reject); });
    doc.pipe(res);
    const X = 40; const W = doc.page.width - 80;
    doc.rect(X, 36, W, 58).fill(C.band);
    const logo = schoolLogoPath(school);
    if (logo) { try { doc.image(logo, X + 10, 42, { fit: [46, 46] }); } catch { /* unreadable logo */ } }
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#fff').text(school?.name || 'School', X, 46, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#FDE2E2').text(title, X, 68, { width: W, align: 'center' });
    doc.y = 106;
    if (subtitle) doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(subtitle, X, doc.y, { width: W });
    doc.moveDown(0.6);
    return { doc, X, W, done };
}

function finish(doc) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        const y = doc.page.height - 30;
        doc.font('Helvetica').fontSize(8).fillColor(C.muted)
            .text('CONFIDENTIAL — medical information. Keep it safe and share it only with those caring for the child.', 40, y, { width: doc.page.width - 180, lineBreak: false })
            .text(`Page ${i + 1} of ${range.count}`, doc.page.width - 140, y, { width: 100, align: 'right', lineBreak: false });
    }
    doc.end();
}

function heading(ctx, text) {
    const { doc, X, W } = ctx;
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.moveDown(0.5);
    doc.rect(X, doc.y, W, 18).fill(C.head);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(text.toUpperCase(), X + 6, doc.y + 5, { width: W - 12, characterSpacing: 0.5 });
    doc.moveDown(0.6);
}

function line(ctx, text, { bold = false, color = C.ink, indent = 0 } = {}) {
    const { doc, X, W } = ctx;
    if (doc.y > doc.page.height - 70) doc.addPage();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(color).text(text, X + 6 + indent, doc.y, { width: W - 12 - indent });
    doc.moveDown(0.25);
}

function pairs(ctx, items) {
    const { doc, X, W } = ctx;
    const col = (W - 12) / 2;
    const list = items.filter(([, v]) => v !== undefined && v !== null && v !== '');
    for (let i = 0; i < list.length; i += 2) {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y;
        [list[i], list[i + 1]].forEach((p, j) => {
            if (!p) return;
            doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(String(p[0]).toUpperCase(), X + 6 + j * col, y, { width: col - 8 });
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(String(p[1]), X + 6 + j * col, y + 10, { width: col - 8 });
        });
        doc.y = y + 28;
    }
}

/**
 * healthSummary(res, { school, record, forNextSchool, generatedBy })
 * `record` is medicalRead.staffRecord's shape (or the family record's).
 */
function healthSummary(res, opts) {
    const s0 = opts.record?.student || {};
    const ctx = start(res, {
        school: opts.school, title: `Health summary — ${s0.name || ''}`,
        subtitle: `Generated ${instantDayLabel(new Date())}${opts.generatedBy ? ` by ${opts.generatedBy}` : ''} from the school's Medical Room record.`,
        filename: `health-summary-${String(s0.name || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
    });
    try { drawHealthSummary(ctx, opts); } catch (e) { console.error('[medical] summary pdf failed:', e.message); }
    finish(ctx.doc);
    return ctx.done;
}

function drawHealthSummary(ctx, { record: r, note = '' }) {
    const s = r.student || {};
    const p = r.profile || {};
    heading(ctx, 'The student');
    pairs(ctx, [
        ['Name', s.name], ['Born', day(s.dob)], ['Admission no.', s.admissionNumber], ['Class', s.classLabel],
        ['Blood group', r.bloodGroup || '—'], ['Height / weight', [p.heightCm && `${p.heightCm} cm`, p.weightKg && `${p.weightKg} kg`].filter(Boolean).join(' · ') || '—'],
    ]);
    const live = (x) => !x.archivedAt && x.status !== 'resolved';
    heading(ctx, 'Allergies');
    const allergies = (r.allergies || []).filter(live);
    if (!allergies.length) line(ctx, 'None on record.', { color: C.muted });
    for (const a of allergies) {
        const severe = ['severe', 'life_threatening'].includes(a.severity);
        line(ctx, `${a.allergen} — ${String(a.severity || '').replace('_', '-')}${a.category ? ` (${a.category})` : ''}`, { bold: true, color: severe ? C.red : C.ink });
        if (a.reaction) line(ctx, `Reaction: ${a.reaction}`, { indent: 10 });
        if (a.emergencyInstructions) line(ctx, `If exposed: ${a.emergencyInstructions}`, { indent: 10 });
    }
    heading(ctx, 'Medical conditions');
    const conditions = (r.conditions || []).filter(live);
    if (!conditions.length) line(ctx, 'None on record.', { color: C.muted });
    for (const c of conditions) {
        line(ctx, `${c.condition}${c.severity ? ` — ${c.severity}` : ''}`, { bold: true });
        if (c.medication) line(ctx, `Medicine: ${c.medication}`, { indent: 10 });
        if (c.emergencyInstructions) line(ctx, `In an emergency: ${c.emergencyInstructions}`, { indent: 10 });
    }
    const plans = (r.carePlans || []).filter((c) => !c.archivedAt && c.status === 'active');
    if (plans.length) {
        heading(ctx, 'Emergency care plans');
        for (const c of plans) {
            line(ctx, c.title, { bold: true, color: C.red });
            (c.steps || []).forEach((x, i) => line(ctx, `${i + 1}. ${x.text}`, { indent: 10, bold: !!x.critical }));
            if (c.ambulanceWhen) line(ctx, `Call an ambulance: ${c.ambulanceWhen}`, { indent: 10 });
        }
    }
    const rescue = (r.rescueMeds || []).filter((m) => !m.archivedAt && m.status === 'active');
    if (rescue.length) {
        heading(ctx, 'Rescue medicines');
        for (const m of rescue) line(ctx, `${m.name}${m.dose ? ` — ${m.dose}` : ''}${m.expiresOn ? ` · expires ${day(m.expiresOn)}` : ''}${m.selfCarry ? ' · carried by the student' : ''}`);
    }
    const meds = (r.plans || []).filter((x) => ['active', 'paused'].includes(x.status));
    heading(ctx, 'Medicines at school');
    if (!meds.length) line(ctx, 'None.', { color: C.muted });
    for (const m of meds) line(ctx, `${m.medicineName} — ${m.dosage}${(m.times || []).length ? ` at ${m.times.join(', ')}` : ' when needed'}${m.status === 'paused' ? ' (paused)' : ''}`);
    heading(ctx, 'Vaccinations');
    const vac = (r.vaccinations || []).filter((v) => !v.archivedAt);
    if (!vac.length) line(ctx, 'None on record.', { color: C.muted });
    for (const v of vac.slice(0, 40)) line(ctx, `${v.vaccine}${v.dose ? ` (${v.dose})` : ''} — ${v.givenOn ? `given ${day(v.givenOn)}` : v.dueOn ? `due ${day(v.dueOn)}` : ''}`);
    const ck = (r.checkups || []).find((c) => c.status === 'completed');
    if (ck) {
        heading(ctx, 'Last health checkup');
        const res0 = ck.results || {};
        line(ctx, `${day(ck.checkedOn)}: ${[res0.heightCm && `${res0.heightCm} cm`, res0.weightKg && `${res0.weightKg} kg`, res0.bmi && `BMI ${res0.bmi}`, (res0.visionLeft || res0.visionRight) && `vision L ${res0.visionLeft || '—'} R ${res0.visionRight || '—'}`].filter(Boolean).join(' · ')}`);
        if (ck.findings) line(ctx, ck.findings, { indent: 10 });
    }
    const g = r.growth?.latest?.indicators;
    if (g && (g.bmi || g.height)) {
        heading(ctx, 'Growth (WHO charts)');
        for (const k of ['bmi', 'height']) {
            const x = g[k];
            if (x && !x.implausible) line(ctx, `${x.label}: ${x.centileLabel} — ${x.bandLabel} (measured ${day(r.growth.latest.on)})`, { color: x.tone === 'red' ? C.red : C.ink });
        }
    }
    heading(ctx, 'People to call');
    const contacts = (r.contacts || []).filter((c) => c.phone || c.name);
    if (!contacts.length) line(ctx, 'None on record.', { color: C.muted });
    for (const c of contacts) line(ctx, `${c.name || ''}${c.relation ? ` (${c.relation})` : ''}${c.phone ? ` — ${c.phone}` : ''}`);
    if (p.doctor?.name) line(ctx, `Family doctor: ${p.doctor.name}${p.doctor.phone ? ` — ${p.doctor.phone}` : ''}`);
    if (p.instructions || note) {
        heading(ctx, 'Notes');
        if (p.instructions) line(ctx, p.instructions);
        if (note) line(ctx, note);
    }
}

/**
 * referralLetter(res, { school, referral, student, allergies, room, by })
 * The letter a family takes to the specialist, with a reply slip at the foot.
 */
function referralLetter(res, opts) {
    const r = opts.referral || {};
    const st = opts.student || {};
    const ctx = start(res, {
        school: opts.school, title: `Referral — ${r.specialtyLabel || 'Specialist'}`,
        subtitle: `${r.number || ''} · ${instantDayLabel(r.createdAt || new Date())}${r.urgency === 'urgent' ? ' · URGENT' : ''}`,
        filename: `referral-${String(st.name || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(r.number || '').toLowerCase()}.pdf`,
    });
    try { drawReferral(ctx, opts); } catch (e) { console.error('[medical] referral pdf failed:', e.message); }
    finish(ctx.doc);
    return ctx.done;
}

function drawReferral(ctx, { referral: r, student: st = {}, allergies = [], room = {}, by = '', school }) {
    const { doc, X, W } = ctx;
    heading(ctx, 'The student');
    pairs(ctx, [['Name', st.name], ['Born', day(st.dob)], ['Class', st.classLabel], ['Admission no.', st.admissionNumber]]);
    heading(ctx, `To the ${String(r.specialtyLabel || 'specialist').toLowerCase()}`);
    line(ctx, 'Dear Doctor,');
    line(ctx, `${st.name || 'This student'} was seen at our school's Medical Room. ${r.reason || ''}`);
    if (r.findings) line(ctx, `What we found: ${r.findings}`);
    if (r.source?.label) line(ctx, `From: ${r.source.label}`, { color: C.muted });
    const live = (allergies || []).filter((a) => a.allergen);
    line(ctx, live.length ? `Allergies on record: ${live.map((a) => `${a.allergen}${a.severity ? ` (${String(a.severity).replace('_', '-')})` : ''}`).join(', ')}` : 'No allergies on record.', { bold: live.length > 0, color: live.length ? C.red : C.ink });
    line(ctx, `We would be grateful if you could see ${st.name ? st.name.split(' ')[0] : 'the student'}${r.dueBy ? ` by ${day(r.dueBy)}` : ''} and tell us what you find — on the slip below, or through the family.`);
    doc.moveDown(0.6);
    line(ctx, by ? `${by}, ${room.name || 'Medical Room'}` : (room.name || 'Medical Room'), { bold: true });
    line(ctx, [school?.name, room.phone ? `Phone ${room.phone}` : ''].filter(Boolean).join(' · '), { color: C.muted });
    // The reply slip — cut along the line.
    if (doc.y > doc.page.height - 240) doc.addPage();
    doc.moveDown(1.2);
    const y = doc.y;
    doc.save().dash(4, { space: 3 }).moveTo(X, y).lineTo(X + W, y).strokeColor(C.muted).stroke().restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Cut here and return this part to the school', X, y + 3, { width: W, align: 'center' });
    doc.y = y + 18;
    heading(ctx, `Reply — ${st.name || ''} (${r.number || ''})`);
    const blank = (label) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const yy = doc.y + 4;
        doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(label, X + 6, yy, { width: 150 });
        doc.moveTo(X + 160, yy + 11).lineTo(X + W - 6, yy + 11).strokeColor(C.line).stroke();
        doc.y = yy + 22;
    };
    blank('Seen on');
    blank('Doctor / clinic');
    blank('What was found');
    blank('');
    blank('Advice / treatment');
    blank('');
    blank('Glasses / aids needed');
    blank('Signature & stamp');
}

/* ── More documents (Oct 2026): incident report, hospital handover, annual health card, emergency card sets ── */

const ZONE = 'Asia/Kolkata';
const stamp = (d) => { if (!d) return ''; const x = new Date(d); return Number.isNaN(x.getTime()) ? '' : `${instantDayLabel(x)}, ${x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE })}`; };
const sev = (v) => String(v || '').replace(/_/g, '-');

/** A document of several parts (one per student) — the caller draws each, a new page between. */
function many(res, { school, title, subtitle, filename }, items, draw) {
    const ctx = start(res, { school, title, subtitle, filename });
    try {
        items.forEach((it, i) => {
            if (i > 0) { ctx.doc.addPage(); ctx.doc.y = 50; }
            draw(ctx, it, i);
        });
        if (!items.length) line(ctx, 'Nobody to print.', { color: C.muted });
    } catch (e) { console.error('[medical] pdf failed:', e.message); }
    finish(ctx.doc);
    return ctx.done;
}

/**
 * incidentReport(res, { school, incident, student, alerts, by })
 */
function incidentReport(res, o) {
    const i = o.incident; const st = o.student || {};
    const ctx = start(res, {
        school: o.school, title: `Medical incident report — ${i.number}`,
        subtitle: `Printed ${stamp(new Date())}${o.by ? ` by ${o.by}` : ''}`,
        filename: `incident-${String(i.number).toLowerCase()}.pdf`,
    });
    try {
        heading(ctx, 'The student');
        pairs(ctx, [['Name', st.name], ['Class', st.classLabel], ['Admission no.', st.admissionNumber], ['Born', day(st.dob)]]);
        heading(ctx, 'What happened');
        pairs(ctx, [['When', stamp(i.occurredAt)], ['Where', i.location], ['Type', o.typeLabel], ['Severity', sev(i.severity)], ['Reported by', [i.reportedByName, i.reportedByRole].filter(Boolean).join(', ')], ['Status', o.statusLabel]]);
        line(ctx, i.description);
        if (i.witnesses) line(ctx, `Witnesses: ${i.witnesses}`);
        heading(ctx, 'Injury and care');
        if (i.injury || i.bodyPart) line(ctx, [i.injury, i.bodyPart && `(${i.bodyPart})`].filter(Boolean).join(' '), { bold: true });
        for (const x of (i.injuries || [])) line(ctx, `• ${x.region ? String(x.region).replace(/_/g, ' ') : ''}${x.view ? ` (${x.view})` : ''}: ${x.kind || ''}${x.note ? ` — ${x.note}` : ''}`, { indent: 6 });
        if (i.firstAid) line(ctx, `First aid: ${i.firstAid}`);
        if (i.medicineUsed) line(ctx, `Medicine: ${i.medicineUsed}`);
        if ((o.alerts || []).length) line(ctx, `On record: ${o.alerts.join(' · ')}`, { color: C.red });
        heading(ctx, 'Family and follow-up');
        line(ctx, i.parentNotified ? `Parents told ${stamp(i.parentNotifiedAt)}${i.parentNotifyNote ? ` — ${i.parentNotifyNote}` : ''}` : 'Parents not yet recorded as told.');
        if (i.referral?.referred) line(ctx, `Referred to ${i.referral.hospital}${i.referral.reason ? ` — ${i.referral.reason}` : ''}${i.referral.transport ? ` · by ${i.referral.transport}` : ''}${i.referral.accompaniedBy ? ` · with ${i.referral.accompaniedBy}` : ''}`, { bold: true });
        if (i.followUp?.required) line(ctx, `Follow-up${i.followUp.on ? ` by ${day(i.followUp.on)}` : ''}: ${i.followUp.note || ''}${i.followUp.outcome ? ` — done: ${i.followUp.outcome}` : ''}`);
        ctx.doc.moveDown(2);
        line(ctx, 'Signed (Medical Room) ______________________          Signed (Principal) ______________________', { color: C.muted });
    } catch (e) { console.error('[medical] incident pdf failed:', e.message); }
    finish(ctx.doc);
    return ctx.done;
}

/**
 * handover(res, { school, visit, card (emergencyProfile), doses, by, room })
 * What a hospital needs about a child arriving from school, on one page.
 */
function handover(res, o) {
    const v = o.visit; const e = o.card || {}; const st = e.student || {};
    const ctx = start(res, {
        school: o.school, title: `Hospital handover — ${st.name || ''}`,
        subtitle: `From the school's Medical Room · ${v.number} · printed ${stamp(new Date())}${o.by ? ` by ${o.by}` : ''}`,
        filename: `handover-${String(st.name || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
    });
    try {
        heading(ctx, 'The child');
        pairs(ctx, [['Name', st.name], ['Born', `${day(st.dob)}${st.age != null ? ` (${st.age} y)` : ''}`], ['Sex', st.gender], ['Blood group', e.bloodGroup || 'Not recorded'], ['Class', st.classLabel], ['Admission no.', st.admissionNumber]]);
        heading(ctx, 'Allergies');
        if (!(e.allergies || []).length) line(ctx, 'None on record.', { color: C.muted });
        for (const a of e.allergies || []) line(ctx, `${a.allergen} — ${sev(a.severity)}${a.reaction ? ` (${a.reaction})` : ''}`, { bold: true, color: a.critical ? C.red : C.ink });
        heading(ctx, 'Conditions and regular medicines');
        if (!(e.conditions || []).length) line(ctx, 'None on record.', { color: C.muted });
        for (const c of e.conditions || []) line(ctx, `${c.condition} — ${sev(c.severity)}${c.medication ? ` · medicine: ${c.medication}` : ''}`, { bold: c.critical });
        if (e.instructions) line(ctx, e.instructions, { color: C.muted });
        heading(ctx, 'Today at school');
        pairs(ctx, [['Arrived in the room', stamp(v.arrivedAt)], ['Why', v.reason], ['Triage', v.triage?.level ? String(v.triage.level).toUpperCase() : ''], ['Left for hospital', stamp(v.departedAt)]]);
        if (v.symptoms) line(ctx, `Symptoms: ${v.symptoms}`);
        if (v.observation) line(ctx, `Seen: ${v.observation}`);
        if (v.firstAid) line(ctx, `First aid: ${v.firstAid}`);
        if (v.treatment) line(ctx, `Treatment: ${v.treatment}`);
        for (const x of (v.injuries || [])) line(ctx, `Injury: ${String(x.region || '').replace(/_/g, ' ')} — ${x.kind || ''}${x.note ? ` (${x.note})` : ''}`, { indent: 6 });
        const readings = (v.readings || []).filter((r) => !r.struck);
        if (readings.length) {
            heading(ctx, 'Readings');
            for (const r of readings.slice(-8)) {
                const parts = [r.temperature != null ? `T ${r.temperature}°${r.tempUnit || 'F'}` : '', r.pulse != null ? `pulse ${r.pulse}` : '', r.respRate != null ? `RR ${r.respRate}` : '', r.spo2 != null ? `SpO₂ ${r.spo2}%`.replace('₂', '2') : '', r.bpSystolic != null ? `BP ${r.bpSystolic}/${r.bpDiastolic ?? '—'}` : '', r.glucose != null ? `glucose ${r.glucose}` : '', r.avpu ? `AVPU ${r.avpu}` : '', r.painScore != null ? `pain ${r.painScore}/10` : ''].filter(Boolean);
                line(ctx, `${stamp(r.at)} — ${parts.join(' · ')}${r.note ? ` · ${r.note}` : ''}`);
            }
        }
        heading(ctx, 'Medicines given at school today');
        if (!(o.doses || []).length) line(ctx, 'None.', { color: C.muted });
        for (const d of o.doses || []) line(ctx, `${stamp(d.givenAt)} — ${d.medicineName} ${d.dosage || ''}${d.givenByName ? ` (by ${d.givenByName})` : ''}`, { bold: true });
        if ((e.carePlans || []).length) {
            heading(ctx, 'Emergency care plan on record');
            for (const c of e.carePlans) {
                line(ctx, c.title, { bold: true, color: C.red });
                (c.steps || []).slice(0, 6).forEach((x, i) => line(ctx, `${i + 1}. ${x.text}`, { indent: 10 }));
            }
        }
        heading(ctx, 'Who to call');
        for (const c of (e.contacts || []).filter((x) => x.phone).slice(0, 4)) line(ctx, `${c.name || ''}${c.relation ? ` (${c.relation})` : ''} — ${c.phone}`);
        if (e.doctor?.name) line(ctx, `Family doctor: ${e.doctor.name}${e.doctor.phone ? ` — ${e.doctor.phone}` : ''}`);
        line(ctx, `The school: ${o.room?.name || 'Medical Room'}${o.room?.phone ? ` — ${o.room.phone}` : ' (no phone number set)'}`, { bold: true });
    } catch (err) { console.error('[medical] handover pdf failed:', err.message); }
    finish(ctx.doc);
    return ctx.done;
}

/**
 * annualCards(res, { school, year, cards: [{ student, ... }], by })
 * One page per student: the year's health in one place, for the family.
 */
function annualCards(res, o) {
    const one = o.cards.length === 1 ? o.cards[0].student : null;
    return many(res, {
        school: o.school, title: `Annual health card — ${o.year?.name || ''}`.trim(),
        subtitle: `Printed ${stamp(new Date())}${o.by ? ` by ${o.by}` : ''}`,
        filename: one ? `health-card-${String(one.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf` : `health-cards-${String(o.label || 'class').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
    }, o.cards, (ctx, c) => {
        const st = c.student;
        heading(ctx, st.name);
        pairs(ctx, [['Class', st.classLabel], ['Admission no.', st.admissionNumber], ['Born', day(st.dob)], ['Blood group', c.bloodGroup || 'Not recorded']]);
        heading(ctx, 'Growth');
        const g = c.growth?.latest;
        if (!g) line(ctx, 'No height or weight this year.', { color: C.muted });
        else {
            line(ctx, `${day(g.on)}: ${[g.heightCm && `${g.heightCm} cm`, g.weightKg && `${g.weightKg} kg`, g.bmi && `BMI ${g.bmi}`].filter(Boolean).join(' · ')}`);
            for (const k of ['bmi', 'height']) { const x = g.indicators?.[k]; if (x && !x.implausible) line(ctx, `${x.label}: ${x.centileLabel} — ${x.bandLabel} (WHO)`, { indent: 10, color: x.tone === 'red' ? C.red : C.ink }); }
        }
        heading(ctx, 'Checkups this year');
        if (!c.checkups.length) line(ctx, 'None recorded.', { color: C.muted });
        for (const k of c.checkups) line(ctx, `${day(k.checkedOn)} — ${k.typeLabel}${k.line ? `: ${k.line}` : ''}${k.outcomeLabel ? ` · ${k.outcomeLabel}` : ''}`);
        heading(ctx, 'Vaccinations');
        if (!c.vaccinations.length) line(ctx, 'None given this year.', { color: C.muted });
        for (const v of c.vaccinations) line(ctx, `${day(v.givenOn)} — ${v.vaccine}${v.dose ? ` (${v.dose})` : ''}`);
        for (const e of c.scheduleDue) line(ctx, `${e.label}: ${e.statusLabel.toLowerCase()}${e.dueOn ? ` (from ${day(e.dueOn)})` : ''}`, { color: e.status === 'overdue' ? C.red : C.ink });
        heading(ctx, 'Allergies and conditions');
        if (!c.allergies.length && !c.conditions.length) line(ctx, 'None on record.', { color: C.muted });
        for (const a of c.allergies) line(ctx, `Allergy: ${a.allergen} — ${sev(a.severity)}`, { bold: ['severe', 'life_threatening'].includes(a.severity), color: ['severe', 'life_threatening'].includes(a.severity) ? C.red : C.ink });
        for (const x of c.conditions) line(ctx, `Condition: ${x.condition} — ${sev(x.severity)}`);
        heading(ctx, 'The Medical Room this year');
        line(ctx, `${c.visits} visit${c.visits === 1 ? '' : 's'}${c.sentHome ? `, sent home ${c.sentHome} time${c.sentHome === 1 ? '' : 's'}` : ''}${c.incidents ? `, ${c.incidents} incident${c.incidents === 1 ? '' : 's'}` : ''}.`);
        for (const r of c.referrals) line(ctx, `Referred to ${r.specialtyLabel.toLowerCase()} (${instantDayLabel(r.createdAt)}): ${r.statusLabel}${r.outcome?.diagnosis ? ` — ${r.outcome.diagnosis}` : ''}`);
        for (const x of c.campaigns) line(ctx, `${x.title} (${day(x.startOn)}): ${x.outcomeLabel || 'not recorded'}`);
    });
}

/**
 * emergencyCards(res, { school, title, cards: [emergencyProfile…], by, photoPath })
 * Children with something to know get a card each; everyone else is a line
 * with a number to call — what a teacher on a trip carries.
 */
function emergencyCards(res, o) {
    const ctx = start(res, {
        school: o.school, title: o.title || 'Emergency cards',
        subtitle: `${o.cards.length} student${o.cards.length === 1 ? '' : 's'} · printed ${stamp(new Date())}${o.by ? ` by ${o.by}` : ''} · keep with you; return or shred after`,
        filename: `emergency-cards-${String(o.title || 'set').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}.pdf`,
    });
    const { doc, X, W } = ctx;
    try {
        const flagged = o.cards.filter((e) => (e.allergies || []).length || (e.conditions || []).length || (e.carePlans || []).length || (e.rescueMeds || []).length || e.emergencyMedication);
        const others = o.cards.filter((e) => !flagged.includes(e));
        heading(ctx, `With something to know (${flagged.length})`);
        for (const e of flagged) {
            const st = e.student || {};
            const lines = [];
            for (const a of e.allergies || []) lines.push({ t: `Allergy: ${a.allergen} — ${sev(a.severity)}${a.emergencyInstructions ? `. If exposed: ${a.emergencyInstructions}` : ''}`, red: a.critical });
            for (const c of e.conditions || []) lines.push({ t: `${c.condition} — ${sev(c.severity)}${c.emergencyInstructions ? `. ${c.emergencyInstructions}` : ''}`, red: c.critical });
            for (const c of e.carePlans || []) lines.push({ t: `Care plan — ${c.title}: ${(c.steps || []).filter((x) => x.critical).slice(0, 3).map((x) => x.text).join(' > ') || (c.steps || []).slice(0, 2).map((x) => x.text).join(' > ')}`, red: true });
            for (const m of e.rescueMeds || []) lines.push({ t: `Rescue medicine: ${m.name}${m.dose ? ` (${m.dose})` : ''}${m.selfCarry ? ' — carried by the child' : ''}${(m.locations || []).length ? ` — kept: ${m.locations.map((l) => String(l.place).replace(/_/g, ' ')).join(', ')}` : ''}${m.expired ? ' — EXPIRED' : ''}`, red: !!m.expired });
            if (e.emergencyMedication) lines.push({ t: `Emergency medicine: ${e.emergencyMedication.name || ''}${e.emergencyMedication.location ? ` — kept ${e.emergencyMedication.location}` : ''}`, red: true });
            const calls = (e.contacts || []).filter((c) => c.phone).slice(0, 2).map((c) => `${c.name || c.relation || 'Contact'}: ${c.phone}`).join('   ');
            const height = 46 + lines.length * 13 + 16;
            if (doc.y + height > doc.page.height - 60) { doc.addPage(); doc.y = 50; }
            const top = doc.y;
            doc.roundedRect(X, top, W, height, 6).lineWidth(1).strokeColor(lines.some((l) => l.red) ? C.red : C.line).stroke();
            const photo = o.photoPath ? o.photoPath(st.photo) : null;
            let textX = X + 10;
            if (photo) { try { doc.image(photo, X + 8, top + 8, { fit: [34, 40] }); textX = X + 50; } catch { /* unreadable */ } }
            doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(st.name || '', textX, top + 8, { width: W - (textX - X) - 10 });
            doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text([st.classLabel, st.dob ? `born ${day(st.dob)}` : '', `blood group ${e.bloodGroup || '—'}`].filter(Boolean).join(' · '), textX, top + 22, { width: W - (textX - X) - 10 });
            let y = top + 38;
            for (const l of lines) { doc.font(l.red ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.8).fillColor(l.red ? C.red : C.ink).text(l.t, textX, y, { width: W - (textX - X) - 10, lineBreak: false, ellipsis: true }); y += 13; }
            doc.font('Helvetica-Bold').fontSize(8.8).fillColor(C.ink).text(calls ? `Call: ${calls}` : 'No contact on record', textX, y + 2, { width: W - (textX - X) - 10, lineBreak: false, ellipsis: true });
            doc.y = top + height + 8;
        }
        if (!flagged.length) line(ctx, 'None of these students has an allergy, condition or care plan on record.', { color: C.muted });
        heading(ctx, `Everyone else (${others.length}) — blood group and who to call`);
        for (const e of others) {
            const st = e.student || {};
            const calls = (e.contacts || []).filter((c) => c.phone).slice(0, 2).map((c) => `${c.name || c.relation || 'Contact'} ${c.phone}`).join(' · ');
            line(ctx, `${st.name} (${st.classLabel || '—'}) · ${e.bloodGroup || '—'} · ${calls || 'no contact on record'}`);
        }
        line(ctx, `The school: ${o.room?.name || 'Medical Room'}${o.room?.phone ? ` — ${o.room.phone}` : ' (no phone number set)'}`, { bold: true });
    } catch (err) { console.error('[medical] emergency cards pdf failed:', err.message); }
    finish(ctx.doc);
    return ctx.done;
}

module.exports = { start, finish, heading, line, pairs, day, stamp, healthSummary, referralLetter, incidentReport, handover, annualCards, emergencyCards, C };
