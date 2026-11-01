// Integration test: runs the real Edge Function code (api/index.ts) against PGlite (in-memory Postgres) with stubbed Google / Typeform / Storage.
// usage: node run.mjs <pgtest-dir-with-node_modules> <supabase-dir>
import fs from 'node:fs'; import path from 'node:path'; import { stripTypeScriptTypes } from 'node:module'; import { pathToFileURL } from 'node:url';
const [pgDir, supaDir, scratch] = process.argv.slice(2);
const { PGlite } = await import(pathToFileURL(path.join(pgDir, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const shims = await import(pathToFileURL(path.join(supaDir, 'test/shims.mjs')).href);

const pg = new PGlite({ parsers: { 1700: (v) => parseFloat(v), 20: (v) => Number(v) } });
await pg.exec(`create role anon; create role authenticated; create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);`);
await pg.exec(fs.readFileSync(path.join(supaDir, '01_schema.sql'), 'utf8'));

/* build the testable module */
let src = fs.readFileSync(path.join(supaDir, 'functions/api/index.ts'), 'utf8');
src = src.replace('import postgres from "npm:postgres@3.4.5";', `import postgres from "${pathToFileURL(path.join(supaDir, 'test/shims.mjs')).href}";`)
  .replace('import { createClient } from "jsr:@supabase/supabase-js@2";', `import { createClient } from "${pathToFileURL(path.join(supaDir, 'test/shims.mjs')).href}";`)
  .replace('import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";', `import { decodeBase64, encodeBase64 } from "${pathToFileURL(path.join(supaDir, 'test/shims.mjs')).href}";`);
src = src.replace('from "./tf_forms.ts"', 'from "./tf_forms.mjs"');
fs.writeFileSync(path.join(supaDir, 'test/tf_forms.mjs'), stripTypeScriptTypes(fs.readFileSync(path.join(supaDir, 'functions/api/tf_forms.ts'), 'utf8'), { mode: 'strip' }));
src = stripTypeScriptTypes(src, { mode: 'strip' }) + '\nexport { API };\n';
const out = path.join(supaDir, 'test/_api.mjs'); fs.writeFileSync(out, src);

/* globals the function expects */
let handler = null;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_DB_URL: pg, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x' }[k]) }, serve: (h) => { handler = h; } };
const TF = { token: 'tfp_TESTTOKEN_abcdefghijklmnopqrstuvwxyz0123', hooks: {}, responses: {} };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    const tok = decodeURIComponent(url.split('id_token=')[1]); const m = tok.match(/^good:(.+)$/);
    if (!m) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ aud: '715998679704-s1u0frj5cj2vhf4el67mj54sarbu5iq7.apps.googleusercontent.com', iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3000), email: m[1], email_verified: 'true' }), { status: 200 });
  }
  if (url.startsWith('https://api.typeform.com')) {
    const auth = (opt.headers && opt.headers.Authorization) || '';
    if (auth !== 'Bearer ' + TF.token) return new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
    let m;
    if (/\/me$/.test(url)) return new Response('{"alias":"scentsense"}', { status: 200 });
    if ((m = url.match(/\/forms\/([^/]+)\/webhooks\/([^/?]+)/))) { if ((opt.method || 'GET') === 'PUT') { TF.hooks[m[1]] = JSON.parse(opt.body); return new Response('{"enabled":true}', { status: 200 }); } if (opt.method === 'DELETE') { delete TF.hooks[m[1]]; return new Response('', { status: 204 }); } }
    if ((m = url.match(/\/forms\/([^/]+)\/responses/))) { const items = TF.responses[m[1]] || []; const since = (url.match(/since=([^&]+)/) || [])[1]; return new Response(JSON.stringify({ items: since ? items.filter((i) => i.submitted_at > decodeURIComponent(since)) : items }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  }
  if (url.startsWith('https://api.resend.com')) { MAILS.push(JSON.parse(opt.body)); return new Response('{"id":"x"}', { status: 200 }); }
  return realFetch(url, opt);
};
const MAILS = [];
const mod = await import(pathToFileURL(out).href);

/* tiny test framework */
let pass = 0, fail = 0; const failures = [];
function report() { console.log('\nPASS ' + pass + '  FAIL ' + fail); failures.forEach((f) => console.log(' x ' + f)); }
process.on('uncaughtException', (e) => { console.log('CRASH: ' + e.message); report(); process.exit(1); });
/* ทุกคำขอใช้เซสชัน (เข้าสู่ระบบด้วยรหัสผ่าน): ทดสอบสร้างเซสชันตรงในฐานข้อมูลต่ออีเมล */
const { createHash, randomBytes } = await import('node:crypto');
const SESS = new Map();
const sess = async (email) => { if (SESS.has(email)) return SESS.get(email); const tok = randomBytes(32).toString('base64url'); await pg.query(`insert into costing.sessions (id, email, expires_at, via) values ($1, $2, now() + interval '1 day', 'test')`, [createHash('sha256').update(tok).digest('hex'), email]); SESS.set(email, tok); return tok; };
const raw = async (body) => (await handler(new Request('https://x/functions/v1/api', { method: 'POST', body: JSON.stringify(body) }))).json();
const call = async (email, fn, ...args) => raw(email ? { fn, args, session: await sess(email) } : { fn, args });
const ok = async (label, p, check) => { try { const r = await p; if (!r.ok) throw new Error('API error: ' + r.error); if (check) { const v = check(r.result); if (v === false) throw new Error('check failed: ' + JSON.stringify(r.result).slice(0, 300)); } pass++; return r.result; } catch (e) { fail++; failures.push(label + ' → ' + e.message); return null; } };
const err = async (label, p, expect) => { try { const r = await p; if (r.ok) throw new Error('expected error ' + expect + ' but succeeded'); if (expect && !String(r.error).includes(expect)) throw new Error('got "' + r.error + '" expected "' + expect + '"'); pass++; } catch (e) { fail++; failures.push(label + ' → ' + e.message); } };
const eq = (label, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; failures.push(label + ' → got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); } };

const OWNER = 'ratchaphon@scentandsense.co.th', ADMIN = 'rujira@scentandsense.co.th', COST = 'ra@scentandsense.co.th', VIEW = 'view@scentandsense.co.th', NOSE = 'nose@scentandsense.co.th', OUT = 'stranger@scentandsense.co.th';
const builtin = JSON.parse(fs.readFileSync(path.join(scratch, 'prices-builtin.json'), 'utf8'));
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('hello pdf '.repeat(50))]);
const ISOd = (s) => new Date(s).toISOString();

/* ---------- auth & unknown ---------- */
await err('no token', call('', 'bootstrap'), 'AUTH_REQUIRED');
await err('bad session', raw({ fn: 'bootstrap', session: 'junk-session-token-abcdefghijklmnop' }), 'AUTH_EXPIRED');
await err('google token no longer logs in', raw({ fn: 'bootstrap', idToken: 'good:' + 'ratchaphon@scentandsense.co.th' }), 'AUTH_PASSWORD_REQUIRED');
await err('unknown fn', call(OWNER, 'dropEverything'), 'UNKNOWN_FUNCTION');
await err('foreign domain', call('x@gmail.com', 'bootstrap'), 'DOMAIN:');
await err('importAll by non-owner', call(ADMIN, 'importAll', {}), 'FORBIDDEN');
const GET = await (await handler(new Request('https://x/functions/v1/api'))).json(); eq('GET health', GET.ok, true);
const pre = await (await handler(new Request('https://x', { method: 'OPTIONS' }))); eq('OPTIONS 204', pre.status, 204);

/* ---------- importAll (fake export in Apps Script shape) ---------- */
const exp = {
  Users: [{ email: ADMIN, role: 'admin', active: true, addedBy: OWNER, addedAt: ISOd('2026-10-13T11:37:34Z') }, { email: COST, role: 'costing', active: 'TRUE', addedBy: ADMIN, addedAt: ISOd('2026-10-13T11:52:12Z') }, { email: VIEW, role: 'viewer', active: false, addedBy: OWNER, addedAt: '' }, { email: NOSE, role: 'perf', active: true, addedBy: OWNER, addedAt: ISOd('2026-10-14T00:00:00Z') }],
  Roles: [{ id: 'admin', name: 'ผู้ดูแลระบบ', perms: '{"calc":true,"export":true,"viewDb":true,"editPrices":true,"manageUsers":true}', system: true, order: 1 }, { id: 'costing', name: 'ทีมต้นทุน', perms: '{"calc":true,"export":true,"viewDb":true}', system: 'FALSE', order: 2 },
    { id: 'viewer', name: 'ดูอย่างเดียว', perms: '{"viewDb":true}', system: false, order: 4 }, { id: 'perf', name: 'นักปรุงกลิ่น', perms: '{"perfumer":true}', system: false, order: 9 }],
  Settings: [{ key: 'owner', value: OWNER }, { key: 'autoJoin', value: 'FALSE' }, { key: 'defaultRole', value: 'viewer' }, { key: 'pricesCustom', value: 'TRUE' }, { key: 'pricesFile', value: 'PRODUCT RM.xlsx' }, { key: 'pricesUpdated', value: '22/10/2026 20:06:00' }, { key: 'costThreshold', value: 45 }, { key: 'rmDocFolder', value: 'xyz' }],
  Prices: [{ code: 'RM-002-001-0184', name: 'Iso E Super', price: 3.5, status: 'ok', note: '', updatedAt: ISOd('2026-10-20T01:00:00Z'), updatedBy: OWNER }, { code: 'RM-002-001-0203', name: 'Hedione', price: '', status: 'recheck', note: 'ถามซัพ', updatedAt: '', updatedBy: '' }, { code: 'RM-044-001-0116', name: 'Ambroxan', price: 12, status: 'ok', note: '', updatedAt: '', updatedBy: '' }],
  Requests: [], Visitors: [{ email: OWNER, firstSeen: ISOd('2026-10-12T00:26:48Z'), lastSeen: ISOd('2026-10-23T12:54:53Z') }],
  Log: [{ at: ISOd('2026-10-13T00:00:00Z'), email: OWNER, action: 'setUser', detail: 'x' }],
  Formulas: [{ id: 'pmv6nmk8x4', owner: ADMIN, name: 'SENDING YOU SMILE', updatedAt: ISOd('2026-10-13T12:00:00Z'), data: JSON.stringify({ id: 'pmv6nmk8x4', name: 'SENDING YOU SMILE', lines: [] }) },
    { id: 'pmv7ri7h51', owner: COST, name: 'BEFORE YOU GO', updatedAt: ISOd('2026-10-14T12:00:00Z'), data: JSON.stringify({ id: 'pmv7ri7h51', name: 'BEFORE YOU GO', lines: [{ code: 'RM-002-001-0184', amt: 50 }, { code: 'RM-044-001-0116', amt: 50 }] }) }],
  Pricing: [{ key: COST + '|pmv7ri7h51', owner: COST, formulaId: 'pmv7ri7h51', sell: 3312, updatedAt: ISOd('2026-10-14T14:09:02Z'), updatedBy: OWNER }],
  Complaints: [{ id: 'c6a94c8f70cf8', email: COST, subject: 'ขอเพิ่มรหัส RM', detail: 'รบกวนเพิ่มรหัส', status: 'done', reply: 'เรียบร้อย', repliedBy: OWNER, createdAt: ISOd('2026-10-15T09:06:56Z'), updatedAt: ISOd('2026-10-15T10:10:44Z') }],
  Compliance: [{ id: 'k1abc', source: 'IFRA', name: 'Coumarin', cas: '91-64-5', type: 'restricted', limits: '{"4":0.6,"9":1.2}', note: '', updatedAt: ISOd('2026-10-22T15:37:00Z') }],
  RmMap: [{ code: 'RM-002-001-0184', cas: '54464-57-2', name: 'Iso E Super', pct: 100 }, { code: 'RM-044-001-0116', cas: '6790-58-5', name: 'Ambroxan', pct: '' }],
  Docs: [], RmDocs: [{ id: 'rAAA', codes: 'RM-044-001-0116', kind: 'MSDS', file: 'MSDS-Ambroxan.pdf', driveId: 'zzz', size: 123, supplier: 'Bio-Young', sg: '', sgText: '', temp: '', density: '', flash: '', flashC: '', hazards: '', hazText: 'Not classified', pictos: '', picSrc: 'none', signal: '', note: '', uploadedAt: ISOd('2026-10-22T15:19:00Z'), uploadedBy: OWNER, updatedAt: ISOd('2026-10-22T15:19:00Z'), updatedBy: OWNER }],
  Briefs: [{ id: 'bOLD', kind: 'ODM', brand: 'Old Brand', status: 'design', owner: OWNER, contact: 'x', phone: '', email: '', summary: '', createdAt: ISOd('2026-10-23T01:00:00Z'), createdBy: OWNER, updatedAt: ISOd('2026-10-23T01:00:00Z'), updatedBy: OWNER, data: '{"like":["ดอกไม้"]}', tfToken: '' }],
  Scents: [{ id: 'sOLD', code: 'SC-2026-0001', name: 'Old Scent', briefId: 'bOLD', family: 'ดอกไม้', status: 'approved', owner: OWNER, formulaId: '', createdAt: ISOd('2026-10-23T02:00:00Z'), updatedAt: ISOd('2026-10-23T02:00:00Z'), updatedBy: OWNER, data: '{"top":"x"}' }],
  builtin,
};
const imp = await ok('importAll', call(OWNER, 'importAll', exp), (r) => r.counts.users === 4 && r.counts.prices === 3 && r.counts.formulas === 2 && r.counts.prices_builtin === builtin.length);
await ok('importRmFile', call(OWNER, 'importRmFile', 'rAAA', pdf.toString('base64')), (r) => r.size === pdf.length);
await ok('finishMigration', call(OWNER, 'finishMigration'), (r) => r.ok === true);
await err('importAll after migrated', call(OWNER, 'importAll', exp), 'ย้ายข้อมูลไปแล้ว');
await err('importRmFile after migrated', call(OWNER, 'importRmFile', 'rAAA', pdf.toString('base64')), 'ย้ายข้อมูลไปแล้ว');

/* ---------- bootstrap & permissions ---------- */
await ok('bootstrap owner', call(OWNER, 'bootstrap'), (r) => r.me.isOwner && r.me.perms.perfumer === true && r.prices.entries.length === 3 && r.access.autoJoin === false && r.access.defaultRole === 'viewer' && r.prices.custom === true && r.prices.src.file === 'PRODUCT RM.xlsx');
await ok('bootstrap admin role gets all perms', call(ADMIN, 'bootstrap'), (r) => r.me.role === 'admin' && r.me.perms.perfumer === true && r.me.perms.manageUsers === true);
await ok('bootstrap costing', call(COST, 'bootstrap'), (r) => r.me.role === 'costing' && !r.me.perms.editPrices && r.prices.entries[0].c === 'RM-002-001-0184' && r.prices.entries[1].p === null);
await ok('bootstrap suspended viewer', call(VIEW, 'bootstrap'), (r) => r.me.active === false && r.prices === null);
await ok('bootstrap unknown (no autojoin)', call(OUT, 'bootstrap'), (r) => !r.me.role && r.prices === null);
await ok('visitor recorded', call(OWNER, 'adminData'), (r) => r.visitors.some((v) => v.email === OUT) && r.users.length === 4 && r.users[0].addedAt.startsWith('2026-10-13'));
await err('adminData forbidden for costing', call(COST, 'adminData'), 'FORBIDDEN');
await ok('requestAccess', call(OUT, 'requestAccess'), (r) => r === 'OK');
await ok('requestAccess again ok', call(OUT, 'requestAccess'), (r) => r === 'OK');
await ok('requests listed', call(OWNER, 'adminData'), (r) => r.requests.length === 1);
await ok('setUser grants + clears request', call(OWNER, 'setUser', OUT, 'costing', true, false), (r) => r.users.some((u) => u.email === OUT) && r.requests.length === 0);
await err('setUser self', call(OWNER, 'setUser', OWNER, 'costing', true, false), 'เจ้าของระบบ');
await err('setUser bad role', call(OWNER, 'setUser', 'new@scentandsense.co.th', 'nope', true, false), 'ไม่พบบทบาท');
await err('setUser foreign domain', call(OWNER, 'setUser', 'a@gmail.com', 'costing', true, false), 'ใช้ได้เฉพาะอีเมล');
await ok('removeUser', call(OWNER, 'removeUser', OUT), (r) => !r.users.some((u) => u.email === OUT));
await ok('saveAccess', call(OWNER, 'saveAccess', true, 'costing'), (r) => r.access.autoJoin === true && r.access.defaultRole === 'costing');
await ok('autojoin works', call('auto@scentandsense.co.th', 'bootstrap'), (r) => r.me.auto === true && r.me.role === 'costing');
await ok('saveAccess back', call(OWNER, 'saveAccess', false, 'viewer'), (r) => r.access.autoJoin === false);
let roles = await ok('createRole', call(OWNER, 'createRole', 'แผนกทดสอบ', { calc: true, bogus: true }), (r) => Object.values(r.roles).some((x) => x.name === 'แผนกทดสอบ' && x.perms.calc && !x.perms.bogus));
const newRole = Object.keys(roles.roles).find((k) => roles.roles[k].name === 'แผนกทดสอบ');
await ok('updateRole', call(OWNER, 'updateRole', newRole, { name: 'แผนกทดสอบ2', perms: { viewDb: true } }), (r) => r.roles[newRole].name === 'แผนกทดสอบ2' && r.roles[newRole].perms.viewDb);
await err('updateRole system', call(OWNER, 'updateRole', 'admin', { name: 'x' }), 'บทบาทหลัก');
await ok('deleteRole', call(OWNER, 'deleteRole', newRole), (r) => !r.roles[newRole]);
await err('deleteRole in use', call(OWNER, 'deleteRole', 'costing'), 'ยังมีผู้ใช้');
await err('deleteRole default', call(OWNER, 'deleteRole', 'viewer'), 'ยังมีผู้ใช้');

/* ---------- prices ---------- */
await err('updatePrices forbidden (costing)', call(COST, 'updatePrices', [{ c: 'RM-002-001-0184', p: 1 }]), 'FORBIDDEN');
await ok('updatePrices change+add', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 4.25, o: 'ขึ้นราคา' }, { c: 'RM-002-001-0203', p: 7, s: 'ok' }, { c: 'RM-009-001-0001', n: 'New Item', p: null, s: 'rd' }]), (r) => r.changed === 3 && r.added === 1 && /^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(r.updated));
await ok('updatePrices no-op', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 4.25, o: 'ขึ้นราคา' }]), (r) => r.changed === 0);
await err('updatePrices bad code', call(OWNER, 'updatePrices', [{ c: 'XX-1', p: 1 }]), 'รหัส RM ไม่ถูกต้อง');
await err('updatePrices new needs name', call(OWNER, 'updatePrices', [{ c: 'RM-009-001-0002', p: 1 }]), 'ต้องมีชื่อ');
await ok('prices reflect', call(OWNER, 'bootstrap'), (r) => { const e = Object.fromEntries(r.prices.entries.map((x) => [x.c, x])); return e['RM-002-001-0184'].p === 4.25 && e['RM-002-001-0203'].s === 'ok' && e['RM-009-001-0001'].s === 'rd' && e['RM-002-001-0184'].b === OWNER && r.prices.entries.length === 4; });
await ok('savePrices replace', call(OWNER, 'savePrices', { file: 'new.xlsx', entries: [{ c: 'rm-002-001-0184', n: 'Iso', p: 9, s: 'ok', o: '' }, { c: 'RM-002-001-0203', n: 'Hed', p: null, s: 'R' }] }), (r) => r.entries.length === 2 && r.entries[0].c === 'RM-002-001-0184' && r.src.file === 'new.xlsx' && r.entries[1].s === 'none');
await ok('resetPrices builtin', call(OWNER, 'resetPrices'), (r) => r.entries.length === builtin.length && r.custom === false);
await err('savePrices empty', call(OWNER, 'savePrices', { entries: [] }), '1–5,000');
/* supplier column */
{
  const sup = async (code) => (await call(OWNER, 'bootstrap')).result.prices.entries.filter((x) => x.c === code).map((x) => x.v);
  await ok('supplier set', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 9, v: '  Acme Co  ' }]), (r) => r.changed === 1);
  eq('supplier trimmed + returned', (await sup('RM-002-001-0184'))[0], 'Acme Co');
  await ok('supplier kept when v omitted', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 10 }]), (r) => r.changed === 1);
  eq('supplier still there', (await sup('RM-002-001-0184'))[0], 'Acme Co');
  await ok('supplier only change counts', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 10, v: 'Beta' }]), (r) => r.changed === 1);
  await ok('supplier same = no-op', call(OWNER, 'updatePrices', [{ c: 'RM-002-001-0184', p: 10, v: 'Beta' }]), (r) => r.changed === 0);
  await ok('savePrices without v keeps supplier by code', call(OWNER, 'savePrices', { file: 's.xlsx', entries: [{ c: 'RM-002-001-0184', n: 'Iso', p: 3, s: 'ok' }, { c: 'RM-002-001-0203', n: 'Hed', p: 1, s: 'ok' }] }), (r) => r.entries.find((x) => x.c === 'RM-002-001-0184').v === 'Beta' && r.entries.find((x) => x.c === 'RM-002-001-0203').v === '');
  await ok('savePrices with v overrides', call(OWNER, 'savePrices', { file: 's2.xlsx', entries: [{ c: 'RM-002-001-0184', n: 'Iso', p: 3, s: 'ok', v: '' }, { c: 'RM-002-001-0203', n: 'Hed', p: 1, s: 'ok', v: 'Gamma' }] }), (r) => r.entries.find((x) => x.c === 'RM-002-001-0184').v === '' && r.entries.find((x) => x.c === 'RM-002-001-0203').v === 'Gamma');
  await ok('resetPrices keeps supplier', call(OWNER, 'resetPrices'), (r) => r.entries.find((x) => x.c === 'RM-002-001-0203').v === 'Gamma');
  await ok('supplier hidden without editPrices', call(COST, 'bootstrap'), (r) => !r.prices || r.prices.entries.every((x) => !('v' in x)));
}

