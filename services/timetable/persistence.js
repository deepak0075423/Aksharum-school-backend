'use strict';
/**
 * Bulk writes and the atomic publish.
 *
 * Two things here deliberately drop below the ORM:
 *
 *  1. BULK INSERT — `Model.insertMany` loops one INSERT per row. A whole-school
 *     generation is ~1,000-1,500 rows, so it is written as chunked multi-row
 *     INSERTs instead (the same reason middleware/auth.js hand-writes its JOIN).
 *
 *  2. TRANSACTIONS — db/pool.js runs every query as a standalone statement so it
 *     stays PgBouncer-safe. Publish MUST be all-or-nothing, so it checks out ONE
 *     client and runs BEGIN/COMMIT on it, exactly as the note in db/pool.js
 *     prescribes. A Postgres advisory lock (released with the transaction)
 *     serialises concurrent publishes for the same school.
 */

const pool = require('../../db/pool');
const Timetable             = require('../../models/Timetable');
const TimetableEntry        = require('../../models/TimetableEntry');
const TimetableVersion      = require('../../models/TimetableVersion');
const TimetableVersionEntry = require('../../models/TimetableVersionEntry');
const TimetableConflict     = require('../../models/TimetableConflict');

const crypto = require('crypto');

const VE = JSON.stringify(TimetableVersionEntry.tableName);
const TE = JSON.stringify(TimetableEntry.tableName);
const TT = JSON.stringify(Timetable.tableName);
const TV = JSON.stringify(TimetableVersion.tableName);
const TC = JSON.stringify(TimetableConflict.tableName);

const newId = () => crypto.randomUUID();
const sid = (v) => (v == null ? null : String(v._id ?? v));

/** Insert rows in chunks of `size` using multi-row VALUES. */
async function chunkedInsert(runner, table, columns, rows, size = 500) {
    if (!rows.length) return 0;
    const quoted = columns.map((c) => JSON.stringify(c)).join(', ');
    let inserted = 0;
    for (let i = 0; i < rows.length; i += size) {
        const slice = rows.slice(i, i + size);
        const params = [];
        const tuples = slice.map((row) => {
            const placeholders = row.map((value, ci) => {
                params.push(value);
                return `$${params.length}${columns[ci] === '_id' ? '::uuid' : ''}`;
            });
            return `(${placeholders.join(', ')})`;
        });
        await runner(`INSERT INTO ${table} (${quoted}) VALUES ${tuples.join(', ')}`, params);
        inserted += slice.length;
    }
    return inserted;
}

const run = (sql, params) => pool.query(sql, params);

/* ══════════════════════════════════════════════════════════════════════════
   Draft entries
   ══════════════════════════════════════════════════════════════════════════ */

const VERSION_ENTRY_COLUMNS = [
    '_id', 'version', 'school', 'section', 'dayOfWeek', 'periodNumber',
    'subject', 'teacher', 'room', 'isManual', 'isLocked', 'note', 'createdAt', 'updatedAt',
];

async function replaceVersionEntries(versionId, schoolId, assignments) {
    await run(`DELETE FROM ${VE} WHERE "version" = $1::uuid`, [String(versionId)]);
    const now = new Date();
    const rows = assignments.map((a) => ([
        newId(), String(versionId), String(schoolId), sid(a.sectionId ?? a.section),
        a.dayOfWeek, Number(a.periodNumber),
        sid(a.subjectId ?? a.subject), sid(a.teacherId ?? a.teacher) || null, sid(a.roomId ?? a.room) || null,
        !!a.isManual, !!a.isLocked, a.note || '', now, now,
    ]));
    return chunkedInsert(run, VE, VERSION_ENTRY_COLUMNS, rows);
}

/* ══════════════════════════════════════════════════════════════════════════
   Conflicts
   ══════════════════════════════════════════════════════════════════════════ */

const CONFLICT_COLUMNS = [
    '_id', 'version', 'school', 'type', 'severity', 'section', 'class', 'teacher',
    'subject', 'room', 'dayOfWeek', 'periodNumber', 'description', 'suggestion',
    'status', 'meta', 'createdAt', 'updatedAt',
];

async function replaceConflicts(versionId, schoolId, conflicts) {
    await run(`DELETE FROM ${TC} WHERE "version" = $1::uuid`, [String(versionId)]);
    const now = new Date();
    const rows = conflicts.map((c) => ([
        newId(), String(versionId), String(schoolId), c.type, c.severity || 'ERROR',
        sid(c.sectionId ?? c.section), sid(c.classId ?? c.class), sid(c.teacherId ?? c.teacher),
        sid(c.subjectId ?? c.subject), sid(c.roomId ?? c.room),
        c.dayOfWeek || '', c.periodNumber == null ? null : Number(c.periodNumber),
        c.description || '', c.suggestion || '', 'open',
        JSON.stringify(c.meta || {}), now, now,
    ]));
    await chunkedInsert(run, TC, CONFLICT_COLUMNS, rows);

    const errorCount = conflicts.filter((c) => (c.severity || 'ERROR') === 'ERROR').length;
    const warningCount = conflicts.filter((c) => c.severity === 'WARNING').length;
    return { conflictCount: conflicts.length, errorCount, warningCount };
}

/* ══════════════════════════════════════════════════════════════════════════
   Publish — atomic projection onto the live timetable
   ══════════════════════════════════════════════════════════════════════════ */

