-- Money is stored and charged in micro-USD again (NotPanel bills in dollars). Telegram Stars are only how users see
-- amounts and how they pay: 1 Star paid credits 1/stars_per_usd dollars. Reverses 0005's conversion at the same rate.
-- orders.rate (Stars per $1 when the order was placed) stays for reference.

-- Balances and credits round up to the micro-dollar, so N Stars still show as N Stars (balances shown rounded down)
UPDATE users SET balance = CASE WHEN balance > 0 THEN (CAST((balance * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER) + ((balance * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) > CAST((balance * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER))) ELSE CAST(ROUND(balance * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER) END;
UPDATE ledger SET delta = CAST(ROUND(delta * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER);
UPDATE orders SET
  charge = CAST(ROUND(charge * 1000000.0 / COALESCE(rate, (SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER),
  refund = CAST(ROUND(refund * 1000000.0 / COALESCE(rate, (SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER);
-- What a payment credited: the dollar value of the Stars paid
UPDATE payments SET amount = (CAST((stars * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER) + ((stars * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) > CAST((stars * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER)));
UPDATE referrals SET reward = (CAST((reward * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER) + ((reward * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) > CAST((reward * 1000000.0 / COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77)) AS INTEGER)));

-- One Telegram Stars payment is at most 10,000 Stars
UPDATE settings SET value = '10000' WHERE key = 'max_topup_stars' AND CAST(value AS REAL) > 10000;