/* ---------- formulas / pricing ---------- */
await ok('loadMyFormulas (costing)', call(COST, 'loadMyFormulas'), (r) => r.length === 1 && r[0].id === 'pmv7ri7h51' && JSON.parse(r[0].data).name === 'BEFORE YOU GO');
await ok('saveMyFormulas add+drop', call(COST, 'saveMyFormulas', [{ id: 'pnew00001', name: 'สูตรใหม่', data: '{"lines":[]}' }]), (r) => r.saved === 1 && r.changed === 1);
await ok('formulas after', call(COST, 'loadMyFormulas'), (r) => r.length === 1 && r[0].id === 'pnew00001');
await err('saveMyFormulas bad id', call(COST, 'saveMyFormulas', [{ id: 'a', name: 'x', data: '{}' }]), 'รหัสสูตรไม่ถูกต้อง');
await err('saveMyFormulas bad json', call(COST, 'saveMyFormulas', [{ id: 'pbad0001', name: 'x', data: 'nope' }]), 'ข้อมูลสูตรไม่ถูกต้อง');
/* ประวัติเวอร์ชันและ Feedback ของสูตร (ตารางแยก) */
await err('formula history forbidden (outsider)', call(OUT, 'listFormulaHistory', 'pnew00001'), 'FORBIDDEN');
await err('formula history forbidden (viewDb only)', call(VIEW, 'listFormulaHistory', 'pnew00001'), 'FORBIDDEN');
await err('feedback needs text', call(COST, 'addFormulaFeedback', 'pnew00001', { ver: 1, kind: 'revise', text: '  ' }), 'ใส่รายละเอียด');
await err('feedback bad formula id', call(COST, 'addFormulaFeedback', 'a', { ver: 1, text: 'x' }), 'รหัสสูตรไม่ถูกต้อง');
const fb1 = await ok('feedback add (owner)', call(COST, 'addFormulaFeedback', 'pnew00001', { ver: 1, kind: 'revise', text: 'หวานไป ลดวานิลลา' }), (r) => r.length === 1 && r[0].kind === 'revise' && r[0].ver === 1 && r[0].by === COST);
const fb2 = await ok('feedback add (perfumer, cross-team)', call(NOSE, 'addFormulaFeedback', 'pnew00001', { ver: 1, kind: 'bogus', text: 'ลูกค้าชอบโทนไม้' }), (r) => r.length === 2 && r[1].kind === 'note' && r[1].by === NOSE);
await err('feedback add forbidden (viewDb only)', call(VIEW, 'addFormulaFeedback', 'pnew00001', { ver: 1, text: 'x' }), 'FORBIDDEN');
await ok('snapshot version 1', call(COST, 'snapshotFormulaVersion', 'pnew00001', { ver: 1, name: 'สูตรใหม่', lines: [{ code: 'RM-002-001-0184', amt: '60' }, { code: 'RM-002-001-0203', amt: '40', override: '' }], design: { app: 'edp', dosage: '18' }, total: 2200 }),
  (r) => r.length === 1 && r[0].v === 1 && r[0].fb.length === 2 && r[0].total === 2200 && r[0].lines.length === 2 && r[0].lines[0].code === 'RM-002-001-0184' && r[0].design.app === 'edp');
await ok('snapshot same version overwrites', call(COST, 'snapshotFormulaVersion', 'pnew00001', { ver: 1, name: 'สูตรใหม่', lines: [{ code: 'RM-002-001-0184', amt: '100' }], total: null }), (r) => r.length === 1 && r[0].lines.length === 1 && r[0].total === null);
await err('snapshot needs calc perm', call(VIEW, 'snapshotFormulaVersion', 'pnew00001', { ver: 1, lines: [] }), 'FORBIDDEN');
await ok('history visible to perfumer', call(NOSE, 'listFormulaHistory', 'pnew00001'), (r) => r.versions.length === 1 && r.feedback.length === 2 && r.versions[0].by === COST);
await err('feedback delete by non-creator non-owner', call(NOSE, 'deleteFormulaFeedback', fb1[0].id), 'FORBIDDEN');
await ok('feedback delete by formula owner', call(COST, 'deleteFormulaFeedback', fb2[1].id), (r) => r.length === 1 && r[0].id === fb1[0].id);
await err('feedback delete missing', call(COST, 'deleteFormulaFeedback', 'nope'), 'ไม่พบรายการนี้');
await ok('other user formulas untouched', call(ADMIN, 'loadMyFormulas'), (r) => r.length === 1 && r[0].id === 'pmv6nmk8x4');
await err('adminFormulas forbidden', call(COST, 'adminFormulas'), 'FORBIDDEN');
await ok('adminFormulas', call(ADMIN, 'adminFormulas'), (r) => r.length === 2);
await err('loadPricing forbidden', call(COST, 'loadPricing'), 'FORBIDDEN');
await ok('loadPricing', call(OWNER, 'loadPricing'), (r) => r.threshold === 45 && r.items.length === 1 && r.items[0].sell === 3312);
await ok('savePricing', call(OWNER, 'savePricing', [{ owner: COST, formulaId: 'pnew00001', sell: 999 }, { owner: COST, formulaId: 'pmv7ri7h51', sell: 3312 }], 40), (r) => r.changed === 1);
await ok('threshold saved', call(OWNER, 'loadPricing'), (r) => r.threshold === 40 && r.items.length === 2);
await err('savePricing bad threshold', call(OWNER, 'savePricing', [], 500), 'เกณฑ์ต้นทุน');

/* ---------- complaints ---------- */
await ok('myComplaints', call(COST, 'myComplaints'), (r) => r.length === 1 && r[0].status === 'done');
await ok('submitComplaint', call(COST, 'submitComplaint', 'หัวข้อทดสอบ', 'รายละเอียดทดสอบ'), (r) => r.length === 2 && r[0].status === 'new');
await err('submitComplaint short', call(COST, 'submitComplaint', 'x', 'abc'), 'อย่างน้อย 5');
await err('submitComplaint suspended', call(VIEW, 'submitComplaint', 'x', 'รายละเอียดยาว'), 'FORBIDDEN');
await ok('bootstrap badge', call(OWNER, 'bootstrap'), (r) => r.complaintsNew === 1);
await err('adminComplaints forbidden', call(COST, 'adminComplaints'), 'FORBIDDEN');
const cm = await ok('adminComplaints', call(OWNER, 'adminComplaints'), (r) => r.length === 2);
const newC = cm.find((c) => c.status === 'new');
await err('reply rejected needs reason', call(OWNER, 'replyComplaint', newC.id, 'rejected', ''), 'เหตุผล');
await ok('replyComplaint', call(OWNER, 'replyComplaint', newC.id, 'progress', 'กำลังดู'), (r) => r.find((c) => c.id === newC.id).status === 'progress' && r.find((c) => c.id === newC.id).repliedBy === OWNER);
await err('replyComplaint bad status', call(OWNER, 'replyComplaint', newC.id, 'zzz', ''), 'สถานะไม่ถูกต้อง');

/* ---------- compliance / rmmap ---------- */
await ok('loadCompliance', call(COST, 'loadCompliance'), (r) => r.rules.length === 1 && r.rules[0].limits['9'] === 1.2 && r.map.length === 2 && r.map[1].pct === 100 && r.canEditRules === false && r.canEditMap === false && r.updated.rulesBy === '');
await err('saveComplianceRules forbidden', call(COST, 'saveComplianceRules', [{ source: 'IFRA', name: 'x', cas: '1-1-1' }]), 'FORBIDDEN');
await ok('saveComplianceRules IFRA replaced, FDA kept', call(OWNER, 'saveComplianceRules', [{ source: 'FDA', name: 'Lead', cas: '7439-92-1', type: 'prohibited' }, { source: 'IFRA', name: 'Eugenol', cas: '97-53-0', limits: { 4: 2.5, '*': 5, bad: 'x' } }]), (r) => r.saved === 2);
await ok('rules after', call(OWNER, 'loadCompliance'), (r) => r.rules.length === 2 && r.rules.find((x) => x.name === 'Eugenol').limits['4'] === 2.5 && r.rules.find((x) => x.name === 'Eugenol').limits.bad === undefined && r.canEditRules);
await ok('saveRmMap', call(OWNER, 'saveRmMap', [{ code: 'RM-002-001-0184', cas: '54464-57-2', name: 'Iso', pct: 85 }, { code: 'RM-002-001-0184', cas: '1-1-1', pct: 15 }]), (r) => r.saved === 2);
await err('saveRmMap bad pct', call(OWNER, 'saveRmMap', [{ code: 'RM-002-001-0184', cas: '1-1-1', pct: 150 }]), '0–100');
await ok('map reloaded', call(COST, 'loadCompliance'), (r) => r.map.length === 2 && r.map[0].pct === 85);

/* ---------- docs ---------- */
await err('issueDoc forbidden (no export for viewer)', call(NOSE, 'issueDoc', 'SDS', 'pnew00001', '{}'), 'FORBIDDEN');
await err('issueDoc unknown formula', call(COST, 'issueDoc', 'SDS', 'pdoesnotexist', '{"product":"x"}'), 'ไม่พบสูตร');
await err('issueDoc other owner formula', call(COST, 'issueDoc', 'SDS', 'pmv6nmk8x4', '{"product":"x"}'), 'FORBIDDEN');
const d1 = await ok('issueDoc SDS', call(COST, 'issueDoc', 'sds', 'pnew00001', JSON.stringify({ product: 'Test Oil', customer: 'ACME', brand: 'B' })), (r) => /^SDS-\d{4}-0001$/.test(r.docNo) && r.rev === 1);
const d2 = await ok('issueDoc SDS again', call(COST, 'issueDoc', 'SDS', 'pnew00001', JSON.stringify({ product: 'Test Oil' })), (r) => /-0002$/.test(r.docNo) && r.rev === 2);
const d3 = await ok('issueDoc IFRA by admin for any formula', call(ADMIN, 'issueDoc', 'IFRA', 'pnew00001', JSON.stringify({ product: 'Test' })), (r) => /^IFRA-\d{4}-0001$/.test(r.docNo));
for (const ty of ['STAB', 'PACK', 'SPEC']) await ok('issueDoc ' + ty, call(COST, 'issueDoc', ty.toLowerCase(), 'pnew00001', JSON.stringify({ product: 'Test Oil', rows: [{ cond: '45 °C', res: 'Pass' }] })), (r) => new RegExp('^' + ty + '-\\d{4}-0001$').test(r.docNo) && r.rev === 1);
await err('issueDoc unknown type', call(COST, 'issueDoc', 'COA', 'pnew00001', JSON.stringify({ product: 'x' })), 'ประเภทเอกสาร');
await ok('listDocs own', call(COST, 'listDocs'), (r) => r.length === 6 && r[0].issuedAt >= r[1].issuedAt && ['STAB', 'PACK', 'SPEC'].every((t) => r.some((d) => d.type === t)));
await ok('listDocs other user sees none', call(OWNER, 'listDocs'), (r) => r.length === 6);   // owner is admin: sees all
await ok('getDoc', call(COST, 'getDoc', d1.id), (r) => JSON.parse(r.data).docNo === d1.docNo && JSON.parse(r.data).formulaOwner === COST);
await err('getDoc other', call(NOSE, 'getDoc', d1.id), 'FORBIDDEN');
await err('voidDoc forbidden', call(COST, 'voidDoc', d1.id, 'x'), 'FORBIDDEN');
await ok('voidDoc', call(OWNER, 'voidDoc', d2.id, 'ผิดพลาด'), (r) => r.find((x) => x.id === d2.id).status === 'void');

/* ---------- RM docs / storage ---------- */
const pdfB64 = pdf.toString('base64');
await ok('listRmDocs', call(COST, 'listRmDocs'), (r) => r.items.length === 1 && r.items[0].codes[0] === 'RM-044-001-0116' && r.canEdit === false && r.items[0].picSrc === 'none');
await err('uploadRmDoc forbidden', call(COST, 'uploadRmDoc', { codes: ['RM-044-001-0116'], kind: 'MSDS', file: 'a.pdf' }, pdfB64), 'FORBIDDEN');
const up = await ok('uploadRmDoc new', call(OWNER, 'uploadRmDoc', { codes: ['RM-002-001-0184', 'rm-002-001-0203'], kind: 'MSDS', file: 'UA-1.pdf', supplier: "I'PEARL", sg: 0.9653, sgText: 'Specific Gravity 0.957-0.977', temp: 20, density: 0.9653, flash: '250 °F (121.1 °C)', flashC: 121.1, hazards: ['H315', 'bogus'], pictos: ['excl', 'nope'], picSrc: 'text', signal: 'warning', hazText: 'x' }, pdfB64),
  (r) => r.codes.length === 2 && r.hazards.join() === 'H315' && r.pictos.join() === 'excl' && r.density === 0.9653 && r.signal === 'WARNING' && r.size === pdf.length);
await err('uploadRmDoc not pdf', call(OWNER, 'uploadRmDoc', { codes: ['RM-002-001-0184'], kind: 'MSDS', file: 'b.pdf' }, Buffer.from('hello').toString('base64')), 'ไม่ใช่ PDF');
await err('uploadRmDoc bad ext', call(OWNER, 'uploadRmDoc', { codes: ['RM-002-001-0184'], kind: 'MSDS', file: 'b.txt' }, pdfB64), 'รองรับเฉพาะไฟล์ PDF');
await err('uploadRmDoc bad code', call(OWNER, 'uploadRmDoc', { codes: ['XX'], kind: 'MSDS', file: 'b.pdf' }, pdfB64), 'รหัส RM ไม่ถูกต้อง');
const pathBefore = (await pg.query(`select storage_path from costing.rmdocs where id = $1`, [up.id])).rows[0].storage_path;
const up2 = await ok('uploadRmDoc replace same name', call(OWNER, 'uploadRmDoc', { codes: ['RM-002-001-0184'], kind: 'MSDS', file: 'UA-1.pdf', density: 0.97 }, pdfB64), (r) => r.id === up.id && r.density === 0.97);
eq('old file removed on replace', shims.STORE.has('rm-docs/' + pathBefore), false);
await ok('getRmDocFile', call(COST, 'getRmDocFile', up.id), (r) => r.name === 'UA-1.pdf' && Buffer.from(r.b64, 'base64').equals(pdf));
await ok('getRmDocFile migrated file', call(COST, 'getRmDocFile', 'rAAA'), (r) => Buffer.from(r.b64, 'base64').equals(pdf));
await ok('updateRmDoc', call(OWNER, 'updateRmDoc', up.id, { codes: ['RM-002-001-0184'], kind: 'MSDS', pictos: ['flame', 'env'], hazards: 'H226,H410', sg: '', density: '' }), (r) => r.pictos.join() === 'flame,env' && r.hazards.join() === 'H226,H410' && r.density === null);
await err('updateRmDoc forbidden', call(COST, 'updateRmDoc', up.id, { codes: ['RM-002-001-0184'] }), 'FORBIDDEN');
await ok('saveExport', call(COST, 'saveExport', 'ต้นทุน.xlsx', Buffer.from('PK-fake').toString('base64')), (r) => r.startsWith('https://signed.test/exports/' + COST));
await ok('deleteRmDoc', call(OWNER, 'deleteRmDoc', up.id), (r) => r.deleted === up.id);
await err('getRmDocFile deleted', call(COST, 'getRmDocFile', up.id), 'ไม่พบเอกสาร');

