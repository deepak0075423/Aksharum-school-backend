'use strict';
/**
 * The admission emails' markup — rich enough for a school's letters, and
 * unable to carry HTML or script.
 *
 *   # Heading            ## Smaller heading
 *   **bold**   _italic_
 *   - bullet item        1. numbered item
 *   > a highlighted note
 *   ---                  a divider
 *   [link text](https://…)   or   [link text]({{portal_link}})
 *   [[Button text|{{application_link}}]]
 *   {{placeholder}}
 *
 * A blank line starts a new paragraph; a single line break stays a line break.
 *
 * The template is the school's (trusted to format, never to inject); the
 * placeholder values are the applicant's and the system's. So the template is
 * parsed FIRST, with placeholders held as opaque markers, and values go in
 * last, escaped — a name like "**Rahul**" or "[x](javascript:…)" stays text.
 * A link may point only at http(s)/mailto, or at a placeholder that is itself
 * a link the server generated.
 */
const { escapeHtml: esc } = require('../../utils/textRules');

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MARK = '\u0001';
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}/g;
const SAFE_URL = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;

const S = {
    p: 'margin:0 0 14px;line-height:1.6;color:#1f2937;font-size:15px',
    h1: 'margin:4px 0 12px;font-size:20px;line-height:1.3;color:#111827',
    h2: 'margin:4px 0 10px;font-size:17px;line-height:1.35;color:#111827',
    ul: 'margin:0 0 14px;padding-left:22px;color:#1f2937;font-size:15px;line-height:1.6',
    note: 'margin:0 0 14px;padding:12px 16px;background:#eef2ff;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;color:#1e1b4b;font-size:14px;line-height:1.55',
    hr: 'border:none;border-top:1px solid #e5e7eb;margin:18px 0',
    a: 'color:#4f46e5;text-decoration:underline',
    btn: 'display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px',
};

const clean = (t) => String(t ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '');

/**
 * Every problem with a template's text, given the placeholders its event
 * offers ({ key: { link: bool } }). Empty array: it can be saved.
 */
function problems(src, allowed) {
    const out = [];
    const text = clean(src);
    for (const m of text.matchAll(PLACEHOLDER)) {
        if (!allowed[m[1]]) out.push(`{{${m[1]}}} is not available in this email`);
    }
    const broken = text.replace(PLACEHOLDER, '').match(/\{\{|\}\}/);
    if (broken) out.push('A placeholder is not closed — write it as {{name}}');
    const urls = [...text.matchAll(/\[\[[^\]|]{1,80}\|([^\]]{1,300})\]\]/g), ...text.matchAll(/\[[^\]]{1,200}\]\(([^)\s]{1,300})\)/g)].map((m) => m[1].trim());
    for (const u of urls) {
        const ph = u.match(/^\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}$/);
        if (ph) { if (allowed[ph[1]] && !allowed[ph[1]].link) out.push(`{{${ph[1]}}} is not a link and cannot be a link's address`); continue; }
        if (!SAFE_URL.test(u)) out.push(`"${u.slice(0, 60)}" is not a web address (start it with https://)`);
    }
    return [...new Set(out)];
}

/** Bold and italic, on text that is already escaped. */
const emphasis = (t) => t
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>');

/** One line's inline content: tokens out, escape, emphasis, tokens back in. */
function inline(line, ctx) {
    const tokens = [];
    const hold = (html) => { tokens.push(html); return `${MARK}${tokens.length - 1}${MARK}`; };
    let t = line
        .replace(/\[\[([^\]|]{1,80})\|([^\]]{1,300})\]\]/g, (_, label, url) => {
            const href = resolveUrl(url.trim(), ctx);
            return href ? hold(`<a href="${esc(href)}" style="${S.btn}">${inline(label, { ...ctx, noLinks: true })}</a>`) : hold(inline(label, { ...ctx, noLinks: true }));
        })
        .replace(/\[([^\]]{1,200})\]\(([^)\s]{1,300})\)/g, (whole, label, url) => {
            if (ctx.noLinks) return whole;
            const href = resolveUrl(url.trim(), ctx);
            const inner = inline(label, { ...ctx, noLinks: true });
            return href ? hold(`<a href="${esc(href)}" style="${S.a}">${inner}</a>`) : hold(inner);
        })
        .replace(PLACEHOLDER, (_, key) => hold(esc(ctx.values[key] ?? '')));
    t = emphasis(esc(t));
    return t.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => tokens[Number(i)]);
}

function resolveUrl(url, ctx) {
    const ph = url.match(/^\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}$/);
    const value = ph ? String(ctx.values[ph[1]] ?? '') : url;
    return SAFE_URL.test(value) ? value : null;
}

/** Template text → email-safe HTML, with `values` filled in. */
function render(src, values = {}) {
    const ctx = { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, clean(v)])) };
    const lines = clean(src).split('\n');
    const html = [];
    let para = [];
    let list = null;      // { tag, items }
    const flushPara = () => { if (para.length) { html.push(`<p style="${S.p}">${para.map((l) => inline(l, ctx)).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { html.push(`<${list.tag} style="${S.ul}">${list.items.map((i) => `<li>${inline(i, ctx)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) { flushPara(); flushList(); continue; }
        let m;
        if ((m = line.match(/^\s*(#{1,2})\s+(.+)$/))) {
            flushPara(); flushList();
            html.push(`<${m[1].length === 1 ? 'h1' : 'h2'} style="${m[1].length === 1 ? S.h1 : S.h2}">${inline(m[2], ctx)}</${m[1].length === 1 ? 'h1' : 'h2'}>`);
        } else if (/^\s*-{3,}\s*$/.test(line)) {
            flushPara(); flushList(); html.push(`<hr style="${S.hr}">`);
        } else if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
            flushPara();
            if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
            list.items.push(m[1]);
        } else if ((m = line.match(/^\s*\d{1,2}[.)]\s+(.+)$/))) {
            flushPara();
            if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
            list.items.push(m[1]);
        } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
            flushPara(); flushList(); html.push(`<div style="${S.note}">${inline(m[1], ctx)}</div>`);
        } else {
            flushList(); para.push(line.trim());
        }
    }
    flushPara(); flushList();
    return html.join('\n');
}

/** A subject line: placeholders filled, no markup, one line. */
function renderSubject(src, values = {}) {
    return clean(src).replace(PLACEHOLDER, (_, key) => clean(values[key] ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Plain-text twin of a rendered email, for clients that do not show HTML. */
function plainText(src, values = {}) {
    return clean(src)
        .replace(/\[\[([^\]|]{1,80})\|([^\]]{1,300})\]\]/g, '$1: $2')
        .replace(/\[([^\]]{1,200})\]\(([^)\s]{1,300})\)/g, '$1 ($2)')
        .replace(PLACEHOLDER, (_, key) => clean(values[key] ?? ''))
        .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
        .replace(/^\s*#{1,2}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '');
}

module.exports = { render, renderSubject, plainText, problems, clean };
