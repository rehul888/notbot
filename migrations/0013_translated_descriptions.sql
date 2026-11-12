-- Service descriptions in the user's language (NotPanel translates them like names). Translated names are re-fetched
-- on the next view so their descriptions come along; the duplicate payments index from 0012 is dropped (0004 has one).
ALTER TABLE service_names ADD COLUMN description TEXT;
DELETE FROM service_names;
DROP INDEX IF EXISTS payments_order;
