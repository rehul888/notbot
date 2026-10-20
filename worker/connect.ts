// Connecting the bot and NotPanel to this deployment: Telegram webhook, NotPanel webhook, menu button, bot texts.
// Shared by the setup page (routes/setup.ts), the admin panel and the legacy /setup/<secret> routes.
import { LANGS } from "../shared/types";
import { webhookSecret } from "./auth";
import { botAboutFor } from "./bot-about";
import { userCommands } from "./commands";
import { brandName } from "./brand";
import type { Env } from "./env";
import { botPlain } from "./i18n";
import { npCall } from "./notpanel";
import { getSettings, setSettings, type Settings } from "./settings";
import { tg } from "./telegram";

export const ALLOWED_UPDATES = ["message", "callback_query", "pre_checkout_query", "my_chat_member"];

/** Points Telegram at this deployment (secret from webhookSecret) */
export async function setTelegramWebhook(env: Env, origin: string): Promise<void> {
  await tg(env.BOT_TOKEN, "setWebhook", {
    url: `${origin}/bot`,
    secret_token: await webhookSecret(env),
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
}

/** NotPanel webhook for instant order updates (the cron job is the backup). Returns the settings to save, or the error text. */
export async function registerNotPanelWebhook(env: Env, s: Settings, origin: string): Promise<{ values?: Partial<Settings>; error?: string }> {
  try {
    if (s.np_webhook_id) await npCall(env, "webhook.remove", { id: s.np_webhook_id }).catch(() => undefined);
    const wh = await npCall<{ id: string; webhook_id?: string; secret: string }>(env, "webhook.add", {
      url: `${origin}/hooks/notpanel`,
      events: "order.processing,order.in_progress,order.completed,order.partial,order.canceled,refill.completed,refill.rejected",
    });
    return { values: { np_webhook_id: String(wh.id ?? wh.webhook_id), np_webhook_secret: wh.secret } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Mini App menu button; remembers the app URL and bot username. */
export async function setMenuButton(env: Env, origin: string): Promise<{ username: string; firstName: string; id: number }> {
  const me = await tg<{ id: number; username: string; first_name: string }>(env.BOT_TOKEN, "getMe");
  await tg(env.BOT_TOKEN, "setChatMenuButton", { menu_button: { type: "web_app", text: botPlain("en", "open"), web_app: { url: origin } } });
  await setSettings(env, { app_url: origin, bot_username: me.username });
  return { username: me.username, firstName: me.first_name, id: me.id };
}

export type TextParts = "all" | "texts" | "commands";

/**
 * Sets the command menu and the bot's name, "About" text and description for one batch of 10 languages (4 Telegram calls
 * each), staying under the free plan's 50 outgoing calls per request. Returns the next batch number, or null when done.
 * `parts` limits the work: "texts" skips the command menus, "commands" does only those.
 */
export async function syncBotTexts(env: Env, batch: number, parts: TextParts = "all"): Promise<number | null> {
  const s = await getSettings(env);
  const about = botAboutFor(brandName(s));
  const langs = LANGS.slice(batch * 10, batch * 10 + 10);
  for (const l of langs) {
    const lc = l === "en" ? {} : { language_code: l };
    if (parts !== "texts") await tg(env.BOT_TOKEN, "setMyCommands", { commands: userCommands(l), ...lc });
    if (parts !== "commands") {
      await tg(env.BOT_TOKEN, "setMyName", { name: about[l].name, ...lc });
      await tg(env.BOT_TOKEN, "setMyShortDescription", { short_description: about[l].short, ...lc });
      await tg(env.BOT_TOKEN, "setMyDescription", { description: about[l].description, ...lc });
    }
  }
  return (batch + 1) * 10 < LANGS.length ? batch + 1 : null;
}

/** Everything except the per-language texts (legacy /setup/<secret> and admin "Connect") */
export async function connectAll(env: Env, origin: string) {
  const s = await getSettings(env);
  const out: Record<string, unknown> = { appUrl: origin };
  await setTelegramWebhook(env, origin);
  const me = await setMenuButton(env, origin);
  out.bot = me.username;
  const wh = await registerNotPanelWebhook(env, s, origin);
  if (wh.values) await setSettings(env, wh.values);
  out.notpanelWebhook = wh.error ?? true;
  return out;
}
