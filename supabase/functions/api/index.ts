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
const PERM_KEYS = ["calc", "export", "viewDb", "editPrices", "manageUsers", "perfumer", "projects", "pd", "ra"];
const BUILTIN_SOURCE = { file: "PRODUCT RM - Summary RM.pdf", updated: "12/10/2026 11:41:18" };
const DEFAULT_PUBLIC_URL = "https://rd.scentandsense.co.th/";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  max: 4, prepare: false, idle_timeout: 20, connect_timeout: 15, transform: { undefined: null },
  types: {
    numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => parseFloat(x) },
    int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  },
});
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
  const users = await db`select email, role, active, added_by, added_at from costing.users order by added_at, email`;
  const reqs = await db`select email, at from costing.requests order by at`;
  const vis = await db`select email, first_seen, last_seen from costing.visitors order by first_seen`;
  const pw = new Set((await db`select email from costing.credentials`).map((r: Any) => String(r.email).toLowerCase()));
  return { owner: m.owner, me: m.email, withPassword: [...pw],
    users: users.map((r: Any) => ({ email: String(r.email).toLowerCase(), role: String(r.role), active: r.active !== false, addedBy: String(r.added_by || ""), addedAt: iso(r.added_at), hasPassword: pw.has(String(r.email).toLowerCase()) })),
    requests: reqs.map((r: Any) => ({ email: String(r.email).toLowerCase(), at: iso(r.at) })),
    visitors: vis.map((r: Any) => ({ email: String(r.email).toLowerCase(), firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen) })),
    roles: rr.roles, order: rr.order,
    access: { autoJoin: (await getSetting(db, "autoJoin")) === "true", defaultRole: (await getSetting(db, "defaultRole")) || "costing" } };
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
const DOC_TYPES: Record<string, number> = { STAB: 1, PACK: 1, SDS: 1, IFRA: 1, SPEC: 1 }, DOC_DATA_MAX = 45000;
const docOut = (r: Any, withData: boolean) => {
  const o: Any = { id: String(r.id), docNo: String(r.doc_no), type: String(r.type), formulaId: String(r.formula_id), owner: String(r.owner).toLowerCase(), product: String(r.product),
    customer: String(r.customer), brand: String(r.brand), status: String(r.status || "issued"), issuedAt: iso(r.issued_at), issuedBy: String(r.issued_by) };
  if (withData) o.data = String(r.data || "");
  return o;
};
const docVisible = (m: Me, r: Any) => isAdmin(m) || String(r.owner).toLowerCase() === m.email;
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
    const fr = await db`select id, owner, name from costing.formulas where id = ${formulaId} limit 1`;
    if (!fr.length) throw new Error("ไม่พบสูตรนี้ในระบบ (บันทึกสูตรก่อนออกเอกสาร)");
    const f = fr[0];
    if (!isAdmin(m) && String(f.owner).toLowerCase() !== m.email) throw new Error("FORBIDDEN");
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
const PF_VIEW = ["perfumer", "calc", "viewDb"], PF_DATA_MAX = 45000;
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
async function listScents(ctx: Ctx) { await needAny(ctx, PF_VIEW); return (await ctx.db`select * from costing.scents order by updated_at desc`).map(scentOut); }
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
    return scentOut({ ...row, data: pfData(s.data) });
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
const RD_VIEW = ["projects", "perfumer", "pd", "ra", "calc", "viewDb"], RD_EDIT = ["projects", "perfumer", "pd"], RD_DATA_MAX = 60000;
const RD_STAGES = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "done", "lost"];
const RD_KINDS: Record<string, number> = { new: 1, cost: 1, topping: 1, repeat: 1 };
const RD_SLA_DEFAULT: Record<string, number> = { s1: 1, s2: 2, s3: 15, s3send: 2, s3eval: 7, s5send: 2, s5eval: 7, s7: 1 };
const RA_STATUS: Record<string, number> = { pending: 1, pass: 1, cond: 1, fail: 1 };
const SAMPLE_KINDS: Record<string, number> = { scent: 1, mockup: 1 };
const EVAL_FIELDS = ["scent", "appearance", "skinfeel", "target", "brand", "overall"];
const EVAL_DECISIONS: Record<string, number> = { produce: 1, revise: 1, reject: 1 };

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
  await needAny(ctx, RD_VIEW); const db = ctx.db;
  const r = (await db`select * from costing.projects where id = ${String(id || "")}`)[0];
  if (!r) throw new Error("ไม่พบโครงการนี้");
  return { project: projOut(r), scents: (await db`select * from costing.scents where project_id = ${String(r.id)} order by created_at`).map(scentOut),
    samples: (await db`select * from costing.samples where project_id = ${String(r.id)} order by created_at`).map((s: Any) => sampleOut(s, "")), sla: await rdSla(db) };
}
async function saveProject(ctx: Ctx, p: Any) {
  return await locked(ctx, async (c) => {
    const m = await needAny(c, ["projects", "perfumer"]), db = c.db;
    p = p || {};
    const now = new Date(), ex = p.id ? (await db`select * from costing.projects where id = ${String(p.id)}`)[0] : null;
    if (p.id && !ex) throw new Error("ไม่พบโครงการนี้ (อาจถูกลบไปแล้ว)");
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
    case "s4": return (await decided("scent")) ? "" : 'ลูกค้ายังไม่ได้เลือก "ผลิตจริงต่อไป" ให้กลิ่นใด (ต้องมีผลประเมินตัวอย่างกลิ่น)';
    case "s5": return (await db`select 1 from costing.samples where project_id = ${String(pr.id)} and kind = 'mockup' limit 1`).length ? "" : "ยังไม่มีชุดตัวอย่างต้นแบบสินค้า (FM-RD-04)";
    case "s6": return (await decided("mockup")) ? "" : 'ลูกค้ายังไม่ได้ยืนยันต้นแบบ (ต้องมีผลประเมินต้นแบบที่เลือก "ผลิตจริงต่อไป")';
    case "s7": return d.stability && (d.stability.standard || d.stability.result === "pass") ? "" : "บันทึก Stability ก่อน: เบสเดิมใช้เอกสารมาตรฐาน หรือเบสใหม่ต้องมีผลทดสอบผ่าน (FM-RD-08)";
    case "s8": return d.bom && d.bom.released ? "" : "ออก BOM และบันทึกส่งมอบสูตร (FM-RD-09) ก่อน";
    case "done": return !(d.bom && d.bom.released) ? "ออก BOM และบันทึกส่งมอบสูตร (FM-RD-09) ก่อน" : d.newFormula && !(d.pilot && d.pilot.result === "pass") ? "สูตรใหม่ต้องทำ Pilot Batch ให้ผ่านก่อน (FM-RD-07)" : "";
    default: return "";
  }
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
  const itemHtml = (it: Any, i: number) => { const pv = prev(it.code); return `<div class="card" data-item="${i}"><h2>${hx(it.code || "ตัวอย่าง " + (i + 1))}${it.name ? " · " + hx(it.name) : ""}</h2>${it.size ? `<div class="muted">${hx(it.size)}${it.qty ? " × " + hx(it.qty) : ""}</div>` : ""}
    ${CRIT.map(([k, l]) => `<div class="crit"><span>${l}</span><div class="scale">${[1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="s${i}_${k}" value="${v}" ${Number((pv.scores || {})[k]) === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div></div>`).join("")}
    <div style="margin-top:8px"><div class="muted">ความเห็น / ข้อเสนอแนะ</div><textarea name="c${i}" rows="2" maxlength="1000">${hx(pv.comment || "")}</textarea></div>
    <div class="dec" style="margin-top:8px"><div class="muted">ตัวอย่างนี้เหมาะสำหรับ</div><label><input type="radio" name="d${i}" value="produce" ${pv.decision === "produce" ? "checked" : ""}><span>ผลิตจริงต่อไป</span></label><label><input type="radio" name="d${i}" value="revise" ${pv.decision === "revise" ? "checked" : ""}><span>ปรับแก้แล้วส่งใหม่</span></label><label><input type="radio" name="d${i}" value="reject" ${pv.decision === "reject" ? "checked" : ""}><span>ไม่เลือก</span></label></div></div>`; };
  const body = `<div class="brandbar">Scent &amp; Sense · แผนกวิจัยและพัฒนา</div><h1>แบบประเมิน${String(r.kind) === "mockup" ? "ต้นแบบผลิตภัณฑ์" : "ตัวอย่างกลิ่น"}</h1>
    <div class="muted">${hx(r.brand || r.company)}${r.brand && r.company ? " · " + hx(r.company) : ""} · เอกสาร ${hx(r.doc_no)} · ส่งเมื่อ ${r.shipped_at ? hx(bkk(new Date(r.shipped_at)).slice(0, 10)) : "-"}</div>
    ${done ? `<div class="card ok"><b>ประเมินแล้ว</b> เมื่อ ${hx(bkk(new Date(ev.submittedAt || Date.now())))} โดย ${hx(ev.email || "")} · แก้ไขคำตอบได้ด้านล่างแล้วกดส่งอีกครั้ง</div>` : `<div class="card"><p style="margin:0">ให้คะแนน 1 (น้อย) ถึง 5 (มาก) ในแต่ละด้าน และเลือกว่าตัวอย่างใดให้ผลิตจริงต่อไป ใช้เวลาประมาณ 2 นาที</p></div>`}
    <form id="f">${items.map(itemHtml).join("")}
    <div class="card"><div class="muted">ความเห็นเพิ่มเติมโดยรวม</div><textarea name="note" rows="3" maxlength="2000">${hx(ev.note || "")}</textarea>
      <div style="margin-top:10px"><div class="muted">อีเมลผู้ประเมิน *</div><input type="email" name="email" required value="${hx(ev.email || "")}" placeholder="name@company.com"></div>
      <div style="margin-top:14px"><button type="submit" id="go">ส่งผลประเมิน</button></div><div id="msg" class="muted" style="margin-top:8px" aria-live="polite"></div></div></form>
    <script>const F=document.getElementById('f'),M=document.getElementById('msg');F.addEventListener('submit',async e=>{e.preventDefault();const b=document.getElementById('go');const items=[...document.querySelectorAll('[data-item]')].map((el,i)=>{const sc={};['scent','appearance','skinfeel','target','brand','overall'].forEach(k=>{const r=el.querySelector('input[name="s'+i+'_'+k+'"]:checked');sc[k]=r?+r.value:0});const d=el.querySelector('input[name="d'+i+'"]:checked');return {idx:i,scores:sc,comment:el.querySelector('[name="c'+i+'"]').value,decision:d?d.value:''}});
    const miss=items.find(x=>Object.values(x.scores).some(v=>!v));if(miss){M.innerHTML='<span class="bad">ให้คะแนนให้ครบทุกด้านของตัวอย่างที่ '+(miss.idx+1)+'</span>';return}
    b.disabled=true;M.textContent='กำลังส่ง…';try{const r=await fetch('${hx((Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/api?evalSubmit=" + token)}',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({items,note:F.note.value,email:F.email.value})});const j=await r.json();if(!j.ok)throw new Error(j.error||'ส่งไม่สำเร็จ');M.innerHTML='<b style="color:#1a7f37">ขอบคุณครับ ระบบบันทึกผลประเมินแล้ว</b> ทีม Scent &amp; Sense จะติดต่อกลับโดยเร็ว';window.scrollTo(0,document.body.scrollHeight)}catch(err){M.innerHTML='<span class="bad">'+(err.message||err)+'</span>';b.disabled=false}});</script>`;
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
    const now = new Date(), old = ex.eval || {};
    const ev = { submittedAt: now.toISOString(), email, note: str(body.note, 2000), items: evItems, produce: evItems.some((x: Any) => x.decision === "produce"),
      history: (Array.isArray(old.history) ? old.history : []).concat(old.submittedAt ? [{ submittedAt: old.submittedAt, email: old.email, items: old.items }] : []).slice(-10) };
    const evalDocNo = String(ex.eval_doc_no || "") || await nextDocNo(db, "FM-RD-05", now);
    await db`update costing.samples set status = 'evaluated', eval = ${db.json(ev)}, eval_doc_no = ${evalDocNo}, updated_at = now(), updated_by = ${"customer:" + email} where id = ${String(ex.id)}`;
    const pr = (await db`select * from costing.projects where id = ${String(ex.project_id)}`)[0];
    if (pr) { const key = String(ex.kind) === "mockup" ? "s5eval" : "s3eval", actual = { ...(pr.actual || {}) }; actual[key] = now.toISOString(); await db`update costing.projects set actual = ${db.json(actual)}, updated_at = now() where id = ${String(pr.id)}`; }
    await log(db, "customer:" + email, "evalSubmit", String(ex.doc_no) + " → " + evalDocNo + (ev.produce ? " · เลือกผลิตจริง" : ""));
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
  return v.slice(0, 80).map((x: Any) => ({ code: str(x && x.code, 40), name: str(x && x.name, 200), fn: str(x && x.fn, 120), pct: numOrNull(x && x.pct), price: numOrNull(x && x.price), override: numOrNull(x && x.override), frag: !!(x && x.frag), note: str(x && x.note, 200) }))
    .filter((x: Any) => x.name || x.code || x.frag);
}
function pdBaseData(b: Any) {
  return { targetPrice: numOrNull(b.targetPrice), shelfLife: str(b.shelfLife, 120), stability: str(b.stability, 200), benchmark: str(b.benchmark, 200), note: str(b.note, 2000),
    fragranceAdjustable: !!b.fragranceAdjustable, lines: pdLines(b.lines), source: b.source && typeof b.source === "object" ? b.source : {} };
}
const baseOut = (r: Any) => ({ id: String(r.id), category: String(r.category), name: String(r.name), active: !!r.active, sort: Number(r.sort) || 0, ...pdBaseData(r.data || {}),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: String(r.updated_by || "") });
async function listPdBases(ctx: Ctx) {
  await needAny(ctx, RD_VIEW);
  return (await ctx.db`select * from costing.pd_bases order by sort, category, name`).map(baseOut);
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
function pdFormulaData(f: Any) {
  return { category: str(f.category, 80), baseName: str(f.baseName, 200), mode: PD_MODES[f.mode] ? String(f.mode) : "standard", customer: str(f.customer, 200), brand: str(f.brand, 200),
    fragranceFormulaId: str(f.fragranceFormulaId, 60), fragranceScentId: str(f.fragranceScentId, 60), fragranceName: str(f.fragranceName, 200), fragranceCode: str(f.fragranceCode, 60), fragrancePrice: numOrNull(f.fragrancePrice),
    batchG: numOrNull(f.batchG), targetPrice: numOrNull(f.targetPrice), note: str(f.note, 3000), lines: pdLines(f.lines), approvedBy: str(f.approvedBy, 120), approvedAt: str(f.approvedAt, 40) };
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
  await needAny(ctx, RD_VIEW); const db = ctx.db;
  const rows = projectId ? await db`select * from costing.pd_formulas where project_id = ${String(projectId)} order by updated_at desc` : await db`select * from costing.pd_formulas order by updated_at desc limit 1000`;
  return rows.map(fmOut);
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

/* ===== ตารางฟังก์ชันที่หน้าเว็บเรียกได้ ===== */
const API: Record<string, (ctx: Ctx, ...a: Any[]) => Promise<unknown>> = {
  bootstrap, requestAccess, savePrices, resetPrices, saveExport, adminData, setUser, removeUser, declineRequest, saveAccess, createRole, updateRole, deleteRole,
  loadMyFormulas, saveMyFormulas, adminFormulas, loadPricing, savePricing, updatePrices, submitComplaint, myComplaints, adminComplaints, replyComplaint,
  loadCompliance, saveComplianceRules, saveRmMap, listDocs, getDoc, issueDoc, voidDoc, listRmDocs, getRmDocFile, uploadRmDoc, updateRmDoc, deleteRmDoc,
  listBriefs, saveBrief, deleteBrief, listScents, saveScent, deleteScent, getTypeformStatus, saveTypeformToken, syncTypeform, disconnectTypeform,
  pwLogin, setMyPassword, pwLogout, resetUserPassword,
  listCustomers, saveCustomer, listProjects, getProject, saveProject, setStage, raCheck, issueProjectDoc, listSamples, saveSample, sendSample, deleteSample, evalSummary, importRd,
  listPdBases, savePdBase, deletePdBase, listPdFormulas, savePdFormula, deletePdFormula, importPdBases,
  importAll, importRmFile, finishMigration,
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (url.searchParams.get("tf")) return await tfWebhook(req, url);
  /* ลิงก์ประเมินตัวอย่างของลูกค้า: GET แสดงฟอร์ม, POST บันทึกผล (ไม่ต้อง log in ใช้ token ของชุดตัวอย่าง) */
  if (url.searchParams.get("eval")) return await evalPage(url.searchParams.get("eval") || "");
  if (url.searchParams.get("evalSubmit")) {
    let out: Any;
    try { out = await evalSubmit(url.searchParams.get("evalSubmit") || "", JSON.parse((await req.text()) || "{}")); }
    catch (err) { out = { ok: false, error: String((err && (err as Error).message) || err) }; }
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", ...CORS } });
  }
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "costing-api" }), { headers: { "Content-Type": "application/json", ...CORS } });
  let out: Any;
  try {
    const reqBody = JSON.parse((await req.text()) || "{}");
    if (!Object.prototype.hasOwnProperty.call(API, reqBody.fn)) throw new Error("UNKNOWN_FUNCTION");
    /* เข้าสู่ระบบด้วยรหัสผ่านเท่านั้น: ทุกฟังก์ชันใช้เซสชัน ยกเว้น pwLogin (ก่อนเข้าระบบ) และ setMyPassword ที่ยืนยันตัวตนด้วย Google ได้ (ตั้งครั้งแรก / ลืมรหัส) */
    let ctx: Ctx;
    if (reqBody.fn === "pwLogin") ctx = { email: "", db: sql, via: "none" };
    else if (reqBody.session) { const s = await sessionEmail(reqBody.session); ctx = { email: s.email, db: sql, via: "session", sid: s.sid }; }
    else if (reqBody.fn === "setMyPassword" && reqBody.idToken) ctx = { email: await verifyIdToken(reqBody.idToken), db: sql, via: "google" };
    else throw new Error(reqBody.idToken ? "AUTH_PASSWORD_REQUIRED" : "AUTH_REQUIRED");
    out = { ok: true, result: await API[reqBody.fn](ctx, ...(Array.isArray(reqBody.args) ? reqBody.args : [])) };
  } catch (err) {
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", ...CORS } });
});
