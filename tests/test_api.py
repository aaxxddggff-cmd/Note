"""API and storage tests on a temporary database: python3 -m unittest discover -s tests -v"""

import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import date, datetime, timedelta
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import push  # noqa: E402
import server  # noqa: E402

TODAY = date.today()


def d(offset):
    return (TODAY + timedelta(days=offset)).isoformat()


PASSWORD = "correct horse"
EMAIL = "a@example.com"
OTHER = "b@example.com"


def post(base, path, body, cookie=None):
    headers = {"Content-Type": "application/json", "X-Requested-With": "fetch"}
    if cookie:
        headers["Cookie"] = cookie
    req = Request(base + path, data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with urlopen(req) as res:
            c = res.headers.get("Set-Cookie")
            return res.status, json.loads(res.read()), c.split(";")[0] if c else None
    except HTTPError as e:
        return e.code, json.loads(e.read()), None


def start(tmp, **kw):
    httpd = server.make_server("127.0.0.1", 0, os.path.join(tmp, "test.db"), os.path.join(tmp, "uploads"),
                               with_push=False, **kw)
    httpd.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def stop(httpd):
    httpd.shutdown()
    httpd.server_close()
    httpd.store.db.close()


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd, cls.base = start(cls.tmp.name)
        cls.store = cls.httpd.store
        status, body, cls.cookie = post(cls.base, "/api/auth/signup", {"email": EMAIL, "password": PASSWORD})
        assert status == 201, body
        cls.uid = body["user"]["id"]
        _, body, cls.other = post(cls.base, "/api/auth/signup", {"email": OTHER, "password": PASSWORD})
        cls.other_uid = body["user"]["id"]
        cls.httpd.RequestHandlerClass.signup_limit.clear("127.0.0.1")

    @classmethod
    def login(cls, email=EMAIL, password=PASSWORD):
        return post(cls.base, "/api/auth/login", {"email": email, "password": password})[2]

    @classmethod
    def tearDownClass(cls):
        stop(cls.httpd)
        cls.tmp.cleanup()

    def setUp(self):
        with self.store.lock:
            self.store.db.execute("DELETE FROM notes")
            self.store.db.execute("DELETE FROM user_settings")
            self.store.db.commit()

    def call(self, method, path, body=None, raw=None, headers=None, cookie=True):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        hdrs = {"X-Requested-With": "fetch", **({"Cookie": self.cookie} if cookie is True else {"Cookie": cookie} if cookie else {}),
                **(headers or {})}
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        req = Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urlopen(req) as res:
                ctype = res.headers.get("Content-Type", "")
                payload = res.read()
                return res.status, (json.loads(payload) if ctype.startswith("application/json") else payload)
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def add(self, **fields):
        status, note = self.call("POST", "/api/notes", {"title": "ประชุม", "date": d(0), **fields})
        self.assertEqual(status, 201, note)
        return note

    def cats(self):
        return {c["name"]: c for c in self.call("GET", "/api/categories")[1]}

    def occ(self, start, end):
        status, rows = self.call("GET", f"/api/occurrences?from={start}&to={end}")
        self.assertEqual(status, 200, rows)
        return rows

    # -- notes

    def test_create_defaults_and_detail(self):
        note = self.add()
        self.assertEqual((note["repeat"], note["nag"], note["time"], note["category_id"]), ("none", 0, None, None))
        self.assertEqual((note["checklist"], note["attachments"], note["completed"]), ([], [], []))

    def test_update_and_delete(self):
        cat = self.cats()["งาน"]["id"]
        note = self.add(time="09:30", remind_minutes=15)
        status, upd = self.call("PUT", f"/api/notes/{note['id']}", {"title": " ใหม่ ", "category_id": cat, "nag": True})
        self.assertEqual((status, upd["title"], upd["category_id"], upd["nag"], upd["time"]), (200, "ใหม่", cat, 1, "09:30"))
        self.assertEqual(self.call("DELETE", f"/api/notes/{note['id']}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/notes/{note['id']}")[0], 404)
        self.assertEqual(self.call("PUT", f"/api/notes/{note['id']}", {"title": "x"})[0], 404)

    def test_validation(self):
        bad = [
            {"date": d(0)},
            {"title": "   ", "date": d(0)},
            {"title": "x"},
            {"title": "x", "date": "2026-02-30"},
            {"title": "x", "date": d(0), "time": "25:00"},
            {"title": "x", "date": d(0), "category_id": 99999},
            {"title": "x", "date": d(0), "remind_minutes": -5},
            {"title": "x", "date": d(0), "remind_minutes": "15"},
            {"title": "x", "date": d(0), "repeat": "hourly"},
            {"title": "x", "date": d(5), "repeat": "day", "repeat_until": d(1)},
        ]
        for body in bad:
            with self.subTest(body=body):
                status, res = self.call("POST", "/api/notes", body)
                self.assertEqual(status, 400, res)
                self.assertIn("error", res)
        self.assertEqual(self.call("PUT", f"/api/notes/{self.add()['id']}", {})[0], 400)
        self.assertEqual(self.call("GET", f"/api/occurrences?from={d(0)}&to={d(500)}")[0], 400)

    # -- occurrences and repeats

    def test_occurrences_sorted_all_day_first(self):
        self.add(title="บ่าย", time="14:00")
        self.add(title="เช้า", time="08:00")
        self.add(title="ทั้งวัน")
        self.add(title="พรุ่งนี้", date=d(1))
        rows = self.occ(d(0), d(0))
        self.assertEqual([r["title"] for r in rows], ["ทั้งวัน", "เช้า", "บ่าย"])

    def test_repeat_rules(self):
        self.assertEqual(
            [x.isoformat() for x in server.occurrences(
                {"date": "2026-01-31", "repeat": "month", "repeat_until": None}, date(2026, 1, 1), date(2026, 4, 30))],
            ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
        self.assertEqual(
            [x.isoformat() for x in server.occurrences(
                {"date": "2024-02-29", "repeat": "year", "repeat_until": None}, date(2025, 1, 1), date(2028, 12, 31))],
            ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"])
        self.assertEqual(
            [x.isoformat() for x in server.occurrences(
                {"date": "2026-09-28", "repeat": "week", "repeat_until": "2026-10-20"}, date(2026, 10, 1), date(2026, 12, 31))],
            ["2026-10-05", "2026-10-12", "2026-10-19"])
        self.assertEqual(
            server.occurrences({"date": "2026-09-28", "repeat": "day", "repeat_until": None}, date(2026, 9, 1), date(2026, 9, 27)), [])

    def test_repeating_note_done_per_occurrence(self):
        note = self.add(repeat="day", date=d(-2))
        self.assertEqual(len(self.occ(d(-5), d(2))), 5)
        self.call("POST", f"/api/notes/{note['id']}/done", {"date": d(0), "done": True})
        rows = {r["occ"]: r["done"] for r in self.occ(d(-1), d(1))}
        self.assertEqual(rows, {d(-1): False, d(0): True, d(1): False})
        self.call("POST", f"/api/notes/{note['id']}/done", {"date": d(0), "done": False})
        self.assertFalse(self.occ(d(0), d(0))[0]["done"])

    def test_overdue_and_move_keeps_done(self):
        late = self.add(title="เลย", date=d(-3))
        finished = self.add(title="เสร็จ", date=d(-2))
        self.add(title="ซ้ำ", date=d(-10), repeat="week")
        self.call("POST", f"/api/notes/{finished['id']}/done", {"date": d(-2)})
        status, rows = self.call("GET", f"/api/overdue?today={d(0)}")
        self.assertEqual([r["title"] for r in rows], ["เลย"])
        self.call("PUT", f"/api/notes/{finished['id']}", {"date": d(3)})
        self.assertTrue(self.occ(d(3), d(3))[0]["done"])
        self.call("PUT", f"/api/notes/{late['id']}", {"date": d(0)})
        self.assertEqual(self.call("GET", f"/api/overdue?today={d(0)}")[1], [])

    def test_important(self):
        c = self.cats()
        self.add(title="สำคัญเลย", date=d(-1), category_id=c["สำคัญ"]["id"])
        self.add(title="ค่าไฟ", date=d(-40), repeat="month", category_id=c["สำคัญ"]["id"])
        self.add(title="งาน", category_id=c["งาน"]["id"])
        done = self.add(title="เสร็จแล้ว", category_id=c["สำคัญ"]["id"])
        self.call("POST", f"/api/notes/{done['id']}/done", {"date": d(0)})
        rows = self.call("GET", f"/api/important?today={d(0)}")[1]
        self.assertEqual(rows[0]["title"], "สำคัญเลย")
        self.assertEqual({r["title"] for r in rows}, {"สำคัญเลย", "ค่าไฟ"})
        self.assertGreaterEqual(next(r for r in rows if r["title"] == "ค่าไฟ")["occ"], d(0))

    # -- search

    def test_search(self):
        self.add(title="จ่ายค่าไฟ")
        self.add(title="นัดหมอ", detail="ค่ารักษา 100%")
        b = self.add(title="ของขวัญ")
        self.call("POST", f"/api/notes/{b['id']}/checklist", {"text": "ห่อค่าส่ง"})
        self.add(title="อื่นๆ")
        rows = self.call("GET", "/api/search?q=" + quote("ค่า"))[1]
        self.assertEqual({r["title"]: r["matched_in"] for r in rows},
                         {"จ่ายค่าไฟ": "title", "นัดหมอ": "detail", "ของขวัญ": "checklist"})
        rows = self.call("GET", "/api/search?q=" + quote("%"))[1]
        self.assertEqual([r["title"] for r in rows], ["นัดหมอ"])
        self.assertEqual(self.call("GET", "/api/search?q=")[1], [])

    # -- checklist and attachments

    def test_checklist(self):
        note = self.add()
        s, item = self.call("POST", f"/api/notes/{note['id']}/checklist", {"text": "ซื้อเค้ก"})
        self.assertEqual((s, item["done"]), (201, False))
        self.call("POST", f"/api/notes/{note['id']}/checklist", {"text": "ห่อของขวัญ"})
        self.call("PUT", f"/api/checklist/{item['id']}", {"done": True})
        o = self.occ(d(0), d(0))[0]
        self.assertEqual((o["checklist_total"], o["checklist_done"]), (2, 1))
        self.assertEqual(self.call("POST", f"/api/notes/{note['id']}/checklist", {"text": " "})[0], 400)
        self.assertEqual(self.call("DELETE", f"/api/checklist/{item['id']}")[0], 200)
        self.assertEqual(len(self.call("GET", f"/api/notes/{note['id']}")[1]["checklist"]), 1)

    def test_attachments(self):
        note = self.add()
        s, att = self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"\x89PNG fake",
                           headers={"Content-Type": "image/png", "X-Filename": quote("รูป เค้ก.png")})
        self.assertEqual((s, att["name"], att["mime"], att["size"]), (201, "รูป เค้ก.png", "image/png", 9))
        s, html = self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"<script>alert(1)</script>",
                            headers={"Content-Type": "text/html", "X-Filename": "x.html"})
        with urlopen(Request(self.base + f"/api/attachments/{att['id']}", headers={"Cookie": self.cookie})) as res:
            self.assertEqual((res.read(), res.headers["Content-Type"]), (b"\x89PNG fake", "image/png"))
        with urlopen(Request(self.base + f"/api/attachments/{html['id']}", headers={"Cookie": self.cookie})) as res:
            self.assertEqual(res.headers["Content-Type"], "application/octet-stream")
            self.assertTrue(res.headers["Content-Disposition"].startswith("attachment"))
        self.assertEqual(self.occ(d(0), d(0))[0]["attachments"], 2)
        stored = self.store.attachment(self.uid, att["id"])[1]
        self.assertTrue(os.path.exists(stored))
        self.call("DELETE", f"/api/notes/{note['id']}")
        self.assertFalse(os.path.exists(stored))
        self.assertEqual(self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"x",
                                   headers={"Content-Type": "text/plain"})[0], 404)

    # -- categories and settings

    def test_categories(self):
        c = self.cats()
        self.assertEqual(list(c), ["สำคัญ", "งาน", "ส่วนตัว", "บิล / ค่าใช้จ่าย"])
        self.assertEqual(c["สำคัญ"]["important"], 1)
        s, home = self.call("POST", "/api/categories", {"name": "บ้าน", "color": "#4F7D3A"})
        self.assertEqual((s, home["count"]), (201, 0))
        note = self.add(category_id=home["id"])
        self.assertEqual(self.cats()["บ้าน"]["count"], 1)
        self.assertEqual(self.call("PUT", f"/api/categories/{home['id']}", {"important": True})[1]["important"], 1)
        self.assertEqual(self.call("POST", "/api/categories", {"name": "x", "color": "green"})[0], 400)
        self.call("DELETE", f"/api/categories/{home['id']}")
        self.assertIsNone(self.call("GET", f"/api/notes/{note['id']}")[1]["category_id"])

    # -- accounts

    def test_login_required_and_logout(self):
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=None)[0], 401)
        with self.assertRaises(HTTPError) as ctx:
            urlopen(self.base + "/api/attachments/1")
        self.assertEqual(ctx.exception.code, 401)
        status = self.call("GET", "/api/auth/status", cookie=None)[1]
        self.assertEqual((status["authed"], status["user"], status["signup_open"]), (False, None, True))
        me = self.call("GET", "/api/auth/status")[1]
        self.assertEqual((me["authed"], me["user"]["email"]), (True, EMAIL))
        second = self.login()
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=second)[1]["user"]["email"], EMAIL)
        self.call("POST", "/api/auth/logout", {}, cookie=second)
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=second)[0], 401)
        self.assertEqual(self.call("GET", "/api/bootstrap")[0], 200)

    def test_signup_rules(self):
        limit = self.httpd.RequestHandlerClass.signup_limit
        self.assertEqual(post(self.base, "/api/auth/signup", {"email": "A@Example.com", "password": PASSWORD})[:2],
                         (400, {"error": "อีเมลนี้มีบัญชีอยู่แล้ว"}))
        self.assertEqual(post(self.base, "/api/auth/signup", {"email": "not-an-email", "password": PASSWORD})[0], 400)
        self.assertEqual(post(self.base, "/api/auth/signup", {"email": "c@example.com", "password": "short"})[0], 400)
        s, body, cookie = post(self.base, "/api/auth/signup", {"email": " C@Example.com ", "password": PASSWORD})
        self.assertEqual((s, body["user"]["email"]), (201, "c@example.com"))
        self.assertEqual(len(self.call("GET", "/api/categories", cookie=cookie)[1]), 4)  # own default categories
        self.assertIsNotNone(self.login("C@EXAMPLE.COM"))
        for _ in range(5):
            limit.fail("127.0.0.1")
        self.assertIn("หลายครั้ง", post(self.base, "/api/auth/signup", {"email": "d@example.com", "password": PASSWORD})[1]["error"])
        limit.clear("127.0.0.1")
        os.environ["ALLOW_SIGNUP"] = "0"
        try:
            self.assertEqual(post(self.base, "/api/auth/signup", {"email": "e@example.com", "password": PASSWORD})[0], 400)
            self.assertFalse(self.call("GET", "/api/auth/status", cookie=None)[1]["signup_open"])
        finally:
            del os.environ["ALLOW_SIGNUP"]

    def test_wrong_password_and_rate_limit(self):
        s, res, _ = post(self.base, "/api/auth/login", {"email": EMAIL, "password": "nope"})
        self.assertEqual((s, res["error"]), (400, "อีเมลหรือรหัสผ่านไม่ถูกต้อง"))
        s, res, _ = post(self.base, "/api/auth/login", {"email": "nobody@example.com", "password": PASSWORD})
        self.assertEqual((s, res["error"]), (400, "อีเมลหรือรหัสผ่านไม่ถูกต้อง"))
        limit = self.httpd.RequestHandlerClass.login_limit
        for _ in range(10):
            limit.fail("email:" + OTHER)
        s, res, _ = post(self.base, "/api/auth/login", {"email": OTHER, "password": PASSWORD})
        self.assertIn("หลายครั้ง", res["error"])
        limit.clear("email:" + OTHER)
        limit.clear("127.0.0.1")

    def test_writes_need_fetch_header(self):
        s, _ = self.call("POST", "/api/notes", {"title": "x", "date": d(0)}, headers={"X-Requested-With": ""})
        self.assertEqual(s, 403)

    def test_change_password_ends_other_sessions(self):
        second = self.login()
        self.assertEqual(self.call("POST", "/api/auth/password", {"current": "bad", "new": "new-password"})[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/password", {"current": PASSWORD, "new": "short"})[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/password", {"current": PASSWORD, "new": "new-password"})[0], 200)
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=second)[0], 401)
        self.assertEqual(self.call("GET", "/api/bootstrap")[0], 200)
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=self.other)[0], 200)  # other users untouched
        self.store.set_password(self.uid, PASSWORD)

    def test_users_cannot_see_each_other(self):
        mine = self.add(title="ของฉัน")
        cat = self.cats()["งาน"]["id"]
        s, item = self.call("POST", f"/api/notes/{mine['id']}/checklist", {"text": "ลับ"})
        s, att = self.call("POST", f"/api/notes/{mine['id']}/attachments", raw=b"secret",
                           headers={"Content-Type": "text/plain", "X-Filename": "a.txt"})
        o = self.other
        self.assertEqual(self.call("GET", f"/api/notes/{mine['id']}", cookie=o)[0], 404)
        self.assertEqual(self.call("PUT", f"/api/notes/{mine['id']}", {"title": "x"}, cookie=o)[0], 404)
        self.assertEqual(self.call("DELETE", f"/api/notes/{mine['id']}", cookie=o)[0], 404)
        self.assertEqual(self.call("POST", f"/api/notes/{mine['id']}/done", {"date": d(0)}, cookie=o)[0], 404)
        self.assertEqual(self.call("POST", f"/api/notes/{mine['id']}/checklist", {"text": "x"}, cookie=o)[0], 404)
        self.assertEqual(self.call("PUT", f"/api/checklist/{item['id']}", {"done": True}, cookie=o)[0], 404)
        self.assertEqual(self.call("DELETE", f"/api/checklist/{item['id']}", cookie=o)[0], 404)
        self.assertEqual(self.call("GET", f"/api/attachments/{att['id']}", cookie=o)[0], 404)
        self.assertEqual(self.call("DELETE", f"/api/attachments/{att['id']}", cookie=o)[0], 404)
        self.assertEqual(self.call("POST", f"/api/notes/{mine['id']}/snooze", {"date": d(0)}, cookie=o)[0], 404)
        self.assertEqual(self.call("PUT", f"/api/categories/{cat}", {"name": "x"}, cookie=o)[0], 404)
        self.assertEqual(self.call("DELETE", f"/api/categories/{cat}", cookie=o)[0], 404)
        self.assertEqual(self.call("POST", "/api/notes", {"title": "x", "date": d(0), "category_id": cat}, cookie=o)[0], 400)
        self.assertEqual(self.call("GET", f"/api/occurrences?from={d(-1)}&to={d(1)}", cookie=o)[1], [])
        self.assertEqual(self.call("GET", "/api/search?q=" + quote("ของ"), cookie=o)[1], [])
        self.assertEqual(self.call("GET", "/api/search?q=" + quote("ลับ"), cookie=o)[1], [])
        self.assertNotIn(cat, [c["id"] for c in self.call("GET", "/api/categories", cookie=o)[1]])
        self.call("PUT", "/api/settings", {"theme": "dark"}, cookie=o)
        self.assertEqual(self.call("GET", "/api/settings")[1]["theme"], "system")
        self.assertEqual(len(self.occ(d(0), d(0))), 1)

    def test_attachment_quota(self):
        note = self.add()
        old = server.USER_QUOTA
        server.USER_QUOTA = 10
        try:
            ok = self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"12345678", headers={"Content-Type": "text/plain"})
            full = self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"12345", headers={"Content-Type": "text/plain"})
        finally:
            server.USER_QUOTA = old
        self.assertEqual((ok[0], full[0]), (201, 400))
        self.assertIn("เต็ม", full[1]["error"])

    def test_export_and_delete_account(self):
        s, body, cookie = post(self.base, "/api/auth/signup", {"email": "gone@example.com", "password": PASSWORD})
        self.httpd.RequestHandlerClass.signup_limit.clear("127.0.0.1")
        uid = body["user"]["id"]
        note = self.call("POST", "/api/notes", {"title": "ส่งออก", "date": d(0)}, cookie=cookie)[1]
        self.call("POST", f"/api/notes/{note['id']}/checklist", {"text": "ย่อย"}, cookie=cookie)
        att = self.call("POST", f"/api/notes/{note['id']}/attachments", raw=b"x", cookie=cookie,
                        headers={"Content-Type": "text/plain", "X-Filename": "f.txt"})[1]
        path = self.store.attachment(uid, att["id"])[1]
        req = Request(self.base + "/api/account/export", headers={"Cookie": cookie})
        with urlopen(req) as res:
            self.assertTrue(res.headers["Content-Disposition"].startswith("attachment"))
            data = json.loads(res.read())
        self.assertEqual((data["account"]["email"], data["notes"][0]["title"], data["notes"][0]["checklist"][0]["text"]),
                         ("gone@example.com", "ส่งออก", "ย่อย"))
        self.assertEqual(self.call("POST", "/api/account/delete", {"password": "wrong"}, cookie=cookie)[0], 400)
        self.assertEqual(self.call("POST", "/api/account/delete", {"password": PASSWORD}, cookie=cookie)[0], 200)
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=cookie)[0], 401)
        self.assertIsNone(self.store.user_by_email("gone@example.com"))
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM notes WHERE user_id = ?", (uid,)).fetchone()[0], 0)

    def test_forgot_and_reset_password(self):
        self.assertEqual(post(self.base, "/api/auth/forgot", {"email": EMAIL})[0], 400)  # no SMTP set up
        sent = []
        orig = server.send_mail
        server.send_mail = lambda to, subject, text: sent.append((to, text))
        os.environ.update(SMTP_HOST="smtp.example.com", SMTP_FROM="app@example.com", PUBLIC_URL="https://notes.example.com")
        try:
            self.assertTrue(self.call("GET", "/api/auth/status", cookie=None)[1]["reset_available"])
            self.assertEqual(post(self.base, "/api/auth/forgot", {"email": "nobody@example.com"})[:2], (200, {"ok": True}))
            self.assertEqual(post(self.base, "/api/auth/forgot", {"email": OTHER})[:2], (200, {"ok": True}))
            for _ in range(50):
                if sent:
                    break
                threading.Event().wait(0.05)
        finally:
            server.send_mail = orig
            for k in ("SMTP_HOST", "SMTP_FROM", "PUBLIC_URL"):
                del os.environ[k]
            self.httpd.RequestHandlerClass.reset_limit.clear("127.0.0.1")
        self.assertEqual(len(sent), 1)
        to, text = sent[0]
        token = re.search(r"https://notes\.example\.com/#/reset\?token=(\S+)", text).group(1)
        self.assertEqual(to, OTHER)
        self.assertEqual(post(self.base, "/api/auth/reset", {"token": "bad", "password": "brand-new-pw"})[0], 400)
        s, body, cookie = post(self.base, "/api/auth/reset", {"token": token, "password": "brand-new-pw"})
        self.assertEqual((s, body["user"]["email"]), (200, OTHER))
        self.assertEqual(self.call("GET", "/api/bootstrap", cookie=self.other)[0], 401)  # old sessions ended
        self.assertEqual(post(self.base, "/api/auth/reset", {"token": token, "password": "again-new-pw"})[0], 400)
        type(self).other = cookie
        self.store.set_password(self.other_uid, PASSWORD)

    def test_push_endpoints_without_pywebpush(self):
        self.assertEqual(self.call("GET", "/api/push/config")[1], {"enabled": False, "public_key": None, "devices": 0})
        self.assertEqual(self.call("POST", "/api/push/subscribe", {"endpoint": "https://x", "keys": {"p256dh": "a", "auth": "b"}})[0], 400)
        note = self.add(time="10:00", remind_minutes=10)
        self.assertEqual(self.call("POST", f"/api/notes/{note['id']}/snooze", {"date": d(0)})[0], 200)
        self.assertIsNotNone(self.store.reminder_log()[(note["id"], d(0))]["snooze_until"])

    def test_settings(self):
        s = self.call("GET", "/api/settings")[1]
        self.assertEqual(s, server.DEFAULT_SETTINGS)
        s = self.call("PUT", "/api/settings", {"theme": "dark", "week_start": 0, "default_remind": None})[1]
        self.assertEqual((s["theme"], s["week_start"], s["default_remind"], s["buddhist_year"]), ("dark", 0, None, True))
        self.assertEqual(self.call("PUT", "/api/settings", {"theme": "blue"})[0], 400)
        self.assertEqual(self.call("PUT", "/api/settings", {"nope": 1})[0], 400)
        boot = self.call("GET", "/api/bootstrap")[1]
        self.assertEqual(boot["settings"]["theme"], "dark")

    def test_static_files(self):
        for path in ("/", "/js/main.js", "/style.css", "/manifest.json", "/sw.js"):
            with urlopen(self.base + path) as res:
                self.assertEqual(res.status, 200, path)


