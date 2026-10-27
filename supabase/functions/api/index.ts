/**
 * แผนกวิจัยและพัฒนา · Scent & Sense — Supabase Edge Function "api"
 * พอร์ตจาก Google Apps Script (Code.gs): หน้าเว็บเรียก POST {fn, args, idToken} เหมือนเดิมทุกอย่าง
 * - ตรวจ Google ID token กับ Google ทุกครั้ง (อีเมลต้องเป็นโดเมนบริษัท) แล้วเรียกฟังก์ชันในตาราง API ด้านล่าง
 * - ข้อมูลอยู่ใน schema "costing" (RLS เปิด ไม่มี policy) เข้าถึงผ่านฟังก์ชันนี้ด้วยสิทธิ์ของเซิร์ฟเวอร์เท่านั้น
 * - ไฟล์ MSDS เก็บใน Storage bucket "rm-docs" (private)
 */
import postgres from "npm:postgres@3.4.5";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";
import { TF_FORMS } from "./tf_forms.ts";

const GOOGLE_CLIENT_ID = "715998679704-s1u0frj5cj2vhf4el67mj54sarbu5iq7.apps.googleusercontent.com";
const DOMAINS = ["scentandsense.co.th", "scentandsense.co"];
const PERM_KEYS = ["calc", "export", "viewDb", "editPrices", "manageUsers", "perfumer", "projects", "pd", "ra", "research", "rdView"];
const BUILTIN_SOURCE = { file: "PRODUCT RM - Summary RM.pdf", updated: "12/10/2026 11:41:18" };
const DEFAULT_PUBLIC_URL = "https://rd.scentandsense.co.th/";

const PG_OPTS = {
  max: 4, prepare: false, idle_timeout: 20, connect_timeout: 15, transform: { undefined: null },
  types: {
    numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => parseFloat(x) },
    int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  },
};
const mkSql = () => postgres(Deno.env.get("SUPABASE_DB_URL")!, PG_OPTS);
let sql = mkSql(), lastDbUse = Date.now(), inflight = 0;
/** Edge isolates are frozen between requests: a pooled socket can die silently and the next query then waits for the 150 s gateway timeout.
 *  After a quiet spell (> 8 s) start from a fresh pool; the old one is closed in the background. */
function freshPool(why: string) { const old = sql as Any; sql = mkSql(); try { const p = old.end && old.end({ timeout: 0 }); if (p && p.catch) p.catch(() => {}); } catch (_e) { /* ignore */ } console.log("db pool recycled: " + why); }
function touchDb() { const now = Date.now(); if (inflight === 0 && now - lastDbUse > 8000) freshPool("idle " + Math.round((now - lastDbUse) / 1000) + "s"); lastDbUse = now; }
/** Safety net: a request still stuck after `ms` recycles the pool and gives up (the web client retries a non-JSON 503 by itself). */
class DbStuck extends Error { constructor() { super("DB_STUCK"); } }
async function guard<T>(p: Promise<T>, ms = 40000): Promise<T> {
  const cap = Number(Deno.env.get("DB_GUARD_MS")); if (cap > 0) ms = Math.min(ms, cap);   /* tests shorten the safety net */
  let t: number | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new DbStuck()), ms) as unknown as number; })]); }
  finally { if (t !== undefined) clearTimeout(t); lastDbUse = Date.now(); }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
type Db = any;
/** via: "session" = รหัสผ่าน (ปกติ), "google" = ยืนยันตัวตนด้วย Google เพื่อตั้งรหัสผ่าน, "none" = ก่อนเข้าสู่ระบบ · sid = แฮชของโทเคนเซสชัน */
type Ctx = { email: string; db: Db; via?: string; sid?: string };
// deno-lint-ignore no-explicit-any
type Any = any;

/* ===== ตัวช่วย ===== */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : "");
const str = (v: unknown, n: number) => String(v === undefined || v === null ? "" : v).trim().slice(0, n);
const isTrue = (v: unknown) => v === true || String(v).toUpperCase() === "TRUE";
const numOrNull = (v: unknown) => { const n = Number(v); return v === "" || v === null || v === undefined || isNaN(n) ? null : n; };
const splitList = (v: unknown) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const uuid = (n: number) => crypto.randomUUID().replace(/-/g, "").slice(0, n);
function bkk(d: Date, withSec = false) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour === "24" ? "00" : p.hour}:${p.minute}${withSec ? ":" + p.second : ""}`;
}
const bkkYear = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric" }).format(d);

async function getSetting(db: Db, k: string): Promise<string | null> {
  const r = await db`select value from costing.settings where key = ${k}`;
  return r.length ? String(r[0].value) : null;
}
async function setSetting(db: Db, k: string, v: unknown) {
  await db`insert into costing.settings (key, value) values (${k}, ${String(v)}) on conflict (key) do update set value = excluded.value`;
}
async function delSetting(db: Db, k: string) { await db`delete from costing.settings where key = ${k}`; }
async function log(db: Db, email: string, action: string, detail = "") {
  try { await db`insert into costing.log (email, action, detail) values (${email}, ${action}, ${String(detail).slice(0, 2000)})`; } catch (_e) { /* ไม่ให้ log ล้มทั้งคำขอ */ }
}
/** ล็อกเดียวทั้งระบบ (แทน LockService) — เขียนข้อมูลทีละคำขอ */
async function locked<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx: Db) => {
    await tx`select pg_advisory_xact_lock(7001)`;
    return await fn({ email: ctx.email, db: tx, via: ctx.via, sid: ctx.sid });
  }) as T;
}
function normEmail(e: unknown) {
  const email = String(e || "").trim().toLowerCase();
  const m = email.match(/^[^@\s]+@([^@\s]+)$/);
  if (!m || DOMAINS.indexOf(m[1]) < 0) throw new Error("ใช้ได้เฉพาะอีเมล @" + DOMAINS.join(" หรือ @"));
  return email;
}
async function appUrl(db: Db) { return (await getSetting(db, "publicUrl")) || DEFAULT_PUBLIC_URL; }
/** ส่งอีเมลผ่าน Resend ถ้าแอดมินตั้งค่า resendKey ไว้ (ไม่มีก็ข้าม ไม่ให้คำขอล้ม) */
async function sendMail(db: Db, to: string, subject: string, text: string) {
  try {
    const key = await getSetting(db, "resendKey"); if (!key || !to) return;
    const from = (await getSetting(db, "mailFrom")) || "Scent & Sense R&D <noreply@scentandsense.co.th>";
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }), signal: AbortSignal.timeout(8000) });
  } catch (_e) { /* ignore */ }
}

/* ===== ยืนยันตัวตน (Google ID token) ===== */
const tokCache = new Map<string, { email: string; exp: number }>();
async function verifyIdToken(token: unknown): Promise<string> {
  if (!token || typeof token !== "string") throw new Error("AUTH_REQUIRED");
  const hit = tokCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.email;
  const res = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(10000) });
  if (res.status !== 200) throw new Error("AUTH_EXPIRED");
  const p = await res.json();
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== GOOGLE_CLIENT_ID) throw new Error("AUTH_INVALID");
  if (["accounts.google.com", "https://accounts.google.com"].indexOf(p.iss) < 0) throw new Error("AUTH_INVALID");
  if (Number(p.exp) <= now) throw new Error("AUTH_EXPIRED");
  if (String(p.email_verified) !== "true") throw new Error("AUTH_INVALID");
  const email = String(p.email || "").toLowerCase();
  if (DOMAINS.indexOf(email.split("@")[1]) < 0) throw new Error("DOMAIN:" + email);
  tokCache.set(token, { email, exp: Date.now() + Math.max(1, Math.min(300, Number(p.exp) - now - 30)) * 1000 });
  if (tokCache.size > 500) tokCache.clear();
  return email;
}

/* ===== เข้าสู่ระบบด้วยรหัสผ่าน =====
   - รหัสผ่านเก็บเป็น PBKDF2-SHA256 (210,000 รอบ, salt 16 ไบต์) ไม่เก็บตัวรหัส
   - ตั้ง/รีเซ็ตรหัสครั้งแรก ต้องยืนยันตัวตนด้วย Google (อีเมลโดเมนบริษัท) · เปลี่ยนรหัสขณะเข้าระบบอยู่ ต้องใส่รหัสเดิม
   - ใส่ผิด 5 ครั้งติดกัน ล็อก 15 นาที · เซสชัน 12 ชั่วโมง (จดจำ 30 วัน) เก็บแฮชของโทเคนในตาราง sessions */
const PW_ITER = 210000, PW_FAIL_MAX = 5, PW_LOCK_MIN = 15, SESSION_HOURS = 12, SESSION_REMEMBER_DAYS = 30;
const te = new TextEncoder();
const b64u = (u8: Uint8Array) => encodeBase64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function pbkdf2(pw: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(pw: string) { const salt = crypto.getRandomValues(new Uint8Array(16)); return `pbkdf2$${PW_ITER}$${encodeBase64(salt)}$${encodeBase64(await pbkdf2(pw, salt, PW_ITER))}`; }
async function checkPassword(pw: string, stored: string) {
  const p = String(stored || "").split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") { await pbkdf2(pw, new Uint8Array(16), PW_ITER); return false; }   /* ใช้เวลาเท่ากันแม้ไม่มีบัญชี */
  const want = decodeBase64(p[3]), got = await pbkdf2(pw, decodeBase64(p[2]), Number(p[1]) || PW_ITER);
  let diff = want.length ^ got.length; for (let i = 0; i < Math.min(want.length, got.length); i++) diff |= want[i] ^ got[i];
  return diff === 0;
}
function pwPolicy(pw: unknown, email: string) {
  const s = String(pw || "");
  if (s.length < 8) throw new Error("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
  if (s.length > 128) throw new Error("รหัสผ่านยาวเกินไป");
  if (!/[A-Za-z฀-๿]/.test(s) || !/[0-9]/.test(s)) throw new Error("รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข");
  if (s.toLowerCase().includes(email.split("@")[0].toLowerCase())) throw new Error("รหัสผ่านต้องไม่มีชื่ออีเมลอยู่ในนั้น");
  return s;
}
const sha256hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));
async function newSession(db: Db, email: string, via: string, remember: boolean) {
  const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + (remember ? SESSION_REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000));
  await db`insert into costing.sessions (id, email, created_at, expires_at, last_seen, via) values (${await sha256hex(token)}, ${email}, now(), ${expires}, now(), ${via})`;
  await db`delete from costing.sessions where expires_at < now()`;   /* เก็บกวาดเซสชันหมดอายุ */
  return { session: token, expiresAt: expires.toISOString(), email };
}
const sesCache = new Map<string, { email: string; exp: number }>();
async function sessionEmail(token: unknown): Promise<{ email: string; sid: string }> {
  if (!token || typeof token !== "string" || token.length < 20 || token.length > 100) throw new Error("AUTH_EXPIRED");
  const sid = await sha256hex(token), hit = sesCache.get(sid);
  if (hit && hit.exp > Date.now()) return { email: hit.email, sid };
  const r = (await sql`select email, expires_at, last_seen from costing.sessions where id = ${sid}`)[0];
  if (!r || new Date(r.expires_at).getTime() <= Date.now()) throw new Error("AUTH_EXPIRED");
  if (!r.last_seen || Date.now() - new Date(r.last_seen).getTime() > 600000) await sql`update costing.sessions set last_seen = now() where id = ${sid}`;
  sesCache.set(sid, { email: String(r.email), exp: Math.min(Date.now() + 60000, new Date(r.expires_at).getTime()) });
  if (sesCache.size > 1000) sesCache.clear();
  return { email: String(r.email), sid };
}
/** เข้าสู่ระบบด้วยอีเมล + รหัสผ่าน (เรียกได้โดยไม่ต้องมีเซสชัน) */
async function pwLogin(ctx: Ctx, emailIn: string, password: string, remember: boolean) {
  const bad = "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  let email = ""; try { email = normEmail(emailIn); } catch (_e) { await checkPassword(String(password || ""), ""); throw new Error(bad); }
  /* ความผิดพลาดคืนค่าออกมาแทนการ throw ในทรานแซกชัน เพื่อให้ตัวนับครั้งที่ผิดถูกบันทึกจริง (throw = rollback) */
  const r: Any = await locked(ctx, async (c) => {
    const db = c.db, cr = (await db`select * from costing.credentials where email = ${email}`)[0];
    if (cr && cr.locked_until && new Date(cr.locked_until).getTime() > Date.now()) {
      return { err: `ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว ลองใหม่หลัง ${bkk(new Date(cr.locked_until)).slice(11)} น. หรือตั้งรหัสใหม่ด้วย Google` };
    }
    const ok = await checkPassword(String(password || ""), cr ? String(cr.hash) : "");
    if (!cr) return { err: bad + " (ถ้ายังไม่เคยตั้งรหัสผ่าน กด \"ตั้งรหัสผ่านครั้งแรก\")" };
    if (!ok) {
      const failed = Number(cr.failed || 0) + 1, lock = failed >= PW_FAIL_MAX;
      await db`update costing.credentials set failed = ${lock ? 0 : failed}, locked_until = ${lock ? new Date(Date.now() + PW_LOCK_MIN * 60000) : null} where email = ${email}`;
      await log(db, email, "pwLoginFail", lock ? "ล็อก " + PW_LOCK_MIN + " นาที" : "ครั้งที่ " + failed);
      return { err: lock ? `ใส่รหัสผิด ${PW_FAIL_MAX} ครั้ง บัญชีถูกล็อก ${PW_LOCK_MIN} นาที` : bad };
    }
    await db`update costing.credentials set failed = 0, locked_until = null where email = ${email}`;
    await log(db, email, "pwLogin", remember ? "จดจำ " + SESSION_REMEMBER_DAYS + " วัน" : "");
    return await newSession(db, email, "password", !!remember);
  });
  if (r.err) throw new Error(r.err);
  return r;
}
/** ตั้ง/เปลี่ยนรหัสผ่านของตัวเอง: ผ่าน Google (ครั้งแรก / ลืมรหัส) ไม่ต้องใช้รหัสเดิม · ผ่านเซสชันต้องใส่รหัสเดิม · ยกเลิกเซสชันเดิมทั้งหมดแล้วออกเซสชันใหม่ */
async function setMyPassword(ctx: Ctx, newPw: string, oldPw: string, remember: boolean) {
  return await locked(ctx, async (c) => {
    const db = c.db, email = normEmail(c.email);
    const pw = pwPolicy(newPw, email);
    const cr = (await db`select * from costing.credentials where email = ${email}`)[0];
    if (c.via !== "google") {
      if (!cr || !(await checkPassword(String(oldPw || ""), String(cr.hash)))) throw new Error("รหัสผ่านเดิมไม่ถูกต้อง");
      if (oldPw === pw) throw new Error("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม");
    }
    const h = await hashPassword(pw);
    await db`insert into costing.credentials (email, hash, set_at, set_via, failed, locked_until) values (${email}, ${h}, now(), ${c.via || ""}, 0, null)
      on conflict (email) do update set hash = excluded.hash, set_at = excluded.set_at, set_via = excluded.set_via, failed = 0, locked_until = null`;
    await db`delete from costing.sessions where email = ${email}`; sesCache.clear();
    await log(db, email, "setMyPassword", c.via === "google" ? (cr ? "ตั้งใหม่ด้วย Google (ลืมรหัส)" : "ตั้งครั้งแรกด้วย Google") : "เปลี่ยนรหัส");
    return await newSession(db, email, "password", !!remember);
  });
}
async function pwLogout(ctx: Ctx) {
  if (ctx.sid) { await ctx.db`delete from costing.sessions where id = ${ctx.sid}`; sesCache.delete(ctx.sid); }
  return { ok: true };
}
/** ผู้ดูแลรีเซ็ตรหัสผ่านของผู้ใช้: ลบรหัสและออกจากระบบทุกเครื่อง ผู้ใช้ต้องตั้งใหม่ด้วย Google */
async function resetUserPassword(ctx: Ctx, email: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    email = normEmail(email);
    if (email === m.owner && m.email !== m.owner) throw new Error("รีเซ็ตรหัสของเจ้าของระบบไม่ได้");
    await db`delete from costing.credentials where email = ${email}`;
    await db`delete from costing.sessions where email = ${email}`; sesCache.clear();
    await log(db, m.email, "resetUserPassword", email);
    return await adminData_(c, m);
  });
}

/* ===== บทบาทและตัวตน ===== */
async function readRoles(db: Db) {
  const rs = await db`select id, name, perms, system, ord from costing.roles order by ord, id`;
  const roles: Record<string, Any> = {}, order: string[] = [];
  rs.forEach((r: Any) => { roles[r.id] = { name: r.name, perms: r.perms || {}, system: !!r.system }; order.push(r.id); });
  return { roles, order };
}
const allPerms = () => Object.fromEntries(PERM_KEYS.map((k) => [k, true]));
async function me(ctx: Ctx) {
  const email = ctx.email.toLowerCase().trim();
  if (!email) throw new Error("NO_IDENTITY");
  if (DOMAINS.indexOf(email.split("@")[1]) < 0) throw new Error("DOMAIN:" + email);
  const db = ctx.db;
  const owner = ((await getSetting(db, "owner")) || "").toLowerCase();
  const rr = await readRoles(db);
  const ur = await db`select role, active from costing.users where email = ${email}`;
  const autoJoin = (await getSetting(db, "autoJoin")) === "true", defRole = (await getSetting(db, "defaultRole")) || "costing";
  let role: string | null = null, active = true, auto = false;
  if (email === owner) role = "admin";
  else if (ur.length) { role = String(ur[0].role); active = ur[0].active !== false; }
  else if (autoJoin && rr.roles[defRole]) { role = defRole; auto = true; }
  const isOwner = email === owner;
  const perms = isOwner || role === "admin" ? allPerms() : (role && rr.roles[role] ? rr.roles[role].perms : {});
  return { email, isOwner, role, roleName: role && rr.roles[role] ? rr.roles[role].name : "", active, auto, perms: perms as Record<string, boolean>,
    roles: rr.roles, order: rr.order, autoJoin, defRole, owner };
}
type Me = Awaited<ReturnType<typeof me>>;
const hasPerm = (m: Me, p: string) => !!(m.isOwner || m.role === "admin" || m.perms[p]);
const canCost = (m: Me) => hasPerm(m, "calc") || hasPerm(m, "editPrices") || hasPerm(m, "viewDb");
const canRecipe = (m: Me) => hasPerm(m, "calc") || hasPerm(m, "perfumer");
/** ตัดราคาวัตถุดิบออกจากสูตร/เบสผลิตภัณฑ์ก่อนส่งให้ผู้ที่ไม่มีสิทธิ์เห็นต้นทุน */
const maskPd = (m: Me, o: Any) => canCost(m) || !o ? o : { ...o, fragrancePrice: null, lines: (o.lines || []).map((l: Any) => ({ ...l, price: null, override: null })) };
const maskScent = (m: Me, o: Any) => canCost(m) || !o ? o : { ...o, data: { ...(o.data || {}), costKg: undefined, cost: undefined } };
const isAdmin = (m: Me) => !!m.role && m.active && (m.isOwner || m.role === "admin");
async function need(ctx: Ctx, perm: string) {
  const m = await me(ctx);
  if (!m.role || !m.active || !hasPerm(m, perm)) throw new Error("FORBIDDEN");
  return m;
}
async function needAny(ctx: Ctx, perms: string[]) {
  const m = await me(ctx);
  if (!m.role || !m.active || !perms.some((p) => hasPerm(m, p))) throw new Error("FORBIDDEN");
  return m;
}
async function needAdmin(ctx: Ctx) { const m = await me(ctx); if (!isAdmin(m)) throw new Error("FORBIDDEN"); return m; }
async function activeMe(ctx: Ctx) { const m = await me(ctx); if (!m.role || !m.active) throw new Error("FORBIDDEN"); return m; }

/* ===== เรียกจากหน้าเว็บ: ทุกคน ===== */
async function newComplaints(db: Db) {
  const r = await db`select count(*)::int as n from costing.complaints where status = 'new' or status not in ('new','progress','done','rejected')`;
  return r[0].n as number;
}
async function bootstrap(ctx: Ctx) {
  const m = await me(ctx), db = ctx.db;
  await db`insert into costing.visitors (email, first_seen, last_seen) values (${m.email}, now(), now()) on conflict (email) do update set last_seen = now()`;
  const ok = !!m.role && m.active;
  return {
    me: { email: m.email, isOwner: m.isOwner, role: m.role, roleName: m.roleName, active: m.active, auto: m.auto, perms: ok ? m.perms : {} },
    roles: m.roles, order: m.order, access: { autoJoin: m.autoJoin, defaultRole: m.defRole },
    prices: ok && (m.perms.calc || m.perms.viewDb || m.isOwner) ? await readPrices(db) : null,
    appUrl: await appUrl(db),
    requested: (await db`select 1 from costing.requests where email = ${m.email}`).length > 0,
    complaintsNew: ok && isAdmin(m) ? await newComplaints(db) : 0,
  };
}
async function requestAccess(ctx: Ctx) {
  return await locked(ctx, async (c) => {
    const m = await me(c);
    if (m.role && m.active) return "ALREADY";
    if (!m.active) throw new Error("บัญชีนี้ถูกระงับ ติดต่อผู้ดูแลระบบ");
    await c.db`insert into costing.requests (email, at) values (${m.email}, now()) on conflict (email) do update set at = now()`;
    await log(c.db, m.email, "requestAccess");
    await sendMail(c.db, m.owner, "[แผนกวิจัยและพัฒนา] คำขอสิทธิ์ใช้งานจาก " + m.email,
      m.email + ' ขอสิทธิ์ใช้งานระบบของแผนกวิจัยและพัฒนา\n\nอนุมัติได้ที่หน้า "จัดการผู้ใช้และบทบาท":\n' + await appUrl(c.db));
    return "OK";
  });
}

/* ===== ฐานราคา ===== */
async function readPrices(db: Db) {
  const rows = await db`select code, name, price, status, note, updated_at, updated_by from costing.prices order by id`;
  const entries = rows.map((r: Any) => ({ c: String(r.code), n: String(r.name), p: r.price === null ? null : Number(r.price), s: String(r.status || ""), o: String(r.note || ""), u: iso(r.updated_at), b: String(r.updated_by || "") }));
  return { entries, custom: (await getSetting(db, "pricesCustom")) === "true",
    src: { file: (await getSetting(db, "pricesFile")) || BUILTIN_SOURCE.file, updated: (await getSetting(db, "pricesUpdated")) || "", by: (await getSetting(db, "pricesBy")) || "" } };
}
const OK_STATUS: Record<string, number> = { ok: 1, recheck: 1, cancel: 1, rd: 1, none: 1 };
async function savePrices(ctx: Ctx, body: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    const list = (body && body.entries) || [];
    if (!list.length || list.length > 5000) throw new Error("ไฟล์ราคาต้องมี 1–5,000 รายการ");
    const rows = list.map((e: Any) => { const n = Number(e.p);
      return { code: String(e.c || "").toUpperCase().slice(0, 40), name: String(e.n || "").slice(0, 300), price: e.p === null || isNaN(n) ? null : n,
        status: OK_STATUS[e.s] ? e.s : "none", note: String(e.o || "").slice(0, 500) }; });
    await db`delete from costing.prices`;
    for (let i = 0; i < rows.length; i += 1000) await db`insert into costing.prices ${db(rows.slice(i, i + 1000))}`;
    await setSetting(db, "pricesFile", String(body.file || "ไฟล์ที่อัปเดต").slice(0, 200));
    await setSetting(db, "pricesUpdated", bkk(new Date()));
    await setSetting(db, "pricesBy", m.email); await setSetting(db, "pricesCustom", "true");
    await log(db, m.email, "savePrices", body.file + " · " + list.length + " รายการ");
    return await readPrices(db);
  });
}
/** แก้ราคาทีละรายการ (หรือเพิ่มรหัสใหม่) — เจ้าของระบบ แอดมิน และจัดซื้อ · ทุกการเปลี่ยนแปลงบันทึกใน Log */
async function updatePrices(ctx: Ctx, items: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    if (!Array.isArray(items) || !items.length || items.length > 300) throw new Error("บันทึกได้ครั้งละ 1–300 รายการ");
    const cur: Record<string, Any> = {};
    (await db`select id, code, name, price, status, note from costing.prices order by id`).forEach((r: Any) => { const k = String(r.code).toUpperCase(); if (!cur[k]) cur[k] = r; });
    const now = new Date(), notes: string[] = [];
    let changed = 0, added = 0;
    for (const it of items) {
      const code = String((it && it.c) || "").toUpperCase().trim();
      if (!/^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/.test(code)) throw new Error("รหัส RM ไม่ถูกต้อง: " + code.slice(0, 30));
      let price: number | null = it.p === null || it.p === undefined || it.p === "" ? null : Number(it.p);
      if (price !== null && (isNaN(price) || price < 0 || price > 10000000)) throw new Error("ราคาไม่ถูกต้อง: " + code);
      if (price === 0) price = null;
      let status = OK_STATUS[it.s] ? it.s : "none";
      if (price !== null) status = "ok"; else if (status === "ok") status = "none";
      const note = String(it.o || "").slice(0, 500), ex = cur[code];
      const name = ex ? String(ex.name) : String(it.n || "").trim().slice(0, 300);
      if (!ex && !name) throw new Error("รหัสใหม่ต้องมีชื่อวัตถุดิบ: " + code);
      if (ex) {
        const same = (ex.price === null ? null : Number(ex.price)) === price && String(ex.status) === status && String(ex.note || "") === note;
        if (same) continue;
        await db`update costing.prices set price = ${price}, status = ${status}, note = ${note}, updated_at = ${now}, updated_by = ${m.email} where id = ${ex.id}`;
        notes.push(code + ": " + (ex.price === null ? "-" : ex.price) + " → " + (price === null ? "-" : price) + (String(ex.status) !== status ? " [" + ex.status + "→" + status + "]" : ""));
      } else {
        const ins = await db`insert into costing.prices (code, name, price, status, note, updated_at, updated_by) values (${code}, ${name}, ${price}, ${status}, ${note}, ${now}, ${m.email}) returning id`;
        cur[code] = { id: ins[0].id, code, name, price, status, note }; added++;
        notes.push(code + ": เพิ่มใหม่ " + (price === null ? "-" : price));
      }
      changed++;
    }
    const stamp = bkk(now);
    if (changed) {
      await setSetting(db, "pricesUpdated", stamp); await setSetting(db, "pricesBy", m.email); await setSetting(db, "pricesCustom", "true");
      await log(db, m.email, "updatePrices", (changed + " รายการ · " + notes.join("; ")).slice(0, 2000));
    }
    return { changed, added, updated: stamp, by: m.email, at: now.toISOString() };
  });
}
async function resetPrices(ctx: Ctx) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    const b = await db`select count(*)::int as n from costing.prices_builtin`;
    if (!b[0].n) throw new Error("ไม่มีฐานราคาตั้งต้นในระบบ");
    await db`delete from costing.prices`;
    await db`insert into costing.prices (code, name, price, status, note) select code, name, price, status, note from costing.prices_builtin order by ord`;
    await setSetting(db, "pricesFile", BUILTIN_SOURCE.file); await setSetting(db, "pricesUpdated", BUILTIN_SOURCE.updated);
    await setSetting(db, "pricesBy", ""); await setSetting(db, "pricesCustom", "false");
    await log(db, m.email, "resetPrices", BUILTIN_SOURCE.file);
    return await readPrices(db);
  });
}

/* ===== ส่งออก Excel: เก็บใน Storage แล้วคืนลิงก์ดาวน์โหลด (สำรองเมื่อดาวน์โหลดตรงไม่ได้) ===== */
async function saveExport(ctx: Ctx, filename: string, b64: string) {
  const m = await need(ctx, "export");
  const name = String(filename || "export.xlsx").replace(/[\\\/:*?"<>|]/g, " ").slice(0, 120);
  const path = `${m.email}/${Date.now()}-${uuid(6)}.xlsx`;
  const up = await sb.storage.from("exports").upload(path, decodeBase64(b64), { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  if (up.error) throw new Error("บันทึกไฟล์ไม่สำเร็จ: " + up.error.message);
  const s = await sb.storage.from("exports").createSignedUrl(path, 7 * 86400, { download: name });
  if (s.error || !s.data) throw new Error("สร้างลิงก์ไม่สำเร็จ");
  await log(ctx.db, m.email, "saveExport", name);
  return s.data.signedUrl;
}

/* ===== ผู้ดูแลระบบ ===== */
async function adminData_(ctx: Ctx, m: Me) {
  const db = ctx.db, rr = await readRoles(db);
  const users = await db`select email, role, active, added_by, added_at, full_name from costing.users order by added_at, email`;
  const reqs = await db`select email, at from costing.requests order by at`;
  const vis = await db`select email, first_seen, last_seen from costing.visitors order by first_seen`;
  const pw = new Set((await db`select email from costing.credentials`).map((r: Any) => String(r.email).toLowerCase()));
  return { owner: m.owner, me: m.email, withPassword: [...pw],
    users: users.map((r: Any) => ({ email: String(r.email).toLowerCase(), role: String(r.role), active: r.active !== false, addedBy: String(r.added_by || ""), addedAt: iso(r.added_at), fullName: String(r.full_name || ""), hasPassword: pw.has(String(r.email).toLowerCase()) })),
    requests: reqs.map((r: Any) => ({ email: String(r.email).toLowerCase(), at: iso(r.at) })),
    visitors: vis.map((r: Any) => ({ email: String(r.email).toLowerCase(), firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen) })),
    roles: rr.roles, order: rr.order,
    access: { autoJoin: (await getSetting(db, "autoJoin")) === "true", defaultRole: (await getSetting(db, "defaultRole")) || "costing" } };
}
/** ชื่อ-นามสกุลจริงของผู้ใช้ (ใช้พิมพ์ในช่องผู้ลงนามของเอกสาร เช่น FM-RD-03) */
async function setUserName(ctx: Ctx, email: string, name: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db; email = str(email, 200).toLowerCase(); name = str(name, 120);
    if (!(await db`update costing.users set full_name = ${name} where email = ${email} returning email`).length) throw new Error("ไม่พบผู้ใช้นี้");
    await log(db, m.email, "setUserName", email + " · " + name);
    return await adminData_(c, m);
  });
}
/** อีเมล → ชื่อจริง ของผู้ใช้ที่ตั้งชื่อไว้ · คนที่ดูข้อมูล R&D ได้ใช้แสดงชื่อในเอกสาร */
async function listPeopleNames(ctx: Ctx) {
  await needAny(ctx, RD_VIEW);
  const out: Record<string, string> = {};
  (await ctx.db`select email, full_name from costing.users where active is not false and full_name <> ''`).forEach((r: Any) => { out[String(r.email).toLowerCase()] = String(r.full_name); });
  return out;
}
async function adminData(ctx: Ctx) { return await adminData_(ctx, await need(ctx, "manageUsers")); }
async function setUser(ctx: Ctx, email: string, role: string, active: boolean, notify: boolean) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    email = normEmail(email);
    if (email === m.owner) throw new Error("เจ้าของระบบเป็นผู้ดูแลระบบเสมอ แก้ไขไม่ได้");
    if (email === m.email) throw new Error("แก้ไขสิทธิ์ของตัวเองไม่ได้");
    const rr = await readRoles(db);
    if (!rr.roles[role]) throw new Error("ไม่พบบทบาทนี้");
    await db`insert into costing.users (email, role, active, added_by, added_at) values (${email}, ${role}, ${active !== false}, ${m.email}, now())
      on conflict (email) do update set role = excluded.role, active = excluded.active`;
    await db`delete from costing.requests where email = ${email}`;
    await log(db, m.email, "setUser", email + " → " + role + (active === false ? " (ระงับ)" : ""));
    if (notify && active !== false) await sendMail(db, email, "[แผนกวิจัยและพัฒนา] คุณได้รับสิทธิ์ใช้งานแล้ว",
      'คุณได้รับสิทธิ์ใช้งานระบบของแผนกวิจัยและพัฒนา ในบทบาท "' + rr.roles[role].name + '"\n\nเปิดลิงก์แล้วกด "ตั้งรหัสผ่านครั้งแรก" (ยืนยันตัวตนด้วยบัญชี Google ของบริษัท) จากนั้นเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน:\n' + await appUrl(db));
    return await adminData_(c, m);
  });
}
async function removeUser(ctx: Ctx, email: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers");
    email = normEmail(email);
    if (email === m.owner || email === m.email) throw new Error("ลบบัญชีนี้ไม่ได้");
    await c.db`delete from costing.users where email = ${email}`;
    await log(c.db, m.email, "removeUser", email);
    return await adminData_(c, m);
  });
}
async function declineRequest(ctx: Ctx, email: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers");
    await c.db`delete from costing.requests where email = ${String(email || "").toLowerCase()}`;
    await log(c.db, m.email, "declineRequest", String(email));
    return await adminData_(c, m);
  });
}
async function saveAccess(ctx: Ctx, autoJoin: boolean, defaultRole: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    if (!(await readRoles(db)).roles[defaultRole]) throw new Error("ไม่พบบทบาทนี้");
    await setSetting(db, "autoJoin", autoJoin ? "true" : "false"); await setSetting(db, "defaultRole", defaultRole);
    await log(db, m.email, "saveAccess", (autoJoin ? "เปิด" : "ปิด") + " · " + defaultRole);
    return await adminData_(c, m);
  });
}
const cleanPerms = (p: Any) => { const o: Record<string, boolean> = {}; PERM_KEYS.forEach((k) => { if (p && p[k]) o[k] = true; }); return o; };
async function createRole(ctx: Ctx, name: string, perms: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    name = String(name || "").trim().slice(0, 40);
    if (!name) throw new Error("ใส่ชื่อบทบาท");
    const mx = await db`select coalesce(max(ord), 0)::int as n from costing.roles`;
    await db`insert into costing.roles (id, name, perms, system, ord) values (${"r" + Date.now().toString(36)}, ${name}, ${db.json(cleanPerms(perms))}, false, ${mx[0].n + 1})`;
    await log(db, m.email, "createRole", name);
    return await adminData_(c, m);
  });
}
async function updateRole(ctx: Ctx, id: string, patch: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    const r = await db`select id, name, perms, system from costing.roles where id = ${String(id)}`;
    if (!r.length) throw new Error("ไม่พบบทบาทนี้");
    if (r[0].system) throw new Error("บทบาทหลักแก้ไขไม่ได้");
    const perms = { ...(r[0].perms || {}) };
    if (patch && patch.perms) Object.keys(patch.perms).forEach((k) => { if (PERM_KEYS.indexOf(k) >= 0) perms[k] = !!patch.perms[k]; });
    const name = patch && patch.name ? String(patch.name).trim().slice(0, 40) : r[0].name;
    await db`update costing.roles set name = ${name}, perms = ${db.json(cleanPerms(perms))} where id = ${String(id)}`;
    await log(db, m.email, "updateRole", id + " " + JSON.stringify(patch));
    return await adminData_(c, m);
  });
}
async function deleteRole(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    const r = await db`select id, system from costing.roles where id = ${String(id)}`;
    if (!r.length) throw new Error("ไม่พบบทบาทนี้");
    if (r[0].system) throw new Error("บทบาทหลักลบไม่ได้");
    if ((await db`select 1 from costing.users where role = ${String(id)} limit 1`).length) throw new Error("ยังมีผู้ใช้ในบทบาทนี้ ย้ายผู้ใช้ออกก่อน");
    if ((await getSetting(db, "defaultRole")) === String(id)) throw new Error("บทบาทนี้เป็นบทบาทเริ่มต้น เปลี่ยนบทบาทเริ่มต้นก่อน");
    await db`delete from costing.roles where id = ${String(id)}`;
    await log(db, m.email, "deleteRole", String(id));
    return await adminData_(c, m);
  });
}

/* ===== สูตรของผู้ใช้ ===== */
const FORMULA_MAX = 300, FORMULA_CELL_MAX = 45000;
const formulaOut = (r: Any) => ({ id: String(r.id), owner: String(r.owner).toLowerCase(), name: String(r.name), updatedAt: iso(r.updated_at), data: String(r.data) });
async function loadMyFormulas(ctx: Ctx) {
  const m = await need(ctx, "calc");
  return (await ctx.db`select id, owner, name, updated_at, data from costing.formulas where owner = ${m.email} order by updated_at, id`).map(formulaOut);
}
async function saveMyFormulas(ctx: Ctx, items: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "calc"), db = c.db;
    if (!Array.isArray(items) || items.length > FORMULA_MAX) throw new Error("บันทึกได้ไม่เกิน " + FORMULA_MAX + " สูตร");
    const keep: Record<string, { name: string; data: string }> = {};
    items.forEach((it: Any) => {
      const id = String((it && it.id) || "");
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new Error("รหัสสูตรไม่ถูกต้อง");
      const data = String((it && it.data) || ""), name = String((it && it.name) || "สูตร").slice(0, 120);
      if (data.length > FORMULA_CELL_MAX) throw new Error('สูตร "' + name.slice(0, 40) + '" ใหญ่เกินไป (ลดจำนวนรายการ)');
      try { JSON.parse(data); } catch (_e) { throw new Error("ข้อมูลสูตรไม่ถูกต้อง"); }
      keep[id] = { name, data };
    });
    const mine = await db`select id, name, data from costing.formulas where owner = ${m.email}`;
    const cur: Record<string, Any> = {}; mine.forEach((r: Any) => { cur[String(r.id)] = r; });
    const gone = mine.filter((r: Any) => !keep[String(r.id)]).map((r: Any) => String(r.id));
    if (gone.length) await db`delete from costing.formulas where owner = ${m.email} and id in ${db(gone)}`;
    const now = new Date(); let changed = 0;
    for (const id of Object.keys(keep)) {
      const ex = cur[id], k = keep[id];
      if (ex && String(ex.data) === k.data && String(ex.name) === k.name) continue;
      await db`insert into costing.formulas (id, owner, name, updated_at, data) values (${id}, ${m.email}, ${k.name}, ${now}, ${k.data})
        on conflict (owner, id) do update set name = excluded.name, updated_at = excluded.updated_at, data = excluded.data`;
      changed++;
    }
    return { saved: Object.keys(keep).length, changed, at: now.toISOString() };
  });
}
/* ประวัติเวอร์ชันและ Feedback ลูกค้าของสูตรกลิ่น: ตารางแยก ทีม calc/perfumer/projects เห็นร่วมกัน · ไม่ติดขีดจำกัดขนาดสูตร */
const FH_VIEW = ["calc", "perfumer", "projects"], FH_WRITE = ["calc", "perfumer"], FH_FB_KINDS = ["note", "revise", "approve", "reject"];
const fhVerOut = (r: Any) => ({ id: String(r.id), formulaId: String(r.formula_id), owner: String(r.owner), v: Number(r.ver), name: String(r.name || ""), lines: r.lines || [], design: r.design || {}, total: r.total == null ? null : Number(r.total), fb: r.feedback || [], at: iso(r.created_at), by: String(r.created_by || "") });
const fhFbOut = (r: Any) => ({ id: String(r.id), formulaId: String(r.formula_id), ver: Number(r.ver), kind: String(r.kind), text: String(r.text), at: iso(r.created_at), by: String(r.created_by || "") });
const fhId = (fid: unknown) => { const id = str(fid, 40); if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new Error("รหัสสูตรไม่ถูกต้อง"); return id; };
const fhVer = (v: unknown) => Math.max(1, Math.min(999, Math.round(Number(v) || 1)));
const fhNewId = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
async function listFormulaHistory(ctx: Ctx, formulaId: string) {
  const m = await needAny(ctx, FH_VIEW); const fid = fhId(formulaId), db = ctx.db;
  const mask = (v: Any) => canRecipe(m) ? v : { ...v, lines: [], design: {}, total: null, recipeHidden: true };
  return { versions: (await db`select * from costing.formula_versions where formula_id = ${fid} order by ver`).map((x: Any) => mask(fhVerOut(x))),
    feedback: (await db`select * from costing.formula_feedback where formula_id = ${fid} order by created_at`).map(fhFbOut) };
}
async function addFormulaFeedback(ctx: Ctx, formulaId: string, fb: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FH_WRITE), db = c.db, fid = fhId(formulaId); fb = fb || {};
    const text = str(fb.text, 2000); if (!text) throw new Error("ใส่รายละเอียด Feedback");
    const kind = FH_FB_KINDS.includes(String(fb.kind)) ? String(fb.kind) : "note", ver = fhVer(fb.ver);
    const own = (await db`select owner from costing.formulas where id = ${fid} limit 1`)[0]; const owner = own ? String(own.owner) : m.email;
    await db`insert into costing.formula_feedback (id, formula_id, owner, ver, kind, text, created_at, created_by) values (${fhNewId("fb")}, ${fid}, ${owner}, ${ver}, ${kind}, ${text}, now(), ${m.email})`;
    await log(db, m.email, "addFormulaFeedback", fid + " v" + ver + " " + kind);
    return (await db`select * from costing.formula_feedback where formula_id = ${fid} order by created_at`).map(fhFbOut);
  });
}
async function deleteFormulaFeedback(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FH_WRITE), db = c.db; id = str(id, 40);
    const r = (await db`select * from costing.formula_feedback where id = ${id}`)[0]; if (!r) throw new Error("ไม่พบรายการนี้");
    if (String(r.created_by) !== m.email && String(r.owner) !== m.email && !isAdmin(m)) throw new Error("FORBIDDEN");
    await db`delete from costing.formula_feedback where id = ${id}`;
    return (await db`select * from costing.formula_feedback where formula_id = ${String(r.formula_id)} order by created_at`).map(fhFbOut);
  });
}
/** ปิดเวอร์ชันเป็นประวัติ: เก็บสูตร ข้อมูลสินค้า ต้นทุน และ Feedback ของเวอร์ชันนั้น (ซ้ำเลขเวอร์ชันเดิมของเจ้าของ = เขียนทับ) */
async function snapshotFormulaVersion(ctx: Ctx, formulaId: string, snap: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "calc"), db = c.db, fid = fhId(formulaId); snap = snap || {};
    const ver = fhVer(snap.ver);
    const lines = Array.isArray(snap.lines) ? snap.lines.slice(0, 400).map((l: Any) => ({ code: str(l && l.code, 40), nameIn: str(l && l.nameIn, 200), amt: str(l && l.amt, 20), override: str(l && l.override, 20) })) : [];
    const design = snap.design && typeof snap.design === "object" && !Array.isArray(snap.design) ? snap.design : {}; if (JSON.stringify(design).length > 4000) throw new Error("ข้อมูลสินค้าใหญ่เกินไป");
    const fb = (await db`select * from costing.formula_feedback where formula_id = ${fid} and ver = ${ver} order by created_at`).map(fhFbOut);
    await db`delete from costing.formula_versions where formula_id = ${fid} and ver = ${ver} and owner = ${m.email}`;
    await db`insert into costing.formula_versions (id, formula_id, owner, ver, name, lines, design, total, feedback, created_at, created_by) values (${fhNewId("fv")}, ${fid}, ${m.email}, ${ver}, ${str(snap.name, 120)}, ${db.json(lines)}, ${db.json(design)}, ${numOrNull(snap.total)}, ${db.json(fb)}, now(), ${m.email})`;
    await log(db, m.email, "snapshotFormulaVersion", fid + " v" + ver);
    return (await db`select * from costing.formula_versions where formula_id = ${fid} order by ver`).map(fhVerOut);
  });
}
async function adminFormulas(ctx: Ctx) {
  const m = await needAdmin(ctx);
  const list = (await ctx.db`select id, owner, name, updated_at, data from costing.formulas order by updated_at, id`).map(formulaOut);
  await log(ctx.db, m.email, "adminFormulas", list.length + " สูตร");
  return list;
}

/* ===== ทำราคาขาย: เฉพาะเจ้าของระบบและแอดมิน ===== */
async function loadPricing(ctx: Ctx) {
  await needAdmin(ctx);
  const t = Number(await getSetting(ctx.db, "costThreshold"));
  const rows = await ctx.db`select key, owner, formula_id, sell, updated_at, updated_by from costing.pricing order by updated_at, key`;
  return { threshold: t > 0 && t <= 100 ? t : 30,
    items: rows.map((r: Any) => ({ key: String(r.key), owner: String(r.owner).toLowerCase(), formulaId: String(r.formula_id), sell: Number(r.sell) || 0, updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by) })) };
}
async function savePricing(ctx: Ctx, items: Any, threshold: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    if (!Array.isArray(items) || items.length > 500) throw new Error("บันทึกได้ครั้งละไม่เกิน 500 สูตร");
    if (threshold !== undefined && threshold !== null) {
      const t = Number(threshold);
      if (!(t > 0 && t <= 100)) throw new Error("เกณฑ์ต้นทุนต้องอยู่ระหว่าง 1–100");
      await setSetting(db, "costThreshold", t);
    }
    const cur: Record<string, Any> = {};
    (await db`select key, sell from costing.pricing`).forEach((r: Any) => { cur[String(r.key)] = r; });
    const now = new Date(); let changed = 0;
    for (const it of items) {
      const owner = normEmail(it && it.owner), id = String((it && it.formulaId) || "");
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new Error("รหัสสูตรไม่ถูกต้อง");
      const sell = Number(it.sell);
      if (!(sell >= 0) || sell > 1e9) throw new Error("ราคาขายไม่ถูกต้อง");
      const key = owner + "|" + id;
      if (cur[key] && Number(cur[key].sell) === sell) continue;
      await db`insert into costing.pricing (key, owner, formula_id, sell, updated_at, updated_by) values (${key}, ${owner}, ${id}, ${sell}, ${now}, ${m.email})
        on conflict (key) do update set sell = excluded.sell, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
      changed++;
    }
    await log(db, m.email, "savePricing", changed + " สูตร" + (threshold != null ? " · เกณฑ์ " + threshold + "%" : ""));
    return { changed, at: now.toISOString() };
  });
}

