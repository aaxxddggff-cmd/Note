-- Schema version 4 (PRAGMA user_version = 4): many users, each with their own data.
-- server.py upgrades older databases (their data becomes the first user's).

CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password       TEXT    NOT NULL,                 -- pbkdf2_sha256$rounds$salt$hash
    created_at     TEXT    NOT NULL,
    last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL,                     -- #rrggbb
    important  INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),  -- listed under "สำคัญ"
    sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories (user_id);

CREATE TABLE IF NOT EXISTS notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    detail          TEXT    NOT NULL DEFAULT '',
    date            TEXT    NOT NULL,              -- YYYY-MM-DD, first occurrence
    time            TEXT,                          -- HH:MM, NULL = all day
    category_id     INTEGER REFERENCES categories (id) ON DELETE SET NULL,
    remind_minutes  INTEGER,                       -- minutes before, NULL = no reminder
    nag             INTEGER NOT NULL DEFAULT 0 CHECK (nag IN (0, 1)),  -- repeat reminder hourly until done
    repeat          TEXT    NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'day', 'week', 'month', 'year')),
    repeat_until    TEXT,                          -- YYYY-MM-DD, NULL = forever
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    user_id         INTEGER REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notes_user_date ON notes (user_id, date);

-- One row per finished occurrence (a non-repeating note has a single occurrence on its date).
CREATE TABLE IF NOT EXISTS completions (
    note_id  INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    date     TEXT    NOT NULL,
    PRIMARY KEY (note_id, date)
);

CREATE TABLE IF NOT EXISTS checklist (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id  INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    text     TEXT    NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    sort     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checklist_note ON checklist (note_id);

CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,                 -- original file name
    stored      TEXT    NOT NULL,                 -- file name inside uploads/
    mime        TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments (note_id);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key      TEXT    NOT NULL,
    value    TEXT    NOT NULL,                    -- JSON
    PRIMARY KEY (user_id, key)
);

-- Internal values: last morning summary per user, …
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT    PRIMARY KEY,             -- sha256 of the cookie value
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    user_agent  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT    PRIMARY KEY,
    p256dh      TEXT    NOT NULL,
    auth        TEXT    NOT NULL,
    user_agent  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    user_id     INTEGER REFERENCES users (id) ON DELETE CASCADE
);

-- Reminders sent by the server, per note occurrence.
CREATE TABLE IF NOT EXISTS reminder_log (
    note_id       INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    date          TEXT    NOT NULL,
    signature     TEXT    NOT NULL,             -- time|remind_minutes when sent; a change re-arms the reminder
    first_at      REAL    NOT NULL,             -- unix seconds
    last_at       REAL    NOT NULL,
    snooze_until  REAL,
    PRIMARY KEY (note_id, date)
);
