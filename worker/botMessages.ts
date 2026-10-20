// Rich bot messages: the photo welcome, help, and an owner-only preview of every message type.
import { balanceStars, shownStars, underOneStar } from "../shared/stars";
import { langLabel, type Lang } from "../shared/types";
import type { Env } from "./env";
import { validHttpsUrl } from "../shared/brand";
import { brandName } from "./brand";
import { botText, escapeHtml } from "./i18n";
import { getSettings, setSettings, type Settings } from "./settings";
import { linkButton, tg, webAppButton } from "./telegram";

/** Whole Stars for bot messages: "1,250 ⭐" */
export const starsText = (stars: number) => `${Math.round(stars).toLocaleString("en-US")} ⭐`;
/** A micro-USD amount (charge, refund, credit) as users see it: Stars, rounded up */
export const amountText = (micro: number, s: Settings) => starsText(shownStars(micro, s.stars_per_usd));
/** A micro-USD balance as users see it: Stars, rounded down */
export const balanceText = (micro: number, s: Settings) =>
  underOneStar(micro, s.stars_per_usd) ? "<1 ⭐" : starsText(balanceStars(micro, s.stars_per_usd));
export const supportHandle = (s: Settings) => (s.support_username ? "@" + s.support_username : s.bot_username ? "@" + s.bot_username : brandName(s));
/** Telegram links in captions: show without the scheme and keep them short */
export const linkText = (link: string) => {
  const l = link.replace(/^https?:\/\/(www\.)?/, "");
  return l.length > 48 ? l.slice(0, 47) + "…" : l;
};

export function openButton(lang: Lang, s: Settings, path = "") {
  return s.app_url ? webAppButton(botText(lang, "open"), `${s.app_url}${path}`) : null;
}

/** The owner's welcome text (plain text, escaped here) with {name} and {brand} filled in */
export function customWelcome(template: string, name: string, brand: string): string {
  return escapeHtml(template).replace(/\{name\}/g, escapeHtml(name)).replace(/\{brand\}/g, escapeHtml(brand));
}

/**
 * Welcome with the owner's banner (if one is uploaded), the feature caption and an Open button; text only otherwise.
 * Reuses Telegram's file_id after the first send; a new banner changes the URL (banner_ver), which drops the cache.
 */
export async function sendWelcome(env: Env, chatId: number, lang: Lang, name: string): Promise<void> {
  const s = await getSettings(env);
  const open = openButton(lang, s);
  const reply_markup = open ? { inline_keyboard: [[open]] } : undefined;
  const caption = s.welcome_text.trim() ? customWelcome(s.welcome_text, name || "there", brandName(s)) : botText(lang, "welcome", { name: name || "there" });
  const url = s.app_url && s.banner_ver > 0 ? `${s.app_url}/media/banner?v=${s.banner_ver}` : "";
  if (url) {
    const [cachedUrl, fileId] = (s.welcome_photo || "|").split("|");
    const photo = fileId && cachedUrl === url ? fileId : url;
    try {
      const msg = await tg<{ photo?: { file_id: string }[] }>(env.BOT_TOKEN, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", reply_markup });
      const id = msg.photo?.at(-1)?.file_id;
      if (id && photo === url) await setSettings(env, { welcome_photo: `${url}|${id}` });
      return;
    } catch (e) {
      console.warn("welcome photo failed, sending text", (e as Error).message);
    }
  }
  await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: caption, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup });
}

/** Terms button: the owner's terms link, else the in-app terms page, else none */
export function termsButton(lang: Lang, s: Settings) {
  if (validHttpsUrl(s.terms_url)) return linkButton(botText(lang, "termsButton"), s.terms_url, "terms");
  if (s.app_url) return webAppButton(botText(lang, "termsButton"), `${s.app_url}/#/terms`, "terms");
  return null;
}

export async function sendHelp(env: Env, chatId: number, lang: Lang, key: "help" | "paysupport" = "help"): Promise<void> {
  const s = await getSettings(env);
  const open = openButton(lang, s);
  const terms = termsButton(lang, s);
  const rows = [...(open ? [[open]] : []), ...(terms ? [[terms]] : [])];
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: botText(lang, key, { support: supportHandle(s) }),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
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
  const sample = { id: "16502", service: "Telegram Post Views — Real", quantity: "1,000", link: "t.me/example/42", refund: "27 ⭐", amount: "500 ⭐", balance: "1,240 ⭐", reason: "LINK_BUSY" };
  const view = s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "viewOrder"), `${s.app_url}/#/orders`, "viewOrder")]] } : undefined;
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
