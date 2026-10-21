// Connecting the bot and NotPanel to this deployment: Telegram webhook, NotPanel webhook, menu button, bot texts.
// Shared by the setup page (routes/setup.ts), the admin panel and the legacy /setup/<secret> routes.
import { LANGS } from "../shared/types";
import { webhookSecret } from "./auth";
import { ABOUT_LANGS, botAboutAll } from "./bot-about";
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

/** Telegram asked us to slow down (429): try again after this many seconds */
export class TelegramRetryLater extends Error {
  constructor(public seconds: number) {
    super(`Telegram rate limit, retry after ${seconds}s`);
  }
}

export function retryAfterSeconds(message: string): number | null {
  const m = /\b429\b.*?retry after (\d+)/i.exec(message);
  return m ? Number(m[1]) : null;
}

const BATCH = 10;
export const PROFILE_BATCHES = Math.ceil(ABOUT_LANGS.length / BATCH);

/**
 * The bot's short description and description (and its name, only when `names` is set) for one batch of 10 profile
 * languages (up to 3 Telegram calls each).
 * A language Telegram refuses is skipped; a rate limit stops the batch with TelegramRetryLater. Returns the next batch,
 * or null when done.
 */
export async function setProfileTexts(env: Env, batch: number, opts: { names?: boolean } = {}): Promise<number | null> {
  const about = botAboutAll(brandName(await getSettings(env)));
  for (const l of ABOUT_LANGS.slice(batch * BATCH, batch * BATCH + BATCH)) {
    const lc = l === "en" ? {} : { language_code: l };
    const calls: [string, Record<string, unknown>][] = [
      // The name only on request (setup, or "Update bot name" in admin): a name the owner set in @BotFather must stay
      ...(opts.names ? ([["setMyName", { name: about[l].name, ...lc }]] as [string, Record<string, unknown>][]) : []),
      ["setMyShortDescription", { short_description: about[l].short, ...lc }],
      ["setMyDescription", { description: about[l].description, ...lc }],
    ];
    for (const [method, params] of calls) {
      try {
        await tg(env.BOT_TOKEN, method, params);
      } catch (e) {
        const msg = (e as Error).message;
        const wait = retryAfterSeconds(msg);
        if (wait !== null) throw new TelegramRetryLater(wait);
        console.warn("bot profile text refused", l, method, msg);
      }
    }
  }
  return batch + 1 < PROFILE_BATCHES ? batch + 1 : null;
}

/**
 * Command menus (20 app languages) and/or profile texts (every profile language) for one batch of 10 languages, at most
 * 40 Telegram calls, under the free plan's 50 per request. Returns the next batch number, or null when done.
 */
export async function syncBotTexts(env: Env, batch: number, parts: TextParts = "all"): Promise<number | null> {
  let more = false;
  if (parts !== "texts") {
    for (const l of LANGS.slice(batch * BATCH, batch * BATCH + BATCH)) {
      await tg(env.BOT_TOKEN, "setMyCommands", { commands: userCommands(l), ...(l === "en" ? {} : { language_code: l }) });
    }
    more ||= (batch + 1) * BATCH < LANGS.length;
  }
  // syncBotTexts runs on an explicit request (setup page or admin button), so it sets the names too
  if (parts !== "commands") more ||= (await setProfileTexts(env, batch, { names: true })) !== null;
  return more ? batch + 1 : null;
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