const LIVE_ENTRY_COLUMNS = [
    '_id', 'timetable', 'dayOfWeek', 'periodNumber', 'subject', 'teacher',
    'room', 'sourceVersion', 'additionalSubjects', 'mergedSections',
];

/**
 * Project a validated draft version onto Timetable / TimetableEntry.
 *
 * The live tables are only touched for the sections this version owns, inside a
 * single transaction: either the whole new schedule lands or the currently
 * published one is left exactly as it was. Nothing is deleted before the
 * replacement rows are known.
 *
 * @returns {{sections:number, entries:number, archivedVersions:number}}
 */
async function publishVersion({ version, entries, userId, structureBySection }) {
    const client = await pool.getPool().connect();
    const q = (sql, params) => client.query(sql, params);
    try {
        await q('BEGIN');
        // Serialise publishes per school; released automatically on COMMIT/ROLLBACK.
        await q('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`timetable-publish:${version.school}`]);

        const sectionIds = (version.sections || []).map(String);
        if (!sectionIds.length) throw new Error('This version covers no sections');

        // 1. Make sure every section has a Timetable header row for this year.
        const { rows: existing } = await q(
            `SELECT "_id", "section" FROM ${TT} WHERE "section" = ANY($1::uuid[]) AND "academicYear" = $2::uuid`,
            [sectionIds, String(version.academicYear)],
        );
        const ttBySection = new Map(existing.map((r) => [String(r.section), String(r._id)]));

        const missing = sectionIds.filter((s) => !ttBySection.has(s));
        if (missing.length) {
            const now = new Date();
            const rows = missing.map((sectionId) => {
                const structure = structureBySection?.get(sectionId) || {};
                const id = newId();
                ttBySection.set(sectionId, id);
                return [
                    id, sectionId, String(version.academicYear), String(userId),
                    structure.schoolStartTime || '08:00',
                    structure.schoolEndTime || '14:00',
                    JSON.stringify(structure.periodsStructure || []),
                    now,
                ];
            });
            await chunkedInsert(q, TT,
                ['_id', 'section', 'academicYear', 'createdBy', 'schoolStartTime', 'schoolEndTime', 'periodsStructure', 'createdAt'],
                rows);
        }

        // 2. Swap the entries for exactly these timetables.
        const ttIds = [...ttBySection.values()];
        await q(`DELETE FROM ${TE} WHERE "timetable" = ANY($1::uuid[])`, [ttIds]);

        const liveRows = entries.map((e) => ([
            newId(),
            ttBySection.get(String(e.section)),
            e.dayOfWeek,
            Number(e.periodNumber),
            String(e.subject),
            e.teacher ? String(e.teacher) : null,
            e.room ? String(e.room) : null,
            String(version._id),
            JSON.stringify([]),
            JSON.stringify([]),
        ])).filter((r) => r[1]);
        const inserted = await chunkedInsert(q, TE, LIVE_ENTRY_COLUMNS, liveRows);

        // 3. Retire the version this one replaces, then mark this one live.
        const { rowCount: archived } = await q(
            `UPDATE ${TV} SET "status" = 'archived', "archivedAt" = now(), "updatedAt" = now()
              WHERE "school" = $1::uuid AND "academicYear" = $2::uuid
                AND "status" = 'published' AND "_id" <> $3::uuid`,
            [String(version.school), String(version.academicYear), String(version._id)],
        );
        await q(
            `UPDATE ${TV} SET "status" = 'published', "publishedAt" = now(), "publishedBy" = $2::uuid,
                    "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = now()
              WHERE "_id" = $1::uuid`,
            [String(version._id), String(userId)],
        );

        await q('COMMIT');
        return { sections: sectionIds.length, entries: inserted, archivedVersions: archived };
    } catch (e) {
        try { await q('ROLLBACK'); } catch { /* connection already broken */ }
        throw e;
    } finally {
        client.release();
    }
}

/** Copy every entry of one version into another (duplicate / restore). */
async function copyEntries(fromVersionId, toVersionId, schoolId) {
    const rows = await TimetableVersionEntry.find({ version: fromVersionId }).lean();
    return replaceVersionEntries(toVersionId, schoolId, rows.map((r) => ({
        sectionId: r.section, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber,
        subjectId: r.subject, teacherId: r.teacher, roomId: r.room,
        isManual: r.isManual, isLocked: r.isLocked, note: r.note,
    })));
}

/** Next version number for a school+year, computed in one query. */
async function nextVersionNumber(schoolId, academicYearId) {
    const { rows } = await run(
        `SELECT COALESCE(MAX("versionNumber"), 0)::int + 1 AS next FROM ${TV}
          WHERE "school" = $1::uuid AND "academicYear" = $2::uuid`,
        [String(schoolId), String(academicYearId)],
    );
    return rows[0]?.next || 1;
}

/** Persist a progress tick without re-reading the row. */
async function writeProgress(versionId, progress, extra = {}) {
    const sets = ['"progress" = $2::jsonb', '"updatedAt" = now()'];
    const params = [String(versionId), JSON.stringify(progress)];
    if (extra.status) { params.push(extra.status); sets.push(`"status" = $${params.length}`); }
    await run(`UPDATE ${TV} SET ${sets.join(', ')} WHERE "_id" = $1::uuid`, params);
}

module.exports = {
    replaceVersionEntries, replaceConflicts, publishVersion,
    copyEntries, nextVersionNumber, writeProgress, chunkedInsert,
};
