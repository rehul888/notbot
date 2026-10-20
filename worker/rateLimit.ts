// Fixed-window limits on WRONG guesses for the rarely used public endpoints (setup unlock, admin claim), kept in the
// `rate_limits` table. Only failures count and a correct secret is never refused, so nobody can lock the real owner out
// by sending wrong guesses; the limits just stop one sender from hammering the Worker and the database.
import type { Env } from "./env";

/** True when `key` already has `max` failures in the current window (read only: a limited sender causes no writes). */
export async function isLimited(env: Env, key: string, max: number, windowSec: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const row = await env.DB.prepare("SELECT win_start, attempts FROM rate_limits WHERE key = ?1").bind(key).first<{ win_start: number; attempts: number }>();
  return !!row && row.win_start > now - windowSec && row.attempts >= max;
}

/** Counts one failure for `key` (a new window starts when the old one ended). */
export async function recordFailure(env: Env, key: string, windowSec: number, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, win_start, attempts) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE WHEN win_start <= ?2 - ?3 THEN 1 ELSE attempts + 1 END,
       win_start = CASE WHEN win_start <= ?2 - ?3 THEN ?2 ELSE win_start END`,
  )
    .bind(key, now, windowSec)
    .run();
}

/** Hourly cleanup of ended windows */
export async function cleanupRateLimits(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE win_start < ?1").bind(now - 86400).run();
}
