'use strict';
/**
 * The Medical Room's messages to families in Hindi as well as English
 * (Oct 2026).
 *
 * Who reads what: a parent's own choice (ParentProfile.medicalLanguage —
 * 'en' | 'hi', set on their Medical Room page) or else the school's
 * (settings.noticeLanguage — 'en' | 'hi' | 'both'; 'both' sends the English
 * and the Hindi together).
 *
 * The English text stays what each sender already writes, word for word; the
 * Hindi comes from the templates here, with the same facts. What a member of
 * staff typed (a reason, a treatment, an outbreak notice) is passed through as
 * typed — only the school's own words are translated. Hindi verbs here avoid
 * the child's gender (passive and respectful forms), so one sentence fits
 * every child.
 */
const pool = require('../db/pool');

const S = (v) => String(v);
const LANGS = ['en', 'hi'];

const WHOM_HI = {
    eye: 'आँखों के डॉक्टर', ent: 'नाक-कान-गले (ENT) के डॉक्टर', dental: 'दाँतों के डॉक्टर', paediatric: 'बच्चों के डॉक्टर',
    nutrition: 'आहार विशेषज्ञ', skin: 'त्वचा रोग विशेषज्ञ', mental_health: 'काउंसलर', orthopaedic: 'हड्डी रोग विशेषज्ञ', other: 'विशेषज्ञ डॉक्टर',
};
const CHECKUP_HI = {
    general: 'सामान्य स्वास्थ्य', vision: 'आँखों की', dental: 'दाँतों की', hearing: 'सुनने की', height: 'लंबाई की', weight: 'वज़न की',
    bmi: 'लंबाई-वज़न (BMI) की', bp: 'रक्तचाप की', physical: 'शारीरिक',
};
const OUTCOME_HI = { normal: 'परिणाम: सामान्य।', attention: 'परिणाम: ध्यान देने की ज़रूरत है।', referred: 'परिणाम: डॉक्टर को दिखाने की सलाह दी गई है।' };
const CAMPAIGN_HI = {
    deworming: 'कृमि-मुक्ति दिवस', vitamin_a: 'विटामिन A अभियान', iron: 'आयरन और फ़ोलिक एसिड अभियान', vaccination: 'टीकाकरण अभियान',
    screening: 'स्वास्थ्य जाँच', dental: 'दाँतों की जाँच का शिविर', eye: 'आँखों की जाँच का शिविर', awareness: 'स्वास्थ्य वार्ता', other: 'स्वास्थ्य कार्यक्रम',
};
const URGENT_HI = { emergency: 'चिकित्सा आपातकाल', sent_home: 'घर भेजा जा रहा है', referred: 'अस्पताल रेफ़रल', incident: 'गंभीर घटना' };
const PLAN_STATUS_HI = { paused: 'दवा कुछ समय के लिए रोकी गई', cancelled: 'दवा बंद की गई', completed: 'दवा का कोर्स पूरा हुआ', active: 'दवा फिर से शुरू हुई' };
const opt = (v, f) => (v ? f(v) : '');

