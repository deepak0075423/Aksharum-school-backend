'use strict';
/**
 * Video Learning — the provider registry.
 *
 * Books, chapters, releases, the player and the tracker never name a storage
 * service. They hold a video whose `provider` is one of the keys below, and
 * ask this file for it; each provider answers the same few questions (where
 * does an upload go, is it processed yet, what does the player open). Adding
 * or swapping a provider is a new file here and nothing anywhere else.
 *
 *   file providers   local, s3      upload → process → signed playback
 *   embed providers  vimeo, youtube linked by id, played in their own player
 *
 * A provider's configuration is its stored settings and sealed secrets, with
 * an environment variable of the same purpose laid over them (so a deployment
 * can keep every credential out of the database if it prefers).
 */
const { M, bad, HttpError } = require('../common');
const secrets = require('../secrets');
const local = require('./local');
const s3 = require('./s3');
const { vimeo, youtube } = require('./embeds');

const PROVIDERS = { local, s3, vimeo, youtube };
// Before anyone has opened the settings: the ones that need no credentials are on.
const INITIAL = { local: { enabled: true, isDefault: true }, s3: { enabled: false }, vimeo: { enabled: true }, youtube: { enabled: true } };

const get = (name) => {
    const p = PROVIDERS[name];
    if (!p) throw bad('Unknown video provider');
    return p;
};

async function rows() {
    const found = await M.provider.find({}).lean();
    const by = new Map(found.map((r) => [r.provider, r]));
    const anyDefault = found.some((r) => r.isDefault);
    return Object.keys(PROVIDERS).map((name) => by.get(name)
        || { provider: name, settings: {}, secrets: {}, ...INITIAL[name], isDefault: !anyDefault && !!INITIAL[name].isDefault, unsaved: true });
}

const envOf = (field) => (field.env && process.env[field.env] !== undefined && process.env[field.env] !== '' ? process.env[field.env] : undefined);

/** The working configuration of one provider — secrets opened. Never leaves the server. */
function resolve(provider, row) {
    const cfg = { enabled: !!row.enabled, isDefault: !!row.isDefault };
    for (const f of provider.settingsFields) cfg[f.key] = envOf(f) ?? row.settings?.[f.key] ?? '';
    for (const f of provider.secretFields) cfg[f.key] = envOf(f) ?? (row.secrets?.[f.key] ? secrets.open(row.secrets[f.key]) : '');
    return cfg;
}

async function config(name) {
    const provider = get(name);
    const row = (await rows()).find((r) => r.provider === name);
    return resolve(provider, row);
}

/** What the settings screen is shown: never a secret, only whether one is set and where from. */
async function describe() {
    return (await rows()).map((row) => {
        const provider = PROVIDERS[row.provider];
        const cfg = resolve(provider, row);
        const st = provider.status(cfg);
        return {
            provider: provider.name, label: provider.label, kind: provider.kind,
            enabled: !!row.enabled, isDefault: !!row.isDefault,
            configured: st.configured, missing: st.missing, notes: st.notes || [],
            usable: !!row.enabled && st.configured,
            settingsFields: provider.settingsFields.map((f) => ({
                key: f.key, label: f.label, placeholder: f.placeholder || '', help: f.help || '', type: f.type || 'text', required: !!f.required,
                value: f.type === 'boolean' ? /^(1|true|yes)$/i.test(String(cfg[f.key])) || cfg[f.key] === true : String(cfg[f.key] ?? ''),
                fromEnv: envOf(f) !== undefined,
            })),
            secretFields: provider.secretFields.map((f) => ({
                key: f.key, label: f.label, help: f.help || '', multiline: !!f.multiline, required: !!f.required,
                isSet: !!cfg[f.key], fromEnv: envOf(f) !== undefined,
            })),
            lastCheckedAt: row.lastCheckedAt || null, lastCheckOk: row.lastCheckOk ?? null, lastCheckMessage: row.lastCheckMessage || '',
        };
    });
}

