'use strict';
/**
 * The three pieces of paper an inventory office actually needs.
 *
 * The module could raise a purchase order, receive against it and issue the
 * goods, and at no point could anyone print any of it. A purchase order that
 * cannot leave the building is not a purchase order — a vendor needs it, a
 * storekeeper signs a goods-received note, and whoever takes stock away signs
 * for it. Until now all three existed only as rows on a screen.
 *
 * Rendered as self-contained HTML rather than PDF, matching services/
 * receiptRenderer: the browser prints it or saves it as PDF, both mobile
 * clients can display it, and the same markup is what an email would carry.
 * One stylesheet, no external assets, A4 page rules included.
 */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const money = (n, s = '₹') =>
    `${s}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n) => Number(n || 0).toLocaleString('en-IN');
const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const num = (v) => (Number.isFinite(+v) ? +v : 0);

/* ── Shared chrome ──────────────────────────────────────────────────────── */

const CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:#f1f5f9;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1e293b}
  .sheet{max-width:820px;margin:24px auto;background:#fff;padding:36px 40px;border-radius:10px;
         box-shadow:0 1px 3px rgba(15,23,42,.1),0 8px 24px rgba(15,23,42,.06)}
  .top{display:flex;gap:20px;align-items:flex-start;justify-content:space-between;
       border-bottom:2px solid #1e293b;padding-bottom:16px;margin-bottom:22px}
  .brand{display:flex;gap:13px;align-items:center;min-width:0}
  .brand img{width:52px;height:52px;object-fit:contain;border-radius:8px}
  .brand h1{margin:0;font-size:1.18rem;letter-spacing:-.01em}
  .brand .addr{color:#64748b;font-size:.78rem;margin-top:3px;max-width:340px}
  .docmeta{text-align:right;flex:none}
  .docmeta .kind{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:#64748b;font-weight:700}
  .docmeta .no{font-size:1.05rem;font-weight:800;margin-top:2px}
  .docmeta .dt{color:#64748b;font-size:.78rem;margin-top:2px}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.7rem;font-weight:700;
        letter-spacing:.04em;text-transform:uppercase;background:#eef2ff;color:#4338ca;margin-top:6px}
  .pill.ok{background:#dcfce7;color:#15803d} .pill.warn{background:#fef3c7;color:#b45309}
  .pill.bad{background:#fee2e2;color:#b91c1c}
  .cols{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:22px}
  .col{flex:1 1 220px;min-width:0}
  .col h3{margin:0 0 7px;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#64748b}
  .col .big{font-weight:700;font-size:.95rem}
  .col .line{color:#475569;font-size:.82rem}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th{text-align:left;font-size:.7rem;letter-spacing:.07em;text-transform:uppercase;color:#475569;
     background:#f8fafc;border-bottom:1.5px solid #e2e8f0;padding:9px 10px;white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  th.n,td.n{text-align:right}
  tbody tr:last-child td{border-bottom:1.5px solid #e2e8f0}
  .sub{color:#64748b;font-size:.75rem}
  .totals{margin-left:auto;width:290px}
  .totals tr td{border:none;padding:5px 0}
  .totals tr td.n{font-variant-numeric:tabular-nums}
  .totals tr.grand td{border-top:1.5px solid #1e293b;padding-top:9px;font-weight:800;font-size:1rem}
  .note{background:#f8fafc;border-left:3px solid #cbd5e1;padding:11px 14px;border-radius:0 6px 6px 0;
        font-size:.82rem;color:#475569;margin-bottom:18px;white-space:pre-wrap}
  .signs{display:flex;gap:30px;margin-top:44px;page-break-inside:avoid}
  .sign{flex:1;text-align:center}
  .sign .rule{border-top:1px solid #94a3b8;margin-bottom:6px}
  .sign .who{font-size:.78rem;font-weight:700}
  .sign .role{font-size:.7rem;color:#64748b}
  .foot{margin-top:26px;padding-top:12px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:.72rem;
        display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}
  .bar{position:fixed;top:0;left:0;right:0;background:#1e293b;color:#fff;padding:9px 16px;text-align:center;font-size:.8rem}
  .bar button{background:#fff;color:#1e293b;border:0;border-radius:6px;padding:5px 15px;font-weight:700;
              font-size:.8rem;cursor:pointer;margin-left:10px}
  @media print{
    body{background:#fff} .bar{display:none}
    .sheet{max-width:none;margin:0;padding:0;border-radius:0;box-shadow:none}
    @page{size:A4;margin:14mm}
    thead{display:table-header-group} tr{page-break-inside:avoid}
  }
  @media (max-width:640px){
    .sheet{margin:0;padding:22px 18px;border-radius:0}
    .top{flex-direction:column;gap:14px} .docmeta{text-align:left}
    .totals{width:100%} .signs{flex-direction:column;gap:30px}
  }
`;