/* ===== เรื่องร้องเรียน ===== */
const CMP_LABEL: Record<string, string> = { new: "ยังไม่ได้รับเรื่อง", progress: "กำลังดำเนินงาน", done: "เสร็จสิ้น", rejected: "ปฏิเสธ" };
const cmpOut = (r: Any) => ({ id: String(r.id), email: String(r.email).toLowerCase(), subject: String(r.subject), detail: String(r.detail),
  status: CMP_LABEL[String(r.status)] ? String(r.status) : "new", reply: String(r.reply || ""), repliedBy: String(r.replied_by || ""), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
async function myComplaints(ctx: Ctx) {
  const m = await activeMe(ctx);
  return (await ctx.db`select * from costing.complaints where lower(email) = ${m.email} order by created_at desc`).map(cmpOut);
}
async function adminComplaints(ctx: Ctx) { await needAdmin(ctx); return (await ctx.db`select * from costing.complaints order by created_at desc`).map(cmpOut); }
async function submitComplaint(ctx: Ctx, subject: string, detail: string) {
  return await locked(ctx, async (c) => {
    const m = await activeMe(c), db = c.db;
    subject = String(subject || "").trim().slice(0, 120); detail = String(detail || "").trim().slice(0, 2000);
    if (!subject) throw new Error("ใส่หัวข้อเรื่อง");
    if (detail.length < 5) throw new Error("อธิบายรายละเอียดอย่างน้อย 5 ตัวอักษร");
    const recent = await db`select count(*)::int as n from costing.complaints where lower(email) = ${m.email} and created_at > now() - interval '1 day'`;
    if (recent[0].n >= 5) throw new Error("ส่งเรื่องได้ไม่เกิน 5 เรื่องต่อวัน");
    const id = "c" + uuid(12);
    await db`insert into costing.complaints (id, email, subject, detail, status, reply, replied_by, created_at, updated_at) values (${id}, ${m.email}, ${subject}, ${detail}, 'new', '', '', now(), now())`;
    await log(db, m.email, "submitComplaint", id + " · " + subject.slice(0, 60));
    await sendMail(db, m.owner, "[แผนกวิจัยและพัฒนา] เรื่องร้องเรียนใหม่จาก " + m.email,
      "หัวข้อ: " + subject + "\n\n" + detail + '\n\nตอบกลับและเปลี่ยนสถานะได้ที่ปุ่ม "เรื่องร้องเรียน":\n' + await appUrl(db));
    return (await db`select * from costing.complaints where lower(email) = ${m.email} order by created_at desc`).map(cmpOut);
  });
}
async function replyComplaint(ctx: Ctx, id: string, status: string, reply: string) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    if (!CMP_LABEL[String(status)]) throw new Error("สถานะไม่ถูกต้อง");
    reply = String(reply || "").trim().slice(0, 2000);
    if (status === "rejected" && !reply) throw new Error("ใส่เหตุผลที่ปฏิเสธเพื่อแจ้งผู้ส่งเรื่อง");
    const cur = await db`select * from costing.complaints where id = ${String(id || "")}`;
    if (!cur.length) throw new Error("ไม่พบเรื่องนี้");
    const before = cmpOut(cur[0]);
    if (before.status === status && before.reply === reply) return (await db`select * from costing.complaints order by created_at desc`).map(cmpOut);
    await db`update costing.complaints set status = ${status}, reply = ${reply}, replied_by = ${m.email}, updated_at = now() where id = ${before.id}`;
    await log(db, m.email, "replyComplaint", before.id + " · " + before.status + "→" + status);
    await sendMail(db, before.email, "[แผนกวิจัยและพัฒนา] อัปเดตเรื่องร้องเรียน: " + before.subject.slice(0, 80),
      "เรื่อง: " + before.subject + "\nสถานะ: " + CMP_LABEL[status] + (reply ? "\n\nข้อความจากผู้ดูแลระบบ:\n" + reply : "") + '\n\nดูรายละเอียดได้ที่ปุ่ม "เรื่องร้องเรียน":\n' + await appUrl(db));
    return (await db`select * from costing.complaints order by created_at desc`).map(cmpOut);
  });
}

/* ===== ตรวจตามข้อกำหนด IFRA / อย. ===== */
const COMPLIANCE_MAX = 4000, RMMAP_MAX = 12000;
const casNorm = (s: unknown) => String(s || "").replace(/[^0-9\-]/g, "").slice(0, 20);
async function loadCompliance(ctx: Ctx) {
  const m = await need(ctx, "calc"), db = ctx.db;
  const rules = (await db`select id, source, name, cas, type, limits, note from costing.compliance order by source, name`)
    .map((r: Any) => ({ id: String(r.id), source: String(r.source), name: String(r.name), cas: casNorm(r.cas), type: String(r.type), limits: r.limits || {}, note: String(r.note || "") }));
  const map = (await db`select code, cas, name, pct from costing.rmmap order by id`)
    .map((r: Any) => ({ code: String(r.code).toUpperCase(), cas: casNorm(r.cas), name: String(r.name || ""), pct: r.pct === null || isNaN(Number(r.pct)) ? 100 : Number(r.pct) }));
  return { rules, map,
    updated: { rules: (await getSetting(db, "complianceUpdated")) || "", rulesBy: (await getSetting(db, "complianceBy")) || "", map: (await getSetting(db, "rmMapUpdated")) || "", mapBy: (await getSetting(db, "rmMapBy")) || "" },
    canEditRules: isAdmin(m), canEditMap: !!m.isOwner || !!m.perms.editPrices };
}
async function saveComplianceRules(ctx: Ctx, items: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    if (!Array.isArray(items) || !items.length || items.length > COMPLIANCE_MAX) throw new Error("ไฟล์ต้องมี 1–" + COMPLIANCE_MAX + " รายการ");
    const sources: Record<string, boolean> = {}, now = new Date(), out: Any[] = [];
    items.forEach((it: Any, i: number) => {
      const source = String((it && it.source) || "");
      if (source !== "IFRA" && source !== "FDA") throw new Error("แหล่งที่มาต้องเป็น IFRA หรือ FDA (แถว " + (i + 1) + ")");
      const cas = casNorm(it.cas), name = String(it.name || "").trim().slice(0, 200);
      if (!cas || !name) throw new Error("ทุกแถวต้องมีชื่อสารและเลข CAS (แถว " + (i + 1) + ")");
      const type = it.type === "prohibited" ? "prohibited" : "restricted";
      const limits: Record<string, number> = {};
      Object.keys(it.limits || {}).slice(0, 40).forEach((k) => { const v = Number(it.limits[k]); if (!isNaN(v) && v >= 0 && v <= 100) limits[String(k).slice(0, 6)] = v; });
      sources[source] = true;
      out.push({ id: "k" + i + uuid(6), source, name, cas, type, limits: db.json(limits), note: String(it.note || "").slice(0, 500), updated_at: now });
    });
    await db`delete from costing.compliance where source in ${db(Object.keys(sources))}`;
    for (let i = 0; i < out.length; i += 500) await db`insert into costing.compliance ${db(out.slice(i, i + 500))}`;
    await setSetting(db, "complianceUpdated", bkk(now)); await setSetting(db, "complianceBy", m.email);
    await log(db, m.email, "saveComplianceRules", Object.keys(sources).join("+") + " · " + out.length + " รายการ");
    return { saved: out.length, sources: Object.keys(sources) };
  });
}
async function saveRmMap(ctx: Ctx, items: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    if (!Array.isArray(items) || !items.length || items.length > RMMAP_MAX) throw new Error("ไฟล์ต้องมี 1–" + RMMAP_MAX + " รายการ");
    const rows = items.map((it: Any, i: number) => {
      const code = String((it && it.code) || "").toUpperCase().trim();
      if (!/^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/.test(code)) throw new Error("รหัส RM ไม่ถูกต้อง (แถว " + (i + 1) + "): " + code.slice(0, 30));
      const cas = casNorm(it.cas);
      if (!cas) throw new Error("ต้องมีเลข CAS (แถว " + (i + 1) + ")");
      const pct = it.pct === undefined || it.pct === null || it.pct === "" ? 100 : Number(it.pct);
      if (isNaN(pct) || pct < 0 || pct > 100) throw new Error("% ในวัตถุดิบต้องอยู่ระหว่าง 0–100 (แถว " + (i + 1) + ")");
      return { code, cas, name: String(it.name || "").trim().slice(0, 200), pct };
    });
    await db`delete from costing.rmmap`;
    for (let i = 0; i < rows.length; i += 2000) await db`insert into costing.rmmap ${db(rows.slice(i, i + 2000))}`;
    await setSetting(db, "rmMapUpdated", bkk(new Date())); await setSetting(db, "rmMapBy", m.email);
    await log(db, m.email, "saveRmMap", rows.length + " แถว");
    return { saved: rows.length };
  });
}

/* ===== เอกสารวัตถุดิบต่อสูตร + ทะเบียนสูตร: Stability · Packaging Compatibility · SDS (MSDS) · IFRA · Specification ===== */
const DOC_TYPES: Record<string, number> = { STAB: 1, PACK: 1, SDS: 1, IFRA: 1, SPEC: 1, ALG26: 1, ALG83: 1 }, DOC_DATA_MAX = 45000;
const docOut = (r: Any, withData: boolean) => {
  const o: Any = { id: String(r.id), docNo: String(r.doc_no), type: String(r.type), formulaId: String(r.formula_id), owner: String(r.owner).toLowerCase(), product: String(r.product),
    customer: String(r.customer), brand: String(r.brand), status: String(r.status || "issued"), issuedAt: iso(r.issued_at), issuedBy: String(r.issued_by) };
  if (withData) o.data = String(r.data || "");
  return o;
};
/** สูตรจาก Product Development (pd_formulas) ใช้ id ขึ้นต้น pdf- (สร้างในระบบ) หรือ imp-fm03- (นำเข้าจากไฟล์) · เอกสารของสูตรกลุ่มนี้ทุกคนที่มีสิทธิ์ calc เห็น เพราะสูตร PD เป็นของทีม */
const isPdDocId = (id: unknown) => /^(pdf|imp-fm03)-/.test(String(id || ""));
const docVisible = (m: Me, r: Any) => isAdmin(m) || String(r.owner).toLowerCase() === m.email || isPdDocId(r.formula_id);
/** สูตร Product Development ที่อนุมัติแล้ว ให้หมวด "เอกสารวัตถุดิบ" ใช้ออกเอกสาร (Stability · Packaging · MSDS · IFRA · Spec) */
async function listPdDocFormulas(ctx: Ctx) {
  const m = await need(ctx, "calc");
  /* แบบย่อ (ไม่ส่งส่วนประกอบ) เพราะอาจมีหลายพันสูตร · เปิดเต็มรายสูตรด้วย getPdFormula ตอนออกเอกสาร */
  const rows = await ctx.db`select id, code, name, data->>'customer' as customer, data->>'brand' as brand, data->>'fragranceCode' as fragrance_code, data->>'fgCode' as fg_code, data->>'productName' as product_name, jsonb_array_length(coalesce(data->'lines', '[]'::jsonb)) as n_lines, updated_by, updated_at from costing.pd_formulas where status = 'approved' order by updated_at desc, code limit 6000`;
  return rows.map((x: Any) => ({ id: String(x.id), code: String(x.code || ""), name: String(x.name), customer: String(x.customer || ""), brand: String(x.brand || ""), fragranceCode: String(x.fragrance_code || ""), fgCode: String(x.fg_code || ""), productName: String(x.product_name || ""), nLines: Number(x.n_lines) || 0, updatedBy: String(x.updated_by || ""), updatedAt: iso(x.updated_at) }));
}
async function listDocs(ctx: Ctx) {
  const m = await need(ctx, "calc");
  return (await ctx.db`select * from costing.docs order by issued_at desc`).filter((r: Any) => docVisible(m, r)).map((r: Any) => docOut(r, false));
}
async function getDoc(ctx: Ctx, id: string) {
  const m = await need(ctx, "calc");
  const r = await ctx.db`select * from costing.docs where id = ${String(id || "")}`;
  if (!r.length || !docVisible(m, r[0])) throw new Error("ไม่พบเอกสาร");
  return docOut(r[0], true);
}
async function issueDoc(ctx: Ctx, type: string, formulaId: string, data: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "export"), db = c.db;
    type = String(type || "").toUpperCase();
    if (!DOC_TYPES[type]) throw new Error("ประเภทเอกสารไม่ถูกต้อง");
    formulaId = String(formulaId || "");
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(formulaId)) throw new Error("รหัสสูตรไม่ถูกต้อง");
    let f: Any;
    if (isPdDocId(formulaId)) {   /* สูตร Product Development: ออกได้เมื่ออนุมัติแล้วเท่านั้น */
      const pr = await db`select id, name, status, updated_by from costing.pd_formulas where id = ${formulaId} limit 1`;
      if (!pr.length) throw new Error("ไม่พบสูตรนี้ในระบบ");
      if (String(pr[0].status) !== "approved") throw new Error("ออกเอกสารได้เฉพาะสูตร Product Development ที่อนุมัติแล้ว");
      const ow = String(pr[0].updated_by || "").toLowerCase();
      f = { id: pr[0].id, owner: /@/.test(ow) ? ow : m.email, name: pr[0].name };
    } else {
      const fr = await db`select id, owner, name from costing.formulas where id = ${formulaId} limit 1`;
      if (!fr.length) throw new Error("ไม่พบสูตรนี้ในระบบ (บันทึกสูตรก่อนออกเอกสาร)");
      f = fr[0];
      if (!isAdmin(m) && String(f.owner).toLowerCase() !== m.email) throw new Error("FORBIDDEN");
    }
    let d: Any = {};
    try { d = JSON.parse(String(data || "{}")); } catch (_e) { throw new Error("ข้อมูลเอกสารไม่ถูกต้อง"); }
    const product = String(d.product || f.name || "").trim().slice(0, 200);
    if (!product) throw new Error("ใส่ชื่อผลิตภัณฑ์");
    const now = new Date(), year = bkkYear(now);
    const seq = (await db`select count(*)::int as n from costing.docs where type = ${type} and doc_no like ${type + "-" + year + "-%"}`)[0].n + 1;
    const rev = (await db`select count(*)::int as n from costing.docs where type = ${type} and formula_id = ${formulaId}`)[0].n + 1;
    const docNo = type + "-" + year + "-" + ("0000" + seq).slice(-4);
    d.docNo = docNo; d.rev = rev; d.issuedAt = now.toISOString(); d.issuedBy = m.email; d.formulaOwner = String(f.owner).toLowerCase();
    const json = JSON.stringify(d);
    if (json.length > DOC_DATA_MAX) throw new Error("เนื้อหาเอกสารใหญ่เกินไป");
    const id = "d" + uuid(12);
    await db`insert into costing.docs (id, doc_no, type, formula_id, owner, product, customer, brand, status, issued_at, issued_by, data)
      values (${id}, ${docNo}, ${type}, ${formulaId}, ${String(f.owner).toLowerCase()}, ${product}, ${String(d.customer || "").slice(0, 200)}, ${String(d.brand || "").slice(0, 120)}, 'issued', ${now}, ${m.email}, ${json})`;
    await log(db, m.email, "issueDoc", docNo + " · " + product + " (rev " + rev + ")");
    return { id, docNo, rev, issuedAt: d.issuedAt, issuedBy: m.email };
  });
}
async function voidDoc(ctx: Ctx, id: string, reason: string) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    const r = await db`select doc_no from costing.docs where id = ${String(id || "")}`;
    if (!r.length) throw new Error("ไม่พบเอกสาร");
    await db`update costing.docs set status = 'void' where id = ${String(id)}`;
    await log(db, m.email, "voidDoc", String(r[0].doc_no) + (reason ? " · " + String(reason).slice(0, 200) : ""));
    return await listDocs(c);
  });
}

/* ===== MSDS และเอกสารของวัตถุดิบ (RM) ===== */
const RMDOC_KINDS: Record<string, number> = { MSDS: 1, IFRA: 1, ALLERGEN: 1, COA: 1, OTHER: 1 };
const RMDOC_MAX_BYTES = 15 * 1024 * 1024, RMDOC_PICTOS: Record<string, number> = { flame: 1, excl: 1, health: 1, corr: 1, env: 1, skull: 1, oxid: 1, gas: 1, expl: 1 };
const RM_CODE_RE = /^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/;
const rmDocOut = (r: Any) => ({ id: String(r.id), codes: splitList(r.codes), kind: String(r.kind), file: String(r.file), size: Number(r.size) || 0, supplier: String(r.supplier || ""),
  sg: numOrNull(r.sg), sgText: String(r.sg_text || ""), temp: numOrNull(r.temp), density: numOrNull(r.density), flash: String(r.flash || ""), flashC: numOrNull(r.flash_c),
  hazards: splitList(r.hazards), hazText: String(r.haz_text || ""), pictos: splitList(r.pictos), picSrc: String(r.pic_src || ""), signal: String(r.signal || ""), note: String(r.note || ""),
  uploadedAt: iso(r.uploaded_at), uploadedBy: String(r.uploaded_by || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
function rmDocClean(d: Any) {
  d = d || {};
  const codes: string[] = [];
  (Array.isArray(d.codes) ? d.codes : splitList(d.codes)).slice(0, 20).forEach((c0: unknown) => {
    const c = String(c0 || "").toUpperCase().trim();
    if (!RM_CODE_RE.test(c)) throw new Error("รหัส RM ไม่ถูกต้อง: " + c.slice(0, 30));
    if (codes.indexOf(c) < 0) codes.push(c);
  });
  if (!codes.length) throw new Error("เลือกรหัส RM อย่างน้อย 1 รหัส");
  const kind = String(d.kind || "MSDS").toUpperCase();
  if (!RMDOC_KINDS[kind]) throw new Error("ประเภทเอกสารไม่ถูกต้อง");
  const num = (v: unknown, lo: number, hi: number) => { const n = numOrNull(v); return n !== null && n >= lo && n <= hi ? n : null; };
  const hz = (Array.isArray(d.hazards) ? d.hazards : splitList(d.hazards)).map((h: unknown) => String(h).toUpperCase().trim()).filter((h: string) => /^(EU)?H\d{3}[A-Z]{0,2}$/.test(h)).slice(0, 40);
  const pic = (Array.isArray(d.pictos) ? d.pictos : splitList(d.pictos)).filter((p: string) => RMDOC_PICTOS[p]);
  const signal = String(d.signal || "").toUpperCase();
  return { codes: codes.join(","), kind, supplier: String(d.supplier || "").trim().slice(0, 120), sg: num(d.sg, 0.3, 3), sg_text: String(d.sgText || "").trim().slice(0, 120),
    temp: num(d.temp, 0, 60), density: num(d.density, 0.3, 3), flash: String(d.flash || "").trim().slice(0, 60), flash_c: num(d.flashC, -100, 400),
    hazards: [...new Set(hz)].join(","), haz_text: String(d.hazText || "").trim().slice(0, 1000), pictos: [...new Set(pic)].join(","),
    pic_src: { h: 1, text: 1, manual: 1, none: 1 }[String(d.picSrc) as "h"] ? String(d.picSrc) : "manual", signal: signal === "DANGER" || signal === "WARNING" ? signal : "", note: String(d.note || "").trim().slice(0, 500) };
}
async function listRmDocs(ctx: Ctx) {
  const m = await need(ctx, "viewDb");
  return { items: (await ctx.db`select * from costing.rmdocs order by uploaded_at desc`).map(rmDocOut), canEdit: !!m.isOwner || !!m.perms.editPrices || m.role === "admin" };
}
async function getRmDocFile(ctx: Ctx, id: string) {
  const m = await need(ctx, "viewDb");
  const r = await ctx.db`select file, codes, storage_path from costing.rmdocs where id = ${String(id || "")}`;
  if (!r.length) throw new Error("ไม่พบเอกสาร");
  const dl = await sb.storage.from("rm-docs").download(String(r[0].storage_path));
  if (dl.error || !dl.data) throw new Error("ไม่พบไฟล์ในที่เก็บไฟล์ อัปโหลดใหม่ได้");
  await log(ctx.db, m.email, "getRmDocFile", String(r[0].file) + " · " + String(r[0].codes));
  return { name: String(r[0].file), mime: "application/pdf", b64: encodeBase64(new Uint8Array(await dl.data.arrayBuffer())) };
}
async function uploadRmDoc(ctx: Ctx, meta: Any, b64: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    const d = rmDocClean(meta);
    const file = String((meta && meta.file) || "").replace(/[\\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 150);
    if (!/\.pdf$/i.test(file)) throw new Error("รองรับเฉพาะไฟล์ PDF");
    if (typeof b64 !== "string" || !b64) throw new Error("ไม่มีข้อมูลไฟล์");
    const bytes = decodeBase64(b64);
    if (!bytes.length || bytes.length > RMDOC_MAX_BYTES) throw new Error("ไฟล์ต้องมีขนาดไม่เกิน 15 MB");
    if (bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) throw new Error("ไฟล์นี้ไม่ใช่ PDF");
    const ex = (await db`select id, storage_path from costing.rmdocs where kind = ${d.kind} and lower(file) = ${file.toLowerCase()}`)[0];
    const id = ex ? String(ex.id) : "r" + uuid(12), path = `${id}/${Date.now()}.pdf`;
    const up = await sb.storage.from("rm-docs").upload(path, bytes, { contentType: "application/pdf" });
    if (up.error) throw new Error("บันทึกไฟล์ไม่สำเร็จ: " + up.error.message);
    const now = new Date();
    const row = { id, ...d, file, storage_path: path, size: bytes.length, uploaded_at: now, uploaded_by: m.email, updated_at: now, updated_by: m.email };
    if (ex) { await db`update costing.rmdocs set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${id}`; try { await sb.storage.from("rm-docs").remove([String(ex.storage_path)]); } catch (_e) { /* ignore */ } }
    else await db`insert into costing.rmdocs ${db(row)}`;
    await log(db, m.email, "uploadRmDoc", (ex ? "แทนที่ " : "") + d.kind + " " + file + " → " + d.codes);
    return rmDocOut(row);
  });
}
async function updateRmDoc(ctx: Ctx, id: string, meta: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    const ex = (await db`select * from costing.rmdocs where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบเอกสาร");
    const upd = { ...rmDocClean(meta), updated_at: new Date(), updated_by: m.email };
    await db`update costing.rmdocs set ${db(upd, ...Object.keys(upd))} where id = ${String(id)}`;
    await log(db, m.email, "updateRmDoc", String(ex.file) + " → " + upd.codes);
    return rmDocOut({ ...ex, ...upd });
  });
}
async function deleteRmDoc(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db;
    const ex = (await db`select * from costing.rmdocs where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบเอกสาร");
    try { await sb.storage.from("rm-docs").remove([String(ex.storage_path)]); } catch (_e) { /* ignore */ }
    await db`delete from costing.rmdocs where id = ${String(id)}`;
    await log(db, m.email, "deleteRmDoc", String(ex.kind) + " " + String(ex.file) + " · " + String(ex.codes));
    return { deleted: String(ex.id) };
  });
}

/* ===== Perfumer: บรีฟออกแบบกลิ่น (Briefs) และคลังกลิ่น (Scents) ===== */
const PF_VIEW = ["perfumer", "projects", "pd", "ra", "calc", "viewDb", "rdView"], PF_DATA_MAX = 45000;
const PF_KINDS: Record<string, number> = { ODM: 1, SV: 1, INT: 1, QUIZ: 1 };
const PF_BRIEF_STATUS: Record<string, number> = { new: 1, design: 1, sample: 1, revise: 1, approved: 1, closed: 1, lost: 1 };
const PF_SCENT_STATUS: Record<string, number> = { draft: 1, trial: 1, sent: 1, approved: 1, production: 1, retired: 1 };
function pfData(d: unknown) {
  const o = d && typeof d === "object" ? d : {};
  if (JSON.stringify(o).length > PF_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป (ลดความยาวข้อความ)");
  return o;
}
const briefOut = (r: Any) => ({ id: String(r.id), kind: String(r.kind), brand: String(r.brand), status: String(r.status), owner: String(r.owner).toLowerCase(), contact: String(r.contact || ""),
  phone: String(r.phone || ""), email: String(r.email || ""), summary: String(r.summary || ""), createdAt: iso(r.created_at), createdBy: String(r.created_by || ""),
  updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || ""), data: r.data || {} });
const scentOut = (r: Any) => ({ id: String(r.id), code: String(r.code), name: String(r.name), briefId: String(r.brief_id || ""), family: String(r.family || ""), status: String(r.status),
  owner: String(r.owner).toLowerCase(), formulaId: String(r.formula_id || ""), projectId: String(r.project_id || ""), formulaCode: String(r.formula_code || ""),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || ""), data: r.data || {} });
