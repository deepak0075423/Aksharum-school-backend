'use strict';
/**
 * Can a notification actually flag the record it is about?
 * ────────────────────────────────────────────────────────
 * Following a notification lands on a list — the leave queue, the circulation
 * register, your own loans — where the row that prompted it is one of twenty.
 * Three things have to line up for that row to be highlighted:
 *
 *   1. the notify() call passes `link.entityId` — the record it is about;
 *   2. notificationLinks.resolve() turns that into `?focus=<id>`;
 *   3. the page it lands on renders `data-focus-id` on its rows, which
 *      hooks/useFocusHighlight.js then finds and flashes.
 *
 * Break any one and the notification still navigates — it just dumps the reader
 * on a list with no sign of what they clicked. Nothing fails, nothing logs, and
 * it is only noticed by someone wondering why it works for leave but not for
 * library. That is what this script is for.
 *
 * Sibling of checkNotificationLinks.js, which checks that the link types
 * themselves resolve. This one checks the two ends around that.
 *
 *   node scripts/checkNotificationFocus.js
 *
 * Exits non-zero when something regressed. Destinations with genuinely no row
 * to point at — a dashboard, a timetable grid, a page that IS the record — are
 * listed under "nothing to flag" and are not failures.
 */
const fs   = require('fs');
const path = require('path');
const { ROUTES, resolve } = require('../services/notificationLinks');

const BACKEND  = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'school-frontend', 'src');
const ROLES    = ['school_admin', 'teacher', 'student', 'parent'];

// Destinations that are not lists. A dashboard, a calendar and a timetable grid
// have no row to flag, so a notification landing there is doing its whole job
// by navigating. Listed explicitly rather than inferred, so adding a list to
// one of these pages shows up here as work to do.
const NOT_A_LIST = new Set([
  '/parent/dashboard',
  '/admin/hostel/dashboard', '/student/hostel', '/parent/hostel',
  '/admin/timetable', '/teacher/timetable', '/student/timetable',
  '/teacher/my-section', '/student/my-class', '/parent/child-class',
  '/student/attendance', '/parent/child-attendance',
  '/parent/transport/details',
  '/teacher/feedback/dashboard',
  '/admin/videos/browse', '/teacher/videos/catalog', '/student/videos',
  '/student/fees', '/parent/child-fees',
]);

// ── 1. Which notify() calls name the record they are about ───────────────────

function linkSites() {
  const sites = [];
  for (const dir of ['controllers', 'services']) {
    for (const f of fs.readdirSync(path.join(BACKEND, dir)).filter((n) => n.endsWith('.js'))) {
      const rel  = `${dir}/${f}`;
      const text = fs.readFileSync(path.join(BACKEND, rel), 'utf8');
      for (const m of text.matchAll(/\blink:\s*(?![:=])/g)) {
        // Read to the end of the property value, tracking braces so a nested
        // `params: { … }` does not cut it short.
        let depth = 0, end = m.index + m[0].length;
        for (; end < text.length; end++) {
          const c = text[end];
          if (c === '{') depth++;
          else if (c === '}') { if (depth === 0) break; depth--; }
          else if (c === ',' && depth === 0) break;
        }
        const value = text.slice(m.index, end + 1);
        const line  = text.slice(0, m.index).split('\n').length;
        for (const q of value.matchAll(/type:\s*[^,}]*?'([a-zA-Z][\w.]*)'/g)) {
          sites.push({ type: q[1], named: /entityId\s*:/.test(value), where: `${rel}:${line}` });
        }
      }
    }
  }
  return sites;
}

// ── 2. Which file the web app renders for a path ─────────────────────────────

