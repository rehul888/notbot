-- NotPanel's cancel request state ('requested' / 'refused') and when the next refill becomes possible (unix seconds)
ALTER TABLE orders ADD COLUMN cancel_state TEXT;
ALTER TABLE orders ADD COLUMN refill_at INTEGER;
