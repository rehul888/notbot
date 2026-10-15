import { Hono } from "hono";
import { LANG_NAMES, LANGS, pickLang, type Lang } from "../../shared/types";
import { timingSafeEqual } from "../auth";
import type { Env } from "../env";
import { botText } from "../i18n";
import { onPreCheckout, onSuccessfulPayment } from "../payments";
import { getSettings } from "../settings";
import { tg, webAppButton } from "../telegram";

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
  if (!timingSafeEqual(secret, c.env.TG_WEBHOOK_SECRET)) return c.text("forbidden", 403);
  const update = await c.req.json<any>();
  // pre_checkout must be answered within 10 s — do it inline; everything else can run after we reply.
  if (update.pre_checkout_query) {
    await onPreCheckout(c.env, update.pre_checkout_query);
    return c.text("ok");
  }
  c.executionCtx.waitUntil(handle(c.env, update).catch((e) => console.error("bot update failed", e)));
  return c.text("ok");
});

function languageKeyboard() {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < LANGS.length; i += 2) rows.push(LANGS.slice(i, i + 2).map((l) => ({ text: LANG_NAMES[l], callback_data: `lang:${l}` })));
  return { inline_keyboard: rows };
}

/** Language buttons → save the choice (shared with the Mini App) and show the welcome in that language. */
async function onCallback(env: Env, q: any): Promise<void> {
  const m = /^lang:(\w+)$/.exec(q.data ?? "");
  if (!m || !(LANGS as readonly string[]).includes(m[1])) return void (await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id }));
  const lang = m[1] as Lang;
  await env.DB.prepare("UPDATE users SET lang = ?2 WHERE id = ?1").bind(q.from.id, lang).run();
  await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id, text: LANG_NAMES[lang] });
  const s = await getSettings(env);
  if (q.message)
    await tg(env.BOT_TOKEN, "editMessageText", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      text: botText(lang, "welcome", { name: q.from.first_name ?? "" }),
      parse_mode: "HTML",
      reply_markup: s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "open"), s.app_url)]] } : undefined,
    });
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
  const text: string = m.text ?? "";
  const s = await getSettings(env);
  const openBtn = s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "open"), s.app_url)]] } : undefined;
  const send = (t: string, markup?: unknown) =>
    tg(env.BOT_TOKEN, "sendMessage", { chat_id: from.id, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup });

  if (text.startsWith("/terms"))
    return void (await send(botText(lang, "terms", { terms: s.terms_text }), {
      inline_keyboard: [[{ text: botText(lang, "termsButton"), url: "https://notpanel.com/tos" }]],
    }));
  if (text.startsWith("/paysupport") || text.startsWith("/support")) {
    const support = s.support_username ? "@" + s.support_username : "the bot owner";
    return void (await send(botText(lang, "paysupport", { support })));
  }
  if (text.startsWith("/language") || (text.startsWith("/start") && !user?.lang))
    return void (await send(botText(lang, "chooseLanguage"), languageKeyboard()));
  if (text.startsWith("/start")) return void (await send(botText(lang, "welcome", { name: from.first_name }), openBtn));
  await send(botText(lang, "help"), openBtn);
}
