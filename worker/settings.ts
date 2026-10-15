import type { Env } from "./env";

export const DEFAULTS = {
  default_markup_pct: 30,
  stars_per_usd: 77, // ≈ break-even with Telegram's Stars payout rate; markup is the profit
  min_topup: 1_000_000,
  max_topup: 500_000_000,
  sync_enabled: 1,
  sync_every_hours: 6,
  auto_enable_new: 1,
  only_timed: 1, // list only services that have a measured average delivery time
  low_balance: 5_000_000,
  support_username: "",
  channel_username: "notpanel_com",
  terms_text:
    "By using this app you agree that services are delivered by third parties and delivery times are estimates. " +
    "Balance top-ups are paid in Telegram Stars and are credited to your in-app balance. Orders that cannot be " +
    "delivered are refunded to your balance automatically. For payment questions use /paysupport in the bot.",
  last_sync_at: 0,
  last_sync_summary: "",
  sync_state: "",
  last_catalog_at: "",
  catalog_version: 1,
  app_url: "",
  bot_username: "",
  np_webhook_id: "",
  np_webhook_secret: "",
};

export type Settings = typeof DEFAULTS;
export type SettingKey = keyof Settings;

let memo: { at: number; value: Settings } | null = null;
const MEMO_MS = 15_000;

/** Settings, cached per isolate for 15 s. Pass fresh for anything that coordinates work (the price sync). */
export async function getSettings(env: Env, opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const value = await loadSettings(env);
  memo = { at: Date.now(), value };
  return value;
}

async function loadSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const s: any = { ...DEFAULTS };
  for (const r of results) {
    if (!(r.key in DEFAULTS)) continue;
    s[r.key] = typeof (DEFAULTS as any)[r.key] === "number" ? Number(r.value) : r.value;
  }
  return s as Settings;
}

export function setSettingsStmts(env: Env, values: Partial<Settings>): D1PreparedStatement[] {
  memo = null;
  return Object.entries(values).map(([k, v]) =>
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
      k,
      String(v),
    ),
  );
}

export async function setSettings(env: Env, values: Partial<Settings>): Promise<void> {
  memo = null;
  const stmts = setSettingsStmts(env, values);
  if (stmts.length) await env.DB.batch(stmts);
}

export function bumpCatalogStmt(env: Env): D1PreparedStatement {
  memo = null;
  return env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('catalog_version', '2') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
  );
}