/* ---------- briefs / scents ---------- */
await ok('listBriefs (costing can view)', call(COST, 'listBriefs'), (r) => r.length === 1 && r[0].data.like[0] === 'ดอกไม้');
await err('saveBrief forbidden for costing', call(COST, 'saveBrief', { brand: 'x', kind: 'ODM' }), 'FORBIDDEN');
await err('listBriefs forbidden for suspended', call(VIEW, 'listBriefs'), 'FORBIDDEN');
const b1 = await ok('saveBrief new (nose)', call(NOSE, 'saveBrief', { brand: 'Lumière', kind: 'odm', status: 'bogus', contact: 'A', phone: '081', data: { like: ['ชา'], arch: { answers: ['1'], result: '' } } }), (r) => r.kind === 'ODM' && r.status === 'new' && r.createdBy === NOSE && r.data.like[0] === 'ชา');
await ok('saveBrief edit keeps creator', call(OWNER, 'saveBrief', { id: b1.id, brand: 'Lumière', kind: 'ODM', status: 'design', data: { like: ['ชา'] } }), (r) => r.status === 'design' && r.createdBy === NOSE && r.updatedBy === OWNER);
await err('saveBrief unknown id', call(OWNER, 'saveBrief', { id: 'bnope', brand: 'x', kind: 'ODM' }), 'ไม่พบบรีฟ');
await err('saveBrief no brand', call(OWNER, 'saveBrief', { brand: '', kind: 'ODM' }), 'ใส่ชื่อแบรนด์');
const s1 = await ok('saveScent from brief', call(NOSE, 'saveScent', { name: 'Lumière Signature', briefId: b1.id, family: 'ชา', data: { top: 'x', applications: [{ type: 'EDP', dosage: '18' }] } }), (r) => /^SC-\d{4}-0002$/.test(r.code) && r.status === 'draft');
await err('saveScent bad brief', call(NOSE, 'saveScent', { name: 'x', briefId: 'bzzz' }), 'ไม่พบบรีฟที่เลือก');
await err('deleteBrief with scents', call(NOSE, 'deleteBrief', b1.id), 'ยังมีกลิ่น');
await ok('saveScent → production', call(NOSE, 'saveScent', { id: s1.id, name: 'Lumière Signature', briefId: b1.id, status: 'production', formulaId: 'pnew00001' }), (r) => r.status === 'production' && r.code === s1.code);
await err('deleteScent production', call(NOSE, 'deleteScent', s1.id), 'ใช้ผลิตอยู่');
await ok('scent retired then delete', call(NOSE, 'saveScent', { id: s1.id, name: 'Lumière Signature', briefId: b1.id, status: 'retired' }), (r) => r.status === 'retired');
await err('deleteScent by other user', call(COST, 'deleteScent', s1.id), 'FORBIDDEN');
await ok('deleteScent owner', call(NOSE, 'deleteScent', s1.id), (r) => r.deleted === s1.id);
await ok('deleteBrief', call(NOSE, 'deleteBrief', b1.id), (r) => r.deleted === b1.id);
await ok('listScents', call(COST, 'listScents'), (r) => r.length === 1 && r[0].id === 'sOLD');

/* ---------- Typeform ---------- */
await err('typeform status forbidden', call(NOSE, 'getTypeformStatus'), 'FORBIDDEN');
await ok('typeform status disconnected', call(OWNER, 'getTypeformStatus'), (r) => r.connected === false && r.forms.length === 3);
await err('typeform bad token format', call(OWNER, 'saveTypeformToken', 'short'), 'รูปแบบ token');
await err('typeform rejected token', call(OWNER, 'saveTypeformToken', 'tfp_WRONGTOKEN_abcdefghijklmnopqrstuvwxyz99'), 'Typeform ปฏิเสธ');
await ok('typeform still disconnected', call(OWNER, 'getTypeformStatus'), (r) => r.connected === false);
const A = (ref, type, val) => { const a = { field: { ref, type: 'x' }, type }; if (type === 'choice') a.choice = { label: val }; else if (type === 'choices') a.choices = { labels: val }; else a[type] = val; return a; };
TF.responses.hX1hmKKI = [{ token: 'tok-odm-1', submitted_at: '2026-10-20T03:00:00Z', answers: [A('language_selection', 'choice', 'English'), A('en_q01', 'text', 'Maison Verde'), A('en_q03', 'choices', ['Thailand', 'Japan / Korea']), A('en_q05', 'choices', ['Fine fragrance (perfume, roller, stick)']), A('en_q06', 'choice', '2-3'), A('en_q10', 'choices', ['Fresh / citrus', 'Not sure, please advise']), A('en_q17', 'text', 'Anna Lee'), A('en_q19', 'phone_number', '+66812345678'), A('en_q20', 'email', 'anna@maisonverde.com'), A('en_q24', 'boolean', true)] }];
TF.responses.IUMus82U = [{ token: 'tok-sv-1', submitted_at: '2026-10-21T05:00:00Z', answers: [A('language_choice', 'choice', 'ภาษาไทย'), A('q1', 'text', 'โรงแรมริมคลอง'), A('q4', 'number', 3), A('q15', 'choices', ['ซิตรัส', 'หวานละมุน']), A('q24', 'choices', ['Hotel Amenities: Shower gel, Shampoo, Body Lotion etc.']), A('contact_name', 'text', 'คุณบี')] }];
TF.responses.XE5KreIp = [{ token: 'tok-q-1', submitted_at: '2026-10-22T01:00:00Z', answers: [A('en_brand_name', 'text', 'maison verde'), A('en_q1', 'choice', 'Care for and protect customers like family'), A('en_q5', 'choice', 'A warm home where someone is waiting for you')] }, { token: 'tok-q-2', submitted_at: '2026-10-22T02:00:00Z', answers: [A('brand_name', 'text', 'Nova Fit'), A('q1', 'choice', 'พาลูกค้าไปพบประสบการณ์ใหม่')] }];
await ok('typeform connect', call(OWNER, 'saveTypeformToken', TF.token), (r) => r.connected && r.account === 'scentsense' && r.forms.every((f) => f.webhook));
eq('webhooks registered with secret', Object.values(TF.hooks).every((h) => h.url.startsWith('https://test.supabase.co/functions/v1/api?tf=') && h.secret && h.enabled), true);
eq('token stored server-side only', (await pg.query(`select count(*)::int n from costing.settings where key = 'TYPEFORM_TOKEN'`)).rows[0].n, 1);
const sync = await ok('typeform sync all', call(NOSE, 'syncTypeform', true), (r) => r.imported === 3 && r.attached === 1 && r.skipped === 0);
await ok('typeform sync again = no dupes', call(NOSE, 'syncTypeform', true), (r) => r.imported === 0 && r.attached === 0 && r.skipped === 4);
await ok('typeform briefs mapped', call(NOSE, 'listBriefs'), (r) => { const o = r.find((b) => b.brand === 'Maison Verde'), sv = r.find((b) => b.brand === 'โรงแรมริมคลอง'), q = r.find((b) => b.brand === 'Nova Fit'); return o && o.kind === 'ODM' && o.createdBy === 'typeform' && o.data.lang === 'EN' && o.data.like.join() === 'ซิตรัส / สดชื่น,ยังไม่แน่ใจ ให้ทีมแนะนำ' && o.data.markets.join() === 'ไทย,ญี่ปุ่น / เกาหลี' && o.data.arch.answers[0] === '1' && o.contact === 'Anna Lee' && sv.kind === 'SV' && sv.data.like.join() === 'ซิตรัส / สดชื่น,หวาน / กูร์มองด์' && sv.data.svProducts[0] === 'Hotel Amenities (Shower gel, Shampoo, Body Lotion)' && sv.data.branches === 3 && q.kind === 'QUIZ'; });
const hook = (secret, body) => handler(new Request('https://x/functions/v1/api?tf=' + secret, { method: 'POST', body: JSON.stringify(body) })).then((r) => r.text());
const sec = (await pg.query(`select value from costing.settings where key = 'TYPEFORM_SECRET'`)).rows[0].value;
const pay = { event_type: 'form_response', form_response: { form_id: 'hX1hmKKI', token: 'tok-odm-2', submitted_at: new Date().toISOString(), answers: [A('language_selection', 'choice', 'ภาษาไทย'), A('q01', 'text', 'Siam Bloom'), A('q10', 'choices', ['ดอกไม้']), A('q20', 'email', 'a@siam.co')] } };
eq('webhook wrong secret', await hook('nope', pay), 'forbidden');
eq('webhook good', await hook(sec, pay), 'imported');
eq('webhook duplicate', await hook(sec, pay), 'skipped');
eq('webhook unknown form', await hook(sec, { event_type: 'form_response', form_response: { form_id: 'ZZZ', token: 'q' } }), 'unknown form');
eq('webhook other event', await hook(sec, { event_type: 'ping' }), 'ignored');
await ok('status shows imported', call(OWNER, 'getTypeformStatus'), (r) => r.imported === 4 && r.lastRun.includes(NOSE));
await ok('typeform disconnect', call(OWNER, 'disconnectTypeform'), (r) => r.connected === false && Object.keys(TF.hooks).length === 0);
eq('webhook after disconnect', await hook(sec, pay), 'forbidden');

/* ---------- R&D: customers, projects, stage gates, samples, customer evaluation ---------- */
await err('listProjects forbidden', call(OUT, 'listProjects'), 'FORBIDDEN');
await err('saveProject needs projects/perfumer perm', call(COST, 'saveProject', { brand: 'X' }), 'FORBIDDEN');
const c1 = await ok('saveCustomer auto code', call(OWNER, 'saveCustomer', { company: 'บริษัท มีเมตตา จำกัด', brand: 'ONEST' }), (r) => r.code === '001' && r.brand === 'ONEST');
await ok('saveCustomer explicit code', call(OWNER, 'saveCustomer', { code: '281', company: 'บริษัท มีเมตตา จำกัด', brand: 'ONEST' }), (r) => r.code === '281');
await ok('saveCustomer next auto code after 281', call(OWNER, 'saveCustomer', { company: 'Nova', brand: 'Nova Fit' }), (r) => r.code === '282');
await err('saveCustomer empty', call(OWNER, 'saveCustomer', { code: '999' }), 'ใส่ชื่อบริษัท');
await ok('listCustomers', call(COST, 'listCustomers'), (r) => r.length === 3);
const p1 = await ok('saveProject new', call(OWNER, 'saveProject', { customerCode: '281', soNo: 'SO#251024-0001', kind: 'new', scentCount: 2, title: 'Home Retreat', owners: { pc: OWNER, perfumer: [NOSE] }, data: { products: ['Reed diffuser'] } }),
  (r) => /^PDR\d{7}$/.test(r.pdrNo) && /^FM-RD-01-\d{6}-001$/.test(r.docNo) && r.stage === 's1' && r.brand === 'ONEST' && r.actual.s1 && r.owners.perfumer[0] === NOSE);
const p2 = await ok('saveProject with inline customer', call(NOSE, 'saveProject', { customer: { company: 'Siam Bloom Co', brand: 'Siam Bloom' }, scentCount: 1 }), (r) => r.customerCode === '283' && /-002$/.test(r.docNo) && r.pdrNo > p1.pdrNo);
await err('saveProject unknown customer', call(OWNER, 'saveProject', { customerCode: '777' }), 'ไม่พบรหัสลูกค้า');
await err('setStage skip', call(OWNER, 'setStage', p1.id, 's3', '', false), 'ข้ามขั้นไม่ได้');
await ok('setStage s1→s2', call(OWNER, 'setStage', p1.id, 's2', '', false), (r) => r.stage === 's2' && r.actual.s2);
await err('setStage s2→s3 needs RA', call(OWNER, 'setStage', p1.id, 's3', '', false), 'RA ต้องตรวจกฎหมาย');
await err('bulkStage needs note', call(OWNER, 'bulkStage', [p1.id], 'lost', ''), 'ใส่เหตุผล');
await err('bulkStage bad stage', call(OWNER, 'bulkStage', [p1.id], 's3', 'x'), 'เสร็จสิ้น หรือ ยกเลิก');
await ok('bulkStage done + skip unknown', call(OWNER, 'bulkStage', [p1.id, 'nope'], 'done', 'ล้างทะเบียนเก่า'), (x) => x.updated === 1 && x.skipped === 1);
await ok('bulkStage recorded', call(OWNER, 'getProject', p1.id), (x) => x.project.stage === 'done' && x.project.actual.done && x.project.data.stageLog.slice(-1)[0].note.startsWith('[กลุ่ม]') && x.project.data.overrides.length === 1);
await ok('bulkStage already closed is skipped', call(OWNER, 'bulkStage', [p1.id], 'lost', 'x'), (x) => x.updated === 0);
await ok('reopen p1 for later tests', call(OWNER, 'setStage', p1.id, 's2', 'reopen', false), (x) => x.stage === 's2');
await err('raCheck forbidden for perfumer', call(NOSE, 'raCheck', p1.id, 'pass', ''), 'FORBIDDEN');
await ok('raCheck pass', call(OWNER, 'raCheck', p1.id, 'cond', 'หลีกเลี่ยง allergen เกิน 0.001%'), (r) => r.ra.status === 'cond' && r.ra.by === OWNER && r.actual.s2ra);
await ok('setStage s2→s3', call(NOSE, 'setStage', p1.id, 's3', '', false), (r) => r.stage === 's3');
await err('setStage s3→s4 cannot skip the scent-eval stage', call(NOSE, 'setStage', p1.id, 's4', '', false), 'ข้ามขั้นไม่ได้');
await err('setStage s3→s3e needs a sent scent sample', call(NOSE, 'setStage', p1.id, 's3e', '', false), 'ยังไม่ได้ส่งตัวอย่างกลิ่น');
await err('setStage override needs note', call(NOSE, 'setStage', p1.id, 's3e', '', true), 'ใส่เหตุผล');
await err('perfumer cannot go back', call(NOSE, 'setStage', p1.id, 's2', 'x', false), 'ย้อนขั้น');
const sc1 = await ok('saveScent in project gets PF code', call(NOSE, 'saveScent', { name: 'Home Retreat 01', projectId: p1.id, data: { top: 'bergamot' } }), (r) => r.projectId === p1.id && r.formulaCode === 'PF2810101');
const sc2 = await ok('second scent in same customer', call(NOSE, 'saveScent', { name: 'Home Retreat 02', projectId: p1.id }), (r) => r.formulaCode === 'PF2810201');
const sc3 = await ok('third direction', call(NOSE, 'saveScent', { name: 'Home Retreat 03', projectId: p1.id }), (r) => r.formulaCode === 'PF2810301');
await ok('scent keeps code on resave', call(NOSE, 'saveScent', { id: sc1.id, name: 'Home Retreat 01 v2', projectId: p1.id }), (r) => r.formulaCode === 'PF2810101');
await err('saveScent unknown project', call(NOSE, 'saveScent', { name: 'x', projectId: 'pzzz' }), 'ไม่พบโครงการ');
await err('saveSample no items', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'scent', items: [] }), 'อย่างน้อย 1 รายการ');
const sm1 = await ok('saveSample scent', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'scent', items: [{ code: 'HR-01', name: 'Home Retreat 01', scentId: sc1.id, formulaCode: sc1.formulaCode, size: '5 ml', qty: 2 }, { code: 'HR-02', name: 'Home Retreat 02', scentId: sc2.id, formulaCode: sc2.formulaCode }], requestedAt: '2026-10-24', rdBy: NOSE, saBy: 'aom' }),
  (r) => /^FM-RD-04-\d{6}-001$/.test(r.docNo) && r.status === 'draft' && r.items.length === 2 && r.items[0].qty === 2 && r.evalLink === '');
await err('first scent round needs 3 directions', call(OWNER, 'sendSample', sm1.id), '3 แนวทาง');
await ok('resave with 3 directions', call(OWNER, 'saveSample', { ...sm1, items: sm1.items.concat([{ code: 'HR-03', name: 'Home Retreat 03', scentId: sc3.id, formulaCode: sc3.formulaCode }]) }), (r) => r.id === sm1.id && r.items.length === 3 && r.docNo === sm1.docNo);
const sent = await ok('sendSample', call(OWNER, 'sendSample', sm1.id), (r) => r.status === 'sent' && /^https:\/\/rd\.scentandsense\.co\.th\/eval\/[0-9a-f]{24}$/.test(r.evalLink) && r.shippedAt);
await ok('project actual s3send set; sending moves s3 → s3e', call(COST, 'getProject', p1.id), (r) => r.project.actual.s3send && r.samples.length === 1 && r.scents.length === 3 && r.project.stage === 's3e' && r.project.actual.s3e && r.project.data.stageLog.slice(-1)[0].note.includes('อัตโนมัติ'));
await err('setStage s3e→s4 needs produce decision', call(NOSE, 'setStage', p1.id, 's4', '', false), 'ผลิตจริงต่อไป');
const tokenE = sent.evalLink.split('/eval/')[1];
const page = await handler(new Request('https://x/functions/v1/api?eval=' + tokenE)); const pageHtml = await page.text();
eq('eval page html', page.headers.get('content-type').startsWith('text/html') && pageHtml.includes('รอบที่ 1 จาก 3') && pageHtml.includes('value="revise"') && pageHtml.includes('ONEST') && pageHtml.includes('HR-02') && pageHtml.includes('ผลิตจริงต่อไป') && pageHtml.includes('name="pick"') && !pageHtml.includes('name="d0"'), true);
const nf = await (await handler(new Request('https://x/functions/v1/api?eval=nope'))).text(); eq('eval page unknown token', nf.includes('ไม่พบแบบประเมิน'), true);
const submit = (tok, body) => handler(new Request('https://x/functions/v1/api?evalSubmit=' + tok, { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json());
const scoresOf = (n) => ({ scent: n, appearance: n, skinfeel: n, target: n, brand: n, overall: n });
eq('evalSubmit bad email', (await submit(tokenE, { email: 'x', items: [] })).error, 'ใส่อีเมลผู้ประเมินให้ถูกต้อง');
eq('evalSubmit incomplete scores', (await submit(tokenE, { email: 'k@onest.co', items: [{ idx: 0, scores: scoresOf(5) }, { idx: 1, scores: { scent: 3 } }, { idx: 2, scores: scoresOf(2) }] })).error, 'ให้คะแนนให้ครบทุกด้าน');
const all3 = [{ idx: 0, scores: scoresOf(5), comment: 'ดีมาก' }, { idx: 1, scores: { scent: 3, appearance: 4, skinfeel: 3, target: 2, brand: 3, overall: 3 } }, { idx: 2, scores: scoresOf(2) }];
eq('evalSubmit scent needs one pick', (await submit(tokenE, { email: 'k@onest.co', items: all3 })).error, 'เลือก 1 กลิ่นที่จะไปต่อ และระบุว่าจะผลิตจริงหรือนำไปแก้ไข');
eq('evalSubmit pick needs action', (await submit(tokenE, { email: 'k@onest.co', items: all3, pick: { idx: 0, action: 'reject' } })).error, 'เลือก 1 กลิ่นที่จะไปต่อ และระบุว่าจะผลิตจริงหรือนำไปแก้ไข');
const ev1 = await submit(tokenE, { email: 'k@onest.co', note: 'ชอบ 01', items: all3, pick: { idx: 0, action: 'produce' } });
eq('evalSubmit ok', ev1.ok === true && /^FM-RD-05-\d{6}-001$/.test(ev1.docNo), true);
await ok('sample evaluated: picked item produce, others reject', call(COST, 'listSamples', p1.id), (r) => r[0].status === 'evaluated' && r[0].eval.produce === true && r[0].eval.items[0].decision === 'produce' && r[0].eval.items[1].decision === 'reject' && r[0].eval.items[2].decision === 'reject' && r[0].eval.pick.code === 'HR-01' && r[0].eval.pick.scentId === sc1.id && r[0].evalDocNo === ev1.docNo);
await ok('project remembers the chosen scent; scent approved', call(COST, 'getProject', p1.id), (r) => r.project.data.chosenScent.scentId === sc1.id && r.project.data.chosenScent.action === 'produce' && r.project.data.chosenScent.evalDocNo === ev1.docNo && r.scents.find((x) => x.id === sc1.id).status === 'approved' && r.scents.find((x) => x.id === sc2.id).status !== 'approved');
/* revision round after a pick: any number of scents; customer may send it back for more work */
const smR = await ok('revision round sample (1 scent)', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'scent', items: [{ code: 'HR-02R', name: 'Home Retreat 02 rev', scentId: sc2.id, formulaCode: sc2.formulaCode }] }), (r) => /-002$/.test(r.docNo));
const sentR = await ok('revision round may be sent with 1 scent', call(OWNER, 'sendSample', smR.id), (r) => r.status === 'sent');
const evR = await submit(sentR.evalLink.split('/eval/')[1], { email: 'k@onest.co', items: [{ idx: 0, scores: scoresOf(4) }], pick: { idx: 0, action: 'revise' } });
eq('revise pick accepted', evR.ok, true);
await ok('revise pick recorded, scent not approved, project back to s3', call(COST, 'getProject', p1.id), (r) => r.project.stage === 's3' && r.project.data.chosenScent.scentId === sc2.id && r.project.data.chosenScent.action === 'revise' && r.scents.find((x) => x.id === sc2.id).status !== 'approved' && r.samples.find((x) => x.id === smR.id).eval.produce === false);
await err('evaluated sample locked', call(OWNER, 'saveSample', { id: sm1.id, projectId: p1.id, kind: 'scent', items: [{ code: 'x' }] }), 'ประเมินแล้วแก้ไขไม่ได้');
/* round 3 = last round: no revise; a 4th round cannot be sent */
const sm3 = await ok('round 3 sample', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'scent', items: [{ code: 'HR-01F', name: 'Home Retreat 01 final', scentId: sc1.id, formulaCode: sc1.formulaCode }] }), (r) => r.status === 'draft');
const sent3 = await ok('round 3 sent → s3e again', call(OWNER, 'sendSample', sm3.id), (r) => r.status === 'sent');
await ok('project back in s3e', call(COST, 'getProject', p1.id), (r) => r.project.stage === 's3e');
const tok3 = sent3.evalLink.split('/eval/')[1], page3 = await (await handler(new Request('https://x/functions/v1/api?eval=' + tok3))).text();
eq('last round page has no revise option', page3.includes('รอบที่ 3 จาก 3') && page3.includes('รอบสุดท้าย') && !page3.includes('value="revise"'), true);
eq('last round rejects revise', String((await submit(tok3, { email: 'k@onest.co', items: [{ idx: 0, scores: scoresOf(4) }], pick: { idx: 0, action: 'revise' } })).error).includes('รอบสุดท้าย'), true);
eq('last round produce ok', (await submit(tok3, { email: 'k@onest.co', items: [{ idx: 0, scores: scoresOf(5) }], pick: { idx: 0, action: 'produce' } })).ok, true);
const sm4 = await ok('round 4 draft can be saved', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'scent', items: [{ code: 'HR-X' }] }), (r) => r.status === 'draft');
await err('round 4 cannot be sent', call(OWNER, 'sendSample', sm4.id), 'ครบ 3 รอบ');
await ok('delete round 4 draft', call(OWNER, 'deleteSample', sm4.id));
await ok('setStage s3e→s4 after produce', call(NOSE, 'setStage', p1.id, 's4', '', false), (r) => r.stage === 's4' && r.actual.s3eval);
await err('setStage s4→s5 needs mockup sample', call(NOSE, 'setStage', p1.id, 's5', '', false), 'ต้นแบบสินค้า');
const sm2 = await ok('saveSample mockup', call(OWNER, 'saveSample', { projectId: p1.id, kind: 'mockup', items: [{ code: 'MK-01', name: 'Reed diffuser 100 ml' }] }), (r) => /-005$/.test(r.docNo) && r.kind === 'mockup');
await ok('setStage s4→s5', call(NOSE, 'setStage', p1.id, 's5', '', false), (r) => r.stage === 's5');
await ok('setStage s5→s6 override with note', call(NOSE, 'setStage', p1.id, 's6', 'ลูกค้ายืนยันทาง LINE 24/10', true), (r) => r.stage === 's6' && r.data.overrides.slice(-1)[0].note.includes('LINE'));
await err('setStage s6→s7 needs stability', call(NOSE, 'setStage', p1.id, 's7', '', false), 'Stability');
await ok('saveProject stability standard base + newFormula', call(OWNER, 'saveProject', { id: p1.id, customerCode: '281', owners: p1.owners, data: { stability: { standard: true, base: 'BASE Hair And Body Mist' }, newFormula: true } }), (r) => r.data.stability.standard === true && r.pdrNo === p1.pdrNo && r.stage === 's6');
await ok('setStage s6→s7', call(NOSE, 'setStage', p1.id, 's7', '', false), (r) => r.stage === 's7');
await err('setStage s7→done blocked (new formula → pilot first)', call(NOSE, 'setStage', p1.id, 'done', '', false), 'Pilot Batch');
const pd1 = await ok('issueProjectDoc bom', call(NOSE, 'issueProjectDoc', p1.id, 'bom'), (r) => /^FM-RD-09-\d{6}-001$/.test(r.data.bom.docNo));
await ok('issueProjectDoc same doc keeps number', call(NOSE, 'issueProjectDoc', p1.id, 'bom'), (r) => r.data.bom.docNo === pd1.data.bom.docNo);
await err('issueProjectDoc unknown', call(NOSE, 'issueProjectDoc', p1.id, 'zzz'), 'ไม่รู้จัก');
await err('notifyRaContracts needs a contract', call(NOSE, 'notifyRaContracts', p1.id, [], ''), 'อย่างน้อย 1');
await err('notifyRaContracts unknown key ignored', call(NOSE, 'notifyRaContracts', p1.id, ['zzz'], ''), 'อย่างน้อย 1');

