-- Indexes for the hot paths and cleanup jobs (all idempotent).
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_refill_id ON orders(refill_id) WHERE refill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_price_changes_service ON price_changes(service_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_created ON referrals(referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_fixed_rate ON services(id) WHERE fixed_rate IS NOT NULL;
