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
  Docs:       ['id', 'docNo', 'type', 'formulaId', 'owner', 'product', 'customer', 'brand', 'status', 'issuedAt', 'issuedBy', 'data'],
  RmDocs:     ['id', 'codes', 'kind', 'file', 'driveId', 'size', 'supplier', 'sg', 'sgText', 'temp', 'density', 'flash', 'flashC',
               'hazards', 'hazText', 'pictos', 'picSrc', 'signal', 'note', 'uploadedAt', 'uploadedBy', 'updatedAt', 'updatedBy'],
  Briefs:     ['id', 'kind', 'brand', 'status', 'owner', 'contact', 'phone', 'email', 'summary', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'data', 'tfToken'],
  Scents:     ['id', 'code', 'name', 'briefId', 'family', 'status', 'owner', 'formulaId', 'createdAt', 'updatedAt', 'updatedBy', 'data']
};
const PERM_KEYS = ['calc', 'export', 'viewDb', 'editPrices', 'manageUsers', 'perfumer'];
const DEFAULT_ROLES = [
  ['admin',   'ผู้ดูแลระบบ', {calc:true, export:true, viewDb:true, editPrices:true, manageUsers:true, perfumer:true}, true],
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
    listDocs: listDocs, getDoc: getDoc, issueDoc: issueDoc, voidDoc: voidDoc,
    listRmDocs: listRmDocs, getRmDocFile: getRmDocFile, uploadRmDoc: uploadRmDoc, updateRmDoc: updateRmDoc, deleteRmDoc: deleteRmDoc,
    listBriefs: listBriefs, saveBrief: saveBrief, deleteBrief: deleteBrief, listScents: listScents, saveScent: saveScent, deleteScent: deleteScent,
    getTypeformStatus: getTypeformStatus, saveTypeformToken: saveTypeformToken, syncTypeform: syncTypeform, disconnectTypeform: disconnectTypeform};
  if (e && e.parameter && e.parameter.tf) return tfWebhook_(e);   // Typeform webhook (ตรวจ secret ใน query string)
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
  if (!s && HEAD[n] && (n === 'Formulas' || n === 'Pricing' || n === 'Complaints' || n === 'Compliance' || n === 'RmMap' || n === 'Docs' || n === 'RmDocs' || n === 'Briefs' || n === 'Scents')) {   // แท็บที่เพิ่มภายหลัง สร้างให้เองเมื่อยังไม่มี
    s = ss.insertSheet(n);
    s.getRange(1, 1, 1, HEAD[n].length).setValues([HEAD[n]]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  if (!s) throw new Error('SETUP: ยังไม่ได้รัน setup()');
  if (HEAD[n] && s.getLastRow() > 0) {   // เติมหัวคอลัมน์ที่เพิ่มภายหลัง (เช่น Briefs.tfToken)
    const have = s.getLastColumn();
    if (have < HEAD[n].length) s.getRange(1, have + 1, 1, HEAD[n].length - have).setValues([HEAD[n].slice(have)]).setFontWeight('bold');
  }
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
  const perms = isOwner || role === 'admin' ? allPerms_() : (role && rr.roles[role] ? rr.roles[role].perms : {});
  return {email: email, isOwner: isOwner, role: role, roleName: role && rr.roles[role] ? rr.roles[role].name : '',
          active: active, auto: auto, perms: perms, roles: rr.roles, order: rr.order, autoJoin: autoJoin, defRole: defRole, owner: owner};
}
/** บทบาท admin (ผู้ดูแลระบบ) มีทุกสิทธิ์เสมอ แม้สิทธิ์ใหม่จะยังไม่อยู่ในชีต Roles */
function hasPerm_(m, perm) { return !!(m.isOwner || m.role === 'admin' || m.perms[perm]); }
function need_(perm) {
  const m = me_();
  if (!m.role || !m.active || !hasPerm_(m, perm)) throw new Error('FORBIDDEN');
  return m;
}
function needAny_(perms) {
  const m = me_();
  if (!m.role || !m.active || !perms.some(function (p) { return hasPerm_(m, p); })) throw new Error('FORBIDDEN');
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

/* ===== MSDS และเอกสารของวัตถุดิบ (RM) =====
   ไฟล์ PDF เก็บในโฟลเดอร์ Google Drive ของเจ้าของระบบ (ไม่แชร์สาธารณะ) · ข้อมูลที่อ่านจากไฟล์ (ความถ่วงจำเพาะ g/ml จุดวาบไฟ รหัส H สัญลักษณ์ GHS) เก็บในแท็บ RmDocs
   ดูและดาวน์โหลด: สิทธิ์ดูฐานข้อมูล (viewDb) · อัปโหลด แก้ไข ลบ: สิทธิ์แก้ราคา (editPrices = เจ้าของระบบ แอดมิน จัดซื้อ)
   เอกสาร 1 ไฟล์ผูกได้หลายรหัส RM (เช่น วัตถุดิบเดียวกันหลายขนาดบรรจุ) · อัปโหลดชื่อไฟล์ + ประเภทเดิมซ้ำ = แทนที่ไฟล์เก่า (ไฟล์เก่าย้ายไปถังขยะ Drive กู้คืนได้ 30 วัน) */
const RMDOC_FOLDER = 'Scent & Sense · MSDS วัตถุดิบ', RMDOC_KINDS = {MSDS: 1, IFRA: 1, ALLERGEN: 1, COA: 1, OTHER: 1};
const RMDOC_MAX_BYTES = 15 * 1024 * 1024, RMDOC_PICTOS = {flame: 1, excl: 1, health: 1, corr: 1, env: 1, skull: 1, oxid: 1, gas: 1, expl: 1};
const RM_CODE_RE = /^RM-[A-Z0-9]+-\d{3}-\d{1,4}$/;
function rmDocFolder_() {
  const id = getSetting_('rmDocFolder');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(RMDOC_FOLDER);
  setSetting_('rmDocFolder', f.getId());
  return f;
}
function splitList_(v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(String); }
function numOrNull_(v) { const n = Number(v); return v === '' || v === null || v === undefined || isNaN(n) ? null : n; }
function rmDocOut_(r) {
  return {id: String(r.id), codes: splitList_(r.codes), kind: String(r.kind), file: String(r.file), size: Number(r.size) || 0,
    supplier: String(r.supplier || ''), sg: numOrNull_(r.sg), sgText: String(r.sgText || ''), temp: numOrNull_(r.temp), density: numOrNull_(r.density),
    flash: String(r.flash || ''), flashC: numOrNull_(r.flashC), hazards: splitList_(r.hazards), hazText: String(r.hazText || ''),
    pictos: splitList_(r.pictos), picSrc: String(r.picSrc || ''), signal: String(r.signal || ''), note: String(r.note || ''),
    uploadedAt: iso_(r.uploadedAt), uploadedBy: String(r.uploadedBy || ''), updatedAt: iso_(r.updatedAt), updatedBy: String(r.updatedBy || '')};
}
/** ตรวจและทำความสะอาดข้อมูลที่หน้าเว็บส่งมา (ไม่รวมตัวไฟล์) */
function rmDocClean_(d) {
  d = d || {};
  const codes = [];
  (Array.isArray(d.codes) ? d.codes : splitList_(d.codes)).slice(0, 20).forEach(function (c) {
    c = String(c || '').toUpperCase().trim();
    if (!RM_CODE_RE.test(c)) throw new Error('รหัส RM ไม่ถูกต้อง: ' + c.slice(0, 30));
    if (codes.indexOf(c) < 0) codes.push(c);
  });
  if (!codes.length) throw new Error('เลือกรหัส RM อย่างน้อย 1 รหัส');
  const kind = String(d.kind || 'MSDS').toUpperCase();
  if (!RMDOC_KINDS[kind]) throw new Error('ประเภทเอกสารไม่ถูกต้อง');
  const num = function (v, lo, hi) { const n = numOrNull_(v); return n !== null && n >= lo && n <= hi ? n : ''; };
  const hz = (Array.isArray(d.hazards) ? d.hazards : splitList_(d.hazards)).map(function (h) { return String(h).toUpperCase().trim(); })
    .filter(function (h) { return /^(EU)?H\d{3}[A-Z]{0,2}$/.test(h); }).slice(0, 40);
  const pic = (Array.isArray(d.pictos) ? d.pictos : splitList_(d.pictos)).filter(function (p) { return RMDOC_PICTOS[p]; });
  const signal = String(d.signal || '').toUpperCase();
  return {codes: codes.join(','), kind: kind, supplier: String(d.supplier || '').trim().slice(0, 120),
    sg: num(d.sg, 0.3, 3), sgText: String(d.sgText || '').trim().slice(0, 120), temp: num(d.temp, 0, 60), density: num(d.density, 0.3, 3),
    flash: String(d.flash || '').trim().slice(0, 60), flashC: num(d.flashC, -100, 400),
    hazards: hz.filter(function (h, i) { return hz.indexOf(h) === i; }).join(','), hazText: String(d.hazText || '').trim().slice(0, 1000),
    pictos: pic.filter(function (p, i) { return pic.indexOf(p) === i; }).join(','),
    picSrc: {h: 1, text: 1, manual: 1, none: 1}[d.picSrc] ? String(d.picSrc) : 'manual',
    signal: signal === 'DANGER' || signal === 'WARNING' ? signal : '', note: String(d.note || '').trim().slice(0, 500)};
}
function listRmDocs() {
  const m = need_('viewDb');
  return {items: rows_('RmDocs').map(rmDocOut_).sort(function (a, b) { return String(b.uploadedAt).localeCompare(String(a.uploadedAt)); }),
    canEdit: !!m.isOwner || !!m.perms.editPrices};
}
/** ส่งไฟล์ PDF กลับเป็น base64 ให้หน้าเว็บดาวน์โหลด/เปิดดู */
function getRmDocFile(id) {
  const m = need_('viewDb');
  const r = findRow_('RmDocs', 'id', String(id || ''));
  if (!r) throw new Error('ไม่พบเอกสาร');
  let blob;
  try { blob = DriveApp.getFileById(String(r.driveId)).getBlob(); } catch (e) { throw new Error('ไม่พบไฟล์ใน Google Drive (อาจถูกลบหรือย้าย) อัปโหลดใหม่ได้'); }
  log_(m.email, 'getRmDocFile', String(r.file) + ' · ' + String(r.codes));
  return {name: String(r.file), mime: blob.getContentType() || 'application/pdf', b64: Utilities.base64Encode(blob.getBytes())};
}
function uploadRmDoc(meta, b64) {
  return withLock_(function () {
    const m = need_('editPrices');
    const d = rmDocClean_(meta);
    const file = String((meta && meta.file) || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 150);
    if (!/\.pdf$/i.test(file)) throw new Error('รองรับเฉพาะไฟล์ PDF');
    if (typeof b64 !== 'string' || !b64) throw new Error('ไม่มีข้อมูลไฟล์');
    const bytes = Utilities.base64Decode(b64);
    if (!bytes.length || bytes.length > RMDOC_MAX_BYTES) throw new Error('ไฟล์ต้องมีขนาดไม่เกิน 15 MB');
    if (bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) throw new Error('ไฟล์นี้ไม่ใช่ PDF');
    const f = rmDocFolder_().createFile(Utilities.newBlob(bytes, 'application/pdf', file));
    const now = new Date(), sheet = sh_('RmDocs'), h = HEAD.RmDocs;
    const ex = rows_('RmDocs').filter(function (r) { return String(r.kind) === d.kind && String(r.file).toLowerCase() === file.toLowerCase(); })[0];
    const row = Object.assign({}, d, {id: ex ? String(ex.id) : 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), file: file, driveId: f.getId(), size: bytes.length,
      uploadedAt: now, uploadedBy: m.email, updatedAt: now, updatedBy: m.email});
    const vals = h.map(function (k) { return row[k] !== undefined ? row[k] : ''; });
    if (ex) {
      try { DriveApp.getFileById(String(ex.driveId)).setTrashed(true); } catch (e) {}
      sheet.getRange(ex._row, 1, 1, h.length).setValues([vals]);
    } else sheet.appendRow(vals);
    log_(m.email, 'uploadRmDoc', (ex ? 'แทนที่ ' : '') + d.kind + ' ' + file + ' → ' + d.codes);
    return rmDocOut_(row);
  });
}
/** แก้ข้อมูลของเอกสาร (รหัส RM ที่ผูก ความถ่วงจำเพาะ สัญลักษณ์ ฯลฯ) โดยไม่เปลี่ยนไฟล์ */
function updateRmDoc(id, meta) {
  return withLock_(function () {
    const m = need_('editPrices');
    const ex = findRow_('RmDocs', 'id', String(id || ''));
    if (!ex) throw new Error('ไม่พบเอกสาร');
    const row = Object.assign({}, ex, rmDocClean_(meta), {updatedAt: new Date(), updatedBy: m.email});
    sh_('RmDocs').getRange(ex._row, 1, 1, HEAD.RmDocs.length).setValues([HEAD.RmDocs.map(function (k) { return row[k] !== undefined ? row[k] : ''; })]);
    log_(m.email, 'updateRmDoc', String(ex.file) + ' → ' + row.codes);
    return rmDocOut_(row);
  });
}
function deleteRmDoc(id) {
  return withLock_(function () {
    const m = need_('editPrices');
    const ex = findRow_('RmDocs', 'id', String(id || ''));
    if (!ex) throw new Error('ไม่พบเอกสาร');
    try { DriveApp.getFileById(String(ex.driveId)).setTrashed(true); } catch (e) {}
    sh_('RmDocs').deleteRow(ex._row);
    log_(m.email, 'deleteRmDoc', String(ex.kind) + ' ' + String(ex.file) + ' · ' + String(ex.codes));
    return {deleted: String(ex.id)};
  });
}

/* ===== Perfumer: บรีฟออกแบบกลิ่น (Briefs) และคลังกลิ่น (Scents) =====
   ต้นแบบฟอร์มบรีฟ: ODM Brief · SV Brief · Brand Archetype Quiz ของ Scent & Sense
   ดู: สิทธิ์ perfumer, calc หรือ viewDb · สร้าง/แก้ไข: สิทธิ์ perfumer (ทีมแก้ไขร่วมกันได้ทุกรายการ) · ลบ: ผู้สร้างหรือ admin
   ฟิลด์หลักเก็บเป็นคอลัมน์เพื่อค้นหา ส่วนรายละเอียดทั้งหมดเก็บเป็น JSON ในคอลัมน์ data · รหัสกลิ่นรันอัตโนมัติ SC-ปี-ลำดับ */
const PF_VIEW = ['perfumer', 'calc', 'viewDb'], PF_DATA_MAX = 45000;
const PF_KINDS = {ODM: 1, SV: 1, INT: 1, QUIZ: 1};
const PF_BRIEF_STATUS = {new: 1, design: 1, sample: 1, revise: 1, approved: 1, closed: 1, lost: 1};
const PF_SCENT_STATUS = {draft: 1, trial: 1, sent: 1, approved: 1, production: 1, retired: 1};
function pfJson_(d) {
  const s = JSON.stringify(d && typeof d === 'object' ? d : {});
  if (s.length > PF_DATA_MAX) throw new Error('ข้อมูลใหญ่เกินไป (ลดความยาวข้อความ)');
  return s;
}
function pfStr_(v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n); }
function briefOut_(r) {
  let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (e) {}
  return {id: String(r.id), kind: String(r.kind), brand: String(r.brand), status: String(r.status), owner: String(r.owner).toLowerCase(),
    contact: String(r.contact || ''), phone: String(r.phone || ''), email: String(r.email || ''), summary: String(r.summary || ''),
    createdAt: iso_(r.createdAt), createdBy: String(r.createdBy || ''), updatedAt: iso_(r.updatedAt), updatedBy: String(r.updatedBy || ''), data: d};
}
function scentOut_(r) {
  let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (e) {}
  return {id: String(r.id), code: String(r.code), name: String(r.name), briefId: String(r.briefId || ''), family: String(r.family || ''),
    status: String(r.status), owner: String(r.owner).toLowerCase(), formulaId: String(r.formulaId || ''),
    createdAt: iso_(r.createdAt), updatedAt: iso_(r.updatedAt), updatedBy: String(r.updatedBy || ''), data: d};
}
function pfSort_(a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); }
function listBriefs() { needAny_(PF_VIEW); return rows_('Briefs').map(briefOut_).sort(pfSort_); }
function listScents() { needAny_(PF_VIEW); return rows_('Scents').map(scentOut_).sort(pfSort_); }
function saveBrief(b) {
  return withLock_(function () {
    const m = need_('perfumer');
    b = b || {};
    const brand = pfStr_(b.brand, 200);
    if (!brand) throw new Error('ใส่ชื่อแบรนด์ / ชื่อลูกค้า');
    const kind = String(b.kind || 'ODM').toUpperCase();
    if (!PF_KINDS[kind]) throw new Error('ประเภทบรีฟไม่ถูกต้อง');
    const status = PF_BRIEF_STATUS[b.status] ? String(b.status) : 'new';
    const now = new Date(), ex = b.id ? findRow_('Briefs', 'id', String(b.id)) : null;
    if (b.id && !ex) throw new Error('ไม่พบบรีฟนี้ (อาจถูกลบไปแล้ว)');
    const owner = ex ? String(ex.owner) : m.email;
    const row = {id: ex ? String(ex.id) : 'b' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), kind: kind, brand: brand, status: status, owner: owner,
      contact: pfStr_(b.contact, 120), phone: pfStr_(b.phone, 60), email: pfStr_(b.email, 120), summary: pfStr_(b.summary, 300),
      createdAt: ex ? ex.createdAt : now, createdBy: ex ? String(ex.createdBy) : m.email, updatedAt: now, updatedBy: m.email, data: pfJson_(b.data), tfToken: ex ? String(ex.tfToken || '') : ''};
    const h = HEAD.Briefs, vals = h.map(function (k) { return row[k]; });
    if (ex) sh_('Briefs').getRange(ex._row, 1, 1, h.length).setValues([vals]); else sh_('Briefs').appendRow(vals);
    log_(m.email, 'saveBrief', (ex ? 'แก้ไข ' : 'สร้าง ') + kind + ' · ' + brand + ' [' + status + ']');
    return briefOut_(row);
  });
}
function deleteBrief(id) {
  return withLock_(function () {
    const m = need_('perfumer');
    const ex = findRow_('Briefs', 'id', String(id || ''));
    if (!ex) throw new Error('ไม่พบบรีฟนี้');
    if (!isAdmin_(m) && String(ex.createdBy).toLowerCase() !== m.email && String(ex.owner).toLowerCase() !== m.email) throw new Error('FORBIDDEN');
    if (rows_('Scents').some(function (s) { return String(s.briefId) === String(ex.id); })) throw new Error('ยังมีกลิ่นที่อ้างถึงบรีฟนี้ ย้ายหรือลบกลิ่นก่อน');
    sh_('Briefs').deleteRow(ex._row);
    log_(m.email, 'deleteBrief', String(ex.kind) + ' · ' + String(ex.brand));
    return {deleted: String(ex.id)};
  });
}
function saveScent(s) {
  return withLock_(function () {
    const m = need_('perfumer');
    s = s || {};
    const name = pfStr_(s.name, 160);
    if (!name) throw new Error('ใส่ชื่อกลิ่น');
    const status = PF_SCENT_STATUS[s.status] ? String(s.status) : 'draft';
    const briefId = pfStr_(s.briefId, 40);
    if (briefId && !findRow_('Briefs', 'id', briefId)) throw new Error('ไม่พบบรีฟที่เลือก');
    const formulaId = pfStr_(s.formulaId, 40);
    if (formulaId && !/^[A-Za-z0-9_-]{3,40}$/.test(formulaId)) throw new Error('รหัสสูตรไม่ถูกต้อง');
    const now = new Date(), ex = s.id ? findRow_('Scents', 'id', String(s.id)) : null;
    if (s.id && !ex) throw new Error('ไม่พบกลิ่นนี้ (อาจถูกลบไปแล้ว)');
    let code = ex ? String(ex.code) : '';
    if (!code) {
      const year = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy');
      const seq = rows_('Scents').filter(function (r) { return String(r.code).indexOf('SC-' + year + '-') === 0; }).length + 1;
      code = 'SC-' + year + '-' + ('0000' + seq).slice(-4);
    }
    const row = {id: ex ? String(ex.id) : 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), code: code, name: name, briefId: briefId,
      family: pfStr_(s.family, 80), status: status, owner: ex ? String(ex.owner) : m.email, formulaId: formulaId,
      createdAt: ex ? ex.createdAt : now, updatedAt: now, updatedBy: m.email, data: pfJson_(s.data)};
    const h = HEAD.Scents, vals = h.map(function (k) { return row[k]; });
    if (ex) sh_('Scents').getRange(ex._row, 1, 1, h.length).setValues([vals]); else sh_('Scents').appendRow(vals);
    log_(m.email, 'saveScent', (ex ? 'แก้ไข ' : 'สร้าง ') + code + ' · ' + name + ' [' + status + ']');
    return scentOut_(row);
  });
}
function deleteScent(id) {
  return withLock_(function () {
    const m = need_('perfumer');
    const ex = findRow_('Scents', 'id', String(id || ''));
    if (!ex) throw new Error('ไม่พบกลิ่นนี้');
    if (!isAdmin_(m) && String(ex.owner).toLowerCase() !== m.email) throw new Error('FORBIDDEN');
    if (String(ex.status) === 'production') throw new Error('กลิ่นที่ใช้ผลิตอยู่ลบไม่ได้ เปลี่ยนสถานะเป็น "เลิกใช้" แทน');
    sh_('Scents').deleteRow(ex._row);
    log_(m.email, 'deleteScent', String(ex.code) + ' · ' + String(ex.name));
    return {deleted: String(ex.id)};
  });
}

