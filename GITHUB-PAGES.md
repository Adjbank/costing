# เอาระบบต้นทุนหัวน้ำหอมขึ้น GitHub Pages

หน้าเว็บอยู่บน GitHub Pages ส่วนข้อมูลและสิทธิ์ยังอยู่ที่ Google Apps Script + Google Sheet เหมือนเดิม

```
ผู้ใช้ ──(Sign in with Google)──▶ หน้าเว็บบน GitHub Pages  (ไม่มีข้อมูลราคา)
                                      │  ส่ง Google ID token ทุกคำขอ
                                      ▼
                         Apps Script API (doPost) ── ตรวจ token กับ Google
                                      │              ตรวจโดเมน @scentandsense.co.th / .co
                                      ▼              ตรวจบทบาทและสิทธิ์
                                Google Sheet (ผู้ใช้ บทบาท ราคา Log)
```

## คำสั่ง build

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

อ่าน `apps-script/Index.html` และ `site.config.json` แล้วสร้าง `dist/index.html` (หน้าเว็บที่ขึ้น GitHub Pages) สคริปต์จะหยุดถ้ายังไม่ได้ตั้งค่า หรือถ้าพบข้อมูลราคาในหน้าเว็บ

บน GitHub ไม่ต้องรันเอง: ทุกครั้งที่ push ขึ้น branch `main` GitHub Actions (`.github/workflows/pages.yml`) จะรัน `build.ps1` และ deploy ให้อัตโนมัติ

## ไฟล์ที่ขึ้น GitHub และไม่ขึ้น

| ขึ้น GitHub | ไม่ขึ้น (กันไว้ใน `.gitignore`) |
| --- | --- |
| `build.ps1`, `site.config.json`, `.github/workflows/pages.yml` | `apps-script/Prices.gs` (ราคาวัตถุดิบ 1,123 รายการ) |
| `apps-script/Index.html`, `Code.gs`, `appsscript.json` | ไฟล์ PDF ทั้งหมด |
| คู่มือ (`GITHUB-PAGES.md`, `apps-script/คู่มือติดตั้ง.md`) | `ระบบคำนวณต้นทุนหัวน้ำหอม.html` (ไฟล์เก่าที่ฝังราคา) และไฟล์อื่นในโฟลเดอร์ |

## ขั้นตอน (ทำครั้งเดียว ประมาณ 30 นาที)

### 1. อัปเดตโปรเจกต์ Apps Script

ในโปรเจกต์ "ระบบต้นทุนหัวน้ำหอม" ที่ติดตั้งไว้แล้ว

1. แทนที่ `รหัส.gs` ด้วยเนื้อหา `apps-script/Code.gs` ฉบับใหม่ (ไม่มีราคาแล้ว และมี API สำหรับ GitHub Pages)
2. กด **＋ → สคริปต์** ตั้งชื่อ `Prices` แล้ววางเนื้อหา `apps-script/Prices.gs`
3. แทนที่ `Index.html` และ `appsscript.json` ด้วยฉบับใหม่ (เพิ่มสิทธิ์ `script.external_request` สำหรับตรวจ token กับ Google)
4. บันทึก แล้วรันฟังก์ชัน `setup` อีกครั้ง กด **Allow** สิทธิ์ใหม่ (ข้อมูลเดิมในชีตไม่หาย)

### 2. สร้าง Google OAuth Client ID (สำหรับปุ่ม Sign in with Google)

1. ไปที่ https://console.cloud.google.com ด้วยบัญชี ratchaphon@scentandsense.co.th แล้วสร้างโปรเจกต์ใหม่ เช่น `scent-sense-costing`
2. **APIs & Services → OAuth consent screen**: User type **Internal** (เฉพาะบัญชีในองค์กร) ตั้งชื่อแอป `ระบบต้นทุนหัวน้ำหอม` ใส่อีเมลติดต่อ แล้วบันทึก
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://<ชื่อผู้ใช้-github>.github.io`
4. คัดลอก **Client ID** (ลงท้ายด้วย `.apps.googleusercontent.com`)

### 3. ตั้งค่า Script properties ใน Apps Script

**Project Settings (⚙) → Script properties → Add script property**

| Property | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Client ID จากขั้นที่ 2 |
| `PUBLIC_URL` | `https://<ชื่อผู้ใช้-github>.github.io/<ชื่อ-repo>/` (ใช้ในอีเมลแจ้งผู้ใช้และปุ่มแชร์ลิงก์) |

### 4. Deploy Apps Script เป็น API

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone**
- กด Deploy แล้วคัดลอก URL ที่ลงท้ายด้วย `/exec`

