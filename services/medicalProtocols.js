'use strict';
/**
 * What to do for the common complaints, and how urgent a case is (Oct 2026).
 *
 * Triage — a school version of the five-colour scales hospitals use:
 *   red     Immediate     call an ambulance now
 *   orange  Very urgent   treat now, call the parents, think about hospital
 *   yellow  Urgent        see within 15 minutes
 *   green   Standard      see within the hour
 *   blue    Minor         advice, rest
 * Each colour also sets how often the student is looked at again while they
 * are in the room (RECHECK); a head injury is looked at every 15 minutes for
 * its first hour whatever its colour.
 *
 * Protocols are general first-aid guidance of the kind the school's own
 * first-aid training teaches — the steps, and the RED FLAGS that make a case
 * more urgent. They support the nurse's judgement and the school doctor's
 * standing orders; they do not replace either. A red flag ticked on a visit
 * raises its suggested colour; the nurse decides.
 *
 * Each protocol: { key, title, match (words in the reason or symptoms),
 *   base (the colour it starts at), redFlags [{ key, label, level }],
 *   steps [], sendHomeIf [], returnIf [], recheck (minutes, optional),
 *   exclusion (the return-to-school rule it usually leads to, optional),
 *   parentAdvice (sent to the parents when the student leaves, optional) }
 */

const TRIAGE = {
    red:    { label: 'Immediate',   tone: 'red',    rank: 5, recheck: 5,    hint: 'Call an ambulance now' },
    orange: { label: 'Very urgent', tone: 'orange', rank: 4, recheck: 10,   hint: 'Treat now, call the parents, think about hospital' },
    yellow: { label: 'Urgent',      tone: 'amber',  rank: 3, recheck: 15,   hint: 'See within 15 minutes' },
    green:  { label: 'Standard',    tone: 'green',  rank: 2, recheck: 30,   hint: 'See within the hour' },
    blue:   { label: 'Minor',       tone: 'blue',   rank: 1, recheck: null, hint: 'Advice and rest' },
};
const higher = (a, b) => ((TRIAGE[a]?.rank || 0) >= (TRIAGE[b]?.rank || 0) ? a : b);