/** Hindi templates: key → (vars) → { title, body }. */
const HI = {
    visit_seen: (v) => ({
        title: `${v.name} की मेडिकल रूम में जाँच हुई`,
        body: `${v.time} बजे स्कूल के मेडिकल रूम में ${v.name} की जाँच हुई (${v.reason})।${opt(v.treatment, (t) => ` उपचार: ${t}।`)} इसके बाद उन्हें कक्षा में वापस भेजा गया।`,
    }),
    sent_home: (v) => ({
        title: `${v.name} को घर भेजा जा रहा है`,
        body: `${v.time} बजे स्कूल के मेडिकल रूम में ${v.name} की जाँच हुई (${v.reason}) और उन्हें घर भेजा जा रहा है।${opt(v.treatment, (t) => ` दिया गया उपचार: ${t}।`)} कृपया ${v.name} को स्कूल कार्यालय से ले जाएँ या स्कूल से संपर्क करें।`,
    }),
    emergency: (v) => ({
        title: `चिकित्सा आपातकाल — ${v.name}`,
        body: `स्कूल के मेडिकल रूम में ${v.name} को तुरंत देखभाल दी जा रही है (${v.reason})। स्कूल आपसे संपर्क करेगा। अगर हमसे बात न हुई हो, तो कृपया स्कूल को फ़ोन करें।`,
    }),
    referred: (v) => ({
        title: `अस्पताल रेफ़रल — ${v.name}`,
        body: `${v.name} को स्कूल के मेडिकल रूम से ${v.hospital || 'अस्पताल'} भेजा गया है${opt(v.reason, (r) => ` (${r})`)}${opt(v.transport, (t) => `, ${t} से`)}। कृपया तुरंत स्कूल से संपर्क करें।`,
    }),
    medicine_given: (v) => ({
        title: 'स्कूल में दवा दी गई',
        body: `${v.time} बजे स्कूल के मेडिकल रूम में ${v.name} को दवा दी गई: ${v.medicine}${opt(v.dose, (d) => ` (${d})`)}।`,
    }),
    medicine_refused: (v) => ({
        title: 'स्कूल में दवा नहीं ली गई',
        body: `${v.name} ने आज ${v.medicine}${opt(v.dose, (d) => ` (${d})`)} नहीं ली${opt(v.note, (n) => `: ${n}`)}।`,
    }),
    vaccination_due: (v) => ({
        title: `टीका लगवाने का समय — ${v.name}`,
        body: `${v.name} का ${v.vaccine}${opt(v.dose, (d) => ` (${d})`)} टीका ${v.due} को लगना है। टीका लगने के बाद कृपया उसका प्रमाणपत्र स्कूल के मेडिकल रूम में भेजें।`,
    }),
    vaccination_overdue: (v) => ({
        title: `टीका बाकी है — ${v.name}`,
        body: `${v.name} का ${v.vaccine}${opt(v.dose, (d) => ` (${d})`)} टीका ${v.due} को लगना था। अगर टीका लग चुका है, तो कृपया उसका प्रमाणपत्र स्कूल के मेडिकल रूम में भेजें; अगर नहीं, तो अपने डॉक्टर से बात करें।`,
    }),
    schedule_due: (v) => ({
        title: `टीका लगवाने का समय — ${v.name}`,
        body: `स्कूल की टीकाकरण सूची के अनुसार ${v.name} का ${v.label} ${v.now ? 'अब लगना है' : `${v.due} को लगना है`}। टीका लगने के बाद कृपया उसका प्रमाणपत्र स्कूल के मेडिकल रूम में भेजें।`,
    }),
    consent_request: (v) => ({
        title: `मेडिकल सहमति ${v.year || 'इस वर्ष'} — ${v.name}`,
        body: `कृपया स्कूल के मेडिकल रूम को बताएँ कि इस वर्ष वह ${v.name} के लिए क्या कर सकता है: आपातकालीन उपचार, पैरासिटामॉल जैसी रोज़मर्रा की दवाएँ, और भी बहुत कुछ। ऐप में इसमें एक मिनट लगता है।`,
    }),
    referral: (v) => ({
        title: `कृपया ${WHOM_HI[v.specialty] || WHOM_HI.other} को दिखाएँ — ${v.name}`,
        body: `स्कूल का मेडिकल रूम सुझाव देता है कि ${v.name} को ${v.urgent ? 'जल्द से जल्द' : `${v.due} तक`} ${WHOM_HI[v.specialty] || WHOM_HI.other} को दिखाया जाए: ${v.reason} डॉक्टर ने क्या कहा, कृपया स्कूल को बताएँ — यह मेडिकल रूम पेज से किया जा सकता है।`,
    }),
    referral_reminder: (v) => ({
        title: `याद दिलाना: ${WHOM_HI[v.specialty] || WHOM_HI.other} — ${v.name}`,
        body: `स्कूल ने सुझाव दिया था कि ${v.name} को${opt(v.due, (d) => ` ${d} तक`)} ${WHOM_HI[v.specialty] || WHOM_HI.other} को दिखाया जाए: ${v.reason} कृपया स्कूल को बताएँ कि डॉक्टर ने क्या कहा, या कि आपने समय ले लिया है।`,
    }),
    checkup_done: (v) => ({
        title: `स्वास्थ्य जाँच पूरी हुई — ${v.name}`,
        body: `${v.date} को स्कूल में ${v.name} की ${CHECKUP_HI[v.type] || 'स्वास्थ्य'} जाँच हुई।${opt(OUTCOME_HI[v.outcome], (o) => ` ${o}`)}${opt(v.recommendation, (r) => ` सलाह: ${r}`)}`,
    }),
    campaign: (v) => {
        const kind = CAMPAIGN_HI[v.kind] || CAMPAIGN_HI.other;
        const by = v.by ? `${v.by} तक` : 'उस दिन से पहले';
        const about = v.about ? ` ${v.about}` : '';
        if (v.consent === 'opt_in') return { title: `${kind} — ${v.name}`, body: `${v.when} स्कूल में ${kind}: ${v.what}।${about} अगर आप चाहते हैं कि ${v.name} इसमें भाग ले, तो कृपया ${by} मेडिकल रूम पेज पर "हाँ" चुनें।` };
        if (v.consent === 'opt_out') return { title: `${kind} — ${v.name}`, body: `${v.when} स्कूल में ${kind}: ${v.name} को ${v.what} दी जाएगी।${about} अगर आप यह नहीं चाहते, तो कृपया ${by} मेडिकल रूम पेज पर "नहीं" चुनें।` };
        return { title: `${kind} — ${v.name}`, body: `${v.when} स्कूल में ${kind}: ${v.what}।${about}` };
    },
    incident: (v) => ({
        title: `स्कूल में घटना — ${v.name}`,
        body: `${v.when} स्कूल में ${v.name} के साथ एक घटना हुई: ${v.what}${opt(v.firstAid, (f) => `। प्राथमिक उपचार: ${f}`)}। अधिक जानकारी के लिए मेडिकल रूम पेज देखें या स्कूल से संपर्क करें।`,
    }),
    urgent_reminder: (v) => ({
        title: `कृपया जवाब दें — ${v.name}`,
        body: `स्कूल अभी भी ${v.name} के बारे में आपके जवाब की प्रतीक्षा कर रहा है (${URGENT_HI[v.kind] || 'ज़रूरी सूचना'})। कृपया मेडिकल रूम पेज खोलकर जवाब दें, या स्कूल को फ़ोन करें${opt(v.phone, (p) => ` (${p})`)}।`,
    }),
    plan_authorise: (v) => ({
        title: `कृपया दवा की अनुमति दें — ${v.name}`,
        body: `मेडिकल रूम स्कूल में ${v.name} को ${v.medicine} (${v.dosage}, ${v.when}) देना चाहता है। जब तक आप मेडिकल रूम पेज पर अनुमति नहीं देते, यह दवा नहीं दी जाएगी।`,
    }),
    plan_status: (v) => ({
        title: `${PLAN_STATUS_HI[v.status] || 'दवा की योजना बदली'} — ${v.name}`,
        body: `स्कूल में ${v.name} की दवा ${v.medicine}: ${PLAN_STATUS_HI[v.status] || 'योजना बदली गई है'}।${opt(v.note, (n) => ` ${n}`)}`,
    }),
    plan_changed: (v) => ({
        title: `दवा की योजना बदली — ${v.name}`,
        body: `स्कूल में ${v.name} को ${v.medicine} की खुराक अब इस तरह दी जाएगी: ${v.dosage}, ${v.when}।`,
    }),
    campaign_result: (v) => ({
        title: `${CAMPAIGN_HI[v.kind] || CAMPAIGN_HI.other} — ${v.name}`,
        body: v.outcome === 'given'
            ? `आज स्कूल में ${v.name} को ${v.what} की खुराक दी गई (${v.title})।`
            : v.outcome === 'absent'
                ? `${v.title}: आज स्कूल में ${v.name} की उपस्थिति नहीं थी, इसलिए ${v.what} की खुराक नहीं दी जा सकी।${opt(v.mopUp, (d) => ` ${d} को फिर से मौका मिलेगा।`)}`
                : `${v.title}: आज ${v.name} को ${v.what} की खुराक नहीं दी गई${opt(v.note, (n) => ` (${n})`)}।${opt(v.mopUp, (d) => ` ${d} को फिर से मौका मिलेगा।`)}`,
    }),
    checkup_scheduled: (v) => ({
        title: `स्वास्थ्य जाँच ${v.date} को — ${v.name}`,
        body: `मेडिकल रूम ने ${v.date} को स्कूल में ${v.name} की ${CHECKUP_HI[v.type] || 'स्वास्थ्य'} जाँच रखी है। परिणाम आपको बताए जाएँगे।`,
    }),
    checkup_cancelled: (v) => ({
        title: `स्वास्थ्य जाँच रद्द — ${v.name}`,
        body: `${v.date} को होने वाली ${v.name} की ${CHECKUP_HI[v.type] || 'स्वास्थ्य'} जाँच रद्द कर दी गई है।`,
    }),
    dose_correction: (v) => ({
        title: `सुधार — ${v.name}`,
        body: `${v.name} के लिए दर्ज की गई ${v.medicine} की खुराक गलती से दर्ज हुई थी और रिकॉर्ड से हटा दी गई है।`,
    }),
    supply_received: (v) => ({
        title: `दवा मिल गई — ${v.name}`,
        body: `मेडिकल रूम को ${v.name} के लिए ${v.medicine} की ${v.quantity} खुराक/मात्रा मिल गई है।`,
    }),
    supply_returned: (v) => ({
        title: `दवा लौटाई गई — ${v.name}`,
        body: `मेडिकल रूम ने ${v.name} की ${v.medicine} की ${v.quantity} मात्रा लौटा दी है।`,
    }),
    restriction_ended: (v) => ({
        title: `स्कूल में: ${v.text} — अब ज़रूरी नहीं`,
        body: `मेडिकल रूम ने ${v.name} के शिक्षकों को बता दिया है कि यह अब ज़रूरी नहीं है: ${v.text}।`,
    }),
    dose_due_student: (v) => ({
        title: 'दवा का समय',
        body: `आपकी दवा का समय हो गया है: कृपया अभी मेडिकल रूम जाएँ (${v.time})।`,
    }),
    restriction_student: (v) => ({
        title: 'मेडिकल रूम से',
        body: `${v.text}${opt(v.until, (u) => ` (${u} तक)`)}।`,
    }),
};

