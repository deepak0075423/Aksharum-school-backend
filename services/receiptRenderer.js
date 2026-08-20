'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Receipt rendering.
//
//  A receipt is returned as a self-contained HTML document rather than a PDF:
//  the browser and both mobile clients can display it, print it, or save it as
//  PDF through the OS, and the same markup is what an email would carry. The
//  previous fee "receipt" was a .txt file, which nobody can hand to a parent.
//
//  Five presets ship. Each is a full design — the school picks one and adjusts
//  the accent, wording and which blocks appear; it never has to draw anything.
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS = {
    classic: {
        name: 'Classic',
        blurb: 'Centred masthead over a ruled table. What most schools already hand out.',
    },
    modern: {
        name: 'Modern',
        blurb: 'Coloured header band, generous spacing, amount called out in large type.',
    },
    compact: {
        name: 'Compact',
        blurb: 'Fits a half sheet — good for a counter printer or a receipt book.',
    },
    formal: {
        name: 'Formal',
        blurb: 'Bordered, serif, with a signature block. Reads as an official record.',
    },
    minimal: {
        name: 'Minimal',
        blurb: 'Type only, no rules or colour. Cheapest to print.',
    },
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const money = (n, symbol = '₹') =>
    `${symbol}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) => (d
    ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : '');

/** Sensible defaults for a school that has not saved a design yet. */
const defaultTemplate = (module, paymentMode) => ({
    module,
    paymentMode,
    preset: 'classic',
    accentColor: '#4F46E5',
    headerText: '',
    footerText: 'This is a computer-generated receipt.',
    notes: '',
    signatoryName: '',
    showLogo: true,
    showBreakdown: true,
    showSignature: true,
    showPaymentMode: true,
});

// ── Shared pieces ────────────────────────────────────────────────────────────

const rowsHtml = (lines, symbol) => (lines || [])
    .map(l => `<tr><td>${esc(l.label)}</td><td class="amt">${money(l.amount, symbol)}</td></tr>`)
    .join('');

const kv = (label, value) => (value
    ? `<div class="kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
    : '');

/**
 * `receipt` is module-neutral on purpose — fees and library fines both reduce
 * to: who paid, what for, how much, when, and against which reference.
 *
 * @param {object} receipt  { number, date, paidBy, paidByDetail, title, lines[],
 *                            total, paymentMode, reference, school }
 */