async function listBriefs(ctx: Ctx) { await needAny(ctx, PF_VIEW); return (await ctx.db`select * from costing.briefs order by updated_at desc`).map(briefOut); }
async function listScents(ctx: Ctx) { const m = await needAny(ctx, PF_VIEW); return (await ctx.db`select * from costing.scents order by updated_at desc`).map((x: Any) => maskScent(m, scentOut(x))); }
async function saveBrief(ctx: Ctx, b: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "perfumer"), db = c.db;
    b = b || {};
    const brand = str(b.brand, 200);
    if (!brand) throw new Error("ใส่ชื่อแบรนด์ / ชื่อลูกค้า");
    const kind = String(b.kind || "ODM").toUpperCase();
    if (!PF_KINDS[kind]) throw new Error("ประเภทบรีฟไม่ถูกต้อง");
    const status = PF_BRIEF_STATUS[b.status] ? String(b.status) : "new";
    const now = new Date(), ex = b.id ? (await db`select * from costing.briefs where id = ${String(b.id)}`)[0] : null;
    if (b.id && !ex) throw new Error("ไม่พบบรีฟนี้ (อาจถูกลบไปแล้ว)");
    const row = { id: ex ? String(ex.id) : "b" + uuid(12), kind, brand, status, owner: ex ? String(ex.owner) : m.email, contact: str(b.contact, 120), phone: str(b.phone, 60), email: str(b.email, 120),
      summary: str(b.summary, 300), created_at: ex ? ex.created_at : now, created_by: ex ? String(ex.created_by) : m.email, updated_at: now, updated_by: m.email, data: db.json(pfData(b.data)), tf_token: ex ? ex.tf_token : null };
    if (ex) await db`update costing.briefs set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`;
    else await db`insert into costing.briefs ${db(row)}`;
    await log(db, m.email, "saveBrief", (ex ? "แก้ไข " : "สร้าง ") + kind + " · " + brand + " [" + status + "]");
    return briefOut({ ...row, data: pfData(b.data) });
  });
}
async function deleteBrief(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "perfumer"), db = c.db;
    const ex = (await db`select * from costing.briefs where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบบรีฟนี้");
    if (!isAdmin(m) && String(ex.created_by).toLowerCase() !== m.email && String(ex.owner).toLowerCase() !== m.email) throw new Error("FORBIDDEN");
    if ((await db`select 1 from costing.scents where brief_id = ${String(ex.id)} limit 1`).length) throw new Error("ยังมีกลิ่นที่อ้างถึงบรีฟนี้ ย้ายหรือลบกลิ่นก่อน");
    await db`delete from costing.briefs where id = ${String(ex.id)}`;
    await log(db, m.email, "deleteBrief", String(ex.kind) + " · " + String(ex.brand));
    return { deleted: String(ex.id) };
  });
}
async function saveScent(ctx: Ctx, s: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "perfumer"), db = c.db;
    s = s || {};
    const name = str(s.name, 160);
    if (!name) throw new Error("ใส่ชื่อกลิ่น");
    const status = PF_SCENT_STATUS[s.status] ? String(s.status) : "draft";
    const briefId = str(s.briefId, 40);
    if (briefId && !(await db`select 1 from costing.briefs where id = ${briefId}`).length) throw new Error("ไม่พบบรีฟที่เลือก");
    const formulaId = str(s.formulaId, 40);
    if (formulaId && !/^[A-Za-z0-9_-]{3,40}$/.test(formulaId)) throw new Error("รหัสสูตรไม่ถูกต้อง");
    const now = new Date(), ex = s.id ? (await db`select * from costing.scents where id = ${String(s.id)}`)[0] : null;
    if (s.id && !ex) throw new Error("ไม่พบกลิ่นนี้ (อาจถูกลบไปแล้ว)");
    let code = ex ? String(ex.code) : "";
    if (!code) {
      const year = bkkYear(now);
      const seq = (await db`select count(*)::int as n from costing.scents where code like ${"SC-" + year + "-%"}`)[0].n + 1;
      code = "SC-" + year + "-" + ("0000" + seq).slice(-4);
    }
    /* ผูกกับโครงการ: รหัสสูตรกลิ่น PF+ลูกค้า+ลำดับกลิ่น+01 ออกให้ครั้งแรกที่ผูก (คงเดิมเมื่อย้ายโครงการของลูกค้าเดียวกัน) */
    const projectId = str(s.projectId, 40);
    let formulaCode = ex ? String(ex.formula_code || "") : "";
    if (projectId) {
      const pr = (await db`select customer_code from costing.projects where id = ${projectId}`)[0];
      if (!pr) throw new Error("ไม่พบโครงการที่เลือก");
      if (!formulaCode) formulaCode = await nextFormulaCode(db, String(pr.customer_code || ""));
    }
    const row = { id: ex ? String(ex.id) : "s" + uuid(12), code, name, brief_id: briefId, family: str(s.family, 80), status, owner: ex ? String(ex.owner) : m.email, formula_id: formulaId,
      project_id: projectId, formula_code: formulaCode, created_at: ex ? ex.created_at : now, updated_at: now, updated_by: m.email, data: db.json(pfData(s.data)) };
    if (ex) await db`update costing.scents set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`;
    else await db`insert into costing.scents ${db(row)}`;
    await log(db, m.email, "saveScent", (ex ? "แก้ไข " : "สร้าง ") + code + " · " + name + " [" + status + "]");
    return maskScent(m, scentOut({ ...row, data: pfData(s.data) }));
  });
}
async function deleteScent(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "perfumer"), db = c.db;
    const ex = (await db`select * from costing.scents where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบกลิ่นนี้");
    if (!isAdmin(m) && String(ex.owner).toLowerCase() !== m.email) throw new Error("FORBIDDEN");
    if (String(ex.status) === "production") throw new Error('กลิ่นที่ใช้ผลิตอยู่ลบไม่ได้ เปลี่ยนสถานะเป็น "เลิกใช้" แทน');
    await db`delete from costing.scents where id = ${String(id)}`;
    await log(db, m.email, "deleteScent", String(ex.code) + " · " + String(ex.name));
    return { deleted: String(ex.id) };
  });
}

/* ===== เชื่อม Typeform ===== */
const TF_API = "https://api.typeform.com", TF_TAG = "scentsense-costing";
const TF_SYN: Record<string, string> = { "สดชื่น / ซิตรัส": "ซิตรัส / สดชื่น", "ซิตรัส": "ซิตรัส / สดชื่น", "หวานละมุน": "หวาน / กูร์มองด์", "มีหัวน้ำหอมของตัวเองแล้ว": "ลูกค้ามีหัวน้ำหอมของตัวเองแล้ว",
  "Natural Ingredients — สนใจส่วนผสมจากธรรมชาติ เช่น Essential Oils": "Natural Ingredients — ส่วนผสมจากธรรมชาติ เช่น Essential Oils",
  "Thai Identity — สนใจกลิ่นและวัตถุดิบที่สะท้อนเอกลักษณ์ไทย ผ่าน 100 Siam Palette": "Thai Identity — เอกลักษณ์ไทยผ่าน 100 Siam Palette",
  "Upcycled Ingredients — สนใจวัตถุดิบที่นำผลพลอยได้หรือวัสดุเหลือใช้กลับมาสร้างคุณค่าใหม่": "Upcycled Ingredients — วัตถุดิบจากผลพลอยได้",
  "Open to Suggestions — เปิดรับคำแนะนำจากทีมผู้เชี่ยวชาญ โดยไม่จำกัดประเภทวัตถุดิบ": "Open to Suggestions — เปิดรับคำแนะนำจากทีม",
  "Hotel Amenities: Shower gel, Shampoo, Body Lotion etc.": "Hotel Amenities (Shower gel, Shampoo, Body Lotion)", "Spa Amenities: Body Oil, Massage Oil etc.": "Spa Amenities (Body Oil, Massage Oil)" };
async function tfToken(db: Db) { return (await getSetting(db, "TYPEFORM_TOKEN")) || ""; }
async function tfSecret(db: Db) {
  let s = await getSetting(db, "TYPEFORM_SECRET");
  if (!s) { s = uuid(32) + uuid(8); await setSetting(db, "TYPEFORM_SECRET", s); }
  return s;
}
async function tfFetch(db: Db, path: string, opt: { method?: string; payload?: unknown } = {}): Promise<Any> {
  const token = await tfToken(db);
  if (!token) throw new Error("ยังไม่ได้เชื่อม Typeform (ใส่ Personal access token ก่อน)");
  const res = await fetch(TF_API + path, { method: (opt.method || "get").toUpperCase(), headers: { Authorization: "Bearer " + token, ...(opt.payload ? { "Content-Type": "application/json" } : {}) },
    body: opt.payload ? JSON.stringify(opt.payload) : undefined, signal: AbortSignal.timeout(30000) });
  const code = res.status, txt = await res.text();
  if (code === 401 || code === 403) throw new Error("Typeform ปฏิเสธ token (ตรวจว่ายังไม่หมดอายุและมีสิทธิ์ forms:read, responses:read, webhooks:write)");
  if (code >= 400) throw new Error("Typeform ตอบกลับ " + code + ": " + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : {};
}
const tfWebhookUrl = async (db: Db) => Deno.env.get("SUPABASE_URL") + "/functions/v1/api?tf=" + await tfSecret(db);
async function getTypeformStatus(ctx: Ctx) {
  await needAdmin(ctx); const db = ctx.db;
  const forms = [];
  for (const id of Object.keys(TF_FORMS)) forms.push({ id, kind: TF_FORMS[id].kind, title: TF_FORMS[id].title, url: "https://form.typeform.com/to/" + id, webhook: (await getSetting(db, "tfHook:" + id)) === "on", lastSync: (await getSetting(db, "tfSync:" + id)) || "" });
  const imported = (await db`select count(*)::int as n from costing.briefs where coalesce(tf_token, '') <> ''`)[0].n;
  return { connected: !!(await tfToken(db)), account: (await getSetting(db, "tfAccount")) || "", forms, imported, lastRun: (await getSetting(db, "tfLastRun")) || "", lastError: (await getSetting(db, "tfLastError")) || "" };
}
async function saveTypeformToken(ctx: Ctx, token: string) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    token = String(token || "").trim();
    if (!/^[A-Za-z0-9_\-\.]{20,200}$/.test(token)) throw new Error("รูปแบบ token ไม่ถูกต้อง");
    await setSetting(db, "TYPEFORM_TOKEN", token);
    let meInfo: Any;
    try { meInfo = await tfFetch(db, "/me"); } catch (e) { await delSetting(db, "TYPEFORM_TOKEN"); throw e; }
    await setSetting(db, "tfAccount", String(meInfo.alias || meInfo.email || ""));
    const hook = await tfWebhookUrl(db), results: string[] = [];
    for (const id of Object.keys(TF_FORMS)) {
      try { await tfFetch(db, "/forms/" + id + "/webhooks/" + TF_TAG, { method: "put", payload: { url: hook, enabled: true, secret: await tfSecret(db), verify_ssl: true } });
        await setSetting(db, "tfHook:" + id, "on"); results.push(id + " ok");
      } catch (e) { await setSetting(db, "tfHook:" + id, "off"); results.push(id + " " + (e as Error).message); }
    }
    await log(db, m.email, "saveTypeformToken", "บัญชี " + (meInfo.alias || "") + " · webhook: " + results.join("; "));
    return await getTypeformStatus(c);
  });
}
async function disconnectTypeform(ctx: Ctx) {
  return await locked(ctx, async (c) => {
    const m = await needAdmin(c), db = c.db;
    for (const id of Object.keys(TF_FORMS)) { try { await tfFetch(db, "/forms/" + id + "/webhooks/" + TF_TAG, { method: "delete" }); } catch (_e) { /* ignore */ } await setSetting(db, "tfHook:" + id, "off"); }
    await delSetting(db, "TYPEFORM_TOKEN"); await delSetting(db, "TYPEFORM_SECRET"); await setSetting(db, "tfAccount", "");
    await log(db, m.email, "disconnectTypeform");
    return await getTypeformStatus(c);
  });
}
async function syncTypeform(ctx: Ctx, all: boolean) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "perfumer"), db = c.db;
    const out: Any = { imported: 0, skipped: 0, attached: 0, forms: {} };
    for (const id of Object.keys(TF_FORMS)) {
      let q = "/forms/" + id + "/responses?page_size=1000&completed=true";
      const since = await getSetting(db, "tfSync:" + id);
      if (!all && since) q += "&since=" + encodeURIComponent(since);
      const page = await tfFetch(db, q); let n = 0;
      for (const it of (page.items || [])) { const r = await tfImport(db, id, it); out[r]++; n++; }
      out.forms[id] = n;
      await setSetting(db, "tfSync:" + id, new Date().toISOString());
    }
    await setSetting(db, "tfLastRun", bkk(new Date()) + " โดย " + m.email);
    await log(db, m.email, "syncTypeform", JSON.stringify(out));
    return out;
  });
}
const tfNorm = (s: unknown) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function tfChoice(fdef: Any, label: unknown) {
  let l = String(label || "").replace(/\s+/g, " ").trim();
  if (fdef.en && fdef.th) { const i = fdef.en.findIndex((x: string) => tfNorm(x) === tfNorm(l)); if (i >= 0 && fdef.th[i]) l = fdef.th[i]; }
  return TF_SYN[l] || l;
}
function tfAnswerValue(a: Any): Any {
  switch (a.type) {
    case "text": return a.text; case "email": return a.email; case "phone_number": return a.phone_number; case "url": return a.url;
    case "number": return a.number; case "boolean": return a.boolean; case "date": return a.date;
    case "choice": return a.choice ? (a.choice.label || a.choice.other || "") : "";
    case "choices": return a.choices ? (a.choices.labels || []).concat(a.choices.other ? [a.choices.other] : []) : [];
    default: return a.text || "";
  }
}
async function tfImport(db: Db, formId: string, fr: Any): Promise<"imported" | "skipped" | "attached"> {
  const def = TF_FORMS[formId], token = String(fr.token || fr.response_id || "");
  if (!token) return "skipped";
  if ((await db`select 1 from costing.briefs where tf_token = ${token} or data->'archTf'->>'token' = ${token} limit 1`).length) return "skipped";
  const d: Any = { tf: { form: formId, token, submitted: String(fr.submitted_at || ""), landed: String(fr.landed_at || "") } }, arch: string[] = [];
  let lang = "TH";
  for (const a of (fr.answers || [])) {
    const ref = String((a.field && a.field.ref) || ""), base = ref.replace(/^en_/, "");
    if (/^language/.test(base)) { const v = tfAnswerValue(a); if (/english|อังกฤษ/i.test(String(v))) lang = "EN"; continue; }
    const fdef = def.fields[base]; if (!fdef) continue;
    let v = tfAnswerValue(a);
    if (a.type === "choice") v = tfChoice(fdef, v);
    else if (a.type === "choices") v = v.map((x: string) => tfChoice(fdef, x));
    if (/^arch\d$/.test(fdef.k)) {
      const list = ref.indexOf("en_") === 0 ? (fdef.en || []) : (fdef.th || []);
      const i = list.findIndex((x: string) => tfNorm(x) === tfNorm(a.choice && a.choice.label));
      arch[Number(fdef.k.slice(4))] = i >= 0 ? String(i) : ""; continue;
    }
    if (fdef.k === "consent") { d.consent = v === true; continue; }
    if (fdef.k === "branches") { d.branches = v === "" || v === null ? "" : Number(v); continue; }
    d[fdef.k] = typeof v === "string" ? v.slice(0, 3000) : v;
  }
  d.lang = lang;
  if (arch.length) { for (let i = 0; i < 8; i++) if (arch[i] === undefined) arch[i] = ""; d.arch = { answers: arch, result: "" }; }
  const brand = str(d.brand, 200) || "ไม่ระบุแบรนด์"; delete d.brand;
  const now = new Date(), kind = def.kind;
  if (kind === "QUIZ") {
    const cands = await db`select * from costing.briefs where lower(brand) = ${tfNorm(brand)} and kind <> 'QUIZ'`;
    const hit = cands.find((r: Any) => !((r.data?.arch?.answers || []).some((x: string) => String(x))));
    if (hit) {
      const nd = { ...(hit.data || {}), arch: d.arch, archTf: d.tf }; if (d.email && !nd.email) nd.email = d.email;
      await db`update costing.briefs set data = ${db.json(pfData(nd))}, updated_at = ${now}, updated_by = 'typeform' where id = ${hit.id}`;
      return "attached";
    }
  }
  const prods = (d.products || d.svProducts || []) as string[];
  const summary = ["Typeform", kind === "QUIZ" ? "Archetype Quiz" : (prods.length ? prods.slice(0, 2).map((p) => String(p).split(" (")[0]).join(", ") + (prods.length > 2 ? " +" + (prods.length - 2) : "") : ""), d.sku ? d.sku + " SKU" : "", d.budget || d.retail || ""].filter(String).join(" · ");
  await db`insert into costing.briefs ${db({ id: "b" + uuid(12), kind, brand, status: "new", owner: "", contact: str(d.contact, 120), phone: str(d.phone, 60), email: str(d.email, 120), summary: summary.slice(0, 300),
    created_at: fr.submitted_at ? new Date(fr.submitted_at) : now, created_by: "typeform", updated_at: now, updated_by: "typeform", data: db.json(pfData(d)), tf_token: token })}`;
  return "imported";
}
async function tfWebhook(req: Request, url: URL): Promise<Response> {
  const ok = (s: string) => new Response(s, { status: 200, headers: { "Content-Type": "text/plain", ...CORS } });
  try {
    const secret = await getSetting(sql, "TYPEFORM_SECRET");
    if (!(await tfToken(sql)) || !secret || url.searchParams.get("tf") !== secret) return ok("forbidden");
    const body = JSON.parse((await req.text()) || "{}");
    if (body.event_type !== "form_response" || !body.form_response) return ok("ignored");
    const fr = body.form_response, id = String(fr.form_id || "");
    if (!TF_FORMS[id]) return ok("unknown form");
    const r = await sql.begin(async (tx: Db) => { await tx`select pg_advisory_xact_lock(7001)`; return await tfImport(tx, id, fr); });
    await log(sql, "typeform", "webhook", id + " · " + String(fr.token || "").slice(0, 12) + " · " + r);
    return ok(r);
  } catch (err) {
    try { await setSetting(sql, "tfLastError", bkk(new Date()) + " " + String((err as Error).message || err).slice(0, 200)); } catch (_e) { /* ignore */ }
    return ok("error");
  }
}

/* ===== ย้ายข้อมูลจาก Google Sheet (ใช้ครั้งเดียว) =====
   เจ้าของระบบเรียกจากหน้าเว็บ: ดึงข้อมูลจาก Apps Script (exportAll) แล้วส่งมาที่นี่ · ปิดตัวเองหลังย้ายสำเร็จ (ตั้ง settings.migrated) */
const MIGRATION_OWNER = "ratchaphon@scentandsense.co.th";
const ts = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? null : d; };
const bool = (v: unknown, def = true) => (v === "" || v === null || v === undefined ? def : isTrue(v));
const jsonOf = (v: unknown, def: unknown) => { if (v && typeof v === "object") return v; try { return JSON.parse(String(v || "")); } catch (_e) { return def; } };
const S = (v: unknown) => (v === null || v === undefined ? "" : String(v));
async function importAll(ctx: Ctx, d: Any) {
  if (ctx.email !== MIGRATION_OWNER) throw new Error("FORBIDDEN");
  return await locked(ctx, async (c) => {
    const db = c.db;
    if ((await getSetting(db, "migrated")) === "1") throw new Error("ย้ายข้อมูลไปแล้ว (ปิดการย้ายถาวร)");
    const t = (k: string): Any[] => (Array.isArray(d && d[k]) ? d[k] : []);
    const counts: Record<string, number> = {};
    const ins = async (table: string, rows: Any[], chunk = 500) => {
      counts[table] = rows.length;
      await db.unsafe(`truncate table costing.${table} restart identity`);
      for (let i = 0; i < rows.length; i += chunk) await db`insert into ${db("costing." + table)} ${db(rows.slice(i, i + chunk))}`;
    };
    await ins("users", t("Users").filter((r) => S(r.email)).map((r) => ({ email: S(r.email).toLowerCase(), role: S(r.role), active: bool(r.active), added_by: S(r.addedBy), added_at: ts(r.addedAt) || new Date() })));
    await ins("roles", t("Roles").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), name: S(r.name), perms: db.json(jsonOf(r.perms, {})), system: bool(r.system, false), ord: Number(r.order) || 0 })));
    await ins("settings", t("Settings").filter((r) => S(r.key) && S(r.key) !== "rmDocFolder").map((r) => ({ key: S(r.key), value: /^(true|false)$/i.test(S(r.value)) ? S(r.value).toLowerCase() : S(r.value) })));
    await ins("prices", t("Prices").filter((r) => S(r.code)).map((r) => ({ code: S(r.code), name: S(r.name), price: numOrNull(r.price), status: S(r.status) || "none", note: S(r.note), updated_at: ts(r.updatedAt), updated_by: S(r.updatedBy) })), 1000);
    if (Array.isArray(d.builtin) && d.builtin.length) await ins("prices_builtin", d.builtin.map((r: Any, i: number) => ({ ord: i + 1, code: S(r.code), name: S(r.name), price: numOrNull(r.price), status: S(r.status) || "none", note: S(r.note) })), 1000);
    await ins("requests", t("Requests").filter((r) => S(r.email)).map((r) => ({ email: S(r.email).toLowerCase(), at: ts(r.at) || new Date() })));
    await ins("visitors", t("Visitors").filter((r) => S(r.email)).map((r) => ({ email: S(r.email).toLowerCase(), first_seen: ts(r.firstSeen), last_seen: ts(r.lastSeen) })));
    await ins("log", t("Log").map((r) => ({ at: ts(r.at) || new Date(), email: S(r.email), action: S(r.action), detail: S(r.detail).slice(0, 2000) })), 1000);
    await ins("formulas", t("Formulas").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), owner: S(r.owner).toLowerCase(), name: S(r.name), updated_at: ts(r.updatedAt), data: S(r.data) || "{}" })), 100);
    await ins("pricing", t("Pricing").filter((r) => S(r.key)).map((r) => ({ key: S(r.key), owner: S(r.owner).toLowerCase(), formula_id: S(r.formulaId), sell: Number(r.sell) || 0, updated_at: ts(r.updatedAt), updated_by: S(r.updatedBy) })));
    await ins("complaints", t("Complaints").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), email: S(r.email).toLowerCase(), subject: S(r.subject), detail: S(r.detail), status: S(r.status) || "new", reply: S(r.reply), replied_by: S(r.repliedBy), created_at: ts(r.createdAt) || new Date(), updated_at: ts(r.updatedAt) || new Date() })));
    await ins("compliance", t("Compliance").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), source: S(r.source), name: S(r.name), cas: S(r.cas), type: S(r.type) || "restricted", limits: db.json(jsonOf(r.limits, {})), note: S(r.note), updated_at: ts(r.updatedAt) })), 500);
    await ins("rmmap", t("RmMap").filter((r) => S(r.code)).map((r) => ({ code: S(r.code), cas: S(r.cas), name: S(r.name), pct: r.pct === "" || r.pct === null || r.pct === undefined ? 100 : Number(r.pct) })), 2000);
    await ins("docs", t("Docs").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), doc_no: S(r.docNo), type: S(r.type), formula_id: S(r.formulaId), owner: S(r.owner).toLowerCase(), product: S(r.product), customer: S(r.customer), brand: S(r.brand), status: S(r.status) || "issued", issued_at: ts(r.issuedAt), issued_by: S(r.issuedBy), data: S(r.data) || "{}" })), 100);
    await ins("rmdocs", t("RmDocs").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), codes: S(r.codes), kind: S(r.kind), file: S(r.file), storage_path: `${S(r.id)}/migrated.pdf`, size: Number(r.size) || 0, supplier: S(r.supplier), sg: numOrNull(r.sg), sg_text: S(r.sgText), temp: numOrNull(r.temp), density: numOrNull(r.density), flash: S(r.flash), flash_c: numOrNull(r.flashC), hazards: S(r.hazards), haz_text: S(r.hazText), pictos: S(r.pictos), pic_src: S(r.picSrc), signal: S(r.signal), note: S(r.note), uploaded_at: ts(r.uploadedAt), uploaded_by: S(r.uploadedBy), updated_at: ts(r.updatedAt), updated_by: S(r.updatedBy) })), 100);
    await ins("briefs", t("Briefs").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), kind: S(r.kind), brand: S(r.brand), status: S(r.status) || "new", owner: S(r.owner), contact: S(r.contact), phone: S(r.phone), email: S(r.email), summary: S(r.summary), created_at: ts(r.createdAt), created_by: S(r.createdBy), updated_at: ts(r.updatedAt), updated_by: S(r.updatedBy), data: db.json(jsonOf(r.data, {})), tf_token: S(r.tfToken) || null })), 100);
    await ins("scents", t("Scents").filter((r) => S(r.id)).map((r) => ({ id: S(r.id), code: S(r.code), name: S(r.name), brief_id: S(r.briefId), family: S(r.family), status: S(r.status) || "draft", owner: S(r.owner), formula_id: S(r.formulaId), created_at: ts(r.createdAt), updated_at: ts(r.updatedAt), updated_by: S(r.updatedBy), data: db.json(jsonOf(r.data, {})) })), 100);
    await setSetting(db, "publicUrl", DEFAULT_PUBLIC_URL);
    await log(db, ctx.email, "importAll", JSON.stringify(counts));
    return { counts };
  });
}
/** ย้ายไฟล์ PDF ของเอกสารวัตถุดิบ (เรียกทีละไฟล์หลัง importAll) */
async function importRmFile(ctx: Ctx, id: string, b64: string) {
  if (ctx.email !== MIGRATION_OWNER) throw new Error("FORBIDDEN");
  if ((await getSetting(ctx.db, "migrated")) === "1") throw new Error("ย้ายข้อมูลไปแล้ว (ปิดการย้ายถาวร)");
  const r = await ctx.db`select storage_path from costing.rmdocs where id = ${String(id)}`;
  if (!r.length) throw new Error("ไม่พบเอกสารในฐานข้อมูล");
  const bytes = decodeBase64(b64);
  if (bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) throw new Error("ไฟล์นี้ไม่ใช่ PDF");
  const up = await sb.storage.from("rm-docs").upload(String(r[0].storage_path), bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error(up.error.message);
  await ctx.db`update costing.rmdocs set size = ${bytes.length} where id = ${String(id)}`;
  return { ok: true, size: bytes.length };
}
async function finishMigration(ctx: Ctx) {
  if (ctx.email !== MIGRATION_OWNER) throw new Error("FORBIDDEN");
  const missing: string[] = [];
  for (const r of await ctx.db`select id, file, storage_path from costing.rmdocs`) {
    const dir = String(r.storage_path).split("/")[0], ls = await sb.storage.from("rm-docs").list(dir);
    if (ls.error || !ls.data || !ls.data.some((f: Any) => f.name === String(r.storage_path).split("/")[1])) missing.push(String(r.file));
  }
  if (missing.length) throw new Error("ยังมีไฟล์ที่ย้ายไม่ครบ: " + missing.slice(0, 5).join(", "));
  await setSetting(ctx.db, "migrated", "1");
  return { ok: true };
}

/* ===== แผนกวิจัยและพัฒนา: ลูกค้า โครงการพัฒนาสินค้า (PDR) ตัวอย่างที่ส่ง และผลประเมินของลูกค้า =====
   โครงการหนึ่งรายการ = คำขอพัฒนา (FM-RD-01) หนึ่งใบ เดินผ่านขั้น s1..s8 → done (หรือ lost) ตามระเบียบปฏิบัติ QP-RD-01
   เลขเอกสาร FM-RD-XX-DDMMYY-NNN ออกให้เองจากตัวนับ docseq (NNN รันต่อเดือน) · ลูกค้าประเมินตัวอย่างผ่านลิงก์สาธารณะ (ไม่ต้อง log in) */
const RD_VIEW = ["projects", "perfumer", "pd", "ra", "calc", "viewDb", "rdView"], RD_EDIT = ["projects", "perfumer", "pd"], RD_DATA_MAX = 60000;
const RD_STAGES = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "done", "lost"];
const RD_KINDS: Record<string, number> = { new: 1, cost: 1, topping: 1, repeat: 1 };
const RD_SLA_DEFAULT: Record<string, number> = { s1: 1, s2: 2, s3: 15, s3send: 2, s3eval: 7, s5send: 2, s5eval: 7, s7: 1 };
const RA_STATUS: Record<string, number> = { pending: 1, pass: 1, cond: 1, fail: 1 };
const SAMPLE_KINDS: Record<string, number> = { scent: 1, mockup: 1 };
const EVAL_FIELDS = ["scent", "appearance", "skinfeel", "target", "brand", "overall"];
const EVAL_DECISIONS: Record<string, number> = { produce: 1, revise: 1, reject: 1 };
const RD_DIRECTIONS = 3;   /* ตัวอย่างกลิ่นรอบแรกเสนอ 3 แนวทาง ลูกค้าเลือก 1 กลิ่นเพื่อไปต่อหรือนำไปแก้ไข */

function bkkParts(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { dd: p.day, mm: p.month, yyyy: p.year };
}
/** เลขเอกสาร FM-RD-XX-DDMMYY-NNN (วันที่ไทย ปี พ.ศ. 2 หลัก, NNN รันต่อเดือนต่อฟอร์ม) */
async function nextDocNo(db: Db, prefix: string, at: Date) {
  const p = bkkParts(at);
  const r = await db`insert into costing.docseq (prefix, period, n) values (${prefix}, ${p.yyyy + p.mm}, 1) on conflict (prefix, period) do update set n = costing.docseq.n + 1 returning n`;
  return `${prefix}-${p.dd}${p.mm}${String((Number(p.yyyy) + 543) % 100).padStart(2, "0")}-${String(Number(r[0].n)).padStart(3, "0")}`;
}
/** เลข PDR: PDR + ปี ค.ศ. 2 หลัก + เดือน + ลำดับ 3 หลัก (รูปแบบเดียวกับฟอร์ม PDR เดิม เช่น PDR2505001) */
async function nextPdrNo(db: Db, at: Date) {
  const p = bkkParts(at), period = p.yyyy + p.mm;
  const r = await db`insert into costing.docseq (prefix, period, n) values ('PDR', ${period}, 1) on conflict (prefix, period) do update set n = costing.docseq.n + 1 returning n`;
  return "PDR" + p.yyyy.slice(2) + p.mm + String(Number(r[0].n)).padStart(3, "0");
}
/** รหัสสูตรกลิ่น PF + รหัสลูกค้า 3 หลัก + ลำดับกลิ่นของลูกค้า 2 หลัก + 01 */
async function nextFormulaCode(db: Db, customerCode: string) {
  const cust = (customerCode || "000").replace(/[^0-9A-Za-z]/g, "").padStart(3, "0").slice(-3).toUpperCase();
  const n = (await db`select count(*)::int as n from costing.scents where formula_code like ${"PF" + cust + "%"}`)[0].n + 1;
  return "PF" + cust + String(n).padStart(2, "0") + "01";
}
const custCode = (v: unknown) => str(v, 10).replace(/[^0-9A-Za-z-]/g, "").toUpperCase();
const custOut = (r: Any) => ({ code: String(r.code), company: String(r.company || ""), brand: String(r.brand || ""), contact: String(r.contact || ""), phone: String(r.phone || ""),
  email: String(r.email || ""), note: String(r.note || ""), updatedAt: iso(r.updated_at) });
async function listCustomers(ctx: Ctx) { await needAny(ctx, RD_VIEW); return (await ctx.db`select * from costing.customers order by code`).map(custOut); }
async function upsertCustomer(db: Db, c: Any, email: string) {
  let code = custCode(c.code);
  if (!code) {   /* รหัสใหม่ = เลขสูงสุดที่เป็นตัวเลข + 1 (3 หลัก) */
    const r = await db`select max((code)::int) as m from costing.customers where code ~ '^[0-9]+$'`;
    code = String((Number(r[0].m) || 0) + 1).padStart(3, "0");
  }
  const now = new Date(), ex = (await db`select * from costing.customers where code = ${code}`)[0];
  const row = { code, company: str(c.company, 200), brand: str(c.brand, 200), contact: str(c.contact, 120), phone: str(c.phone, 60), email: str(c.email, 120), note: str(c.note, 1000),
    created_at: ex ? ex.created_at : now, updated_at: now, updated_by: email };
  if (!row.company && !row.brand) throw new Error("ใส่ชื่อบริษัทหรือแบรนด์");
  if (ex) await db`update costing.customers set ${db(row, "company", "brand", "contact", "phone", "email", "note", "updated_at", "updated_by")} where code = ${code}`;
  else await db`insert into costing.customers ${db(row)}`;
  return custOut(row);
}
async function saveCustomer(ctx: Ctx, c: Any) {
  return await locked(ctx, async (cx) => { const m = await needAny(cx, RD_EDIT); const out = await upsertCustomer(cx.db, c || {}, m.email); await log(cx.db, m.email, "saveCustomer", out.code + " · " + (out.brand || out.company)); return out; });
}

