// Rich bot messages: the photo welcome, help, and an owner-only preview of every message type.
import { langLabel, type Lang } from "../shared/types";
import type { Env } from "./env";
import { botText } from "./i18n";
import { getSettings, setSettings, type Settings } from "./settings";
import { tg, VIEW_ORDER_ICON_EMOJI_ID, webAppButton } from "./telegram";

export const TERMS_URL = "https://notpanel.com/tos";
const BANNER_PATH = "/brand/welcome-banner.jpg";

export const usdText = (m: number) => "$" + (m / 1e6).toFixed(m > 0 && m < 100_000 ? 3 : 2);
export const supportHandle = (s: Settings) => (s.support_username ? "@" + s.support_username : s.bot_username ? "@" + s.bot_username : "NotPanel");
/** Telegram links in captions: show without the scheme and keep them short */
export const linkText = (link: string) => {
  const l = link.replace(/^https?:\/\/(www\.)?/, "");
  return l.length > 48 ? l.slice(0, 47) + "…" : l;
};

export function openButton(lang: Lang, s: Settings, path = "") {
  return s.app_url ? webAppButton(botText(lang, "open"), `${s.app_url}${path}`) : null;
}

/** Welcome photo (4:3 banner) with the feature caption and an Open button. Reuses Telegram's file_id after the first send. */
export async function sendWelcome(env: Env, chatId: number, lang: Lang, name: string): Promise<void> {
  const s = await getSettings(env);
  const open = openButton(lang, s);
  const reply_markup = open ? { inline_keyboard: [[open]] } : undefined;
  const caption = botText(lang, "welcome", { name: name || "there" });
  const url = s.app_url ? `${s.app_url}${BANNER_PATH}` : "";
  const [cachedUrl, fileId] = (s.welcome_photo || "|").split("|");
  const photo = fileId && cachedUrl === url ? fileId : url;
  try {
    if (!photo) throw new Error("no app url");
    const msg = await tg<{ photo?: { file_id: string }[] }>(env.BOT_TOKEN, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", reply_markup });
    const id = msg.photo?.at(-1)?.file_id;
    if (id && photo === url) await setSettings(env, { welcome_photo: `${url}|${id}` });
  } catch (e) {
    console.warn("welcome photo failed, sending text", (e as Error).message);
    await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: caption, parse_mode: "HTML", reply_markup });
  }
}

export async function sendHelp(env: Env, chatId: number, lang: Lang, key: "help" | "paysupport" = "help"): Promise<void> {
  const s = await getSettings(env);
  const open = openButton(lang, s);
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: botText(lang, key, { support: supportHandle(s) }),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [...(open ? [[open]] : []), [{ text: botText(lang, "termsButton"), url: TERMS_URL }]] },
  });
}

export function languageKeyboard(langs: readonly Lang[]) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < langs.length; i += 2) rows.push(langs.slice(i, i + 2).map((l) => ({ text: langLabel(l), callback_data: `lang:${l}` })));
  return { inline_keyboard: rows };
}

/** Owner preview: sends one of every message type with sample data, in the given language. */
export async function sendPreviews(env: Env, chatId: number, lang: Lang, name: string, langs: readonly Lang[]): Promise<number> {
  const s = await getSettings(env);
  const sample = { id: "1234", service: "Telegram Post Views — Real", quantity: "1,000", link: "t.me/notpanel_com/42", refund: "$0.35", amount: "$5.00", balance: "$12.40", reason: "LINK_BUSY" };
  const view = s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "viewOrder"), `${s.app_url}/#/orders`, VIEW_ORDER_ICON_EMOJI_ID)]] } : undefined;
  const open = openButton(lang, s);
  const send = (text: string, reply_markup?: unknown) =>
    tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup });
  let n = 0;
  await send(`🧪 <b>Bot message previews</b> · ${langLabel(lang)}\nSample data, nothing was charged.`);
  await send(botText(lang, "chooseLanguage"), languageKeyboard(langs)), n++;
  await sendWelcome(env, chatId, lang, name), n++;
  await sendHelp(env, chatId, lang), n++;
  await sendHelp(env, chatId, lang, "paysupport"), n++;
  for (const key of ["orderPlaced", "orderCompleted", "orderPartial", "orderCancelled", "orderFailed"] as const) await send(botText(lang, key, sample), view), n++;
  await send(botText(lang, "topupDone", sample), open ? { inline_keyboard: [[open]] } : undefined), n++;
  await send(botText(lang, "orderNotPlaced", sample), open ? { inline_keyboard: [[open]] } : undefined), n++;
  return n;
}
