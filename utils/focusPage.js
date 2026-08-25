'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Which page is that record on?
//
//  Following a notification lands on a list, and the record it was about is
//  frequently not on the first page — so the list opens, nothing is
//  highlighted, and the person is left scrolling. The link carries the record
//  id as `focus`; this works out which page of the *current* filter and sort
//  actually contains it, so the list can open there instead of at page 1.
//
//  Counting rows that sort ahead of the record is exact and costs one indexed
//  count — cheaper and steadier than fetching pages until it turns up.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Model}  Model     the list's model
 * @param {Object} filter    the same filter the list query uses
 * @param {Object} sort      the same sort, e.g. { fromDate: -1 }
 * @param {Number} limit     page size
 * @param {String} focusId   the record to locate
 * @returns {Promise<Number|null>} 1-based page, or null when the record is not
 *          in this filtered set (deleted, or hidden by a filter the user set)
 */
async function focusPage(Model, filter, sort, limit, focusId) {
    if (!focusId || !limit) return null;

    const doc = await Model.findOne({ ...filter, _id: String(focusId) }).lean();
    if (!doc) return null;   // not in this set — the caller decides what to do

    // Rows that come before it under this sort. Ties are broken by _id so the
    // answer matches what the paged query returns rather than drifting between
    // two rows that share a sort value.
    const [field, dir] = Object.entries(sort || {})[0] || [];
    if (!field) return 1;

    const ahead = { ...filter };
    const value = doc[field];
    if (value === undefined || value === null) return 1;

    ahead.$or = dir === -1
        ? [{ [field]: { $gt: value } }, { [field]: value, _id: { $lt: doc._id } }]
        : [{ [field]: { $lt: value } }, { [field]: value, _id: { $lt: doc._id } }];

    const before = await Model.countDocuments(ahead);
    return Math.floor(before / Number(limit)) + 1;
}

/**
 * The whole pattern in one call, for a controller that already has its filter,
 * sort and page size to hand:
 *
 *   const page = await resolvePage(LeaveApplication, filter, sort, limit,
 *                                  req.query.focus, req.query.page);
 *
 * A focus id that cannot be placed leaves the requested page alone, so a stale
 * notification still opens the list rather than an error.
 */
async function resolvePage(Model, filter, sort, limit, focusId, requestedPage = 1) {
    const found = await focusPage(Model, filter, sort, limit, focusId);
    return { page: found || Math.max(1, Number(requestedPage) || 1), focusFound: !!found };
}

module.exports = { focusPage, resolvePage };
