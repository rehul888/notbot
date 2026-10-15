-- Order updates in chat are on by default; users can turn them off in the app.
UPDATE users SET notify = 1 WHERE notify = 0;
