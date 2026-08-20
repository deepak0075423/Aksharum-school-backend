'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Code 128 barcode rendering, as SVG.
//
//  Copy codes are already in LIB-COPY-000042 form, so the identifier scheme for
//  scanning has existed since the module shipped — only the rendering was
//  missing. Code 128 subset B covers the full ASCII range those codes use and
//  is what every cheap USB and Bluetooth scanner reads out of the box.
//
//  Written here rather than pulled in as a dependency: the encoding is a fixed
//  107-entry pattern table and about forty lines of logic, and the alternative
//  is another package in the tree for that.
// ─────────────────────────────────────────────────────────────────────────────

// Each entry is the bar/space run-length pattern for one symbol, six digits
// wide: bar, space, bar, space, bar, space.
const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '112142', '112241', '114212', '124112', '124211', '411212', '421112',
    '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113',
    '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '233111',
];

const START_B = 104;   // Code 128 subset B
const STOP    = 106;

/**
 * Bar/space run lengths for `text`, including start, checksum and stop symbols.
 * Subset B maps a printable ASCII character to `charCode - 32`.
 */
function encode(text) {
    const values = [START_B];
    for (const ch of String(text)) {
        const v = ch.charCodeAt(0) - 32;
        if (v < 0 || v > 94) throw new Error(`Code 128B cannot encode ${JSON.stringify(ch)}`);
        values.push(v);
    }

    // Weighted modulo-103 checksum: start value, then each symbol times its
    // 1-based position.
    let sum = START_B;
    for (let i = 1; i < values.length; i++) sum += values[i] * i;
    values.push(sum % 103, STOP);

    // The stop symbol carries a seventh element, the final 2-wide bar.
    const runs = [];
    for (const v of values) for (const d of PATTERNS[v]) runs.push(Number(d));
    runs.push(2);
    return runs;
}

/**
 * One barcode as an SVG fragment. Runs alternate bar/space starting with a bar,
 * so only the even-indexed runs are drawn.
 */
function barcodeSvg(text, { moduleWidth = 1.6, height = 42 } = {}) {
    const runs = encode(text);
    const width = runs.reduce((a, b) => a + b, 0) * moduleWidth;

    let x = 0;
    const bars = [];
    runs.forEach((run, i) => {
        const w = run * moduleWidth;
        if (i % 2 === 0) bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}"/>`);
        x += w;
    });

    return {
        width,
        height,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height}" viewBox="0 0 ${width.toFixed(2)} ${height}" shape-rendering="crispEdges"><g fill="#000">${bars.join('')}</g></svg>`,
    };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * A printable sheet of spine labels — barcode, human-readable code, title and
 * rack — laid out on A4 at a size that fits a standard 65-per-sheet label
 * stock. Returned as a self-contained HTML document the librarian prints from
 * the browser, so nothing here depends on a PDF pipeline or a label driver.
 */
function labelSheetHtml(labels, { schoolName = '' } = {}) {
    const cells = labels.map((l) => {
        const { svg } = barcodeSvg(l.code, { moduleWidth: 1.25, height: 34 });
        return `<div class="label">
      <div class="ttl">${esc(l.title).slice(0, 42)}</div>
      <div class="bc">${svg}</div>
      <div class="code">${esc(l.code)}</div>
      ${l.rack ? `<div class="rack">${esc(l.rack)}</div>` : ''}
    </div>`;
    }).join('');

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Spine labels</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #fff; }
  .head { font-size: 11px; margin: 0 0 6mm; display: flex; justify-content: space-between; }
  .sheet { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
  .label { border: 0.4pt dashed #bbb; padding: 2mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .ttl  { font-size: 7pt; line-height: 1.15; height: 2.4em; overflow: hidden; margin-bottom: 1mm; }
  .bc svg { max-width: 100%; height: auto; }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7.5pt; letter-spacing: 0.04em; margin-top: 0.6mm; }
  .rack { font-size: 6.5pt; color: #444; margin-top: 0.4mm; }
  @media print { .head { display: none; } .label { border-color: transparent; } }
</style></head>
<body>
  <div class="head"><span>${esc(schoolName)} — spine labels</span><span>${labels.length} label(s)</span></div>
  <div class="sheet">${cells}</div>
</body></html>`;
}

module.exports = { barcodeSvg, labelSheetHtml };
