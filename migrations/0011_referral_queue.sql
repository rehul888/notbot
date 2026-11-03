-- The referral re-check (worker/growth.ts retryReferrals) now reads only queued referrals: a pending referral is queued
-- when checked_at is set. Queue the ones whose friend already reached the home screen but was never re-checked.
UPDATE referrals SET checked_at = 0 WHERE status = 'pending' AND checked_at IS NULL
  AND referred_id IN (SELECT id FROM users WHERE home_at IS NOT NULL);