const rdData = (d: unknown) => { const o = d && typeof d === "object" ? d : {}; if (JSON.stringify(o).length > RD_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป (ลดความยาวข้อความ)"); return o; };
const emailList = (v: unknown) => (Array.isArray(v) ? v : splitList(v)).map((x) => str(x, 120).toLowerCase()).filter(Boolean).slice(0, 10);
function cleanOwners(o: Any) { o = o || {}; return { pc: str(o.pc, 120).toLowerCase(), sa: str(o.sa, 120).toLowerCase(), pd: str(o.pd, 120).toLowerCase(), perfumer: emailList(o.perfumer) }; }
const projOut = (r: Any) => ({ id: String(r.id), pdrNo: String(r.pdr_no || ""), docNo: String(r.doc_no || ""), customerCode: String(r.customer_code || ""), company: String(r.company || ""),
  brand: String(r.brand || ""), soNo: String(r.so_no || ""), kind: String(r.kind || "new"), title: String(r.title || ""), scentCount: Number(r.scent_count) || 0, stage: String(r.stage || "s1"),
  owners: r.owners || {}, briefId: String(r.brief_id || ""), ra: r.ra || {}, actual: r.actual || {}, data: r.data || {},
  createdAt: iso(r.created_at), createdBy: String(r.created_by || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function rdSla(db: Db) { const s = jsonOf(await getSetting(db, "rdSla"), {}); return { ...RD_SLA_DEFAULT, ...(s && typeof s === "object" ? s : {}) }; }
async function listProjects(ctx: Ctx) {
  await needAny(ctx, RD_VIEW); const db = ctx.db;
  const rows = await db`select * from costing.projects order by updated_at desc`;
  const sc = await db`select project_id, count(*)::int as n from costing.scents where project_id <> '' group by project_id`;
  const sm = await db`select project_id, count(*)::int as n, sum(case when status = 'evaluated' then 1 else 0 end)::int as ev from costing.samples group by project_id`;
  const scN: Record<string, number> = {}, smN: Record<string, Any> = {};
  sc.forEach((r: Any) => { scN[String(r.project_id)] = Number(r.n); }); sm.forEach((r: Any) => { smN[String(r.project_id)] = r; });
  return { sla: await rdSla(db), items: rows.map((r: Any) => ({ ...projOut(r), scents: scN[String(r.id)] || 0, samples: smN[String(r.id)] ? Number(smN[String(r.id)].n) : 0, evaluated: smN[String(r.id)] ? Number(smN[String(r.id)].ev) : 0 })) };
}
async function getProject(ctx: Ctx, id: string) {
  const m = await needAny(ctx, RD_VIEW); const db = ctx.db;
  const r = (await db`select * from costing.projects where id = ${String(id || "")}`)[0];
  if (!r) throw new Error("ไม่พบโครงการนี้");
  return { project: projOut(r), scents: (await db`select * from costing.scents where project_id = ${String(r.id)} order by created_at`).map((x: Any) => maskScent(m, scentOut(x))),
    samples: (await db`select * from costing.samples where project_id = ${String(r.id)} order by created_at`).map((s: Any) => sampleOut(s, "")), sla: await rdSla(db) };
}
/* ---------- เอกสารแนบโครงการ (PDR FM-RD-01 ฯลฯ): ไฟล์อยู่ใน bucket rd-docs (private) · รายการไฟล์อยู่ใน projects.data.pdrFiles ---------- */
const PDR_MIME: Record<string, string> = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
const PDR_MAX_BYTES = 15 * 1024 * 1024, PDR_MAX_FILES = 20, PDR_KINDS: Record<string, string> = { pdr: "PDR (FM-RD-01)", other: "เอกสารอื่น", design: "รูปงานออกแบบกลิ่น" };
function pdrMagicOk(ext: string, b: Uint8Array) {
  const is = (...h: number[]) => h.every((v, i) => b[i] === v);
  if (ext === "pdf") return is(0x25, 0x50, 0x44, 0x46);
  if (ext === "xlsx" || ext === "docx") return is(0x50, 0x4b, 0x03, 0x04);
  if (ext === "xls" || ext === "doc") return is(0xd0, 0xcf, 0x11, 0xe0);
  if (ext === "png") return is(0x89, 0x50, 0x4e, 0x47);
  return is(0xff, 0xd8, 0xff);
}
const pdrList = (d: Any): Any[] => (d && Array.isArray(d.pdrFiles) ? d.pdrFiles : []);
const pdrOut = (f: Any) => ({ id: String(f.id), name: String(f.name), ext: String(f.ext), size: Number(f.size) || 0, kind: String(f.kind || "pdr"), at: String(f.at || ""), by: String(f.by || "") });
async function uploadProjectDoc(ctx: Ctx, projectId: string, meta: Any, b64: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${String(projectId || "")}`)[0]; if (!pr) throw new Error("ไม่พบโครงการนี้");
    const name = String((meta && meta.file) || "").replace(/[\\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 150);
    const ext = ((name.match(/\.([A-Za-z0-9]{2,5})$/) || [])[1] || "").toLowerCase();
    if (!PDR_MIME[ext]) throw new Error("รองรับไฟล์ PDF, Excel (xlsx/xls), Word (docx/doc) และรูปภาพ (png/jpg) เท่านั้น");
    if (typeof b64 !== "string" || !b64) throw new Error("ไม่มีข้อมูลไฟล์");
    const bytes = decodeBase64(b64);
    if (!bytes.length || bytes.length > PDR_MAX_BYTES) throw new Error("ไฟล์ต้องมีขนาดไม่เกิน 15 MB");
    if (!pdrMagicOk(ext, bytes)) throw new Error("เนื้อหาไฟล์ไม่ตรงกับนามสกุล ." + ext);
    const d = pr.data || {}, list = pdrList(d); if (list.length >= PDR_MAX_FILES) throw new Error("แนบได้ไม่เกิน " + PDR_MAX_FILES + " ไฟล์ต่อโครงการ");
    const kind = PDR_KINDS[String(meta && meta.kind)] ? String(meta.kind) : "pdr", id = "f" + uuid(10), path = `${String(pr.id)}/${id}.${ext}`;
    const up = await sb.storage.from("rd-docs").upload(path, bytes, { contentType: PDR_MIME[ext] });
    if (up.error) throw new Error("บันทึกไฟล์ไม่สำเร็จ: " + up.error.message);
    const f = { id, name, ext, size: bytes.length, kind, at: new Date().toISOString(), by: m.email };
    const data = { ...d, pdrFiles: [...list, f] };
    await db`update costing.projects set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "uploadProjectDoc", String(pr.pdr_no) + " · " + PDR_KINDS[kind] + " · " + name);
    return { files: data.pdrFiles.map(pdrOut) };
  });
}
async function getProjectDocFile(ctx: Ctx, projectId: string, fileId: string) {
  const m = await needAny(ctx, RD_VIEW), db = ctx.db;
  const pr = (await db`select id, pdr_no, data from costing.projects where id = ${String(projectId || "")}`)[0]; if (!pr) throw new Error("ไม่พบโครงการนี้");
  const f = pdrList(pr.data).find((x: Any) => String(x.id) === String(fileId || "")); if (!f) throw new Error("ไม่พบไฟล์นี้");
  const dl = await sb.storage.from("rd-docs").download(`${String(pr.id)}/${String(f.id)}.${String(f.ext)}`);
  if (dl.error || !dl.data) throw new Error("ไม่พบไฟล์ในที่เก็บไฟล์ อัปโหลดใหม่ได้");
  await log(db, m.email, "getProjectDocFile", String(pr.pdr_no) + " · " + String(f.name));
  return { name: String(f.name), mime: PDR_MIME[String(f.ext)] || "application/octet-stream", b64: encodeBase64(new Uint8Array(await dl.data.arrayBuffer())) };
}
async function deleteProjectDoc(ctx: Ctx, projectId: string, fileId: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${String(projectId || "")}`)[0]; if (!pr) throw new Error("ไม่พบโครงการนี้");
    const d = pr.data || {}, list = pdrList(d), f = list.find((x: Any) => String(x.id) === String(fileId || "")); if (!f) throw new Error("ไม่พบไฟล์นี้");
    if (String(f.by) !== m.email && !hasPerm(m, "projects") && !isAdmin(m)) throw new Error("FORBIDDEN");   /* ลบได้เฉพาะคนที่แนบ · Project Coordinator · ผู้ดูแล */
    try { await sb.storage.from("rd-docs").remove([`${String(pr.id)}/${String(f.id)}.${String(f.ext)}`]); } catch (_e) { /* ignore */ }
    const data = { ...d, pdrFiles: list.filter((x: Any) => x !== f) };
    await db`update costing.projects set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "deleteProjectDoc", String(pr.pdr_no) + " · " + String(f.name));
    return { files: data.pdrFiles.map(pdrOut) };
  });
}
async function saveProject(ctx: Ctx, p: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    p = p || {};
    const now = new Date(), ex = p.id ? (await db`select * from costing.projects where id = ${String(p.id)}`)[0] : null;
    if (p.id && !ex) throw new Error("ไม่พบโครงการนี้ (อาจถูกลบไปแล้ว)");
    if (!ex && !hasPerm(m, "projects") && !hasPerm(m, "perfumer")) throw new Error("FORBIDDEN");   /* PD แก้ได้เฉพาะโครงการที่เปิดแล้ว */
    if (ex) { ["customerCode", "soNo", "kind", "title", "scentCount", "briefId", "owners"].forEach((k) => { if (p[k] === undefined && !(k === "customerCode" && p.customer)) p[k] = { customerCode: ex.customer_code, soNo: ex.so_no, kind: ex.kind, title: ex.title, scentCount: ex.scent_count, briefId: ex.brief_id, owners: ex.owners }[k]; }); }
    const kind = RD_KINDS[p.kind] ? String(p.kind) : "new";
    let cust: Any = null;
    if (p.customer && typeof p.customer === "object" && (p.customer.company || p.customer.brand)) cust = await upsertCustomer(db, p.customer, m.email);   /* สร้าง/แก้ลูกค้าในคำขอเดียวกัน */
    const code = cust ? cust.code : custCode(p.customerCode);
    if (code && !cust) { cust = (await db`select * from costing.customers where code = ${code}`)[0]; if (!cust) throw new Error("ไม่พบรหัสลูกค้า " + code); cust = custOut(cust); }
    const company = str(p.company, 200) || (cust ? cust.company : ""), brand = str(p.brand, 200) || (cust ? cust.brand : "");
    if (!company && !brand) throw new Error("ใส่ชื่อลูกค้าหรือแบรนด์");
    const briefId = str(p.briefId, 40);
    if (briefId && !(await db`select 1 from costing.briefs where id = ${briefId}`).length) throw new Error("ไม่พบบรีฟที่เลือก");
    const scentCount = Math.max(1, Math.min(99, Math.round(Number(p.scentCount) || 1)));
    const actual = ex ? (ex.actual || {}) : { s1: now.toISOString() };
    /* ส่วนที่เซิร์ฟเวอร์ดูแลเอง (ประวัติขั้น การข้ามเงื่อนไข เลขเอกสารย่อย) คงค่าเดิมไว้เสมอ แม้หน้าเว็บส่ง data ชุดเก่ามา */
    const data: Any = rdData(p.data), old: Any = ex ? ex.data || {} : {};
    data.pdrFiles = old.pdrFiles;   /* รายการไฟล์แนบจัดการผ่าน uploadProjectDoc/deleteProjectDoc เท่านั้น */
    if (ex) { data.stageLog = old.stageLog; data.overrides = old.overrides; Object.keys(RD_SUBDOCS).forEach((k) => { if (old[k] && old[k].docNo) data[k] = { ...(data[k] && typeof data[k] === "object" ? data[k] : {}), docNo: old[k].docNo, issuedAt: old[k].issuedAt, issuedBy: old[k].issuedBy }; }); }
    const row = { id: ex ? String(ex.id) : "p" + uuid(12), pdr_no: ex ? String(ex.pdr_no) : await nextPdrNo(db, now), doc_no: ex ? String(ex.doc_no) : await nextDocNo(db, "FM-RD-01", now),
      customer_code: code, company, brand, so_no: str(p.soNo, 60), kind, title: str(p.title, 300), scent_count: scentCount, stage: ex ? String(ex.stage) : "s1",
      owners: db.json(cleanOwners(p.owners)), brief_id: briefId, ra: db.json(ex ? ex.ra || {} : {}), actual: db.json(actual), data: db.json(data),
      created_at: ex ? ex.created_at : now, created_by: ex ? String(ex.created_by) : m.email, updated_at: now, updated_by: m.email };
    if (ex) await db`update costing.projects set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`;
    else await db`insert into costing.projects ${db(row)}`;
    await log(db, m.email, "saveProject", (ex ? "แก้ไข " : "เปิด ") + row.pdr_no + " · " + (brand || company));
    return projOut({ ...row, owners: cleanOwners(p.owners), ra: ex ? ex.ra || {} : {}, actual, data });
  });
}
/** เงื่อนไขผ่านด่านของแต่ละขั้น (ตาม QP-RD-01) — คืนข้อความเหตุผลถ้ายังไปต่อไม่ได้ */
async function gateCheck(db: Db, pr: Any, to: string): Promise<string> {
  const d = pr.data || {}, ra = pr.ra || {}, ow = pr.owners || {};
  const decided = async (kind: string) => (await db`select 1 from costing.samples where project_id = ${String(pr.id)} and kind = ${kind} and status = 'evaluated' and eval->>'produce' = 'true' limit 1`).length > 0;
  switch (to) {
    case "s2": return !pr.customer_code ? "ระบุรหัสลูกค้าก่อน" : !ow.pc ? "ระบุผู้ประสานงาน (Project Coordinator) ก่อน" : "";
    case "s3": return ra.status !== "pass" && ra.status !== "cond" ? "RA ต้องตรวจกฎหมายผ่าน (หรือผ่านแบบมีเงื่อนไข) ก่อน" : !(ow.perfumer || []).length ? "มอบหมาย Perfumer ก่อน" : "";
    case "s4": return (await decided("scent")) ? "" : 'ลูกค้ายังไม่ได้เลือกกลิ่นที่จะ "ผลิตจริงต่อไป" (ส่งตัวอย่างกลิ่น ' + RD_DIRECTIONS + ' แนวทาง แล้วให้ลูกค้าเลือก 1 กลิ่นในแบบประเมิน)';
    case "s5": return (await db`select 1 from costing.samples where project_id = ${String(pr.id)} and kind = 'mockup' limit 1`).length ? "" : "ยังไม่มีชุดตัวอย่างต้นแบบสินค้า (FM-RD-04)";
    case "s6": return (await decided("mockup")) ? "" : 'ลูกค้ายังไม่ได้ยืนยันต้นแบบ (ต้องมีผลประเมินต้นแบบที่เลือก "ผลิตจริงต่อไป")';
    case "s7": return d.stability && (d.stability.standard || d.stability.result === "pass") ? "" : "บันทึก Stability ก่อน: เบสเดิมใช้เอกสารมาตรฐาน หรือเบสใหม่ต้องมีผลทดสอบผ่าน (FM-RD-08)";
    case "s8": return d.bom && d.bom.released ? "" : "ออก BOM และบันทึกส่งมอบสูตร (FM-RD-09) ก่อน";
    case "done": return !(d.bom && d.bom.released) ? "ออก BOM และบันทึกส่งมอบสูตร (FM-RD-09) ก่อน" : d.newFormula && !(d.pilot && d.pilot.result === "pass") ? "สูตรใหม่ต้องทำ Pilot Batch ให้ผ่านก่อน (FM-RD-07)" : "";
    default: return "";
  }
}
/** ข้อมูลกลิ่นของวัตถุดิบ (ชั้นโน้ต + ตระกูลกลิ่น) ใช้คำนวณกราฟลักษณะกลิ่นและ Fragrance Wheel จากสูตรจริง */
const OLF_AX = ["citrus", "green", "aquatic", "floral", "spicy", "gourmand", "woody", "amber"], OLF_LAYER: Record<string, number> = { top: 1, heart: 1, base: 1, none: 1 };
const olfOut = (r: Any) => ({ code: String(r.code), layer: String(r.layer || ""), fam: r.fam || {}, odor: String(r.odor || ""), src: String(r.src || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function listRmOlf(ctx: Ctx) {
  await needAny(ctx, PF_VIEW);
  return (await ctx.db`select * from costing.rm_olf order by code`).map(olfOut);
}
async function saveRmOlf(ctx: Ctx, code: string, o: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, ["perfumer", "editPrices"]), db = c.db;
    code = str(code, 40); if (!/^RM-[A-Z0-9-]{3,36}$/i.test(code)) throw new Error("รหัสวัตถุดิบไม่ถูกต้อง");
    o = o && typeof o === "object" ? o : {};
    const layer = OLF_LAYER[String(o.layer)] ? String(o.layer) : "";
    const fam: Record<string, number> = {};
    if (layer !== "none" && o.fam && typeof o.fam === "object") for (const k of OLF_AX) { const n = Number(o.fam[k]); if (isFinite(n) && n > 0) fam[k] = Math.round(Math.min(1, n) * 100) / 100; }
    if (Object.keys(fam).length > 4) throw new Error("เลือกตระกูลกลิ่นได้ไม่เกิน 4 กลุ่ม");
    if (!layer && !Object.keys(fam).length) { await db`delete from costing.rm_olf where code = ${code}`; await log(db, m.email, "saveRmOlf", code + " · ล้าง"); return { code, layer: "", fam: {}, odor: "", src: "", updatedAt: "", updatedBy: "" }; }
    const row = { code, layer, fam: db.json(fam), odor: str(o.odor, 200), src: "manual", updated_at: new Date(), updated_by: m.email };
    await db`insert into costing.rm_olf ${db(row)} on conflict (code) do update set layer = excluded.layer, fam = excluded.fam, odor = excluded.odor, src = excluded.src, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
    await log(db, m.email, "saveRmOlf", code + " · " + layer + " " + Object.keys(fam).join("/"));
    return olfOut({ ...row, fam });
  });
}
/** นำเข้าข้อมูลกลิ่นวัตถุดิบที่จัดอัตโนมัติจากชื่อ (ไฟล์ supabase/seed/rm_olf.json ใน GitHub ตาม commit) · เจ้าของระบบเท่านั้น · ไม่ทับแถวที่มีอยู่ */
async function seedRmOlf(ctx: Ctx, sha: string) {
  if (ctx.email !== MIGRATION_OWNER) throw new Error("FORBIDDEN");
  if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) throw new Error("commit sha ไม่ถูกต้อง");
  const res = await fetch(`https://raw.githubusercontent.com/Adjbank/costing/${sha}/supabase/seed/rm_olf.json`);
  if (!res.ok) throw new Error("ดึงไฟล์ข้อมูลไม่สำเร็จ (" + res.status + ")");
  const j = await res.json(), rules: Any[] = Array.isArray(j.rules) ? j.rules : [], rows: Any[] = Array.isArray(j.rows) ? j.rows : [];
  return await locked(ctx, async (c) => {
    const db = c.db, now = new Date(); let n = 0;
    const list = rows.map((x: Any) => { const ru = rules[Number(x[1])] || []; return { code: str(x[0], 40), layer: OLF_LAYER[String(ru[0])] ? String(ru[0]) : "", fam: db.json(ru[1] && typeof ru[1] === "object" ? ru[1] : {}), odor: str(ru[2], 200), src: "auto", updated_at: now, updated_by: "auto-classify" }; })
      .filter((x: Any) => /^RM-[A-Z0-9-]{3,36}$/i.test(x.code) && x.layer);
    for (let i = 0; i < list.length; i += 300) n += (await db`insert into costing.rm_olf ${db(list.slice(i, i + 300))} on conflict (code) do nothing returning code`).length;
    await log(db, ctx.email, "seedRmOlf", sha.slice(0, 7) + " · " + n + "/" + list.length);
    return { inserted: n, total: list.length };
  });
}
/** ข้อมูลออกแบบกลิ่นของโครงการ (data.scentDesign): Brand Story · Archetype · Concept · Heart Ingredients · Mood & Tone · รายละเอียด
 *  ทุกสูตร/ทุกแนวทางของโครงการใช้ชุดเดียวกัน · รูปแนบใช้ uploadProjectDoc kind "design" */
const SD_TOKEN = /^[a-z][a-z0-9_-]{1,23}$/;
async function saveProjectScentDesign(ctx: Ctx, id: string, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, [...RD_EDIT, "calc"]), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${str(id, 80)}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการนี้");
    d = d && typeof d === "object" ? d : {};
    const arch = SD_TOKEN.test(String(d.arch || "")) ? String(d.arch) : "";
    const moods = (Array.isArray(d.moods) ? d.moods : []).map(String).filter((x: string) => SD_TOKEN.test(x)).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).slice(0, 3);
    const sd = { story: str(d.story, 3000), arch, concept: str(d.concept, 3000), heart: str(d.heart, 1000), moods, tone: str(d.tone, 500), details: str(d.details, 3000), at: new Date().toISOString(), by: m.email };
    const data = { ...(pr.data || {}), scentDesign: sd };
    if (JSON.stringify(data).length > RD_DATA_MAX) throw new Error("ข้อมูลโครงการใหญ่เกินไป");
    await db`update costing.projects set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "saveProjectScentDesign", String(pr.pdr_no));
    return projOut({ ...pr, data, updated_by: m.email, updated_at: new Date() });
  });
}
/** แก้ไข Mockup ของโครงการ (data.mockups) · ทับรายการเดิมทั้งชุด · สิทธิ์เดียวกับการแก้โครงการ */
async function saveProjectMockups(ctx: Ctx, id: string, items: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${str(id, 80)}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการนี้");
    if (!Array.isArray(items) || items.length > 60) throw new Error("บันทึก Mockup ได้ไม่เกิน 60 รายการ");
    const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    const list = items.map((x: Any) => ({ product: str(x && x.product, 120), name: str(x && x.name, 200), code: str(x && x.code, 80), date: day(x && x.date), cf: day(x && x.cf), extra: day(x && x.extra),
      rounds: (Array.isArray(x && x.rounds) ? x.rounds : []).slice(0, 3).map((r: Any) => ({ due: day(r && r.due), follow: day(r && r.follow) })).filter((r: Any) => r.due || r.follow), note: str(x && x.note, 500) }))
      .filter((x: Any) => x.product || x.name || x.code || x.date || x.cf || x.extra || x.rounds.length || x.note);
    const data = { ...(pr.data || {}), mockups: list };
    if (JSON.stringify(data).length > RD_DATA_MAX) throw new Error("ข้อมูลโครงการใหญ่เกินไป");
    await db`update costing.projects set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "saveProjectMockups", String(pr.pdr_no) + " · " + list.length + " Mockup");
    return projOut({ ...pr, data, updated_by: m.email, updated_at: new Date() });
  });
}
async function setStage(ctx: Ctx, id: string, stage: string, note: string, force: boolean) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${String(id || "")}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการนี้");
    if (RD_STAGES.indexOf(stage) < 0) throw new Error("ขั้นตอนไม่ถูกต้อง");
    const from = String(pr.stage), fi = RD_STAGES.indexOf(from), ti = RD_STAGES.indexOf(stage);
    note = str(note, 1000);
    if (stage === "lost" && !note) throw new Error("ใส่เหตุผลที่ยกเลิกโครงการ");
    const forward = ti > fi && stage !== "lost";
    const data = pr.data || {};
    if (forward) {
      if (ti - fi > 1 && stage !== "done") throw new Error("ข้ามขั้นไม่ได้ ไปทีละขั้น");
      if (stage === "done" && from !== "s8" && !(from === "s7" && !data.newFormula)) throw new Error(data.newFormula ? "สูตรใหม่ต้องผ่าน Pilot Batch (ขั้น 8) ก่อนปิดงาน" : "ต้องออก BOM (ขั้น 7) ก่อนปิดงาน");
      const why = await gateCheck(db, pr, stage);
      if (why) {
        if (!force) throw new Error("ยังไปขั้นถัดไปไม่ได้: " + why);
        if (!note) throw new Error("ข้ามเงื่อนไขต้องใส่เหตุผล (เช่น ลูกค้ายืนยันทาง LINE)");
        data.overrides = (Array.isArray(data.overrides) ? data.overrides : []).concat([{ stage, why, note, by: m.email, at: new Date().toISOString() }]).slice(-50);
      }
    } else if (!isAdmin(m) && !hasPerm(m, "projects")) throw new Error("ย้อนขั้นหรือยกเลิกได้เฉพาะ Project Coordinator หรือผู้ดูแลระบบ");
    const actual = { ...(pr.actual || {}) };
    if (!actual[stage]) actual[stage] = new Date().toISOString();
    data.stageLog = (Array.isArray(data.stageLog) ? data.stageLog : []).concat([{ from, to: stage, note, by: m.email, at: new Date().toISOString() }]).slice(-100);
    await db`update costing.projects set stage = ${stage}, actual = ${db.json(actual)}, data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "setStage", String(pr.pdr_no) + " · " + from + " → " + stage + (note ? " · " + note : ""));
    return projOut({ ...pr, stage, actual, data, updated_by: m.email, updated_at: new Date() });
  });
}
/** ปิดงาน/ยกเลิกหลายโครงการพร้อมกัน (ล้างทะเบียนเก่า): เฉพาะ Project Coordinator หรือผู้ดูแลระบบ · ข้ามเงื่อนไขขั้นตอน บันทึกเหตุผลใน stageLog + overrides */
async function bulkStage(ctx: Ctx, ids: Any, stage: string, note: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    if (!isAdmin(m) && !hasPerm(m, "projects")) throw new Error("ปิดงานหรือยกเลิกแบบกลุ่มได้เฉพาะ Project Coordinator หรือผู้ดูแลระบบ");
    if (stage !== "done" && stage !== "lost") throw new Error("เลือกได้เฉพาะ เสร็จสิ้น หรือ ยกเลิก");
    note = str(note, 1000); if (!note) throw new Error("ใส่เหตุผล (เช่น ล้างทะเบียนเก่า ปิดงานตามจริง)");
    const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => str(x, 40)).filter(Boolean))];
    if (!list.length) throw new Error("ยังไม่ได้เลือกโครงการ"); if (list.length > 300) throw new Error("ทำได้ครั้งละไม่เกิน 300 โครงการ");
    const rows = await db`select * from costing.projects where id = any(${list}) and stage <> 'done' and stage <> 'lost'`;
    const at = new Date().toISOString(); let n = 0;
    for (const pr of rows) {
      const from = String(pr.stage), data = pr.data || {}, actual = { ...(pr.actual || {}) }; if (!actual[stage]) actual[stage] = at;
      data.stageLog = (Array.isArray(data.stageLog) ? data.stageLog : []).concat([{ from, to: stage, note: "[กลุ่ม] " + note, by: m.email, at }]).slice(-100);
      if (stage === "done") data.overrides = (Array.isArray(data.overrides) ? data.overrides : []).concat([{ stage, why: "ปิดงานแบบกลุ่มโดยไม่ผ่านเงื่อนไขขั้นตอน", note, by: m.email, at }]).slice(-50);
      await db`update costing.projects set stage = ${stage}, actual = ${db.json(actual)}, data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`; n++;
    }
    await log(db, m.email, "bulkStage", n + " โครงการ → " + stage + " · " + note);
    return { updated: n, skipped: list.length - n };
  });
}
async function raCheck(ctx: Ctx, id: string, status: string, note: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "ra"), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${String(id || "")}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการนี้");
    if (!RA_STATUS[status]) throw new Error("ผลตรวจไม่ถูกต้อง");
    const ra = { status, note: str(note, 2000), by: m.email, at: new Date().toISOString() };
    const actual = { ...(pr.actual || {}) }; if (status !== "pending" && !actual.s2ra) actual.s2ra = ra.at;
    await db`update costing.projects set ra = ${db.json(ra)}, actual = ${db.json(actual)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "raCheck", String(pr.pdr_no) + " · " + status + (ra.note ? " · " + ra.note.slice(0, 200) : ""));
    return projOut({ ...pr, ra, actual, updated_by: m.email, updated_at: new Date() });
  });
}
/** ออกเลขเอกสารให้ส่วนย่อยของโครงการ (FM-RD-03/06/07/08/09/10) ครั้งแรกครั้งเดียว แล้วเก็บไว้ใน data[key].docNo */
const RD_SUBDOCS: Record<string, string> = { prototype: "FM-RD-03", finalFormula: "FM-RD-06", pilot: "FM-RD-07", stability: "FM-RD-08", bom: "FM-RD-09", retention: "FM-RD-10", plan: "FM-RD-12" };
async function issueProjectDoc(ctx: Ctx, id: string, key: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const pr = (await db`select * from costing.projects where id = ${String(id || "")}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการนี้");
    if (!RD_SUBDOCS[key]) throw new Error("ไม่รู้จักเอกสาร " + key);
    const data = pr.data || {}; data[key] = data[key] && typeof data[key] === "object" ? data[key] : {};
    if (!data[key].docNo) { data[key].docNo = await nextDocNo(db, RD_SUBDOCS[key], new Date()); data[key].issuedAt = new Date().toISOString(); data[key].issuedBy = m.email; }
    await db`update costing.projects set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(pr.id)}`;
    await log(db, m.email, "issueProjectDoc", String(pr.pdr_no) + " · " + data[key].docNo);
    return projOut({ ...pr, data, updated_by: m.email, updated_at: new Date() });
  });
}

/* ---- ตัวอย่างที่ส่งให้ลูกค้า (FM-RD-04) และผลประเมิน (FM-RD-05) ---- */
const sampleOut = (r: Any, base: string) => ({ id: String(r.id), docNo: String(r.doc_no || ""), projectId: String(r.project_id), kind: String(r.kind), items: Array.isArray(r.items) ? r.items : [],
  requestedAt: iso(r.requested_at), shippedAt: iso(r.shipped_at), arrivalAt: iso(r.arrival_at), rdBy: String(r.rd_by || ""), saBy: String(r.sa_by || ""), note: String(r.note || ""),
  status: String(r.status), evalDocNo: String(r.eval_doc_no || ""), evalLink: r.eval_token && base ? base + "eval/" + String(r.eval_token) : "", eval: r.eval || {},
  createdAt: iso(r.created_at), createdBy: String(r.created_by || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
function cleanItems(v: Any) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 30).map((x: Any) => ({ code: str(x && x.code, 40), name: str(x && x.name, 160), scentId: str(x && x.scentId, 40), formulaCode: str(x && x.formulaCode, 40), size: str(x && x.size, 40), qty: numOrNull(x && x.qty) }))
    .filter((x: Any) => x.code || x.name || x.scentId);
}
const evalBase = async (db: Db) => { const u = await appUrl(db); return u.endsWith("/") ? u : u + "/"; };
async function listSamples(ctx: Ctx, projectId: string) {
  await needAny(ctx, RD_VIEW); const db = ctx.db, base = await evalBase(db);
  const rows = projectId ? await db`select * from costing.samples where project_id = ${String(projectId)} order by created_at` : await db`select * from costing.samples order by created_at desc limit 500`;
  return rows.map((r: Any) => sampleOut(r, base));
}
async function saveSample(ctx: Ctx, s: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    s = s || {};
    const pr = (await db`select * from costing.projects where id = ${str(s.projectId, 40)}`)[0];
    if (!pr) throw new Error("ไม่พบโครงการของตัวอย่างนี้");
    const kind = SAMPLE_KINDS[s.kind] ? String(s.kind) : "scent";
    const items = cleanItems(s.items);
    if (!items.length) throw new Error("ใส่รายการตัวอย่างอย่างน้อย 1 รายการ");
    const now = new Date(), ex = s.id ? (await db`select * from costing.samples where id = ${String(s.id)}`)[0] : null;
    if (s.id && !ex) throw new Error("ไม่พบชุดตัวอย่างนี้");
    if (ex && String(ex.status) === "evaluated") throw new Error("ชุดตัวอย่างที่ลูกค้าประเมินแล้วแก้ไขไม่ได้ สร้างชุดใหม่แทน");
    const row = { id: ex ? String(ex.id) : "x" + uuid(12), doc_no: ex ? String(ex.doc_no) : await nextDocNo(db, "FM-RD-04", now), project_id: String(pr.id), kind, items: db.json(items),
      requested_at: ts(s.requestedAt), shipped_at: ts(s.shippedAt), arrival_at: ts(s.arrivalAt), rd_by: str(s.rdBy, 120), sa_by: str(s.saBy, 120), note: str(s.note, 2000),
      status: ex ? String(ex.status) : "draft", eval_token: ex ? ex.eval_token : null, eval_doc_no: ex ? String(ex.eval_doc_no || "") : "", eval: db.json(ex ? ex.eval || {} : {}),
      created_at: ex ? ex.created_at : now, created_by: ex ? String(ex.created_by) : m.email, updated_at: now, updated_by: m.email };
    if (ex) await db`update costing.samples set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`;
    else await db`insert into costing.samples ${db(row)}`;
    await log(db, m.email, "saveSample", String(pr.pdr_no) + " · " + row.doc_no + " · " + kind + " × " + items.length);
    return sampleOut({ ...row, items, eval: ex ? ex.eval || {} : {} }, await evalBase(db));
  });
}
/** ส่งตัวอย่าง: บันทึกวันส่ง สร้างลิงก์ประเมิน และบันทึกวันที่จริงของขั้นในโครงการ */
async function sendSample(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const ex = (await db`select * from costing.samples where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบชุดตัวอย่างนี้");
    if (String(ex.status) === "evaluated") throw new Error("ชุดนี้ประเมินแล้ว");
    if (String(ex.kind) === "scent") {
      const n = (Array.isArray(ex.items) ? ex.items : []).length;
      const prior = (await db`select 1 from costing.samples where project_id = ${String(ex.project_id)} and kind = 'scent' and status = 'evaluated' limit 1`).length > 0;
      if (!prior && n !== RD_DIRECTIONS) throw new Error(`ตัวอย่างกลิ่นรอบแรกต้องเสนอ ${RD_DIRECTIONS} แนวทาง (ชุดนี้มี ${n}) · รอบแก้ไขหลังลูกค้าเลือกแล้วส่งกี่กลิ่นก็ได้`);
    }
    const now = new Date(), token = ex.eval_token || uuid(24), shipped = ex.shipped_at || now;
    await db`update costing.samples set status = 'sent', eval_token = ${token}, shipped_at = ${shipped}, updated_at = now(), updated_by = ${m.email} where id = ${String(ex.id)}`;
    const pr = (await db`select * from costing.projects where id = ${String(ex.project_id)}`)[0];
    if (pr) { const key = String(ex.kind) === "mockup" ? "s5send" : "s3send", actual = { ...(pr.actual || {}) }; if (!actual[key]) actual[key] = now.toISOString(); await db`update costing.projects set actual = ${db.json(actual)}, updated_at = now() where id = ${String(pr.id)}`; }
    await log(db, m.email, "sendSample", String(ex.doc_no) + " · ส่งแล้ว");
    return sampleOut({ ...ex, status: "sent", eval_token: token, shipped_at: shipped, updated_by: m.email, updated_at: now }, await evalBase(db));
  });
}
async function deleteSample(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db;
    const ex = (await db`select * from costing.samples where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบชุดตัวอย่างนี้");
    if (String(ex.status) === "evaluated" && !isAdmin(m)) throw new Error("ชุดที่ประเมินแล้วลบได้เฉพาะผู้ดูแลระบบ");
    await db`delete from costing.samples where id = ${String(ex.id)}`;
    await log(db, m.email, "deleteSample", String(ex.doc_no));
    return { deleted: String(ex.id) };
  });
}
/** สรุปผลประเมินของลูกค้า (FM-RD-11): period = "YYYY-MM" (รายเดือน) หรือ "YYYY" (รายปี) ตามเวลาไทย */
async function evalSummary(ctx: Ctx, period: string, kind: string) {
  await needAny(ctx, RD_VIEW); const db = ctx.db;
  period = str(period, 7); kind = SAMPLE_KINDS[kind] ? kind : "scent";
  if (!/^\d{4}(-\d{2})?$/.test(period)) throw new Error("ช่วงเวลาไม่ถูกต้อง");
  const rows = await db`select s.*, p.company, p.brand, p.pdr_no from costing.samples s join costing.projects p on p.id = s.project_id where s.status = 'evaluated' and s.kind = ${kind} and (s.eval->>'submittedAt') like ${period + "%"} order by s.eval->>'submittedAt'`;
  const out: Any[] = [];
  rows.forEach((r: Any) => { const ev = r.eval || {}; (Array.isArray(ev.items) ? ev.items : []).forEach((it: Any) => {
    const sc = it.scores || {}, vals = EVAL_FIELDS.map((f) => Number(sc[f]) || 0), total = vals.reduce((a, b) => a + b, 0);
    if (!total) return;   /* ผลที่นำเข้าจากทะเบียนเดิมไม่มีคะแนนรายด้าน ไม่นับในสรุป */
    out.push({ pdrNo: String(r.pdr_no), company: String(r.company || ""), brand: String(r.brand || ""), docNo: String(r.eval_doc_no || ""), code: String(it.code || ""), name: String(it.name || ""), formulaCode: String(it.formulaCode || ""),
      scores: Object.fromEntries(EVAL_FIELDS.map((f, i) => [f, vals[i]])), total, pct: Math.round(total / 30 * 10000) / 100, decision: String(it.decision || ""), comment: String(it.comment || ""), submittedAt: String(ev.submittedAt || ""), email: String(ev.email || "") }); }); });
  const n = out.length, avg = n ? Math.round(out.reduce((a, r) => a + r.pct, 0) / n * 100) / 100 : 0;
  return { period, kind, rows: out, count: n, avgPct: avg, passPct: Number(await getSetting(db, "evalPassPct")) || 80 };
}
const hx = (s: unknown) => String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
/** หน้าประเมินตัวอย่างสำหรับลูกค้า (สาธารณะ ผ่าน token ของชุดตัวอย่าง) */
async function evalPage(token: string): Promise<Response> {
  const html = (body: string, title = "ประเมินตัวอย่าง · Scent & Sense") => new Response(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${hx(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif;background:#f6f3ee;color:#1f2430;line-height:1.5}.wrap{max-width:720px;margin:0 auto;padding:20px 16px 60px}.card{background:#fff;border:1px solid #e6e1d8;border-radius:14px;padding:18px 18px 14px;margin:14px 0}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 8px}.muted{color:#6b7280;font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.crit{display:grid;grid-template-columns:1fr auto;gap:6px 10px;align-items:center;padding:6px 0;border-top:1px solid #f0ece5}.crit:first-of-type{border-top:0}
.scale{display:flex;gap:4px}.scale label{width:36px;height:36px;border:1px solid #cfc8bb;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-weight:600;background:#fff}.scale input{display:none}.scale input:checked+span{background:#1f3a5f;color:#fff;border-radius:7px;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
textarea,input[type=email]{width:100%;box-sizing:border-box;border:1px solid #cfc8bb;border-radius:8px;padding:9px 10px;font:inherit}.dec label{display:inline-flex;align-items:center;gap:6px;border:1px solid #cfc8bb;border-radius:999px;padding:6px 12px;margin:4px 6px 0 0;cursor:pointer;background:#fff}.dec input:checked+span{font-weight:700}.dec label:has(input:checked){background:#e9f1fb;border-color:#1f3a5f}
button{background:#1f3a5f;color:#fff;border:0;border-radius:10px;padding:12px 20px;font:inherit;font-weight:700;cursor:pointer;width:100%}button:disabled{opacity:.6}.ok{background:#e5f4e4;border-color:#b7dcb5}.bad{color:#b42318}.brandbar{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a6a4b;font-weight:700}</style></head><body><div class="wrap">${body}</div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const r = (await sql`select s.*, p.company, p.brand, p.pdr_no from costing.samples s join costing.projects p on p.id = s.project_id where s.eval_token = ${str(token, 40)}`)[0];
  if (!r) return html(`<div class="card"><h1>ไม่พบแบบประเมิน</h1><p class="muted">ลิงก์อาจหมดอายุหรือพิมพ์ไม่ครบ กรุณาติดต่อเจ้าหน้าที่ Scent & Sense</p></div>`, "ไม่พบแบบประเมิน");
  const items = Array.isArray(r.items) ? r.items : [], ev = r.eval || {}, done = String(r.status) === "evaluated";
  const CRIT = [["scent", "กลิ่น (Scent)"], ["appearance", "สี / ลักษณะภายนอก (Appearance)"], ["skinfeel", "ความรู้สึกหลังใช้งาน (Skin feel)"], ["target", "ความเหมาะสมกับกลุ่มเป้าหมาย (Target fit)"], ["brand", "ความเหมาะสมกับแบรนด์ (Brand alignment)"], ["overall", "ความชอบโดยรวม (Overall liking)"]];
  const prev = (code: string) => (Array.isArray(ev.items) ? ev.items : []).find((x: Any) => x.code === code) || {};
  const isScent = String(r.kind) === "scent", pk = ev.pick || {};
  const itemHtml = (it: Any, i: number) => { const pv = prev(it.code); return `<div class="card" data-item="${i}"><h2>${hx(it.code || "ตัวอย่าง " + (i + 1))}${it.name ? " · " + hx(it.name) : ""}</h2>${it.size ? `<div class="muted">${hx(it.size)}${it.qty ? " × " + hx(it.qty) : ""}</div>` : ""}
    ${CRIT.map(([k, l]) => `<div class="crit"><span>${l}</span><div class="scale">${[1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="s${i}_${k}" value="${v}" ${Number((pv.scores || {})[k]) === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div></div>`).join("")}
    <div style="margin-top:8px"><div class="muted">ความเห็น / ข้อเสนอแนะ</div><textarea name="c${i}" rows="2" maxlength="1000">${hx(pv.comment || "")}</textarea></div>
    ${isScent ? "" : `<div class="dec" style="margin-top:8px"><div class="muted">ตัวอย่างนี้เหมาะสำหรับ</div><label><input type="radio" name="d${i}" value="produce" ${pv.decision === "produce" ? "checked" : ""}><span>ผลิตจริงต่อไป</span></label><label><input type="radio" name="d${i}" value="revise" ${pv.decision === "revise" ? "checked" : ""}><span>ปรับแก้แล้วส่งใหม่</span></label><label><input type="radio" name="d${i}" value="reject" ${pv.decision === "reject" ? "checked" : ""}><span>ไม่เลือก</span></label></div>`}</div>`; };
  const pickHtml = !isScent ? "" : `<div class="card" id="pick"><h2>เลือก 1 กลิ่นที่จะไปต่อ *</h2><div class="muted">จาก ${items.length} แนวทางที่ส่งมา เลือกได้กลิ่นเดียว</div>
    <div class="dec">${items.map((it: Any, i: number) => `<label><input type="radio" name="pick" value="${i}" ${Number(pk.idx) === i && pk.action ? "checked" : ""}><span>${hx(it.code || "ตัวอย่าง " + (i + 1))}${it.name ? " · " + hx(it.name) : ""}</span></label>`).join("")}</div>
    <div class="muted" style="margin-top:10px">กลิ่นที่เลือกจะนำไป</div><div class="dec"><label><input type="radio" name="pickAct" value="produce" ${pk.action === "produce" ? "checked" : ""}><span>ไปต่อ · ผลิตจริงต่อไป</span></label><label><input type="radio" name="pickAct" value="revise" ${pk.action === "revise" ? "checked" : ""}><span>นำไปแก้ไขแล้วส่งใหม่</span></label></div></div>`;
  const body = `<div class="brandbar">Scent &amp; Sense · แผนกวิจัยและพัฒนา</div><h1>แบบประเมิน${String(r.kind) === "mockup" ? "ต้นแบบผลิตภัณฑ์" : "ตัวอย่างกลิ่น"}</h1>
    <div class="muted">${hx(r.brand || r.company)}${r.brand && r.company ? " · " + hx(r.company) : ""} · เอกสาร ${hx(r.doc_no)} · ส่งเมื่อ ${r.shipped_at ? hx(bkk(new Date(r.shipped_at)).slice(0, 10)) : "-"}</div>
    ${done ? `<div class="card ok"><b>ประเมินแล้ว</b> เมื่อ ${hx(bkk(new Date(ev.submittedAt || Date.now())))} โดย ${hx(ev.email || "")} · แก้ไขคำตอบได้ด้านล่างแล้วกดส่งอีกครั้ง</div>` : `<div class="card"><p style="margin:0">${isScent ? "ให้คะแนน 1 (น้อย) ถึง 5 (มาก) ทุกกลิ่นที่ส่งมา " + items.length + " แนวทาง แล้วเลือก 1 กลิ่นที่จะไปต่อ (ผลิตจริง) หรือนำไปแก้ไข" : "ให้คะแนน 1 (น้อย) ถึง 5 (มาก) ในแต่ละด้าน และเลือกว่าตัวอย่างใดให้ผลิตจริงต่อไป"} ใช้เวลาประมาณ 2 นาที</p></div>`}
    <form id="f">${items.map(itemHtml).join("")}${pickHtml}
    <div class="card"><div class="muted">ความเห็นเพิ่มเติมโดยรวม</div><textarea name="note" rows="3" maxlength="2000">${hx(ev.note || "")}</textarea>
      <div style="margin-top:10px"><div class="muted">อีเมลผู้ประเมิน *</div><input type="email" name="email" required value="${hx(ev.email || "")}" placeholder="name@company.com"></div>
      <div style="margin-top:14px"><button type="submit" id="go">ส่งผลประเมิน</button></div><div id="msg" class="muted" style="margin-top:8px" aria-live="polite"></div></div></form>
    <script>const F=document.getElementById('f'),M=document.getElementById('msg');F.addEventListener('submit',async e=>{e.preventDefault();const b=document.getElementById('go');const items=[...document.querySelectorAll('[data-item]')].map((el,i)=>{const sc={};['scent','appearance','skinfeel','target','brand','overall'].forEach(k=>{const r=el.querySelector('input[name="s'+i+'_'+k+'"]:checked');sc[k]=r?+r.value:0});const d=el.querySelector('input[name="d'+i+'"]:checked');return {idx:i,scores:sc,comment:el.querySelector('[name="c'+i+'"]').value,decision:d?d.value:''}});
    const miss=items.find(x=>Object.values(x.scores).some(v=>!v));if(miss){M.innerHTML='<span class="bad">ให้คะแนนให้ครบทุกด้านของตัวอย่างที่ '+(miss.idx+1)+'</span>';return}
    const pk=document.querySelector('input[name="pick"]:checked'),pa=document.querySelector('input[name="pickAct"]:checked');if(document.getElementById('pick')&&(!pk||!pa)){M.innerHTML='<span class="bad">เลือก 1 กลิ่นที่จะไปต่อ และระบุว่าจะผลิตจริงหรือนำไปแก้ไข</span>';document.getElementById('pick').scrollIntoView({behavior:'smooth'});return}
    b.disabled=true;M.textContent='กำลังส่ง…';try{const r=await fetch('${hx((Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/api?evalSubmit=" + token)}',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({items,note:F.note.value,email:F.email.value,pick:pk?{idx:+pk.value,action:pa?pa.value:''}:null})});const j=await r.json();if(!j.ok)throw new Error(j.error||'ส่งไม่สำเร็จ');M.innerHTML='<b style="color:#1a7f37">ขอบคุณครับ ระบบบันทึกผลประเมินแล้ว</b> ทีม Scent &amp; Sense จะติดต่อกลับโดยเร็ว';window.scrollTo(0,document.body.scrollHeight)}catch(err){M.innerHTML='<span class="bad">'+(err.message||err)+'</span>';b.disabled=false}});</script>`;
  return html(body);
}
async function evalSubmit(token: string, body: Any): Promise<Any> {
  token = str(token, 40); body = body || {};
  const email = str(body.email, 160).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("ใส่อีเมลผู้ประเมินให้ถูกต้อง");
  return await sql.begin(async (db: Db) => {
    await db`select pg_advisory_xact_lock(7001)`;
    const ex = (await db`select * from costing.samples where eval_token = ${token}`)[0];
    if (!ex) throw new Error("ไม่พบแบบประเมิน");
    const items = Array.isArray(ex.items) ? ex.items : [], ans = Array.isArray(body.items) ? body.items : [];
    const evItems = items.map((it: Any, i: number) => { const a = ans.find((x: Any) => Number(x && x.idx) === i) || {}; const scores: Record<string, number> = {};
      EVAL_FIELDS.forEach((f) => { const v = Math.round(Number((a.scores || {})[f])); scores[f] = v >= 1 && v <= 5 ? v : 0; });
      return { code: String(it.code || ""), name: String(it.name || ""), scentId: String(it.scentId || ""), formulaCode: String(it.formulaCode || ""), scores, comment: str(a.comment, 1000), decision: EVAL_DECISIONS[a.decision] ? String(a.decision) : "" }; });
    if (evItems.some((x: Any) => EVAL_FIELDS.some((f) => !x.scores[f]))) throw new Error("ให้คะแนนให้ครบทุกด้าน");
    let pick: Any = null;
    if (String(ex.kind) === "scent") {   /* ตัวอย่างกลิ่น: ลูกค้าเลือก 1 กลิ่น ที่เหลือถือว่าไม่เลือก */
      const pb = body.pick || {}, idx = Math.round(Number(pb.idx)), act = String(pb.action || "");
      if (!(idx >= 0 && idx < evItems.length) || (act !== "produce" && act !== "revise")) throw new Error("เลือก 1 กลิ่นที่จะไปต่อ และระบุว่าจะผลิตจริงหรือนำไปแก้ไข");
      evItems.forEach((x: Any, i: number) => { x.decision = i === idx ? act : "reject"; });
      const it = evItems[idx]; pick = { idx, code: it.code, name: it.name, scentId: it.scentId, formulaCode: it.formulaCode, action: act };
    }
    const now = new Date(), old = ex.eval || {};
    const ev = { submittedAt: now.toISOString(), email, note: str(body.note, 2000), items: evItems, pick, produce: evItems.some((x: Any) => x.decision === "produce"),
      history: (Array.isArray(old.history) ? old.history : []).concat(old.submittedAt ? [{ submittedAt: old.submittedAt, email: old.email, items: old.items }] : []).slice(-10) };
    const evalDocNo = String(ex.eval_doc_no || "") || await nextDocNo(db, "FM-RD-05", now);
    await db`update costing.samples set status = 'evaluated', eval = ${db.json(ev)}, eval_doc_no = ${evalDocNo}, updated_at = now(), updated_by = ${"customer:" + email} where id = ${String(ex.id)}`;
    const pr = (await db`select * from costing.projects where id = ${String(ex.project_id)}`)[0];
    if (pr) { const key = String(ex.kind) === "mockup" ? "s5eval" : "s3eval", actual = { ...(pr.actual || {}) }, data = { ...(pr.data || {}) }; actual[key] = now.toISOString();
      if (pick) data.chosenScent = { ...pick, sampleId: String(ex.id), sampleDocNo: String(ex.doc_no || ""), evalDocNo, at: now.toISOString(), email };
      await db`update costing.projects set actual = ${db.json(actual)}, data = ${db.json(data)}, updated_at = now() where id = ${String(pr.id)}`; }
    if (pick && pick.action === "produce" && pick.scentId) await db`update costing.scents set status = 'approved', updated_at = now(), updated_by = ${"customer:" + email} where id = ${String(pick.scentId)} and status in ('draft', 'trial', 'sent')`;
    await log(db, "customer:" + email, "evalSubmit", String(ex.doc_no) + " → " + evalDocNo + (pick ? " · เลือก " + (pick.code || pick.name) + (pick.action === "produce" ? " ไปต่อ" : " นำไปแก้ไข") : ev.produce ? " · เลือกผลิตจริง" : ""));
    return { ok: true, docNo: evalDocNo };
  });
}
/** นำเข้าทะเบียน R&D เดิม (ลูกค้า โครงการ ตัวอย่าง) จากไฟล์ Excel — เจ้าของระบบเท่านั้น ทำซ้ำได้ (upsert ตาม id) */
async function importRd(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await me(c), db = c.db;
    if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
    d = d || {}; let nc = 0, np = 0, ns = 0, nsc = 0;
    for (const x of (Array.isArray(d.customers) ? d.customers : [])) { if (!x || (!x.company && !x.brand)) continue; await upsertCustomer(db, x, m.email); nc++; }
    for (const p of (Array.isArray(d.projects) ? d.projects : [])) {
      if (!p || !p.id) continue;
      const ex = (await db`select id from costing.projects where id = ${String(p.id)}`)[0];
      const row = { id: String(p.id), pdr_no: str(p.pdrNo, 20), doc_no: str(p.docNo, 40), customer_code: custCode(p.customerCode), company: str(p.company, 200), brand: str(p.brand, 200), so_no: str(p.soNo, 60),
        kind: RD_KINDS[p.kind] ? String(p.kind) : "new", title: str(p.title, 300), scent_count: Math.max(1, Number(p.scentCount) || 1), stage: RD_STAGES.indexOf(p.stage) >= 0 ? String(p.stage) : "s1",
        owners: db.json(cleanOwners(p.owners)), brief_id: "", ra: db.json(p.ra && typeof p.ra === "object" ? p.ra : {}), actual: db.json(p.actual && typeof p.actual === "object" ? p.actual : {}), data: db.json(rdData(p.data)),
        created_at: ts(p.createdAt) || new Date(), created_by: "import", updated_at: ts(p.updatedAt) || new Date(), updated_by: m.email };
      if (ex) await db`update costing.projects set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`; else await db`insert into costing.projects ${db(row)}`;
      np++;
    }
    for (const s of (Array.isArray(d.samples) ? d.samples : [])) {
      if (!s || !s.id || !s.projectId) continue;
      if (!(await db`select 1 from costing.projects where id = ${String(s.projectId)}`).length) continue;
      const ex = (await db`select id from costing.samples where id = ${String(s.id)}`)[0];
      const row = { id: String(s.id), doc_no: str(s.docNo, 40), project_id: String(s.projectId), kind: SAMPLE_KINDS[s.kind] ? String(s.kind) : "scent", items: db.json(cleanItems(s.items)),
        requested_at: ts(s.requestedAt), shipped_at: ts(s.shippedAt), arrival_at: ts(s.arrivalAt), rd_by: str(s.rdBy, 120), sa_by: str(s.saBy, 120), note: str(s.note, 2000),
        status: s.status === "evaluated" ? "evaluated" : s.status === "sent" ? "sent" : "draft", eval_token: null, eval_doc_no: str(s.evalDocNo, 40), eval: db.json(s.eval && typeof s.eval === "object" ? s.eval : {}),
        created_at: ts(s.createdAt) || new Date(), created_by: "import", updated_at: new Date(), updated_by: m.email };
      if (ex) await db`update costing.samples set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`; else await db`insert into costing.samples ${db(row)}`;
      ns++;
    }
    for (const s of (Array.isArray(d.scents) ? d.scents : [])) {   /* กลิ่นจากทะเบียน FM-RD-02: มีอยู่แล้ว → ผูกโครงการ+รหัสสูตร, ยังไม่มี → สร้างใหม่ */
      if (!s || !s.id) continue;
      const pid = str(s.projectId, 40), fc = str(s.formulaCode, 40);
      if (pid && !(await db`select 1 from costing.projects where id = ${pid}`).length) continue;
      const ex = (await db`select id from costing.scents where id = ${String(s.id)}`)[0];
      if (ex) { await db`update costing.scents set project_id = ${pid}, formula_code = ${fc} where id = ${String(s.id)}`; nsc++; continue; }
      const name = str(s.name, 160); if (!name) continue;
      await db`insert into costing.scents ${db({ id: String(s.id), code: str(s.code, 40) || ("SC-IMP-" + uuid(6).toUpperCase()), name, brief_id: "", family: str(s.family, 80), status: PF_SCENT_STATUS[s.status] ? String(s.status) : "trial",
        owner: "import", formula_id: "", project_id: pid, formula_code: fc, created_at: ts(s.createdAt) || new Date(), updated_at: new Date(), updated_by: m.email, data: db.json(pfData(s.data)) })}`;
      nsc++;
    }
    for (const q of (Array.isArray(d.docseq) ? d.docseq : [])) {   /* ตั้งตัวนับให้ต่อจากเลขเดิม */
      if (!q || !q.prefix || !q.period) continue;
      await db`insert into costing.docseq (prefix, period, n) values (${str(q.prefix, 20)}, ${str(q.period, 8)}, ${Math.max(0, Number(q.n) || 0)}) on conflict (prefix, period) do update set n = greatest(costing.docseq.n, excluded.n)`;
    }
    await log(db, m.email, "importRd", `customers ${nc} projects ${np} samples ${ns} scents ${nsc}`);
    return { customers: nc, projects: np, samples: ns, scents: nsc };
  });
}

/* ===== Product Development: สูตรพื้นฐาน (เบส) ของแต่ละประเภทสินค้า และสูตรผลิตภัณฑ์ที่นำกลิ่นจาก Perfumer มาผสมเบส ===== */
const PD_STATUS: Record<string, number> = { draft: 1, testing: 1, approved: 1, retired: 1 }, PD_MODES: Record<string, number> = { standard: 1, modified: 1 };
/** ส่วนประกอบหนึ่งแถว: รหัส RM (ราคาดึงจากฐานราคาตอนแสดงผล) · price = ราคาที่บันทึกไว้กับเบส · override = ราคาที่ผู้ใช้กำหนดเองในสูตร · frag = ช่องน้ำหอม */
function pdLines(v: Any) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 80).map((x: Any) => ({ part: str(x && x.part, 20), code: str(x && x.code, 40), name: str(x && x.name, 200), fn: str(x && x.fn, 120), pct: numOrNull(x && x.pct), price: numOrNull(x && x.price), override: numOrNull(x && x.override), frag: !!(x && x.frag), note: str(x && x.note, 200) }))
    .filter((x: Any) => x.name || x.code || x.frag);
}
function pdBaseData(b: Any) {
  return { targetPrice: numOrNull(b.targetPrice), shelfLife: str(b.shelfLife, 120), stability: str(b.stability, 200), benchmark: str(b.benchmark, 200), note: str(b.note, 2000),
    fragranceAdjustable: !!b.fragranceAdjustable, lines: pdLines(b.lines), source: b.source && typeof b.source === "object" ? b.source : {} };
}
const baseOut = (r: Any) => ({ id: String(r.id), category: String(r.category), name: String(r.name), active: !!r.active, sort: Number(r.sort) || 0, ...pdBaseData(r.data || {}),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function listPdBases(ctx: Ctx) {
  const m = await needAny(ctx, RD_VIEW);
  return (await ctx.db`select * from costing.pd_bases order by sort, category, name`).map((x: Any) => maskPd(m, baseOut(x)));
}
async function savePdBase(ctx: Ctx, b: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db; b = b || {};
    const category = str(b.category, 80), name = str(b.name, 200);
    if (!category || !name) throw new Error("ใส่ประเภทสินค้าและชื่อเบส");
    const data = pdBaseData(b);
    if (!data.lines.length) throw new Error("ใส่ส่วนประกอบอย่างน้อย 1 รายการ");
    if (JSON.stringify(data).length > RD_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป");
    const id = str(b.id, 60) || "base-" + uuid(10), now = new Date();
    const ex = (await db`select * from costing.pd_bases where id = ${id}`)[0];
    const row = { id, category, name, active: b.active === undefined ? true : !!b.active, sort: Number(b.sort) || (ex ? Number(ex.sort) : 0), data: db.json(data), updated_at: now, updated_by: m.email };
    if (ex) await db`update costing.pd_bases set ${db(row, "category", "name", "active", "sort", "data", "updated_at", "updated_by")} where id = ${id}`;
    else await db`insert into costing.pd_bases ${db({ ...row, created_at: now, created_by: m.email })}`;
    await log(db, m.email, ex ? "savePdBase" : "newPdBase", category + " · " + name);
    return baseOut((await db`select * from costing.pd_bases where id = ${id}`)[0]);
  });
}
async function deletePdBase(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db;
    const ex = (await db`select * from costing.pd_bases where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบเบสนี้");
    const used = Number((await db`select count(*)::int as n from costing.pd_formulas where base_id = ${String(ex.id)}`)[0].n);
    if (used > 0) throw new Error(`มีสูตรผลิตภัณฑ์ ${used} สูตรอ้างอิงเบสนี้ ให้ปิดใช้งานแทนการลบ`);
    await db`delete from costing.pd_bases where id = ${String(ex.id)}`;
    await log(db, m.email, "deletePdBase", String(ex.category) + " · " + String(ex.name));
    return { ok: true };
  });
}
/* ส่วนท้ายใบสูตร FM-RD-03 */
const pdSteps = (v: Any) => (Array.isArray(v) ? v : []).slice(0, 30).map((x: Any) => ({ step: str(x && x.step, 300), min: str(x && x.min, 20), temp: str(x && x.temp, 20), rpm: str(x && x.rpm, 20), equip: str(x && x.equip, 120), note: str(x && x.note, 200) })).filter((x: Any) => x.step || x.min || x.temp || x.rpm || x.equip || x.note);
const pdSpec = (v: Any) => { const a = Array.isArray(v) ? v : []; return [0, 1, 2, 3, 4, 5].map((i) => { const x: Any = a[i] || {}; return { target: str(x.target, 120), method: str(x.method, 120), limit: str(x.limit, 120), result: str(x.result, 120) }; }); };
const pdStab = (v: Any) => { const a = Array.isArray(v) ? v : []; return [0, 1, 2, 3, 4, 5].map((i) => { const x: Any = a[i] || {}; return { obs: x.obs === "0" || x.obs === "1" ? String(x.obs) : "", pf: x.pf === "pass" || x.pf === "fail" ? String(x.pf) : "", note: str(x.note, 300) }; }); };
const pdConcl = (v: Any) => { const x: Any = v || {}; return { result: ["pass", "cond", "fail"].includes(String(x.result)) ? String(x.result) : "", cond: str(x.cond, 300), fail: str(x.fail, 300) }; };
const pdDate = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
function pdFormulaData(f: Any) {
  return { category: str(f.category, 80), baseName: str(f.baseName, 200), mode: PD_MODES[f.mode] ? String(f.mode) : "standard", customer: str(f.customer, 200), brand: str(f.brand, 200),
    fragranceFormulaId: str(f.fragranceFormulaId, 60), fragranceScentId: str(f.fragranceScentId, 60), fragranceName: str(f.fragranceName, 200), fragranceCode: str(f.fragranceCode, 60), fragrancePrice: numOrNull(f.fragrancePrice),
    batchG: numOrNull(f.batchG), targetPrice: numOrNull(f.targetPrice), note: str(f.note, 3000), lines: pdLines(f.lines), approvedBy: str(f.approvedBy, 120), approvedAt: str(f.approvedAt, 40),
    /* หัวใบสูตร FM-RD-03 (Product Information) */
    productName: str(f.productName, 200), fgCode: str(f.fgCode, 60), revision: numOrNull(f.revision), purpose: str(f.purpose, 200), packaging: str(f.packaging, 200), fillQty: str(f.fillQty, 60), qty: numOrNull(f.qty),
    sampleDue: pdDate(f.sampleDue), designDate: pdDate(f.designDate), mockupRequest: pdDate(f.mockupRequest), mockupDate: pdDate(f.mockupDate), appearance: str(f.appearance, 120), colour: str(f.colour, 60), odor: str(f.odor, 120), perfumer: str(f.perfumer, 120), designer: str(f.designer, 120), operator: str(f.operator, 120),
    steps: pdSteps(f.steps), spec: pdSpec(f.spec), stab: pdStab(f.stab), concl: pdConcl(f.concl) };
}
const fmOut = (r: Any) => ({ id: String(r.id), code: String(r.code || ""), projectId: String(r.project_id || ""), name: String(r.name), baseId: String(r.base_id || ""), status: String(r.status), ...pdFormulaData(r.data || {}),
  createdAt: iso(r.created_at), createdBy: String(r.created_by || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
/** รหัสสูตรผลิตภัณฑ์ PDyymmNNN (นับต่อเดือน ชุดเดียวกับ PDR) */
async function nextPdCode(db: Db, at: Date) {
  const p = bkkParts(at), period = p.yyyy + p.mm;
  const r = await db`insert into costing.docseq (prefix, period, n) values ('PD', ${period}, 1) on conflict (prefix, period) do update set n = costing.docseq.n + 1 returning n`;
  return "PD" + p.yyyy.slice(2) + p.mm + String(Number(r[0].n)).padStart(3, "0");
}
async function listPdFormulas(ctx: Ctx, projectId?: string) {
  const m = await needAny(ctx, RD_VIEW); const db = ctx.db;
  const rows = projectId ? await db`select * from costing.pd_formulas where project_id = ${String(projectId)} order by updated_at desc` : await db`select * from costing.pd_formulas where created_by not like 'import:%' order by updated_at desc limit 1000`;   /* สูตรที่นำเข้าจากไฟล์ (หลายพันสูตร) ดูผ่าน searchPdImported */
  return rows.map((x: Any) => maskPd(m, fmOut(x)));
}
async function savePdFormula(ctx: Ctx, f: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db; f = f || {};
    const name = str(f.name, 200); if (!name) throw new Error("ใส่ชื่อสูตรผลิตภัณฑ์");
    const data = pdFormulaData(f);
    if (!data.lines.length) throw new Error("ใส่ส่วนประกอบอย่างน้อย 1 รายการ");
    if (JSON.stringify(data).length > RD_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป");
    const projectId = str(f.projectId, 40);
    if (projectId && !(await db`select 1 from costing.projects where id = ${projectId}`).length) throw new Error("ไม่พบโครงการนี้");
    if (data.fragranceScentId && !(await db`select 1 from costing.scents where id = ${data.fragranceScentId}`).length) throw new Error("ไม่พบกลิ่นนี้ในคลังกลิ่น");
    const baseId = str(f.baseId, 60);
    if (baseId && !(await db`select 1 from costing.pd_bases where id = ${baseId}`).length) throw new Error("ไม่พบเบสนี้");
    const status = PD_STATUS[f.status] ? String(f.status) : "draft";
    const ex = f.id ? (await db`select * from costing.pd_formulas where id = ${String(f.id)}`)[0] : null;
    if (f.id && !ex) throw new Error("ไม่พบสูตรนี้ (อาจถูกลบไปแล้ว)");
    const now = new Date();
    if (status === "approved") { if (!(ex && ex.status === "approved")) { data.approvedBy = m.email; data.approvedAt = now.toISOString(); } }
    else { data.approvedBy = ""; data.approvedAt = ""; }
    const id = ex ? String(ex.id) : "pdf-" + uuid(10), code = ex ? String(ex.code) : await nextPdCode(db, now);
    const row = { id, code, project_id: projectId, name, base_id: baseId, status, data: db.json(data), updated_at: now, updated_by: m.email };
    if (ex) await db`update costing.pd_formulas set ${db(row, "project_id", "name", "base_id", "status", "data", "updated_at", "updated_by")} where id = ${id}`;
    else await db`insert into costing.pd_formulas ${db({ ...row, created_at: now, created_by: m.email })}`;
    await log(db, m.email, ex ? "savePdFormula" : "newPdFormula", code + " · " + name + " · " + status);
    return fmOut((await db`select * from costing.pd_formulas where id = ${id}`)[0]);
  });
}
async function deletePdFormula(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db;
    const ex = (await db`select * from costing.pd_formulas where id = ${String(id || "")}`)[0];
    if (!ex) throw new Error("ไม่พบสูตรนี้");
    if (ex.status === "approved" && !isAdmin(m)) throw new Error("สูตรที่อนุมัติแล้วลบได้เฉพาะผู้ดูแล ให้เปลี่ยนสถานะเป็นเลิกใช้แทน");
    await db`delete from costing.pd_formulas where id = ${String(ex.id)}`;
    await log(db, m.email, "deletePdFormula", String(ex.code) + " · " + String(ex.name));
    return { ok: true };
  });
}
/** สูตรที่นำเข้าจากไฟล์ FM-RD-03 (ประวัติ): ค้นหาฝั่งเซิร์ฟเวอร์ เพราะมีหลายพันสูตร ไม่โหลดทั้งหมดขึ้นหน้าเว็บ */
async function searchPdImported(ctx: Ctx, q: string, limit?: number) {
  const m = await needAny(ctx, RD_VIEW); const db = ctx.db;
  q = str(q, 120); const n = Math.min(500, Math.max(1, Number(limit) || 200));
  const like = "%" + q.replace(/[%_\\]/g, (ch) => "\\" + ch) + "%";
  const rows = q
    ? await db`select * from costing.pd_formulas where created_by like 'import:%' and (code ilike ${like} or name ilike ${like} or data::text ilike ${like}) order by created_at desc nulls last, code limit ${n}`
    : await db`select * from costing.pd_formulas where created_by like 'import:%' order by created_at desc nulls last, code limit ${n}`;
  const total = Number((await db`select count(*)::int as n from costing.pd_formulas where created_by like 'import:%'`)[0].n);
  return { total, items: rows.map((x: Any) => maskPd(m, fmOut(x))) };
}
/** รายชื่อลูกค้าในสูตร Product Development ทั้งหมด (รวมสูตรที่นำเข้าจากไฟล์) + จำนวนสูตร · ใช้เป็นตัวเลือก "ลูกค้า" ในหน้าส่วนประกอบฉลาก */
async function listPdCustomers(ctx: Ctx) {
  await needAny(ctx, RD_VIEW);
  const rows = await ctx.db`select data->>'customer' as customer, count(*)::int as n from costing.pd_formulas where coalesce(data->>'customer', '') <> '' group by 1 order by 1`;
  return rows.map((x: Any) => ({ customer: String(x.customer), n: Number(x.n) }));
}
/** สูตรของลูกค้ารายหนึ่ง (แบบย่อ ไม่มีส่วนประกอบ) · ชื่อลูกค้าต้องตรงทั้งชื่อ */
async function listPdByCustomer(ctx: Ctx, customer: string) {
  await needAny(ctx, RD_VIEW);
  const c = str(customer, 200); if (!c) throw new Error("ระบุลูกค้า");
  const rows = await ctx.db`select id, code, name, status, data->>'brand' as brand, jsonb_array_length(coalesce(data->'lines', '[]'::jsonb)) as n_lines, created_at, updated_at from costing.pd_formulas where data->>'customer' = ${c} order by created_at desc nulls last, code limit 600`;
  return rows.map((x: Any) => ({ id: String(x.id), code: String(x.code || ""), name: String(x.name), status: String(x.status), brand: String(x.brand || ""), nLines: Number(x.n_lines) || 0, createdAt: iso(x.created_at), updatedAt: iso(x.updated_at) }));
}
/** ค้นหาสูตร Product Development ทุกสถานะ (รวมสูตรนำเข้า) จากรหัสสูตร/ชื่อสูตร/ชื่อสินค้า/รหัสสินค้า(FG)/รหัสตัวอย่าง/แบรนด์/ชื่อลูกค้า · กรองตามลูกค้าได้ (ชื่อตรงทั้งชื่อ) · แบบย่อ ไม่มีส่วนประกอบ */
async function searchPdFormulas(ctx: Ctx, q: string, customer?: string) {
  await needAny(ctx, RD_VIEW); const db = ctx.db;
  q = str(q, 120).trim(); if (!q) throw new Error("พิมพ์คำค้น");
  const like = "%" + q.replace(/[%_\\]/g, (ch) => "\\" + ch) + "%", cu = str(customer, 200);
  const rows = await db`select id, code, name, status, data->>'brand' as brand, data->>'customer' as customer, jsonb_array_length(coalesce(data->'lines', '[]'::jsonb)) as n_lines, updated_at from costing.pd_formulas
    where (code ilike ${like} or name ilike ${like} or data->>'customer' ilike ${like} or data->>'brand' ilike ${like} or data->>'productName' ilike ${like} or data->>'fgCode' ilike ${like} or data->>'fragranceCode' ilike ${like} or data->>'fragranceName' ilike ${like})
    and (${cu} = '' or data->>'customer' = ${cu}) order by (code ilike ${q}) desc, updated_at desc, code limit 100`;
  return rows.map((x: Any) => ({ id: String(x.id), code: String(x.code || ""), name: String(x.name), status: String(x.status), brand: String(x.brand || ""), customer: String(x.customer || ""), nLines: Number(x.n_lines) || 0, updatedAt: iso(x.updated_at) }));
}
/** คีย์สำหรับตัดสูตร Perfumer ที่ซ้ำกับสูตร PD ออก (ชื่อสูตร/ชื่อตัวอย่างน้ำหอม + รหัสสูตร/รหัสสินค้า/รหัสตัวอย่าง ตัวพิมพ์เล็ก) */
async function listPdDupKeys(ctx: Ctx) {
  await needAny(ctx, RD_VIEW);
  const rows = await ctx.db`select lower(btrim(name)) as n, lower(btrim(code)) as c, lower(btrim(coalesce(data->>'fragranceCode', ''))) as fc, lower(btrim(coalesce(data->>'fgCode', ''))) as fg, lower(btrim(coalesce(data->>'fragranceName', ''))) as fn from costing.pd_formulas`;
  const names = new Set<string>(), codes = new Set<string>();
  rows.forEach((x: Any) => { if (x.n) names.add(String(x.n)); if (x.fn) names.add(String(x.fn)); [x.c, x.fc, x.fg].forEach((v: Any) => { if (v) codes.add(String(v)); }); });
  return { names: [...names], codes: [...codes] };
}
async function getPdFormula(ctx: Ctx, id: string) {
  const m = await needAny(ctx, RD_VIEW);
  const x = (await ctx.db`select * from costing.pd_formulas where id = ${str(id, 60)}`)[0];
  if (!x) throw new Error("ไม่พบสูตรนี้");
  return maskPd(m, fmOut(x));
}
/** นำเข้าสูตรต้นแบบจากไฟล์ FM-RD-03 (เจ้าของระบบเท่านั้น · upsert ตาม id imp-fm03-… ทำซ้ำได้ · created_by = import:fm03) */
async function importPdFormulas(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await me(c), db = c.db;
    if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
    let n = 0, skipped = 0;
    for (const f of (Array.isArray(d && d.items) ? d.items : [])) {
      if (!f || !/^imp-fm03-[a-z0-9]{6,20}$/.test(String(f.id || ""))) { skipped++; continue; }
      const name = str(f.name, 200), data = pdFormulaData(f);
      if (!name || !data.lines.length || JSON.stringify(data).length > RD_DATA_MAX) { skipped++; continue; }
      const id = String(f.id), status = PD_STATUS[f.status] ? String(f.status) : "draft", now = new Date();
      const ex = (await db`select id from costing.pd_formulas where id = ${id}`)[0];
      const row = { id, code: str(f.code, 40), project_id: "", name, base_id: "", status, data: db.json(data), updated_at: now, updated_by: m.email };
      if (ex) await db`update costing.pd_formulas set ${db(row, "code", "name", "status", "data", "updated_at", "updated_by")} where id = ${id}`;
      else await db`insert into costing.pd_formulas ${db({ ...row, created_at: ts(f.createdAt) || now, created_by: "import:fm03" })}`;
      n++;
    }
    await log(db, m.email, "importPdFormulas", `formulas ${n} skipped ${skipped}`);
    return { imported: n, skipped };
  });
}
/* ===== คลังส่วนประกอบฉลาก: เก็บผลคำนวณส่วนประกอบบนฉลาก (Ingredients) ต่อสูตรไว้เป็นประวัติ · ดู/ค้นหาได้ทุกคนที่ดูหน้า อย. · ลบได้เฉพาะผู้บันทึกหรือแอดมิน ===== */
const LBL_TYPES: Record<string, number> = { leave: 1, rinse: 1, home: 1, oil: 1 }, LBL_SRC: Record<string, number> = { pd: 1, pf: 1, manual: 1 };
const lblOut = (r: Any, full: boolean) => {
  const o: Any = { id: String(r.id), docNo: String(r.doc_no), rev: Number(r.rev) || 1, src: String(r.src), formulaId: String(r.formula_id || ""), formulaCode: String(r.formula_code || ""), formulaName: String(r.formula_name || ""),
    customer: String(r.customer || ""), brand: String(r.brand || ""), type: String(r.type), list: String(r.list || ""), fragName: String(r.frag_name || ""), minPct: numOrNull(r.min_pct), lineSum: numOrNull(r.line_sum),
    ingredients: String(r.ingredients || ""), note: String(r.note || ""), nRows: Number(r.n_rows) || 0, nHidden: Number(r.n_hidden) || 0, createdAt: iso(r.created_at), createdBy: String(r.created_by || "") };
  if (full) { o.rows = r.rows || []; o.hidden = r.hidden || []; o.warnings = r.warnings || []; }
  return o;
};
async function listLabelArchive(ctx: Ctx) {
  await needAny(ctx, FDA_VIEW);
  const rows = await ctx.db`select id, doc_no, rev, src, formula_id, formula_code, formula_name, customer, brand, type, list, frag_name, min_pct, line_sum, ingredients, note, created_at, created_by,
    jsonb_array_length(rows) as n_rows, jsonb_array_length(hidden) as n_hidden from costing.label_archive order by created_at desc limit 3000`;
  return rows.map((r: Any) => lblOut(r, false));
}
async function getLabelArchive(ctx: Ctx, id: string) {
  await needAny(ctx, FDA_VIEW);
  const r = await ctx.db`select *, jsonb_array_length(rows) as n_rows, jsonb_array_length(hidden) as n_hidden from costing.label_archive where id = ${str(id, 60)}`;
  if (!r.length) throw new Error("ไม่พบรายการในคลัง");
  return lblOut(r[0], true);
}
async function saveLabelArchive(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_VIEW), db = c.db; d = d || {};
    const ingredients = str(d.ingredients, 8000);
    const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 400).map((x: Any) => ({ inci: str(x && x.inci, 300), cas: str(x && x.cas, 200), pct: numOrNull(x && x.pct), kind: x && (x.kind === "a26" || x.kind === "a83") ? String(x.kind) : "",
      banned: !!(x && x.banned), unknown: !!(x && x.unknown), frag: !!(x && x.frag) })).filter((x: Any) => x.inci);
    if (!ingredients || !rows.length) throw new Error("ไม่มีส่วนประกอบให้บันทึก");
    const hidden = (Array.isArray(d.hidden) ? d.hidden : []).slice(0, 400).map((x: Any) => ({ inci: str(x && x.inci, 300), pct: numOrNull(x && x.pct) })).filter((x: Any) => x.inci);
    const warnings = (Array.isArray(d.warnings) ? d.warnings : []).slice(0, 60).map((w: unknown) => str(w, 400)).filter(Boolean);
    const src = LBL_SRC[d.src] ? String(d.src) : "manual", type = LBL_TYPES[d.type] ? String(d.type) : "leave", fid = str(d.formulaId, 60);
    const now = new Date(), year = String(bkkYear(now));
    const seq = await db`insert into costing.docseq (prefix, period, n) values ('LBL', ${year}, 1) on conflict (prefix, period) do update set n = costing.docseq.n + 1 returning n`;
    const docNo = "LBL-" + year + "-" + ("0000" + String(Number(seq[0].n))).slice(-4);
    const rev = fid ? Number((await db`select count(*)::int as n from costing.label_archive where src = ${src} and formula_id = ${fid} and type = ${type}`)[0].n) + 1 : 1;
    const id = "lbl-" + uuid(10);
    await db`insert into costing.label_archive ${db({ id, doc_no: docNo, rev, src, formula_id: fid, formula_code: str(d.formulaCode, 60), formula_name: str(d.formulaName, 300), customer: str(d.customer, 200), brand: str(d.brand, 200),
      type, list: d.list === "a26" ? "a26" : "a83", frag_name: str(d.fragName, 40), min_pct: numOrNull(d.minPct), line_sum: numOrNull(d.lineSum), ingredients, rows: db.json(rows), hidden: db.json(hidden), warnings: db.json(warnings),
      note: str(d.note, 500), created_at: now, created_by: m.email })}`;
    await log(db, m.email, "saveLabelArchive", docNo + " · " + (str(d.formulaCode, 60) || str(d.formulaName, 100)) + " (rev " + rev + ")");
    return { id, docNo, rev, createdAt: now.toISOString() };
  });
}
async function deleteLabelArchive(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_VIEW), db = c.db;
    const r = await db`select doc_no, created_by from costing.label_archive where id = ${str(id, 60)}`;
    if (!r.length) throw new Error("ไม่พบรายการในคลัง");
    if (!isAdmin(m) && String(r[0].created_by).toLowerCase() !== m.email) throw new Error("FORBIDDEN");
    await db`delete from costing.label_archive where id = ${str(id, 60)}`;
    await log(db, m.email, "deleteLabelArchive", String(r[0].doc_no));
    return { ok: true };
  });
}

