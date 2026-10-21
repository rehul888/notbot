-- Referrals whose channel membership couldn't be confirmed at the time are re-checked by the cron (worker/growth.ts)
ALTER TABLE referrals ADD COLUMN checked_at INTEGER;
CREATE INDEX IF NOT EXISTS referrals_pending ON referrals (status, checked_at);
