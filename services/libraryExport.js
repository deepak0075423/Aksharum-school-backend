'use strict';
// Spreadsheet delivery, shared by the reports controller and the catalogue /
// circulation exports so every download in the module behaves the same way:
// the same rows the screen shows, in the order the caller built them.
const XLSX = require('xlsx');

/** True when the caller asked for a spreadsheet rather than JSON. */
const wantsXlsx = (req) => String(req.query.format || '').toLowerCase() === 'xlsx';

/**
 * Sends `rows` as an .xlsx attachment. Column order follows the first row, so
 * the shape of the objects handed in decides the sheet layout — build them in
 * the order a person would want to read them.
 */
function sendXlsx(res, name, rows) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name.slice(0, 31));
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${stamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
}

const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');

module.exports = { wantsXlsx, sendXlsx, day };