/** The rendered message in one language ('both' joins the English and the Hindi). */
function render(key, vars, lang, english) {
    if (lang === 'en' || !HI[key]) return english;
    const hi = HI[key](vars || {});
    if (lang === 'hi') return hi;
    return { title: `${english.title} / ${hi.title}`, body: `${english.body}\n\n${hi.body}` };
}

/** Each reader's language: their own choice, else the school's. → Map(lang → [userIds]) */
async function groups(schoolId, userIds) {
    const ids = [...new Set((userIds || []).map(S))];
    const out = new Map();
    if (!ids.length) return out;
    const s = await require('./medicalSettings').get(schoolId);
    const fallback = ['en', 'hi', 'both'].includes(s.noticeLanguage) ? s.noticeLanguage : 'en';
    const { rows } = await pool.query(`SELECT "user"::text AS id, "medicalLanguage" AS lang FROM "parentprofiles" WHERE "user" = ANY($1::uuid[])`, [ids]).catch(() => ({ rows: [] }));
    const mine = new Map(rows.map((r) => [r.id, r.lang]));
    for (const id of ids) {
        const lang = LANGS.includes(mine.get(id)) ? mine.get(id) : fallback;
        if (!out.has(lang)) out.set(lang, []);
        out.get(lang).push(id);
    }
    return out;
}

module.exports = { HI, WHOM_HI, render, groups, LANGS };
