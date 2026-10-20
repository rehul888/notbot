// Messages the bot sends in chat. Placeholders: {name}, {brand} (filled automatically, see setBotBrand). Missing translations fall back to English.
import type { Lang } from "../shared/types";
import bot from "./bot-strings.json";

const en = {
  welcome:
    "┏━━ 👋 <b>Welcome, {name}!</b>\n\n" +
    "<b>{brand}</b> helps you grow any social account in a few taps.\n\n" +
    "🚀 <b>WHAT YOU CAN GET</b>\n" +
    "  ┣ 👥 <i>Followers, subscribers & members</i>\n" +
    "  ┣ 👁 <i>Views & story views</i>\n" +
    "  ┣ ❤️ <i>Likes & reactions</i>\n" +
    "  ┣ 💬 <i>Comments & shares</i>\n" +
    "  ┗ 📊 <i>Live tracking for every order</i>\n\n" +
    "┗━━━━━━━━━━━━━━━━━━━━━━┛\n" +
    "👇 <b>Tap Open App to start</b>",
  open: "Open App",
  chooseLanguage: "🌐 <b>Choose your language</b>\n\nTap a language below. You can change it any time with /language.",
  viewOrder: "View order",
  orderPlaced:
    "🚀 <b>ORDER PLACED</b>\n\n" +
    "  ┣ 🧾 Order: <b>#{id}</b>\n" +
    "  ┣ 📦 {service}\n" +
    "  ┣ 🔢 Quantity: <b>{quantity}</b>\n" +
    "  ┗ 🔗 {link}\n\n" +
    "⏱ <i>We'll message you here as soon as it's done.</i>",
  orderCompleted:
    "✅ <b>ORDER COMPLETED</b>\n\n" +
    "  ┣ 🧾 Order: <b>#{id}</b>\n" +
    "  ┣ 📦 {service}\n" +
    "  ┣ 🔢 Quantity: <b>{quantity}</b>\n" +
    "  ┗ 🔗 {link}\n\n" +
    "🎉 <i>Thanks for ordering with {brand}!</i>",
  orderPartial:
    "🟡 <b>ORDER PARTLY DELIVERED</b>\n\n" +
    "  ┣ 🧾 Order: <b>#{id}</b>\n" +
    "  ┣ 📦 {service}\n" +
    "  ┣ 🔢 Quantity: <b>{quantity}</b>\n" +
    "  ┗ 💸 Refunded: <b>{refund}</b>\n\n" +
    "<i>The part that couldn't be delivered went back to your balance.</i>",
  orderCancelled:
    "⛔️ <b>ORDER CANCELED</b>\n\n" +
    "  ┣ 🧾 Order: <b>#{id}</b>\n" +
    "  ┣ 📦 {service}\n" +
    "  ┣ 🔢 Quantity: <b>{quantity}</b>\n" +
    "  ┗ 💸 Refunded: <b>{refund}</b>\n\n" +
    "<i>The refund is already in your balance.</i>",
  orderFailed:
    "⚠️ <b>ORDER COULD NOT START</b>\n\n" +
    "  ┣ 🧾 Order: <b>#{id}</b>\n" +
    "  ┣ 📦 {service}\n" +
    "  ┗ 💸 Refunded: <b>{refund}</b>\n\n" +
    "<i>Please check the link is public and correct, then try again.</i>",
  topupDone:
    "⭐️ <b>BALANCE TOPPED UP</b>\n\n" +
    "  ┣ 💰 Added: <b>{amount}</b>\n" +
    "  ┗ 👛 Balance: <b>{balance}</b>\n\n" +
    "<i>You're ready to order. Tap below.</i>",
  orderNotPlaced:
    "⭐️ <b>PAYMENT RECEIVED</b>\n\n" +
    "  ┣ 💰 Added to balance: <b>{amount}</b>\n" +
    "  ┗ ⚠️ The order couldn't be placed: <i>{reason}</i>\n\n" +
    "<i>Your money is safe in your balance. Try again from the app.</i>",
  help:
    "ℹ️ <b>HELP</b>\n\n" +
    "  ┣ 🚀 Open the app with the button below\n" +
    "  ┣ 🌐 /language: change language\n" +
    "  ┗ 💬 Support: {support}\n\n" +
    "⭐️ <b>Payment questions?</b> Write to {support} with your payment date and amount. Telegram support can't help with purchases made in this bot.",
  paysupport:
    "⭐️ <b>PAYMENT SUPPORT</b>\n\n" +
    "  ┣ 💬 Write to: {support}\n" +
    "  ┗ 🧾 Include your payment date and amount\n\n" +
    "<i>Telegram support can't help with purchases made in this bot.</i>",
  termsButton: "Terms of service",
  referralReward:
    "🎁 <b>REFERRAL BONUS</b>\n\n" +
    "  ┣ 👤 {name} joined with your link\n" +
    "  ┣ 💰 Added: <b>{amount}</b>\n" +
    "  ┗ 👛 Balance: <b>{balance}</b>\n\n" +
    "<i>Invite more friends and earn for each one.</i>",
  inviteMore: "Invite more friends",
  cmdStart: "Open {brand}",
  cmdLanguage: "Change language",
  cmdHelp: "Help and support",
  cmdOrders: "My orders",
  cmdWallet: "Balance and top-up",
  ordersReply: "📦 <b>YOUR ORDERS</b>\n\n<i>Track every order live in the app.</i>",
  walletReply: "👛 <b>BALANCE: {balance}</b>\n\n<i>Top up with Telegram Stars in the app.</i>",
  invoiceTitle: "{brand} balance",
  invoiceTopup: "Add {amount} to your {brand} balance",
  invoiceOrder: "{service} · {quantity}",
};

export type BotKey = keyof typeof en;
const all = bot as Partial<Record<Lang, Partial<Record<BotKey, string>>>>;

let botBrand = "NotBot";

/** Sets the brand name that fills {brand} in every bot text (call whenever settings load). */
export function setBotBrand(name: string) {
  if (name.trim()) botBrand = name.trim();
}

export function botText(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(vars[k] ?? (k === "brand" ? botBrand : "")));
}

/** Same, without HTML escaping, for plain-text places like invoice titles */
export function botPlain(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? (k === "brand" ? botBrand : ""));
}

export const BOT_EN = en;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