/* ===== ประวัติขอราคา: รายการที่ RD ส่งสูตรให้ RA/พี่เจคิดราคา และราคาที่ส่งกลับ SA (นำเข้าจากไฟล์ติดตามโครงการ) · เห็นได้เฉพาะแอดมิน (มีราคา) ===== */
const pqOut = (r: Any) => ({ id: String(r.id), line: Number(r.line) || 0, customer: String(r.customer || ""), scentName: String(r.scent_name || ""), scentCode: String(r.scent_code || ""), product: String(r.product || ""), formulaDate: String(r.formula_date || ""),
  dueSa: String(r.due_sa || ""), rdBy: String(r.rd_by || ""), raBy: String(r.ra_by || ""), rdDue: String(r.rd_due || ""), sentAt: String(r.sent_at || ""), price: numOrNull(r.price), priceRaw: String(r.price_raw || ""), price2Raw: String(r.price2_raw || ""),
  note: String(r.note || ""), remark: String(r.remark || ""), projectId: String(r.project_id || "") });
async function listPriceQuotes(ctx: Ctx) {
  await needAdmin(ctx);
  const rows = await ctx.db`select * from costing.price_quotes order by coalesce(nullif(sent_at, ''), nullif(formula_date, ''), '') desc, line desc limit 5000`;
  return rows.map(pqOut);
}
/** นำเข้าประวัติขอราคาจากไฟล์ (เจ้าของระบบเท่านั้น · upsert ตาม id ทำซ้ำได้) แล้วผูกกับโครงการจากรหัสกลิ่น หรือชื่อลูกค้า */
async function importPriceQuotes(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await me(c), db = c.db;
    if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
    const items = Array.isArray(d && d.items) ? d.items : []; if (items.length > 500) throw new Error("ส่งได้ครั้งละไม่เกิน 500 รายการ");
    const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    let n = 0, skipped = 0; const now = new Date();
    for (const x of items) {
      if (!x || !/^pq26-[0-9]{1,6}$/.test(String(x.id || "")) || !(str(x.customer, 300) || str(x.scentName, 300))) { skipped++; continue; }
      const row = { id: String(x.id), line: Number(x.line) || 0, customer: str(x.customer, 300), scent_name: str(x.scentName, 300), scent_code: str(x.scentCode, 60), product: str(x.product, 120), formula_date: day(x.formulaDate), due_sa: day(x.dueSa),
        rd_by: str(x.rdBy, 80), ra_by: str(x.raBy, 80), rd_due: day(x.rdDue), sent_at: day(x.sentAt), price: numOrNull(x.price), price_raw: str(x.priceRaw, 120), price2_raw: str(x.price2Raw, 120), note: str(x.note, 500), remark: str(x.remark, 500) };
      const ex = (await db`select id from costing.price_quotes where id = ${row.id}`)[0];
      if (ex) await db`update costing.price_quotes set ${db(row, ...Object.keys(row).filter((k) => k !== "id"))} where id = ${row.id}`;
      else await db`insert into costing.price_quotes ${db({ ...row, project_id: "", created_at: now, created_by: "import:pq26" })}`;
      n++;
    }
    await db`update costing.price_quotes q set project_id = coalesce((select s.project_id from costing.scents s where q.scent_code <> '' and upper(s.formula_code) = upper(q.scent_code) and s.project_id <> '' limit 1),
      (select p.id from costing.projects p where lower(btrim(p.company)) = lower(btrim(q.customer)) order by p.created_at desc limit 1), '') where q.project_id = ''`;
    await log(db, m.email, "importPriceQuotes", `quotes ${n} skipped ${skipped}`);
    return { imported: n, skipped };
  });
}

