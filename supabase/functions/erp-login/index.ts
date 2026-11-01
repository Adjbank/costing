/**
 * แผนกวิจัยและพัฒนา · Scent & Sense — Supabase Edge Function "erp-login"
 * เข้าระบบ R&D ด้วยล็อกอินของ ERP (factory.scentandsense.co.th) เมื่อเปิดหน้า R&D อยู่ในหน้า ERP:
 * - ERP ส่ง access token ของ Supabase โปรเจกต์ ss-factory มา → ตรวจกับ /auth/v1/user ของ ss-factory ว่าเป็นผู้ใช้จริง
 * - อีเมลต้องเป็นโดเมนบริษัท แล้วออกเซสชัน R&D แบบเดียวกับ pwLogin (costing.sessions เก็บแฮช, 12 ชั่วโมง, via = "erp")
 * - สิทธิ์ใช้งานยังมาจาก costing.users ตามเดิม ฟังก์ชัน "api" ตรวจเซสชันนี้เหมือนเซสชันจากรหัสผ่าน
 * - คีย์สาธารณะ (anon) ของ ss-factory อ่านจาก config.js ของเว็บ ERP ไม่ได้เก็บไว้ในโค้ด
 */
import postgres from "npm:postgres@3.4.5";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ERP = "https://factory.scentandsense.co.th";
const ERP_AUTH = "https://fyqgikevpnpbjvesdtpj.supabase.co/auth/v1/user";
const DOMAINS = ["scentandsense.co.th", "scentandsense.co"];
const SESSION_HOURS = 12;
const ORIGINS = [ERP, "https://rd.scentandsense.co.th"];

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false, idle_timeout: 20, connect_timeout: 15 });
const te = new TextEncoder();
const b64u = (u8: Uint8Array) => encodeBase64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");

let anon = "", anonAt = 0;
async function erpKey(): Promise<string> {
  if (anon && Date.now() - anonAt < 3600000) return anon;
  const txt = await (await fetch(ERP + "/config.js", { signal: AbortSignal.timeout(8000) })).text();
  const m = /"key"\s*:\s*"([^"]+)"/.exec(txt);
  if (!m) throw new Error("ERP_CONFIG");
  anon = m[1]; anonAt = Date.now();
  return anon;
}
async function erpEmail(token: string): Promise<string> {
  const r = await fetch(ERP_AUTH, { headers: { apikey: await erpKey(), Authorization: "Bearer " + token }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("ERP_AUTH");
  const u = await r.json();
  const email = String(u && u.email || "").trim().toLowerCase(), m = email.match(/^[^@\s]+@([^@\s]+)$/);
  if (!m || DOMAINS.indexOf(m[1]) < 0) throw new Error("ใช้ได้เฉพาะอีเมล @" + DOMAINS.join(" หรือ @"));
  return email;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.indexOf(origin) >= 0 ? origin : ORIGINS[1], "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  let out: Record<string, unknown>;
  try {
    if (req.method !== "POST") throw new Error("POST_ONLY");
    const body = JSON.parse((await req.text()) || "{}"), tok = body && body.token;
    if (!tok || typeof tok !== "string" || tok.length < 20 || tok.length > 4096) throw new Error("ERP_AUTH");
    const email = await erpEmail(tok);
    const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + SESSION_HOURS * 3600000);
    await sql`insert into costing.sessions (id, email, created_at, expires_at, last_seen, via) values (${await sha256hex(token)}, ${email}, now(), ${expires}, now(), ${"erp"})`;
    await sql`delete from costing.sessions where expires_at < now()`;
    await sql`insert into costing.log (email, action, detail) values (${email}, ${"erpLogin"}, ${"เข้าจาก ERP"})`;
    out = { ok: true, result: { session: token, expiresAt: expires.toISOString(), email } };
  } catch (err) {
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", ...cors } });
});