function routeTable() {
  const app = fs.readFileSync(path.join(FRONTEND, 'App.jsx'), 'utf8');

  const imports = new Map();
  for (const m of app.matchAll(/const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\('([^']+)'\)\)/g)) {
    imports.set(m[1], m[2]);
  }

  // A JSX tag cannot be matched with a regex — `element={<Guard><Page/></Guard>}`
  // puts `>` inside an attribute, and anything stopping at the first `>` closes
  // the tag early, nesting every following sibling under it. Scan characters,
  // tracking brace depth and quotes.
  const routes = [];
  const stack  = [];
  for (let i = 0; i < app.length; i++) {
    if (app.startsWith('</Route>', i)) { stack.pop(); i += 7; continue; }
    if (!app.startsWith('<Route', i) || /\w/.test(app[i + 6] || '')) continue;

    let depth = 0, quote = null, end = i + 6;
    for (; end < app.length; end++) {
      const c = app[end];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tok  = app.slice(i, end + 1);
    const p    = (tok.match(/\bpath="([^"]*)"/) || [])[1];
    const comp = (tok.match(/element=\{<(\w+)/) || [])[1];
    const full = (`/${[...stack, p].filter((x) => x != null && x !== '').join('/')}`).replace(/\/+/g, '/');
    if (comp && p != null) routes.push({ path: full, comp });
    if (!/\/\s*>$/.test(tok)) stack.push(p);
    i = end;
  }

  return (webPath) => {
    const cp = webPath.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean);
    const hit = routes
      .filter((r) => r.comp !== 'Navigate')          // a redirect is not a page
      .filter((r) => {
        const rp = r.path.split('/').filter(Boolean);
        if (rp[rp.length - 1] === '*') return rp.slice(0, -1).every((s, i) => s === cp[i]);
        return rp.length === cp.length && rp.every((s, i) => s.startsWith(':') || s === cp[i]);
      })
      .sort((a, b) => b.path.split('/').filter((s) => !s.startsWith(':')).length
                    - a.path.split('/').filter((s) => !s.startsWith(':')).length)[0];
    if (!hit) return null;
    const imp = imports.get(hit.comp);
    if (!imp) return null;
    for (const ext of ['.jsx', '.js', '/index.jsx']) {
      const f = path.join(FRONTEND, imp.replace(/^\.\//, '') + ext);
      if (fs.existsSync(f)) return f;
    }
    return null;
  };
}

// ── 3. Whether that file's rows can be found ─────────────────────────────────

/**
 * Only two things prove it: the page writes `data-focus-id` itself, or it
 * renders its rows through something that does. Merely *importing* a file that
 * mentions the attribute is not proof — a page can import the list frame for a
 * button and still hand-write its own <tr>, which is exactly how the library's
 * My Books page went unmarked. So an import only counts when the page actually
 * renders that component.
 */
function marksRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('data-focus-id')) return { how: 'writes it', sure: true };

  const tables = (text.match(/<ListTable\b/g) || []).length + (text.match(/<Table\b/g) || []).length;
  if (tables) {
    // One list on a single-purpose page is good evidence. A page with tabs, or
    // with several lists, is not: the marked one may not be the one a
    // notification lands on. Admin → Substitutions is exactly that — its only
    // <Table> is the Workload tab listing *teachers*, while the board it opens
    // on is a card list that marked nothing, and this check passed it for
    // months.
    const tabbed = /\btab === |\bview === |\bsub === /.test(text);
    return { how: tables > 1 ? `${tables} tables` : 'one table', sure: !tabbed && tables === 1 };
  }

  for (const m of text.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+'(\.[^']+)'/g)) {
    const names = (m[1] || m[2] || '').split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    const rendered = names.filter((n) => new RegExp(`<${n}\\b`).test(text));
    if (!rendered.length) continue;
    for (const ext of ['.jsx', '.js']) {
      const dep = path.join(path.dirname(file), m[3] + ext);
      if (fs.existsSync(dep) && fs.readFileSync(dep, 'utf8').includes('data-focus-id')) {
        return { how: `via <${rendered[0]}>`, sure: true };
      }
    }
  }
  return null;
}

// ── Report ───────────────────────────────────────────────────────────────────

const fileFor = routeTable();
const sites   = linkSites();

const unnamed = new Map();                   // type → call sites with no entityId
for (const s of sites) {
  if (s.named) continue;
  if (!unnamed.has(s.type)) unnamed.set(s.type, []);
  unnamed.get(s.type).push(s.where);
}

const unflaggable = [];
const unsure      = [];
const noList      = [];
for (const type of Object.keys(ROUTES)) {
  for (const role of ROLES) {
    const r = resolve({ type, entityId: 'FOCUSID' }, role, 'R');
    if (!r.resolved) continue;
    const web = r.web.replace('?focus=FOCUSID', '').replace('&focus=FOCUSID', '');
    if (r.web.split('?')[0].includes('FOCUSID')) continue;   // the page IS the record
    if (NOT_A_LIST.has(web.split('?')[0])) { noList.push([type, role, web]); continue; }
    const file = fileFor(r.web);
    if (!file) { unflaggable.push([type, role, web, 'no route found']); continue; }
    const mark = marksRows(file);
    if (!mark)       { unflaggable.push([type, role, web, `no row markers in ${path.relative(FRONTEND, file)}`]); }
    else if (!mark.sure) { unsure.push([type, role, web, `${mark.how} in ${path.relative(FRONTEND, file)}`]); }
  }
}

let problems = 0;

if (unnamed.size) {
  console.log('notify() calls that name no record — these can never flag a row:\n');
  for (const [type, where] of [...unnamed].sort()) {
    console.log(`  ${type.padEnd(30)} ${where.length} site(s)  ${where.slice(0, 3).join(', ')}`);
  }
  console.log('\n  Some of these are right: a batch notice ("40 loans are overdue") has no');
  console.log('  single row to point at. Add `entityId` wherever one record is in scope.\n');
}

if (unflaggable.length) {
  problems += unflaggable.length;
  console.log('destinations that get a ?focus= but cannot use it:\n');
  for (const [t, role, web, why] of unflaggable) {
    console.log(`  ✗ ${t.padEnd(28)} ${role.padEnd(13)} ${web.padEnd(34)} ${why}`);
  }
  console.log();
}

if (unsure.length) {
  console.log('cannot be proved from here — the page renders a list, but it has tabs or');
  console.log('several lists, so the marked one may not be the one a notification opens on:\n');
  for (const [t, role, web, why] of unsure) {
    console.log(`  ? ${t.padEnd(28)} ${role.padEnd(13)} ${web.padEnd(34)} ${why}`);
  }
  console.log();
}

if (noList.length) {
  console.log(`nothing to flag by design (${noList.length}): a dashboard, a calendar or a grid —`);
  console.log('the notification does its whole job by navigating there.\n');
}

console.log(`${sites.length} notify links; ${sites.filter((s) => s.named).length} name their record.`);
console.log(problems ? `\n${problems} problem(s).` : '\nEvery focusable destination can flag its row.');
process.exit(problems ? 1 : 0);
