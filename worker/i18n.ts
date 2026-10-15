// Messages the bot sends in chat. Placeholders: {name}. Missing translations fall back to English.
import type { Lang } from "../shared/types";
import bot from "./bot-strings.json";

const en = {
  welcome:
    "<b>NotPanel Bot</b>\n\nWelcome to NotPanel Bot, {name}! 👋\nGet followers, views, likes and more for Telegram, Instagram, TikTok, YouTube and other platforms.\n\nTo use our services, tap the button below 👇",
  open: "Open NotPanel",
  chooseLanguage: "🌐 Choose your language",
  viewOrder: "View order",
  orderCompleted: "✅ <b>Order #{id} completed</b>\n{service} · {quantity}",
  orderPartial: "🟡 <b>Order #{id} partly delivered</b>\n{service} · {quantity}\n{refund} was refunded to your balance.",
  orderCancelled: "⛔️ <b>Order #{id} canceled</b>\n{service} · {quantity}\n{refund} was refunded to your balance.",
  orderFailed: "⚠️ <b>Order #{id} could not be started</b>\n{service}\n{refund} was refunded to your balance.",
  topupDone: "⭐️ <b>{amount} added to your balance.</b>",
  orderPlaced: "🚀 <b>Order #{id} placed</b>\n{service} · {quantity}",
  orderNotPlaced: "⭐️ Payment received: <b>{amount}</b> was added to your balance, but the order could not be placed ({reason}). You can try again from the app.",
  paysupport:
    "<b>Payment support</b>\n\nFor questions about a Stars payment, write to {support} with your payment date and amount. Telegram support can't help with purchases made in this bot.",
  terms: "<b>Terms of service</b>\n\n{terms}",
  termsButton: "Read full terms",
  help: "Tap the button below to open the app. Commands: /terms · /paysupport",
  invoiceTitle: "NotPanel balance",
  invoiceTopup: "Add {amount} to your NotPanel balance",
  invoiceOrder: "{service} · {quantity}",
};

export type BotKey = keyof typeof en;
const all = bot as Partial<Record<Lang, Partial<Record<BotKey, string>>>>;

export function botText(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(vars[k] ?? ""));
}

/** Same, without HTML escaping — for plain-text places like invoice titles */
export function botPlain(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export const BOT_EN = en;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
