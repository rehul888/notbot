import { DEFAULT_PRESET } from "../shared/brand";
import { brandName, parseButtonIcons, parseEmojiMap } from "./brand";
import type { Env } from "./env";
import { setBotBrand } from "./i18n";
import { setCustomization } from "./telegram";

export const DEFAULTS = {
  default_markup_pct: 30,
  stars_per_usd: 77, // ≈ break-even with Telegram's Stars payout rate; markup is the profit
  // Top-up limits in whole Stars (users see and pay in Stars; the balance is credited their dollar value)
  min_topup_stars: 50,
  max_topup_stars: 10_000,
  sync_enabled: 1,
  sync_every_hours: 6,
  auto_enable_new: 1,
  only_timed: 1, // list only services that have a measured average delivery time
  low_balance: 5_000_000,
  support_username: "",
  // Update channel: users must join it before using the app (bot must be an admin there). Off until a channel is set.
  channel_url: "",
  channel_id: "",
  channel_gate: 1, // inactive while channel_id is empty
  // Referrals: reward the referrer this many Stars' worth of balance when a new user joins the channel and reaches home
  referral_enabled: 1,
  referral_reward_stars: 3,
  referral_daily_cap: 50,
  terms_text:
    "By using this app you agree that services are delivered by third parties and delivery times are estimates. " +
    "Balance top-ups are paid in Telegram Stars and are credited to your in-app balance. Orders that cannot be " +
    "delivered are refunded to your balance automatically.",
  last_sync_at: 0,
  last_sync_summary: "",
  sync_state: "",
  last_catalog_at: "",
  catalog_version: 1,
  app_url: "",
  welcome_photo: "", // "<banner url>|<telegram file_id>"
  bot_username: "",
  np_webhook_id: "",
  np_webhook_secret: "",
  // ---- White-label / open-source settings ----
  brand_name: "", // "" = the bot's first name, saved by setup
  brand_preset: DEFAULT_PRESET,
  brand_accent: "#2457ff", // used when brand_preset is "custom"
  website_url: "",
  terms_url: "", // "" = the in-app terms text
  welcome_text: "", // "" = the built-in translated welcome; {name} and {brand} are replaced
  custom_emoji: "{}", // JSON map: plain emoji -> Telegram custom emoji id (needs the bot owner's Premium)
  button_icons: '{"open":"","viewOrder":"","terms":"","invite":""}', // JSON ButtonIcons
  owner_ids: "", // admins claimed or added in the app (env OWNER_IDS also counts)
  claim_code_hash: "", // SHA-256 of the one-time admin claim code
  claim_expires: 0,
  np_api_key: "", // NotPanel key saved via setup/admin (env NOTPANEL_API_KEY is the fallback)
  logo_ver: 0, // > 0: a logo exists (value busts caches); negative: removed
  banner_ver: 0,
  setup_done: 0,
  commands_key: "", // what the command menus were last set for (see worker/commands.ts)
  commands_step: 0,
  broadcast_state: "", // running admin broadcast (worker/broadcast.ts), "" when none
  alerts_sent: "{}", // last time each admin alert kind was sent (worker/alerts.ts)
  commands_wait_until: 0, // Telegram rate limit: resume menu/profile updates after this time
  commands_admins: "", // admin chats that got the admin menu
  setup_steps: "", // comma list of setup steps that finished
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
  applyBranding(value);
  return value;
}

let applied = "";
/** Pushes the brand name and the owner's Premium emoji/icons to the modules that format bot messages (only when changed). */
function applyBranding(s: Settings): void {
  const sig = `${s.brand_name}\u0000${s.custom_emoji}\u0000${s.button_icons}`;
  if (sig === applied) return;
  applied = sig;
  setBotBrand(brandName(s));
  setCustomization(parseEmojiMap(s.custom_emoji), parseButtonIcons(s.button_icons));
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

/** Call after writing settings rows directly (not through setSettings*), so the next read is fresh. */
export function bustSettings(): void {
  memo = null;
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
