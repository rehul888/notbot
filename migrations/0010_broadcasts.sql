-- Admin broadcast menu (worker/broadcast.ts): one draft per admin, and the last finished or stopped broadcasts
CREATE TABLE IF NOT EXISTS broadcast_drafts (
  admin_id INTEGER PRIMARY KEY,
  draft TEXT,
  v INTEGER NOT NULL DEFAULT 1,
  awaiting TEXT,
  awaiting_until INTEGER NOT NULL DEFAULT 0,
  card INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  by_admin INTEGER NOT NULL
);
