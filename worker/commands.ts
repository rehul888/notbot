// The bot's command menus. Customers get the user commands in their language; admins get the same list plus the
// admin commands (English, like the admin panel), set per admin chat. The cron job keeps Telegram in sync on its own:
// after a deploy that changes the commands, a brand rename or an admin change, the menus are refreshed within minutes.
import { type Lang, LANGS, pickLang } from "../shared/types";
import { brandName } from "./brand";
import { type Env, ownerIds } from "./env";
import { botPlain } from "./i18n";
import { getSettings, setSettings, type Settings } from "./settings";
import { tg } from "./telegram";

/** Bump when the command lists change, so every deployment refreshes its menus after updating */
export const COMMANDS_VERSION = 2;

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

/** What the menus depend on: the code version, the brand name (in /start's text) and who the admins are */
export const commandsKey = (env: Env, s: Settings) => `${COMMANDS_VERSION}|${brandName(s)}|${ownerIds(env, s).join(",")}`;

/**
 * Cron: when the menus are out of date, refresh them one step per minute (customer menus in two batches, then the
 * admin menus). Waits while a price sync is running so a single run never makes too many outgoing calls.
 */
export async function commandsTick(env: Env): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  if (!s.bot_username || !s.setup_done || s.sync_state) return;
  const key = commandsKey(env, s);
  if (s.commands_key === key) return;
  const step = s.commands_step;
  if (step < 2) {
    const next = await setUserCommands(env, step);
    await setSettings(env, { commands_step: next ?? 2 });
    return;
  }
  const previous = s.commands_admins.split(",").map(Number).filter(Boolean);
  await setAdminCommands(env, s, previous);
  await setSettings(env, { commands_key: key, commands_step: 0, commands_admins: ownerIds(env, s).join(",") });
}

/** Setup: everything at once (about 20 + admins calls), then mark the menus as current */
export async function setAllCommands(env: Env): Promise<void> {
  for (let b: number | null = 0; b !== null; ) b = await setUserCommands(env, b);
  const s = await getSettings(env, { fresh: true });
  await setAdminCommands(env, s, s.commands_admins.split(",").map(Number).filter(Boolean));
  await setSettings(env, { commands_key: commandsKey(env, s), commands_step: 0, commands_admins: ownerIds(env, s).join(",") });
}
