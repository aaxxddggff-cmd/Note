# เอาขึ้น VPS

คู่มือนี้ทำให้แอปเปิดได้ที่ `https://โดเมนของคุณ` ใช้ได้ทั้งมือถือและคอม ใครก็สมัครบัญชีของตัวเองได้ (ข้อมูลแยกกัน)
และแจ้งเตือนเด้งได้แม้ปิดแอป
โดยใช้ Docker รันตัวแอป และใช้ Caddy ทำ HTTPS ให้อัตโนมัติ

## สิ่งที่ต้องมี

- **VPS** Ubuntu 22.04 หรือ 24.04 สเปก 1 CPU / 1 GB RAM ก็พอ (เช่น DigitalOcean, Vultr, Linode, Hetzner)
- **โดเมน** ที่ชี้มาที่ IP ของ VPS จำเป็นต้องมี เพราะการแจ้งเตือนและการติดตั้งแอปบนมือถือต้องใช้ HTTPS
  - มีโดเมนอยู่แล้ว: เพิ่ม DNS record ชนิด `A` เช่น `notes.example.com` → IP ของ VPS
  - ไม่มีโดเมน: สมัครซับโดเมนฟรีที่ [duckdns.org](https://www.duckdns.org) แล้วใส่ IP ของ VPS

## ติดตั้งครั้งแรก

1. **เข้า VPS แล้วติดตั้ง Docker**
   ```sh
   ssh root@IP_ของ_VPS
   curl -fsSL https://get.docker.com | sh
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   ```

2. **ส่งไฟล์แอปขึ้นไป** (สั่งจาก Mac เครื่องนี้)
   ```sh
   rsync -av --exclude data.db --exclude uploads --exclude backups --exclude __pycache__ \
     ~/projeat2/ root@IP_ของ_VPS:/opt/notes/
   ```

3. **ตั้งค่า** (บน VPS)
   ```sh
   cd /opt/notes
   cp .env.example .env
   nano .env        # แก้ DOMAIN, PUBLIC_URL, PUSH_CONTACT และ SMTP_* (ถ้ามี)
   ```

4. **เปิดแอป**
   ```sh
   docker compose up -d --build
   docker compose logs -f     # ควรเห็น "แจ้งเตือนแบบ push: เปิดอยู่"  (Ctrl+C เพื่อออก)
   ```

5. เปิด `https://โดเมนของคุณ` → "สมัครสมาชิก" เพื่อสร้างบัญชีของคุณเอง

6. **ก่อนชวนคนอื่นมาใช้** ทำตามหัวข้อ "ก่อนเปิดให้คนอื่นใช้" ด้านล่าง

## ติดตั้งบนมือถือและเปิดแจ้งเตือน

- **iPhone (iOS 16.4 ขึ้นไป):** เปิดใน Safari → ปุ่มแชร์ → "เพิ่มไปยังหน้าจอโฮม" → เปิดแอปจากไอคอน →
  ตั้งค่า → เปิด "แจ้งเตือนบนเครื่องนี้" → อนุญาต
  ต้องเปิดจากไอคอนบนหน้าจอโฮมเท่านั้น ถ้าเปิดใน Safari ธรรมดา iPhone จะไม่ส่งการแจ้งเตือน
- **Android (Chrome):** เปิดเว็บ → เมนู ⋮ → "ติดตั้งแอป" → ตั้งค่า → เปิด "แจ้งเตือนบนเครื่องนี้"
- **คอมพิวเตอร์:** เปิดใน Chrome/Edge/Firefox → ตั้งค่า → เปิด "แจ้งเตือนบนเครื่องนี้"

กด "ทดสอบการแจ้งเตือน" ในหน้าตั้งค่าเพื่อดูว่ามีแจ้งเตือนเด้งขึ้นมาจริง

## ก่อนเปิดให้คนอื่นใช้

- [ ] **แก้ `static/privacy.html`:** เติมช่อง [ชื่อผู้ให้บริการ], [อีเมลติดต่อ] และ [ผู้ให้บริการ VPS] ให้ครบ
  (เป็นแม่แบบที่เขียนตามสิ่งที่แอปเก็บจริง แต่ควรให้ผู้รู้ด้าน PDPA ตรวจก่อน)
- [ ] **ตั้ง SMTP ใน `.env`:** เพื่อให้ปุ่ม "ลืมรหัสผ่าน" ใช้ได้ ถ้าไม่ตั้ง คนที่ลืมรหัสต้องติดต่อคุณให้รีเซ็ตให้ (ดู "จัดการบัญชี")
  แล้วทดสอบ: ออกจากระบบ → ลืมรหัสผ่าน → ต้องได้รับอีเมล
- [ ] **สำรองข้อมูลออกนอกเครื่อง:** ตั้งให้ดึงข้อมูลสำรองลงเครื่องอื่นเป็นประจำ (ดู "สำรองข้อมูล") เพราะตอนนี้เป็นข้อมูลของคนอื่นด้วย
- [ ] **ตัดสินใจเรื่องการรับสมัคร:** จะเปิดให้ใครก็สมัครได้ (`ALLOW_SIGNUP=1`) หรือปิดแล้วสร้างบัญชีให้เอง (`ALLOW_SIGNUP=0` + `--create-user`)
  ถ้าเปิด ระบบจำกัดการสมัครไว้ที่ 5 บัญชีต่อ IP ต่อชั่วโมง และไฟล์แนบ 200 MB ต่อบัญชี (แก้ได้ที่ `USER_QUOTA_MB`)
- [ ] **ดูพื้นที่ดิสก์เป็นระยะ:** ใช้ `df -h` และ `docker compose exec app python server.py --users`

## จัดการบัญชี

```sh
docker compose exec app python server.py --users                        # รายชื่อ จำนวนเรื่อง พื้นที่ที่ใช้
docker compose exec app python server.py --create-user someone@mail.com # สร้างบัญชีให้ (ใช้ได้แม้ปิดรับสมัคร)
docker compose exec app python server.py --reset-password someone@mail.com
docker compose exec app python server.py --delete-user someone@mail.com
```

ผู้ใช้ดาวน์โหลดข้อมูลของตัวเอง หรือลบบัญชีตัวเองได้จากหน้าตั้งค่า

## ย้ายข้อมูลจาก Mac ขึ้นไป (ถ้าต้องการ)

ข้อมูลใน `~/projeat2/data.db` บน Mac ตอนนี้อยู่ในบัญชี `owner@localhost` และมีข้อมูลตัวอย่างที่ใส่ไว้ตอนทดสอบด้วย
ถ้าไม่ต้องการก็ข้ามขั้นนี้ได้ แอปบน VPS จะเริ่มจากว่าง
ถ้าจะย้าย สั่งบน VPS หลังจากส่งไฟล์ `data.db` และโฟลเดอร์ `uploads` ขึ้นไปไว้ที่ `/opt/notes/import/`:

```sh
cd /opt/notes
docker compose stop app
docker compose cp import/data.db app:/data/data.db
docker compose cp import/uploads app:/data/
docker compose start app
docker compose exec app python server.py --reset-password owner@localhost
```

## อัปเดตแอปเมื่อแก้โค้ด

```sh
# จาก Mac
rsync -av --exclude data.db --exclude uploads --exclude backups --exclude __pycache__ --exclude .env \
  ~/projeat2/ root@IP_ของ_VPS:/opt/notes/
# บน VPS
cd /opt/notes && docker compose up -d --build
```

ถ้าเพิ่มหรือลบไฟล์ใน `static/` ให้เปลี่ยน `VERSION` ใน `static/sw.js` ด้วย มือถือจะได้โหลดไฟล์ชุดใหม่
ส่วนไฟล์ที่แก้เฉยๆ มือถือจะได้เวอร์ชันใหม่ตอนเปิดแอปรอบถัดไป

## สำรองข้อมูล

แอปสำรองให้อัตโนมัติตอนเริ่มและทุก 24 ชั่วโมง เก็บไว้ 14 ชุดล่าสุดใน volume ของ Docker
แต่ข้อมูลสำรองเหล่านี้อยู่บน VPS เครื่องเดียวกัน ถ้า VPS เสียก็หายไปด้วยกัน จึงควรดึงลงเครื่องตัวเองเป็นระยะ

```sh
docker compose exec app python backup.py            # สำรองตอนนี้
docker compose exec app python backup.py --list      # ดูรายการ
docker compose cp app:/data/backups ./backups        # คัดลอกออกมาที่ /opt/notes/backups
# แล้วดึงลง Mac:  rsync -av root@IP_ของ_VPS:/opt/notes/backups/ ~/notes-backups/
```

กู้คืน:
```sh
docker compose stop app
docker compose run --rm app python backup.py --restore 20261001-030000
docker compose start app
```

## แก้ปัญหา

| อาการ | ทางแก้ |
|---|---|
| เปิดเว็บไม่ได้ / ไม่มี HTTPS | เช็กว่าโดเมนชี้ IP ถูก (`ping โดเมน`) และเปิดพอร์ต 80/443 แล้ว ดู `docker compose logs caddy` |
| ผู้ใช้ลืมรหัสผ่าน (ไม่มี SMTP) | `docker compose exec app python server.py --reset-password อีเมล` |
| ส่งอีเมลรีเซ็ตไม่ออก | ดู `docker compose logs app` หา "ส่งอีเมลไม่สำเร็จ" แล้วตรวจค่า SMTP_* ใน `.env` แล้วรัน `docker compose up -d` |
| ไม่มีแจ้งเตือน | ดูว่าหน้าตั้งค่ามีสวิตช์ "แจ้งเตือนบนเครื่องนี้" และเปิดอยู่ กด "ทดสอบการแจ้งเตือน" แล้วเช็กว่าเครื่องไม่ได้อยู่ในโหมดห้ามรบกวน |
| เวลาแจ้งเตือนเพี้ยน | ดู "เขตเวลา" ในหน้าตั้งค่า แอปจะตั้งตามเครื่องที่เปิดล่าสุดให้เอง |
| ลองรหัสผิดหลายครั้งแล้วถูกล็อก | รอ 15 นาที |
