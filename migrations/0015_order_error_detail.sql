-- NotPanel's own words when it refused an order (orders.error keeps the short code), and when an order NotPanel never
-- answered for was sent again with the same request_id (it is only resent once).
ALTER TABLE orders ADD COLUMN error_detail TEXT;
ALTER TABLE orders ADD COLUMN resent_at INTEGER;
