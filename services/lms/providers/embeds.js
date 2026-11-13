'use strict';
/**
 * Video Learning providers — Vimeo and YouTube. Nothing is uploaded through
 * the app: the video already exists with the provider and is registered here
 * by its address or id, then played in the provider's own player, which the
 * app drives (play, pause, where it is) but does not own.
 *
 *   Vimeo     suitable for protected content when the Vimeo account restricts
 *             embedding to the app's domain (a Vimeo setting, not ours).
 *             VIDEO_VIMEO_TOKEN (optional) lets the app confirm the video
 *             exists and read its title, length and thumbnail.
 *   YouTube   NOT for content that must not be shared: anyone can open a
 *             YouTube video outside the app. A video marked `strict` cannot
 *             use it (services/lms/catalog).
 *             VIDEO_YOUTUBE_API_KEY (optional) reads the length.
 */
const TIMEOUT = 8000;

// VIDEO_EMBED_LOOKUP=off: never call Vimeo or YouTube (a server with no way
// out, or the test suite). Videos are then linked on the id alone.
const lookupsOff = () => /^(off|0|false|no)$/i.test(process.env.VIDEO_EMBED_LOOKUP || '');

async function getJson(url, headers = {}) {
    if (lookupsOff()) return { ok: false, status: 0, error: 'lookups are switched off' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
        const r = await fetch(url, { headers, signal: ctl.signal });
        if (!r.ok) return { ok: false, status: r.status };
        return { ok: true, body: await r.json() };
    } catch (e) { return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timed out' : e.message }; }
    finally { clearTimeout(t); }
}

// PT1H2M3S → seconds
function isoDuration(s) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s || ''));
    return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

const vimeo = {
    name: 'vimeo',
    label: 'Vimeo',
    kind: 'embed',
    settingsFields: [],
    secretFields: [{ key: 'accessToken', label: 'Access token', env: 'VIDEO_VIMEO_TOKEN', help: 'Optional. A Vimeo API token lets the app confirm a video exists and read its title, length and thumbnail.' }],

    status() { return { configured: true, missing: [], notes: ['Restrict embedding to this app\'s domain in the Vimeo account so the videos cannot be played elsewhere.'] }; },

    /** "https://vimeo.com/123456789/abcdef0123" or "123456789" → "123456789" or "123456789:abcdef0123" (unlisted). */
    parse(input) {
        const s = String(input || '').trim();
        let m = /^(\d{5,})(?::([0-9a-f]{6,}))?$/i.exec(s);
        if (!m) m = /vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/i.exec(s);
        if (!m) return null;
        const hash = m[2] || (/[?&]h=([0-9a-f]{6,})/i.exec(s) || [])[1] || '';
        return hash ? `${m[1]}:${hash}` : m[1];
    },

    async fetchMeta(assetId, cfg = {}) {
        const [vid, hash] = String(assetId).split(':');
        if (cfg.accessToken) {
            const r = await getJson(`https://api.vimeo.com/videos/${vid}?fields=name,duration,pictures.sizes`, { Authorization: `bearer ${cfg.accessToken}` });
            if (r.ok) {
                const sizes = r.body.pictures?.sizes || [];
                const pic = sizes.find((x) => x.width >= 640) || sizes[sizes.length - 1];
                return { found: true, title: r.body.name || '', durationSec: Number(r.body.duration) || 0, thumbnailUrl: pic?.link || '' };
            }
            if (r.status === 404) return { found: false };
        }
        const page = `https://vimeo.com/${vid}${hash ? `/${hash}` : ''}`;
        const r = await getJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(page)}`);
        if (r.ok) return { found: true, title: r.body.title || '', durationSec: Number(r.body.duration) || 0, thumbnailUrl: r.body.thumbnail_url || '' };
        return { found: r.status === 404 ? false : null };     // null: could not be checked
    },

    async check(cfg = {}) {
        if (!cfg.accessToken) return { ok: true, message: 'Videos are linked by their Vimeo id. No access token is set, so titles and lengths are read from Vimeo\'s public details.' };
        const r = await getJson('https://api.vimeo.com/me?fields=name', { Authorization: `bearer ${cfg.accessToken}` });
        return r.ok ? { ok: true, message: `Connected to Vimeo as ${r.body.name || 'the token\'s account'}` }
            : { ok: false, message: r.status === 401 ? 'Vimeo did not accept the access token' : `Vimeo could not be reached (${r.status || r.error})` };
    },

    async playback(video) {
        const [vid, hash] = String(video.providerAssetId).split(':');
        return { type: 'vimeo', videoId: vid, hash: hash || '' };
    },
    async remove() { /* the video is Vimeo's; nothing of ours to delete */ },
};

const youtube = {
    name: 'youtube',
    label: 'YouTube',
    kind: 'embed',
    settingsFields: [],
    secretFields: [{ key: 'apiKey', label: 'API key', env: 'VIDEO_YOUTUBE_API_KEY', help: 'Optional. A YouTube Data API key lets the app read a video\'s length; without it the length is typed in.' }],

    status() { return { configured: true, missing: [], notes: ['Only for content that does not need protection: a YouTube video can always be opened and shared outside the app.'] }; },

    parse(input) {
        const s = String(input || '').trim();
        if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
        const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/.exec(s);
        return m ? m[1] : null;
    },

    async fetchMeta(assetId, cfg = {}) {
        if (cfg.apiKey) {
            const r = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${assetId}&key=${encodeURIComponent(cfg.apiKey)}`);
            if (r.ok) {
                const item = (r.body.items || [])[0];
                if (!item) return { found: false };
                const th = item.snippet?.thumbnails || {};
                return { found: true, title: item.snippet?.title || '', durationSec: isoDuration(item.contentDetails?.duration), thumbnailUrl: (th.high || th.medium || th.default || {}).url || '' };
            }
        }
        const r = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${assetId}`)}`);
        if (r.ok) return { found: true, title: r.body.title || '', durationSec: 0, thumbnailUrl: r.body.thumbnail_url || `https://i.ytimg.com/vi/${assetId}/hqdefault.jpg` };
        return { found: [400, 401, 403, 404].includes(r.status) ? false : null };
    },

    async check(cfg = {}) {
        if (!cfg.apiKey) return { ok: true, message: 'Videos are linked by their YouTube address. No API key is set, so each video\'s length is typed in.' };
        const r = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(cfg.apiKey)}`);
        return r.ok ? { ok: true, message: 'The YouTube API key works' } : { ok: false, message: `YouTube did not accept the API key (${r.status || r.error})` };
    },

    async playback(video) { return { type: 'youtube', videoId: video.providerAssetId }; },
    async remove() { /* nothing of ours to delete */ },
};

module.exports = { vimeo, youtube, isoDuration };
