-- White-label support: owner-uploaded logo and welcome banner. The image is stored as base64 text in `data`
-- (D1 hands BLOB columns to Workers as number arrays, which is too slow for the free plan's CPU budget).
CREATE TABLE IF NOT EXISTS assets (
  kind TEXT PRIMARY KEY CHECK (kind IN ('logo', 'banner')),
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- An install that was already connected before this version counts as set up, so the setup page stays closed.
INSERT OR IGNORE INTO settings (key, value)
SELECT 'setup_done', '1' WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'app_url' AND value != '');

-- Wrong-guess limits for the setup page and the admin claim (per sender, see worker/rateLimit.ts)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  win_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