const P = [
    {
        key: 'head_injury', title: 'Head injury', base: 'yellow', recheck: 15, exclusion: null,
        match: ['head', 'bump', 'concussion', 'hit his head', 'hit her head', 'knocked out', 'skull', 'forehead'],
        redFlags: [
            { key: 'loc', label: 'Lost consciousness, even briefly', level: 'red' },
            { key: 'seizure', label: 'A fit or seizure since the injury', level: 'red' },
            { key: 'avpu', label: 'Drowsy, confused or hard to wake', level: 'red' },
            { key: 'pupils', label: 'Pupils unequal in size', level: 'red' },
            { key: 'fluid', label: 'Clear fluid or blood from the nose or ears', level: 'red' },
            { key: 'weakness', label: 'Weakness, numbness or trouble speaking or walking', level: 'red' },
            { key: 'vomit2', label: 'Vomited more than once', level: 'orange' },
            { key: 'amnesia', label: 'Cannot remember what happened before or after', level: 'orange' },
            { key: 'headache', label: 'Headache getting worse', level: 'orange' },
            { key: 'neck', label: 'Neck pain or the injury came from a fall from height', level: 'orange' },
        ],
        steps: [
            'Keep the student still and lying or sitting comfortably; do not let them go back to play.',
            'Apply a cold compress to a bump for 10–15 minutes.',
            'Check and record: alert, pupils, headache, vomiting — every 15 minutes for the first hour.',
            'Tell the parents about every head injury, however small.',
            'Any red flag: call an ambulance; keep the head and neck still if a neck injury is possible.',
        ],
        sendHomeIf: ['Headache that does not settle', 'Vomited once', 'Feeling unwell after an hour of observation'],
        returnIf: ['Alert, no headache or only a mild one that is easing, no vomiting, after at least 30 minutes of observation'],
        parentAdvice: 'Watch for these signs for the next 48 hours and go to hospital at once if you see any: vomiting more than once, a headache that gets worse, drowsiness or being hard to wake, confusion, a fit, weakness or numbness, trouble seeing or speaking, clear fluid from the nose or ears. Rest and no sport until all symptoms have gone.',
    },
    {
        key: 'fever', title: 'Fever', base: 'green', exclusion: 'fever',
        match: ['fever', 'temperature', 'hot', 'chills', 'shivering'],
        redFlags: [
            { key: 'rash', label: 'A rash that does not fade when a glass is pressed on it', level: 'red' },
            { key: 'stiff', label: 'Stiff neck or dislikes bright light', level: 'red' },
            { key: 'breath', label: 'Breathing fast or with difficulty', level: 'orange' },
            { key: 'drowsy', label: 'Very drowsy or floppy', level: 'red' },
            { key: 'high', label: 'Temperature 39.5 °C (103 °F) or more', level: 'orange' },
        ],
        steps: [
            'Record the temperature and the time; recheck in 30 minutes.',
            'Give fluids; remove extra clothing; rest in a cool place.',
            'Fever-reducing medicine only on a care plan or the parents’ consent, checking the last dose given at home.',
            'Call the parents to collect a child with a fever of 38 °C (100.4 °F) or more.',
        ],
        sendHomeIf: ['Temperature 38 °C (100.4 °F) or more'],
        returnIf: ['Temperature normal on recheck and feeling well'],
    },
    {
        key: 'breathing', title: 'Asthma / breathing difficulty', base: 'yellow', recheck: 10, exclusion: null,
        match: ['asthma', 'wheez', 'breath', 'breathless', 'inhaler', 'chest tight', 'cough'],
        redFlags: [
            { key: 'speak', label: 'Too breathless to speak in sentences', level: 'red' },
            { key: 'blue', label: 'Blue or grey lips', level: 'red' },
            { key: 'noeffect', label: 'No better after the reliever inhaler', level: 'red' },
            { key: 'tired', label: 'Exhausted, drowsy or confused', level: 'red' },
            { key: 'spo2', label: 'Oxygen saturation below 92%', level: 'orange' },
        ],
        steps: [
            'Sit the student up, leaning slightly forward; stay calm and keep them calm.',
            'Reliever inhaler (blue) through a spacer: 1 puff every 30–60 seconds, up to 10 puffs, as the student’s plan says.',
            'No better after 10 puffs, or worse at any point: call an ambulance and repeat the inhaler while waiting.',
            'Record the time and number of puffs; tell the parents.',
        ],
        sendHomeIf: ['Needed the reliever more than once', 'Still wheezy after treatment'],
        returnIf: ['Breathing normally and able to talk, 15 minutes after the reliever'],
    },
    {
        key: 'allergic', title: 'Allergic reaction', base: 'yellow', recheck: 5, exclusion: null,
        match: ['allerg', 'hives', 'rash', 'swelling', 'sting', 'itch', 'anaphyla', 'bee', 'wasp'],
        redFlags: [
            { key: 'airway', label: 'Swelling of the tongue or throat, hoarse voice, trouble swallowing', level: 'red' },
            { key: 'breathing', label: 'Wheeze, noisy breathing or persistent cough', level: 'red' },
            { key: 'faint', label: 'Pale, floppy, dizzy or collapsed', level: 'red' },
            { key: 'spreading', label: 'Rash spreading fast or swelling of the face', level: 'orange' },
        ],
        steps: [
            'Any sign of anaphylaxis: give the adrenaline auto-injector now (outer thigh), call an ambulance, note the time.',
            'Lie the student flat with legs raised (sit up if breathing is hard); do not let them stand or walk.',
            'A second auto-injector after 5 minutes if there is no improvement.',
            'Mild reaction (rash only): antihistamine as the care plan or consent allows; watch for 30 minutes.',
            'A sting: scrape the sting out sideways; cold compress.',
        ],
        sendHomeIf: ['Any adrenaline given (goes to hospital)', 'A reaction that needed medicine'],
        returnIf: ['A mild local reaction that has settled after 30 minutes'],
    },
    {
        key: 'fainting', title: 'Fainting / dizziness', base: 'yellow', exclusion: null,
        match: ['faint', 'dizz', 'collaps', 'blackout', 'light-headed', 'lightheaded'],
        redFlags: [
            { key: 'exercise', label: 'Fainted during exercise', level: 'orange' },
            { key: 'chest', label: 'Chest pain or a racing heartbeat before fainting', level: 'orange' },
            { key: 'long', label: 'Unconscious for more than a minute', level: 'red' },
            { key: 'injury', label: 'Hit the head when falling', level: 'orange' },
        ],
        steps: [
            'Lie the student down with legs raised; loosen tight clothing; fresh air.',
            'Check breathing and pulse; record the readings.',
            'When recovered, sit up slowly; small drink and a snack if they have not eaten.',
            'Check blood sugar for a student with diabetes.',
        ],
        sendHomeIf: ['Fainted more than once today', 'Still dizzy after 30 minutes'],
        returnIf: ['Fully recovered after 20–30 minutes, readings normal'],
    },
    {
        key: 'seizure', title: 'Seizure / fit', base: 'orange', recheck: 5, exclusion: null,
        match: ['seizure', 'fit', 'convuls', 'epilep'],
        redFlags: [
            { key: 'five', label: 'Seizure lasting more than 5 minutes, or one after another', level: 'red' },
            { key: 'first', label: 'First seizure the student has had', level: 'red' },
            { key: 'injury', label: 'Injured during the seizure', level: 'orange' },
            { key: 'breathing', label: 'Breathing difficulty after the seizure', level: 'red' },
            { key: 'water', label: 'Happened in water', level: 'red' },
        ],
        steps: [
            'Note the time it started. Protect the head; move hard objects away. Do not restrain or put anything in the mouth.',
            'Follow the student’s seizure care plan (rescue medicine and when to give it).',
            'When it stops: recovery position, check breathing, stay with them.',
            'Call an ambulance for a seizure over 5 minutes, a first seizure, or as the care plan says.',
        ],
        sendHomeIf: ['Any seizure — the parents decide with the care plan'],
        returnIf: ['Only if the care plan says so and the student has fully recovered'],
    },
    {
        key: 'diabetes_low', title: 'Low blood sugar (diabetes)', base: 'orange', recheck: 15, exclusion: null,
        match: ['hypo', 'diabet', 'blood sugar', 'sugar low', 'shaky', 'sweaty'],
        redFlags: [
            { key: 'unconscious', label: 'Drowsy, unconscious or fitting', level: 'red' },
            { key: 'cannot', label: 'Cannot swallow safely', level: 'red' },
            { key: 'repeat', label: 'Still low after two treatments', level: 'orange' },
        ],
        steps: [
            'Check blood sugar. Below 70 mg/dL (4 mmol/L): 15–20 g of fast sugar (juice, glucose tablets) — sitting down.',
            'Recheck after 10–15 minutes; repeat the fast sugar if still low.',
            'When above 70: a slower snack (biscuits, sandwich).',
            'Unconscious or cannot swallow: nothing by mouth — recovery position, glucagon if prescribed, call an ambulance.',
        ],
        sendHomeIf: ['Needed more than two treatments', 'Not feeling right after recovering'],
        returnIf: ['Blood sugar above 100 mg/dL (5.5 mmol/L) after a snack and feeling well'],
    },
    {
        key: 'nosebleed', title: 'Nosebleed', base: 'blue', exclusion: null,
        match: ['nose', 'nosebleed', 'epistaxis'],
        redFlags: [
            { key: 'twenty', label: 'Still bleeding after 20 minutes of pressure', level: 'orange' },
            { key: 'injury', label: 'After a blow to the face or head', level: 'yellow' },
            { key: 'heavy', label: 'Very heavy bleeding, pale or dizzy', level: 'orange' },
        ],
        steps: [
            'Sit up, lean forward (not back); pinch the soft part of the nose for 10–15 minutes without letting go.',
            'Breathe through the mouth; spit out blood rather than swallow it.',
            'Cold compress on the bridge of the nose.',
            'No blowing or picking the nose for some hours.',
        ],
        sendHomeIf: ['Bleeds again after stopping'],
        returnIf: ['Bleeding stopped for 10 minutes'],
    },
    {
        key: 'wound', title: 'Cut / wound', base: 'green', exclusion: null,
        match: ['cut', 'wound', 'bleed', 'graze', 'scrape', 'laceration', 'blood'],
        redFlags: [
            { key: 'spurting', label: 'Spurting blood or not stopping after 10 minutes of pressure', level: 'red' },
            { key: 'gaping', label: 'Deep or gaping — may need stitches', level: 'orange' },
            { key: 'object', label: 'Something stuck in the wound', level: 'orange' },
            { key: 'face', label: 'On the face, or from a bite', level: 'yellow' },
        ],
        steps: [
            'Gloves on. Firm pressure with a clean pad; raise the injured part.',
            'When bleeding stops: clean with water, dry, cover with a dressing.',
            'Do not remove an embedded object — pad around it.',
            'Note the tetanus record if the wound is dirty.',
        ],
        sendHomeIf: ['May need stitches (to a clinic)'],
        returnIf: ['Bleeding stopped and dressed'],
    },
    {
        key: 'sprain', title: 'Sprain / limb injury', base: 'green', exclusion: null,
        match: ['sprain', 'ankle', 'wrist', 'twist', 'fracture', 'broken', 'swollen', 'limb', 'knee', 'finger'],
        redFlags: [
            { key: 'deformed', label: 'Bent out of shape or bone showing', level: 'red' },
            { key: 'cannot', label: 'Cannot put any weight on it or move it', level: 'orange' },
            { key: 'numb', label: 'Numb, cold or pale below the injury', level: 'orange' },
        ],
        steps: [
            'Rest the injured part; support it in the most comfortable position.',
            'Cold compress (wrapped) for 15–20 minutes.',
            'Raise it if possible; a light support bandage only if it does not increase pain.',
            'Possible fracture: do not move it — splint or support, call the parents (or an ambulance for a large bone).',
        ],
        sendHomeIf: ['Possible fracture', 'Cannot walk on it'],
        returnIf: ['Can move it and bear weight with little pain'],
    },
    {
        key: 'burn', title: 'Burn / scald', base: 'yellow', exclusion: null,
        match: ['burn', 'scald', 'hot water', 'chemical'],
        redFlags: [
            { key: 'large', label: 'Larger than the student’s hand, or on the face, hands, feet or genitals', level: 'orange' },
            { key: 'deep', label: 'White, charred or painless skin', level: 'red' },
            { key: 'chemical', label: 'Chemical or electrical burn', level: 'orange' },
            { key: 'airway', label: 'Burn to the mouth or breathed in smoke', level: 'red' },
        ],
        steps: [
            'Cool under cool running water for 20 minutes (not ice); remove jewellery near the burn.',
            'Cover loosely with cling film or a clean non-fluffy dressing.',
            'Do not burst blisters or put creams on it.',
            'Chemical: brush off powder, then rinse for 20 minutes.',
        ],
        sendHomeIf: ['Any blistered burn bigger than a coin'],
        returnIf: ['A small red burn that has been cooled and is comfortable'],
    },
    {
        key: 'stomach', title: 'Stomach ache / vomiting / diarrhoea', base: 'green', exclusion: 'vomiting',
        match: ['stomach', 'tummy', 'abdom', 'vomit', 'nausea', 'diarr', 'loose motion', 'sick'],
        redFlags: [
            { key: 'severe', label: 'Severe pain, or pain in the lower right side', level: 'orange' },
            { key: 'rigid', label: 'Belly hard, or pain on walking or jumping', level: 'orange' },
            { key: 'blood', label: 'Blood in the vomit or stool', level: 'orange' },
            { key: 'dehydrated', label: 'Dry mouth, no urine for hours, very weak', level: 'orange' },
            { key: 'injury', label: 'After a blow to the belly', level: 'orange' },
        ],
        steps: [
            'Rest lying on the side; sips of water or oral rehydration.',
            'Bucket nearby; gloves for cleaning up; hand washing.',
            'A child who has vomited or had diarrhoea goes home.',
        ],
        sendHomeIf: ['Vomited or diarrhoea at school', 'Pain not settling after 30 minutes'],
        returnIf: ['Pain settled after rest and a drink, no vomiting'],
    },
    {
        key: 'headache', title: 'Headache', base: 'blue', exclusion: null,
        match: ['headache', 'migraine', 'head ache', 'head pain'],
        redFlags: [
            { key: 'worst', label: 'Sudden, severe — "the worst ever"', level: 'red' },
            { key: 'stiff', label: 'With stiff neck, fever or a rash', level: 'red' },
            { key: 'vision', label: 'With vision changes, weakness or confusion', level: 'red' },
            { key: 'injury', label: 'After a head injury', level: 'yellow' },
        ],
        steps: [
            'Rest in a quiet, dim place; a drink of water; ask when they last ate.',
            'Pain relief only on a care plan or consent.',
            'Recheck after 30 minutes.',
        ],
        sendHomeIf: ['Not better after rest and fluids'],
        returnIf: ['Eased after 20–30 minutes of rest'],
    },
    {
        key: 'eye', title: 'Eye injury', base: 'yellow', exclusion: null,
        match: ['eye', 'vision'],
        redFlags: [
            { key: 'chemical', label: 'A chemical in the eye', level: 'red' },
            { key: 'penetrating', label: 'Something stuck in the eye, or a cut to the eye', level: 'red' },
            { key: 'vision', label: 'Loss of vision or double vision', level: 'red' },
            { key: 'blow', label: 'A hard blow to the eye', level: 'orange' },
        ],
        steps: [
            'Chemical: rinse with clean running water for 15–20 minutes, from the inner corner outwards; call an ambulance.',
            'Dust or grit: blink; rinse with water. Do not rub.',
            'Something stuck: do not remove — cover both eyes lightly, keep still.',
            'A blow: cold compress, no pressure on the eye.',
        ],
        sendHomeIf: ['Eye still painful or red after rinsing'],
        returnIf: ['Comfortable and seeing normally after rinsing'],
    },
    {
        key: 'tooth', title: 'Tooth / mouth injury', base: 'green', exclusion: null,
        match: ['tooth', 'teeth', 'dental', 'mouth', 'lip'],
        redFlags: [
            { key: 'knocked', label: 'An adult tooth knocked out', level: 'orange' },
            { key: 'jaw', label: 'Jaw pain or the teeth do not meet', level: 'orange' },
        ],
        steps: [
            'Bleeding: bite on a clean pad for 10 minutes.',
            'A knocked-out adult tooth: hold it by the crown (not the root), do not scrub; store it in milk or the student’s saliva; to a dentist within 30 minutes.',
            'A baby tooth: do not put it back.',
        ],
        sendHomeIf: ['A knocked-out adult tooth (to the dentist now)'],
        returnIf: ['Minor bleeding stopped'],
    },
    {
        key: 'menstrual', title: 'Period pain', base: 'blue', exclusion: null,
        match: ['period', 'menstru', 'cramp'],
        redFlags: [
            { key: 'severe', label: 'Severe pain with vomiting or fainting', level: 'orange' },
            { key: 'heavy', label: 'Very heavy bleeding, pale or dizzy', level: 'orange' },
        ],
        steps: ['Rest; a hot water bottle or heat pad; a drink.', 'Pain relief only on consent.', 'Sanitary supplies; privacy.'],
        sendHomeIf: ['Pain stopping the student from taking part after rest'],
        returnIf: ['Pain eased after rest'],
    },
    {
        key: 'anxiety', title: 'Anxiety / panic', base: 'blue', exclusion: null,
        match: ['anxiety', 'panic', 'anxious', 'stress', 'crying', 'upset'],
        redFlags: [
            { key: 'harm', label: 'Talks about harming themselves', level: 'red' },
            { key: 'chest', label: 'Chest pain or fainting', level: 'orange' },
        ],
        steps: [
            'A quiet place with someone they trust; speak calmly.',
            'Slow breathing: in for 4, hold for 2, out for 6.',
            'Talk about what happened when they are calm; tell the counsellor if there is one.',
        ],
        sendHomeIf: ['Cannot settle after 30 minutes'],
        returnIf: ['Calm and ready'],
    },
];
const BY_KEY = Object.fromEntries(P.map((p) => [p.key, p]));

