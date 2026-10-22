-- Installs that were already set up have their bot names in place: never rename them automatically
INSERT OR IGNORE INTO settings (key, value)
SELECT 'names_done', '1' WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'setup_done' AND value = '1');