const header = (school, kind, number, when, statusPill) => `
  <div class="top">
    <div class="brand">
      ${school?.logoUrl ? `<img src="${esc(school.logoUrl)}" alt="">` : ''}
      <div>
        <h1>${esc(school?.name || 'School')}</h1>
        ${school?.address ? `<div class="addr">${esc(school.address)}</div>` : ''}
      </div>
    </div>
    <div class="docmeta">
      <div class="kind">${esc(kind)}</div>
      <div class="no">${esc(number || '—')}</div>
      <div class="dt">${esc(date(when))}</div>
      ${statusPill || ''}
    </div>
  </div>`;

const block = (title, big, ...lines) => `
  <div class="col">
    <h3>${esc(title)}</h3>
    <div class="big">${esc(big || '—')}</div>
    ${lines.filter(Boolean).map(l => `<div class="line">${esc(l)}</div>`).join('')}
  </div>`;

const signature = (pairs) => `
  <div class="signs">
    ${pairs.map(([who, role]) => `
      <div class="sign"><div class="rule"></div>
        <div class="who">${esc(who || ' ')}</div>
        <div class="role">${esc(role)}</div></div>`).join('')}
  </div>`;

const page = (title, body, footNote) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
  <div class="bar">Use your browser's print dialog to print this or save it as PDF.
    <button onclick="window.print()">Print</button></div>
  <div class="sheet">${body}
    <div class="foot">
      <span>${esc(footNote || 'Computer-generated document.')}</span>
      <span>Generated ${esc(new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
    </div>
  </div>
</body></html>`;

const STATUS_TONE = {
    received: 'ok', approved: 'ok', returned: 'ok',
    cancelled: 'bad', rejected: 'bad',
    draft: 'warn', pending_approval: 'warn', partially_received: 'warn', partially_returned: 'warn',
};
const pill = (status) => (status
    ? `<span class="pill ${STATUS_TONE[status] || ''}">${esc(String(status).replace(/_/g, ' '))}</span>`
    : '');

/* ── 1. Purchase order — the copy the vendor gets ───────────────────────── */

function purchaseOrder({ po, vendor, department, warehouse, school, raisedBy, approvedBy, currency = '₹' }) {
    const lines = (po.items || []).map((l, i) => {
        const gross = num(l.quantity) * num(l.unitPrice);
        const tax = gross * (num(l.gst) / 100);
        return `<tr>
            <td class="n">${i + 1}</td>
            <td><strong>${esc(l.itemName)}</strong>${l.item?.itemCode ? `<div class="sub">${esc(l.item.itemCode)}</div>` : ''}</td>
            <td class="n">${qty(l.quantity)} ${esc(l.unit || '')}</td>
            <td class="n">${money(l.unitPrice, currency)}</td>
            <td class="n">${num(l.gst)}%</td>
            <td class="n">${money(gross + tax, currency)}</td>
        </tr>`;
    }).join('');

    const body = `
      ${header(school, 'Purchase Order', po.poNumber, po.createdAt, pill(po.status))}
      <div class="cols">
        ${block('Vendor', vendor?.name,
            vendor?.contactPerson && `Attn: ${vendor.contactPerson}`,
            vendor?.phone, vendor?.email, vendor?.address)}
        ${block('Deliver to', warehouse?.name || school?.name,
            po.deliveryAddress || warehouse?.location || school?.address,
            po.expectedDelivery ? `Expected by ${date(po.expectedDelivery)}` : null)}
        ${block('Raised by', raisedBy?.name,
            department?.name ? `Department: ${department.name}` : null,
            po.purchaseRequest?.requestNumber ? `Against ${po.purchaseRequest.requestNumber}` : null)}
      </div>
      <table>
        <thead><tr><th class="n">#</th><th>Item</th><th class="n">Qty</th>
          <th class="n">Rate</th><th class="n">GST</th><th class="n">Amount</th></tr></thead>
        <tbody>${lines || '<tr><td colspan="6" class="sub">No lines on this order.</td></tr>'}</tbody>
      </table>
      <table class="totals">
        <tr><td>Subtotal</td><td class="n">${money(po.subTotal, currency)}</td></tr>
        <tr><td>Tax</td><td class="n">${money(po.taxTotal, currency)}</td></tr>
        ${num(po.discount) ? `<tr><td>Discount</td><td class="n">− ${money(po.discount, currency)}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td class="n">${money(po.grandTotal, currency)}</td></tr>
      </table>
      ${po.terms ? `<div class="note"><strong>Terms</strong><br>${esc(po.terms)}</div>` : ''}
      ${signature([
        [raisedBy?.name, 'Prepared by'],
        [approvedBy?.name, po.approvedAt ? `Approved ${date(po.approvedAt)}` : 'Approved by'],
        ['', 'Vendor acknowledgement'],
      ])}`;
    return page(`Purchase Order ${po.poNumber || ''}`.trim(), body,
        'This purchase order is valid only with an authorised signature.');
}

/* ── 2. Goods received note — what the storekeeper signs ────────────────── */

function goodsReceived({ po, vendor, warehouse, school, receivedBy, lines = [], currency = '₹' }) {
    // `lines` is what came in on THIS receipt; the order's own figures give the
    // running picture, so a partial delivery reads honestly on both counts.
    const rows = (lines.length ? lines : (po.items || []).map(l => ({
        itemName: l.itemName, unit: l.unit, ordered: num(l.quantity),
        received: num(l.receivedQty), now: num(l.receivedQty),
    }))).map((l, i) => {
        const outstanding = Math.max(0, num(l.ordered) - num(l.received));
        return `<tr>
            <td class="n">${i + 1}</td>
            <td><strong>${esc(l.itemName)}</strong></td>
            <td class="n">${qty(l.ordered)} ${esc(l.unit || '')}</td>
            <td class="n"><strong>${qty(l.now)}</strong></td>
            <td class="n">${qty(l.received)}</td>
            <td class="n">${outstanding ? qty(outstanding) : '—'}</td>
            <td>${esc(l.condition || 'Good')}</td>
        </tr>`;
    }).join('');

    const body = `
      ${header(school, 'Goods Received Note', `GRN / ${po.poNumber || ''}`, new Date(), pill(po.status))}
      <div class="cols">
        ${block('Received from', vendor?.name, vendor?.phone, vendor?.email)}
        ${block('Received into', warehouse?.name, warehouse?.location,
            po.invoice?.number ? `Invoice ${po.invoice.number}${po.invoice.date ? ` · ${date(po.invoice.date)}` : ''}` : null)}
        ${block('Against order', po.poNumber, `Ordered ${date(po.createdAt)}`,
            po.expectedDelivery ? `Expected ${date(po.expectedDelivery)}` : null)}
      </div>
      <table>
        <thead><tr><th class="n">#</th><th>Item</th><th class="n">Ordered</th>
          <th class="n">This receipt</th><th class="n">Received to date</th>
          <th class="n">Outstanding</th><th>Condition</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="sub">Nothing received.</td></tr>'}</tbody>
      </table>
      <div class="note">Goods listed above have been checked against the order and taken into
store. Any shortage or damage is recorded in the Outstanding and Condition columns.</div>
      ${signature([
        ['', 'Delivered by (vendor)'],
        [receivedBy?.name, 'Received and checked by'],
        ['', 'Store in-charge'],
      ])}`;
    return page(`Goods Received — ${po.poNumber || ''}`.trim(), body,
        'Retain this note with the vendor invoice.');
}

/* ── 3. Issue slip — what the person taking stock signs ─────────────────── */

function issueSlip({ issue, item, warehouse, department, school, issuedBy, currency = '₹' }) {
    const outstanding = Math.max(0, num(issue.quantity) - num(issue.returnedQty));
    const who = issue.issuedToUser?.name || issue.issuedToName || issue.classLabel || department?.name || '—';
    const returns = (issue.returns || []).map(r => `<tr>
        <td>${esc(r.returnNumber || '')}</td>
        <td class="n">${qty(r.quantity)}</td>
        <td>${esc(String(r.condition || '').replace(/_/g, ' '))}</td>
        <td>${esc(r.restocked ? 'Back in store' : 'Written off')}</td>
        <td>${esc(date(r.returnedAt))}</td>
      </tr>`).join('');

    const body = `
      ${header(school, issue.returnable ? 'Issue Slip (returnable)' : 'Issue Slip', issue.issueNumber, issue.issueDate || issue.createdAt, pill(issue.status))}
      <div class="cols">
        ${block('Issued to', who,
            issue.recipientType ? `${String(issue.recipientType).replace(/_/g, ' ')}` : null,
            issue.issuedToUser?.email || null,
            department?.name && department.name !== who ? `Department: ${department.name}` : null)}
        ${block('Issued from', warehouse?.name, warehouse?.location,
            issuedBy?.name ? `By ${issuedBy.name}` : null)}
        ${block('Return',
            !issue.returnable ? 'Not returnable'
                : outstanding <= 0 ? 'Fully returned'
                : issue.expectedReturn ? `Due ${date(issue.expectedReturn)}` : 'Returnable',
            !issue.returnable ? 'Consumable — no return expected'
                : outstanding <= 0 ? `All ${qty(issue.quantity)} came back`
                : `${qty(outstanding)} still out of ${qty(issue.quantity)}`,
            `Condition out: ${issue.conditionOut || 'Good'}`)}
      </div>
      <table>
        <thead><tr><th>Item</th><th>Code</th><th class="n">Quantity</th><th class="n">Returned</th><th class="n">Outstanding</th></tr></thead>
        <tbody><tr>
          <td><strong>${esc(item?.name || '—')}</strong>${item?.category?.name ? `<div class="sub">${esc(item.category.name)}</div>` : ''}</td>
          <td>${esc(item?.itemCode || '—')}</td>
          <td class="n">${qty(issue.quantity)} ${esc(item?.unit || '')}</td>
          <td class="n">${qty(issue.returnedQty)}</td>
          <td class="n">${issue.returnable ? qty(outstanding) : '—'}</td>
        </tr></tbody>
      </table>
      ${returns ? `<h3 style="font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:#64748b;margin:0 0 7px">Returns recorded</h3>
      <table><thead><tr><th>Return</th><th class="n">Qty</th><th>Condition</th><th>Outcome</th><th>When</th></tr></thead>
        <tbody>${returns}</tbody></table>` : ''}
      ${issue.note ? `<div class="note">${esc(issue.note)}</div>` : ''}
      ${issue.returnable && outstanding > 0 ? `<div class="note">The items above remain school property and are to be returned
${issue.expectedReturn ? `by ${date(issue.expectedReturn)}` : 'on request'} in the condition issued.</div>` : ''}
      ${signature([
        [issuedBy?.name, 'Issued by'],
        [who !== '—' ? who : '', 'Received by'],
      ])}`;
    return page(`Issue Slip ${issue.issueNumber || ''}`.trim(), body,
        issue.returnable && outstanding > 0
            ? 'Produce this slip when returning the items.'
            : 'Computer-generated issue slip.');
}

module.exports = { purchaseOrder, goodsReceived, issueSlip };
