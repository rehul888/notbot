-- Admin order list and order refunds look up the Stars payment that bought an order (worker/routes/admin.ts)
CREATE INDEX IF NOT EXISTS payments_order ON payments (order_id) WHERE order_id IS NOT NULL;
