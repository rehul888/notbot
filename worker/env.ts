import type { Settings } from "./settings";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Telegram bot token from @BotFather. The only credential the setup page asks to see again. */
  BOT_TOKEN: string;
  /** NotPanel API key. Optional: it can also be pasted in the setup page / admin panel (saved in settings). */
  NOTPANEL_API_KEY?: string;
  /** Overrides the webhook secret derived from BOT_TOKEN (keeps an already registered webhook working). */
  TG_WEBHOOK_SECRET?: string;
  /** Secret path segment for the legacy /setup/<secret> routes. Unset/empty = all /setup routes return 404. */
  SETUP_SECRET?: string;
  /** Optional comma-separated Telegram user IDs that are always admins (more can be claimed or added in the app). */
  OWNER_IDS?: string;
  /** Local development only: skip Telegram auth and act as this user id */
  DEV_FAKE_USER_ID?: string;
  /** Local development guard used by worker/orders.ts: allows placing real NotPanel orders */
  ALLOW_LIVE_ORDERS?: string;
}

/** "1, 2,x,3" → [1, 2, 3] (positive safe integers only) */
export function parseIds(v: string | undefined | null): number[] {
  const out: number[] = [];
  for (const part of (v ?? "").split(",")) {
    const n = Number(part.trim());
    if (part.trim() && Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Admins fixed by the OWNER_IDS environment variable (read-only in the app) */
export const envOwners = (env: Env): number[] => parseIds(env.OWNER_IDS);
/** Admins claimed or added in the app (settings.owner_ids) */
export const addedOwners = (s: Pick<Settings, "owner_ids">): number[] => parseIds(s.owner_ids);
/** Everyone who can open the Admin panel */
export const ownerIds = (env: Env, s: Pick<Settings, "owner_ids">): number[] => [...new Set([...envOwners(env), ...addedOwners(s)])];

export function isOwner(env: Env, s: Pick<Settings, "owner_ids">, userId: number): boolean {
  return ownerIds(env, s).includes(userId);
}