/* ===== เชื่อม Typeform: บรีฟที่ลูกค้ากรอกในฟอร์ม ODM Brief / SV Brief / Brand Archetype Quiz ไหลเข้าหน้า Perfumer อัตโนมัติ =====
   ตั้งค่า (admin): วาง Personal access token ของ Typeform (สิทธิ์ forms:read, responses:read, webhooks:write) → ระบบเก็บใน Script Properties
   แล้วตั้ง webhook ของทั้ง 3 ฟอร์มให้ส่งคำตอบมาที่ doPost?tf=<secret> ทันทีที่มีคนส่งฟอร์ม · ปุ่ม "ดึงคำตอบ" ดึงย้อนหลังผ่าน Responses API
   TF_FORMS = ตารางจับคู่คำถาม (ref) → ช่องในระบบ พร้อมตัวเลือกไทย/อังกฤษเรียงลำดับเดียวกัน (คำตอบอังกฤษแปลงเป็นไทยตามลำดับตัวเลือก) */
const TF_FORMS = {"hX1hmKKI":{"kind":"ODM","title":"ODM Brief | บรีฟจ้างผลิต (TH / EN)","fields":{"q01":{"k":"brand"},"q02":{"k":"bizStatus","th":["แบรนด์ใหม่ / เริ่มต้นธุรกิจ","แบรนด์เดิม ต้องการเพิ่มไลน์สินค้า","โรงแรม / สปา / องค์กร (อเมนิตี้ ของที่ระลึก)","ผู้จัดจำหน่าย / ร้านค้าปลีก","อินฟลูเอนเซอร์ / ครีเอเตอร์","อื่น ๆ"],"en":["New brand / start-up","Existing brand adding a product line","Hotel / spa / corporate (amenities, gifts)","Distributor / retailer","Influencer / creator","Other"]},"q03":{"k":"markets","th":["ไทย","อาเซียน","จีน","ญี่ปุ่น / เกาหลี","ยุโรป","สหรัฐฯ","ตะวันออกกลาง","อื่น ๆ"],"multi":true,"en":["Thailand","ASEAN","China","Japan / Korea","Europe","USA","Middle East","Other"]},"q04":{"k":"channels","th":["ออนไลน์ / TikTok Shop / Marketplace","ห้างสรรพสินค้า / ร้านค้าปลีก","หน้าร้านของแบรนด์","โรงแรม / สปา","ของขวัญองค์กร","ส่งออกต่างประเทศ"],"multi":true,"en":["Online / TikTok Shop / marketplaces","Department stores / retail","Own stores","Hotels / spas","Corporate gifts","Export"]},"q05":{"k":"products","th":["น้ำหอม (Perfume / Roller / Stick)","บอดี้มิสต์ / บอดี้เพอร์ฟูม","ผลิตภัณฑ์อาบน้ำ (เจลอาบน้ำ สครับ ออยล์)","บำรุงผิว (โลชั่น ครีม กันแดด)","ดูแลเส้นผม (แชมพู คอนดิชันเนอร์ แฮร์ออยล์)","ดูแลมือ (แฮนด์ครีม เจล / สเปรย์แอลกอฮอล์)","ดูแลผิวหน้า (คลีนเซอร์ โฟม)","หอมในบ้าน (ก้านไม้หอม สเปรย์ห้อง เทียนหอม สเปรย์ผ้า)","หัวน้ำหอม (Fragrance Oil) อย่างเดียว"],"multi":true,"en":["Fine fragrance (perfume, roller, stick)","Body mist / body perfume","Bath & shower (shower gel, scrub, oil)","Body care (lotion, cream, sunscreen)","Hair care (shampoo, conditioner, hair oil)","Hand care (hand cream, alcohol gel / spray)","Facial care (cleanser, foam)","Home fragrance (reed diffuser, room spray, candle, fabric spray)","Fragrance oil only"]},"q06":{"k":"sku","th":["1","2-3","4-6","7 ขึ้นไป"],"en":["1","2-3","4-6","7 or more"]},"q07":{"k":"concept"},"q08":{"k":"refProducts"},"q09":{"k":"approach","th":["ออกแบบ Signature Scent ใหม่เฉพาะแบรนด์","เลือกจากคลังกลิ่น Scent & Sense / 100 Siam Palette","พัฒนาให้ใกล้เคียงกลิ่นอ้างอิง","มีหัวน้ำหอมของตัวเองแล้ว"],"en":["Design a new signature scent for my brand","Choose from the Scent & Sense library / 100 Siam Palette","Match a reference scent","I already have my own fragrance"]},"q10":{"k":"like","th":["สดชื่น / ซิตรัส","ดอกไม้","ดอกไม้สีขาว","ไม้หอม","อำพัน / โอเรียนทัล","หวาน / กูร์มองด์","ผลไม้","น้ำ / ทะเล","กรีน / สมุนไพร","มัสก์ / Skin Scent","พฤกษาไทย","ยังไม่แน่ใจ ให้ทีมแนะนำ"],"multi":true,"en":["Fresh / citrus","Floral","White floral","Woody","Amber / oriental","Sweet / gourmand","Fruity","Aquatic","Green / herbal","Musk / skin scent","Thai botanicals","Not sure, please advise"]},"q11":{"k":"claims","th":["น้ำมันหอมระเหยธรรมชาติ","วัตถุดิบยั่งยืน / Upcycled","Vegan / Clean Beauty","ลดสารก่อภูมิแพ้ (83 Allergen Report)","อโรมาเธอราพี / Wellness","กลิ่นติดทนนาน (Encapsulation)","ลดกลิ่นไม่พึงประสงค์"],"multi":true,"en":["Natural essential oils","Sustainable / upcycled ingredients","Vegan / clean beauty","Low allergen (83 Allergen Report)","Aromatherapy / wellness","Long-lasting scent (encapsulation)","Odor neutralizing"]},"q12":{"k":"services","th":["ออกแบบกลิ่น","พัฒนาสูตรผลิตภัณฑ์","จัดหาบรรจุภัณฑ์","ออกแบบฉลากและบรรจุภัณฑ์","ออกแบบแบรนด์ (โลโก้ CI)","จดแจ้ง อย.","เอกสาร MSDS / COA / IFRA / Stability Test","เวิร์กช็อปและอบรมทีมขาย"],"multi":true,"en":["Scent design","Product formulation","Packaging sourcing","Label and packaging design","Brand design (logo, CI)","Thai FDA registration","MSDS / COA / IFRA / stability test documents","Sales team workshop and training"]},"q13":{"k":"packaging","th":["มีบรรจุภัณฑ์ของตัวเอง","ให้ Scent & Sense จัดหา","ยังไม่แน่ใจ"],"en":["I have my own packaging","Please source packaging for me","Not sure yet"]},"q14":{"k":"qty","th":["น้อยกว่า 500 ชิ้น","500-1,000","1,000-3,000","3,000-10,000","มากกว่า 10,000"],"en":["Under 500 pcs","500-1,000","1,000-3,000","3,000-10,000","Over 10,000"]},"q15":{"k":"retail","th":["ต่ำกว่า 200 บาท","200-499","500-999","1,000-1,999","2,000 บาทขึ้นไป"],"en":["Under USD 6","USD 6-15","USD 15-30","USD 30-60","Over USD 60"]},"q16":{"k":"launch","th":["ภายใน 3 เดือน","3-6 เดือน","6-12 เดือน","มากกว่า 12 เดือน","ยังไม่แน่ใจ"],"en":["Within 3 months","3-6 months","6-12 months","Over 12 months","Not sure yet"]},"q17":{"k":"contact"},"q18":{"k":"position"},"q19":{"k":"phone"},"q20":{"k":"email"},"q21":{"k":"line"},"q22":{"k":"moodboard"},"q23":{"k":"notes"},"q24":{"k":"consent"}}},"IUMus82U":{"kind":"SV","title":"SV Brief | ค้นหากลิ่นประจำแบรนด์ธุรกิจบริการ (TH/EN)","fields":{"q1":{"k":"brand"},"q2":{"k":"bizType","th":["โรงแรม / รีสอร์ต","สปา / เวลเนส","คลินิก / โรงพยาบาล","ร้านอาหาร / คาเฟ่","โชว์รูม / ยานยนต์","อาคารสำนักงาน","ร้านค้า / ศูนย์การค้า","ที่พักอาศัย / อสังหาฯ","บันเทิง / อีเวนต์ / มิวเซียม","ฟิตเนส / ซาลอน"],"en":["Hotel / Resort","Spa / Wellness","Clinic / Hospital","Restaurant / Café","Showroom / Automotive","Office building","Retail store / Shopping centre","Residential / Real estate","Entertainment / Events / Museum","Fitness centre / Salon"]},"q3":{"k":"location"},"q4":{"k":"branches"},"q5":{"k":"website"},"q6":{"k":"positioning","th":["เข้าถึงง่าย (Accessible)","พรีเมียม (Premium)","ลักชัวรี (Luxury)","เหนือระดับ (Ultra-luxury)"],"en":["Accessible","Premium","Luxury","Ultra-luxury"]},"q7":{"k":"slogan"},"q8":{"k":"words3"},"q9":{"k":"story"},"q10":{"k":"customers"},"q12":{"k":"feelings","th":["ผ่อนคลาย สงบ","สดชื่น สะอาด","หรูหรา มีระดับ","อบอุ่น ได้รับการต้อนรับ","มีพลัง กระฉับกระเฉง","สร้างแรงบันดาลใจ","น่าเชื่อถือ ปลอดภัย","โรแมนติก ใกล้ชิด","สนุก ตื่นเต้น","อยากอาหาร","มีสมาธิ จดจ่อ","ดื่มด่ำ ลึกลับ"],"multi":true,"en":["Relaxed / Calm","Refreshed / Clean","Luxurious / Sophisticated","Warm / Welcomed","Energised / Active","Inspired","Reassured / Safe","Romantic / Intimate","Playful / Excited","Hungry / Tempted to eat","Focused / Attentive","Immersed / Intrigued"]},"q13":{"k":"touchpoints","th":["กล่องของขวัญ / จดหมายเชิญ","รถรับส่ง","ทางเข้า / ล็อบบี้","ลิฟต์ / ทางเดิน","ห้องพัก / ห้องทรีตเมนต์","ห้องอาหาร","ห้องน้ำ","อเมนิตี้ (สบู่ แชมพู โลชั่น)","สปา / สระว่ายน้ำ","ร้านของที่ระลึก","ของฝากกลับบ้าน","ของขวัญองค์กร"],"multi":true,"en":["Gift boxes / Invitations","Shuttle vehicles","Entrance / Lobby","Lifts / Corridors","Guest rooms / Treatment rooms","Dining areas","Restrooms","Amenities (soap, shampoo, lotion)","Spa / Swimming pool","Souvenir shop","Take-home gifts","Corporate gifts"]},"q14":{"k":"moments"},"q15":{"k":"like","th":["ซิตรัส","กรีน / สมุนไพร","ดอกไม้","ดอกไม้สีขาว","ชา","น้ำ / ทะเล","ไม้หอม","อำพัน / โอเรียนทัล","เครื่องเทศ","หนัง / ควันไม้","หวานละมุน","พฤกษาไทย"],"multi":true,"en":["Citrus","Green / Herbal","Floral","White floral","Tea","Aquatic / Marine","Woody","Amber / Oriental","Spicy","Leather / Smoky wood","Soft / Sweet","Thai botanicals"]},"q16":{"k":"dislike","th":["ซิตรัส","กรีน / สมุนไพร","ดอกไม้","ดอกไม้สีขาว","ชา","น้ำ / ทะเล","ไม้หอม","อำพัน / โอเรียนทัล","เครื่องเทศ","หนัง / ควันไม้","หวานละมุน","พฤกษาไทย"],"multi":true,"en":["Citrus","Green / Herbal","Floral","White floral","Tea","Aquatic / Marine","Woody","Amber / Oriental","Spicy","Leather / Smoky wood","Soft / Sweet","Thai botanicals"]},"q18":{"k":"sustainable","th":["Natural Ingredients — สนใจส่วนผสมจากธรรมชาติ เช่น Essential Oils","Thai Identity — สนใจกลิ่นและวัตถุดิบที่สะท้อนเอกลักษณ์ไทย ผ่าน 100 Siam Palette","Upcycled Ingredients — สนใจวัตถุดิบที่นำผลพลอยได้หรือวัสดุเหลือใช้กลับมาสร้างคุณค่าใหม่","Open to Suggestions — เปิดรับคำแนะนำจากทีมผู้เชี่ยวชาญ โดยไม่จำกัดประเภทวัตถุดิบ"],"multi":true,"en":["Natural Ingredients — Natural ingredients such as essential oils","Thai Identity — Scents and ingredients reflecting Thai identity through 100 Siam Palette","Upcycled Ingredients — Giving by-products or unused materials new value","Open to Suggestions — Expert recommendations without restrictions on ingredient types"]},"q19":{"k":"refScent"},"q20":{"k":"avoid"},"q22":{"k":"hvac","th":["มี ระบบส่วนกลาง","ไม่มี ใช้แอร์แยกห้อง","ไม่แน่ใจ"],"en":["Yes, a central system","No, separate air-conditioning units","Not sure"]},"q23":{"k":"hours"},"q24":{"k":"svProducts","th":["ระบบกระจายกลิ่น (Scent Diffuser)","ก้านไม้หอม (Reed Diffuser)","Hotel Amenities: Shower gel, Shampoo, Body Lotion etc.","Spa Amenities: Body Oil, Massage Oil etc.","ระบบสุขอนามัย (Soap / Urinal sanitizer)","ระบบกระดาษเช็ดมือ","ของที่ระลึก / ของขวัญองค์กร","สเปรย์ห้อง / สเปรย์ผ้า","เทียนหอม / ถุงหอม"],"multi":true,"en":["Scent diffuser systems","Reed diffusers","Hotel amenities: shower gel, shampoo, body lotion, etc.","Spa amenities: body oil, massage oil, etc.","Hygiene systems (soap / urinal sanitiser)","Paper towel systems","Souvenirs / Corporate gifts","Room sprays / Fabric sprays","Scented candles / Sachets"]},"q25":{"k":"start","th":["ภายใน 1 เดือน","1-3 เดือน","3-6 เดือน","มากกว่า 6 เดือน / เปิดโครงการใหม่"],"en":["Within 1 month","In 1–3 months","In 3–6 months","More than 6 months / New project opening"]},"q26":{"k":"offering","th":["ระบบดูแลบรรยากาศ","ของใช้ในโรงแรม","ของใช้ในสปา","ของฝากที่ระลึก"],"en":["Ambient scent systems","Hotel amenities","Spa amenities","Souvenirs"]},"q27":{"k":"budget","th":["ต่ำกว่า 30,000 บาท","30,000-100,000 บาท","100,000-300,000 บาท","มากกว่า 300,000 บาท","ไม่ระบุ"],"en":["Below THB 30,000","THB 30,000–100,000","THB 100,000–300,000","Above THB 300,000","Prefer not to specify"]},"q28":{"k":"source","th":["Google","Facebook / Instagram","LINE","งานแสดงสินค้า (Expo)","คนรู้จักแนะนำ","อื่น ๆ"],"en":["Google","Facebook / Instagram","LINE","Trade show / Expo","Referral","Other"]},"contact_name":{"k":"contact"},"contact_phone":{"k":"phone"},"contact_email":{"k":"email"},"contact_company":{"k":"company"},"q30":{"k":"position"},"q32":{"k":"notes"},"q33":{"k":"consent"}}},"XE5KreIp":{"kind":"QUIZ","title":"Brand Archetype Quiz | ค้นหาตัวตนแบรนด์ (TH / EN)","fields":{"brand_name":{"k":"brand"},"q1":{"k":"arch0","th":["สร้างมาตรฐานความเป็นเลิศและความมั่นคง","ดูแลและปกป้องลูกค้าเหมือนคนในครอบครัว","สร้างสรรค์สิ่งใหม่ที่ยังไม่เคยมีใครทำ","ทำให้ชีวิตลูกค้าเรียบง่ายและมีความสุข","มอบความรู้และคำตอบที่เชื่อถือได้","พาลูกค้าไปพบประสบการณ์ใหม่"],"en":["Set the standard for excellence and stability","Care for and protect customers like family","Create something new that no one has done before","Make customers' lives simple and happy","Share knowledge and answers people can trust","Take customers on new experiences"]},"q2":{"k":"arch1","th":["กล้าคิดต่าง ไม่ทำตามใคร","มีเสน่ห์ลึกลับ ทำเรื่องธรรมดาให้น่าทึ่ง","มุ่งมั่น ไม่ยอมแพ้ ชอบความท้าทาย","เป็นกันเอง เข้าถึงง่าย","ตลก สดใส อยู่ด้วยแล้วสนุก","อบอุ่น ละมุน ใส่ใจความรู้สึก"],"en":["Bold and different, never follows the crowd","Mysterious and charming, makes the ordinary amazing","Driven, never gives up, loves a challenge","Friendly and easy to talk to","Funny and bright, always fun to be around","Warm and gentle, attentive to feelings"]},"q3":{"k":"arch2","th":["หรูหรา มีระดับ","พิเศษ เหมือนได้รับการดูแลอย่างใกล้ชิด","มีพลัง พร้อมลุยเป้าหมาย","สงบ ปลอดโปร่ง สบายใจ","ตื่นเต้น อยากค้นหาต่อ","สนุก อารมณ์ดี ยิ้มได้"],"en":["Luxurious and prestigious","Special, personally cared for","Energized, ready to go","Calm, clear and at ease","Excited to explore more","Happy and smiling"]},"q4":{"k":"arch3","th":["บริการที่เอาใจใส่ทุกคน","ไอเดียและการออกแบบที่ไม่ซ้ำใคร","ความเชี่ยวชาญและข้อมูลที่ลึกซึ้ง","การท้าทายวิธีเดิม ๆ ของอุตสาหกรรม","ประสบการณ์ที่เปลี่ยนความรู้สึกลูกค้าได้จริง","ความจริงใจ เข้าถึงได้ทุกคน"],"en":["Attentive service for everyone","Original ideas and design","Deep expertise and knowledge","Challenging the industry's old ways","Experiences that truly change how customers feel","Sincerity and being accessible to all"]},"q5":{"k":"arch4","th":["ห้องสมุดเงียบสงบริมสวน","โรงละครที่เต็มไปด้วยเวทมนตร์","สนามแข่งขันระดับโลก","บ้านอบอุ่นที่มีคนรอต้อนรับ","ร้านกาแฟประจำซอยที่ทุกคนรู้จัก","สปาหรูริมทะเลยามพระอาทิตย์ตก"],"en":["A quiet library by a garden","A theatre full of magic","A world-class stadium","A warm home where someone is waiting for you","The neighborhood cafe everyone knows","A luxury spa by the sea at sunset"]},"q6":{"k":"arch5","th":["น่าเชื่อถือ ระดับพรีเมียม","ไม่เหมือนใคร มีสไตล์","สะอาด บริสุทธิ์ ไว้ใจได้","อิสระ กล้าลอง","เท่ แรง มีจุดยืน","สนุก ขำ น่ารัก"],"en":["Trusted and premium","Unique and stylish","Clean, pure and reliable","Free and adventurous","Cool, bold, with a point of view","Fun, funny and cute"]},"q7":{"k":"arch6","th":["วางระบบและควบคุมสถานการณ์ให้เป็นระเบียบ","ร่วมมือกับทุกคนหาทางออกที่ทุกฝ่ายรับได้","พลิกวิกฤตให้เป็นโอกาสที่ไม่มีใครคาดคิด","ลองเส้นทางใหม่ที่ยังไม่มีใครเดิน","ใส่ใจความรู้สึกของลูกค้าและทีมก่อน","ปกป้องลูกค้าไม่ให้ได้รับผลกระทบ"],"en":["Set up systems and bring order to the situation","Work with everyone to find a solution all can accept","Turn the crisis into an unexpected opportunity","Try a new path no one has taken","Put customers' and the team's feelings first","Protect customers from any impact"]},"q8":{"k":"arch7","th":["กลิ่นแปลกใหม่ ผสมผสานไม่เหมือนใคร","กลิ่นผ้าสะอาด มัสก์ขาว ดอกไม้อ่อน ๆ","กลิ่นชา ไม้ซีดาร์ และกำยาน","กลิ่นหนัง ควันไม้ เครื่องเทศเข้ม","กลิ่นซิตรัส มินต์ สดชื่นกระฉับกระเฉง","กลิ่นผลไม้หวาน สดใส ขี้เล่น"],"en":["Something new, an unexpected blend","Clean cotton, white musk, soft florals","Tea, cedarwood and incense","Leather, smoky wood, bold spices","Citrus and mint, fresh and energetic","Sweet fruits, bright and playful"]},"email":{"k":"email"}}}};
const TF_API = 'https://api.typeform.com', TF_TAG = 'scentsense-costing';
const TF_SYN = {'สดชื่น / ซิตรัส': 'ซิตรัส / สดชื่น', 'ซิตรัส': 'ซิตรัส / สดชื่น', 'หวานละมุน': 'หวาน / กูร์มองด์', 'มีหัวน้ำหอมของตัวเองแล้ว': 'ลูกค้ามีหัวน้ำหอมของตัวเองแล้ว',
  'Natural Ingredients — สนใจส่วนผสมจากธรรมชาติ เช่น Essential Oils': 'Natural Ingredients — ส่วนผสมจากธรรมชาติ เช่น Essential Oils',
  'Thai Identity — สนใจกลิ่นและวัตถุดิบที่สะท้อนเอกลักษณ์ไทย ผ่าน 100 Siam Palette': 'Thai Identity — เอกลักษณ์ไทยผ่าน 100 Siam Palette',
  'Upcycled Ingredients — สนใจวัตถุดิบที่นำผลพลอยได้หรือวัสดุเหลือใช้กลับมาสร้างคุณค่าใหม่': 'Upcycled Ingredients — วัตถุดิบจากผลพลอยได้',
  'Open to Suggestions — เปิดรับคำแนะนำจากทีมผู้เชี่ยวชาญ โดยไม่จำกัดประเภทวัตถุดิบ': 'Open to Suggestions — เปิดรับคำแนะนำจากทีม',
  'Hotel Amenities: Shower gel, Shampoo, Body Lotion etc.': 'Hotel Amenities (Shower gel, Shampoo, Body Lotion)', 'Spa Amenities: Body Oil, Massage Oil etc.': 'Spa Amenities (Body Oil, Massage Oil)'};
