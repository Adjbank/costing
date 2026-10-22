/**
 * ระบบคำนวณต้นทุนหัวน้ำหอม — Scent & Sense
 * Google Apps Script (ผูกกับ Google Sheet) · ยืนยันตัวตนด้วยบัญชี Google ของบริษัท
 *
 * ติดตั้งครั้งแรก: เลือกฟังก์ชัน setup แล้วกด Run (ดูคู่มือติดตั้ง.md)
 * ทุกฟังก์ชันที่หน้าเว็บเรียก ตรวจสิทธิ์ซ้ำที่เซิร์ฟเวอร์ทุกครั้ง
 */

const DOMAINS = ['scentandsense.co.th', 'scentandsense.co'];
const HEAD = {
  Users:    ['email', 'role', 'active', 'addedBy', 'addedAt'],
  Roles:    ['id', 'name', 'perms', 'system', 'order'],
  Settings: ['key', 'value'],
  Prices:   ['code', 'name', 'price', 'status', 'note', 'updatedAt', 'updatedBy'],
  Requests: ['email', 'at'],
  Visitors: ['email', 'firstSeen', 'lastSeen'],
  Log:      ['at', 'email', 'action', 'detail'],
  Formulas: ['id', 'owner', 'name', 'updatedAt', 'data'],
  Pricing:  ['key', 'owner', 'formulaId', 'sell', 'updatedAt', 'updatedBy'],
  Complaints: ['id', 'email', 'subject', 'detail', 'status', 'reply', 'repliedBy', 'createdAt', 'updatedAt'],
  Compliance: ['id', 'source', 'name', 'cas', 'type', 'limits', 'note', 'updatedAt'],
  RmMap:      ['code', 'cas', 'name', 'pct'],
  Docs:       ['id', 'docNo', 'type', 'formulaId', 'owner', 'product', 'customer', 'brand', 'status', 'issuedAt', 'issuedBy', 'data']
};
const PERM_KEYS = ['calc', 'export', 'viewDb', 'editPrices', 'manageUsers'];
const DEFAULT_ROLES = [
  ['admin',   'ผู้ดูแลระบบ', {calc:true, export:true, viewDb:true, editPrices:true, manageUsers:true}, true],
  ['costing', 'ทีมต้นทุน',   {calc:true, export:true, viewDb:true}, false],
  ['pc',      'จัดซื้อ / PC', {calc:true, viewDb:true, editPrices:true}, false],
  ['viewer',  'ดูอย่างเดียว', {viewDb:true}, false]
];
const BUILTIN_SOURCE = {file: 'PRODUCT RM - Summary RM.pdf', updated: '12/10/2026 11:41:18'};
const EXPORT_FOLDER = 'Scent & Sense · ต้นทุนหัวน้ำหอม (Export)';

/* ===== web app (หน้าเว็บใน Apps Script) ===== */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ระบบต้นทุนหัวน้ำหอม · Scent & Sense')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ===== JSON API สำหรับหน้าเว็บบน GitHub Pages =====
   หน้าเว็บส่ง {fn, args, idToken} มาแบบ POST (Content-Type: text/plain)
   idToken = Google ID token จาก "Sign in with Google" ตรวจกับ Google ทุกครั้ง แล้วจึงเรียกฟังก์ชันในรายการด้านล่าง
   ตั้งค่าใน Project Settings → Script properties: GOOGLE_CLIENT_ID (จำเป็น), PUBLIC_URL (ลิงก์ GitHub Pages) */
let REQUEST_EMAIL_ = null;

function doPost(e) {
  const api = {bootstrap: bootstrap, requestAccess: requestAccess, savePrices: savePrices, resetPrices: resetPrices,
    saveExport: saveExport, adminData: adminData, setUser: setUser, removeUser: removeUser, declineRequest: declineRequest,
    saveAccess: saveAccess, createRole: createRole, updateRole: updateRole, deleteRole: deleteRole,
    loadMyFormulas: loadMyFormulas, saveMyFormulas: saveMyFormulas, adminFormulas: adminFormulas,
    loadPricing: loadPricing, savePricing: savePricing, updatePrices: updatePrices,
    submitComplaint: submitComplaint, myComplaints: myComplaints, adminComplaints: adminComplaints, replyComplaint: replyComplaint,
    loadCompliance: loadCompliance, saveComplianceRules: saveComplianceRules, saveRmMap: saveRmMap,
    listDocs: listDocs, getDoc: getDoc, issueDoc: issueDoc, voidDoc: voidDoc};
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!Object.prototype.hasOwnProperty.call(api, req.fn)) throw new Error('UNKNOWN_FUNCTION');
    REQUEST_EMAIL_ = verifyIdToken_(req.idToken);
    out = {ok: true, result: api[req.fn].apply(null, Array.isArray(req.args) ? req.args : [])};
  } catch (err) {
    out = {ok: false, error: String((err && err.message) || err)};
  } finally {
    REQUEST_EMAIL_ = null;
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function verifyIdToken_(token) {
  if (!token || typeof token !== 'string') throw new Error('AUTH_REQUIRED');
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('SETUP: ยังไม่ได้ตั้ง Script property GOOGLE_CLIENT_ID');
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) throw new Error('AUTH_EXPIRED');
  const p = JSON.parse(res.getContentText());
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== clientId) throw new Error('AUTH_INVALID');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(p.iss) < 0) throw new Error('AUTH_INVALID');
  if (Number(p.exp) <= now) throw new Error('AUTH_EXPIRED');
  if (String(p.email_verified) !== 'true') throw new Error('AUTH_INVALID');
  const email = String(p.email || '').toLowerCase();
  if (DOMAINS.indexOf(email.split('@')[1]) < 0) throw new Error('DOMAIN:' + email);
  cache.put(key, email, Math.max(1, Math.min(300, Number(p.exp) - now - 30)));
  return email;
}

