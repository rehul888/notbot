export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOT_TOKEN: string;
  NOTPANEL_API_KEY: string;
  TG_WEBHOOK_SECRET: string;
  /** Secret path segment for the one-time /setup/<secret> routes. Unset/empty = all /setup routes return 404. */
  SETUP_SECRET?: string;
  OWNER_IDS: string;
  /** Local development only: skip Telegram auth and act as this user id */
  DEV_FAKE_USER_ID?: string;
  /** Local development guard used by worker/orders.ts: allows placing real NotPanel orders */
  ALLOW_LIVE_ORDERS?: string;
}

export function isOwner(env: Env, userId: number): boolean {
  return env.OWNER_IDS.split(",").map((s) => s.trim()).filter(Boolean).includes(String(userId));
}
