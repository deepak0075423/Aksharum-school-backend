'use strict';
/**
 * Video Learning — an HLS playlist, rewritten for one viewer.
 *
 * A playlist stored beside its segments names them by relative address, which
 * only works when the folder is public. Ours never is. So the playlists are
 * served by the API (controllers/lms/media) and rewritten on the way out:
 *
 *   another playlist (.m3u8)  stays relative — the player asks the API for it,
 *                             and the same check runs again;
 *   a segment, key or map     becomes whatever `signSegment` returns: a
 *                             short-lived signed CDN address, or an API
 *                             address carrying the viewer's playback token.
 *
 * Works with a browser's own HLS player and with hls.js alike, with no cookies.
 */
const path = require('path').posix;

/** `uri` of a playlist at `baseDir`, as a key inside the video's folder — or null if it leaves it. */
function resolveInside(baseDir, uri) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) return null;       // absolute: not ours
    const clean = uri.split(/[?#]/)[0];
    let decoded;
    try { decoded = decodeURIComponent(clean); } catch { return null; }
    const joined = path.normalize(path.join(baseDir, decoded));
    if (joined.startsWith('..') || path.isAbsolute(joined)) return null;
    return joined;
}

const isPlaylist = (uri) => /\.m3u8($|[?#])/i.test(uri);

/**
 * @param {string} text        the playlist as stored
 * @param {string} baseDir     its folder, relative to the video's HLS root ('' for the master)
 * @param {(rel: string) => string} signSegment  address for a segment / key / map at `rel`
 * @param {(rel: string) => string} playlistUrl  address for another playlist at `rel`
 */
function rewriteManifest(text, baseDir, signSegment, playlistUrl) {
    const fix = (uri) => {
        const rel = resolveInside(baseDir, uri);
        if (rel === null) return null;
        return isPlaylist(uri) ? playlistUrl(rel) : signSegment(rel);
    };
    return String(text).split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
            // #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA … carry their address in URI="…"
            return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
                const next = fix(uri);
                return next === null ? 'URI=""' : `URI="${next}"`;
            });
        }
        const next = fix(t);
        return next === null ? '# removed: address outside this video' : next;
    }).join('\n');
}

module.exports = { rewriteManifest, resolveInside, isPlaylist };
