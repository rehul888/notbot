// The bot's command menus and profile descriptions (never its name: that changes only on request). Customers get the user commands in their language; admins get the same list
// plus the admin commands (English, like the admin panel), set per admin chat. The bot's name and descriptions are set
// in every profile language (worker/bot-about.ts). The cron job keeps Telegram in sync on its own: after a deploy that
// changes them, a brand rename, an admin change or a new bot token, everything is refreshed within minutes.
import { type Lang, LANGS, pickLang } from "../shared/types";
import { ABOUT_LANGS } from "./bot-about";
import { brandName } from "./brand";
import { PROFILE_BATCHES, setProfileTexts, TelegramRetryLater } from "./connect";
import { type Env, ownerIds } from "./env";
import { botPlain } from "./i18n";
import { getSettings, setSettings, type Settings } from "./settings";
import { tg } from "./telegram";

/** Bump when the command lists change, so every deployment refreshes its menus after updating */
export const COMMANDS_VERSION = 4;

type Command = { command: string; description: string };

export function userCommands(lang: Lang): Command[] {
  return [
    { command: "start", description: botPlain(lang, "cmdStart") },
    { command: "orders", description: botPlain(lang, "cmdOrders") },
    { command: "wallet", description: botPlain(lang, "cmdWallet") },
    { command: "language", description: botPlain(lang, "cmdLanguage") },
    { command: "help", description: botPlain(lang, "cmdHelp") },
  ];
}

export const ADMIN_COMMANDS: Command[] = [
  { command: "admin", description: "Admin panel" },
  { command: "stats", description: "Sales, users and NotPanel balance" },
  { command: "broadcast", description: "Send a message to all users (reply to it)" },
  { command: "preview", description: "Preview every bot message" },
];

/** Customer menus for one batch of 10 languages (10 Telegram calls). Returns the next batch, or null when done. */
export async function setUserCommands(env: Env, batch: number): Promise<number | null> {
  for (const l of LANGS.slice(batch * 10, batch * 10 + 10)) {
    await tg(env.BOT_TOKEN, "setMyCommands", { commands: userCommands(l), ...(l === "en" ? {} : { language_code: l }) });
  }
  return (batch + 1) * 10 < LANGS.length ? batch + 1 : null;
}

const MAX_ADMIN_CHATS = 20; // per run, to stay far below the free plan's 50 outgoing calls

/** Admin menus: set for current admins (in their language), removed for people who are no longer admins. */
export async function setAdminCommands(env: Env, s: Settings, previous: number[]): Promise<void> {
  const now = ownerIds(env, s);
  const removed = previous.filter((id) => !now.includes(id));
  const ids = [...now, ...removed].slice(0, MAX_ADMIN_CHATS);
  const langs = new Map<number, Lang>();
  if (now.length) {
    const { results } = await env.DB.prepare("SELECT id, lang, language_code FROM users WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(now))
      .all<{ id: number; lang: string | null; language_code: string | null }>();
    for (const r of results) langs.set(r.id, pickLang(r.lang ?? r.language_code));
  }
  for (const id of ids) {
    const scope = { type: "chat", chat_id: id };
    // An admin who never opened the bot has no chat yet: Telegram refuses, and the next refresh tries again
    if (removed.includes(id)) await tg(env.BOT_TOKEN, "deleteMyCommands", { scope }).catch(() => undefined);
    else await tg(env.BOT_TOKEN, "setMyCommands", { scope, commands: [...userCommands(langs.get(id) ?? "en"), ...ADMIN_COMMANDS] }).catch(() => undefined);
  }
}

/** What the menus and profile texts depend on: code version, profile languages, the bot, its brand and its admins */
export const commandsKey = (env: Env, s: Settings) =>
  `${COMMANDS_VERSION}|${ABOUT_LANGS.length}|${(env.BOT_TOKEN ?? "").split(":")[0]}|${brandName(s)}|${ownerIds(env, s).join(",")}`;

/** Steps: 0-1 customer menus, 2 admin menus, then one step per batch of 10 profile languages */
const PROFILE_FIRST_STEP = 3;

/**
 * Cron: when the menus or profile texts are out of date, refresh them one step per minute. Waits while a price sync is
 * running (so one run never makes too many outgoing calls) and for as long as Telegram asks after a rate limit.
 */
export async function commandsTick(env: Env): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  // Waits for price syncs and broadcasts, so one cron run never makes too many outgoing calls
  if (!s.bot_username || !s.setup_done || s.sync_state || s.broadcast_state) return;
  const now = Math.floor(Date.now() / 1000);
  if (s.commands_wait_until > now) return;
  const key = commandsKey(env, s);
  if (s.commands_key === key) return;
  const step = s.commands_step;
  try {
    if (step < 2) {
      const next = await setUserCommands(env, step);
      await setSettings(env, { commands_step: next ?? 2 });
    } else if (step === 2) {
      await setAdminCommands(env, s, s.commands_admins.split(",").map(Number).filter(Boolean));
      await setSettings(env, { commands_step: PROFILE_FIRST_STEP, commands_admins: ownerIds(env, s).join(",") });
    } else {
      const next = await setProfileTexts(env, Math.min(step - PROFILE_FIRST_STEP, PROFILE_BATCHES - 1), { names: false });
      if (next === null) await setSettings(env, { commands_key: key, commands_step: 0 });
      else await setSettings(env, { commands_step: PROFILE_FIRST_STEP + next });
    }
  } catch (e) {
    if (!(e instanceof TelegramRetryLater)) throw e;
    // Telegram asked to slow down: resume this same step after the wait (plus a minute of margin)
    await setSettings(env, { commands_wait_until: now + e.seconds + 60 });
  }
}

/** Setup: all command menus at once (about 20 + admins calls); the cron job then adds the remaining profile languages */
export async function setAllCommands(env: Env): Promise<void> {
  for (let b: number | null = 0; b !== null; ) b = await setUserCommands(env, b);
  const s = await getSettings(env, { fresh: true });
  await setAdminCommands(env, s, s.commands_admins.split(",").map(Number).filter(Boolean));
  // The setup page already set the first 20 profile languages (texts0/texts1): continue after those
  await setSettings(env, { commands_key: "", commands_step: PROFILE_FIRST_STEP + 2, commands_admins: ownerIds(env, s).join(",") });
}