/**
 * Save a provider's set-up. A secret left out (or empty) keeps its stored
 * value; `clearSecrets: ['key']` removes one. Only one provider takes uploads.
 */
async function save(name, body, userId) {
    const provider = get(name);
    const row = (await rows()).find((r) => r.provider === name);
    const settings = { ...(row.settings || {}) };
    for (const f of provider.settingsFields) {
        if (body.settings?.[f.key] === undefined) continue;
        settings[f.key] = f.type === 'boolean' ? !!body.settings[f.key] : String(body.settings[f.key] ?? '').trim().slice(0, 500);
    }
    const sealed = { ...(row.secrets || {}) };
    for (const f of provider.secretFields) {
        const v = body.secrets?.[f.key];
        if (typeof v === 'string' && v.trim()) sealed[f.key] = secrets.seal(v.trim());
        if (Array.isArray(body.clearSecrets) && body.clearSecrets.includes(f.key)) delete sealed[f.key];
    }
    const enabled = body.enabled === undefined ? !!row.enabled : !!body.enabled;
    let isDefault = body.isDefault === undefined ? !!row.isDefault : !!body.isDefault;
    if (isDefault && provider.kind !== 'file') throw bad('Only a provider that stores files can take uploads');
    if (isDefault) {
        const st = provider.status(resolve(provider, { enabled, settings, secrets: sealed }));
        if (!enabled || !st.configured) throw bad(`${provider.label} cannot take uploads until it is switched on and fully set up${st.missing.length ? ` (missing: ${st.missing.join(', ')})` : ''}`);
        await M.provider.updateMany({ provider: { $ne: name }, isDefault: true }, { $set: { isDefault: false } });
    }
    if (!enabled) isDefault = false;
    await M.provider.findOneAndUpdate({ provider: name }, { $set: { enabled, isDefault, settings, secrets: sealed, updatedBy: userId } }, { upsert: true });
    return (await describe()).find((d) => d.provider === name);
}

async function check(name) {
    const provider = get(name);
    const cfg = await config(name);
    const st = provider.status(cfg);
    const result = st.configured
        ? await provider.check(cfg).catch((e) => ({ ok: false, message: e.message }))
        : { ok: false, message: `Not set up yet — missing: ${st.missing.join(', ')}` };
    // A provider checked before it was ever saved keeps what it was by default —
    // including being the one uploads go to.
    const row = (await rows()).find((r) => r.provider === name);
    await M.provider.findOneAndUpdate({ provider: name },
        { $set: { lastCheckedAt: new Date(), lastCheckOk: !!result.ok, lastCheckMessage: String(result.message || '').slice(0, 300) }, $setOnInsert: { enabled: !!row.enabled, isDefault: !!row.isDefault, settings: {}, secrets: {} } },
        { upsert: true });
    return result;
}

const notConfigured = (message) => new HttpError(503, message, 'PROVIDER_NOT_CONFIGURED');

/** A provider ready to be used, with its configuration — or a 503 that says what is missing. */
async function ready(name) {
    const provider = get(name);
    const cfg = await config(name);
    if (!cfg.enabled) throw notConfigured(`${provider.label} is switched off. A Super Admin can switch it on under Video Library › Providers.`);
    const st = provider.status(cfg);
    if (!st.configured) throw notConfigured(`${provider.label} is not set up yet (missing: ${st.missing.join(', ')}). A Super Admin can complete it under Video Library › Providers.`);
    return { provider, cfg };
}

/** Where a new file upload goes. */
async function uploadTarget() {
    const row = (await rows()).find((r) => r.isDefault);
    if (!row) throw notConfigured('No storage provider is chosen for uploads. Choose one under Video Library › Providers.');
    return ready(row.provider);
}

module.exports = { PROVIDERS, get, config, describe, save, check, ready, uploadTarget };