/* ===== ติดตั้งครั้งแรก (รันจาก editor) ===== */
function setup() {
  const ss = ss_();
  Object.keys(HEAD).forEach(function (n) {
    let sh = ss.getSheetByName(n);
    if (!sh) sh = ss.insertSheet(n);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEAD[n].length).setValues([HEAD[n]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  if (!rows_('Roles').length) {
    sh_('Roles').getRange(2, 1, DEFAULT_ROLES.length, 5).setValues(
      DEFAULT_ROLES.map(function (r, i) { return [r[0], r[1], JSON.stringify(r[2]), r[3], i + 1]; }));
  }
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  setSetting_('owner', owner);
  if (getSetting_('autoJoin') === null) setSetting_('autoJoin', 'true');
  if (!getSetting_('defaultRole')) setSetting_('defaultRole', 'costing');
  if (!rows_('Prices').length) seedPrices_();
  const s1 = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  Logger.log('ตั้งค่าเรียบร้อย · เจ้าของระบบ: ' + owner + ' · ราคาวัตถุดิบ ' + rows_('Prices').length + ' รายการ');
  return owner;
}

/* ===== ตัวช่วยชีต ===== */
/** เปิด Google Sheet: ใช้ Script property SHEET_ID ถ้ามี (โปรเจกต์ที่สร้างจาก script.google.com)
 *  ถ้าไม่มี ใช้ชีตที่โปรเจกต์ผูกอยู่ (สร้างจาก ส่วนขยาย → Apps Script ในชีต) */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (!active) throw new Error('SETUP: ตั้ง Script property SHEET_ID เป็น ID ของ Google Sheet (Project Settings → Script properties)');
  return active;
}
function sh_(n) {
  const ss = ss_();
  let s = ss.getSheetByName(n);
  if (!s && HEAD[n] && (n === 'Formulas' || n === 'Pricing' || n === 'Complaints' || n === 'Compliance' || n === 'RmMap' || n === 'Docs')) {   // แท็บที่เพิ่มภายหลัง สร้างให้เองเมื่อยังไม่มี
    s = ss.insertSheet(n);
    s.getRange(1, 1, 1, HEAD[n].length).setValues([HEAD[n]]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  if (!s) throw new Error('SETUP: ยังไม่ได้รัน setup()');
  return s;
}
function rows_(n) {
  const s = sh_(n), last = s.getLastRow(), h = HEAD[n];
  if (last < 2) return [];
  return s.getRange(2, 1, last - 1, h.length).getValues().map(function (r, i) {
    const o = {_row: i + 2};
    h.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  }).filter(function (o) { return String(o[h[0]]) !== ''; });
}
function findRow_(n, key, val) {
  const v = String(val).toLowerCase();
  return rows_(n).filter(function (r) { return String(r[key]).toLowerCase() === v; })[0] || null;
}
function upsert_(n, key, obj) {
  const s = sh_(n), h = HEAD[n], ex = findRow_(n, key, obj[key]);
  const vals = h.map(function (k) { return obj[k] !== undefined ? obj[k] : (ex ? ex[k] : ''); });
  if (ex) s.getRange(ex._row, 1, 1, h.length).setValues([vals]); else s.appendRow(vals);
}
function delete_(n, key, val) { const ex = findRow_(n, key, val); if (ex) sh_(n).deleteRow(ex._row); }
function getSetting_(k) { const r = findRow_('Settings', 'key', k); return r ? String(r.value) : null; }
function setSetting_(k, v) { upsert_('Settings', 'key', {key: k, value: String(v)}); }
function log_(email, action, detail) { try { sh_('Log').appendRow([new Date(), email, action, detail || '']); } catch (e) {} }
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function activeOf_(v) { return v === '' || v === null || v === undefined ? true : isTrue_(v); }
function withLock_(fn) {
  const l = LockService.getScriptLock();
  l.waitLock(20000);
  try { return fn(); } finally { l.releaseLock(); }
}
function normEmail_(e) {
  const email = String(e || '').trim().toLowerCase();
  const m = email.match(/^[^@\s]+@([^@\s]+)$/);
  if (!m || DOMAINS.indexOf(m[1]) < 0) throw new Error('ใช้ได้เฉพาะอีเมล @' + DOMAINS.join(' หรือ @'));
  return email;
}
function appUrl_() {
  const pub = PropertiesService.getScriptProperties().getProperty('PUBLIC_URL');
  if (pub) return pub;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/* ===== บทบาทและตัวตน ===== */
function readRoles_() {
  const rs = rows_('Roles').sort(function (a, b) { return Number(a.order) - Number(b.order); });
  const roles = {}, order = [];
  rs.forEach(function (r) {
    let p = {};
    try { p = JSON.parse(r.perms || '{}'); } catch (e) {}
    roles[String(r.id)] = {name: String(r.name), perms: p, system: isTrue_(r.system)};
    order.push(String(r.id));
  });
  return {roles: roles, order: order};
}
function allPerms_() { const o = {}; PERM_KEYS.forEach(function (k) { o[k] = true; }); return o; }
function me_() {
  const email = String(REQUEST_EMAIL_ || Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  if (!email) throw new Error('NO_IDENTITY');
  if (DOMAINS.indexOf(email.split('@')[1]) < 0) throw new Error('DOMAIN:' + email);
  const owner = (getSetting_('owner') || '').toLowerCase();
  const rr = readRoles_();
  const u = findRow_('Users', 'email', email);
  const autoJoin = getSetting_('autoJoin') === 'true', defRole = getSetting_('defaultRole') || 'costing';
  let role = null, active = true, auto = false;
  if (email === owner) role = 'admin';
  else if (u) { role = String(u.role); active = activeOf_(u.active); }
  else if (autoJoin && rr.roles[defRole]) { role = defRole; auto = true; }
  const isOwner = email === owner;
  const perms = isOwner ? allPerms_() : (role && rr.roles[role] ? rr.roles[role].perms : {});
  return {email: email, isOwner: isOwner, role: role, roleName: role && rr.roles[role] ? rr.roles[role].name : '',
          active: active, auto: auto, perms: perms, roles: rr.roles, order: rr.order, autoJoin: autoJoin, defRole: defRole, owner: owner};
}
function need_(perm) {
  const m = me_();
  if (!m.role || !m.active || !(m.isOwner || m.perms[perm])) throw new Error('FORBIDDEN');
  return m;
}

/* ===== เรียกจากหน้าเว็บ: ทุกคน ===== */
function bootstrap() {
  const m = me_();
  touchVisitor_(m.email);
  const ok = !!m.role && m.active;
  return {
    me: {email: m.email, isOwner: m.isOwner, role: m.role, roleName: m.roleName, active: m.active, auto: m.auto, perms: ok ? m.perms : {}},
    roles: m.roles, order: m.order, access: {autoJoin: m.autoJoin, defaultRole: m.defRole},
    prices: ok && (m.perms.calc || m.perms.viewDb || m.isOwner) ? readPrices_() : null,
    appUrl: appUrl_(),
    requested: !!findRow_('Requests', 'email', m.email),
    complaintsNew: ok && isAdmin_(m) ? newComplaints_() : 0
  };
}
function touchVisitor_(email) {
  const l = LockService.getScriptLock();
  if (!l.tryLock(5000)) return;
  try {
    const now = new Date(), ex = findRow_('Visitors', 'email', email);
    upsert_('Visitors', 'email', {email: email, firstSeen: ex ? undefined : now, lastSeen: now});
  } catch (e) {} finally { l.releaseLock(); }
}
function requestAccess() {
  return withLock_(function () {
    const m = me_();
    if (m.role && m.active) return 'ALREADY';
    if (!m.active) throw new Error('บัญชีนี้ถูกระงับ ติดต่อผู้ดูแลระบบ');
    upsert_('Requests', 'email', {email: m.email, at: new Date()});
    log_(m.email, 'requestAccess', '');
    try {
      MailApp.sendEmail(m.owner, '[ระบบต้นทุนหัวน้ำหอม] คำขอสิทธิ์ใช้งานจาก ' + m.email,
        m.email + ' ขอสิทธิ์ใช้งานระบบคำนวณต้นทุนหัวน้ำหอม\n\nอนุมัติได้ที่หน้า "จัดการผู้ใช้และบทบาท":\n' + appUrl_());
    } catch (e) {}
    return 'OK';
  });
}

/* ===== ฐานราคา ===== */
function seedPrices_() {
  const rows = RM_RAW.split('\n').filter(String).map(function (l) {
    const p = l.split('|'), raw = p[2] || '', n = Number(raw);
    const isNum = raw !== '' && !isNaN(n) && n > 0;
    const status = isNum ? 'ok' : raw === 'R' ? 'recheck' : raw === 'X' ? 'cancel' : raw === 'D' ? 'rd' : 'none';
    return [p[0], p[1] || '', isNum ? n : '', status, p[3] || ''];
  });
  writePrices_(rows);
  setSetting_('pricesFile', BUILTIN_SOURCE.file);
  setSetting_('pricesUpdated', BUILTIN_SOURCE.updated);
  setSetting_('pricesBy', '');
  setSetting_('pricesCustom', 'false');
}
function writePrices_(rows) {
  const s = sh_('Prices'), last = s.getLastRow(), w = HEAD.Prices.length;
  if (last > 1) s.getRange(2, 1, last - 1, w).clearContent();
  if (rows.length) s.getRange(2, 1, rows.length, w).setValues(rows.map(function (r) { return r.concat(['', '']).slice(0, w); }));
}
function readPrices_() {
  const entries = rows_('Prices').map(function (r) {
    const n = Number(r.price);
    return {c: String(r.code), n: String(r.name), p: r.price === '' || isNaN(n) ? null : n, s: String(r.status || ''), o: String(r.note || ''),
            u: iso_(r.updatedAt), b: String(r.updatedBy || '')};
  });
  return {entries: entries, custom: getSetting_('pricesCustom') === 'true',
          src: {file: getSetting_('pricesFile') || BUILTIN_SOURCE.file, updated: getSetting_('pricesUpdated') || '', by: getSetting_('pricesBy') || ''}};
}
function savePrices(body) {
  return withLock_(function () {
    const m = need_('editPrices');
    const list = (body && body.entries) || [];
    if (!list.length || list.length > 5000) throw new Error('ไฟล์ราคาต้องมี 1–5,000 รายการ');
    const ok = {ok: 1, recheck: 1, cancel: 1, rd: 1, none: 1};
    writePrices_(list.map(function (e) {
      const n = Number(e.p);
      return [String(e.c || '').toUpperCase().slice(0, 40), String(e.n || '').slice(0, 300), e.p === null || isNaN(n) ? '' : n,
              ok[e.s] ? e.s : 'none', String(e.o || '').slice(0, 500)];
    }));
    setSetting_('pricesFile', String(body.file || 'ไฟล์ที่อัปเดต').slice(0, 200));
    setSetting_('pricesUpdated', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'));
    setSetting_('pricesBy', m.email);
    setSetting_('pricesCustom', 'true');
    log_(m.email, 'savePrices', body.file + ' · ' + list.length + ' รายการ');
    return readPrices_();
  });
}
/** แก้ราคาทีละรายการ (หรือเพิ่มรหัสใหม่) — เจ้าของระบบ แอดมิน และจัดซื้อ (สิทธิ์ editPrices) · ทุกการเปลี่ยนแปลงบันทึกใน Log */
function updatePrices(items) {
  return withLock_(function () {
    const m = need_('editPrices');
    if (!Array.isArray(items) || !items.length || items.length > 300) throw new Error('บันทึกได้ครั้งละ 1–300 รายการ');
    const okStatus = {ok: 1, recheck: 1, cancel: 1, rd: 1, none: 1};
    const sheet = sh_('Prices'), w = HEAD.Prices.length;
    if (!String(sheet.getRange(1, 6).getValue())) sheet.getRange(1, 6, 1, 2).setValues([['updatedAt', 'updatedBy']]).setFontWeight('bold');
    const rows = {};
    rows_('Prices').forEach(function (r) { const k = String(r.code).toUpperCase(); if (!rows[k]) rows[k] = r; });
    const now = new Date(), notes = [];
    let changed = 0, added = 0;
    items.forEach(function (it) {
      const code = String((it && it.c) || '').toUpperCase().trim();
      if (!/^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/.test(code)) throw new Error('รหัส RM ไม่ถูกต้อง: ' + code.slice(0, 30));
      let price = it.p === null || it.p === undefined || it.p === '' ? '' : Number(it.p);
      if (price !== '' && (isNaN(price) || price < 0 || price > 10000000)) throw new Error('ราคาไม่ถูกต้อง: ' + code);
      if (price === 0) price = '';
      let status = okStatus[it.s] ? it.s : 'none';
      if (price !== '') status = 'ok'; else if (status === 'ok') status = 'none';
      const note = String(it.o || '').slice(0, 500), cur = rows[code];
      const name = cur ? String(cur.name) : String(it.n || '').trim().slice(0, 300);
      if (!cur && !name) throw new Error('รหัสใหม่ต้องมีชื่อวัตถุดิบ: ' + code);
      const vals = [code, name, price, status, note, now, m.email];
      if (cur) {
        const same = (cur.price === '' ? '' : Number(cur.price)) === price && String(cur.status) === status && String(cur.note || '') === note;
        if (same) return;
        sheet.getRange(cur._row, 1, 1, w).setValues([vals]);
        notes.push(code + ': ' + (cur.price === '' ? '-' : cur.price) + ' → ' + (price === '' ? '-' : price) + (String(cur.status) !== status ? ' [' + cur.status + '→' + status + ']' : ''));
      } else {
        sheet.appendRow(vals);
        rows[code] = {_row: sheet.getLastRow(), code: code, name: name, price: price, status: status, note: note};
        added++;
        notes.push(code + ': เพิ่มใหม่ ' + (price === '' ? '-' : price));
      }
      changed++;
    });
    const stamp = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
    if (changed) {
      setSetting_('pricesUpdated', stamp); setSetting_('pricesBy', m.email); setSetting_('pricesCustom', 'true');
      log_(m.email, 'updatePrices', (changed + ' รายการ · ' + notes.join('; ')).slice(0, 2000));
    }
    return {changed: changed, added: added, updated: stamp, by: m.email, at: now.toISOString()};
  });
}
function resetPrices() {
  return withLock_(function () {
    const m = need_('editPrices');
    seedPrices_();
    log_(m.email, 'resetPrices', BUILTIN_SOURCE.file);
    return readPrices_();
  });
}

/* ===== ส่งออก Excel ไป Google Drive (สำรอง เมื่อดาวน์โหลดตรงไม่ได้) ===== */
function saveExport(filename, b64) {
  const m = need_('export');
  const name = String(filename || 'export.xlsx').replace(/[\\\/:*?"<>|]/g, ' ').slice(0, 120);
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name);
  const it = DriveApp.getFoldersByName(EXPORT_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(EXPORT_FOLDER);
  const file = folder.createFile(blob);
  if (!m.isOwner) { try { file.addViewer(m.email); } catch (e) {} }
  log_(m.email, 'saveExport', name);
  return file.getUrl();
}

/* ===== ผู้ดูแลระบบ ===== */
function adminData() { return adminData_(need_('manageUsers')); }
function adminData_(m) {
  const rr = readRoles_();
  return {
    owner: m.owner, me: m.email,
    users: rows_('Users').map(function (r) {
      return {email: String(r.email).toLowerCase(), role: String(r.role), active: activeOf_(r.active), addedBy: String(r.addedBy || ''), addedAt: iso_(r.addedAt)};
    }),
    requests: rows_('Requests').map(function (r) { return {email: String(r.email).toLowerCase(), at: iso_(r.at)}; }),
    visitors: rows_('Visitors').map(function (r) { return {email: String(r.email).toLowerCase(), firstSeen: iso_(r.firstSeen), lastSeen: iso_(r.lastSeen)}; }),
    roles: rr.roles, order: rr.order,
    access: {autoJoin: getSetting_('autoJoin') === 'true', defaultRole: getSetting_('defaultRole') || 'costing'}
  };
}
/** เพิ่มหรือแก้ไขผู้ใช้ (role, active) · notify = ส่งอีเมลแจ้งผู้ใช้ */
function setUser(email, role, active, notify) {
  return withLock_(function () {
    const m = need_('manageUsers');
    email = normEmail_(email);
    if (email === m.owner) throw new Error('เจ้าของระบบเป็นผู้ดูแลระบบเสมอ แก้ไขไม่ได้');
    if (email === m.email) throw new Error('แก้ไขสิทธิ์ของตัวเองไม่ได้');
    const rr = readRoles_();
    if (!rr.roles[role]) throw new Error('ไม่พบบทบาทนี้');
    const ex = findRow_('Users', 'email', email);
    upsert_('Users', 'email', {email: email, role: role, active: active !== false,
      addedBy: ex ? undefined : m.email, addedAt: ex ? undefined : new Date()});
    delete_('Requests', 'email', email);
    log_(m.email, 'setUser', email + ' → ' + role + (active === false ? ' (ระงับ)' : ''));
    if (notify && active !== false) {
      try {
        MailApp.sendEmail(email, '[ระบบต้นทุนหัวน้ำหอม] คุณได้รับสิทธิ์ใช้งานแล้ว',
          'คุณได้รับสิทธิ์ใช้งานระบบคำนวณต้นทุนหัวน้ำหอม ในบทบาท "' + rr.roles[role].name + '"\n\nเปิดด้วยบัญชี Google ของบริษัท:\n' + appUrl_());
      } catch (e) {}
    }
    return adminData_(m);
  });
}
function removeUser(email) {
  return withLock_(function () {
    const m = need_('manageUsers');
    email = normEmail_(email);
    if (email === m.owner || email === m.email) throw new Error('ลบบัญชีนี้ไม่ได้');
    delete_('Users', 'email', email);
    log_(m.email, 'removeUser', email);
    return adminData_(m);
  });
}
function declineRequest(email) {
  return withLock_(function () {
    const m = need_('manageUsers');
    delete_('Requests', 'email', String(email || '').toLowerCase());
    log_(m.email, 'declineRequest', email);
    return adminData_(m);
  });
}
function saveAccess(autoJoin, defaultRole) {
  return withLock_(function () {
    const m = need_('manageUsers');
    if (!readRoles_().roles[defaultRole]) throw new Error('ไม่พบบทบาทนี้');
    setSetting_('autoJoin', autoJoin ? 'true' : 'false');
    setSetting_('defaultRole', defaultRole);
    log_(m.email, 'saveAccess', (autoJoin ? 'เปิด' : 'ปิด') + ' · ' + defaultRole);
    return adminData_(m);
  });
}
function cleanPerms_(p) { const o = {}; PERM_KEYS.forEach(function (k) { if (p && p[k]) o[k] = true; }); return o; }
function createRole(name, perms) {
  return withLock_(function () {
    const m = need_('manageUsers');
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('ใส่ชื่อบทบาท');
    const maxOrder = rows_('Roles').reduce(function (a, r) { return Math.max(a, Number(r.order) || 0); }, 0);
    sh_('Roles').appendRow(['r' + Date.now().toString(36), name, JSON.stringify(cleanPerms_(perms)), false, maxOrder + 1]);
    log_(m.email, 'createRole', name);
    return adminData_(m);
  });
}
function updateRole(id, patch) {
  return withLock_(function () {
    const m = need_('manageUsers');
    const r = findRow_('Roles', 'id', id);
    if (!r) throw new Error('ไม่พบบทบาทนี้');
    if (isTrue_(r.system)) throw new Error('บทบาทหลักแก้ไขไม่ได้');
    let perms = {};
    try { perms = JSON.parse(r.perms || '{}'); } catch (e) {}
    if (patch && patch.perms) Object.keys(patch.perms).forEach(function (k) { if (PERM_KEYS.indexOf(k) >= 0) perms[k] = !!patch.perms[k]; });
    const name = patch && patch.name ? String(patch.name).trim().slice(0, 40) : r.name;
    upsert_('Roles', 'id', {id: r.id, name: name, perms: JSON.stringify(cleanPerms_(perms))});
    log_(m.email, 'updateRole', id + ' ' + JSON.stringify(patch));
    return adminData_(m);
  });
}
function deleteRole(id) {
  return withLock_(function () {
    const m = need_('manageUsers');
    const r = findRow_('Roles', 'id', id);
    if (!r) throw new Error('ไม่พบบทบาทนี้');
    if (isTrue_(r.system)) throw new Error('บทบาทหลักลบไม่ได้');
    if (rows_('Users').some(function (u) { return String(u.role) === String(id); })) throw new Error('ยังมีผู้ใช้ในบทบาทนี้ ย้ายผู้ใช้ออกก่อน');
    if (getSetting_('defaultRole') === String(id)) throw new Error('บทบาทนี้เป็นบทบาทเริ่มต้น เปลี่ยนบทบาทเริ่มต้นก่อน');
    sh_('Roles').deleteRow(r._row);
    log_(m.email, 'deleteRole', id);
    return adminData_(m);
  });
}

/* ===== สูตรของผู้ใช้ =====
   เจ้าของสูตรเห็นและแก้ไขได้เฉพาะของตัวเอง (กรองด้วยอีเมลที่ยืนยันแล้วที่เซิร์ฟเวอร์ ไม่เชื่อค่าจากหน้าเว็บ)
   ดูสูตรของทุกคนได้เฉพาะเจ้าของระบบและบทบาทผู้ดูแลระบบ (admin) */
const FORMULA_MAX = 300, FORMULA_CELL_MAX = 45000;
function isAdmin_(m) { return !!m.role && m.active && (m.isOwner || m.role === 'admin'); }
function formulaOut_(r) {
  return {id: String(r.id), owner: String(r.owner).toLowerCase(), name: String(r.name), updatedAt: iso_(r.updatedAt), data: String(r.data)};
}
function loadMyFormulas() {
  const m = need_('calc');
  return rows_('Formulas').filter(function (r) { return String(r.owner).toLowerCase() === m.email; }).map(formulaOut_);
}
/** แทนที่ชุดสูตรของผู้เรียกทั้งชุด (เพิ่ม/แก้/ลบเฉพาะของตัวเอง) */
function saveMyFormulas(items) {
  return withLock_(function () {
    const m = need_('calc');
    if (!Array.isArray(items) || items.length > FORMULA_MAX) throw new Error('บันทึกได้ไม่เกิน ' + FORMULA_MAX + ' สูตร');
    const keep = {};
    items.forEach(function (it) {
      const id = String((it && it.id) || '');
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new Error('รหัสสูตรไม่ถูกต้อง');
      const data = String((it && it.data) || '');
      const name = String((it && it.name) || 'สูตร').slice(0, 120);
      if (data.length > FORMULA_CELL_MAX) throw new Error('สูตร "' + name.slice(0, 40) + '" ใหญ่เกินไป (ลดจำนวนรายการ)');
      try { JSON.parse(data); } catch (e) { throw new Error('ข้อมูลสูตรไม่ถูกต้อง'); }
      keep[id] = {name: name, data: data};
    });
    const sheet = sh_('Formulas');
    const mine = rows_('Formulas').filter(function (r) { return String(r.owner).toLowerCase() === m.email; });
    mine.filter(function (r) { return !keep[String(r.id)]; }).sort(function (a, b) { return b._row - a._row; })
      .forEach(function (r) { sheet.deleteRow(r._row); });
    const rowOf = {};
    rows_('Formulas').forEach(function (r) { if (String(r.owner).toLowerCase() === m.email) rowOf[String(r.id)] = r; });
    const now = new Date();
    let changed = 0;
    Object.keys(keep).forEach(function (id) {
      const cur = rowOf[id], k = keep[id];
      if (cur) {
        if (String(cur.data) === k.data && String(cur.name) === k.name) return;
        sheet.getRange(cur._row, 1, 1, 5).setValues([[id, m.email, k.name, now, k.data]]);
      } else {
        sheet.appendRow([id, m.email, k.name, now, k.data]);
      }
      changed++;
    });
    return {saved: Object.keys(keep).length, changed: changed, at: now.toISOString()};
  });
}
/** สูตรของทุกคน: เฉพาะแอดมิน */
function adminFormulas() {
  const m = me_();
  if (!isAdmin_(m)) throw new Error('FORBIDDEN');
  const list = rows_('Formulas').map(formulaOut_);
  log_(m.email, 'adminFormulas', list.length + ' สูตร');
  return list;
}

/* ===== ตรวจตามข้อกำหนด IFRA / อย. =====
   ระบบไม่มีข้อมูลข้อกำหนดติดมาเอง: ผู้ดูแลระบบอัปโหลดตารางข้อกำหนด (Compliance) จากเอกสารทางการของ IFRA และ อย. เอง
   ผู้มีสิทธิ์แก้ราคา (จัดซื้อ/แอดมิน) อัปโหลดตารางองค์ประกอบวัตถุดิบ (RmMap: รหัส RM → CAS + % ในวัตถุดิบ)
   ผู้ใช้ที่มีสิทธิ์คำนวณอ่านทั้งสองตารางเพื่อตรวจสูตรของตัวเอง (คำนวณที่หน้าเว็บ) */
const COMPLIANCE_MAX = 4000, RMMAP_MAX = 12000;
function casNorm_(s) { return String(s || '').replace(/[^0-9\-]/g, '').slice(0, 20); }
function loadCompliance() {
  const m = need_('calc');
  const rules = rows_('Compliance').map(function (r) {
    let limits = {};
    try { limits = JSON.parse(r.limits || '{}'); } catch (e) {}
    return {id: String(r.id), source: String(r.source), name: String(r.name), cas: casNorm_(r.cas), type: String(r.type), limits: limits, note: String(r.note || '')};
  });
  const map = rows_('RmMap').map(function (r) {
    const p = Number(r.pct);
    return {code: String(r.code).toUpperCase(), cas: casNorm_(r.cas), name: String(r.name || ''), pct: isNaN(p) || r.pct === '' ? 100 : p};
  });
  return {rules: rules, map: map,
    updated: {rules: getSetting_('complianceUpdated') || '', rulesBy: getSetting_('complianceBy') || '', map: getSetting_('rmMapUpdated') || '', mapBy: getSetting_('rmMapBy') || ''},
    canEditRules: isAdmin_(m), canEditMap: !!m.isOwner || !!m.perms.editPrices};
}
/** แทนที่ข้อกำหนดของแหล่งที่มา (IFRA / FDA) ที่อยู่ในไฟล์ — เฉพาะเจ้าของระบบและ admin */
function saveComplianceRules(items) {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    if (!Array.isArray(items) || !items.length || items.length > COMPLIANCE_MAX) throw new Error('ไฟล์ต้องมี 1–' + COMPLIANCE_MAX + ' รายการ');
    const sources = {}, now = new Date(), out = [];
    items.forEach(function (it, i) {
      const source = String((it && it.source) || '');
      if (source !== 'IFRA' && source !== 'FDA') throw new Error('แหล่งที่มาต้องเป็น IFRA หรือ FDA (แถว ' + (i + 1) + ')');
      const cas = casNorm_(it.cas), name = String(it.name || '').trim().slice(0, 200);
      if (!cas || !name) throw new Error('ทุกแถวต้องมีชื่อสารและเลข CAS (แถว ' + (i + 1) + ')');
      const type = it.type === 'prohibited' ? 'prohibited' : 'restricted';
      const limits = {};
      Object.keys(it.limits || {}).slice(0, 40).forEach(function (k) {
        const v = Number(it.limits[k]);
        if (!isNaN(v) && v >= 0 && v <= 100) limits[String(k).slice(0, 6)] = v;
      });
      sources[source] = true;
      out.push(['k' + i + Utilities.getUuid().replace(/-/g, '').slice(0, 6), source, name, cas, type, JSON.stringify(limits), String(it.note || '').slice(0, 500), now]);
    });
    const keep = rows_('Compliance').filter(function (r) { return !sources[String(r.source)]; })
      .map(function (r) { return [r.id, r.source, r.name, r.cas, r.type, r.limits, r.note, r.updatedAt]; });
    const all = keep.concat(out), sheet = sh_('Compliance'), w = HEAD.Compliance.length, last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, w).clearContent();
    sheet.getRange(2, 1, all.length, w).setValues(all);
    setSetting_('complianceUpdated', Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'));
    setSetting_('complianceBy', m.email);
    log_(m.email, 'saveComplianceRules', Object.keys(sources).join('+') + ' · ' + out.length + ' รายการ');
    return {saved: out.length, sources: Object.keys(sources)};
  });
}
/** แทนที่ตารางองค์ประกอบวัตถุดิบทั้งชุด (รหัส RM → CAS) — ผู้มีสิทธิ์แก้ราคา */
function saveRmMap(items) {
  return withLock_(function () {
    const m = need_('editPrices');
    if (!Array.isArray(items) || !items.length || items.length > RMMAP_MAX) throw new Error('ไฟล์ต้องมี 1–' + RMMAP_MAX + ' รายการ');
    const rows = items.map(function (it, i) {
      const code = String((it && it.code) || '').toUpperCase().trim();
      if (!/^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/.test(code)) throw new Error('รหัส RM ไม่ถูกต้อง (แถว ' + (i + 1) + '): ' + code.slice(0, 30));
      const cas = casNorm_(it.cas);
      if (!cas) throw new Error('ต้องมีเลข CAS (แถว ' + (i + 1) + ')');
      let pct = it.pct === undefined || it.pct === null || it.pct === '' ? 100 : Number(it.pct);
      if (isNaN(pct) || pct < 0 || pct > 100) throw new Error('% ในวัตถุดิบต้องอยู่ระหว่าง 0–100 (แถว ' + (i + 1) + ')');
      return [code, cas, String(it.name || '').trim().slice(0, 200), pct];
    });
    const sheet = sh_('RmMap'), w = HEAD.RmMap.length, last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, w).clearContent();
    sheet.getRange(2, 1, rows.length, w).setValues(rows);
    setSetting_('rmMapUpdated', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'));
    setSetting_('rmMapBy', m.email);
    log_(m.email, 'saveRmMap', rows.length + ' แถว');
    return {saved: rows.length};
  });
}

/* ===== เอกสาร SDS (MSDS) และ IFRA Certificate ต่อสูตร + ทะเบียนสูตร =====
   ออกเอกสารได้เมื่อมีสิทธิ์ส่งออก (export) · เจ้าของสูตรออกได้เฉพาะสูตรตัวเอง เจ้าของระบบ/admin ออกได้ทุกสูตร
   เลขที่เอกสารรันอัตโนมัติ SDS-ปี-ลำดับ / IFRA-ปี-ลำดับ · เนื้อหาที่ออกแล้วเก็บเป็น JSON เพื่อพิมพ์ซ้ำได้เหมือนเดิม */
const DOC_TYPES = {SDS: 1, IFRA: 1}, DOC_DATA_MAX = 45000;
function docOut_(r, withData) {
  const o = {id: String(r.id), docNo: String(r.docNo), type: String(r.type), formulaId: String(r.formulaId), owner: String(r.owner).toLowerCase(),
    product: String(r.product), customer: String(r.customer), brand: String(r.brand), status: String(r.status || 'issued'),
    issuedAt: iso_(r.issuedAt), issuedBy: String(r.issuedBy)};
  if (withData) o.data = String(r.data || '');
  return o;
}
function docVisible_(m, r) { return isAdmin_(m) || String(r.owner).toLowerCase() === m.email; }
function listDocs() {
  const m = need_('calc');
  return rows_('Docs').filter(function (r) { return docVisible_(m, r); }).map(function (r) { return docOut_(r, false); })
    .sort(function (a, b) { return String(b.issuedAt).localeCompare(String(a.issuedAt)); });
}
function getDoc(id) {
  const m = need_('calc');
  const r = findRow_('Docs', 'id', String(id || ''));
  if (!r || !docVisible_(m, r)) throw new Error('ไม่พบเอกสาร');
  return docOut_(r, true);
}
function issueDoc(type, formulaId, data) {
  return withLock_(function () {
    const m = need_('export');
    type = String(type || '').toUpperCase();
    if (!DOC_TYPES[type]) throw new Error('ประเภทเอกสารไม่ถูกต้อง');
    formulaId = String(formulaId || '');
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(formulaId)) throw new Error('รหัสสูตรไม่ถูกต้อง');
    const f = findRow_('Formulas', 'id', formulaId);
    if (!f) throw new Error('ไม่พบสูตรนี้ในระบบ (บันทึกสูตรก่อนออกเอกสาร)');
    if (!isAdmin_(m) && String(f.owner).toLowerCase() !== m.email) throw new Error('FORBIDDEN');
    let d = {};
    try { d = JSON.parse(String(data || '{}')); } catch (e) { throw new Error('ข้อมูลเอกสารไม่ถูกต้อง'); }
    const product = String(d.product || f.name || '').trim().slice(0, 200);
    if (!product) throw new Error('ใส่ชื่อผลิตภัณฑ์');
    const now = new Date(), year = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy');
    const all = rows_('Docs');
    const seq = all.filter(function (r) { return String(r.type) === type && String(r.docNo).indexOf(type + '-' + year + '-') === 0; }).length + 1;
    const rev = all.filter(function (r) { return String(r.type) === type && String(r.formulaId) === formulaId; }).length + 1;
    const docNo = type + '-' + year + '-' + ('0000' + seq).slice(-4);
    d.docNo = docNo; d.rev = rev; d.issuedAt = now.toISOString(); d.issuedBy = m.email; d.formulaOwner = String(f.owner).toLowerCase();
    const json = JSON.stringify(d);
    if (json.length > DOC_DATA_MAX) throw new Error('เนื้อหาเอกสารใหญ่เกินไป');
    const id = 'd' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    sh_('Docs').appendRow([id, docNo, type, formulaId, String(f.owner).toLowerCase(), product, String(d.customer || '').slice(0, 200), String(d.brand || '').slice(0, 120), 'issued', now, m.email, json]);
    log_(m.email, 'issueDoc', docNo + ' · ' + product + ' (rev ' + rev + ')');
    return {id: id, docNo: docNo, rev: rev, issuedAt: d.issuedAt, issuedBy: m.email};
  });
}
function voidDoc(id, reason) {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    const r = findRow_('Docs', 'id', String(id || ''));
    if (!r) throw new Error('ไม่พบเอกสาร');
    sh_('Docs').getRange(r._row, 9).setValue('void');
    log_(m.email, 'voidDoc', String(r.docNo) + (reason ? ' · ' + String(reason).slice(0, 200) : ''));
    return listDocs();
  });
}

/* ===== เรื่องร้องเรียน: ผู้ใช้ที่มีสิทธิ์เข้าระบบทุกคนส่งเรื่องได้ และเห็นเฉพาะเรื่องของตัวเอง
   เจ้าของระบบและบทบาท admin เห็นทุกเรื่อง ตอบกลับ และเปลี่ยนสถานะได้ (new = ยังไม่ได้รับเรื่อง · progress = กำลังดำเนินงาน · done = เสร็จสิ้น · rejected = ปฏิเสธ) ===== */
const CMP_LABEL = {new: 'ยังไม่ได้รับเรื่อง', progress: 'กำลังดำเนินงาน', done: 'เสร็จสิ้น', rejected: 'ปฏิเสธ'};
function cmpOut_(r) {
  const st = CMP_LABEL[String(r.status)] ? String(r.status) : 'new';
  return {id: String(r.id), email: String(r.email).toLowerCase(), subject: String(r.subject), detail: String(r.detail), status: st,
          reply: String(r.reply || ''), repliedBy: String(r.repliedBy || ''), createdAt: iso_(r.createdAt), updatedAt: iso_(r.updatedAt)};
}
function cmpSort_(a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }
function newComplaints_() {
  try { return rows_('Complaints').filter(function (r) { return !CMP_LABEL[String(r.status)] || String(r.status) === 'new'; }).length; } catch (e) { return 0; }
}
function activeMe_() {
  const m = me_();
  if (!m.role || !m.active) throw new Error('FORBIDDEN');
  return m;
}
function myComplaints() {
  const m = activeMe_();
  return rows_('Complaints').filter(function (r) { return String(r.email).toLowerCase() === m.email; }).map(cmpOut_).sort(cmpSort_);
}
function adminComplaints() {
  const m = me_();
  if (!isAdmin_(m)) throw new Error('FORBIDDEN');
  return rows_('Complaints').map(cmpOut_).sort(cmpSort_);
}
function submitComplaint(subject, detail) {
  return withLock_(function () {
    const m = activeMe_();
    subject = String(subject || '').trim().slice(0, 120);
    detail = String(detail || '').trim().slice(0, 2000);
    if (!subject) throw new Error('ใส่หัวข้อเรื่อง');
    if (detail.length < 5) throw new Error('อธิบายรายละเอียดอย่างน้อย 5 ตัวอักษร');
    const since = Date.now() - 86400000;
    const recent = rows_('Complaints').filter(function (r) {
      return String(r.email).toLowerCase() === m.email && new Date(r.createdAt).getTime() > since;
    }).length;
    if (recent >= 5) throw new Error('ส่งเรื่องได้ไม่เกิน 5 เรื่องต่อวัน');
    const id = 'c' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), now = new Date();
    sh_('Complaints').appendRow([id, m.email, subject, detail, 'new', '', '', now, now]);
    log_(m.email, 'submitComplaint', id + ' · ' + subject.slice(0, 60));
    try {
      MailApp.sendEmail(m.owner, '[ระบบต้นทุนหัวน้ำหอม] เรื่องร้องเรียนใหม่จาก ' + m.email,
        'หัวข้อ: ' + subject + '\n\n' + detail + '\n\nตอบกลับและเปลี่ยนสถานะได้ที่ปุ่ม "เรื่องร้องเรียน":\n' + appUrl_());
    } catch (e) {}
    return rows_('Complaints').filter(function (r) { return String(r.email).toLowerCase() === m.email; }).map(cmpOut_).sort(cmpSort_);
  });
}
function replyComplaint(id, status, reply) {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    if (!CMP_LABEL[String(status)]) throw new Error('สถานะไม่ถูกต้อง');
    reply = String(reply || '').trim().slice(0, 2000);
    if (status === 'rejected' && !reply) throw new Error('ใส่เหตุผลที่ปฏิเสธเพื่อแจ้งผู้ส่งเรื่อง');
    const cur = findRow_('Complaints', 'id', String(id || ''));
    if (!cur) throw new Error('ไม่พบเรื่องนี้');
    const before = cmpOut_(cur);
    if (before.status === status && before.reply === reply) return rows_('Complaints').map(cmpOut_).sort(cmpSort_);
    const now = new Date();
    sh_('Complaints').getRange(cur._row, 5, 1, 5).setValues([[status, reply, m.email, cur.createdAt, now]]);
    log_(m.email, 'replyComplaint', before.id + ' · ' + before.status + '→' + status);
    try {
      MailApp.sendEmail(before.email, '[ระบบต้นทุนหัวน้ำหอม] อัปเดตเรื่องร้องเรียน: ' + before.subject.slice(0, 80),
        'เรื่อง: ' + before.subject + '\nสถานะ: ' + CMP_LABEL[status] + (reply ? '\n\nข้อความจากผู้ดูแลระบบ:\n' + reply : '') + '\n\nดูรายละเอียดได้ที่ปุ่ม "เรื่องร้องเรียน":\n' + appUrl_());
    } catch (e) {}
    return rows_('Complaints').map(cmpOut_).sort(cmpSort_);
  });
}

/* ===== ทำราคาขาย: เฉพาะเจ้าของระบบและบทบาทผู้ดูแลระบบ (admin) =====
   ราคาขายเป็นของแต่ละสูตร (key = อีเมลเจ้าของ|รหัสสูตร) เก็บในแท็บ Pricing · เกณฑ์ต้นทุน % เก็บใน Settings (costThreshold) */
function loadPricing() {
  const m = me_();
  if (!isAdmin_(m)) throw new Error('FORBIDDEN');
  const t = Number(getSetting_('costThreshold'));
  return {
    threshold: t > 0 && t <= 100 ? t : 30,
    items: rows_('Pricing').map(function (r) {
      return {key: String(r.key), owner: String(r.owner).toLowerCase(), formulaId: String(r.formulaId), sell: Number(r.sell) || 0,
        updatedAt: iso_(r.updatedAt), updatedBy: String(r.updatedBy)};
    })
  };
}
function savePricing(items, threshold) {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    if (!Array.isArray(items) || items.length > 500) throw new Error('บันทึกได้ครั้งละไม่เกิน 500 สูตร');
    if (threshold !== undefined && threshold !== null) {
      const t = Number(threshold);
      if (!(t > 0 && t <= 100)) throw new Error('เกณฑ์ต้นทุนต้องอยู่ระหว่าง 1–100');
      setSetting_('costThreshold', t);
    }
    const sheet = sh_('Pricing'), rows = {};
    rows_('Pricing').forEach(function (r) { rows[String(r.key)] = r; });
    const now = new Date();
    let changed = 0;
    items.forEach(function (it) {
      const owner = normEmail_(it && it.owner), id = String((it && it.formulaId) || '');
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) throw new Error('รหัสสูตรไม่ถูกต้อง');
      const sell = Number(it.sell);
      if (!(sell >= 0) || sell > 1e9) throw new Error('ราคาขายไม่ถูกต้อง');
      const key = owner + '|' + id, cur = rows[key];
      if (cur) {
        if (Number(cur.sell) === sell) return;
        sheet.getRange(cur._row, 1, 1, 6).setValues([[key, owner, id, sell, now, m.email]]);
      } else {
        sheet.appendRow([key, owner, id, sell, now, m.email]);
      }
      changed++;
    });
    log_(m.email, 'savePricing', changed + ' สูตร' + (threshold != null ? ' · เกณฑ์ ' + threshold + '%' : ''));
    return {changed: changed, at: now.toISOString()};
  });
}

/* ฐานราคาเริ่มต้น (RM_RAW) อยู่ในไฟล์ Prices.gs แยกจากไฟล์นี้ — ห้ามอัปโหลด Prices.gs ขึ้น GitHub */