/** นำเข้าทะเบียนเบสจากไฟล์ Formula Base.xlsx (เจ้าของระบบเท่านั้น · upsert ตาม id ทำซ้ำได้) */
async function importPdBases(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await me(c), db = c.db;
    if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
    const list = Array.isArray(d && d.bases) ? d.bases : []; let n = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]; if (!b || !b.id || !b.name || !b.category) continue;
      const data = pdBaseData(b); if (!data.lines.length) continue;
      const row = { id: str(b.id, 60), category: str(b.category, 80), name: str(b.name, 200), active: true, sort: (i + 1) * 10, data: db.json(data), updated_at: new Date(), updated_by: m.email };
      const ex = (await db`select id from costing.pd_bases where id = ${row.id}`)[0];
      if (ex) await db`update costing.pd_bases set ${db(row, "category", "name", "sort", "data", "updated_at", "updated_by")} where id = ${row.id}`;
      else await db`insert into costing.pd_bases ${db({ ...row, created_at: new Date(), created_by: "import" })}`;
      n++;
    }
    await log(db, m.email, "importPdBases", `bases ${n}`);
    return { bases: n };
  });
}

/* ===== บันทึกขึ้นสินค้าทดลอง (Product Development) =====
   สร้างจากสูตรผลิตภัณฑ์ → บันทึกการชั่งจริง/ผลสังเกต → ส่งลูกค้า (สร้างชุดตัวอย่าง FM-RD-04 ชนิด mockup + ลิงก์ประเมิน) → ผลลูกค้ากลับมาแสดงในบันทึก → รับรอง / ปรับแก้ (สร้างรอบใหม่) / ไม่ผ่าน */
const PT_STATUS: Record<string, number> = { draft: 1, made: 1, sent: 1, accepted: 1, revised: 1, rejected: 1 }, PT_CONCL: Record<string, number> = { pass: 1, adjust: 1, fail: 1 };
async function nextTrialNo(db: Db, at: Date) {
  const p = bkkParts(at), period = p.yyyy + p.mm;
  const r = await db`insert into costing.docseq (prefix, period, n) values ('PT', ${period}, 1) on conflict (prefix, period) do update set n = costing.docseq.n + 1 returning n`;
  return "PT" + p.yyyy.slice(2) + p.mm + String(Number(r[0].n)).padStart(3, "0");
}
function ptLines(v: Any) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 80).map((x: Any) => ({ code: str(x && x.code, 40), name: str(x && x.name, 200), frag: !!(x && x.frag), pct: numOrNull(x && x.pct), plannedG: numOrNull(x && x.plannedG), actualG: numOrNull(x && x.actualG), lot: str(x && x.lot, 60) })).filter((x: Any) => x.name || x.code);
}
function ptData(d: Any, old: Any) {
  const o = d || {}, obs = o.obs && typeof o.obs === "object" ? o.obs : {};
  return { batchG: numOrNull(o.batchG), madeAt: str(o.madeAt, 10), operator: str(o.operator, 120), lines: ptLines(o.lines),
    obs: { appearance: str(obs.appearance, 200), color: str(obs.color, 120), odor: str(obs.odor, 300), ph: str(obs.ph, 40), viscosity: str(obs.viscosity, 80), other: str(obs.other, 1000) },
    conclusion: PT_CONCL[o.conclusion] ? String(o.conclusion) : "", note: str(o.note, 2000), nextNote: str(o.nextNote, 1000),
    stockIssued: old && old.stockIssued ? old.stockIssued : null, sentAt: old && old.sentAt ? old.sentAt : "", evalLink: old && old.evalLink ? old.evalLink : "" };
}
const ptOut = (r: Any, smp: Any, base: string) => {
  const ev = smp && smp.eval ? smp.eval : {}, items = Array.isArray(ev.items) ? ev.items : [], it = items[0] || null;
  const total = it ? EVAL_FIELDS.reduce((a: number, f: string) => a + (Number(it.scores && it.scores[f]) || 0), 0) : 0;
  const fb = smp ? { sampleId: String(smp.id), docNo: String(smp.doc_no), sampleStatus: String(smp.status), evalDocNo: String(smp.eval_doc_no || ""), evalLink: smp.eval_token ? base + "eval/" + String(smp.eval_token) : "", shippedAt: iso(smp.shipped_at),
    submittedAt: String(ev.submittedAt || ""), email: String(ev.email || ""), note: String(ev.note || ""), scores: it ? it.scores || {} : {}, pct: total ? Math.round(total / 30 * 10000) / 100 : null, decision: it ? String(it.decision || "") : "", comment: it ? String(it.comment || "") : "" } : null;
  let status = String(r.status); if (status === "sent" && fb && fb.sampleStatus === "evaluated") status = "feedback";
  return { id: String(r.id), trialNo: String(r.trial_no), formulaId: String(r.formula_id), projectId: String(r.project_id || ""), status, sampleId: String(r.sample_id || ""), ...(r.data || {}), feedback: fb,
    createdAt: iso(r.created_at), createdBy: String(r.created_by || ""), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") };
};
async function ptLoad(db: Db, where: "formula" | "project" | "all" | "one", key: string, base: string) {
  const rows = where === "formula" ? await db`select * from costing.pd_trials where formula_id = ${key} order by created_at desc`
    : where === "project" ? await db`select * from costing.pd_trials where project_id = ${key} order by created_at desc`
    : where === "one" ? await db`select * from costing.pd_trials where id = ${key}` : await db`select * from costing.pd_trials order by created_at desc limit 500`;
  const ids = rows.map((r: Any) => String(r.sample_id)).filter(Boolean), smp: Record<string, Any> = {};
  for (const sid of ids) { const s = (await db`select * from costing.samples where id = ${sid}`)[0]; if (s) smp[sid] = s; }
  return rows.map((r: Any) => ptOut(r, smp[String(r.sample_id)] || null, base));
}
async function listPdTrials(ctx: Ctx, formulaId?: string, projectId?: string) {
  await needAny(ctx, RD_VIEW); const db = ctx.db, base = await evalBase(db);
  return await ptLoad(db, formulaId ? "formula" : projectId ? "project" : "all", String(formulaId || projectId || ""), base);
}
/** สร้างหรือแก้ไขบันทึกขึ้นสินค้าทดลอง (สร้างใหม่ = ระบุ formulaId · ระบบคัดลอกส่วนประกอบจากสูตรและคำนวณกรัมตามขนาด batch) */
async function savePdTrial(ctx: Ctx, t: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db, base = await evalBase(db); t = t || {};
    const ex = t.id ? (await db`select * from costing.pd_trials where id = ${String(t.id)}`)[0] : null; if (t.id && !ex) throw new Error("ไม่พบบันทึกนี้");
    const now = new Date();
    if (!ex) {
      const f = (await db`select * from costing.pd_formulas where id = ${str(t.formulaId, 60)}`)[0]; if (!f) throw new Error("ไม่พบสูตรผลิตภัณฑ์");
      const fd = f.data || {}, batch = numOrNull(t.batchG) || numOrNull(fd.batchG) || 1000; if (!(batch > 0)) throw new Error("ขนาด batch ต้องมากกว่า 0");
      const lines = Array.isArray(t.lines) && t.lines.length ? ptLines(t.lines) : (Array.isArray(fd.lines) ? fd.lines : []).map((l: Any) => { const g = Math.round(Number(l.pct || 0) * batch / 100 * 1000) / 1000; return { code: String(l.code || ""), name: l.frag ? String(fd.fragranceName || l.name || "Fragrance") : String(l.name || ""), frag: !!l.frag, pct: l.pct === undefined ? null : l.pct, plannedG: g, actualG: g, lot: "" }; });
      if (!lines.length) throw new Error("สูตรนี้ยังไม่มีส่วนประกอบ");
      const data = ptData({ ...t, batchG: batch, lines, madeAt: t.madeAt || "", operator: t.operator || m.email.split("@")[0] }, null), id = "pt-" + uuid(10), no = await nextTrialNo(db, now);
      await db`insert into costing.pd_trials ${db({ id, trial_no: no, formula_id: String(f.id), project_id: String(f.project_id || ""), status: "draft", sample_id: "", data: db.json(data), created_at: now, created_by: m.email, updated_at: now, updated_by: m.email })}`;
      await log(db, m.email, "newPdTrial", no + " · " + String(f.code) + " · " + String(f.name));
      return (await ptLoad(db, "one", id, base))[0];
    }
    const locked_ = ["sent", "accepted", "revised", "rejected"].includes(String(ex.status)), od = ex.data || {};
    let data = ptData({ ...od, ...t }, od);
    if (locked_) data = { ...od, note: str(t.note, 2000) || od.note, nextNote: str(t.nextNote, 1000), obs: od.obs, lines: od.lines, batchG: od.batchG, madeAt: od.madeAt, operator: od.operator, conclusion: od.conclusion };   /* ส่งลูกค้าแล้ว: แก้ได้เฉพาะหมายเหตุ */
    if (JSON.stringify(data).length > 30000) throw new Error("ข้อมูลใหญ่เกินไป");
    let status = String(ex.status); if (!locked_) status = PT_STATUS[t.status] && ["draft", "made"].includes(String(t.status)) ? String(t.status) : status;
    if (status === "made" && !data.madeAt) data.madeAt = new Date().toISOString().slice(0, 10);
    await db`update costing.pd_trials set status = ${status}, data = ${db.json(data)}, updated_at = ${now}, updated_by = ${m.email} where id = ${String(ex.id)}`;
    await log(db, m.email, "savePdTrial", String(ex.trial_no) + " · " + status);
    return (await ptLoad(db, "one", String(ex.id), base))[0];
  });
}
/** ส่งให้ลูกค้า: สร้างชุดตัวอย่าง (FM-RD-04 ชนิดต้นแบบ) ในโครงการของสูตร + ลิงก์ประเมิน ผลของลูกค้ากลับมาแสดงในบันทึกนี้ */
async function sendPdTrial(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, RD_EDIT), db = c.db, base = await evalBase(db);
    const tr = (await db`select * from costing.pd_trials where id = ${String(id || "")}`)[0]; if (!tr) throw new Error("ไม่พบบันทึกนี้");
    if (String(tr.status) !== "made" && String(tr.status) !== "draft") throw new Error("บันทึกนี้ส่งหรือปิดไปแล้ว");
    const od = tr.data || {}; if (od.conclusion === "fail") throw new Error("ผลทดลองไม่ผ่าน ไม่ควรส่งลูกค้า ปรับสูตรแล้วทำรอบใหม่");
    if (String(tr.status) === "draft") throw new Error("บันทึกสถานะ \"ผลิตแล้ว\" ก่อนส่งลูกค้า");
    const f = (await db`select * from costing.pd_formulas where id = ${String(tr.formula_id)}`)[0]; if (!f) throw new Error("ไม่พบสูตรผลิตภัณฑ์");
    const pr = (await db`select * from costing.projects where id = ${String(f.project_id || "")}`)[0]; if (!pr) throw new Error("ผูกสูตรกับโครงการก่อนจึงจะส่งลูกค้าได้");
    const fd = f.data || {}, now = new Date(), sid = "x" + uuid(12), token = uuid(24), docNo = await nextDocNo(db, "FM-RD-04", now);
    const items = [{ code: String(tr.trial_no), name: String(f.name), scentId: String(fd.fragranceScentId || ""), formulaCode: String(f.code), size: od.batchG ? `${od.batchG} g (ทดลอง)` : "", qty: null }];
    await db`insert into costing.samples ${db({ id: sid, doc_no: docNo, project_id: String(pr.id), kind: "mockup", items: db.json(items), requested_at: now, shipped_at: now, arrival_at: null, rd_by: m.email, sa_by: String((pr.owners || {}).sa || ""), note: `บันทึกขึ้นสินค้าทดลอง ${tr.trial_no} · สูตร ${f.code}`,
      status: "sent", eval_token: token, eval_doc_no: "", eval: db.json({}), created_at: now, created_by: m.email, updated_at: now, updated_by: m.email })}`;
    const actual = { ...(pr.actual || {}) }; if (!actual.s5send) actual.s5send = now.toISOString(); await db`update costing.projects set actual = ${db.json(actual)}, updated_at = now() where id = ${String(pr.id)}`;
    const data = { ...od, sentAt: now.toISOString(), evalLink: base + "eval/" + token };
    await db`update costing.pd_trials set status = 'sent', sample_id = ${sid}, data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(tr.id)}`;
    await log(db, m.email, "sendPdTrial", String(tr.trial_no) + " → " + docNo);
    return (await ptLoad(db, "one", String(tr.id), base))[0];
  });
}
/** ตัดสินหลังได้ผลลูกค้า: accept (รับรองต้นแบบ → สูตรไปขั้นทดสอบ Stability) · reject · revise (สร้างบันทึกรอบใหม่จากรอบนี้) */
async function decidePdTrial(ctx: Ctx, id: string, action: string, note?: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "pd"), db = c.db, base = await evalBase(db);
    const tr = (await db`select * from costing.pd_trials where id = ${String(id || "")}`)[0]; if (!tr) throw new Error("ไม่พบบันทึกนี้");
    if (String(tr.status) !== "sent") throw new Error("ตัดสินได้เฉพาะบันทึกที่ส่งลูกค้าแล้ว");
    const od = { ...(tr.data || {}), nextNote: str(note, 1000) || str((tr.data || {}).nextNote, 1000) }, now = new Date();
    if (action === "accept" || action === "reject") {
      await db`update costing.pd_trials set status = ${action === "accept" ? "accepted" : "rejected"}, data = ${db.json(od)}, updated_at = now(), updated_by = ${m.email} where id = ${String(tr.id)}`;
      if (action === "accept") await db`update costing.pd_formulas set status = case when status = 'draft' then 'testing' else status end, updated_at = now(), updated_by = ${m.email} where id = ${String(tr.formula_id)}`;
      await log(db, m.email, "decidePdTrial", String(tr.trial_no) + " · " + action);
      return { trial: (await ptLoad(db, "one", String(tr.id), base))[0], next: null };
    }
    if (action !== "revise") throw new Error("การตัดสินไม่ถูกต้อง");
    const id2 = "pt-" + uuid(10), no = await nextTrialNo(db, now), lines = (od.lines || []).map((l: Any) => ({ ...l, actualG: l.plannedG, lot: "" }));
    const d2 = ptData({ batchG: od.batchG, lines, operator: m.email.split("@")[0], note: `ปรับแก้จาก ${tr.trial_no}` + (od.nextNote ? ": " + od.nextNote : "") }, null);
    await db`update costing.pd_trials set status = 'revised', data = ${db.json(od)}, updated_at = now(), updated_by = ${m.email} where id = ${String(tr.id)}`;
    await db`insert into costing.pd_trials ${db({ id: id2, trial_no: no, formula_id: String(tr.formula_id), project_id: String(tr.project_id || ""), status: "draft", sample_id: "", data: db.json(d2), created_at: now, created_by: m.email, updated_at: now, updated_by: m.email })}`;
    await log(db, m.email, "decidePdTrial", String(tr.trial_no) + " · revise → " + no);
    return { trial: (await ptLoad(db, "one", String(tr.id), base))[0], next: (await ptLoad(db, "one", id2, base))[0] };
  });
}
/** ตัดสต็อกคลัง R&D ตามที่ชั่งจริง (เฉพาะรายการที่รหัสตรงกับคลังและหน่วย g/kg · ตัดซ้ำไม่ได้) */
async function issuePdTrialStock(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, STK_EDIT), db = c.db, base = await evalBase(db);
    const tr = (await db`select * from costing.pd_trials where id = ${String(id || "")}`)[0]; if (!tr) throw new Error("ไม่พบบันทึกนี้");
    const od = tr.data || {}; if (od.stockIssued) throw new Error("ตัดสต็อกของบันทึกนี้ไปแล้ว");
    if (String(tr.status) === "draft") throw new Error("บันทึกสถานะ \"ผลิตแล้ว\" ก่อนตัดสต็อก");
    const issued: Any[] = [], skipped: Any[] = [];
    for (const l of (od.lines || [])) {
      const g = Number(l.actualG) || 0; if (!(g > 0)) continue; const code = String(l.code || ""); if (!code) { skipped.push({ name: String(l.name), reason: "ไม่มีรหัส" }); continue; }
      const it = (await db`select * from costing.rdstock_items where upper(code) = ${code.toUpperCase()} and active = true`)[0]; if (!it) { skipped.push({ code, name: String(l.name), reason: "ไม่มีในคลัง R&D" }); continue; }
      const unit = String(it.unit || "").trim().toLowerCase(), qty = unit === "g" || unit === "กรัม" ? g : unit === "kg" || unit === "กก." ? g / 1000 : null; if (qty === null) { skipped.push({ code, name: String(l.name), reason: "หน่วยคลังเป็น " + (it.unit || "ไม่ระบุ") + " (ตัดอัตโนมัติเฉพาะ g/kg)" }); continue; }
      const bal = await stkBalance(db, String(it.id)); if (qty > bal + 1e-9) { skipped.push({ code, name: String(l.name), reason: `คงเหลือไม่พอ (มี ${Math.round(bal * 10000) / 10000} ${it.unit})` }); continue; }
      await stkTxRow(db, String(it.id), -qty, "out", { ref: String(tr.trial_no), note: "ตัดตามบันทึกขึ้นสินค้าทดลอง" }, m.email); issued.push({ code, name: String(l.name), qty: Math.round(qty * 10000) / 10000, unit: String(it.unit) });
    }
    const data = { ...od, stockIssued: { at: new Date().toISOString(), by: m.email, issued, skipped } };
    await db`update costing.pd_trials set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where id = ${String(tr.id)}`;
    await log(db, m.email, "issuePdTrialStock", String(tr.trial_no) + ` · ตัด ${issued.length} ข้าม ${skipped.length}`);
    return (await ptLoad(db, "one", String(tr.id), base))[0];
  });
}

/* ===== Research Ingredients: ทะเบียนวัตถุดิบพืชหอม (BT-nnnn) =====
   ข้อมูลเก็บเป็น data (jsonb) ตามฟิลด์เดิมของทะเบียน · ราคาอ้างอิง/ต้นทุนแยกตาราง เปิดเฉพาะผู้มีสิทธิ์ editPrices · รูปอยู่ใน Storage (private) ส่งเป็นลิงก์ชั่วคราว */
const BT_VIEW = ["research", "perfumer", "pd", "ra", "projects", "calc", "viewDb", "rdView"], BT_DATA_MAX = 60000, BT_IMG_MAX = 3 * 1024 * 1024;
const BT_IMG_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const BT_EXT_METHODS: Record<string, number> = { sd: 1, hd: 1, hdc: 1, sdc: 1, sol: 1, eth: 1, enf: 1, co2: 1, cold: 1, other: 1 };
const BT_EXT_RESULTS: Record<string, number> = { ok: 1, low: 1, none: 1, hydrosol: 1, fail: 1 };
/** รับเฉพาะ JSON ธรรมดา (string/number/boolean/array/object) ตัดคีย์ที่ระบบคุมเอง */
function btClean(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, 4000);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => btClean(x, depth + 1));
  if (typeof v === "object") { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as Any).slice(0, 80)) { if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) o[k] = btClean((v as Any)[k], depth + 1); } return o; }
  return null;
}
const BT_SYSTEM_KEYS = ["regNo", "image", "imageId", "imagePath", "imageUrl", "platePath"];
function btData(d: Any) { const o = btClean(d) as Any; BT_SYSTEM_KEYS.forEach((k) => delete o[k]); if (JSON.stringify(o).length > BT_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป (ลดความยาวข้อความ)"); return o; }
async function btSignedUrls(paths: string[]) {
  const out: Record<string, string> = {}; const uniq = [...new Set(paths.filter(Boolean))];
  if (!uniq.length) return out;
  const r = await sb.storage.from("plant-images").createSignedUrls(uniq, 3600);
  (r.data || []).forEach((x: Any) => { if (x && x.signedUrl && x.path) out[String(x.path)] = String(x.signedUrl); });
  return out;
}
const btOut = (r: Any, urls: Record<string, string>) => ({ ...(r.data || {}), regNo: String(r.reg_no), imageUrl: urls[String(r.image_path)] || "", hasImage: !!r.image_path, updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function listBotanicals(ctx: Ctx) {
  const m = await needAny(ctx, BT_VIEW), db = ctx.db;
  const rows = await db`select * from costing.botanicals order by reg_no`;
  const urls = await btSignedUrls(rows.map((r: Any) => String(r.image_path)));
  return { items: rows.map((r: Any) => btOut(r, urls)), canEdit: hasPerm(m, "research"), canPrice: hasPerm(m, "editPrices") };
}
/** แผ่นภาพพฤกษศาสตร์ (Botanical Plate) ของพืช: ส่งลิงก์ชั่วคราวเมื่อเปิดหน้ารายละเอียดเท่านั้น (ไม่ต้องเซ็นลิงก์ทั้งทะเบียนทุกครั้ง) */
async function getBotanicalPlate(ctx: Ctx, regNo: string) {
  await needAny(ctx, BT_VIEW); regNo = str(regNo, 20);
  const row = (await ctx.db`select data->>'platePath' as p from costing.botanicals where reg_no = ${regNo}`)[0];
  const p = row && row.p ? String(row.p) : ""; if (!p) return { url: "" };
  const urls = await btSignedUrls([p]); return { url: urls[p] || "" };
}
async function getBotanicalPrices(ctx: Ctx) {
  await need(ctx, "editPrices");
  const out: Record<string, Any> = {}; (await ctx.db`select * from costing.botanical_prices`).forEach((r: Any) => { out[String(r.reg_no)] = r.data || {}; });
  return out;
}
async function saveBotanicalPrice(ctx: Ctx, regNo: string, price: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "editPrices"), db = c.db; regNo = str(regNo, 20);
    if (!(await db`select 1 from costing.botanicals where reg_no = ${regNo}`).length) throw new Error("ไม่พบรายการนี้");
    const d = btClean(price) as Any; if (JSON.stringify(d).length > 8000) throw new Error("ข้อมูลใหญ่เกินไป");
    await db`insert into costing.botanical_prices (reg_no, data, updated_at, updated_by) values (${regNo}, ${db.json(d)}, now(), ${m.email})
      on conflict (reg_no) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`;
    await log(db, m.email, "saveBotanicalPrice", regNo);
    return d;
  });
}
/** บันทึกทะเบียนพืช: regNo ว่าง = สร้างใหม่ (ออก BT-nnnn ต่อจากเลขสูงสุด) · แก้ไข = merge ทับฟิลด์ที่ส่งมา ฟิลด์อื่น (เช่น ข้อมูลอ้างอิงจากไฟล์นำเข้า) คงไว้ */
async function saveBotanical(ctx: Ctx, rec: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "research"), db = c.db; rec = rec || {};
    const patch = btData(rec), regIn = str(rec.regNo, 20);
    if (!str(patch.nameTh, 200) && !str(patch.nameEn, 200)) throw new Error("ใส่ชื่อพืช (ไทยหรืออังกฤษ)");
    let ex = regIn ? (await db`select * from costing.botanicals where reg_no = ${regIn}`)[0] : null;
    if (regIn && !ex) throw new Error("ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)");
    let regNo = regIn;
    if (!ex) {
      const mx = await db`select coalesce(max((substring(reg_no from 4))::int), 0)::int as n from costing.botanicals where reg_no ~ '^BT-[0-9]+$'`;
      regNo = "BT-" + String(Number(mx[0].n) + 1).padStart(4, "0");
    }
    const data = { ...(ex ? ex.data : {}), ...patch }; if (JSON.stringify(data).length > BT_DATA_MAX) throw new Error("ข้อมูลใหญ่เกินไป");
    if (ex) await db`update costing.botanicals set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where reg_no = ${regNo}`;
    else await db`insert into costing.botanicals (reg_no, data, created_at, created_by, updated_at, updated_by) values (${regNo}, ${db.json({ source: "ลงทะเบียนในระบบ", ...data })}, now(), ${m.email}, now(), ${m.email})`;
    await log(db, m.email, ex ? "saveBotanical" : "newBotanical", regNo + " · " + str(data.nameTh || data.nameEn, 80));
    const r = (await db`select * from costing.botanicals where reg_no = ${regNo}`)[0];
    return btOut(r, await btSignedUrls([String(r.image_path)]));
  });
}
async function deleteBotanical(ctx: Ctx, regNo: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db; regNo = str(regNo, 20);
    const ex = (await db`select * from costing.botanicals where reg_no = ${regNo}`)[0]; if (!ex) throw new Error("ไม่พบรายการนี้");
    await db`delete from costing.botanical_prices where reg_no = ${regNo}`; await db`delete from costing.botanical_extractions where reg_no = ${regNo}`; await db`delete from costing.botanicals where reg_no = ${regNo}`;
    if (ex.image_path && !(await db`select 1 from costing.botanicals where image_path = ${String(ex.image_path)} limit 1`).length) { try { await sb.storage.from("plant-images").remove([String(ex.image_path)]); } catch (_e) { /* ignore */ } }
    await log(db, m.email, "deleteBotanical", regNo);
    return { ok: true };
  });
}
function btImgKind(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return "image/webp";
  return "";
}
async function uploadBotanicalImage(ctx: Ctx, regNo: string, b64: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "research"), db = c.db; regNo = str(regNo, 20);
    const ex = (await db`select * from costing.botanicals where reg_no = ${regNo}`)[0]; if (!ex) throw new Error("ไม่พบรายการนี้");
    if (typeof b64 !== "string" || !b64) throw new Error("ไม่มีข้อมูลรูป");
    const bytes = decodeBase64(b64); if (!bytes.length || bytes.length > BT_IMG_MAX) throw new Error("รูปต้องมีขนาดไม่เกิน 3 MB");
    const kind = btImgKind(bytes); if (!kind) throw new Error("รองรับเฉพาะรูป JPG / PNG / WebP");
    const path = `${regNo}-${Date.now().toString(36)}.${BT_IMG_TYPES[kind]}`;
    const up = await sb.storage.from("plant-images").upload(path, bytes, { contentType: kind }); if (up.error) throw new Error("บันทึกรูปไม่สำเร็จ: " + up.error.message);
    await db`update costing.botanicals set image_path = ${path}, updated_at = now(), updated_by = ${m.email} where reg_no = ${regNo}`;
    if (ex.image_path && !(await db`select 1 from costing.botanicals where image_path = ${String(ex.image_path)} limit 1`).length) { try { await sb.storage.from("plant-images").remove([String(ex.image_path)]); } catch (_e) { /* ignore */ } }
    await log(db, m.email, "uploadBotanicalImage", regNo);
    return { imageUrl: (await btSignedUrls([path]))[path] || "" };
  });
}
/* ---- บันทึกการสกัด ---- */
const extOut = (r: Any) => ({ id: String(r.id), regNo: String(r.reg_no), ...(r.data || {}), createdAt: iso(r.created_at), createdBy: String(r.created_by || "") });
async function listBotanicalExtractions(ctx: Ctx, regNo?: string) {
  await needAny(ctx, BT_VIEW);
  const rows = regNo ? await ctx.db`select * from costing.botanical_extractions where reg_no = ${str(regNo, 20)} order by created_at desc` : await ctx.db`select * from costing.botanical_extractions order by created_at desc limit 500`;
  return rows.map(extOut);
}
async function saveBotanicalExtraction(ctx: Ctx, regNo: string, e: Any) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "research"), db = c.db; regNo = str(regNo, 20); e = e || {};
    const bt = (await db`select * from costing.botanicals where reg_no = ${regNo}`)[0]; if (!bt) throw new Error("ไม่พบรายการนี้");
    const inG = numOrNull(e.inputG), outG = numOrNull(e.outputG);
    if (inG !== null && inG < 0 || outG !== null && outG < 0) throw new Error("ปริมาณต้องไม่ติดลบ");
    const yieldPct = inG && inG > 0 && outG !== null ? Math.round(outG / inG * 10000) / 100 : numOrNull(e.yieldPct);
    const d = { date: str(e.date, 10) || new Date().toISOString().slice(0, 10), method: BT_EXT_METHODS[e.method] ? String(e.method) : "other", equip: str(e.equip, 120), material: str(e.material, 200), state: str(e.state, 60), lot: str(e.lot, 80),
      inputG: inG, outputG: outG, yieldPct, solvent: str(e.solvent, 120), solventQty: str(e.solventQty, 60), durationMin: numOrNull(e.durationMin), result: BT_EXT_RESULTS[e.result] ? String(e.result) : "ok", operator: str(e.operator, 120) || m.email.split("@")[0], odor: str(e.odor, 600), notes: str(e.notes, 2000) };
    const id = "x" + uuid(12);
    await db`insert into costing.botanical_extractions (id, reg_no, data, created_at, created_by) values (${id}, ${regNo}, ${db.json(d)}, now(), ${m.email})`;
    const runs = await db`select data from costing.botanical_extractions where reg_no = ${regNo}`;
    const best = Math.max(0, ...runs.map((r: Any) => Number(r.data && r.data.yieldPct) || 0));
    const data = { ...(bt.data || {}), extCount: runs.length, lastExtraction: runs.map((r: Any) => String(r.data.date || "")).sort().pop() || d.date, bestYield: best > 0 ? best : null };
    { const rt = Array.isArray(data.rdType) ? data.rdType.slice() : data.rdType ? [data.rdType] : []; if (rt.indexOf("extract") < 0) rt.push("extract"); data.rdType = rt; }   /* งาน R&D เป็นรายการ (เช่น ["extract","buy"]) */
    await db`update costing.botanicals set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where reg_no = ${regNo}`;
    await log(db, m.email, "saveBotanicalExtraction", regNo + " · " + d.method + (yieldPct !== null ? " · " + yieldPct + "%" : ""));
    return extOut((await db`select * from costing.botanical_extractions where id = ${id}`)[0]);
  });
}
async function deleteBotanicalExtraction(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "research"), db = c.db;
    const ex = (await db`select * from costing.botanical_extractions where id = ${String(id || "")}`)[0]; if (!ex) throw new Error("ไม่พบบันทึกนี้");
    if (String(ex.created_by) !== m.email && !isAdmin(m)) throw new Error("ลบได้เฉพาะบันทึกของตัวเองหรือผู้ดูแล");
    await db`delete from costing.botanical_extractions where id = ${String(ex.id)}`;
    const bt = (await db`select * from costing.botanicals where reg_no = ${String(ex.reg_no)}`)[0];
    if (bt) { const rest = await db`select data from costing.botanical_extractions where reg_no = ${String(ex.reg_no)}`; const best = Math.max(0, ...rest.map((r: Any) => Number(r.data && r.data.yieldPct) || 0));
      const data = { ...(bt.data || {}), extCount: rest.length, lastExtraction: rest.map((r: Any) => String(r.data.date || "")).sort().pop() || "", bestYield: best > 0 ? best : null };
      await db`update costing.botanicals set data = ${db.json(data)}, updated_at = now(), updated_by = ${m.email} where reg_no = ${String(ex.reg_no)}`; }
    await log(db, m.email, "deleteBotanicalExtraction", String(ex.reg_no));
    return { ok: true };
  });
}
/** นำเข้าจาก Artifact เดิม (เจ้าของระบบเท่านั้น ทำซ้ำได้): records[{regNo, imagePath, data, price}] · รูปส่งแยกด้วย importBotanicalImage */
async function importBotanicals(ctx: Ctx, d: Any) {
  return await locked(ctx, async (c) => {
    const m = await me(c), db = c.db;
    if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
    const list = Array.isArray(d && d.records) ? d.records : []; let n = 0, np = 0;
    for (const r of list) {
      const regNo = str(r && r.regNo, 20); if (!/^BT-\d{4,6}$/.test(regNo)) continue;
      const data = btData(r.data || {}), img = str(r.imagePath, 120).replace(/[^A-Za-z0-9._-]/g, "");
      await db`insert into costing.botanicals (reg_no, image_path, data, created_at, created_by, updated_at, updated_by) values (${regNo}, ${img}, ${db.json(data)}, ${ts(r.createdAt) || new Date()}, 'import', ${ts(r.updatedAt) || new Date()}, ${m.email})
        on conflict (reg_no) do update set image_path = excluded.image_path, data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`;
      n++;
      if (r.price && typeof r.price === "object") { await db`insert into costing.botanical_prices (reg_no, data, updated_at, updated_by) values (${regNo}, ${db.json(btClean(r.price) as Any)}, now(), ${m.email})
        on conflict (reg_no) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`; np++; }
    }
    await log(db, m.email, "importBotanicals", `records ${n} prices ${np}`);
    return { records: n, prices: np };
  });
}
async function importBotanicalImage(ctx: Ctx, name: string, b64: string) {
  const m = await me(ctx);
  if (m.email !== MIGRATION_OWNER || !m.isOwner) throw new Error("FORBIDDEN");
  name = str(name, 120).replace(/[^A-Za-z0-9._-]/g, ""); if (!name) throw new Error("ชื่อไฟล์ไม่ถูกต้อง");
  const bytes = decodeBase64(String(b64 || "")); const kind = btImgKind(bytes);
  if (!kind || bytes.length > BT_IMG_MAX) throw new Error("รูปไม่ถูกต้อง");
  const up = await sb.storage.from("plant-images").upload(name, bytes, { contentType: kind, upsert: true }); if (up.error) throw new Error("บันทึกรูปไม่สำเร็จ: " + up.error.message);
  return { name, bytes: bytes.length };
}