/** The protocols whose words appear in the reason or symptoms, best first. */
function suggest(reason = '', symptoms = '') {
    const text = `${reason} ${symptoms}`.toLowerCase();
    return P
        .map((p) => ({ key: p.key, hits: p.match.filter((w) => text.includes(w)).length }))
        .filter((x) => x.hits)
        .sort((a, b) => b.hits - a.hits)
        .map((x) => x.key);
}

/**
 * The colour a visit should be, and why: the protocol's starting colour, its
 * ticked red flags, and the flags on the latest reading.
 */
function suggestTriage({ protocol = null, reading = null } = {}) {
    let level = null;
    const reasons = [];
    const p = protocol?.key ? BY_KEY[protocol.key] : null;
    if (p) { level = p.base; reasons.push(`${p.title}`); }
    for (const k of protocol?.redFlags || []) {
        const f = p?.redFlags.find((x) => x.key === k);
        if (f) { level = level ? higher(level, f.level) : f.level; reasons.push(f.label); }
    }
    for (const f of reading?.flags || []) {
        const lvl = f.triage || (f.level === 'critical' ? 'orange' : f.level === 'warning' ? 'yellow' : null);
        if (lvl) { level = level ? higher(level, lvl) : lvl; reasons.push(f.label); }
    }
    return { level: level || 'green', reasons: [...new Set(reasons)] };
}

/** Minutes until the next look at a student in the room (null = no set time). */
function recheckMinutes({ level, protocol, arrivedAt }) {
    const p = protocol?.key ? BY_KEY[protocol.key] : null;
    const byLevel = TRIAGE[level]?.recheck ?? null;
    if (p?.key === 'head_injury') {
        // Every 15 minutes for the first hour, then every 30 — sooner when the colour asks for it.
        const firstHour = !arrivedAt || Date.now() - new Date(arrivedAt).getTime() <= 60 * 60000;
        const base = firstHour ? 15 : 30;
        return ['red', 'orange'].includes(level) ? Math.min(byLevel, base) : base;
    }
    if (p?.recheck) return byLevel == null ? p.recheck : Math.min(byLevel, p.recheck);
    return byLevel;
}

const describe = () => P.map(({ match, ...rest }) => rest);

module.exports = { TRIAGE, PROTOCOLS: P, BY_KEY, suggest, suggestTriage, recheckMinutes, higher, describe };
