'use strict';
/**
 * Health details from the admission form (Oct 2026). The office types what
 * the family wrote — allergies, conditions, medicines taken regularly, the
 * family doctor, food needs — and it becomes the student's Medical Room record
 * on day one, instead of a note nobody reads:
 *
 *   allergies, conditions  the Medical Room's own writer (medicalHealth
 *                          .addHealthRecord): the same checks, the same alerts
 *                          to teachers, marked as the family's and not yet
 *                          checked by the room
 *   doctor, food, notes    the medical profile
 *
 * `check` runs before the student is created, so a bad entry stops the form
 * with nothing half-saved; `fromAdmission` writes after. Nothing is written
 * when the school does not use the Medical Room. The medical staff are told
 * there is a new record to check.
 */
const pool = require('../db/pool');
const R = require('./medicalRules');

const { refuse, str, oneOf } = R;
const MAX = 12;
const { isPhone, normalizePhone } = require('../utils/validators');

/** The form's health part, cleaned — or null when nothing was filled in. */
function check(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    let h = raw;
    if (typeof h === 'string') { try { h = JSON.parse(h); } catch { refuse('The health details are not in the right shape'); } }
    if (!h || typeof h !== 'object') refuse('The health details are not in the right shape');
    const seen = new Set();
    const allergies = [];
    for (const a of (Array.isArray(h.allergies) ? h.allergies : []).slice(0, MAX)) {
        const allergen = str(a?.allergen, 120);
        if (!allergen || seen.has(allergen.toLowerCase())) continue;
        seen.add(allergen.toLowerCase());
        allergies.push({
            allergen, category: oneOf(a?.category, R.ALLERGY_CATEGORY, 'other'), severity: oneOf(a?.severity, R.ALLERGY_SEVERITY, 'moderate'),
            reaction: str(a?.reaction, 400), emergencyInstructions: str(a?.emergencyInstructions, 400),
        });
    }
    const named = new Set();
    const conditions = [];
    for (const c of (Array.isArray(h.conditions) ? h.conditions : []).slice(0, MAX)) {
        const condition = str(c?.condition, 120);
        if (!condition || named.has(condition.toLowerCase())) continue;
        named.add(condition.toLowerCase());
        conditions.push({
            condition, type: oneOf(c?.type, R.CONDITION_TYPE, 'other'), severity: oneOf(c?.severity, R.CONDITION_SEVERITY, 'mild'),
            medication: str(c?.medication, 400), emergencyInstructions: str(c?.emergencyInstructions, 400),
        });
    }
    const doctor = { name: str(h.doctor?.name, 120), phone: normalizePhone(str(h.doctor?.phone, 20)) };
    if (doctor.phone && !isPhone(doctor.phone)) refuse('The family doctor\'s phone number must be a valid 10-digit mobile number');
    const out = { allergies, conditions, medicines: str(h.medicines, 600), doctor, dietary: str(h.dietary, 600), notes: str(h.notes, 1200) };
    const any = allergies.length || conditions.length || out.medicines || doctor.name || doctor.phone || out.dietary || out.notes;
    return any ? out : null;
}

/** Write it into the Medical Room's record of a student just admitted. */
async function fromAdmission(req, studentId, h) {
    if (!h) return null;
    const { rows } = await pool.query(`SELECT ("modules"->>'medical')::boolean AS on FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)]);
    if (!rows[0]?.on) return null;
    const health = require('./medicalHealth');
    const out = { allergies: 0, conditions: 0, profile: false, failed: [] };
    for (const a of h.allergies) {
        try { await health.addHealthRecord(req, 'allergy', studentId, { ...a, parentNote: 'From the admission form' }, { source: 'parent', verified: false }); out.allergies += 1; }
        catch (e) { out.failed.push(`${a.allergen}: ${e.message}`); }
    }
    for (const c of h.conditions) {
        try { await health.addHealthRecord(req, 'condition', studentId, { ...c, parentNote: 'From the admission form' }, { source: 'parent', verified: false }); out.conditions += 1; }
        catch (e) { out.failed.push(`${c.condition}: ${e.message}`); }
    }
    const profile = {};
    if (h.doctor.name || h.doctor.phone) profile.doctor = { name: h.doctor.name, phone: h.doctor.phone };
    if (h.dietary) profile.dietaryRestrictions = h.dietary;
    const notes = [h.medicines ? `Medicines taken regularly (from the admission form): ${h.medicines}` : '', h.notes].filter(Boolean).join('\n');
    if (notes) profile.instructions = notes;
    if (Object.keys(profile).length) {
        try { await health.saveProfile(req, studentId, profile); out.profile = true; } catch (e) { out.failed.push(e.message); }
    }
    if (out.failed.length) console.error('[medical] admission health intake:', out.failed.join(' | '));
    // The room checks what the family wrote — a severe allergy first of all.
    const card = await require('./medicalAccess').studentCard(req.schoolId, studentId);
    const severe = h.allergies.filter((a) => ['severe', 'life_threatening'].includes(a.severity)).length;
    const parts = [out.allergies ? `${out.allergies} allerg${out.allergies === 1 ? 'y' : 'ies'}${severe ? ` (${severe} severe)` : ''}` : '', out.conditions ? `${out.conditions} condition${out.conditions === 1 ? '' : 's'}` : '', out.profile ? 'doctor / food / medicines' : ''].filter(Boolean);
    if (parts.length) {
        require('./medicalNotify').toStaff(req, {
            title: `New student — health details to check: ${card?.name || 'a student'}`,
            body: `${card?.name || 'A new student'}${card?.classLabel ? ` (${card.classLabel})` : ''} joined with ${parts.join(', ')} from the admission form. Check them with the family and mark them checked.`,
            setting: 'staffParentUpdates', urgent: severe > 0,
            link: { type: 'medical.student', entityId: String(studentId) },
        });
    }
    return out;
}

module.exports = { check, fromAdmission };