await ok('mark BOM released', call(OWNER, 'saveProject', { id: p1.id, customerCode: '281', owners: p1.owners, data: { ...pd1.data, bom: { ...pd1.data.bom, released: true } } }), (r) => r.data.bom.released === true);
await err('setStage s7→done new formula needs pilot', call(NOSE, 'setStage', p1.id, 'done', '', false), 'Pilot');
await ok('setStage s7→s8', call(NOSE, 'setStage', p1.id, 's8', '', false), (r) => r.stage === 's8');
await err('setStage s8→done needs pilot pass', call(NOSE, 'setStage', p1.id, 'done', '', false), 'Pilot Batch');
const pd2 = await ok('pilot pass', call(OWNER, 'getProject', p1.id), (r) => r.project.stage === 's8');
await ok('save pilot result', call(OWNER, 'saveProject', { id: p1.id, customerCode: '281', owners: p1.owners, data: { ...pd2.project.data, pilot: { result: 'pass', batchNo: 'PB-001' } } }));
await ok('setStage s8→done', call(NOSE, 'setStage', p1.id, 'done', '', false), (r) => r.stage === 'done' && r.data.stageLog.length >= 8);
await err('lost needs note', call(OWNER, 'setStage', p2.id, 'lost', '', false), 'เหตุผล');
await ok('lost with note', call(OWNER, 'setStage', p2.id, 'lost', 'ลูกค้าไม่ตอบ', false), (r) => r.stage === 'lost');
await ok('listProjects counts', call(COST, 'listProjects'), (r) => r.items.length === 2 && r.sla.s3 === 15 && r.items.find((p) => p.id === p1.id).scents === 3 && r.items.find((p) => p.id === p1.id).samples === 4 && r.items.find((p) => p.id === p1.id).evaluated === 3);
const ym = new Date().toISOString().slice(0, 7);
await ok('evalSummary month', call(COST, 'evalSummary', ym, 'scent'), (r) => r.count === 5 && r.rows[0].total === 30 && r.rows[0].pct === 100 && r.rows[1].total === 18 && r.rows[1].pct === 60 && r.rows[1].decision === 'reject' && r.rows[3].total === 24 && r.rows[3].decision === 'revise' && r.avgPct === 76 && r.rows[0].company.includes('มีเมตตา'));
await ok('evalSummary year', call(COST, 'evalSummary', ym.slice(0, 4), 'scent'), (r) => r.count === 5);
await ok('evalSummary mockup empty', call(COST, 'evalSummary', ym, 'mockup'), (r) => r.count === 0);
await err('evalSummary bad period', call(COST, 'evalSummary', '2026/10', 'scent'), 'ช่วงเวลา');
await err('deleteSample evaluated by perfumer', call(NOSE, 'deleteSample', sm1.id), 'ผู้ดูแลระบบ');
await ok('deleteSample draft', call(NOSE, 'deleteSample', sm2.id), (r) => r.deleted === sm2.id);
await err('importRd non-owner', call(ADMIN, 'importRd', {}), 'FORBIDDEN');
await ok('importRd', call(OWNER, 'importRd', { customers: [{ code: '108', company: 'Scent Studio', brand: 'Scent Studio' }], projects: [{ id: 'pIMP1', pdrNo: 'PDR2310001', docNo: 'FM-RD-01-091066-001', customerCode: '108', company: 'Scent Studio', brand: 'Scent Studio', stage: 'done', createdAt: '2023-10-09', actual: { s1: '2023-10-12T00:00:00Z' } }],
  samples: [{ id: 'xIMP1', projectId: 'pIMP1', docNo: 'FM-RD-04-221166-001', kind: 'scent', items: [{ code: 'Matcha 101' }], status: 'evaluated', evalDocNo: 'FM-RD-05-281166-001', eval: { submittedAt: '2023-11-28T00:00:00Z', items: [{ code: 'Matcha 101', scores: scoresOf(4), decision: 'produce' }], produce: true } }, { id: 'xBAD', projectId: 'pNONE', items: [{ code: 'x' }] }],
  scents: [{ id: sc1.id, projectId: 'pIMP1', formulaCode: 'PF1080101' }, { id: 'imp-PF1080102', code: 'SC-IMP-0001', name: 'Matcha 102', projectId: 'pIMP1', formulaCode: 'PF1080102', status: 'trial', createdAt: '2023-10-12', data: { import: { perfumer: 'เจ' } } }, { id: 'imp-PFnoname', projectId: 'pIMP1', formulaCode: 'PF1080103' }, { id: 'imp-PFbadproj', name: 'x', projectId: 'pNONE' }],
  docseq: [{ prefix: 'FM-RD-01', period: '202310', n: 5 }] }), (r) => r.customers === 1 && r.projects === 1 && r.samples === 1 && r.scents === 2);
await ok('imported scent visible', call(NOSE, 'listScents'), (r) => { const s = r.find((x) => x.id === 'imp-PF1080102'); return s && s.code === 'SC-IMP-0001' && s.projectId === 'pIMP1' && s.formulaCode === 'PF1080102' && s.owner === 'import' && s.data.import.perfumer === 'เจ'; });
await ok('imported eval without scores is skipped in summary', call(OWNER, 'importRd', { samples: [{ id: 'xIMP2', projectId: 'pIMP1', kind: 'scent', items: [{ code: 'A' }], status: 'evaluated', evalDocNo: 'FM-RD-05-011166-002', eval: { submittedAt: '2023-11-01T00:00:00Z', noScores: true, produce: true, items: [{ code: 'A', scores: {}, decision: 'produce' }] } }] }), (r) => r.samples === 1);
await ok('importRd idempotent', call(OWNER, 'importRd', { projects: [{ id: 'pIMP1', pdrNo: 'PDR2310001', docNo: 'FM-RD-01-091066-001', customerCode: '108', company: 'Scent Studio', stage: 'done' }] }), (r) => r.projects === 1);
await ok('imported eval in 2023 summary', call(COST, 'evalSummary', '2023-11', 'scent'), (r) => r.count === 1 && r.rows[0].pct === 80);
eq('docseq raised', (await pg.query(`select n from costing.docseq where prefix = 'FM-RD-01' and period = '202310'`)).rows[0].n, 5);

/* ---------- Product Development: base formulas + product formulas ---------- */
await err('listPdBases forbidden', call(OUT, 'listPdBases'), 'FORBIDDEN');
await err('savePdBase needs pd perm', call(NOSE, 'savePdBase', { category: 'Lotion', name: 'X', lines: [{ name: 'Water', pct: 100 }] }), 'FORBIDDEN');
await err('savePdBase needs lines', call(OWNER, 'savePdBase', { category: 'Lotion', name: 'X', lines: [] }), 'อย่างน้อย 1');
const pb1 = await ok('savePdBase new', call(OWNER, 'savePdBase', { category: 'Lotion', name: 'Lotion (Standard)', targetPrice: 65, shelfLife: '2 ปี',
  lines: [{ code: 'RM-025-011-0608', name: 'RO WATER', pct: 90.15, price: 0 }, { code: 'RM-001-004-0028', name: 'GLYCERINE PTT', pct: 3, price: 63 }, { name: 'Fragrance', pct: 1.5, price: 3000, frag: true }, { code: 'RM-035-005-0833', name: 'Repoly 315', pct: 5.35, price: 414 }] }),
  (r) => /^base-/.test(r.id) && r.lines.length === 4 && r.lines[2].frag === true && r.targetPrice === 65 && r.active === true && r.shelfLife === '2 ปี');
await ok('savePdBase update keeps id', call(OWNER, 'savePdBase', { ...pb1, name: 'Lotion (Std)' }), (r) => r.id === pb1.id && r.name === 'Lotion (Std)' && r.lines.length === 4);
await ok('listPdBases visible to RD viewers', call(COST, 'listPdBases'), (r) => r.length === 1 && r[0].name === 'Lotion (Std)');
await err('listPdFormulas forbidden', call(OUT, 'listPdFormulas'), 'FORBIDDEN');
await err('savePdFormula needs pd perm', call(NOSE, 'savePdFormula', { name: 'X', lines: [{ name: 'a', pct: 1 }] }), 'FORBIDDEN');
await err('savePdFormula unknown project', call(OWNER, 'savePdFormula', { name: 'X', projectId: 'nope', lines: [{ name: 'a', pct: 1 }] }), 'ไม่พบโครงการ');
await err('savePdFormula unknown base', call(OWNER, 'savePdFormula', { name: 'X', baseId: 'nope', lines: [{ name: 'a', pct: 1 }] }), 'ไม่พบเบส');
const pdf1 = await ok('savePdFormula new', call(OWNER, 'savePdFormula', { name: 'Siam Bloom Lotion', projectId: p1.id, baseId: pb1.id, baseName: pb1.name, category: 'Lotion', mode: 'standard', fragranceFormulaId: 'f1', fragranceName: 'Home Retreat', fragrancePrice: 2800, batchG: 1000, targetPrice: 65, lines: pb1.lines }),
  (r) => /^PD\d{4}001$/.test(r.code) && r.status === 'draft' && r.projectId === p1.id && r.baseId === pb1.id && r.lines.length === 4 && r.fragrancePrice === 2800 && r.approvedBy === '');
const pdf2 = await ok('savePdFormula second gets next code', call(OWNER, 'savePdFormula', { name: 'Second', mode: 'modified', lines: [{ name: 'a', pct: 100 }] }), (r) => /002$/.test(r.code) && r.mode === 'modified' && r.projectId === '');
await err('savePdFormula unknown scent', call(OWNER, 'savePdFormula', { name: 'X', fragranceScentId: 'nope', lines: [{ name: 'a', pct: 1 }] }), 'ไม่พบกลิ่น');
const sc0 = await ok('scent for PD link', call(OWNER, 'saveScent', { name: 'PD Link Scent', projectId: p1.id, data: { costKg: 2750 } }), (r) => r.projectId === p1.id && r.data.costKg === 2750);
await ok('savePdFormula links scent', call(OWNER, 'savePdFormula', { ...pdf1, fragranceScentId: sc0.id, fragranceName: sc0.name, fragranceCode: sc0.formulaCode }), (r) => r.fragranceScentId === sc0.id && r.fragranceCode === sc0.formulaCode && r.code === pdf1.code);
await ok('approve records approver', call(OWNER, 'savePdFormula', { ...pdf1, status: 'approved' }), (r) => r.status === 'approved' && r.approvedBy === OWNER && !!r.approvedAt && r.code === pdf1.code);
await ok('back to testing clears approver', call(OWNER, 'savePdFormula', { ...pdf1, status: 'testing' }), (r) => r.status === 'testing' && r.approvedBy === '');
await ok('listPdFormulas by project', call(COST, 'listPdFormulas', p1.id), (r) => r.length === 1 && r[0].id === pdf1.id);
await ok('listPdFormulas all', call(COST, 'listPdFormulas'), (r) => r.length === 2);
await err('deletePdBase in use', call(OWNER, 'deletePdBase', pb1.id), 'อ้างอิงเบสนี้');
await ok('deletePdFormula', call(OWNER, 'deletePdFormula', pdf2.id));
await err('deletePdFormula missing', call(OWNER, 'deletePdFormula', pdf2.id), 'ไม่พบสูตร');
await err('importPdBases non-owner', call(ADMIN, 'importPdBases', { bases: [] }), 'FORBIDDEN');
await ok('importPdBases upsert', call(OWNER, 'importPdBases', { bases: [{ id: pb1.id, category: 'Lotion', name: 'Lotion', lines: pb1.lines }, { id: 'base-x', category: 'Candle', name: 'Candle', targetPrice: 400, lines: [{ code: 'RM-011-011-0552', name: 'Pho soy 49', pct: 92, price: 150 }, { name: 'Fragrance', pct: 8, price: 2000, frag: true }] }] }), (r) => r.bases === 2);
await ok('listPdBases after import', call(OWNER, 'listPdBases'), (r) => r.length === 2 && r.find((b) => b.id === pb1.id).name === 'Lotion' && r.find((b) => b.id === 'base-x').targetPrice === 400);
await ok('deletePdBase unused', call(OWNER, 'deletePdBase', 'base-x'));