class ReminderRuleTest(unittest.TestCase):
    TZ = push.tz_of("Asia/Bangkok")

    def occ(self, **kw):
        o = {"id": 1, "occ": "2026-10-02", "time": "10:00", "remind_minutes": 30, "nag": 0, "done": False,
             "title": "t", "repeat": "none", "checklist_total": 0, "checklist_done": 0}
        o.update(kw)
        return o

    def at(self, hhmm, day="2026-10-02"):
        h, m = map(int, hhmm.split(":"))
        return datetime(*map(int, day.split("-")), h, m, tzinfo=self.TZ).timestamp()

    def due(self, o, now, log=None):
        return [x["id"] for x in push.due_reminders([o], log or {}, now, self.TZ)]

    def test_fires_from_reminder_time_until_an_hour_after(self):
        o = self.occ()
        self.assertEqual(self.due(o, self.at("09:29")), [])
        self.assertEqual(self.due(o, self.at("09:30")), [1])
        self.assertEqual(self.due(o, self.at("10:59")), [1])
        self.assertEqual(self.due(o, self.at("11:01")), [])
        self.assertEqual(self.due(self.occ(done=True), self.at("09:45")), [])

    def test_all_day_uses_nine_oclock(self):
        o = self.occ(time=None, remind_minutes=1440)
        self.assertEqual(self.due(o, self.at("08:59", "2026-10-01")), [])
        self.assertEqual(self.due(o, self.at("09:00", "2026-10-01")), [1])

    def test_sent_once_then_nag_hourly_and_snooze(self):
        sent = self.at("09:30")
        log = {(1, "2026-10-02"): {"signature": "10:00|30", "first_at": sent, "last_at": sent, "snooze_until": None}}
        self.assertEqual(self.due(self.occ(), self.at("09:45"), log), [])
        self.assertEqual(self.due(self.occ(nag=1), self.at("10:00"), log), [])
        self.assertEqual(self.due(self.occ(nag=1), self.at("10:30"), log), [1])
        self.assertEqual(self.due(self.occ(time="11:00"), self.at("10:31"), log), [1])  # time changed: re-armed
        log[(1, "2026-10-02")]["snooze_until"] = self.at("10:45")
        self.assertEqual(self.due(self.occ(), self.at("10:40"), log), [])
        self.assertEqual(self.due(self.occ(), self.at("10:45"), log), [1])

    def test_payload(self):
        p = push.reminder_payload(self.occ(checklist_total=3, checklist_done=1, repeat="year"), date(2026, 10, 1))
        self.assertEqual(p["title"], "พรุ่งนี้: t")
        self.assertEqual(p["body"], "พรุ่งนี้ 10:00 น. · ทุกปี · เช็กลิสต์เหลือ 2 ข้อ")
        self.assertEqual(p["url"], "/#/note/1?date=2026-10-02")


