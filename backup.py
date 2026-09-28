"""Backups of the database, attachments and push key.

    python3 backup.py                    # make one now
    python3 backup.py --list
    python3 backup.py --restore <name>   # stop the server first

The server also makes one at start-up and every 24 hours, keeping the newest 14.
Backups live in DATA_DIR/backups/<YYYYmmdd-HHMMSS>/.
"""

import argparse
import os
import shutil
import sqlite3
import sys
import threading
import time
from datetime import datetime

KEEP = 14


def data_dir():
    return os.environ.get("DATA_DIR") or os.path.dirname(os.path.abspath(__file__))


def backups_dir(base):
    return os.path.join(base, "backups")


def make_backup(base=None, keep=KEEP):
    base = base or data_dir()
    db_path = os.path.join(base, "data.db")
    if not os.path.exists(db_path):
        return None
    target = os.path.join(backups_dir(base), datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(target, exist_ok=True)
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(os.path.join(target, "data.db"))
    with dst:
        src.backup(dst)  # consistent copy even while the server is writing
    src.close()
    dst.close()
    uploads = os.path.join(base, "uploads")
    if os.path.isdir(uploads):
        shutil.copytree(uploads, os.path.join(target, "uploads"))
    key = os.path.join(base, "vapid_private.pem")
    if os.path.exists(key):
        shutil.copy2(key, target)
    for old in list_backups(base)[keep:]:
        shutil.rmtree(os.path.join(backups_dir(base), old), ignore_errors=True)
    return target


def list_backups(base=None):
    root = backups_dir(base or data_dir())
    if not os.path.isdir(root):
        return []
    return sorted((d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))), reverse=True)


def restore(name, base=None):
    base = base or data_dir()
    src = os.path.join(backups_dir(base), os.path.basename(name))
    if not os.path.isdir(src):
        sys.exit(f"ไม่พบข้อมูลสำรอง {name}")
    make_backup(base, keep=KEEP + 1)  # keep the current state too, just in case
    shutil.copy2(os.path.join(src, "data.db"), os.path.join(base, "data.db"))
    uploads = os.path.join(base, "uploads")
    shutil.rmtree(uploads, ignore_errors=True)
    if os.path.isdir(os.path.join(src, "uploads")):
        shutil.copytree(os.path.join(src, "uploads"), uploads)
    if os.path.exists(os.path.join(src, "vapid_private.pem")):
        shutil.copy2(os.path.join(src, "vapid_private.pem"), base)
    print(f"กู้คืนจาก {name} แล้ว")


def start_daily(base=None):
    def loop():
        while True:
            try:
                path = make_backup(base)
                if path:
                    print(f"สำรองข้อมูลแล้ว: {path}")
            except Exception as e:
                print(f"สำรองข้อมูลไม่สำเร็จ: {e}")
            time.sleep(24 * 3600)

    threading.Thread(target=loop, daemon=True, name="backup").start()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--restore", metavar="NAME")
    args = parser.parse_args()
    if args.list:
        names = list_backups()
        print("\n".join(names) if names else "ยังไม่มีข้อมูลสำรอง")
    elif args.restore:
        restore(args.restore)
    else:
        path = make_backup()
        print(f"สำรองข้อมูลแล้ว: {path}" if path else "ยังไม่มีฐานข้อมูล")


if __name__ == "__main__":
    main()