/* ---------- least-privilege: rdView / PD / cost masking ---------- */
const PCU = 'pc@scentandsense.co.th', PDU = 'pd@scentandsense.co.th';
await pg.query('insert into costing.roles (id, name, perms, system, ord) values ($1, $2, $3, false, 20), ($4, $5, $6, false, 21)', ['pc', 'PC', JSON.stringify({ projects: true, rdView: true }), 'pdonly', 'PD', JSON.stringify({ pd: true })]);
await pg.query('insert into costing.users (email, role, active, added_by, added_at) values ($1, $2, true, $3, now()), ($4, $5, true, $3, now())', [PCU, 'pc', OWNER, PDU, 'pdonly']);
await ok('rdView perm accepted by role editor', call(OWNER, 'updateRole', 'pc', { perms: { projects: true, rdView: true } }), (r) => (r.roles || r).pc ? true : true);
await ok('PC sees briefs (PF_VIEW widened)', call(PCU, 'listBriefs'), (r) => r.length >= 1);
await ok('PC sees scents without cost', call(PCU, 'listScents'), (r) => { const s = r.find((x) => x.id === sc0.id); return s && s.data.costKg === undefined; });
await ok('calc user still sees scent cost', call(COST, 'listScents'), (r) => r.find((x) => x.id === sc0.id).data.costKg === 2750);
await ok('PC sees PD bases without RM prices', call(PCU, 'listPdBases'), (r) => r.length === 1 && r[0].lines.every((l) => l.price === null && l.override === null));
await ok('PC sees PD formulas without prices', call(PCU, 'listPdFormulas', p1.id), (r) => r.length === 1 && r[0].fragrancePrice === null && r[0].lines.every((l) => l.price === null));
await ok('calc user sees PD prices', call(COST, 'listPdBases'), (r) => r[0].lines.some((l) => l.price > 0));
await ok('PC sees version numbers but not the recipe', call(PCU, 'listFormulaHistory', 'pnew00001'), (r) => r.versions.length === 1 && r.versions[0].lines.length === 0 && r.versions[0].total === null && r.versions[0].recipeHidden === true && r.feedback.length >= 1);
await ok('perfumer sees the recipe', call(NOSE, 'listFormulaHistory', 'pnew00001'), (r) => r.versions[0].lines.length === 1 && !r.versions[0].recipeHidden);
await err('PC cannot read RM price list', call(PCU, 'loadMyFormulas'), 'FORBIDDEN');
await ok('PC bootstrap has no prices', call(PCU, 'bootstrap'), (r) => r.prices === null && r.me.perms.rdView === true);
await err('rdView-only cannot edit projects', call(PCU, 'raCheck', p1.id, 'pass', ''), 'FORBIDDEN');
await err('notifyRaContracts without RA users', call(PCU, 'notifyRaContracts', p1.id, ['design'], ''), 'สิทธิ์ RA');
await pg.query('insert into costing.roles (id, name, perms, system, ord) values ($1, $2, $3, false, 22)', ['raonly', 'RA', JSON.stringify({ ra: true, rdView: true })]);
await pg.query('insert into costing.users (email, role, active, added_by, added_at) values ($1, $2, true, $3, now())', ['rareg@scentandsense.co.th', 'raonly', OWNER]);
await ok('notifyRaContracts by sales (PC) records notice', call(PCU, 'notifyRaContracts', p1.id, ['design', 'mfg', 'design'], 'ตรวจแล้ว'), (r) => { const n = r.data.contractNotices.slice(-1)[0]; return n.keys.join() === 'design,mfg' && n.by === PCU && n.to.join() === 'rareg@scentandsense.co.th' && n.note === 'ตรวจแล้ว'; });
await ok('saveProject keeps contractNotices', call(OWNER, 'saveProject', { id: p1.id, customerCode: '281', owners: p1.owners, data: { contractNotices: [] } }), (r) => r.data.contractNotices.length === 1);
await pg.query('delete from costing.users where email = $1', ['rareg@scentandsense.co.th']); await pg.query('delete from costing.roles where id = $1', ['raonly']);
await err('PD cannot open a new project', call(PDU, 'saveProject', { customerCode: '281', title: 'x' }), 'FORBIDDEN');
const pdSaved = await ok('PD can update an existing project (stability/pilot) and untouched fields stay', call(PDU, 'saveProject', { id: p1.id, data: { ...(await call(OWNER, 'getProject', p1.id)).result.project.data, stability: { standard: true, base: 'Lotion' } } }), (r) => r.data.stability.base === 'Lotion' && r.customerCode === '281' && r.owners.perfumer[0] === NOSE && r.soNo === 'SO#251024-0001' && r.kind === 'new' && r.scentCount === 2);
await ok('saveProject without title keeps the title', call(OWNER, 'saveProject', { id: p2.id, title: 'Keep Me' }), (r) => r.title === 'Keep Me');
await ok('saveProject partial update keeps title', call(OWNER, 'saveProject', { id: p2.id, data: { note: 'x' } }), (r) => r.title === 'Keep Me' && r.customerCode === '283');
await ok('rdView sees dashboard + projects', call(PCU, 'listProjects'), (r) => r.items.length >= 2);
await ok('rdView sees botanicals without prices', call(PCU, 'listBotanicals'), (r) => r.canPrice === false && r.canEdit === false);
await err('rdView cannot see stock costs via prices', call(PCU, 'getBotanicalPrices'), 'FORBIDDEN');

/* ---------- Research Ingredients: botanicals register ---------- */
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-data'.repeat(20))]);
await err('listBotanicals forbidden', call(OUT, 'listBotanicals'), 'FORBIDDEN');
await err('importBotanicals non-owner', call(ADMIN, 'importBotanicals', { records: [] }), 'FORBIDDEN');
await err('importBotanicalImage non-owner', call(ADMIN, 'importBotanicalImage', 'a.jpg', jpg.toString('base64')), 'FORBIDDEN');
await err('importBotanicalImage rejects non-image', call(OWNER, 'importBotanicalImage', 'a.jpg', Buffer.from('not an image').toString('base64')), 'รูปไม่ถูกต้อง');
await ok('importBotanicalImage', call(OWNER, 'importBotanicalImage', 'abc123.jpg', jpg.toString('base64')), (r) => r.name === 'abc123.jpg');
await ok('importBotanicals', call(OWNER, 'importBotanicals', { records: [
  { regNo: 'BT-0028', imagePath: 'abc123.jpg', data: { nameTh: 'ลาเวนเดอร์', nameEn: 'Lavender', latin: 'Lavandula angustifolia', form: 'Essential oil', odorFamilies: ['floral', 'herbal'], image: '/_blob/x', imageId: 'x', ifraItems: [{ name: 'Linalool', c9: null }], stockLots: [{ name: 'LAVENDER OIL UK', qty: 9708.2 }] }, price: { oilThb: '30,000–50,000', stockCost: 4200 } },
  { regNo: 'BT-0259', data: { nameTh: 'จิงจูฉ่าย', nameEn: 'White Mugwort', form: 'Essential oil', rdType: 'extract' } },
  { regNo: 'bad', data: { nameTh: 'x' } }] }), (r) => r.records === 2 && r.prices === 1);
await ok('importBotanicals idempotent', call(OWNER, 'importBotanicals', { records: [{ regNo: 'BT-0259', data: { nameTh: 'จิงจูฉ่าย', nameEn: 'White Mugwort', form: 'Essential oil', rdType: 'extract' } }] }), (r) => r.records === 1);
const bl = await ok('listBotanicals', call(COST, 'listBotanicals'), (r) => r.items.length === 2 && r.canEdit === false && r.canPrice === false);
eq('list strips system keys + signs image', [bl.items[0].regNo, bl.items[0].image, bl.items[0].imageId, /signed\.test\/plant-images\/abc123\.jpg/.test(bl.items[0].imageUrl), bl.items[0].hasImage, bl.items[0].ifraItems.length, bl.items[1].hasImage], ['BT-0028', undefined, undefined, true, true, 1, false]);
await err('getBotanicalPlate forbidden', call(OUT, 'getBotanicalPlate', 'BT-0028'), 'FORBIDDEN');
await ok('getBotanicalPlate empty without a plate', call(COST, 'getBotanicalPlate', 'BT-0028'), (r) => r.url === '');
await ok('platePath cannot be set by clients', call(ADMIN, 'saveBotanical', { regNo: 'BT-0028', nameTh: 'ลาเวนเดอร์', platePath: 'evil.webp' }), (r) => r.platePath === undefined);
await err('saveBotanical needs research perm', call(COST, 'saveBotanical', { nameTh: 'x' }), 'FORBIDDEN');
await err('saveBotanical needs a name', call(ADMIN, 'saveBotanical', { form: 'Dried herb' }), 'ใส่ชื่อพืช');
const nb = await ok('saveBotanical new gets next regNo', call(ADMIN, 'saveBotanical', { nameTh: 'ตะไคร้', nameEn: 'Lemongrass', form: 'Fresh plant', regNo: '', image: 'hack', odorFamilies: ['citrus'] }), (r) => r.regNo === 'BT-0260' && r.source === 'ลงทะเบียนในระบบ' && r.image === undefined && r.hasImage === false);
await ok('saveBotanical merge keeps untouched fields', call(ADMIN, 'saveBotanical', { regNo: 'BT-0028', note: 'Middle', nameTh: 'ลาเวนเดอร์' }), (r) => r.note === 'Middle' && r.latin === 'Lavandula angustifolia' && r.stockLots.length === 1 && r.ifraItems.length === 1);
await err('saveBotanical unknown regNo', call(ADMIN, 'saveBotanical', { regNo: 'BT-9999', nameTh: 'x' }), 'ไม่พบรายการ');
await err('prices forbidden without editPrices', call(COST, 'getBotanicalPrices'), 'FORBIDDEN');
await ok('prices readable by editors', call(ADMIN, 'getBotanicalPrices'), (r) => r['BT-0028'].stockCost === 4200 && r['BT-0028'].oilThb === '30,000–50,000');
await err('saveBotanicalPrice forbidden', call(COST, 'saveBotanicalPrice', 'BT-0028', { oilThb: '1' }), 'FORBIDDEN');
await ok('saveBotanicalPrice', call(ADMIN, 'saveBotanicalPrice', 'BT-0028', { oilThb: '31,000', priceAsOf: '2026-10' }), (r) => r.oilThb === '31,000');
await ok('price saved', call(ADMIN, 'getBotanicalPrices'), (r) => r['BT-0028'].oilThb === '31,000' && r['BT-0028'].stockCost === undefined);
await err('upload image forbidden', call(COST, 'uploadBotanicalImage', 'BT-0260', jpg.toString('base64')), 'FORBIDDEN');
await err('upload image rejects non-image', call(ADMIN, 'uploadBotanicalImage', 'BT-0260', Buffer.from('hello world text').toString('base64')), 'รองรับเฉพาะรูป');
await ok('upload image', call(ADMIN, 'uploadBotanicalImage', 'BT-0260', jpg.toString('base64')), (r) => /signed\.test\/plant-images\/BT-0260-/.test(r.imageUrl));
await ok('image now listed', call(ADMIN, 'listBotanicals'), (r) => r.items.find((x) => x.regNo === 'BT-0260').hasImage === true && r.canEdit === true && r.canPrice === true);
await err('extraction forbidden', call(COST, 'saveBotanicalExtraction', 'BT-0028', { method: 'sd' }), 'FORBIDDEN');
const ex1 = await ok('saveBotanicalExtraction computes yield', call(NOSE === ADMIN ? OWNER : ADMIN, 'saveBotanicalExtraction', 'BT-0028', { date: '2026-10-22', method: 'sd', inputG: 500, outputG: 4.5, result: 'ok', material: 'ช่อดอก' }), (r) => r.yieldPct === 0.9 && r.regNo === 'BT-0028' && r.method === 'sd');
await ok('extraction updates record', call(COST, 'listBotanicals'), (r) => { const b = r.items.find((x) => x.regNo === 'BT-0028'); return b.extCount === 1 && b.lastExtraction === '2026-10-22' && b.bestYield === 0.9 && Array.isArray(b.rdType) && b.rdType.includes('extract'); });
const ex2 = await ok('second extraction raises bestYield', call(ADMIN, 'saveBotanicalExtraction', 'BT-0028', { date: '2026-10-20', method: 'hd', inputG: 100, outputG: 1.2 }), (r) => r.yieldPct === 1.2);
await ok('bestYield + lastExtraction use all runs', call(COST, 'listBotanicals'), (r) => { const b = r.items.find((x) => x.regNo === 'BT-0028'); return b.extCount === 2 && b.lastExtraction === '2026-10-22' && b.bestYield === 1.2; });
await ok('delete best run lowers bestYield', call(ADMIN, 'deleteBotanicalExtraction', ex2.id));
await ok('bestYield back to first run', call(COST, 'listBotanicals'), (r) => { const b = r.items.find((x) => x.regNo === 'BT-0028'); return b.extCount === 1 && b.bestYield === 0.9; });
await ok('listBotanicalExtractions', call(COST, 'listBotanicalExtractions', 'BT-0028'), (r) => r.length === 1 && r[0].id === ex1.id);
await err('extraction delete forbidden for other user', call(COST, 'deleteBotanicalExtraction', ex1.id), 'FORBIDDEN');
await ok('extraction delete by author', call(ADMIN, 'deleteBotanicalExtraction', ex1.id));
await ok('extraction count reset', call(COST, 'listBotanicals'), (r) => r.items.find((x) => x.regNo === 'BT-0028').extCount === 0);
await err('deleteBotanical needs manageUsers', call(COST, 'deleteBotanical', 'BT-0260'), 'FORBIDDEN');
await ok('deleteBotanical removes record, price and image', call(OWNER, 'deleteBotanical', 'BT-0260'));
await ok('after delete', call(OWNER, 'listBotanicals'), (r) => r.items.length === 2 && !r.items.some((x) => x.regNo === 'BT-0260'));

/* ---------- R&D stock: raw materials and packaging ---------- */
await err('listRdStock forbidden', call(OUT, 'listRdStock'), 'FORBIDDEN');
await err('saveRdStockItem view-only role', call(COST, 'saveRdStockItem', { code: 'RM-1', name: 'x', kind: 'rm' }), 'FORBIDDEN');
await err('saveRdStockItem needs code+name', call(NOSE, 'saveRdStockItem', { code: '', name: 'x', kind: 'rm' }), 'ใส่รหัสและชื่อ');
await err('saveRdStockItem needs kind', call(NOSE, 'saveRdStockItem', { code: 'A1', name: 'x', kind: 'zz' }), 'เลือกประเภท');
await err('saveRdStockItem negative', call(NOSE, 'saveRdStockItem', { code: 'A1', name: 'x', kind: 'rm', minQty: -1 }), 'ติดลบ');
const sk1 = await ok('saveRdStockItem new with opening qty', call(NOSE, 'saveRdStockItem', { code: 'RM-008-012-0536', name: 'Lavender oil', kind: 'rm', unit: 'g', supplier: 'UK', location: 'ตู้ A1', minQty: 100, unitCost: 4.2, openingQty: 500 }),
  (r) => /^stk-/.test(r.id) && r.balance === 500 && r.minQty === 100 && r.unitCost === null && r.location === 'ตู้ A1');
const sk2 = await ok('admin sees unit cost', call(ADMIN, 'saveRdStockItem', { code: 'PM-BOT-30', name: 'ขวดสเปรย์ 30 ml', kind: 'pm', unit: 'ชิ้น', unitCost: 12.5, openingQty: 40 }), (r) => r.unitCost === 12.5 && r.balance === 40);
await err('duplicate code (case-insensitive)', call(NOSE, 'saveRdStockItem', { code: 'rm-008-012-0536', name: 'dup', kind: 'rm' }), 'มีอยู่แล้ว');
await ok('edit item keeps unit cost without price permission', call(NOSE, 'saveRdStockItem', { id: sk2.id, code: 'PM-BOT-30', name: 'ขวดสเปรย์ 30 ml (แก้)', kind: 'pm', unit: 'ชิ้น', unitCost: 999 }), (r) => r.name.includes('(แก้)') && r.unitCost === null && r.balance === 40);
await ok('cost not overwritten', call(ADMIN, 'listRdStock'), (r) => r.items.find((x) => x.id === sk2.id).unitCost === 12.5 && r.canPrice === true && r.canEdit === true);
await ok('view-only role lists without cost', call(COST, 'listRdStock'), (r) => r.items.length === 2 && r.canEdit === false && r.canPrice === false && r.items.every((x) => x.unitCost === null));
await err('out needs reference', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'out', qty: 10 }), 'ระบุเลขโครงการ');
await err('out more than balance', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'out', qty: 501, ref: 'PDR1' }), 'คงเหลือไม่พอ');
await err('zero qty', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'in', qty: 0 }), 'มากกว่า 0');
await err('tx forbidden for view-only', call(COST, 'addRdStockTx', sk1.id, { kind: 'in', qty: 5 }), 'FORBIDDEN');
await ok('receive', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'in', qty: 250, ref: 'PO-1', lot: 'L1', expiry: '2028-01-01' }), (r) => r.balance === 750);
await ok('issue to a formula', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'out', qty: 120.5, ref: 'PD2610001' }), (r) => r.balance === 629.5);
await err('adjust to same count', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'adjust', countTo: 629.5 }), 'ไม่ต้องปรับ');
await ok('adjust to counted', call(NOSE, 'addRdStockTx', sk1.id, { kind: 'adjust', countTo: 600, note: 'นับสิ้นเดือน' }), (r) => r.balance === 600);
await ok('tx history', call(COST, 'listRdStockTx', sk1.id), (r) => r.length === 4 && r[0].kind === 'adjust' && r[0].qty === -29.5 && r.some((x) => x.kind === 'out' && x.qty === -120.5 && x.ref === 'PD2610001') && r.some((x) => x.lot === 'L1' && x.expiry === '2028-01-01'));
await ok('tx history all items', call(COST, 'listRdStockTx'), (r) => r.length === 5 && r.every((x) => x.code && x.name));
await err('cannot delete item with history', call(OWNER, 'deleteRdStockItem', sk1.id), 'ปิดใช้งานแทน');
await err('delete needs admin', call(NOSE, 'deleteRdStockItem', sk1.id), 'FORBIDDEN');
await ok('deactivate item', call(NOSE, 'saveRdStockItem', { id: sk1.id, code: 'RM-008-012-0536', name: 'Lavender oil', kind: 'rm', unit: 'g', active: false }), (r) => r.active === false && r.balance === 600);
await ok('importRdStock creates, updates and adjusts', call(NOSE, 'importRdStock', [
  { code: 'RM-NEW-1', name: 'Citral', kind: 'rm', unit: 'g', qty: 250, minQty: 50, supplier: 'X' },
  { code: 'PM-BOT-30', name: 'ขวดสเปรย์ 30 ml', kind: 'pm', unit: 'ชิ้น', qty: 55 },
  { code: 'bad row', name: '', kind: 'rm' }, { code: 'NEG', name: 'neg', kind: 'rm', qty: -4 }]), (r) => r.created === 1 && r.updated === 1 && r.adjusted === 1 && r.skipped === 2 && r.errors.length === 2);
await ok('import results', call(COST, 'listRdStock'), (r) => r.items.find((x) => x.code === 'RM-NEW-1').balance === 250 && r.items.find((x) => x.code === 'PM-BOT-30').balance === 55);
await err('import empty', call(NOSE, 'importRdStock', []), 'ไม่พบแถวข้อมูล');
await ok('delete untouched item', call(ADMIN, 'saveRdStockItem', { code: 'TMP', name: 'tmp', kind: 'pm' }), (r) => r.balance === 0).then((r) => ok('delete empty item', call(OWNER, 'deleteRdStockItem', r.id)));

/* ---------- RA: จดแจ้ง อย. ---------- */
await err('listFda forbidden', call(OUT, 'listFda'), 'FORBIDDEN');
await ok('listFda empty for viewer', call(COST, 'listFda'), (r) => r.regs.length === 0 && r.requests.length === 0 && r.canEdit === false && r.reqStatus.includes('เรียบร้อย'));
await err('saveFdaReg needs ra', call(COST, 'saveFdaReg', { regNo: '10-1-6600023413', notifyDate: '06/07/2566', productName: 'x' }), 'FORBIDDEN');
await err('bad reg no', call(OWNER, 'saveFdaReg', { regNo: '10-1-66', notifyDate: '06/07/2566', productName: 'x' }), 'รูปแบบ');
await err('bad date', call(OWNER, 'saveFdaReg', { regNo: '10-1-6600023413', notifyDate: '31/02/2566', productName: 'x' }), 'วันที่ไม่ถูกต้อง');
const fq1 = await ok('saveFdaRequest', call(OWNER, 'saveFdaRequest', { status: 'รออ.ย. ตรวจสอบ', sa: 'เบส', group: 'MASSAGE OIL', nameEn: 'PARADISE OIL', nameTh: 'พาราไดซ์ ออยล์', dueDate: '3/11/2026', files: [{ label: 'ใบรับ', name: 'a.pdf', url: 'https://drive.google.com/x' }, { name: 'bad', url: 'javascript:alert(1)' }] }),
  (r) => r.seq === 1 && r.status === 'รออ.ย. ตรวจสอบ' && r.dueDate === '2026-11-03' && r.files.length === 1 && r.regId === '');
await err('request needs a name', call(OWNER, 'saveFdaRequest', { group: 'X' }), 'ชื่อเครื่องสำอาง');
const fr1 = await ok('saveFdaReg converts BE dates, default expiry = +3y-1d, links request', call(OWNER, 'saveFdaReg', { regNo: '10-1-6600023413', notifyDate: '06/07/2566', tradeName: 'LE RISE', productName: 'LE MEILLEUR EDP', requestId: fq1.id }),
  (r) => r.notifyDate === '2023-07-06' && r.expiry === '2026-07-05' && r.requestId === fq1.id && r.decision === '');
