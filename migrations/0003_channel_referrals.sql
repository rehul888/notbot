-- Update-channel gate and referral program.
ALTER TABLE users ADD COLUMN channel_ok INTEGER NOT NULL DEFAULT 0;      -- 0 not confirmed, 1 member (confirmed), 2 let through while Telegram could not answer
ALTER TABLE users ADD COLUMN channel_checked_at INTEGER;                -- last confirmed check (re-checked daily)
ALTER TABLE users ADD COLUMN home_at INTEGER;                           -- first time the user reached the home screen

-- One row per referred user (a user can only ever be referred once).
CREATE TABLE referrals (
  referred_id INTEGER PRIMARY KEY,
  referrer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | rewarded | capped
  reward INTEGER NOT NULL DEFAULT 0,        -- micro-USD paid to the referrer
  created_at INTEGER NOT NULL,
  rewarded_at INTEGER
);
CREATE INDEX referrals_referrer ON referrals (referrer_id, status, rewarded_at);