function renderReceipt(receipt, templateRaw, { school } = {}) {
    const t = { ...defaultTemplate(receipt.module, receipt.paymentMode), ...(templateRaw || {}) };
    const symbol = receipt.currencySymbol || '₹';
    const accent = /^#[0-9a-f]{3,8}$/i.test(t.accentColor || '') ? t.accentColor : '#4F46E5';

    const logo = t.showLogo && school?.logoUrl
        ? `<img class="logo" src="${esc(school.logoUrl)}" alt="">` : '';

    const breakdown = t.showBreakdown && (receipt.lines || []).length
        ? `<table class="lines">
             <thead><tr><th>Description</th><th class="amt">Amount</th></tr></thead>
             <tbody>${rowsHtml(receipt.lines, symbol)}</tbody>
             <tfoot><tr><td>Total</td><td class="amt">${money(receipt.total, symbol)}</td></tr></tfoot>
           </table>`
        : `<div class="total-only"><span>Total paid</span><strong>${money(receipt.total, symbol)}</strong></div>`;

    const signature = t.showSignature
        ? `<div class="sign">
             <div class="sign-line"></div>
             <div class="sign-name">${esc(t.signatoryName || 'Authorised signatory')}</div>
           </div>`
        : '';

    const meta = [
        kv('Receipt no.', receipt.number),
        kv('Date', fmtDate(receipt.date)),
        kv('Paid by', receipt.paidBy),
        kv(receipt.paidByDetailLabel || 'Details', receipt.paidByDetail),
        t.showPaymentMode ? kv('Payment mode', receipt.paymentMode === 'online' ? 'Online' : (receipt.offlineModeLabel || 'Cash')) : '',
        receipt.reference ? kv('Reference', receipt.reference) : '',
    ].join('');

    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${esc(receipt.number || '')}</title>
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #f1f5f9; color: #111827;
    font-family: ${t.preset === 'formal' ? "Georgia, 'Times New Roman', serif" : "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif"};
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet {
    max-width: ${t.preset === 'compact' ? '520px' : '720px'};
    margin: 0 auto; background: #fff; padding: ${t.preset === 'compact' ? '20px 22px' : '34px 38px'};
    ${t.preset === 'formal' ? 'border: 2px solid var(--accent); outline: 1px solid var(--accent); outline-offset: 4px;' : ''}
    ${t.preset === 'minimal' ? '' : 'box-shadow: 0 2px 14px rgba(0,0,0,.08); border-radius: 8px;'}
  }
  .band {
    ${t.preset === 'modern' ? 'background: var(--accent); color: #fff; margin: -34px -38px 24px; padding: 22px 38px; border-radius: 8px 8px 0 0;' : ''}
    ${t.preset === 'classic' ? 'text-align: center; border-bottom: 2px solid var(--accent); padding-bottom: 14px; margin-bottom: 20px;' : ''}
    ${t.preset === 'compact' ? 'border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 14px;' : ''}
    ${t.preset === 'formal' ? 'text-align: center; margin-bottom: 22px;' : ''}
    ${t.preset === 'minimal' ? 'margin-bottom: 22px;' : ''}
  }
  .logo { max-height: 54px; max-width: 190px; margin-bottom: 10px; }
  .school { font-size: ${t.preset === 'compact' ? '1.05rem' : '1.4rem'}; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  .addr { font-size: .8rem; opacity: .75; margin-top: 3px; }
  .doctype {
    margin-top: 10px; font-size: .72rem; letter-spacing: .16em; text-transform: uppercase;
    ${t.preset === 'modern' ? 'opacity: .9;' : 'color: var(--accent); font-weight: 700;'}
  }
  .headline { font-size: .85rem; margin-top: 8px; ${t.preset === 'modern' ? 'opacity:.92' : 'color:#4b5563'} }
  .kvs { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 8px 20px; margin-bottom: 20px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: .84rem;
        border-bottom: 1px dotted #d1d5db; padding-bottom: 5px; }
  .kv span { color: #6b7280; }
  table.lines { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: .88rem; }
  table.lines th, table.lines td { padding: 9px 10px; text-align: left; }
  table.lines thead th {
    ${t.preset === 'minimal' ? 'border-bottom: 1px solid #111;' : 'background: color-mix(in srgb, var(--accent) 10%, #fff); color: var(--accent);'}
    font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
  }
  table.lines tbody td { border-bottom: 1px solid #eef2f7; }
  table.lines tfoot td { font-weight: 700; border-top: 2px solid var(--accent); padding-top: 11px; font-size: .95rem; }
  .amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total-only {
    display: flex; justify-content: space-between; align-items: baseline;
    border-top: 2px solid var(--accent); padding-top: 12px; margin-bottom: 18px;
  }
  .total-only strong { font-size: 1.5rem; color: var(--accent); font-variant-numeric: tabular-nums; }
  .paid {
    display: inline-block; border: 2px solid #16a34a; color: #16a34a; border-radius: 5px;
    padding: 3px 12px; font-weight: 700; letter-spacing: .12em; font-size: .72rem;
    transform: rotate(-3deg); margin-bottom: 14px;
  }
  .notes { font-size: .8rem; color: #4b5563; background: #f8fafc; border-left: 3px solid var(--accent);
           padding: 9px 12px; margin-bottom: 18px; white-space: pre-wrap; }
  .sign { margin-top: 34px; text-align: right; }
  .sign-line { display: inline-block; width: 190px; border-top: 1px solid #9ca3af; }
  .sign-name { font-size: .78rem; color: #6b7280; margin-top: 5px; }
  footer { margin-top: 22px; padding-top: 12px; border-top: 1px solid #e5e7eb;
           font-size: .74rem; color: #9ca3af; text-align: center; white-space: pre-wrap; }
  .actions { max-width: 720px; margin: 0 auto 14px; text-align: right; }
  .actions button {
    font: inherit; font-size: .85rem; padding: 8px 16px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: #fff;
  }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; max-width: none; }
    .actions { display: none; }
  }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">Print or save as PDF</button></div>
  <div class="sheet">
    <div class="band">
      ${logo}
      <h1 class="school">${esc(school?.name || '')}</h1>
      ${school?.address ? `<div class="addr">${esc(school.address)}</div>` : ''}
      <div class="doctype">${esc(receipt.title || 'Payment receipt')}</div>
      ${t.headerText ? `<div class="headline">${esc(t.headerText)}</div>` : ''}
    </div>

    <span class="paid">PAID</span>
    <div class="kvs">${meta}</div>
    ${breakdown}
    ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
    ${signature}
    ${t.footerText ? `<footer>${esc(t.footerText)}</footer>` : ''}
  </div>
</body></html>`;
}

/** A filled-in sample, so the design screen previews with realistic content. */
const sampleReceipt = (module) => (module === 'library'
    ? {
        module: 'library', number: 'LIB-REC-000042', date: new Date(),
        paidBy: 'Aarav Sharma', paidByDetailLabel: 'Class', paidByDetail: 'VIII · B',
        title: 'Library fine receipt', paymentMode: 'online',
        reference: 'pay_PkQ2xR7mNc1Abc',
        lines: [{ label: 'Late return — "The Selfish Giant" (6 days)', amount: 30 },
                { label: 'Damaged book — "Wings of Fire"', amount: 50 }],
        total: 80,
    }
    : {
        module: 'fees', number: 'REC-000412', date: new Date(),
        paidBy: 'Aarav Sharma', paidByDetailLabel: 'Class', paidByDetail: 'VIII · B',
        title: 'Fee receipt', paymentMode: 'online',
        reference: 'pay_PkQ2xR7mNc1Abc',
        lines: [{ label: 'Tuition fee — Term 2', amount: 12500 },
                { label: 'Transport fee — Term 2', amount: 3200 },
                { label: 'Late payment fine', amount: 150 }],
        total: 15850,
    });

module.exports = { PRESETS, renderReceipt, defaultTemplate, sampleReceipt, money, esc };