await err('duplicate reg no', call(OWNER, 'saveFdaReg', { regNo: '10-1-6600023413', notifyDate: '2023-07-06', productName: 'dup' }), 'มีอยู่แล้ว');
await ok('request now linked', call(COST, 'listFda'), (r) => r.requests[0].regId === fr1.id && r.regs.length === 1);
await err('renew needs date', call(OWNER, 'renewFdaReg', fr1.id, {}), 'วันที่ต่ออายุ');
await ok('renew moves expiry +3y and keeps history', call(OWNER, 'renewFdaReg', fr1.id, { renewedAt: '2026-06-20', note: 'ต่ออายุรอบ 1' }), (r) => r.expiry === '2029-07-05' && r.decision === 'renew' && r.history.length === 1 && r.history[0].oldExpiry === '2026-07-05');
await err('renew with earlier expiry', call(OWNER, 'renewFdaReg', fr1.id, { renewedAt: '2026-06-21', newExpiry: '2027-01-01' }), 'หลังวันหมดอายุเดิม');
await ok('edit keeps history', call(OWNER, 'saveFdaReg', { ...fr1, expiry: '2029-07-05', decision: 'no', saNotifiedAt: '03/08/2026' }), (r) => r.history.length === 1 && r.decision === 'no' && r.saNotifiedAt === '2026-08-03');
await err('delete reg needs admin', call(COST, 'deleteFdaReg', fr1.id), 'FORBIDDEN');
await ok('delete reg unlinks request', call(OWNER, 'deleteFdaReg', fr1.id).then(() => call(COST, 'listFda')), (r) => r.regs.length === 0 && r.requests[0].regId === '');
await ok('delete request', call(OWNER, 'deleteFdaRequest', fq1.id).then(() => call(COST, 'listFda')), (r) => r.requests.length === 0);
/* Dashboard ผู้บริหาร */
await err('dashboard forbidden', call(OUT, 'dashboard'), 'FORBIDDEN');
await ok('dashboard aggregates', call(COST, 'dashboard', 6), (r) => r.months.length === 6 && r.projects && typeof r.projects.active === 'number' && r.projects.openedM.length === 6 && r.perfumer && r.perfumer.samples && Array.isArray(r.perfumer.samples.sentM) && r.pd && r.ra && typeof r.ra.fdaTotal === 'number' && r.ra.inci && r.research && r.people && Array.isArray(r.people.roles));
await ok('dashboard clamps months', call(OWNER, 'dashboard', 999), (r) => r.months.length === 36);
/* INCI breakdown */
await err('listInci forbidden', call(OUT, 'listInci'), 'FORBIDDEN');
await err('saveInci needs ra', call(COST, 'saveInci', { code: 'RM-001-004-0028', comps: [{ inci: 'GLYCERIN', pct: 100 }] }), 'FORBIDDEN');
await err('saveInci bad code', call(OWNER, 'saveInci', { code: 'X1', comps: [] }), 'รหัสวัตถุดิบไม่ถูกต้อง');
await err('saveInci bad pct', call(OWNER, 'saveInci', { code: 'RM-001-004-0028', comps: [{ inci: 'GLYCERIN', pct: 120 }] }), '0-100');
await ok('saveInci', call(OWNER, 'saveInci', { code: 'rm-001-004-0028', name: 'GLYCERINE', comps: [{ inci: 'GLYCERIN', cas: '56-81-5', pct: '100' }, { inci: '' }] }), (r) => r.code === 'RM-001-004-0028' && r.comps.length === 1 && r.comps[0].pct === 100 && r.status === '');
const ii = await ok('importInci keeps existing comps, adds pending + refs', call(OWNER, 'importInci', [
  { code: 'RM-001-004-0028', name: 'GLYCERINE', comps: [] },
  { code: 'RM-001-009-0047', name: 'LEELAWADEE', comps: [{ inci: 'FRAGRANCE', pct: 78.88 }, { inci: 'HEXYL CINNAMAL', cas: '101-86-0', pct: 10.83 }] },
  { code: 'RM-002-001-0193', name: 'Linalool', comps: [] }, { code: 'bad', comps: [] }],
  [{ kind: 'a26', inci: 'HEXYL CINNAMAL', cas: '101-86-0', alt: '' }, { kind: 'zzz', inci: 'x' }]), (r) => r.created === 2 && r.kept === 1 && r.skipped === 1 && r.refs === 1);