/* ===== คลังวัตถุดิบและบรรจุภัณฑ์ของแผนก R&D (RM = วัตถุดิบ · PM = บรรจุภัณฑ์) =====
   คงเหลือ = ผลรวมรายการเคลื่อนไหว (รับเข้า +, เบิก −, ปรับยอด ±) · ต้นทุนต่อหน่วยเห็นเฉพาะผู้มีสิทธิ์ editPrices */
const STK_VIEW = RD_VIEW, STK_EDIT = ["research", "pd", "perfumer"], STK_KINDS: Record<string, number> = { rm: 1, pm: 1 }, STK_TX: Record<string, number> = { in: 1, out: 1, adjust: 1 };
const stkItemOut = (r: Any, canPrice: boolean) => ({ id: String(r.id), code: String(r.code), name: String(r.name), kind: String(r.kind), unit: String(r.unit || ""), supplier: String(r.supplier || ""), location: String(r.location || ""),
  minQty: r.min_qty === null || r.min_qty === undefined ? null : Number(r.min_qty), unitCost: canPrice && r.unit_cost !== null && r.unit_cost !== undefined ? Number(r.unit_cost) : null, note: String(r.note || ""), active: !!r.active,
  balance: Math.round(Number(r.bal || 0) * 10000) / 10000, lastAt: iso(r.last_at), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
const stkTxOut = (r: Any) => ({ id: String(r.id), itemId: String(r.item_id), code: String(r.code || ""), name: String(r.name || ""), unit: String(r.unit || ""), kind: String(r.kind), qty: Number(r.qty), ref: String(r.ref || ""), lot: String(r.lot || ""), expiry: String(r.expiry || ""),
  note: String(r.note || ""), at: iso(r.at), by: String(r.created_by || "") });
async function stkBalance(db: Db, id: string) { return Number((await db`select coalesce(sum(qty), 0) as b from costing.rdstock_tx where item_id = ${id}`)[0].b); }
async function stkOne(db: Db, id: string, canPrice: boolean) {
  const r = (await db`select i.*, coalesce(sum(t.qty), 0) as bal, max(t.at) as last_at from costing.rdstock_items i left join costing.rdstock_tx t on t.item_id = i.id where i.id = ${id} group by i.id`)[0];
  return r ? stkItemOut(r, canPrice) : null;
}
async function listRdStock(ctx: Ctx) {
  const m = await needAny(ctx, STK_VIEW), db = ctx.db, canPrice = hasPerm(m, "editPrices");
  const rows = await db`select i.*, coalesce(sum(t.qty), 0) as bal, max(t.at) as last_at from costing.rdstock_items i left join costing.rdstock_tx t on t.item_id = i.id group by i.id order by i.kind, i.code`;
  return { items: rows.map((r: Any) => stkItemOut(r, canPrice)), canEdit: STK_EDIT.some((p) => hasPerm(m, p)), canPrice };
}
async function listRdStockTx(ctx: Ctx, itemId?: string, limit?: number) {
  await needAny(ctx, STK_VIEW); const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const rows = itemId
    ? await ctx.db`select t.*, i.code, i.name, i.unit from costing.rdstock_tx t join costing.rdstock_items i on i.id = t.item_id where t.item_id = ${String(itemId)} order by t.at desc, t.created_at desc limit ${n}`
    : await ctx.db`select t.*, i.code, i.name, i.unit from costing.rdstock_tx t join costing.rdstock_items i on i.id = t.item_id order by t.at desc, t.created_at desc limit ${n}`;
  return rows.map(stkTxOut);
}
function stkTxRow(db: Db, itemId: string, delta: number, kind: string, t: Any, email: string) {
  const at = t && t.date && !isNaN(new Date(String(t.date)).getTime()) ? new Date(String(t.date)) : new Date();
  return db`insert into costing.rdstock_tx (id, item_id, kind, qty, ref, lot, expiry, note, at, created_at, created_by) values (${"t" + uuid(12)}, ${itemId}, ${kind}, ${delta}, ${str(t && t.ref, 80)}, ${str(t && t.lot, 40)}, ${str(t && t.expiry, 10)}, ${str(t && t.note, 300)}, ${at}, now(), ${email})`;
}
async function saveRdStockItem(ctx: Ctx, it: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, STK_EDIT), db = c.db, canPrice = hasPerm(m, "editPrices"); it = it || {};
    const code = str(it.code, 40), name = str(it.name, 200), kind = STK_KINDS[it.kind] ? String(it.kind) : "";
    if (!code || !name) throw new Error("ใส่รหัสและชื่อรายการ"); if (!kind) throw new Error("เลือกประเภท: วัตถุดิบ (RM) หรือบรรจุภัณฑ์ (PM)");
    const minQ = numOrNull(it.minQty), cost = numOrNull(it.unitCost), openQ = numOrNull(it.openingQty);
    if ((minQ !== null && minQ < 0) || (cost !== null && cost < 0) || (openQ !== null && openQ < 0)) throw new Error("ตัวเลขต้องไม่ติดลบ");
    const ex = it.id ? (await db`select * from costing.rdstock_items where id = ${String(it.id)}`)[0] : null; if (it.id && !ex) throw new Error("ไม่พบรายการนี้");
    const dup = (await db`select id from costing.rdstock_items where upper(code) = ${code.toUpperCase()}`)[0]; if (dup && (!ex || String(dup.id) !== String(ex.id))) throw new Error("รหัส " + code + " มีอยู่แล้วในคลัง");
    const id = ex ? String(ex.id) : "stk-" + uuid(10), now = new Date();
    const row: Any = { code, name, kind, unit: str(it.unit, 20), supplier: str(it.supplier, 200), location: str(it.location, 80), min_qty: minQ, note: str(it.note, 500), active: it.active === undefined ? true : !!it.active, updated_at: now, updated_by: m.email };
    if (canPrice) row.unit_cost = cost;   /* คนที่ไม่มีสิทธิ์ราคา แก้รายการได้แต่ไม่แตะต้นทุน */
    if (ex) await db`update costing.rdstock_items set ${db(row, ...Object.keys(row))} where id = ${id}`;
    else { await db`insert into costing.rdstock_items ${db({ id, ...row, unit_cost: canPrice ? cost : null, created_at: now, created_by: m.email })}`; if (openQ && openQ > 0) await stkTxRow(db, id, openQ, "in", { ref: "ยกมา", note: "ยอดยกมาตอนสร้างรายการ" }, m.email); }
    await log(db, m.email, ex ? "saveRdStockItem" : "newRdStockItem", code + " · " + name);
    return (await stkOne(db, id, canPrice))!;
  });
}
async function deleteRdStockItem(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    const ex = (await db`select * from costing.rdstock_items where id = ${String(id || "")}`)[0]; if (!ex) throw new Error("ไม่พบรายการนี้");
    if ((await db`select 1 from costing.rdstock_tx where item_id = ${String(ex.id)} limit 1`).length) throw new Error("รายการนี้มีความเคลื่อนไหวแล้ว ให้ปิดใช้งานแทนการลบ");
    await db`delete from costing.rdstock_items where id = ${String(ex.id)}`; await log(db, m.email, "deleteRdStockItem", String(ex.code));
    return { ok: true };
  });
}
/** รับเข้า (in) · เบิกใช้ (out) · ปรับยอดตามนับจริง (adjust: countTo) · เบิกเกินคงเหลือไม่ได้ */
async function addRdStockTx(ctx: Ctx, itemId: string, t: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, STK_EDIT), db = c.db, canPrice = hasPerm(m, "editPrices"); t = t || {};
    const it = (await db`select * from costing.rdstock_items where id = ${String(itemId || "")}`)[0]; if (!it) throw new Error("ไม่พบรายการนี้");
    const kind = STK_TX[t.kind] ? String(t.kind) : ""; if (!kind) throw new Error("ประเภทรายการไม่ถูกต้อง");
    const bal = await stkBalance(db, String(it.id)); let delta = 0;
    if (kind === "adjust") { const to = numOrNull(t.countTo); if (to === null || to < 0) throw new Error("ใส่จำนวนที่นับได้จริง"); delta = Math.round((to - bal) * 10000) / 10000; if (delta === 0) throw new Error("ยอดนับตรงกับคงเหลือในระบบ ไม่ต้องปรับ"); }
    else { const q = numOrNull(t.qty); if (q === null || !(q > 0)) throw new Error("ใส่จำนวนมากกว่า 0"); delta = kind === "in" ? q : -q; if (kind === "out" && q > bal + 1e-9) throw new Error(`คงเหลือไม่พอ (มี ${Math.round(bal * 10000) / 10000} ${it.unit || ""})`); }
    if (kind === "out" && !str(t.ref, 80) && !str(t.note, 300)) throw new Error("ระบุเลขโครงการ/สูตร หรือหมายเหตุการเบิก");
    await stkTxRow(db, String(it.id), delta, kind, t, m.email);
    await log(db, m.email, "rdStock." + kind, String(it.code) + " " + (delta > 0 ? "+" : "") + delta + " " + str(t.ref, 40));
    return await stkOne(db, String(it.id), canPrice);
  });
}
/** นำเข้ารายการ + ยอดคงเหลือจาก Excel: อิงรหัส (ซ้ำ = แก้ข้อมูล, มียอดนับ = ปรับยอดให้ตรง) */
async function importRdStock(ctx: Ctx, rows: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, STK_EDIT), db = c.db, canPrice = hasPerm(m, "editPrices");
    if (!Array.isArray(rows) || !rows.length) throw new Error("ไม่พบแถวข้อมูล"); if (rows.length > 600) throw new Error("นำเข้าได้ครั้งละไม่เกิน 600 แถว");
    const out = { created: 0, updated: 0, adjusted: 0, skipped: 0, errors: [] as string[] };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {}, code = str(r.code, 40), name = str(r.name, 200), kind = STK_KINDS[String(r.kind || "").toLowerCase()] ? String(r.kind).toLowerCase() : "";
      if (!code || !name || !kind) { out.skipped++; if (out.errors.length < 10) out.errors.push(`แถว ${i + 1}: ต้องมีรหัส ชื่อ และประเภท RM/PM`); continue; }
      const qty = numOrNull(r.qty), minQ = numOrNull(r.minQty), cost = numOrNull(r.unitCost); if ((qty !== null && qty < 0) || (minQ !== null && minQ < 0) || (cost !== null && cost < 0)) { out.skipped++; if (out.errors.length < 10) out.errors.push(`แถว ${i + 1} (${code}): ตัวเลขติดลบ`); continue; }
      const ex = (await db`select * from costing.rdstock_items where upper(code) = ${code.toUpperCase()}`)[0], now = new Date();
      const fields: Any = { name, kind, unit: str(r.unit, 20), supplier: str(r.supplier, 200), location: str(r.location, 80), min_qty: minQ, note: str(r.note, 500), updated_at: now, updated_by: m.email };
      let id: string;
      if (ex) { id = String(ex.id); if (canPrice && cost !== null) fields.unit_cost = cost; await db`update costing.rdstock_items set ${db(fields, ...Object.keys(fields))} where id = ${id}`; out.updated++; }
      else { id = "stk-" + uuid(10); await db`insert into costing.rdstock_items ${db({ id, code, ...fields, unit_cost: canPrice ? cost : null, active: true, created_at: now, created_by: m.email })}`; out.created++; }
      if (qty !== null) { const bal = await stkBalance(db, id), d = Math.round((qty - bal) * 10000) / 10000; if (d !== 0) { await stkTxRow(db, id, d, ex ? "adjust" : "in", { ref: ex ? "นำเข้าจากไฟล์" : "ยกมา", note: ex ? `ปรับยอดจาก ${bal} เป็น ${qty} (นำเข้า Excel)` : "ยอดยกมาจากไฟล์นำเข้า" }, m.email); if (ex) out.adjusted++; } }
    }
    await log(db, m.email, "importRdStock", `created ${out.created} updated ${out.updated} adjusted ${out.adjusted} skipped ${out.skipped}`);
    return out;
  });
}

/* ===== งาน RA: จดแจ้งเครื่องสำอาง (อย.) =====
   ทะเบียนเลขจดแจ้ง (อายุ 3 ปี, ต่ออายุได้) + คำขอจดแจ้งจากฝ่ายขาย/โครงการ · ดูได้ทุกคนใน R&D แก้ไขได้เฉพาะสิทธิ์ ra */
const FDA_VIEW = RD_VIEW, FDA_EDIT = ["ra"], FDA_NO = /^\d{2}-\d-\d{10}$/;
const FDA_DECISION: Record<string, number> = { "": 1, renew: 1, no: 1 };
const FDA_REQ_STATUS = ["", "เตรียมข้อมูลเพิ่มเติมสำหรับจดแจ้ง", "รออ.ย. ตรวจสอบ", "ได้เลขแล้ว รอ Post Audit", "Post Audit ไม่ผ่าน", "เรียบร้อย", "รอเบิก", "ยกเลิกใบจดแจ้ง"];
const FDA_REQ_FIELDS = ["sa", "group", "tradeEn", "tradeTh", "nameEn", "nameTh", "formulaRef", "brand", "employerReg", "employerName", "form", "purpose", "area", "packaging", "usage", "infoDate", "dueDate", "note", "projectId"];
/** วันที่ YYYY-MM-DD (ค.ศ.) หรือ "" · รับ dd/mm/yyyy (พ.ศ. > 2400 แปลงเป็น ค.ศ.) ด้วย */
function fdaDate(v: unknown): string {
  const s = String(v ?? "").trim(); if (!s) return "";
  let y: number, m: number, d: number, mm: RegExpMatchArray | null;
  if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  else throw new Error("รูปแบบวันที่ไม่ถูกต้อง: " + s);
  if (y > 2400) y -= 543;
  const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Error("วันที่ไม่ถูกต้อง: " + s);
  return dt.toISOString().slice(0, 10);
}
/** อายุใบรับจดแจ้ง 3 ปี: วันหมดอายุ = วันเริ่ม + 3 ปี − 1 วัน */
function fdaPlus3y(d: string) { if (!d) return ""; const t = new Date(d + "T00:00:00Z"); t.setUTCFullYear(t.getUTCFullYear() + 3); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); }
function fdaFiles(v: unknown) {
  return (Array.isArray(v) ? v : []).slice(0, 20).map((f: Any) => ({ label: str(f && f.label, 40), name: str(f && f.name, 200), url: str(f && f.url, 500) }))
    .filter((f) => (f.name || f.url) && (!f.url || /^https:\/\//.test(f.url)));
}
const fdaRegOut = (r: Any) => { const d = r.data || {}; return { id: String(r.id), regNo: String(r.reg_no), notifyDate: String(r.notify_date || ""), expiry: String(r.expiry || ""), tradeName: String(r.trade_name || ""), productName: String(r.product_name || ""),
  decision: String(r.decision || ""), cancelled: !!r.cancelled, requestId: String(r.request_id || ""), brand: String(d.brand || ""), saNotifiedAt: String(d.saNotifiedAt || ""), note: String(d.note || ""), files: d.files || [], history: d.history || [],
  updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || ""), createdAt: iso(r.created_at) }; };
const fdaReqOut = (r: Any) => ({ id: String(r.id), seq: Number(r.seq || 0), status: String(r.status || ""), regId: String(r.reg_id || ""), ...(r.data || {}), files: (r.data && r.data.files) || [], updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || ""), createdAt: iso(r.created_at) });
async function listFda(ctx: Ctx) {
  const m = await needAny(ctx, FDA_VIEW), db = ctx.db;
  const regs = await db`select * from costing.fda_regs order by expiry, reg_no`, reqs = await db`select * from costing.fda_requests order by seq desc`;
  return { regs: regs.map(fdaRegOut), requests: reqs.map(fdaReqOut), canEdit: FDA_EDIT.some((p) => hasPerm(m, p)), reqStatus: FDA_REQ_STATUS };
}
async function saveFdaReg(ctx: Ctx, r: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_EDIT), db = c.db; r = r || {};
    const regNo = str(r.regNo, 20).replace(/\s+/g, ""); if (!FDA_NO.test(regNo)) throw new Error("เลขจดแจ้งต้องเป็นรูปแบบ 10-1-6600012345");
    const notify = fdaDate(r.notifyDate), expiry = fdaDate(r.expiry) || fdaPlus3y(notify), decision = FDA_DECISION[String(r.decision || "")] ? String(r.decision || "") : "";
    if (!notify) throw new Error("ใส่วันที่จดแจ้ง (วันพิจารณา)"); if (expiry <= notify) throw new Error("วันหมดอายุต้องหลังวันที่จดแจ้ง");
    const productName = str(r.productName, 300); if (!productName) throw new Error("ใส่ชื่อผลิตภัณฑ์");
    const ex = r.id ? (await db`select * from costing.fda_regs where id = ${String(r.id)}`)[0] : null; if (r.id && !ex) throw new Error("ไม่พบเลขจดแจ้งนี้");
    const dup = (await db`select id from costing.fda_regs where reg_no = ${regNo}`)[0]; if (dup && (!ex || String(dup.id) !== String(ex.id))) throw new Error("เลขจดแจ้ง " + regNo + " มีอยู่แล้ว");
    const reqId = str(r.requestId, 40); if (reqId && !(await db`select 1 from costing.fda_requests where id = ${reqId}`).length) throw new Error("ไม่พบคำขอจดแจ้งที่อ้างถึง");
    const old = ex ? (ex.data || {}) : {}, now = new Date(), id = ex ? String(ex.id) : "fda-" + uuid(10);
    const data = { ...old, brand: str(r.brand, 120), saNotifiedAt: fdaDate(r.saNotifiedAt), note: str(r.note, 2000), files: fdaFiles(r.files), history: old.history || [] };
    const row: Any = { reg_no: regNo, notify_date: notify, expiry, trade_name: str(r.tradeName, 200), product_name: productName, decision, cancelled: !!r.cancelled, request_id: reqId, data: db.json(data), updated_at: now, updated_by: m.email };
    if (ex) await db`update costing.fda_regs set ${db(row, ...Object.keys(row))} where id = ${id}`;
    else await db`insert into costing.fda_regs ${db({ id, ...row, created_at: now, created_by: m.email })}`;
    if (reqId) await db`update costing.fda_requests set reg_id = ${id}, updated_at = ${now}, updated_by = ${m.email} where id = ${reqId}`;
    await log(db, m.email, ex ? "saveFdaReg" : "newFdaReg", regNo + " · " + productName.slice(0, 60));
    return fdaRegOut((await db`select * from costing.fda_regs where id = ${id}`)[0]);
  });
}
/** ต่ออายุ: เก็บประวัติ (วันหมดอายุเดิม → ใหม่) แล้วเลื่อนวันหมดอายุ · ค่าเริ่มต้น = หมดอายุเดิม + 3 ปี */
async function renewFdaReg(ctx: Ctx, id: string, t: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_EDIT), db = c.db; t = t || {};
    const ex = (await db`select * from costing.fda_regs where id = ${String(id || "")}`)[0]; if (!ex) throw new Error("ไม่พบเลขจดแจ้งนี้");
    if (ex.cancelled) throw new Error("เลขจดแจ้งนี้ถูกยกเลิกแล้ว");
    const renewedAt = fdaDate(t.renewedAt); if (!renewedAt) throw new Error("ใส่วันที่ต่ออายุ");
    const oldExp = String(ex.expiry || ""), next = fdaDate(t.newExpiry) || fdaPlus3y(oldExp ? new Date(Date.parse(oldExp + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) : renewedAt);
    if (oldExp && next <= oldExp) throw new Error("วันหมดอายุใหม่ต้องหลังวันหมดอายุเดิม");
    const d = ex.data || {}, hist = (d.history || []).concat([{ renewedAt, oldExpiry: oldExp, newExpiry: next, note: str(t.note, 500), files: fdaFiles(t.files), by: m.email, at: new Date().toISOString() }]);
    await db`update costing.fda_regs set expiry = ${next}, decision = 'renew', data = ${db.json({ ...d, history: hist })}, updated_at = now(), updated_by = ${m.email} where id = ${String(ex.id)}`;
    await log(db, m.email, "renewFdaReg", String(ex.reg_no) + " → " + next);
    return fdaRegOut((await db`select * from costing.fda_regs where id = ${String(ex.id)}`)[0]);
  });
}
async function deleteFdaReg(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    const ex = (await db`select * from costing.fda_regs where id = ${String(id || "")}`)[0]; if (!ex) throw new Error("ไม่พบเลขจดแจ้งนี้");
    await db`update costing.fda_requests set reg_id = '' where reg_id = ${String(ex.id)}`;
    await db`delete from costing.fda_regs where id = ${String(ex.id)}`; await log(db, m.email, "deleteFdaReg", String(ex.reg_no));
    return { ok: true };
  });
}
async function saveFdaRequest(ctx: Ctx, q: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_EDIT), db = c.db; q = q || {};
    const ex = q.id ? (await db`select * from costing.fda_requests where id = ${String(q.id)}`)[0] : null; if (q.id && !ex) throw new Error("ไม่พบคำขอนี้");
    const status = FDA_REQ_STATUS.indexOf(String(q.status || "")) >= 0 ? String(q.status || "") : ""; const data: Any = {};
    FDA_REQ_FIELDS.forEach((k) => { data[k] = str(q[k], k === "note" || k === "usage" ? 2000 : 300); });
    data.infoDate = fdaDate(data.infoDate); data.dueDate = fdaDate(data.dueDate); data.files = fdaFiles(q.files);
    if (!data.nameEn && !data.nameTh) throw new Error("ใส่ชื่อเครื่องสำอาง (EN หรือ TH)");
    const now = new Date(); let id: string;
    if (ex) { id = String(ex.id); await db`update costing.fda_requests set status = ${status}, data = ${db.json(data)}, updated_at = ${now}, updated_by = ${m.email} where id = ${id}`; }
    else { id = "fdq-" + uuid(10); const seq = Number((await db`select coalesce(max(seq), 0) + 1 as n from costing.fda_requests`)[0].n);
      await db`insert into costing.fda_requests ${db({ id, seq, status, reg_id: "", data: db.json(data), created_at: now, created_by: m.email, updated_at: now, updated_by: m.email })}`; }
    await log(db, m.email, ex ? "saveFdaRequest" : "newFdaRequest", (data.nameEn || data.nameTh).slice(0, 80));
    return fdaReqOut((await db`select * from costing.fda_requests where id = ${id}`)[0]);
  });
}
async function deleteFdaRequest(ctx: Ctx, id: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db;
    const ex = (await db`select * from costing.fda_requests where id = ${String(id || "")}`)[0]; if (!ex) throw new Error("ไม่พบคำขอนี้");
    await db`update costing.fda_regs set request_id = '' where request_id = ${String(ex.id)}`;
    await db`delete from costing.fda_requests where id = ${String(ex.id)}`; await log(db, m.email, "deleteFdaRequest", String(ex.seq));
    return { ok: true };
  });
}

/* ===== ส่วนประกอบ INCI ของวัตถุดิบ (Breakdown Ingredients) — ใช้คำนวณรายการส่วนประกอบบนฉลาก สคบ. และ Allergen =====
   ดูได้ทุกคนใน R&D · แก้ไข/นำเข้าได้เฉพาะสิทธิ์ ra · การคำนวณฉลากทำฝั่งหน้าเว็บ */
const INCI_REF_KINDS: Record<string, number> = { a26: 1, a83: 1, claim: 1, banned: 1, supplier: 1 };
function inciComps(v: unknown) {
  return (Array.isArray(v) ? v : []).slice(0, 120).map((c: Any) => {
    const p = c && c.pct !== "" && c.pct !== null && c.pct !== undefined ? Number(String(c.pct).replace(/,/g, "")) : null;
    if (p !== null && (!isFinite(p) || p < 0 || p > 100)) throw new Error("% ของ " + str(c && c.inci, 60) + " ต้องอยู่ระหว่าง 0-100");
    const o: Any = { inci: str(c && c.inci, 250), cas: str(c && c.cas, 160), pct: p === null ? null : Math.round(p * 1e6) / 1e6 };
    if (c && c.ec) o.ec = str(c.ec, 60); if (c && c.origin) o.origin = str(c.origin, 60); if (c && c.noi !== undefined && c.noi !== null && c.noi !== "" && isFinite(Number(c.noi))) o.noi = Number(c.noi);
    return o;
  }).filter((c: Any) => c.inci);
}
const inciOut = (r: Any) => ({ code: String(r.code), name: String(r.name || ""), comps: r.comps || [], note: String(r.note || ""), status: String(r.status || ""), src: String(r.src || ""), files: r.files || [], updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function listInci(ctx: Ctx) {
  const m = await needAny(ctx, FDA_VIEW), db = ctx.db;
  const items = await db`select * from costing.rm_inci order by code`, refs = await db`select kind, inci, cas, data from costing.inci_ref order by kind, inci`;
  return { items: items.map(inciOut), refs: refs.map((r: Any) => ({ kind: String(r.kind), inci: String(r.inci), cas: String(r.cas || ""), ...(r.data || {}) })), canEdit: FDA_EDIT.some((p) => hasPerm(m, p)) };
}
function inciRow(it: Any, email: string) {
  const code = str(it && it.code, 40).toUpperCase(); if (!/^RM-[0-9A-Z]+-[0-9A-Z]+-[0-9A-Z]+$/.test(code)) throw new Error("รหัสวัตถุดิบไม่ถูกต้อง: " + (code || "(ว่าง)"));
  const comps = inciComps(it.comps);
  return { code, name: str(it.name, 300), comps, note: str(it.note, 1000), status: comps.length ? (it.status === "check" ? "check" : "") : "pending", src: str(it.src, 200), files: fdaFiles(it.files), updated_at: new Date(), updated_by: email };
}
async function saveInci(ctx: Ctx, it: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_EDIT), db = c.db, row = inciRow(it || {}, m.email);
    await db`insert into costing.rm_inci ${db({ ...row, comps: db.json(row.comps), files: db.json(row.files) })} on conflict (code) do update set name = excluded.name, comps = excluded.comps, note = excluded.note, status = excluded.status, src = excluded.src, files = excluded.files, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
    await log(db, m.email, "saveInci", row.code + " · " + row.comps.length + " INCI");
    return inciOut((await db`select * from costing.rm_inci where code = ${row.code}`)[0]);
  });
}
async function deleteInci(ctx: Ctx, code: string) {
  return await locked(ctx, async (c) => {
    const m = await need(c, "manageUsers"), db = c.db; code = String(code || "").toUpperCase();
    if (!(await db`delete from costing.rm_inci where code = ${code} returning code`).length) throw new Error("ไม่พบรหัสนี้");
    await log(db, m.email, "deleteInci", code); return { ok: true };
  });
}
/** นำเข้าแบบชุด (จากไฟล์ Breakdown) · keepExisting = ไม่ทับรหัสที่มี INCI อยู่แล้วด้วยแถวที่ไม่มี INCI · refs = แทนที่รายชื่ออ้างอิงตามชนิดที่ส่งมา */
async function importInci(ctx: Ctx, rows: Any, refs?: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, FDA_EDIT), db = c.db; rows = Array.isArray(rows) ? rows : [];
    if (rows.length > 600) throw new Error("นำเข้าได้ครั้งละไม่เกิน 600 รหัส");
    const out = { created: 0, updated: 0, kept: 0, skipped: 0, errors: [] as string[], refs: 0 };
    for (let i = 0; i < rows.length; i++) {
      let row: Any; try { row = inciRow(rows[i] || {}, m.email); } catch (e) { out.skipped++; if (out.errors.length < 10) out.errors.push(`แถว ${i + 1}: ${(e as Error).message}`); continue; }
      const ex = (await db`select comps from costing.rm_inci where code = ${row.code}`)[0];
      if (ex && !row.comps.length && (ex.comps || []).length) { out.kept++; continue; }
      await db`insert into costing.rm_inci ${db({ ...row, comps: db.json(row.comps), files: db.json(row.files) })} on conflict (code) do update set name = excluded.name, comps = excluded.comps, note = excluded.note, status = excluded.status, src = excluded.src, files = excluded.files, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
      if (ex) out.updated++; else out.created++;
    }
    if (Array.isArray(refs) && refs.length) {
      const kinds = [...new Set(refs.map((r: Any) => String(r && r.kind)).filter((k) => INCI_REF_KINDS[k]))];
      for (const k of kinds) await db`delete from costing.inci_ref where kind = ${k}`;
      for (const r of refs.slice(0, 2000)) { const k = String(r && r.kind); if (!INCI_REF_KINDS[k] || !str(r.inci, 250)) continue;
        const { kind: _k, inci: _i, cas: _c, ...rest } = r; await db`insert into costing.inci_ref ${db({ id: "ir-" + uuid(12), kind: k, inci: str(r.inci, 250), cas: str(r.cas, 160), data: db.json(rest) })}`; out.refs++; }
    }
    await log(db, m.email, "importInci", JSON.stringify(out).slice(0, 300));
    return out;
  });
}

