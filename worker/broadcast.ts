// Admin broadcast: an admin writes any message in the bot (text, formatting, photo, Premium emojis), replies to it with
// /broadcast and confirms. The cron job then copies that message to every user the bot can message, a batch per minute,
// with an "Open App" button in each user's language, and reports back to the admin when done. English only (admin).
import { pickLang } from "../shared/types";
import { openButton } from "./botMessages";
import { type Env, isOwner } from "./env";
import { getSettings, setSettings } from "./settings";
import { tg } from "./telegram";
import { retryAfterSeconds } from "./connect";

export interface BroadcastState {
  /** Admin chat and message to copy */
  chat: number;
  msg: number;
  /** Last user id done (users are sent in id order) */
  cursor: number;
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  startedAt: number;
  /** Rate-limited by Telegram: pause until */
  waitUntil?: number;
}

/** Per cron run; leaves room for the other cron jobs within the free plan's 50 outgoing calls */
export const BROADCAST_BATCH = 25;

export function readBroadcast(raw: string): BroadcastState | null {
  try {
    const v = raw ? (JSON.parse(raw) as BroadcastState) : null;
    return v && typeof v.chat === "number" && typeof v.msg === "number" ? v : null;
  } catch {
    return null;
  }
}

const recipients = (env: Env) => env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE can_message = 1 AND banned = 0").first<{ n: number }>();

const say = (env: Env, chatId: number, text: string, reply_markup?: unknown) =>
  tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup }).catch((e) => console.warn("broadcast reply failed", (e as Error).message));

function progress(b: BroadcastState): string {
  const done = b.sent + b.blocked + b.failed;
  return `Sent <b>${b.sent.toLocaleString("en-US")}</b> · blocked ${b.blocked.toLocaleString("en-US")} · failed ${b.failed.toLocaleString("en-US")} · ${Math.min(done, b.total).toLocaleString("en-US")} of ${b.total.toLocaleString("en-US")}`;
}

/** "/broadcast" from an admin: reply-to → ask to confirm; "status" / "stop"; anything else → how to use it */
export async function onBroadcastCommand(env: Env, chatId: number, arg: string, replyTo: { message_id: number } | undefined): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  const running = readBroadcast(s.broadcast_state);
  if (arg === "status") return void (await say(env, chatId, running ? `📣 <b>BROADCAST RUNNING</b>\n\n${progress(running)}` : "No broadcast is running."));
  if (arg === "stop") {
    if (!running) return void (await say(env, chatId, "No broadcast is running."));
    await setSettings(env, { broadcast_state: "" });
    return void (await say(env, chatId, `⛔️ <b>BROADCAST STOPPED</b>\n\n${progress(running)}`));
  }
  if (running) return void (await say(env, chatId, `A broadcast is already running.\n\n${progress(running)}\n\n/broadcast stop cancels it.`));
  if (!replyTo)
    return void (await say(
      env,
      chatId,
      "📣 <b>BROADCAST</b>\n\n1. Write the message here exactly as users should see it (text, formatting, a photo or video, Premium emojis).\n" +
        "2. <b>Reply to it</b> with /broadcast.\n3. Confirm.\n\nEveryone who can receive messages from the bot gets a copy, with an Open App button. " +
        "<i>/broadcast status</i> shows progress, <i>/broadcast stop</i> cancels.",
    ));
  const n = (await recipients(env))?.n ?? 0;
  await say(env, chatId, `Send the message above to <b>${n.toLocaleString("en-US")}</b> users?`, {
    inline_keyboard: [[{ text: "✅ Send", callback_data: `bc:go:${replyTo.message_id}` }, { text: "Cancel", callback_data: "bc:no" }]],
  });
}

/** The confirm buttons. Only admins can start a broadcast. */
export async function onBroadcastCallback(env: Env, q: { id: string; data: string; from: { id: number }; message?: { chat: { id: number }; message_id: number } }): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  const answer = (text: string) => tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => undefined);
  if (!isOwner(env, s, q.from.id) || !q.message) return void (await answer("Admins only"));
  const clear = () => tg(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: q.message!.chat.id, message_id: q.message!.message_id }).catch(() => undefined);
  if (q.data === "bc:no") {
    await clear();
    return void (await answer("Cancelled"));
  }
  const msg = Number(/^bc:go:(\d+)$/.exec(q.data)?.[1]);
  if (!msg) return void (await answer("Unknown action"));
  if (readBroadcast(s.broadcast_state)) return void (await answer("A broadcast is already running"));
  const total = (await recipients(env))?.n ?? 0;
  const state: BroadcastState = { chat: q.message.chat.id, msg, cursor: 0, total, sent: 0, blocked: 0, failed: 0, startedAt: Math.floor(Date.now() / 1000) };
  await setSettings(env, { broadcast_state: JSON.stringify(state) });
  await clear();
  await answer("Broadcast started");
  await say(env, q.message.chat.id, `📣 <b>BROADCAST STARTED</b>\n\nSending to ${total.toLocaleString("en-US")} users, about ${BROADCAST_BATCH} per minute. I'll message you when it's done.\n<i>/broadcast status</i> · <i>/broadcast stop</i>`);
}

/** Telegram's answer means this user can't receive messages from the bot any more */
export const isBlocked = (message: string) => /\b403\b|blocked|deactivated|chat not found|user not found/i.test(message);

/** Cron: copies the message to the next batch of users. Blocked users are marked so nothing is sent to them again. */
export async function broadcastTick(env: Env): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  const b = readBroadcast(s.broadcast_state);
  if (!b || s.sync_state) return;
  const now = Math.floor(Date.now() / 1000);
  if (b.waitUntil && b.waitUntil > now) return;
  const { results } = await env.DB.prepare(
    `SELECT id, lang, language_code FROM users WHERE can_message = 1 AND banned = 0 AND id > ?1 ORDER BY id LIMIT ${BROADCAST_BATCH}`,
  )
    .bind(b.cursor)
    .all<{ id: number; lang: string | null; language_code: string | null }>();
  const blockedIds: number[] = [];
  delete b.waitUntil;
  for (const u of results) {
    const open = openButton(pickLang(u.lang ?? u.language_code), s);
    try {
      await tg(env.BOT_TOKEN, "copyMessage", { chat_id: u.id, from_chat_id: b.chat, message_id: b.msg, ...(open ? { reply_markup: { inline_keyboard: [[open]] } } : {}) });
      b.sent++;
    } catch (e) {
      const m = (e as Error).message;
      const wait = retryAfterSeconds(m);
      if (wait !== null) {
        b.waitUntil = now + wait + 5; // resume with this same user
        break;
      }
      if (isBlocked(m)) {
        b.blocked++;
        blockedIds.push(u.id);
      } else b.failed++;
    }
    b.cursor = u.id;
  }
  if (blockedIds.length)
    await env.DB.prepare("UPDATE users SET can_message = 0 WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(blockedIds)).run();
  // Stopped meanwhile? Don't resurrect it.
  const still = readBroadcast((await getSettings(env, { fresh: true })).broadcast_state);
  if (!still || still.startedAt !== b.startedAt) return;
  if (!results.length || (results.length < BROADCAST_BATCH && !b.waitUntil)) {
    await setSettings(env, { broadcast_state: "" });
    await say(env, b.chat, `✅ <b>BROADCAST DONE</b>\n\n${progress({ ...b, total: b.sent + b.blocked + b.failed })}\n\n<i>Blocked users won't be messaged again.</i>`);
    return;
  }
  await setSettings(env, { broadcast_state: JSON.stringify(b) });
}