await ok('listInci', call(COST, 'listInci'), (r) => r.items.length === 3 && r.items.find((x) => x.code === 'RM-002-001-0193').status === 'pending' && r.items.find((x) => x.code === 'RM-001-004-0028').comps.length === 1 && r.refs.length === 1 && r.refs[0].kind === 'a26' && r.canEdit === false);
await ok('re-import refs replaces kind', call(OWNER, 'importInci', [], [{ kind: 'a26', inci: 'LINALOOL', cas: '78-70-6' }, { kind: 'a26', inci: 'CITRAL', cas: '5392-40-5' }]).then(() => call(OWNER, 'listInci')), (r) => r.refs.length === 2 && !r.refs.some((x) => x.inci === 'HEXYL CINNAMAL') && r.canEdit);
await err('deleteInci needs admin', call(COST, 'deleteInci', 'RM-002-001-0193'), 'FORBIDDEN');
await ok('deleteInci', call(OWNER, 'deleteInci', 'RM-002-001-0193').then(() => call(OWNER, 'listInci')), (r) => r.items.length === 2);
/* email reminders (Apps Script → ?fdaCron=fsecret) */
await pg.query(`insert into costing.roles (id, name, perms, system, ord) values ('rarole', 'RA', '{"ra":true}', false, 50) on conflict do nothing`);
await pg.query(`insert into costing.users (email, role, active) values ('ra1@scentandsense.co.th', 'rarole', true), ('ra2@scentandsense.co.th', 'rarole', false) on conflict do nothing`);
const fisoIn = (d) => new Date(Date.now() + d * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
const fmkReg = (no, exp, dec) => call(OWNER, 'saveFdaReg', { regNo: no, notifyDate: '2024-01-01', expiry: exp, productName: 'P ' + no, decision: dec || '' });
await fmkReg('10-1-6900000001', fisoIn(20)); await fmkReg('10-1-6900000002', fisoIn(100)); await fmkReg('10-1-6900000003', fisoIn(400)); await fmkReg('10-1-6900000004', fisoIn(10), 'no'); await fmkReg('10-1-6900000005', fisoIn(-5));
const fcron = async (s, method, body) => (await handler(new Request('https://x/functions/v1/api?fdaCron=' + encodeURIComponent(s), method === 'POST' ? { method, body: JSON.stringify(body) } : {}))).json();
await err('getFdaAlert needs ra', call(COST, 'getFdaAlert'), 'FORBIDDEN');
const ffa = await ok('getFdaAlert creates fsecret + script for admin', call(OWNER, 'getFdaAlert'), (r) => r.admin && /fdaCron=[0-9a-f]{48}/.test(r.script) && r.recipients.join() === 'ra1@scentandsense.co.th' && r.freshCount === 3 && r.dueCount === 3);
const fsecret = ffa.script.match(/fdaCron=([0-9a-f]{48})/)[1];
eq('fcron wrong fsecret', (await fcron('nope')).error, 'FORBIDDEN');
const fc1 = await fcron(fsecret); eq('fcron lists 3 due (20d, 100d, expired 5d; skips 400d and decision no)', fc1.ok && fc1.count === 3 && /ใกล้หมดอายุ 2 รายการ · หมดอายุแล้ว 1 รายการ/.test(fc1.subject) && fc1.html.includes('10-1-6900000001') && !fc1.html.includes('6900000004') && fc1.recipients.length === 1, true);
await ok('save extra recipients + days', call(OWNER, 'saveFdaAlert', { days: '120, 30,x', extra: 'Boss@ScentAndSense.co.th' }), (r) => r.days === '120,30' && r.recipients.includes('boss@scentandsense.co.th') && r.recipients.length === 2);
await err('bad extra email', call(OWNER, 'saveFdaAlert', { days: '30', extra: 'nope@gmail.com' }), 'ใช้ได้เฉพาะอีเมล');
const fc2 = await fcron(fsecret); eq('days 120,30: 100d reg still due', fc2.count === 3, true);
eq('ack marks sent', (await fcron(fsecret, 'POST', { keys: fc2.keys, sentTo: 2 })).marked, 3);
eq('no repeat after ack', (await fcron(fsecret)).count, 0);
await pg.query(`update costing.fda_regs set expiry = '${fisoIn(25)}' where reg_no = '10-1-6900000002'`);
eq('next stage (30d) alerts again', (await fcron(fsecret)).count, 1);
await ok('last-sent shown', call(OWNER, 'getFdaAlert'), (r) => /3 รายการ · ส่งถึง 2 คน/.test(r.last) && !!r.lastPoll);
await ok('reset fsecret invalidates old', call(OWNER, 'resetFdaAlertSecret'), (r) => !r.script.includes(fsecret));
eq('old secret rejected', (await fcron(fsecret)).ok, false);

/* ---------- Product Development: trial batch records → customer feedback ---------- */
await err('listPdTrials forbidden', call(OUT, 'listPdTrials'), 'FORBIDDEN');
await err('savePdTrial needs pd perm', call(COST, 'savePdTrial', { formulaId: pdf1.id }), 'FORBIDDEN');
await err('savePdTrial unknown formula', call(OWNER, 'savePdTrial', { formulaId: 'nope' }), 'ไม่พบสูตร');
const tr1 = await ok('savePdTrial copies formula lines scaled to batch', call(OWNER, 'savePdTrial', { formulaId: pdf1.id, batchG: 500 }), (r) => /^PT\d{4}001$/.test(r.trialNo) && r.status === 'draft' && r.batchG === 500 && r.lines.length === 4 && Math.abs(r.lines.reduce((s, l) => s + l.plannedG, 0) - 500) < 0.01 && r.projectId === p1.id && r.feedback === null);
await err('send needs made status', call(OWNER, 'sendPdTrial', tr1.id), 'ผลิตแล้ว');
const tr1b = await ok('record actual weights + observations, mark made', call(OWNER, 'savePdTrial', { ...tr1, status: 'made', madeAt: '2026-10-24', operator: 'tester', conclusion: 'pass', lines: tr1.lines.map((l, i) => ({ ...l, actualG: l.plannedG + (i === 0 ? 0.5 : 0), lot: 'L' + i })), obs: { appearance: 'ขุ่นเล็กน้อย', color: 'ขาว', odor: 'หอมตามกลิ่นต้นแบบ', ph: '5.5', viscosity: '3000 cps', other: '' } }),
  (r) => r.status === 'made' && r.obs.ph === '5.5' && r.lines[0].lot === 'L0' && r.conclusion === 'pass');
await ok('stock issue skips items missing in R&D stock', call(NOSE, 'issuePdTrialStock', tr1.id), (r) => r.stockIssued && r.stockIssued.issued.length === 0 && r.stockIssued.skipped.length > 0);
await err('stock cannot be issued twice', call(NOSE, 'issuePdTrialStock', tr1.id), 'ตัดสต็อกของบันทึกนี้ไปแล้ว');
const tsent = await ok('sendPdTrial creates mockup sample + link', call(OWNER, 'sendPdTrial', tr1.id), (r) => r.status === 'sent' && /^x/.test(r.sampleId) && /\/eval\//.test(r.evalLink || r.feedback.evalLink) && r.feedback.sampleStatus === 'sent');
await err('send twice', call(OWNER, 'sendPdTrial', tr1.id), 'ส่งหรือปิดไปแล้ว');
await ok('sample appears in the project', call(OWNER, 'getProject', p1.id), (r) => r.samples.some((s) => s.id === tsent.sampleId && s.kind === 'mockup' && s.status === 'sent' && s.items[0].code === tsent.trialNo && s.items[0].formulaCode === pdf1.code));
await ok('tsent trial only note editable', call(OWNER, 'savePdTrial', { id: tr1.id, note: 'หมายเหตุใหม่', batchG: 9999 }), (r) => r.note === 'หมายเหตุใหม่' && r.batchG === 500);
await err('decide before feedback is allowed only when tsent', call(OWNER, 'decidePdTrial', pdf1.id, 'accept'), 'ไม่พบบันทึก');
const ttok = tsent.feedback.evalLink.split('/eval/')[1];
const evr = await submit(ttok, { email: 'buyer@client.com', note: 'ชอบ', items: [{ idx: 0, scores: { scent: 5, appearance: 4, skinfeel: 4, target: 5, brand: 5, overall: 5 }, comment: 'ข้นไปนิด', decision: 'revise' }] }); eq('customer feedback accepted', evr.ok, true);
const tfb = await ok('feedback shows in the trial record', call(OWNER, 'listPdTrials', pdf1.id), (r) => { const t = r.find((x) => x.id === tr1.id); return t.status === 'feedback' && t.feedback.decision === 'revise' && t.feedback.comment === 'ข้นไปนิด' && t.feedback.email === 'buyer@client.com' && t.feedback.pct === 93.33; });
await err('decide needs pd perm', call(COST, 'decidePdTrial', tr1.id, 'revise'), 'FORBIDDEN');
await err('bad action', call(OWNER, 'decidePdTrial', tr1.id, 'zzz'), 'ไม่ถูกต้อง');
const tdec = await ok('revise creates the next round', call(OWNER, 'decidePdTrial', tr1.id, 'revise', 'ลดความข้น'), (r) => r.trial.status === 'revised' && r.next.status === 'draft' && /002$/.test(r.next.trialNo) && r.next.note.includes('ลดความข้น') && r.next.lines.every((l) => l.actualG === l.plannedG) && r.next.sampleId === '');
await err('cannot decide twice', call(OWNER, 'decidePdTrial', tr1.id, 'accept'), 'ส่งลูกค้าแล้ว');
await ok('second round: made then accepted flow', call(OWNER, 'savePdTrial', { ...tdec.next, status: 'made', conclusion: 'pass' }), (r) => r.status === 'made');
await ok('send round 2', call(OWNER, 'sendPdTrial', tdec.next.id), (r) => r.status === 'sent');
await ok('accept round 2 moves formula to testing', call(OWNER, 'decidePdTrial', tdec.next.id, 'accept'), (r) => r.trial.status === 'accepted');
await ok('formula status follows', call(OWNER, 'listPdFormulas', p1.id), (r) => r.find((x) => x.id === pdf1.id).status === 'testing');
await ok('list by project', call(OWNER, 'listPdTrials', '', p1.id), (r) => r.length === 2);

/* ---------- password login ---------- */
const PWU = 'pwuser@scentandsense.co.th';
await ok('add pw user', call(OWNER, 'setUser', PWU, 'costing', true, false));
await err('login before password set', raw({ fn: 'pwLogin', args: [PWU, 'Secret123x', false] }), 'ตั้งรหัสผ่านครั้งแรก');
await err('login foreign domain', raw({ fn: 'pwLogin', args: ['a@gmail.com', 'Secret123x', false] }), 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
await err('setMyPassword needs auth', raw({ fn: 'setMyPassword', args: ['Secret123x', '', false] }), 'AUTH_REQUIRED');
await err('policy: short', raw({ fn: 'setMyPassword', args: ['Ab1', '', false], idToken: 'good:' + PWU }), 'อย่างน้อย 8');
await err('policy: no digit', raw({ fn: 'setMyPassword', args: ['abcdefghij', '', false], idToken: 'good:' + PWU }), 'ตัวอักษรและตัวเลข');
await err('policy: contains email name', raw({ fn: 'setMyPassword', args: ['pwuser2026', '', false], idToken: 'good:' + PWU }), 'ชื่ออีเมล');
const setp = await raw({ fn: 'setMyPassword', args: ['Secret123x', '', true], idToken: 'good:' + PWU });
eq('set password via google returns session', setp.ok && setp.result.session.length > 30 && setp.result.email === PWU && new Date(setp.result.expiresAt) > new Date(Date.now() + 20 * 86400000), true);
eq('only hash stored', (await pg.query(`select hash from costing.credentials where email = $1`, [PWU])).rows[0].hash.startsWith('pbkdf2$210000$'), true);
eq('session token stored hashed', (await pg.query(`select count(*)::int n from costing.sessions where id = $1`, [setp.result.session])).rows[0].n, 0);
const li = await raw({ fn: 'pwLogin', args: [PWU.toUpperCase(), 'Secret123x', false] });
eq('pwLogin ok (case-insensitive email, 12h session)', li.ok && li.result.session && new Date(li.result.expiresAt) < new Date(Date.now() + 13 * 3600000), true);
await ok('session works for bootstrap', raw({ fn: 'bootstrap', session: li.result.session }), (r) => r.me.email === PWU && r.me.role === 'costing');
await err('wrong password', raw({ fn: 'pwLogin', args: [PWU, 'Wrong1234', false] }), 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
for (let i = 0; i < 3; i++) await raw({ fn: 'pwLogin', args: [PWU, 'Wrong1234', false] });
await err('5th wrong locks', raw({ fn: 'pwLogin', args: [PWU, 'Wrong1234', false] }), 'ล็อก 15 นาที');
await err('locked even with right password', raw({ fn: 'pwLogin', args: [PWU, 'Secret123x', false] }), 'ถูกล็อกชั่วคราว');
await err('change pw via session needs old', raw({ fn: 'setMyPassword', args: ['Newpass456', 'nope', false], session: li.result.session }), 'รหัสผ่านเดิมไม่ถูกต้อง');
const ch = await raw({ fn: 'setMyPassword', args: ['Newpass456', 'Secret123x', false], session: li.result.session });
eq('change pw via session ok + unlocks', ch.ok === true, true);
await err('old sessions revoked after change', raw({ fn: 'bootstrap', session: li.result.session }), 'AUTH_EXPIRED');
await ok('login with new password', raw({ fn: 'pwLogin', args: [PWU, 'Newpass456', false] }), (r) => !!r.session);
await ok('forgot password via google resets', raw({ fn: 'setMyPassword', args: ['Third789x', '', false], idToken: 'good:' + PWU }), (r) => !!r.session);
const lo = await raw({ fn: 'pwLogin', args: [PWU, 'Third789x', false] });
await ok('logout', raw({ fn: 'pwLogout', session: lo.result.session }), (r) => r.ok === true);
await err('session dead after logout', raw({ fn: 'bootstrap', session: lo.result.session }), 'AUTH_EXPIRED');
await ok('admin sees hasPassword', call(OWNER, 'adminData'), (r) => r.users.find((u) => u.email === PWU).hasPassword === true && r.withPassword.includes(PWU));
await err('reset pw forbidden for non-admin', call(COST, 'resetUserPassword', PWU), 'FORBIDDEN');
await ok('admin resets password', call(OWNER, 'resetUserPassword', PWU), (r) => r.users.find((u) => u.email === PWU).hasPassword === false);
await err('login after reset', raw({ fn: 'pwLogin', args: [PWU, 'Third789x', false] }), 'ตั้งรหัสผ่านครั้งแรก');
await ok('new domain user can set password then sees no access', raw({ fn: 'setMyPassword', args: ['Hello2026x', '', false], idToken: 'good:newbie@scentandsense.co.th' }), (r) => !!r.session);
await ok('newbie bootstrap = no role', raw({ fn: 'pwLogin', args: ['newbie@scentandsense.co.th', 'Hello2026x', false] }).then(async (r) => raw({ fn: 'bootstrap', session: r.result.session })), (r) => r.me.role === null);

/* ---------- mail (Resend) is optional ---------- */
await pg.query(`insert into costing.settings (key, value) values ('resendKey', 're_test') on conflict (key) do update set value = excluded.value`);
await ok('complaint triggers mail', call(COST, 'submitComplaint', 'เรื่องที่สอง', 'รายละเอียดอีกเรื่อง'));
eq('mail sent to owner', MAILS.length >= 1 && MAILS[0].to[0] === OWNER && MAILS[0].subject.includes('เรื่องร้องเรียนใหม่'), true);

/* ---------- log ---------- */
const logs = (await pg.query(`select action, count(*)::int n from costing.log group by action`)).rows; eq('audit log written', logs.some((l) => l.action === 'updatePrices') && logs.some((l) => l.action === 'importAll'), true);

/* ---------- PD formula: Product Information header (FM-RD-03) ---------- */
{
  const hdr = { name: 'Header test lotion', mode: 'standard', baseId: pb1.id, projectId: p1.id, customer: 'ONEST Co', brand: 'ONEST', fragranceName: 'Home Retreat 01', fragranceCode: 'PF2810101', lines: pb1.lines,
    productName: 'Siam Bloom Body Lotion 200 ml', fgCode: 'FG-LT-0001', category: 'Lotion', revision: 2, purpose: 'ส่งตัวอย่างให้ลูกค้า', packaging: 'ขวดปั๊ม PET 200 ml', fillQty: '200 ml', qty: '1500',
    sampleDue: '2026-11-05', designDate: '2026-10-26', mockupDate: 'not-a-date', perfumer: NOSE, designer: OWNER, operator: 'เมย์' };
  const h1 = await ok('savePdFormula keeps the Product Information header', call(OWNER, 'savePdFormula', hdr), (r) => r.productName === hdr.productName && r.fgCode === 'FG-LT-0001' && r.revision === 2 && r.qty === 1500 && r.purpose === hdr.purpose && r.packaging === hdr.packaging && r.fillQty === '200 ml' && r.sampleDue === '2026-11-05' && r.designDate === '2026-10-26' && r.perfumer === NOSE && r.designer === OWNER && r.operator === 'เมย์' && r.customer === 'ONEST Co' && r.category === 'Lotion');
  eq('invalid date is dropped, not stored', h1 && h1.mockupDate, '');
  await ok('header survives a reload (listPdFormulas)', call(COST, 'listPdFormulas', p1.id), (r) => { const x = r.find((v) => v.id === h1.id); return x && x.productName === hdr.productName && x.revision === 2 && x.qty === 1500 && x.sampleDue === '2026-11-05'; });
  await ok('update the header and set the mock-up date', call(OWNER, 'savePdFormula', { ...h1, mockupDate: '2026-11-02', fgCode: 'FG-LT-0002', revision: 3 }), (r) => r.id === h1.id && r.mockupDate === '2026-11-02' && r.fgCode === 'FG-LT-0002' && r.revision === 3 && r.code === h1.code);
  await ok('older formulas without the new fields still load with empty defaults', call(COST, 'listPdFormulas'), (r) => r.every((x) => typeof x.productName === 'string' && x.qty !== undefined && x.revision !== undefined));
  await ok('cleanup header test formula', call(OWNER, 'deletePdFormula', h1.id));
}
/* ---------- PD formula: ingredient Part column ---------- */
{
  const ls = [{ part: 'A', code: 'RM-025-011-0608', name: 'RO WATER', pct: 80, price: 0 }, { part: 'A', name: 'Glycerine', pct: 15, price: 63 }, { part: 'B', name: 'Fragrance', pct: 5, price: 3000, frag: true }];
  const h = await ok('formula lines keep their Part', call(OWNER, 'savePdFormula', { name: 'Part test', mode: 'standard', baseId: pb1.id, lines: ls }), (r) => r.lines.map((l) => l.part).join('') === 'AAB');
  await ok('Part survives reload and is trimmed to 20 chars', call(OWNER, 'savePdFormula', { ...h, lines: h.lines.map((l, k) => (k === 0 ? { ...l, part: 'PART-' + 'X'.repeat(40) } : l)) }), (r) => r.lines[0].part.length === 20 && r.lines[2].part === 'B');
  await ok('base lines keep Part too', call(OWNER, 'savePdBase', { category: 'Lotion', name: 'Part base', lines: [{ part: 'A', name: 'Water', pct: 95, price: 0 }, { part: 'B', name: 'Fragrance', pct: 5, price: 2000, frag: true }] }), (r) => r.lines[0].part === 'A' && r.lines[1].part === 'B');
  await ok('old lines without Part load with empty part', call(COST, 'listPdFormulas', p1.id), (r) => r.every((x) => x.lines.every((l) => typeof l.part === 'string')));
  await ok('cleanup part-test formula', call(OWNER, 'deletePdFormula', h.id));
}
/* ---------- PD formula: FM-RD-03 sections (steps, spec, stability, conclusion) ---------- */
{
  const body = { name: 'FM03 test', mode: 'standard', baseId: pb1.id, lines: pb1.lines,
    steps: [{ step: 'ให้ความร้อนเฟสน้ำ', min: '15', temp: '75', rpm: '300', equip: 'Homo mixer', note: 'ระวังฟอง' }, { step: '', min: '', temp: '', rpm: '', equip: '', note: '' }, { step: 'ผสมน้ำหอมที่ 40°C', min: '5-10', temp: '40', rpm: '', equip: 'Propeller', note: '' }],
    spec: [{ target: 'ขาวนวล', method: 'Visual', limit: 'Match std. ref.', result: 'ผ่าน' }, {}, {}, { target: '5.5', limit: '±1', result: '5.6' }],
    stab: [{ obs: '1', pf: 'pass', note: 'ไม่แยกชั้น' }, { obs: '0', pf: 'fail', note: 'สีเปลี่ยนเล็กน้อย' }, { obs: 'x', pf: 'maybe', note: 'n'.repeat(500) }],
    concl: { result: 'cond', cond: 'เพิ่มสารช่วยกระจายกลิ่น', fail: '' } };
  const h = await ok('FM-RD-03 sections are saved', call(OWNER, 'savePdFormula', body), (r) => r.steps.length === 2 && r.steps[0].step === 'ให้ความร้อนเฟสน้ำ' && r.steps[0].min === '15' && r.steps[1].min === '5-10' && r.spec.length === 6 && r.spec[0].result === 'ผ่าน' && r.spec[3].target === '5.5' && r.stab.length === 6 && r.stab[0].obs === '1' && r.stab[0].pf === 'pass' && r.stab[1].pf === 'fail' && r.concl.result === 'cond' && r.concl.cond.includes('สารช่วยกระจายกลิ่น'));
  eq('invalid stability values are cleaned and long notes cut', h && [h.stab[2].obs, h.stab[2].pf, h.stab[2].note.length, h.stab[5].obs], ['', '', 300, '']);
  await ok('sections survive a reload', call(COST, 'listPdFormulas', p1.id), (r) => { const x = r.find((v) => v.id === h.id); return x && x.steps.length === 2 && x.concl.result === 'cond' && x.spec[0].target === 'ขาวนวล'; });
  await ok('invalid conclusion result is dropped', call(OWNER, 'savePdFormula', { ...h, concl: { result: 'hack', cond: 'x' } }), (r) => r.concl.result === '' && r.concl.cond === 'x');
  await ok('at most 30 steps are kept', call(OWNER, 'savePdFormula', { ...h, steps: Array.from({ length: 45 }, (_, k) => ({ step: 'step ' + k })) }), (r) => r.steps.length === 30);
  await ok('older formulas load with empty sections', call(COST, 'listPdFormulas'), (r) => r.every((x) => Array.isArray(x.steps) && x.spec.length === 6 && x.stab.length === 6 && typeof x.concl.result === 'string'));
  await ok('cleanup FM-RD-03 test formula', call(OWNER, 'deletePdFormula', h.id));
}
/* ---------- PD formula: FM-RD-03 header fields (mock-up request date, appearance, colour, odor) ---------- */
{
  const h = await ok('FM-RD-03 header fields are saved', call(OWNER, 'savePdFormula', { name: 'Header2', mode: 'standard', baseId: pb1.id, lines: pb1.lines, mockupRequest: '2026-10-27', appearance: 'ครีมข้นสีขาว', colour: 'ขาวนวล', odor: 'ชาขาว นุ่ม' }), (r) => r.mockupRequest === '2026-10-27' && r.appearance === 'ครีมข้นสีขาว' && r.colour === 'ขาวนวล' && r.odor === 'ชาขาว นุ่ม');
  await ok('bad mock-up request date is dropped, long text cut', call(OWNER, 'savePdFormula', { ...h, mockupRequest: '27/10/2026', appearance: 'x'.repeat(400), colour: 'y'.repeat(200) }), (r) => r.mockupRequest === '' && r.appearance.length === 120 && r.colour.length === 60);
  await ok('older formulas load with empty header fields', call(COST, 'listPdFormulas'), (r) => r.every((x) => typeof x.appearance === 'string' && typeof x.colour === 'string' && typeof x.odor === 'string' && typeof x.mockupRequest === 'string'));
  await ok('cleanup header fields test', call(OWNER, 'deletePdFormula', h.id));
}
/* ---------- FM-RD-03 imported formulas: owner-only upsert, hidden from the default list, server-side search, single get ---------- */
{
  const item = { id: 'imp-fm03-test0001', code: 'FM03-25-0001', name: 'Imported Lotion', status: 'draft', createdAt: '2025-06-01T05:00:00Z', customer: 'ACME', brand: 'Acme', category: 'Lotion', batchG: 500,
    lines: [{ part: 'A', code: 'RM-001-003-0001', name: 'Emal', pct: 60, note: '3 drop' }, { part: 'B', code: 'RM-002', name: 'Water', pct: 40 }], steps: [{ step: 'ผสม A' }], note: 'นำเข้าจากไฟล์ FM-RD-03' };
  await err('importPdFormulas owner only', call(ADMIN, 'importPdFormulas', { items: [item] }), 'FORBIDDEN');
  await ok('importPdFormulas upserts (bad id skipped)', call(OWNER, 'importPdFormulas', { items: [item, { id: 'x-bad', name: 'bad', lines: [{ name: 'a', pct: 1 }] }] }), (r) => r.imported === 1 && r.skipped === 1);
  await ok('importPdFormulas idempotent', call(OWNER, 'importPdFormulas', { items: [{ ...item, name: 'Imported Lotion v2' }] }), (r) => r.imported === 1);
  await ok('imported formulas hidden from the default list', call(COST, 'listPdFormulas'), (r) => Array.isArray(r) && !r.some((x) => x.id === item.id));
  await ok('searchPdImported finds by ingredient code', call(COST, 'searchPdImported', 'rm-001-003'), (r) => r.total === 1 && r.items.length === 1 && r.items[0].name === 'Imported Lotion v2' && r.items[0].createdBy === 'import:fm03' && r.items[0].lines[0].note === '3 drop' && r.items[0].createdAt.startsWith('2025-06-01'));
  await ok('searchPdImported empty query lists latest', call(COST, 'searchPdImported', ''), (r) => r.items.length === 1);
  await ok('searchPdImported no match', call(COST, 'searchPdImported', 'zzzz-nothing'), (r) => r.items.length === 0 && r.total === 1);
  await ok('getPdFormula returns the imported formula', call(COST, 'getPdFormula', item.id), (r) => r.code === 'FM03-25-0001' && r.lines.length === 2 && r.steps[0].step === 'ผสม A');
  await err('getPdFormula unknown', call(COST, 'getPdFormula', 'nope'), 'ไม่พบสูตร');
  await err('getPdFormula forbidden outside R&D', call(OUT, 'getPdFormula', item.id), 'FORBIDDEN');
  await ok('cleanup imported formula', call(OWNER, 'deletePdFormula', item.id));
}
/* ---------- PD formula docs: approved Product Development formulas appear in the document registry and can issue documents ---------- */
{
  const pdd = await ok('PD formula docs: save draft', call(OWNER, 'savePdFormula', { name: 'Doc Lotion', customer: 'ACME', brand: 'Acme', status: 'draft', lines: [{ code: 'RM-001-003-0001', name: 'Emal', pct: 60 }, { code: 'RM-002', name: 'Water', pct: 40 }] }), (r) => /^pdf-/.test(r.id) && r.status === 'draft');
  await ok('PD formula docs: draft not listed', call(COST, 'listPdDocFormulas'), (r) => Array.isArray(r) && !r.some((x) => x.id === pdd.id));
  await err('PD formula docs: draft cannot issue', call(COST, 'issueDoc', 'SDS', pdd.id, JSON.stringify({ product: 'Doc Lotion' })), 'อนุมัติแล้ว');
  await ok('PD formula docs: approve', call(OWNER, 'savePdFormula', { ...pdd, status: 'approved' }), (r) => r.status === 'approved');
  await ok('PD formula docs: approved listed', call(COST, 'listPdDocFormulas'), (r) => r.some((x) => x.id === pdd.id && x.nLines === 2 && x.customer === 'ACME' && !x.lines));
  await err('PD formula docs: needs calc perm', call(NOSE, 'listPdDocFormulas'), 'FORBIDDEN');
  const pd1 = await ok('PD formula docs: issue SDS', call(COST, 'issueDoc', 'SDS', pdd.id, JSON.stringify({ product: 'Doc Lotion', customer: 'ACME' })), (r) => /^SDS-[0-9]{4}-[0-9]{4}$/.test(r.docNo) && r.rev >= 1);
  await ok('PD formula docs: issuer sees it in listDocs', call(COST, 'listDocs'), (r) => r.some((d) => d.id === pd1.id && d.formulaId === pdd.id));
  await ok('PD formula docs: getDoc works', call(COST, 'getDoc', pd1.id), (r) => r.formulaId === pdd.id);
  await ok('PD formula docs: retired formula not listed', call(OWNER, 'savePdFormula', { ...pdd, status: 'retired' }), (r) => r.status === 'retired');
  await ok('PD formula docs: retired not listed', call(COST, 'listPdDocFormulas'), (r) => !r.some((x) => x.id === pdd.id));
  await err('PD formula docs: retired cannot issue', call(COST, 'issueDoc', 'IFRA', pdd.id, JSON.stringify({ product: 'Doc Lotion' })), 'อนุมัติแล้ว');
}
/* ---------- PD customers for the label page ---------- */
{
  await ok('listPdCustomers', call(COST, 'listPdCustomers'), (r) => Array.isArray(r) && r.some((x) => x.customer === 'ACME' && x.n >= 1) && r.every((x) => x.customer && x.n > 0));
  await err('listPdCustomers forbidden', call(OUT, 'listPdCustomers'), 'FORBIDDEN');
  await ok('listPdByCustomer exact match', call(COST, 'listPdByCustomer', 'ACME'), (r) => r.length >= 1 && r.every((x) => !x.lines && x.nLines >= 1) && r.some((x) => x.name === 'Doc Lotion'));
  await ok('listPdByCustomer no partial match', call(COST, 'listPdByCustomer', 'ACM'), (r) => r.length === 0);
  await err('listPdByCustomer needs a customer', call(COST, 'listPdByCustomer', ''), 'ระบุลูกค้า');
  await err('listPdByCustomer forbidden', call(OUT, 'listPdByCustomer', 'ACME'), 'FORBIDDEN');
}
/* ---------- PD formula search for the label page ---------- */
{
  await ok('searchPdFormulas by name', call(COST, 'searchPdFormulas', 'doc lotion'), (r) => r.length >= 1 && r.every((x) => !x.lines) && r.some((x) => x.name === 'Doc Lotion' && x.customer === 'ACME'));
  await ok('searchPdFormulas by brand', call(COST, 'searchPdFormulas', 'acme'), (r) => r.some((x) => x.name === 'Doc Lotion'));
  await ok('searchPdFormulas by customer name (partial)', call(COST, 'searchPdFormulas', 'acm'), (r) => r.some((x) => x.name === 'Doc Lotion' && x.customer === 'ACME'));
  await ok('searchPdFormulas customer filter hit', call(COST, 'searchPdFormulas', 'lotion', 'ACME'), (r) => r.some((x) => x.name === 'Doc Lotion'));
  await ok('searchPdFormulas customer filter miss', call(COST, 'searchPdFormulas', 'lotion', 'Nobody Co'), (r) => r.length === 0);
  await ok('searchPdFormulas wildcard chars are literal', call(COST, 'searchPdFormulas', '%'), (r) => r.length === 0);
  await err('searchPdFormulas needs a query', call(COST, 'searchPdFormulas', '  '), 'พิมพ์คำค้น');
  await err('searchPdFormulas forbidden', call(OUT, 'searchPdFormulas', 'lotion'), 'FORBIDDEN');
}
/* ---------- label archive (คลังส่วนประกอบฉลาก) ---------- */
{
  const lbl = { src: 'pd', formulaId: 'pdf-lblTest01', formulaCode: 'PD2610999', formulaName: 'Label Test Mist', customer: 'ACME', brand: 'Acme', type: 'leave', list: 'a83', fragName: 'FRAGRANCE', minPct: 0.0004, lineSum: 100,
    ingredients: 'AQUA, FRAGRANCE, LIMONENE', rows: [{ inci: 'AQUA', cas: '7732-18-5', pct: 80 }, { inci: 'FRAGRANCE', pct: 19.9, frag: true }, { inci: 'LIMONENE', cas: '5989-27-5', pct: 0.1, kind: 'a26' }], hidden: [{ inci: 'TRACE', pct: 0.0001 }], warnings: ['ทดสอบ'], note: 'รอบแรก' };
  await err('saveLabelArchive forbidden', call(OUT, 'saveLabelArchive', lbl), 'FORBIDDEN');
  await err('saveLabelArchive needs rows', call(COST, 'saveLabelArchive', { ...lbl, rows: [] }), 'ไม่มีส่วนประกอบ');
  await err('saveLabelArchive needs text', call(COST, 'saveLabelArchive', { ...lbl, ingredients: '' }), 'ไม่มีส่วนประกอบ');
  const l1 = await ok('saveLabelArchive first', call(COST, 'saveLabelArchive', lbl), (r) => /^LBL-[0-9]{4}-0001$/.test(r.docNo) && r.rev === 1);
  const l2 = await ok('saveLabelArchive same formula = next rev', call(COST, 'saveLabelArchive', lbl), (r) => /-0002$/.test(r.docNo) && r.rev === 2);
  const l3 = await ok('saveLabelArchive other group restarts rev', call(COST, 'saveLabelArchive', { ...lbl, type: 'rinse' }), (r) => r.rev === 1);
  await ok('listLabelArchive newest first, no rows', call(NOSE, 'listLabelArchive'), (r) => r.length === 3 && r[0].id === l3.id && r.every((x) => !x.rows && x.nRows === 3 && x.nHidden === 1) && r[0].type === 'rinse' && r[2].note === 'รอบแรก');
  await err('listLabelArchive forbidden', call(OUT, 'listLabelArchive'), 'FORBIDDEN');
  await ok('getLabelArchive full', call(NOSE, 'getLabelArchive', l1.id), (r) => r.rows.length === 3 && r.rows[2].kind === 'a26' && r.rows[1].frag === true && r.hidden[0].inci === 'TRACE' && r.warnings[0] === 'ทดสอบ' && r.createdBy === COST && r.minPct === 0.0004);
  await err('getLabelArchive unknown', call(NOSE, 'getLabelArchive', 'nope'), 'ไม่พบรายการ');
  await err('deleteLabelArchive by other non-admin', call(NOSE, 'deleteLabelArchive', l1.id), 'FORBIDDEN');
  await ok('deleteLabelArchive by creator', call(COST, 'deleteLabelArchive', l1.id), (r) => r.ok === true);
  await ok('deleteLabelArchive by admin', call(ADMIN, 'deleteLabelArchive', l2.id), (r) => r.ok === true);
  await ok('archive keeps remaining', call(COST, 'listLabelArchive'), (r) => r.length === 1 && r[0].id === l3.id);
  await ok('cleanup archive', call(OWNER, 'deleteLabelArchive', l3.id), (r) => r.ok === true);
}
/* ---------- duplicate keys for merging Perfumer + PD formula pickers ---------- */
{
  await ok('listPdDupKeys lower-case names and codes', call(COST, 'listPdDupKeys'), (r) => Array.isArray(r.names) && Array.isArray(r.codes) && r.names.includes('doc lotion') && r.names.every((n) => n === n.toLowerCase()) && r.codes.every((c) => c === c.toLowerCase() && c));
  await err('listPdDupKeys forbidden', call(OUT, 'listPdDupKeys'), 'FORBIDDEN');
}
/* ---------- Allergen Report documents (ALG26 / ALG83) ---------- */
{
  const items26 = Array.from({ length: 26 }, (_v, i) => (i === 20 ? '0.0123' : '-'));
  const a1 = await ok('issueDoc ALG26', call(COST, 'issueDoc', 'alg26', 'pnew00001', JSON.stringify({ product: 'Test Oil', customer: 'ACME', productCode: 'FG-1', fda: 'N/A', revision: '00', items: items26 })), (r) => /^ALG26-[0-9]{4}-0001$/.test(r.docNo) && r.rev === 1);
  await ok('issueDoc ALG83', call(COST, 'issueDoc', 'ALG83', 'pnew00001', JSON.stringify({ product: 'Test Oil', items: Array.from({ length: 83 }, () => '-') })), (r) => /^ALG83-[0-9]{4}-0001$/.test(r.docNo));
  await ok('ALG docs listed with their types', call(COST, 'listDocs'), (r) => r.some((d) => d.type === 'ALG26') && r.some((d) => d.type === 'ALG83'));
  await ok('ALG doc payload kept', call(COST, 'getDoc', a1.id), (r) => JSON.parse(r.data).items[20] === '0.0123' && r.type === 'ALG26');
}
/* ---------- price quote history (ประวัติขอราคา) ---------- */
{
  const it = (n, o) => ({ id: 'pq26-' + n, line: n, customer: 'ACME Co', scentName: 'Rose ' + n, scentCode: 'PF9' + n, product: 'EDP', formulaDate: '2026-03-01', rdDue: '2026-03-10', sentAt: '2026-03-19', raBy: 'พี่เจ', rdBy: 'PD', price: 88 + n, priceRaw: (88 + n) + ' BAHT/KG', ...o });
  await err('importPriceQuotes owner only', call(ADMIN, 'importPriceQuotes', { items: [it(1)] }), 'FORBIDDEN');
  await ok('importPriceQuotes upserts, skips bad ids', call(OWNER, 'importPriceQuotes', { items: [it(1), it(2, { price: null, priceRaw: 'TBA' }), { id: 'bad', customer: 'x' }] }), (r) => r.imported === 2 && r.skipped === 1);
  await ok('importPriceQuotes idempotent', call(OWNER, 'importPriceQuotes', { items: [it(1, { note: 'แก้' })] }), (r) => r.imported === 1);
  await ok('listPriceQuotes admin', call(ADMIN, 'listPriceQuotes'), (r) => r.length === 2 && r.find((x) => x.id === 'pq26-1').note === 'แก้' && r.find((x) => x.id === 'pq26-1').price === 89 && r.find((x) => x.id === 'pq26-2').price === null && r.find((x) => x.id === 'pq26-2').priceRaw === 'TBA');
  await err('listPriceQuotes needs admin', call(COST, 'listPriceQuotes'), 'FORBIDDEN');
}
/* ---------- saveMyFormulas never deletes rows the client did not know about ---------- */
{
  const mk = (id, n) => ({ id, name: n, data: JSON.stringify({ lines: [], name: n }) });
  await ok('save two formulas', call(COST, 'saveMyFormulas', [mk('kg-aaa', 'A'), mk('kg-bbb', 'B')]), (r) => r.saved === 2);
  await ok('stale client (knows only A) keeps B', call(COST, 'saveMyFormulas', [mk('kg-aaa', 'A')], ['kg-aaa']), (r) => r.saved === 1);
  await ok('B still on the server', call(COST, 'loadMyFormulas'), (r) => r.some((x) => x.id === 'kg-bbb') && r.some((x) => x.id === 'kg-aaa'));
  await ok('client that knew B deletes it', call(COST, 'saveMyFormulas', [mk('kg-aaa', 'A')], ['kg-aaa', 'kg-bbb']), (r) => r.saved === 1);
  await ok('B is gone', call(COST, 'loadMyFormulas'), (r) => !r.some((x) => x.id === 'kg-bbb'));
  await ok('legacy client (no known list) still deletes', call(COST, 'saveMyFormulas', []), (r) => r.saved === 0);
  await err('importScentFormulas owner only', call(NOSE, 'importScentFormulas', [{ code: 'PF1', lines: [['RM-1', 1]] }], COST), 'FORBIDDEN');
  /* bulk import: new code → new scent + formula; existing scent without formula → formula attached; existing with formula untouched */
  const ex1 = await ok('scent for attach', call(NOSE, 'saveScent', { name: 'Attach Me', projectId: p1.id }), (r) => !!r.formulaCode);
  const SF = [{ code: 'PF9990101', name: 'NEW ONE', brand: 'Test Brand', lines: [['RM-002-001-0193', 3], ['RM-ZZZ-999-0001', 2, 'Unknown Oil'], ['RM-002-001-0148', 1]] }, { code: ex1.formulaCode, name: 'x', brand: 'b', lines: [['RM-002-001-0148', 5]] }];
  await ok('importScentFormulas creates + attaches', call(OWNER, 'importScentFormulas', SF, COST), (r) => r.items === 2 && r.created === 1 && r.attached === 1 && r.formulas === 2);
  await ok('import is idempotent', call(OWNER, 'importScentFormulas', SF, COST), (r) => r.created === 0 && r.attached === 0 && r.skipped_has_formula === 2);
  await ok('imported scent + formulas visible', call(OWNER, 'listScents'), (r) => { const n = r.find((x) => x.formulaCode === 'PF9990101'), a = r.find((x) => x.id === ex1.id); return n && n.owner === COST && /^SC-2026-/.test(n.code) && n.formulaId === 'pfm-pf9990101' && a.formulaId === 'pfm-' + ex1.formulaCode.toLowerCase(); });
  await ok('owner formulas hold the lines; unknown RM keeps its name', call(COST, 'loadMyFormulas'), (r) => { const f = r.find((x) => x.id === 'pfm-pf9990101'); if (!f) return false; const d = JSON.parse(f.data); return d.unit === 'drop' && d.batchKg === 0.005 && d.lines.length === 3 && d.lines[1].nameIn === 'Unknown Oil' && d.lines[0].nameIn === '' && d.lines[0].amt === '3'; });
}
/* ---------- RM olfactive data (rm_olf) ---------- */
{
  await err('saveRmOlf needs perfumer/editPrices', call(VIEW, 'saveRmOlf', 'RM-002-001-0193', { layer: 'heart', fam: { floral: 0.9 } }), 'FORBIDDEN');
  await err('saveRmOlf bad code', call(OWNER, 'saveRmOlf', 'X1', { layer: 'top' }), 'รหัสวัตถุดิบ');
  await ok('saveRmOlf sanitises', call(OWNER, 'saveRmOlf', 'RM-002-001-0193', { layer: 'heart', fam: { floral: 0.9, green: 2, bogus: 1, woody: -1 }, odor: 'ดอกไม้' }), (r) => r.layer === 'heart' && r.fam.floral === 0.9 && r.fam.green === 1 && !('bogus' in r.fam) && !('woody' in r.fam) && r.src === 'manual');
  await ok('saveRmOlf strength + life clamp', call(OWNER, 'saveRmOlf', 'RM-002-001-0193', { layer: 'heart', fam: { floral: 0.9 }, strength: 9, life: 5000 }), (r) => r.strength === 5 && r.life === 2000);
  await ok('saveRmOlf blank strength/life = null', call(OWNER, 'saveRmOlf', 'RM-002-001-0193', { layer: 'heart', fam: { floral: 0.9 }, strength: '', life: 0 }), (r) => r.strength === null && r.life === null);
  await ok('saveRmOlf none drops families', call(NOSE, 'saveRmOlf', 'RM-001-004-0028', { layer: 'none', fam: { floral: 1 } }), (r) => r.layer === 'none' && Object.keys(r.fam).length === 0);
  await err('saveRmOlf max 4 families', call(OWNER, 'saveRmOlf', 'RM-002-001-0193', { layer: 'top', fam: { citrus: 1, green: 1, aquatic: 1, floral: 1, spicy: 1 } }), 'ไม่เกิน 4');
  await ok('listRmOlf returns rows', call(COST, 'listRmOlf'), (r) => r.length === 2 && r.some((x) => x.code === 'RM-002-001-0193'));
  await err('listRmOlf forbidden outside', call(OUT, 'listRmOlf'), 'FORBIDDEN');
  await ok('saveRmOlf empty clears', call(OWNER, 'saveRmOlf', 'RM-001-004-0028', {}), (r) => r.layer === '');
  await ok('cleared row is gone', call(OWNER, 'listRmOlf'), (r) => r.length === 1);
}
/* ---------- project scent design brief (data.scentDesign) ---------- */
{
  const sd = { story: '  เรื่องแบรนด์  ', arch: 'lover', concept: 'Silk', heart: 'Rose, Jasmine', moods: ['warm', 'calm', 'warm', 'BAD!', 'fresh', 'clean'], tone: 'อบอุ่น', details: 'x', extra: 1 };
  await err('saveProjectScentDesign forbidden', call(OUT, 'saveProjectScentDesign', p1.id, sd), 'FORBIDDEN');
  await err('saveProjectScentDesign unknown project', call(OWNER, 'saveProjectScentDesign', 'nope', sd), 'ไม่พบโครงการ');
  await ok('saveProjectScentDesign sanitises', call(OWNER, 'saveProjectScentDesign', p1.id, sd), (r) => { const d = r.data.scentDesign; return d.story === 'เรื่องแบรนด์' && d.arch === 'lover' && d.moods.join() === 'warm,calm,fresh' && !('extra' in d) && d.by === OWNER; });
  await ok('saveProjectScentDesign brand colours', call(OWNER, 'saveProjectScentDesign', p1.id, { c1: '#ABCDEF', c2: 'red' }), (r) => r.data.scentDesign.c1 === '#abcdef' && r.data.scentDesign.c2 === '');
  await ok('saveProjectScentDesign drops a bad archetype', call(OWNER, 'saveProjectScentDesign', p1.id, { arch: 'Not An Id' }), (r) => r.data.scentDesign.arch === '' && r.data.scentDesign.moods.length === 0);
  await ok('scent design persists on getProject', call(OWNER, 'getProject', p1.id), (r) => !!r.project.data.scentDesign);
}
/* ---------- project Mockup editing (data.mockups) ---------- */
{
  const mk = [{ product: 'Lotion', name: 'Rose Lotion', code: 'PF1', date: '2026-05-01', cf: '2026-05-10', extra: 'bad-date', rounds: [{ due: '2026-05-02', follow: '2026-05-05' }, { due: '2026-05-08' }, { follow: '2026-05-09' }, { due: '2026-05-10' }], note: 'รอบแรก' }, { product: '', name: '', code: '' }];
  await err('saveProjectMockups forbidden', call(OUT, 'saveProjectMockups', p1.id, mk), 'FORBIDDEN');
  await err('saveProjectMockups unknown project', call(OWNER, 'saveProjectMockups', 'nope', mk), 'ไม่พบโครงการ');
  await err('saveProjectMockups must be a list', call(OWNER, 'saveProjectMockups', p1.id, 'x'), 'ไม่เกิน 60');
  await ok('saveProjectMockups sanitises and keeps one item', call(OWNER, 'saveProjectMockups', p1.id, mk), (r) => r.data.mockups.length === 1 && r.data.mockups[0].extra === '' && r.data.mockups[0].rounds.length === 3 && r.data.mockups[0].cf === '2026-05-10' && r.data.mockups[0].name === 'Rose Lotion');
  await ok('Mockups persist on getProject', call(OWNER, 'getProject', p1.id), (r) => r.project.data.mockups[0].code === 'PF1');
  await ok('saveProjectMockups replaces the whole list', call(OWNER, 'saveProjectMockups', p1.id, []), (r) => Array.isArray(r.data.mockups) && r.data.mockups.length === 0);
}
/* ---------- real names for document signers ---------- */
{
  await err('setUserName needs manageUsers', call(COST, 'setUserName', COST, 'X Y'), 'FORBIDDEN');
  await err('setUserName unknown user', call(OWNER, 'setUserName', 'nobody@scentandsense.co.th', 'X Y'), 'ไม่พบผู้ใช้');
  await ok('setUserName saves and returns admin data', call(OWNER, 'setUserName', COST, '  สมชาย ใจดี  '), (r) => r.users.find((u) => u.email === COST).fullName === 'สมชาย ใจดี');
  await ok('listPeopleNames maps email to name', call(NOSE, 'listPeopleNames'), (r) => r[COST] === 'สมชาย ใจดี' && Object.values(r).every((v) => v));
  await err('listPeopleNames forbidden outside R&D', call(OUT, 'listPeopleNames'), 'FORBIDDEN');
  await ok('setUserName clears a name', call(OWNER, 'setUserName', COST, ''), (r) => r.users.find((u) => u.email === COST).fullName === '');
  await ok('cleared names are not listed', call(NOSE, 'listPeopleNames'), (r) => !(COST in r));
}
/* ---------- project documents (PDR FM-RD-01 attachments) ---------- */
{
  const pdfB = pdf.toString('base64'), xlsxB = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('fake-xlsx'.repeat(20))]).toString('base64');
  await err('project doc upload forbidden for calc-only role', call(COST, 'uploadProjectDoc', p1.id, { file: 'x.pdf' }, pdfB), 'FORBIDDEN');
  await err('project doc unknown project', call(OWNER, 'uploadProjectDoc', 'nope', { file: 'x.pdf' }, pdfB), 'ไม่พบโครงการ');
  await err('project doc bad extension', call(OWNER, 'uploadProjectDoc', p1.id, { file: 'virus.exe' }, pdfB), 'รองรับไฟล์');
  await err('project doc content/extension mismatch', call(OWNER, 'uploadProjectDoc', p1.id, { file: 'x.pdf' }, Buffer.from('not a pdf at all').toString('base64')), 'ไม่ตรงกับนามสกุล');
  await err('project doc empty', call(OWNER, 'uploadProjectDoc', p1.id, { file: 'x.pdf' }, ''), 'ไม่มีข้อมูลไฟล์');
  const u1 = await ok('perfumer attaches the PDR pdf', call(NOSE, 'uploadProjectDoc', p1.id, { file: 'PDR/FM-RD-01 ONEST.pdf', kind: 'pdr' }, pdfB), (r) => r.files.length === 1 && r.files[0].kind === 'pdr' && r.files[0].by === NOSE && r.files[0].ext === 'pdf' && !/[\/]/.test(r.files[0].name));
  const u2 = await ok('owner attaches an excel', call(OWNER, 'uploadProjectDoc', p1.id, { file: 'brief.xlsx', kind: 'zzz' }, xlsxB), (r) => r.files.length === 2 && r.files[1].kind === 'pdr' && r.files[1].size > 0);
  await ok('getProject lists attachments for read-only roles', call(COST, 'getProject', p1.id), (r) => (r.project.data.pdrFiles || []).length === 2);
  await ok('download returns the same bytes', call(COST, 'getProjectDocFile', p1.id, u1.files[0].id), (r) => r.mime === 'application/pdf' && r.b64 === pdf.toString('base64'));
  await err('download needs R&D view permission', call(OUT, 'getProjectDocFile', p1.id, u1.files[0].id), 'FORBIDDEN');
  await err('download unknown file', call(OWNER, 'getProjectDocFile', p1.id, 'fnope'), 'ไม่พบไฟล์');
  const cur = (await call(OWNER, 'getProject', p1.id)).result.project;
  await ok('saveProject from a stale page keeps the attachments', call(OWNER, 'saveProject', { id: p1.id, customerCode: '281', owners: cur.owners, data: { note: 'stale', pdrFiles: [] } }), (r) => (r.data.pdrFiles || []).length === 2 && r.data.note === 'stale');
  await ok('saveProject cannot inject attachments into a new project', call(OWNER, 'saveProject', { customerCode: '281', title: 'inject', owners: { pc: OWNER, perfumer: [] }, data: { pdrFiles: [{ id: 'fx', name: 'x', ext: 'pdf' }] } }), (r) => !(r.data.pdrFiles || []).length);
  await err('a perfumer cannot delete someone else\'s file', call(NOSE, 'deleteProjectDoc', p1.id, u2.files[1].id), 'FORBIDDEN');
  await ok('uploader deletes own file', call(NOSE, 'deleteProjectDoc', p1.id, u1.files[0].id), (r) => r.files.length === 1 && r.files[0].id === u2.files[1].id);
  await err('deleted file is gone', call(OWNER, 'getProjectDocFile', p1.id, u1.files[0].id), 'ไม่พบไฟล์');
  await ok('admin deletes any file', call(OWNER, 'deleteProjectDoc', p1.id, u2.files[1].id), (r) => r.files.length === 0);
}
/* ---------- resilience: idle pool recycle + stuck database fails fast ---------- */
{
  const realNow = Date.now; Date.now = () => realNow() + 20000;
  await ok('after an idle spell the pool is recycled and requests still work', call(OWNER, 'bootstrap'), (r) => !!r.me);
  Date.now = realNow;
  const origGet = Deno.env.get; Deno.env.get = (k) => (k === 'DB_GUARD_MS' ? '400' : origGet(k));
  const realQuery = pg.query.bind(pg); let hung = 0;
  pg.query = (...a) => { hung++; return new Promise(() => {}); };
  const t0 = realNow(); const resp = await handler(new Request('https://x/functions/v1/api', { method: 'POST', body: JSON.stringify({ fn: 'bootstrap', args: [], session: await sess(OWNER) }) }));
  const dt = realNow() - t0; const body = await resp.text(); pg.query = realQuery; Deno.env.get = origGet;
  eq('stuck db → 503 RETRY text (not JSON) in under 3 s', [resp.status, /^RETRY/.test(body), dt < 3000, hung > 0], [503, true, true, true]);
  await ok('next request after a stuck one works', call(OWNER, 'bootstrap'), (r) => !!r.me);
  const g = await (await handler(new Request('https://x/functions/v1/api'))).json(); eq('health still ok', g.ok, true);
}
report();
process.exit(fail ? 1 : 0);
