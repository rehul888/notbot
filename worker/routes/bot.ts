import { Hono } from "hono";
import { LANGS, langLabel, pickLang, type Lang } from "../../shared/types";
import { timingSafeEqual, webhookSecret } from "../auth";
import { tryClaim } from "../claim";
import type { Env } from "../env";
import { isOwner } from "../env";
import { attachReferral, parseRef } from "../growth";
import { getSettings } from "../settings";
import { botText } from "../i18n";
import { balanceText, languageKeyboard, openButton, sendHelp, sendPreviews, sendWelcome } from "../botMessages";
import { ADMIN_COMMANDS, userCommands } from "../commands";
import { sendAdminLink, sendStats } from "../stats";
import { onBroadcastCallback, onBroadcastCommand } from "../broadcast";
import { onPreCheckout, onSuccessfulPayment } from "../payments";
import { tg } from "../telegram";

export const bot = new Hono<{ Bindings: Env }>();

interface TgFrom {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

bot.post("/", async (c) => {
  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  // An empty header never matches: the effective secret is TG_WEBHOOK_SECRET, or derived from the bot token
  if (!secret || !timingSafeEqual(secret, await webhookSecret(c.env))) return c.text("forbidden", 403);
  const update = await c.req.json<any>().catch(() => null);
  if (!update || typeof update !== "object") return c.text("ok");
  // pre_checkout must be answered within 10 s — do it inline; everything else can run after we reply.
  if (update.pre_checkout_query) {
    await onPreCheckout(c.env, update.pre_checkout_query);
    return c.text("ok");
  }
  c.executionCtx.waitUntil(handle(c.env, update).catch((e) => console.error("bot update failed", e)));
  return c.text("ok");
});

/** Language buttons → save the choice (shared with the Mini App) and show the welcome in that language. */
async function onCallback(env: Env, q: any): Promise<void> {
  if (typeof q.data === "string" && q.data.startsWith("bc:")) return onBroadcastCallback(env, q);
  const m = /^lang:(\w+)$/.exec(q.data ?? "");
  if (!m || !(LANGS as readonly string[]).includes(m[1])) return void (await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id }));
  const lang = m[1] as Lang;
  await env.DB.prepare("UPDATE users SET lang = ?2 WHERE id = ?1").bind(q.from.id, lang).run();
  await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id, text: langLabel(lang) });
  // Swap the language picker for the photo welcome in the chosen language
  if (q.message) await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => undefined);
  await sendWelcome(env, q.from.id, lang, q.from.first_name ?? "");
}

/** Telegram refunded Stars on its side (e.g. a dispute): take the credited balance back, even if that makes it negative. */
async function onRefundedPayment(env: Env, r: { currency?: string; total_amount?: number; telegram_payment_charge_id?: string }): Promise<void> {
  const charge = r.telegram_payment_charge_id;
  if (!charge) return;
  const p = await env.DB.prepare("SELECT id, stars FROM payments WHERE charge_id = ?1 AND status = 'paid'").bind(charge).first<{ id: number; stars: number }>();
  if (!p) return; // unknown, or already refunded (our own admin refund also triggers this message)
  if (r.currency !== "XTR" || r.total_amount !== p.stars) {
    console.error("telegram refund mismatch, not applied", charge, r.currency, r.total_amount);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?1 AND status = 'paid'").bind(p.id),
    env.DB.prepare(
      "INSERT INTO ledger (user_id, delta, kind, ref, note, created_at) SELECT user_id, -amount, 'stars_refund', id, 'telegram refund', ?2 FROM payments WHERE id = ?1 AND changes() = 1",
    ).bind(p.id, now),
    env.DB.prepare(
      "UPDATE users SET balance = balance - (SELECT amount FROM payments WHERE id = ?1) WHERE id = (SELECT user_id FROM payments WHERE id = ?1) AND changes() = 1",
    ).bind(p.id),
  ]);
}