class MigrationTest(unittest.TestCase):
    def test_version1_database_becomes_the_owner_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.db")
            db = sqlite3.connect(path)
            db.executescript("""
                CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
                  date TEXT NOT NULL, time TEXT, priority TEXT NOT NULL DEFAULT 'normal', color TEXT NOT NULL DEFAULT '',
                  done INTEGER NOT NULL DEFAULT 0, remind_minutes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX idx_notes_date ON notes (date, time);
                INSERT INTO notes (title, date, time, priority, done, remind_minutes, created_at, updated_at)
                  VALUES ('เก่า', '2026-09-28', '10:00', 'high', 1, 15, 'x', 'x'), ('ปกติ', '2026-09-29', NULL, 'normal', 0, NULL, 'x', 'x');
            """)
            db.commit()
            db.close()
            store = server.Store(path, os.path.join(tmp, "up"))
            owner = store.user_by_email("owner@localhost")["id"]
            old = store.note(owner, 1)
            self.assertEqual((old["title"], old["time"], old["remind_minutes"], old["completed"]), ("เก่า", "10:00", 15, ["2026-09-28"]))
            self.assertEqual([c["name"] for c in store.categories(owner) if c["id"] == old["category_id"]], ["สำคัญ"])
            self.assertIsNone(store.note(owner, 2)["category_id"])
            indexes = [r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'")]
            self.assertIn("idx_notes_user_date", indexes)
            store.db.close()

    def test_version3_single_user_keeps_its_password(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "v3.db")
            db = sqlite3.connect(path)
            db.executescript("""
                CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL,
                  important INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
                  date TEXT NOT NULL, time TEXT, category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
                  remind_minutes INTEGER, nag INTEGER NOT NULL DEFAULT 0, repeat TEXT NOT NULL DEFAULT 'none',
                  repeat_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX idx_notes_date ON notes (date);
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '');
                CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
                  user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
                INSERT INTO categories (name, color, important) VALUES ('งาน', '#2563EB', 0);
                INSERT INTO notes (title, date, category_id, created_at, updated_at) VALUES ('เดิม', '2026-09-28', 1, 'x', 'x');
                INSERT INTO settings VALUES ('theme', '"dark"');
                INSERT INTO push_subscriptions VALUES ('https://push.example/1', 'k', 'a', '', 'x');
                PRAGMA user_version = 3;
            """)
            db.execute("INSERT INTO meta VALUES ('password', ?)", (server.hash_password("old-password"),))
            db.commit()
            db.close()
            os.environ["OWNER_EMAIL"] = "Me@Example.com"
            try:
                store = server.Store(path, os.path.join(tmp, "up"))
            finally:
                del os.environ["OWNER_EMAIL"]
            self.assertEqual(store.check_login("me@example.com", "old-password"), 1)
            self.assertEqual(store.note(1, 1)["title"], "เดิม")
            self.assertEqual([c["name"] for c in store.categories(1)], ["งาน"])
            self.assertEqual(store.settings(1)["theme"], "dark")
            self.assertEqual(store.push_users(), [1])
            self.assertIsNone(store.meta("password"))
            store.db.close()


if __name__ == "__main__":
    unittest.main()
