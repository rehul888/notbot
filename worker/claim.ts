// First-admin claim: a one-time code (stored only as a SHA-256 hash, valid for an hour) that turns whoever sends it
// to the bot into an admin. Used when nobody is an admin yet (a fresh deploy that left OWNER_IDS empty).
import { randomCode, sha256Hex, timingSafeEqual } from "./auth";
import { addedOwners, type Env, ownerIds } from "./env";
import { isLimited, recordFailure } from "./rateLimit";
import { bustSettings, getSettings, type Settings } from "./settings";

export const CLAIM_TTL_SEC = 3600;
export const CLAIM_MAX_FAILURES = 10; // wrong codes per Telegram account per hour
const CODE_RE = /^[a-z2-9_]{16,40}$/;

export const hashClaimCode = (code: string): Promise<string> => sha256Hex(code);
export const claimCodeShape = (code: unknown): code is string => typeof code === "string" && CODE_RE.test(code);

/** A code is only usable while one is stored, it has not expired, and nobody is an admin yet */
export function claimOpen(s: Pick<Settings, "claim_code_hash" | "claim_expires">, anyOwner: boolean, now = Math.floor(Date.now() / 1000)): boolean {
  return !!s.claim_code_hash && s.claim_expires > now && !anyOwner;
}

/** Makes a fresh code (replacing any earlier one). The plain code is returned once and never stored. */
export async function createClaimCode(env: Env, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const code = randomCode(20);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('claim_code_hash', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(await hashClaimCode(code)),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('claim_expires', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now + CLAIM_TTL_SEC)),
  ]);
  bustSettings();
  return code;
}

export const claimLink = (botUsername: string, code: string) => `https://t.me/${botUsername}?start=claim_${code}`;

/**
 * Tries a code sent by a Telegram user. Returns true only if it was right (the user is now an admin and the code is
 * gone). Wrong, expired or missing codes all look the same to the caller. Wrong guesses are limited per Telegram
 * account, so other people's guesses can never block the owner's correct code (a 100-bit code can't be guessed anyway).
 */
export async function tryClaim(env: Env, userId: number, raw: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const s = await getSettings(env, { fresh: true });
  if (!claimOpen(s, ownerIds(env, s).length > 0, now)) return false;
  const code = raw.trim().toLowerCase();
  const limitKey = `claim:u:${userId}`;
  if (await isLimited(env, limitKey, CLAIM_MAX_FAILURES, 3600, now)) return false;
  const hash = claimCodeShape(code) ? await hashClaimCode(code) : "";
  if (!hash || !timingSafeEqual(hash, s.claim_code_hash)) {
    await recordFailure(env, limitKey, 3600, now);
    return false;
  }
  const owners = [...new Set([...addedOwners(s), userId])].join(",");
  // The code is spent and the admin added in one batch; only the request that really consumed the code adds the admin
  const [spent] = await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'claim_code_hash' AND value = ?1").bind(hash),
    env.DB.prepare(
      "INSERT INTO settings (key, value) SELECT 'owner_ids', ?1 WHERE changes() = 1 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(owners),
    env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'claim_expires' AND changes() = 1"),
  ]);
  bustSettings();
  return spent.meta.changes === 1;
}
