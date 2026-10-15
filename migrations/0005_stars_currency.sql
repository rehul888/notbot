-- Users see and pay everything in whole Telegram Stars. Balances, ledger amounts, order charges/refunds,
-- payment credits and referral rewards switch from micro-USD to whole Stars (converted at the current rate,
-- rounded to the nearest Star). NotPanel costs (orders.cost) and admin USD settings stay in micro-USD.
-- orders.rate keeps the Stars-per-USD rate an order was sold at, so admin profit in USD stays exact later.

ALTER TABLE orders ADD COLUMN rate REAL;

UPDATE orders SET rate = COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77);

UPDATE users SET balance = CAST(ROUND(balance * COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77) / 1000000.0) AS INTEGER);
UPDATE ledger SET delta = CAST(ROUND(delta * COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77) / 1000000.0) AS INTEGER);
-- A paid order costs at least 1 Star; a refund is at least 1 Star and never more than the charge
UPDATE orders SET
  refund = CASE WHEN refund > 0 THEN MIN(MAX(1, CAST(ROUND(refund * rate / 1000000.0) AS INTEGER)), MAX(1, CAST(ROUND(charge * rate / 1000000.0) AS INTEGER))) ELSE 0 END,
  charge = CASE WHEN charge > 0 THEN MAX(1, CAST(ROUND(charge * rate / 1000000.0) AS INTEGER)) ELSE 0 END;
-- A top-up of N Stars credited N Stars
UPDATE payments SET amount = stars;
UPDATE referrals SET reward = CAST(ROUND(reward * COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'stars_per_usd'), 77) / 1000000.0) AS INTEGER);

-- Top-up limits are now whole Stars (old keys were micro-USD)
DELETE FROM settings WHERE key IN ('min_topup', 'max_topup');