async function handle(env: Env, u: any): Promise<void> {
  if (u.callback_query) return onCallback(env, u.callback_query);
  if (u.my_chat_member && u.my_chat_member.chat?.type === "private") {
    const status = u.my_chat_member.new_chat_member?.status;
    await env.DB.prepare("UPDATE users SET can_message = ?2 WHERE id = ?1")
      .bind(u.my_chat_member.from.id, status === "kicked" ? 0 : 1)
      .run();
    return;
  }
  const m = u.message;
  if (!m || m.chat?.type !== "private") return;
  const from = m.from as TgFrom;
  const now = Math.floor(Date.now() / 1000);
  // Messaging the bot means it may message back
  const user = await env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, username, language_code, can_message, notify, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET can_message = 1, first_name = excluded.first_name, last_name = excluded.last_name,
       username = excluded.username, language_code = excluded.language_code
     WHERE users.can_message = 0 OR users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name
       OR users.username IS NOT excluded.username OR users.language_code IS NOT excluded.language_code
     RETURNING lang, language_code`,
  )
    .bind(from.id, from.first_name ?? "", from.last_name ?? "", from.username ?? null, from.language_code ?? null, now)
    .first<{ lang: string | null; language_code: string | null }>()
    .then((r) => r ?? env.DB.prepare("SELECT lang, language_code FROM users WHERE id = ?1").bind(from.id).first<{ lang: string | null; language_code: string | null }>());
  const lang = pickLang(user?.lang ?? user?.language_code);

  if (m.successful_payment) {
    await onSuccessfulPayment(env, from, m.successful_payment);
    return;
  }
  if (m.refunded_payment) {
    await onRefundedPayment(env, m.refunded_payment);
    return;
  }
  const text: string = (m.text ?? "").trim();
  const cmd = /^\/(\w+)/.exec(text)?.[1]?.toLowerCase() ?? "";
  const send = (t: string, markup?: unknown) =>
    tg(env.BOT_TOKEN, "sendMessage", { chat_id: from.id, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup });
  const pickLanguage = () => send(botText(lang, "chooseLanguage"), languageKeyboard(LANGS));

  // First-admin claim: "/start claim_<code>" (the setup link) or "/claim <code>". Wrong codes look like any other message.
  const arg = text.split(/\s+/)[1] ?? "";
  if (cmd === "claim" || (cmd === "start" && arg.startsWith("claim_"))) {
    const code = cmd === "claim" ? arg : arg.slice("claim_".length);
    if (code && (await tryClaim(env, from.id, code))) {
      await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: from.id, message_id: m.message_id }).catch(() => undefined);
      return void (await send("You are now the admin of this bot. Open the app and tap <b>Admin</b> in your profile to finish setting up."));
    }
  }
  // /paysupport stays answered (Telegram requires it for Stars) but isn't in the command menu.
  if (cmd === "paysupport" || cmd === "support") return void (await sendHelp(env, from.id, lang, "paysupport"));
  if (cmd === "language") return void (await pickLanguage());
  if (cmd === "start") {
    const ref = parseRef(text.split(/\s+/)[1]);
    if (ref) await attachReferral(env, await getSettings(env), from.id, ref);
  }
  if (cmd === "start") {
    // An admin's own menu (with /admin and /stats) can only be set once they have a chat with the bot
    const s = await getSettings(env);
    if (isOwner(env, s, from.id))
      await tg(env.BOT_TOKEN, "setMyCommands", { scope: { type: "chat", chat_id: from.id }, commands: [...userCommands(lang), ...ADMIN_COMMANDS] }).catch(() => undefined);
    return void (await (user?.lang ? sendWelcome(env, from.id, lang, from.first_name) : pickLanguage()));
  }
  if (cmd === "orders" || cmd === "wallet") {
    const s = await getSettings(env);
    const open = openButton(lang, s, cmd === "orders" ? "/#/orders" : "/#/wallet");
    const bal = cmd === "wallet" ? await env.DB.prepare("SELECT balance FROM users WHERE id = ?1").bind(from.id).first<{ balance: number }>() : null;
    const text = cmd === "orders" ? botText(lang, "ordersReply") : botText(lang, "walletReply", { balance: balanceText(bal?.balance ?? 0, s) });
    return void (await send(text, open ? { inline_keyboard: [[open]] } : undefined));
  }
  // Admin only (English, like the admin panel)
  if (cmd === "broadcast" && isOwner(env, await getSettings(env), from.id)) {
    return void (await onBroadcastCommand(env, from.id, (text.split(/\s+/)[1] ?? "").toLowerCase(), m.reply_to_message));
  }
  if ((cmd === "admin" || cmd === "stats") && isOwner(env, await getSettings(env), from.id)) {
    return void (await (cmd === "admin" ? sendAdminLink(env, from.id) : sendStats(env, from.id)));
  }
  // Owner only: one of every message, e.g. "/preview" or "/preview ru"
  if (cmd === "preview" && isOwner(env, await getSettings(env), from.id)) {
    const arg = text.split(/\s+/)[1] as Lang | undefined;
    const l = arg && (LANGS as readonly string[]).includes(arg) ? arg : lang;
    await sendPreviews(env, from.id, l, from.first_name, LANGS);
    return;
  }
  // An admin writing a message to broadcast (not a command) gets no help reply in between
  if (!cmd && isOwner(env, await getSettings(env), from.id)) return;
  await sendHelp(env, from.id, lang);
}