function tfProps_() { return PropertiesService.getScriptProperties(); }
function tfToken_() { return tfProps_().getProperty('TYPEFORM_TOKEN') || ''; }
function tfSecret_() {
  let s = tfProps_().getProperty('TYPEFORM_SECRET');
  if (!s) { s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); tfProps_().setProperty('TYPEFORM_SECRET', s); }
  return s;
}
function tfFetch_(path, opt) {
  const token = tfToken_();
  if (!token) throw new Error('ยังไม่ได้เชื่อม Typeform (ใส่ Personal access token ก่อน)');
  const o = Object.assign({muteHttpExceptions: true, headers: {Authorization: 'Bearer ' + token}}, opt || {});
  if (o.payload && typeof o.payload !== 'string') { o.payload = JSON.stringify(o.payload); o.contentType = 'application/json'; }
  const res = UrlFetchApp.fetch(TF_API + path, o), code = res.getResponseCode(), txt = res.getContentText();
  if (code === 401 || code === 403) throw new Error('Typeform ปฏิเสธ token (ตรวจว่ายังไม่หมดอายุและมีสิทธิ์ forms:read, responses:read, webhooks:write)');
  if (code >= 400) throw new Error('Typeform ตอบกลับ ' + code + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : {};
}
function tfWebhookUrl_() {
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (!url) url = getSetting_('tfExecUrl') || '';
  if (!url) throw new Error('หา URL ของ Web App ไม่พบ');
  return url + (url.indexOf('?') < 0 ? '?' : '&') + 'tf=' + tfSecret_();
}
/** admin: สถานะการเชื่อมต่อ + ฟอร์มที่รองรับ */
function getTypeformStatus() {
  const m = me_();
  if (!isAdmin_(m)) throw new Error('FORBIDDEN');
  const token = tfToken_(), forms = Object.keys(TF_FORMS).map(function (id) {
    return {id: id, kind: TF_FORMS[id].kind, title: TF_FORMS[id].title, url: 'https://form.typeform.com/to/' + id, webhook: getSetting_('tfHook:' + id) === 'on', lastSync: getSetting_('tfSync:' + id) || ''};
  });
  const imported = rows_('Briefs').filter(function (r) { return String(r.tfToken || ''); }).length;
  return {connected: !!token, account: getSetting_('tfAccount') || '', forms: forms, imported: imported, lastRun: getSetting_('tfLastRun') || '', lastError: getSetting_('tfLastError') || ''};
}
/** admin: บันทึก token แล้วตั้ง webhook ให้ทั้ง 3 ฟอร์ม */
function saveTypeformToken(token) {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    token = String(token || '').trim();
    if (!/^[A-Za-z0-9_\-\.]{20,200}$/.test(token)) throw new Error('รูปแบบ token ไม่ถูกต้อง');
    tfProps_().setProperty('TYPEFORM_TOKEN', token);
    let me;
    try { me = tfFetch_('/me'); } catch (e) { tfProps_().deleteProperty('TYPEFORM_TOKEN'); throw e; }
    setSetting_('tfAccount', String(me.alias || me.email || ''));
    const hook = tfWebhookUrl_(), results = [];
    Object.keys(TF_FORMS).forEach(function (id) {
      try {
        tfFetch_('/forms/' + id + '/webhooks/' + TF_TAG, {method: 'put', payload: {url: hook, enabled: true, secret: tfSecret_(), verify_ssl: true}});
        setSetting_('tfHook:' + id, 'on'); results.push(id + ' ok');
      } catch (e) { setSetting_('tfHook:' + id, 'off'); results.push(id + ' ' + e.message); }
    });
    log_(m.email, 'saveTypeformToken', 'บัญชี ' + (me.alias || '') + ' · webhook: ' + results.join('; '));
    return getTypeformStatus();
  });
}
function disconnectTypeform() {
  return withLock_(function () {
    const m = me_();
    if (!isAdmin_(m)) throw new Error('FORBIDDEN');
    Object.keys(TF_FORMS).forEach(function (id) {
      try { tfFetch_('/forms/' + id + '/webhooks/' + TF_TAG, {method: 'delete'}); } catch (e) {}
      setSetting_('tfHook:' + id, 'off');
    });
    tfProps_().deleteProperty('TYPEFORM_TOKEN'); tfProps_().deleteProperty('TYPEFORM_SECRET');
    setSetting_('tfAccount', '');
    log_(m.email, 'disconnectTypeform', '');
    return getTypeformStatus();
  });
}
/** ดึงคำตอบย้อนหลังผ่าน Responses API (all=true ดึงทุกคำตอบ ไม่ใช่เฉพาะหลังครั้งล่าสุด) · สิทธิ์ perfumer */
function syncTypeform(all) {
  return withLock_(function () {
    const m = need_('perfumer');
    const out = {imported: 0, skipped: 0, attached: 0, forms: {}};
    Object.keys(TF_FORMS).forEach(function (id) {
      let q = '/forms/' + id + '/responses?page_size=1000&completed=true';
      const since = getSetting_('tfSync:' + id);
      if (!all && since) q += '&since=' + encodeURIComponent(since);
      let page = tfFetch_(q), n = 0;
      (page.items || []).forEach(function (it) { const r = tfImport_(id, it); out[r]++; n++; });
      out.forms[id] = n;
      setSetting_('tfSync:' + id, new Date().toISOString());
    });
    setSetting_('tfLastRun', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') + ' โดย ' + m.email);
    log_(m.email, 'syncTypeform', JSON.stringify(out));
    return out;
  });
}
/** webhook จาก Typeform: ตรวจ secret แล้วนำเข้า 1 คำตอบ */
function tfWebhook_(e) {
  const ok = function (s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); };
  try {
    if (!tfToken_() || String(e.parameter.tf) !== tfProps_().getProperty('TYPEFORM_SECRET')) return ok('forbidden');
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (body.event_type !== 'form_response' || !body.form_response) return ok('ignored');
    const fr = body.form_response, id = String(fr.form_id || '');
    if (!TF_FORMS[id]) return ok('unknown form');
    const r = withLock_(function () { return tfImport_(id, fr); });
    log_('typeform', 'webhook', id + ' · ' + String(fr.token || '').slice(0, 12) + ' · ' + r);
    return ok(r);
  } catch (err) {
    setSetting_('tfLastError', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') + ' ' + String(err && err.message || err).slice(0, 200));
    return ok('error');
  }
}
/* --- แปลงคำตอบ 1 ชุดเป็นบรีฟ --- */
function tfNorm_(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
/** แปลงป้ายตัวเลือก (ไทยหรืออังกฤษ) เป็นป้ายไทยที่ระบบใช้ */
function tfChoice_(fdef, label) {
  label = String(label || '').replace(/\s+/g, ' ').trim();
  if (fdef.en && fdef.th) { const i = fdef.en.findIndex(function (x) { return tfNorm_(x) === tfNorm_(label); }); if (i >= 0 && fdef.th[i]) label = fdef.th[i]; }
  return TF_SYN[label] || label;
}
function tfAnswerValue_(a) {
  switch (a.type) {
    case 'text': return a.text; case 'email': return a.email; case 'phone_number': return a.phone_number; case 'url': return a.url;
    case 'number': return a.number; case 'boolean': return a.boolean; case 'date': return a.date;
    case 'choice': return a.choice ? (a.choice.label || a.choice.other || '') : '';
    case 'choices': return a.choices ? (a.choices.labels || []).concat(a.choices.other ? [a.choices.other] : []) : [];
    default: return a.text || '';
  }
}
function tfImport_(formId, fr) {
  const def = TF_FORMS[formId], token = String(fr.token || fr.response_id || '');
  if (!token) return 'skipped';
  const seen = rows_('Briefs').some(function (r) {   // เคยนำเข้าแล้ว (ทั้งบรีฟหลัก และ Quiz ที่ผูกเข้าบรีฟเดิม)
    if (String(r.tfToken || '') === token) return true;
    return String(r.data || '').indexOf('"' + token + '"') >= 0 && (function () { try { const x = JSON.parse(r.data); return x.archTf && x.archTf.token === token; } catch (e) { return false; } })();
  });
  if (seen) return 'skipped';
  const d = {tf: {form: formId, token: token, submitted: String(fr.submitted_at || ''), landed: String(fr.landed_at || '')}}, arch = [];
  let lang = 'TH';
  (fr.answers || []).forEach(function (a) {
    const ref = String((a.field && a.field.ref) || ''), base = ref.replace(/^en_/, '');
    if (/^language/.test(base)) { const v = tfAnswerValue_(a); if (/english|อังกฤษ/i.test(String(v))) lang = 'EN'; return; }
    const fdef = def.fields[base]; if (!fdef) return;
    let v = tfAnswerValue_(a);
    if (a.type === 'choice') v = tfChoice_(fdef, v);
    else if (a.type === 'choices') v = v.map(function (x) { return tfChoice_(fdef, x); });
    if (/^arch\d$/.test(fdef.k)) {   // คำถาม Archetype: เก็บเป็นลำดับตัวเลือก (ตรงกับแบบทดสอบในระบบ)
      const list = ref.indexOf('en_') === 0 ? (fdef.en || []) : (fdef.th || []);
      const i = list.findIndex(function (x) { return tfNorm_(x) === tfNorm_(a.choice && a.choice.label); });
      arch[Number(fdef.k.slice(4))] = i >= 0 ? String(i) : ''; return;
    }
    if (fdef.k === 'consent') { d.consent = v === true; return; }
    if (fdef.k === 'branches') { d.branches = v === '' || v === null ? '' : Number(v); return; }
    d[fdef.k] = typeof v === 'string' ? v.slice(0, 3000) : v;
  });
  d.lang = lang;
  if (arch.length) { for (let i = 0; i < 8; i++) if (arch[i] === undefined) arch[i] = ''; d.arch = {answers: arch, result: ''}; }
  const brand = pfStr_(d.brand, 200) || 'ไม่ระบุแบรนด์'; delete d.brand;
  const now = new Date(), kind = def.kind;
  if (kind === 'QUIZ') {   // ถ้ามีบรีฟของแบรนด์เดียวกันที่ยังไม่มีผล Archetype ให้ผูกผลเข้าไปแทนการสร้างบรีฟใหม่
    const hit = rows_('Briefs').filter(function (r) { return tfNorm_(r.brand) === tfNorm_(brand) && String(r.kind) !== 'QUIZ'; })
      .map(function (r) { let x = {}; try { x = JSON.parse(r.data || '{}'); } catch (e) {} return {r: r, d: x}; })
      .filter(function (o) { return !(o.d.arch && (o.d.arch.answers || []).some(String)); })[0];
    if (hit) {
      hit.d.arch = d.arch; hit.d.archTf = d.tf; if (d.email && !hit.d.email) hit.d.email = d.email;
      const sh = sh_('Briefs');
      sh.getRange(hit.r._row, HEAD.Briefs.indexOf('data') + 1).setValue(pfJson_(hit.d));
      sh.getRange(hit.r._row, HEAD.Briefs.indexOf('updatedAt') + 1, 1, 2).setValues([[now, 'typeform']]);
      return 'attached';
    }
  }
  const prods = (d.products || d.svProducts || []);
  const summary = ['Typeform', kind === 'QUIZ' ? 'Archetype Quiz' : (prods.length ? prods.slice(0, 2).map(function (p) { return String(p).split(' (')[0]; }).join(', ') + (prods.length > 2 ? ' +' + (prods.length - 2) : '') : ''), d.sku ? d.sku + ' SKU' : '', d.budget || d.retail || ''].filter(String).join(' · ');
  const row = {id: 'b' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), kind: kind, brand: brand, status: 'new', owner: '',
    contact: pfStr_(d.contact, 120), phone: pfStr_(d.phone, 60), email: pfStr_(d.email, 120), summary: summary.slice(0, 300),
    createdAt: fr.submitted_at ? new Date(fr.submitted_at) : now, createdBy: 'typeform', updatedAt: now, updatedBy: 'typeform', data: pfJson_(d), tfToken: token};
  sh_('Briefs').appendRow(HEAD.Briefs.map(function (k) { return row[k]; }));
  return 'imported';
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