/* ===== เตือนวันหมดอายุเลขจดแจ้งทางอีเมล =====
   ส่งด้วย Gmail ของผู้ใช้ผ่าน Google Apps Script (สคริปต์แยก ตั้ง trigger รายวัน) ซึ่งเรียก ?fdaCron=<secret>
   GET = ดึงรายการที่ถึงรอบเตือนพร้อมอีเมลที่จัดรูปแล้ว · POST {keys} = ยืนยันว่าส่งแล้ว (ไม่เตือนซ้ำรอบเดิม) */
const FDA_ALERT_DAYS = "180,90,60,30,14,7";
function fdaAlertDaysList(v: unknown) {
  const a = [...new Set(String(v || FDA_ALERT_DAYS).split(",").map((s) => Math.round(Number(s.trim()))).filter((n) => n > 0 && n <= 730))].sort((x, y) => y - x);
  return a.length ? a : FDA_ALERT_DAYS.split(",").map(Number);
}
const fdaTodayBkk = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
const fdaDaysLeft = (exp: string, today: string) => Math.round((Date.parse(exp + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
const fdaThDate = (d: string) => { if (!d) return "-"; const [y, m, dd] = d.split("-"); return `${+dd}/${+m}/${+y + 543}`; };
async function fdaAlertRecipients(db: Db) {
  const rows = await db`select u.email from costing.users u join costing.roles r on r.id = u.role where u.active is not false and (r.perms->>'ra') = 'true' order by u.email`;
  const extra = splitList(await getSetting(db, "fdaAlertExtra")).map(normEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return [...new Set([...rows.map((r: Any) => normEmail(r.email)), ...extra])];
}
/** stage = รอบเตือนที่เล็กที่สุดที่ครอบจำนวนวันที่เหลือ (−1 = หมดอายุแล้ว) · เตือนเมื่อ stage ใหม่ < stage ที่เคยเตือนสำหรับวันหมดอายุเดียวกัน */
async function fdaAlertItems(db: Db) {
  const days = fdaAlertDaysList(await getSetting(db, "fdaAlertDays")), max = days[0], today = fdaTodayBkk();
  const regs = await db`select * from costing.fda_regs where cancelled = false and decision <> 'no' and expiry <> '' order by expiry`;
  const due: Any[] = [], fresh: Any[] = [];
  regs.forEach((r: Any) => {
    const n = fdaDaysLeft(String(r.expiry), today); if (n > max || n < -30) return;
    const stage = n < 0 ? -1 : days.filter((d) => n <= d).pop()!, a = (r.data && r.data.alert) || {};
    const it = { id: String(r.id), regNo: String(r.reg_no), expiry: String(r.expiry), daysLeft: n, stage, tradeName: String(r.trade_name || ""), productName: String(r.product_name || ""), decision: String(r.decision || "") };
    due.push(it); if (a.expiry !== it.expiry || a.stage === undefined || stage < Number(a.stage)) fresh.push(it);
  });
  return { days, today, due, fresh };
}
function fdaAlertMail(x: Any, url: string) {
  const dec = (d: string) => d === "renew" ? "ตัดสินใจต่ออายุแล้ว (ยังไม่บันทึกการต่อ)" : "ยังไม่ตัดสินใจ";
  const left = (n: number) => n < 0 ? `หมดอายุแล้ว ${-n} วัน` : n === 0 ? "หมดอายุวันนี้" : `เหลือ ${n} วัน`;
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
  const row = (i: Any) => `<tr><td style="padding:4px 8px;border:1px solid #ddd;font-family:monospace">${esc(i.regNo)}</td><td style="padding:4px 8px;border:1px solid #ddd">${esc(i.productName)}<br><span style="color:#666;font-size:12px">${esc(i.tradeName)}</span></td><td style="padding:4px 8px;border:1px solid #ddd;white-space:nowrap">${fdaThDate(i.expiry)}</td><td style="padding:4px 8px;border:1px solid #ddd;white-space:nowrap;color:${i.daysLeft <= 30 ? "#b00020" : "#8a5200"};font-weight:600">${left(i.daysLeft)}</td><td style="padding:4px 8px;border:1px solid #ddd;font-size:12px">${dec(i.decision)}</td></tr>`;
  const table = (list: Any[]) => `<table style="border-collapse:collapse;font-size:13px"><tr style="background:#f3f3f3"><th style="padding:4px 8px;border:1px solid #ddd">เลขที่จดแจ้ง</th><th style="padding:4px 8px;border:1px solid #ddd">ผลิตภัณฑ์</th><th style="padding:4px 8px;border:1px solid #ddd">วันหมดอายุ</th><th style="padding:4px 8px;border:1px solid #ddd">เหลือ</th><th style="padding:4px 8px;border:1px solid #ddd">การต่ออายุ</th></tr>${list.map(row).join("")}</table>`;
  const exp = x.fresh.filter((i: Any) => i.daysLeft < 0).length, soon = x.fresh.length - exp;
  const subject = `[R&D · RA] เตือนเลขจดแจ้ง อย. ${soon ? `ใกล้หมดอายุ ${soon} รายการ` : ""}${soon && exp ? " · " : ""}${exp ? `หมดอายุแล้ว ${exp} รายการ` : ""}`;
  const others = x.due.filter((i: Any) => !x.fresh.some((f: Any) => f.id === i.id));
  const link = url.replace(/\/?$/, "/");
  const html = `<div style="font-family:Tahoma,Arial,sans-serif;font-size:14px;color:#222"><p>เลขจดแจ้งเครื่องสำอางที่ถึงรอบเตือน (${x.days.join(" / ")} วันก่อนหมดอายุ) ณ วันที่ ${fdaThDate(x.today)}</p>${table(x.fresh)}
    ${others.length ? `<p style="margin-top:18px">รายการอื่นที่ใกล้หมดอายุภายใน ${x.days[0]} วัน (เคยเตือนแล้ว)</p>${table(others)}` : ""}
    <p style="margin-top:18px">ตัดสินใจต่ออายุ / บันทึกการต่ออายุได้ที่ <a href="${link}">${esc(link)}</a> → แท็บ "จดแจ้ง อย."</p><p style="color:#888;font-size:12px">อีเมลอัตโนมัติจากระบบแผนกวิจัยและพัฒนา Scent &amp; Sense · ใบรับจดแจ้งมีอายุ 3 ปี ยื่นต่ออายุได้ก่อนหมดอายุ</p></div>`;
  const text = `เลขจดแจ้งที่ถึงรอบเตือน ณ ${fdaThDate(x.today)}\n` + x.fresh.map((i: Any) => `- ${i.regNo} ${i.productName} หมดอายุ ${fdaThDate(i.expiry)} (${left(i.daysLeft)})`).join("\n") + `\n\nดูรายละเอียด: ${link}`;
  return { subject, html, text };
}
function fdaAlertScript(url: string, secret: string) {
  const ep = url + "?fdaCron=" + secret;
  return `/** เตือนวันหมดอายุเลขจดแจ้ง อย. ทางอีเมล (Scent & Sense R&D)
 * วิธีติดตั้ง: วางโค้ดนี้ในโปรเจกต์ Apps Script ใหม่ (script.new) → บันทึก → เลือกฟังก์ชัน setup → กด Run → อนุญาตสิทธิ์
 * setup จะตั้งให้ทำงานทุกวันเวลา 08:00 และส่งรอบแรกทันที (ถ้ามีรายการถึงรอบเตือน)
 * ห้ามเผยแพร่โค้ดนี้ เพราะมีรหัสลับของระบบ */
const ENDPOINT = ${JSON.stringify(ep)};
function sendFdaReminders() {
  const res = UrlFetchApp.fetch(ENDPOINT, { muteHttpExceptions: true });
  const r = JSON.parse(res.getContentText());
  if (!r.ok) throw new Error(r.error || 'ระบบตอบกลับผิดพลาด');
  if (!r.count || !r.recipients.length) return;
  MailApp.sendEmail({ to: r.recipients.join(','), subject: r.subject, htmlBody: r.html, body: r.text, name: 'Scent & Sense R&D' });
  UrlFetchApp.fetch(ENDPOINT, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ keys: r.keys, sentTo: r.recipients.length }), muteHttpExceptions: true });
}
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendFdaReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendFdaReminders').timeBased().everyDays(1).atHour(8).inTimezone('Asia/Bangkok').create();
  sendFdaReminders();
}
`;
}
async function getFdaAlert(ctx: Ctx) {
  const m = await needAny(ctx, FDA_EDIT), db = ctx.db, admin = isAdmin(m);
  let secret = await getSetting(db, "fdaAlertSecret");
  if (!secret && admin) { secret = uuid(32) + uuid(16); await setSetting(db, "fdaAlertSecret", secret); }
  const x = await fdaAlertItems(db), url = await appUrl(db), mail = fdaAlertMail(x, url);
  return { days: x.days.join(","), extra: (await getSetting(db, "fdaAlertExtra")) || "", recipients: await fdaAlertRecipients(db), last: (await getSetting(db, "fdaAlertLast")) || "",
    lastPoll: (await getSetting(db, "fdaAlertPoll")) || "", dueCount: x.due.length, freshCount: x.fresh.length, subject: mail.subject, html: mail.html,
    script: admin && secret ? fdaAlertScript(Deno.env.get("SUPABASE_URL") + "/functions/v1/api", secret) : "", admin };
}
async function saveFdaAlert(ctx: Ctx, c: Any) {
  return await locked(ctx, async (cx) => {
    const m = await needAny(cx, FDA_EDIT), db = cx.db; c = c || {};
    const extra = splitList(c.extra).map(normEmail); const bad = extra.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)); if (bad.length) throw new Error("อีเมลไม่ถูกต้อง: " + bad.join(", "));
    await setSetting(db, "fdaAlertDays", fdaAlertDaysList(c.days).join(",")); await setSetting(db, "fdaAlertExtra", extra.join(","));
    await log(db, m.email, "saveFdaAlert", fdaAlertDaysList(c.days).join(",") + " · " + extra.join(","));
    return await getFdaAlert(cx);
  });
}
/** สร้างรหัสลับใหม่ (สคริปต์เดิมจะใช้ไม่ได้ ต้องวางโค้ดใหม่) */
async function resetFdaAlertSecret(ctx: Ctx) {
  const m = await needAdmin(ctx); await setSetting(ctx.db, "fdaAlertSecret", uuid(32) + uuid(16)); await log(ctx.db, m.email, "resetFdaAlertSecret", "");
  return await getFdaAlert(ctx);
}
function sameSecret(a: string, b: string) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function fdaCron(secret: string, req: Request) {
  const db = sql, saved = await getSetting(db, "fdaAlertSecret");
  if (!sameSecret(String(secret || ""), String(saved || ""))) return { ok: false, error: "FORBIDDEN" };
  if (req.method === "POST") {
    const body = JSON.parse((await req.text()) || "{}"), keys = Array.isArray(body.keys) ? body.keys.slice(0, 2000) : []; let n = 0;
    for (const k of keys) {
      const r = (await db`select data from costing.fda_regs where id = ${String(k && k.id || "")}`)[0]; if (!r) continue;
      await db`update costing.fda_regs set data = ${db.json({ ...(r.data || {}), alert: { expiry: String(k.expiry || ""), stage: Number(k.stage), at: new Date().toISOString() } })} where id = ${String(k.id)}`; n++;
    }
    await setSetting(db, "fdaAlertLast", `${bkk(new Date())} · ${n} รายการ · ส่งถึง ${Number(body.sentTo) || 0} คน`);
    await log(db, "cron", "fdaAlertSent", String(n));
    return { ok: true, marked: n };
  }
  await setSetting(db, "fdaAlertPoll", bkk(new Date()));
  const x = await fdaAlertItems(db), recipients = await fdaAlertRecipients(db);
  if (!x.fresh.length) return { ok: true, count: 0, recipients, keys: [] };
  const mail = fdaAlertMail(x, await appUrl(db));
  return { ok: true, count: x.fresh.length, recipients, keys: x.fresh.map((i: Any) => ({ id: i.id, stage: i.stage, expiry: i.expiry })), ...mail };
}

/* ===== Dashboard ผู้บริหาร: สรุปภาพรวมการทำงานทุกแผนกในคำขอเดียว (ตัวเลขรวม ไม่มีข้อมูลราคา) ===== */
const DASH_VIEW = RD_VIEW;
/** รายการเดือน YYYY-MM ย้อนหลัง n เดือน (เวลาไทย) เรียงเก่า → ใหม่ */
function dashMonths(n: number) {
  const out: string[] = []; const p = bkkParts(new Date()); let y = Number(p.yyyy), m = Number(p.mm);
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } }
  return out;
}
/** กำหนดส่งของขั้นปัจจุบัน (ตรรกะเดียวกับหน้าโครงการ): วันเข้าขั้น + SLA · ขั้น 3/5 ที่ส่งตัวอย่างแล้วนับจากวันส่ง */
function dashDue(p: Any, sla: Record<string, number>, sent: Record<string, string>, now: number) {
  const st = String(p.stage), entered = p.actual && p.actual[st]; if (!entered || st === "done" || st === "lost") return null;
  let days = sla[st], from = String(entered), waiting = false;
  if (st === "s3" || st === "s5") { const s = sent[p.id + "|" + (st === "s3" ? "scent" : "mockup")]; if (s) { from = s; days = sla[st === "s3" ? "s3eval" : "s5eval"]; waiting = true; } }
  const inStage = Math.floor((now - Date.parse(String(entered))) / 86400000);
  if (!days) return { left: null, overdue: false, waiting, inStage };
  const left = Math.ceil((Date.parse(from) + days * 86400000 - now) / 86400000);
  return { left, overdue: left < 0, waiting, inStage };
}
async function dashboard(ctx: Ctx, months?: number) {
  const m = await needAny(ctx, DASH_VIEW), db = ctx.db;
  const n = Math.min(Math.max(Math.round(Number(months) || 12), 3), 36), keys = dashMonths(n), since = keys[0] + "-01", now = Date.now(), today = fdaTodayBkk();
  const series = (rows: Any[]) => { const o: Record<string, number> = {}; keys.forEach((k) => { o[k] = 0; }); rows.forEach((r: Any) => { if (o[String(r.ym)] !== undefined) o[String(r.ym)] = Number(r.n); }); return keys.map((k) => o[k]); };
  const counts = (rows: Any[], k: string) => { const o: Record<string, number> = {}; rows.forEach((r: Any) => { o[String(r[k] ?? "")] = (o[String(r[k] ?? "")] || 0) + Number(r.n); }); return o; };
  const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] || 0) + 1; };

  /* ---- โครงการ (Project Coordinator) ---- */
  const sla = await rdSla(db);
  const projs = await db`select id, pdr_no, brand, company, kind, stage, owners, actual, ra, created_at, updated_at from costing.projects`;
  const sentRows = await db`select project_id, kind, max(shipped_at) as shipped from costing.samples where status = 'sent' and shipped_at is not null group by project_id, kind`;
  const sent: Record<string, string> = {}; sentRows.forEach((r: Any) => { sent[String(r.project_id) + "|" + String(r.kind)] = iso(r.shipped); });
  const byStage: Record<string, number> = {}, overdueByStage: Record<string, number> = {}, byKind: Record<string, number> = {}, raStatus: Record<string, number> = {}, pcLoad: Record<string, Any> = {}, pfLoad: Record<string, Any> = {};
  const ageSum: Record<string, number> = {}, ageN: Record<string, number> = {}, overdue: Any[] = [], waitingCust: Any[] = [];
  let active = 0, lead = 0, leadN = 0, doneInPeriod = 0, openedInPeriod = 0, lostInPeriod = 0;
  const doneM: Record<string, number> = {}, openM: Record<string, number> = {};
  for (const p of projs) {
    const st = String(p.stage); inc(byStage, st); inc(byKind, String(p.kind || "new"));
    const cm = iso(p.created_at).slice(0, 7); if (cm >= keys[0]) { openedInPeriod++; inc(openM, cm); }
    if (st === "done" || st === "lost") {
      const endAt = p.actual && p.actual[st] ? String(p.actual[st]) : iso(p.updated_at);
      if (endAt.slice(0, 7) >= keys[0]) { if (st === "done") { doneInPeriod++; inc(doneM, endAt.slice(0, 7)); } else lostInPeriod++; }
      if (st === "done" && p.created_at) { lead += (Date.parse(endAt) - Date.parse(iso(p.created_at))) / 86400000; leadN++; }
      continue;
    }
    active++;
    const ra = p.ra && p.ra.status ? String(p.ra.status) : "pending"; inc(raStatus, ra);
    const d = dashDue(p, sla, sent, now), ow = p.owners || {}, item = { id: String(p.id), pdrNo: String(p.pdr_no), brand: String(p.brand || p.company || ""), stage: st, left: d ? d.left : null, inStage: d ? d.inStage : null, pc: String(ow.pc || ""), waiting: !!(d && d.waiting) };
    if (d) { ageSum[st] = (ageSum[st] || 0) + d.inStage; ageN[st] = (ageN[st] || 0) + 1; if (d.overdue) { inc(overdueByStage, st); overdue.push(item); } if (d.waiting) waitingCust.push(item); }
    const pc = String(ow.pc || "") || "(ไม่ระบุ)"; pcLoad[pc] = pcLoad[pc] || { n: 0, overdue: 0 }; pcLoad[pc].n++; if (d && d.overdue) pcLoad[pc].overdue++;
    (Array.isArray(ow.perfumer) ? ow.perfumer : []).forEach((e: string) => { pfLoad[e] = pfLoad[e] || { n: 0, s3: 0 }; pfLoad[e].n++; if (st === "s3") pfLoad[e].s3++; });
  }
  overdue.sort((a, b) => (a.left ?? 0) - (b.left ?? 0));
  const ageAvg: Record<string, number> = {}; Object.keys(ageN).forEach((k) => { ageAvg[k] = Math.round(ageSum[k] / ageN[k]); });
  const projects = { total: projs.length, active, byStage, overdueByStage, byKind, raStatus, ageAvg, overdueCount: overdue.length, overdue: overdue.slice(0, 20), waitingCustomer: waitingCust.length,
    openedInPeriod, doneInPeriod, lostInPeriod, leadDays: leadN ? Math.round(lead / leadN) : null, pcLoad, pfLoad,
    openedM: keys.map((k) => openM[k] || 0), doneM: keys.map((k) => doneM[k] || 0), sla };

  /* ---- Perfumer: กลิ่น บรีฟ ตัวอย่างกลิ่น ผลประเมินลูกค้า ---- */
  const scStatus = counts(await db`select status, count(*)::int as n from costing.scents group by status`, "status");
  const brStatus = counts(await db`select status, count(*)::int as n from costing.briefs group by status`, "status");
  const scM = series(await db`select to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.scents where created_at >= ${since}::date group by 1`);
  const evalStats = async (kind: string) => {
    const sentM = series(await db`select to_char(shipped_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.samples where kind = ${kind} and shipped_at is not null and shipped_at >= ${since}::date group by 1`);
    const evM = series(await db`select to_char(coalesce(nullif(eval->>'submittedAt', '')::timestamptz, updated_at) at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.samples where kind = ${kind} and status = 'evaluated' and coalesce(nullif(eval->>'submittedAt', '')::timestamptz, updated_at) >= ${since}::date group by 1`);
    const st = counts(await db`select status, count(*)::int as n from costing.samples where kind = ${kind} group by status`, "status");
    const dec = counts(await db`select coalesce(nullif(e->>'decision', ''), '(ไม่ระบุ)') as d, count(*)::int as n from costing.samples s, jsonb_array_elements(case when jsonb_typeof(s.eval->'items') = 'array' then s.eval->'items' else '[]'::jsonb end) e where s.kind = ${kind} and s.status = 'evaluated' group by 1`, "d");
    const sc = await db`select avg((coalesce((e->'scores'->>'scent')::numeric, 0) + coalesce((e->'scores'->>'appearance')::numeric, 0) + coalesce((e->'scores'->>'skinfeel')::numeric, 0) + coalesce((e->'scores'->>'target')::numeric, 0) + coalesce((e->'scores'->>'brand')::numeric, 0) + coalesce((e->'scores'->>'overall')::numeric, 0)) / 30 * 100) as pct, count(*)::int as n from costing.samples s, jsonb_array_elements(case when jsonb_typeof(s.eval->'items') = 'array' then s.eval->'items' else '[]'::jsonb end) e where s.kind = ${kind} and s.status = 'evaluated' and jsonb_typeof(e->'scores') = 'object' and e->'scores' <> '{}'::jsonb`;
    const pending = (await db`select count(*)::int as n from costing.samples where kind = ${kind} and status = 'sent'`)[0].n;
    return { sentM, evaluatedM: evM, status: st, decisions: dec, avgScore: sc[0] && sc[0].pct !== null ? Math.round(Number(sc[0].pct)) : null, scored: Number(sc[0] ? sc[0].n : 0), awaiting: Number(pending) };
  };
  const perfumer = { scents: scStatus, scentsTotal: Object.values(scStatus).reduce((a, b) => a + b, 0), briefs: brStatus, scentsM: scM, samples: await evalStats("scent"), load: pfLoad };

  /* ---- Product Development: สูตรผลิตภัณฑ์ บันทึกขึ้นสินค้าทดลอง ต้นแบบ ---- */
  const fmStatus = counts(await db`select status, count(*)::int as n from costing.pd_formulas group by status`, "status");
  const fmM = series(await db`select to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.pd_formulas where created_at >= ${since}::date group by 1`);
  const ptStatus = counts(await db`select status, count(*)::int as n from costing.pd_trials group by status`, "status");
  const ptM = series(await db`select to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.pd_trials where created_at >= ${since}::date group by 1`);
  const bases = (await db`select count(*)::int as n, sum(case when active then 1 else 0 end)::int as a from costing.pd_bases`)[0];
  const pdLoad = counts(await db`select coalesce(nullif(created_by, ''), '(ไม่ระบุ)') as who, count(*)::int as n from costing.pd_formulas where created_at >= ${since}::date group by 1`, "who");
  const pd = { formulas: fmStatus, formulasTotal: Object.values(fmStatus).reduce((a, b) => a + b, 0), formulasM: fmM, trials: ptStatus, trialsM: ptM, bases: Number(bases.n), basesActive: Number(bases.a), mockups: await evalStats("mockup"), load: pdLoad };

  /* ---- RA: ตรวจกฎหมายโครงการ เลขจดแจ้ง อย. คำขอจดแจ้ง ฐาน INCI เอกสารวัตถุดิบ ---- */
  const regs = await db`select expiry, decision, cancelled, data->'history' as hist from costing.fda_regs`;
  const fda: Record<string, number> = { ok: 0, soon: 0, urgent: 0, expired: 0, no: 0, cancel: 0 }; let renewedInPeriod = 0; const expM: Record<string, number> = {};
  regs.forEach((r: Any) => {
    const left = r.expiry ? fdaDaysLeft(String(r.expiry), today) : null;
    const st = r.cancelled ? "cancel" : left !== null && left < 0 ? (r.decision === "no" ? "no" : "expired") : r.decision === "no" ? "no" : left !== null && left <= 90 ? "urgent" : left !== null && left <= 180 ? "soon" : "ok";
    inc(fda, st); if (st === "ok" || st === "soon" || st === "urgent") { const k = String(r.expiry).slice(0, 7); expM[k] = (expM[k] || 0) + 1; }
    (Array.isArray(r.hist) ? r.hist : []).forEach((h: Any) => { if (String(h.renewedAt || "").slice(0, 7) >= keys[0]) renewedInPeriod++; });
  });
  const next12 = (() => { const out: string[] = []; const p = bkkParts(new Date()); let y = Number(p.yyyy), mm = Number(p.mm); for (let i = 0; i < 12; i++) { out.push(`${y}-${String(mm).padStart(2, "0")}`); mm++; if (mm === 13) { mm = 1; y++; } } return out; })();
  const reqStatus = counts(await db`select status, count(*)::int as n from costing.fda_requests group by status`, "status");
  const reqM = series(await db`select to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.fda_requests where created_at >= ${since}::date group by 1`);
  const inci = (await db`select count(*)::int as total, sum(case when jsonb_array_length(comps) > 0 then 1 else 0 end)::int as has, sum(case when status = 'check' then 1 else 0 end)::int as chk from costing.rm_inci`)[0];
  const docType = counts(await db`select type, count(*)::int as n from costing.docs where status = 'issued' and issued_at >= ${since}::date group by type`, "type");
  const docM = series(await db`select to_char(issued_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.docs where status = 'issued' and issued_at >= ${since}::date group by 1`);
  const ra = { projectRa: raStatus, fda, fdaTotal: regs.length, fdaExpiring12: next12.map((k) => expM[k] || 0), fdaMonths12: next12, renewedInPeriod, requests: reqStatus, requestsM: reqM,
    requestsOpen: Object.entries(reqStatus).filter(([k]) => k !== "เรียบร้อย" && k !== "ยกเลิกใบจดแจ้ง").reduce((a, [, v]) => a + v, 0), inci: { total: Number(inci.total), has: Number(inci.has), check: Number(inci.chk) }, docType, docM };

  /* ---- Research Ingredients: ทะเบียนพืชหอม การสกัด คลัง R&D ---- */
  const bt = await db`select data->>'status' as s, data->>'form' as f, count(*)::int as n from costing.botanicals group by 1, 2`;
  const btStatus: Record<string, number> = {}, btForm: Record<string, number> = {}; bt.forEach((r: Any) => { btStatus[String(r.s || "")] = (btStatus[String(r.s || "")] || 0) + Number(r.n); btForm[String(r.f || "(ไม่ระบุ)")] = (btForm[String(r.f || "(ไม่ระบุ)")] || 0) + Number(r.n); });
  const exM = series(await db`select to_char(created_at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.botanical_extractions where created_at >= ${since}::date group by 1`);
  const exRes = counts(await db`select coalesce(nullif(data->>'result', ''), '(ไม่ระบุ)') as r, count(*)::int as n from costing.botanical_extractions group by 1`, "r");
  const stk = await db`select i.kind, count(*)::int as n, sum(case when coalesce(b.bal, 0) <= 0 then 1 else 0 end)::int as zero, sum(case when i.min_qty is not null and coalesce(b.bal, 0) < i.min_qty then 1 else 0 end)::int as low, sum(case when b.last_at is null or b.last_at < now() - interval '90 days' then 1 else 0 end)::int as stale from costing.rdstock_items i left join (select item_id, sum(qty) as bal, max(at) as last_at from costing.rdstock_tx group by item_id) b on b.item_id = i.id where i.active group by i.kind`;
  const stock: Record<string, Any> = {}; stk.forEach((r: Any) => { stock[String(r.kind)] = { n: Number(r.n), zero: Number(r.zero), low: Number(r.low), stale: Number(r.stale) }; });
  const txM = await db`select to_char(at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, kind, count(*)::int as n from costing.rdstock_tx where at >= ${since}::date and created_by not like 'import:%' group by 1, 2`;
  const txIn = series(txM.filter((r: Any) => r.kind === "in")), txOut = series(txM.filter((r: Any) => r.kind === "out")), txAdj = series(txM.filter((r: Any) => r.kind === "adjust"));
  const lowItems = await db`select i.code, i.name, i.unit, i.min_qty, coalesce(b.bal, 0) as bal from costing.rdstock_items i left join (select item_id, sum(qty) as bal from costing.rdstock_tx group by item_id) b on b.item_id = i.id where i.active and i.min_qty is not null and coalesce(b.bal, 0) < i.min_qty order by coalesce(b.bal, 0) / nullif(i.min_qty, 0) limit 15`;
  const research = { botanicals: Object.values(btStatus).reduce((a, b) => a + b, 0), btStatus, btForm, extractionsM: exM, extractionsTotal: Object.values(exRes).reduce((a, b) => a + b, 0), extractionResults: exRes, stock, txIn, txOut, txAdj,
    lowItems: lowItems.map((r: Any) => ({ code: String(r.code), name: String(r.name), unit: String(r.unit || ""), min: Number(r.min_qty), bal: Math.round(Number(r.bal) * 100) / 100 })) };

  /* ---- การใช้งานระบบ: ผู้ใช้ตามบทบาท กิจกรรม 30 วัน (จาก log) ---- */
  const roles = await db`select u.role, coalesce(r.name, u.role) as name, count(*)::int as n from costing.users u left join costing.roles r on r.id = u.role where u.active group by u.role, r.name order by 3 desc`;
  const act = await db`select coalesce(u.role, '(ไม่มีบัญชี)') as role, count(*)::int as n, count(distinct l.email)::int as users, max(l.at) as last from costing.log l left join costing.users u on u.email = l.email where l.at >= now() - interval '30 days' and l.action not in ('pwLogin', 'pwLoginFail', 'pwLogout', 'requestAccess') group by 1`;
  const actM = series(await db`select to_char(at at time zone 'Asia/Bangkok', 'YYYY-MM') as ym, count(*)::int as n from costing.log where at >= ${since}::date and action not in ('pwLogin', 'pwLoginFail', 'pwLogout') group by 1`);
  const activeUsers = Number((await db`select count(distinct email)::int as n from costing.log where at >= now() - interval '30 days'`)[0].n);
  const people = { roles: roles.map((r: Any) => ({ id: String(r.role), name: String(r.name), n: Number(r.n) })), activity30: act.map((r: Any) => ({ role: String(r.role), n: Number(r.n), users: Number(r.users), last: iso(r.last) })), activityM: actM, activeUsers };

  await log(db, m.email, "dashboard", `${n} เดือน`);
  return { months: keys, generatedAt: new Date().toISOString(), projects, perfumer, pd, ra, research, people };
}

/* ===== ตารางฟังก์ชันที่หน้าเว็บเรียกได้ ===== */
const API: Record<string, (ctx: Ctx, ...a: Any[]) => Promise<unknown>> = {
  bootstrap, requestAccess, savePrices, resetPrices, saveExport, adminData, setUser, removeUser, declineRequest, saveAccess, createRole, updateRole, deleteRole,
  loadMyFormulas, saveMyFormulas, adminFormulas, loadPricing, savePricing, updatePrices, submitComplaint, myComplaints, adminComplaints, replyComplaint,
  loadCompliance, saveComplianceRules, saveRmMap, listDocs, getDoc, issueDoc, voidDoc, listRmDocs, getRmDocFile, uploadRmDoc, updateRmDoc, deleteRmDoc,
  listBriefs, saveBrief, deleteBrief, listScents, saveScent, deleteScent, getTypeformStatus, saveTypeformToken, syncTypeform, disconnectTypeform,
  pwLogin, setMyPassword, pwLogout, resetUserPassword,
  listCustomers, saveCustomer, listProjects, getProject, saveProject, setStage, bulkStage, raCheck, issueProjectDoc, uploadProjectDoc, getProjectDocFile, deleteProjectDoc, listSamples, saveSample, sendSample, deleteSample, evalSummary, importRd,
  listPdBases, savePdBase, deletePdBase, listPdFormulas, savePdFormula, deletePdFormula, importPdBases, importPdFormulas, searchPdImported, getPdFormula, listPdDocFormulas, listPdCustomers, listPdByCustomer, searchPdFormulas, listLabelArchive, getLabelArchive, saveLabelArchive, deleteLabelArchive, listPdDupKeys, listPriceQuotes, importPriceQuotes, saveProjectMockups, setUserName, listPeopleNames, saveProjectScentDesign, listRmOlf, saveRmOlf, seedRmOlf,
  listPdTrials, savePdTrial, sendPdTrial, decidePdTrial, issuePdTrialStock,
  listRdStock, listRdStockTx, saveRdStockItem, deleteRdStockItem, addRdStockTx, importRdStock,
  listFda, saveFdaReg, renewFdaReg, deleteFdaReg, saveFdaRequest, deleteFdaRequest, getFdaAlert, saveFdaAlert, resetFdaAlertSecret,
  listInci, saveInci, deleteInci, importInci,
  dashboard,
  listFormulaHistory, addFormulaFeedback, deleteFormulaFeedback, snapshotFormulaVersion, listBotanicals, getBotanicalPlate, getBotanicalPrices, saveBotanicalPrice, saveBotanical, deleteBotanical, uploadBotanicalImage, listBotanicalExtractions, saveBotanicalExtraction, deleteBotanicalExtraction, importBotanicals, importBotanicalImage,
  importAll, importRmFile, finishMigration,
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  touchDb(); inflight++;   /* never recycle the pool under a request that is still running */
  try { return await handle(req); } finally { inflight--; lastDbUse = Date.now(); }
});
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get("tf")) return await tfWebhook(req, url);
  /* ลิงก์ประเมินตัวอย่างของลูกค้า: GET แสดงฟอร์ม, POST บันทึกผล (ไม่ต้อง log in ใช้ token ของชุดตัวอย่าง) */
  if (url.searchParams.get("eval")) {
    const tok = url.searchParams.get("eval") || "";
    try { return await guard(evalPage(tok), 12000); } catch (err) { if (!(err instanceof DbStuck)) throw err; freshPool("evalPage stuck"); return await guard(evalPage(tok), 25000); }   /* read-only page: retry once automatically */
  }
  /* เตือนวันหมดอายุเลขจดแจ้ง: เรียกจาก Google Apps Script รายวัน (ยืนยันด้วยรหัสลับใน settings) */
  if (url.searchParams.get("fdaCron")) {
    let out: Any; try { out = await fdaCron(url.searchParams.get("fdaCron") || "", req); } catch (err) { out = { ok: false, error: String((err && (err as Error).message) || err) }; }
    return new Response(JSON.stringify(out), { status: out.ok ? 200 : 403, headers: { "Content-Type": "application/json", ...CORS } });
  }
  if (url.searchParams.get("evalSubmit")) {
    let out: Any;
    try { out = await guard(evalSubmit(url.searchParams.get("evalSubmit") || "", JSON.parse((await req.text()) || "{}")), 30000); }
    catch (err) { if (err instanceof DbStuck) { freshPool("evalSubmit stuck"); out = { ok: false, error: "ระบบหน่วงชั่วคราว กรุณากดส่งอีกครั้ง" }; } else out = { ok: false, error: String((err && (err as Error).message) || err) }; }
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", ...CORS } });
  }
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "costing-api" }), { headers: { "Content-Type": "application/json", ...CORS } });
  let out: Any;
  try {
    const reqBody = JSON.parse((await req.text()) || "{}");
    if (!Object.prototype.hasOwnProperty.call(API, reqBody.fn)) throw new Error("UNKNOWN_FUNCTION");
    /* เข้าสู่ระบบด้วยรหัสผ่านเท่านั้น: ทุกฟังก์ชันใช้เซสชัน ยกเว้น pwLogin (ก่อนเข้าระบบ) และ setMyPassword ที่ยืนยันตัวตนด้วย Google ได้ (ตั้งครั้งแรก / ลืมรหัส) */
    const slowOk = /^import/.test(String(reqBody.fn)) || reqBody.fn === "syncTypeform";   /* bulk import / sync jobs are not cut off */
    const work = (async () => {
      let ctx: Ctx;
      if (reqBody.fn === "pwLogin") ctx = { email: "", db: sql, via: "none" };
      else if (reqBody.session) { const s = await sessionEmail(reqBody.session); ctx = { email: s.email, db: sql, via: "session", sid: s.sid }; }
      else if (reqBody.fn === "setMyPassword" && reqBody.idToken) ctx = { email: await verifyIdToken(reqBody.idToken), db: sql, via: "google" };
      else throw new Error(reqBody.idToken ? "AUTH_PASSWORD_REQUIRED" : "AUTH_REQUIRED");
      return await API[reqBody.fn](ctx, ...(Array.isArray(reqBody.args) ? reqBody.args : []));
    })();
    out = { ok: true, result: slowOk ? await work : await guard(work) };
  } catch (err) {
    if (err instanceof DbStuck) { freshPool("api stuck"); return new Response("RETRY: database connection was stuck", { status: 503, headers: { "Content-Type": "text/plain", ...CORS } }); }   /* not JSON → the web client retries by itself */
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", ...CORS } });
}