ทำไมต้องเป็น Anyone: หน้าเว็บบน GitHub Pages เรียก API โดยไม่มี cookie ของ Google ระบบจึงยืนยันตัวตนด้วย Google ID token แทน ทุกคำขอที่ไม่มี token ที่ถูกต้องจากบัญชีบริษัทจะถูกปฏิเสธ (`AUTH_REQUIRED`, `AUTH_INVALID`, `DOMAIN`) และฟังก์ชันที่เรียกได้มีเฉพาะในรายการ `doPost`

ถ้าต้องการให้หน้าเว็บเดิมใน Apps Script ใช้ต่อได้ด้วย ให้คง deployment เดิม (Who has access: องค์กร) ไว้ คนละ deployment กัน

### 5. ใส่ค่าใน `site.config.json`

```json
{
  "apiUrl": "https://script.google.com/macros/s/XXXXXXXX/exec",
  "googleClientId": "123456789012-xxxxxxxx.apps.googleusercontent.com"
}
```

ทั้งสองค่าไม่ใช่ความลับ (Client ID ออกแบบมาให้อยู่ในหน้าเว็บได้) แต่ถ้าไม่อยากเก็บใน repo ให้ตั้งเป็น GitHub variables ชื่อ `COSTING_API_URL` และ `GOOGLE_CLIENT_ID` แทน (Settings → Secrets and variables → Actions → Variables)

ทดสอบ build บนเครื่อง:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

### 6. ติดตั้ง Git และ push ขึ้น GitHub

ติดตั้ง Git (ครั้งแรกครั้งเดียว) แล้วเปิด PowerShell ใหม่:

```powershell
winget install --id Git.Git -e
```

สร้าง repo ใหม่บน https://github.com/new (เช่น `costing`) แล้วรันในโฟลเดอร์นี้:

```powershell
git init
git add .
git status
```

**ตรวจผล `git status` ก่อน commit**: ต้องไม่มี `Prices.gs`, ไฟล์ `.pdf` หรือ `ระบบคำนวณต้นทุนหัวน้ำหอม.html`

```powershell
git commit -m "ระบบคำนวณต้นทุนหัวน้ำหอม: หน้าเว็บสำหรับ GitHub Pages"
git branch -M main
git remote add origin https://github.com/<ชื่อผู้ใช้-github>/costing.git
git push -u origin main
```

### 7. เปิด GitHub Pages

ใน repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**

ดูความคืบหน้าที่แท็บ **Actions** เมื่อเสร็จ หน้าเว็บอยู่ที่ `https://<ชื่อผู้ใช้-github>.github.io/costing/`

### 8. ทดสอบ

- เปิดลิงก์ กด Sign in with Google ด้วยบัญชีบริษัท ต้องเข้าระบบได้และเห็นราคา
- ลองบัญชี Gmail ส่วนตัว ต้องขึ้น "อีเมลนี้ใช้ไม่ได้"
- ลองบัญชีบทบาท "ทีมต้นทุน" ต้องไม่เห็นปุ่มจัดการผู้ใช้และอัปเดตราคา

## อัปเดตในอนาคต

| แก้อะไร | ทำอย่างไร |
| --- | --- |
| หน้าเว็บ (`apps-script/Index.html`) | `git add . && git commit -m "..." && git push` แล้ว GitHub deploy ให้เอง |
| เซิร์ฟเวอร์ (`Code.gs`) | วางใน Apps Script แล้ว **Deploy → Manage deployments → ✏ → Version: New version** (URL เดิม) |
| ราคาวัตถุดิบ | อัปโหลดไฟล์ Excel ผ่านปุ่ม "อัปเดตราคาให้ทั้งทีม" ในหน้าเว็บ ไม่ต้องแก้โค้ด |

## ข้อควรรู้

- **repo สาธารณะ** ใครก็เห็นโค้ดหน้าเว็บได้ แต่ไม่มีข้อมูลราคาหรือรายชื่อผู้ใช้ (อยู่ใน Google Sheet และส่งให้หลังยืนยันตัวตนเท่านั้น) ถ้าต้องการ repo ส่วนตัวพร้อม Pages ต้องใช้ GitHub แบบเสียเงิน
- **เข้าสู่ระบบ 1 ครั้งใช้ได้ 1 ชั่วโมง** หลังจากนั้นระบบขอเข้าสู่ระบบใหม่ (ถ้าเคยกดไว้ Google มักเข้าให้อัตโนมัติ)
- **OAuth consent screen แบบ Internal** อนุญาตเฉพาะบัญชีใน Google Workspace ของบริษัท ถ้า @scentandsense.co เป็น Workspace แยก ต้องตั้งเป็น External แทน (ระบบยังตรวจโดเมนที่เซิร์ฟเวอร์ทุกครั้ง)
- เปลี่ยนชื่อ repo หรือใช้โดเมนของตัวเอง ต้องเพิ่ม origin ใหม่ใน OAuth Client ID และแก้ `PUBLIC_URL`
