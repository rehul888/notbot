// Admin broadcast: a button-driven menu in the bot (/broadcast). The admin sends the message (text or media with a
// caption, formatting and Premium emojis kept, {name} = each user's first name), adds colored buttons, previews it and
// confirms. The cron job then sends it to every user the bot can message, a batch per minute, editing one status card
// (progress, ETA, pause / resume / stop) and reporting when it is done. English only (admin).
//
// Storage: the running broadcast is the `broadcast_state` setting (JSON, "" when none); drafts and history are in
// broadcast_drafts / broadcast_history (migrations/0010_broadcasts.sql). All changes to the running state are single
// guarded SQL statements, so a button press and the cron job never overwrite each other.
import { pickLang } from "../shared/types";
import { openButton } from "./botMessages";
import {
  AWAIT_SECONDS,
  BROADCAST_BATCH,
  BROADCAST_CALL_BUDGET,
  type BroadcastState,
  buildKeyboard,
  type Draft,
  extractContent,
  isBlocked,
  isLastBatch,
  isSending,
  MAX_BUTTONS,
  messageRequest,
  num,
  parseButtonLine,
  pausePatch,
  readBroadcast,
  readDraft,
  resumePatch,
  type StatePatch,
  shouldAutoPause,
  STYLES,
  withoutCustomEmoji,
} from "./broadcastCore";
import {
  askButtonView,
  askMessageView,
  colorView,
  confirmDiscardView,
  confirmReplaceView,
  confirmSendView,
  confirmStopView,
  draftView,
  finalView,
  type HistoryRow,
  historyView,
  menuView,
  statusView,
  type View,
} from "./broadcastViews";
import { retryAfterSeconds } from "./connect";
import { type Env, isOwner } from "./env";
import { bustSettings, getSettings, type Settings } from "./settings";
import { emojiFallbacks, tg } from "./telegram";

export { BROADCAST_BATCH, isBlocked, readBroadcast };

// ---------------------------------------------------------------------------------------------------------------
// Telegram helpers

const markup = (v: View) => (v.rows.length ? { inline_keyboard: v.rows } : undefined);
const viewParams = (v: View) => ({ text: v.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup(v) });

/** Sends a card as a new message; returns its message id */
async function say(env: Env, chat: number, v: View): Promise<number | undefined> {
  try {
    return (await tg<{ message_id: number }>(env.BOT_TOKEN, "sendMessage", { chat_id: chat, ...viewParams(v) })).message_id;
  } catch (e) {
    console.warn("broadcast reply failed", (e as Error).message);
    return undefined;
  }
}

/** Shows a card by editing a message in place (a new message if it can't be edited) */
async function showView(env: Env, chat: number, msg: number, v: View): Promise<number | undefined> {
  try {
    await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chat, message_id: msg, ...viewParams(v) });
    return msg;
  } catch (e) {
    if (/not modified/i.test((e as Error).message)) return msg;
    return say(env, chat, v);
  }
}

const removeMessage = (env: Env, chat: number, msg: number | null | undefined) =>
  msg ? tg(env.BOT_TOKEN, "deleteMessage", { chat_id: chat, message_id: msg }).catch(() => undefined) : Promise.resolve();

// ---------------------------------------------------------------------------------------------------------------
// Database: drafts and what each admin is being asked for

type Await = "new" | "msg" | "btn";
interface Row {
  draft: Draft | null;
  v: number;
  awaiting: Await | null;
  /** Was waiting for something, but it timed out */
  expired: boolean;
  card: number | null;
}

const now = () => Math.floor(Date.now() / 1000);

async function getRow(env: Env, admin: number): Promise<Row> {
  const r = await env.DB.prepare("SELECT draft, v, awaiting, awaiting_until, card FROM broadcast_drafts WHERE admin_id = ?1")
    .bind(admin)
    .first<{ draft: string | null; v: number; awaiting: string | null; awaiting_until: number; card: number | null }>();
  const live = !!r?.awaiting && r.awaiting_until > now();
  return { draft: readDraft(r?.draft), v: r?.v ?? 0, awaiting: live ? (r!.awaiting as Await) : null, expired: !!r?.awaiting && !live, card: r?.card ?? null };
}

/** Writes only the given parts of an admin's row: the draft (bumps its version), what we are waiting for, the card */
async function patchRow(env: Env, admin: number, f: { draft?: Draft | null; awaiting?: Await | null; card?: number | null }): Promise<void> {
  const t = now();
  const cols = ["admin_id", "updated_at"];
  const vals: unknown[] = [admin, t];
  const upd = ["updated_at = excluded.updated_at"];
  if ("draft" in f) {
    cols.push("draft");
    vals.push(f.draft ? JSON.stringify(f.draft) : null);
    upd.push("draft = excluded.draft", "v = broadcast_drafts.v + 1");
  }
  if ("awaiting" in f) {
    cols.push("awaiting", "awaiting_until");
    vals.push(f.awaiting ?? null, f.awaiting ? t + AWAIT_SECONDS : 0);
    upd.push("awaiting = excluded.awaiting", "awaiting_until = excluded.awaiting_until");
  }
  if ("card" in f) {
    cols.push("card");
    vals.push(f.card ?? null);
    upd.push("card = excluded.card");
  }
  await env.DB.prepare(`INSERT INTO broadcast_drafts (${cols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")}) ON CONFLICT(admin_id) DO UPDATE SET ${upd.join(", ")}`)
    .bind(...vals)
    .run();
}

const dropRow = (env: Env, admin: number) => env.DB.prepare("DELETE FROM broadcast_drafts WHERE admin_id = ?1").bind(admin).run();

const audience = async (env: Env) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE can_message = 1 AND banned = 0").first<{ n: number }>())?.n ?? 0;

// ---------------------------------------------------------------------------------------------------------------
// Database: the running broadcast

const GUARD = "CASE WHEN json_valid(value) THEN json_extract(value, '$.startedAt') END = ?1";

/** Changes fields of the running broadcast (identified by its start time). False if it is gone (stopped, finished). */
async function patchState(env: Env, startedAt: number, patch: StatePatch): Promise<boolean> {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && /^[A-Za-z]+$/.test(k));
  if (!entries.length) return true;
  // Numbers are bound as integers so they stay whole numbers in the JSON
  const sets = entries.map(([k, v], i) => `'$.${k}', ${typeof v === "number" ? `CAST(?${i + 2} AS INTEGER)` : `?${i + 2}`}`).join(", ");
  const r = await env.DB.prepare(`UPDATE settings SET value = json_set(value, ${sets}) WHERE key = 'broadcast_state' AND ${GUARD}`)
    .bind(startedAt, ...entries.map(([, v]) => v))
    .run();
  bustSettings();
  return (r.meta.changes ?? 0) > 0;
}

/** Ends the running broadcast and records it in the history (the last 10 are kept). False if someone else ended it first. */
async function endBroadcast(env: Env, startedAt: number, status: "finished" | "stopped", at: number): Promise<boolean> {
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO broadcast_history (started_at, ended_at, status, kind, label, total, sent, blocked, failed, by_admin)
       SELECT json_extract(value, '$.startedAt'), ?2, ?3, COALESCE(json_extract(value, '$.c.kind'), 'copy'),
         COALESCE(substr(json_extract(value, '$.c.text'), 1, 60), ''), COALESCE(json_extract(value, '$.total'), 0),
         COALESCE(json_extract(value, '$.sent'), 0), COALESCE(json_extract(value, '$.blocked'), 0),
         COALESCE(json_extract(value, '$.failed'), 0), json_extract(value, '$.chat')
       FROM settings WHERE key = 'broadcast_state' AND ${GUARD}`,
    ).bind(startedAt, at, status),
    env.DB.prepare(`UPDATE settings SET value = '' WHERE key = 'broadcast_state' AND ${GUARD}`).bind(startedAt),
    env.DB.prepare("DELETE FROM broadcast_history WHERE id NOT IN (SELECT id FROM broadcast_history ORDER BY id DESC LIMIT 10)"),
  ]);
  bustSettings();
  return (res[0].meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Cards that need data

async function menuCard(env: Env, s: Settings, admin: number): Promise<View> {
  const [row, n] = await Promise.all([getRow(env, admin), audience(env)]);
  return menuView({ audience: n, draft: row.draft, running: readBroadcast(s.broadcast_state), now: now() });
}

async function draftCard(env: Env, s: Settings, admin: number): Promise<View | null> {
  const row = await getRow(env, admin);
  if (!row.draft) return null;
  return draftView({ draft: row.draft, v: row.v, audience: await audience(env), running: !!readBroadcast(s.broadcast_state), hasApp: !!s.app_url });
}

async function historyCard(env: Env): Promise<View> {
  const { results } = await env.DB.prepare(
    `SELECT h.started_at, h.ended_at, h.status, h.kind, h.label, h.total, h.sent, h.blocked, h.failed, h.by_admin, u.first_name AS by_name
     FROM broadcast_history h LEFT JOIN users u ON u.id = h.by_admin ORDER BY h.id DESC LIMIT 10`,
  ).all<HistoryRow>();
  return historyView(results);
}

const NONE: View = { text: "No broadcast is running.", rows: [[{ text: "📣 Open the menu", callback_data: "bc:menu" }]] };

// ---------------------------------------------------------------------------------------------------------------
// Commands

/**
 * "/broadcast" from an admin opens the menu. "/broadcast status | pause | resume | stop" are shortcuts. Replying to a
 * message with /broadcast turns that message into the draft.
 */
export async function onBroadcastCommand(env: Env, chatId: number, arg: string, replyTo: any): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  const running = readBroadcast(s.broadcast_state);
  const t = now();
  if (arg === "status" || arg === "pause" || arg === "resume" || arg === "stop") {
    if (!running) return void (await say(env, chatId, NONE));
    if (arg === "stop") {
      const ok = await endBroadcast(env, running.startedAt, "stopped", t);
      return void (await say(env, chatId, ok ? finalView(running, "stopped", t) : NONE));
    }
    let st = running;
    if (arg !== "status") {
      const patch = arg === "pause" ? pausePatch(running, t) : resumePatch(running, t);
      if (patch) {
        await patchState(env, running.startedAt, patch);
        st = { ...running, ...patch };
      }
    }
    const id = await say(env, chatId, statusView(st, t));
    if (id && chatId === st.chat) await patchState(env, st.startedAt, { card: id });
    return;
  }
  if (replyTo) {
    const ex = extractContent(replyTo);
    if (!ex.ok) return void (await say(env, chatId, { text: `⚠️ ${ex.error}`, rows: [[{ text: "📣 Open the menu", callback_data: "bc:menu" }]] }));
    await patchRow(env, chatId, { draft: { c: ex.content, b: [], two: false, app: true }, awaiting: null });
    const v = await draftCard(env, s, chatId);
    const id = v && (await say(env, chatId, v));
    if (id) await patchRow(env, chatId, { card: id });
    return;
  }
  // Opening the menu again cancels anything it was waiting for
  await patchRow(env, chatId, { awaiting: null });
  const id = await say(env, chatId, await menuCard(env, s, chatId));
  if (id) await patchRow(env, chatId, { card: id });
}

// ---------------------------------------------------------------------------------------------------------------
// The admin's messages while the bot is waiting for one

/** Sends the card as a fresh message at the bottom of the chat and removes the old one, so the card is always in view */
async function moveCard(env: Env, chat: number, row: Row, v: View | null): Promise<void> {
  if (!v) return;
  const id = await say(env, chat, v);
  if (id) {
    await removeMessage(env, chat, row.card);
    await patchRow(env, chat, { card: id });
  }
}

/** An admin's non-command message. Used only while the bot waits for the broadcast message or a button line. */
export async function onBroadcastMessage(env: Env, admin: number, m: any): Promise<void> {
  const row = await getRow(env, admin);
  if (row.expired) {
    await patchRow(env, admin, { awaiting: null });
    await say(env, admin, { text: "⌛ <b>TIMED OUT</b>\n\nThat took too long, so I stopped waiting. Open the menu to continue.", rows: [[{ text: "📣 Open the menu", callback_data: "bc:menu" }]] });
    return;
  }
  if (!row.awaiting) return;
  const s = await getSettings(env);
  if (row.awaiting === "new" || row.awaiting === "msg") {
    const ex = extractContent(m);
    if (!ex.ok) return moveCard(env, admin, row, askMessageView({ change: row.awaiting === "msg", error: ex.error }));
    const base = row.awaiting === "msg" && row.draft ? row.draft : { b: [], two: false, app: true };
    await patchRow(env, admin, { draft: { ...base, c: ex.content, pend: undefined }, awaiting: null });
    return moveCard(env, admin, row, await draftCard(env, s, admin));
  }
  // A button line: "Text | https://link" or "Text | app"
  const draft = row.draft;
  if (!draft) {
    await patchRow(env, admin, { awaiting: null });
    return moveCard(env, admin, row, await menuCard(env, s, admin));
  }
  const parsed = typeof m.text === "string" ? parseButtonLine(m.text, s.app_url) : null;
  if (!parsed || !parsed.ok)
    return moveCard(env, admin, row, askButtonView({ count: draft.b.length, hasApp: !!s.app_url, error: parsed ? parsed.error : "Send the button as text, like <code>Text | https://link</code>." }));
  await patchRow(env, admin, { draft: { ...draft, pend: { t: parsed.t, u: parsed.u } }, awaiting: null });
  await removeMessage(env, admin, m.message_id); // tidy: the line has been read
  return moveCard(env, admin, row, colorView(parsed));
}

// ---------------------------------------------------------------------------------------------------------------
// Buttons

interface Q {
  id: string;
  data: string;
  from: { id: number; first_name?: string; language_code?: string };
  message?: { chat: { id: number }; message_id: number };
}

/** The broadcast buttons. Every press is checked: only admins, and old buttons get a friendly note instead of an error. */
export async function onBroadcastCallback(env: Env, q: Q): Promise<void> {
  let toast: string | void;
  try {
    const s = await getSettings(env, { fresh: true });
    if (!isOwner(env, s, q.from.id)) toast = "Admins only";
    else if (!q.message) toast = "Open /broadcast again";
    else toast = await handleCallback(env, s, q as Q & Required<Pick<Q, "message">>);
  } catch (e) {
    console.error("broadcast button failed", e);
    toast = "Something went wrong. Open /broadcast again.";
  }
  await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id, ...(toast ? { text: String(toast).slice(0, 190) } : {}) }).catch(() => undefined);
}

async function handleCallback(env: Env, s: Settings, q: Q & Required<Pick<Q, "message">>): Promise<string | void> {
  const admin = q.from.id;
  const chat = q.message.chat.id;
  const msg = q.message.message_id;
  const [, act = "", x = "", y = ""] = String(q.data).split(":");
  const t = now();
  const running = readBroadcast(s.broadcast_state);
  const row = await getRow(env, admin);
  const show = (v: View) => showView(env, chat, msg, v);
  const menu = async (toast?: string) => {
    await show(await menuCard(env, s, admin));
    return toast;
  };
  const card = async (toast?: string) => {
    const v = await draftCard(env, s, admin);
    if (!v) return menu("That draft no longer exists");
    await show(v);
    return toast;
  };
  /** Waiting for the admin's next message; this card becomes the prompt */
  const ask = async (kind: Await, v: View) => {
    await patchRow(env, admin, { awaiting: kind, card: msg });
    await show(v);
  };
  /** Status card in this message; it becomes the live card when it is in the chat that started the broadcast */
  const status = async (st: BroadcastState, toast?: string) => {
    const id = (await show(statusView(st, t))) ?? msg;
    if (chat === st.chat && st.card !== id) await patchState(env, st.startedAt, { card: id });
    return toast;
  };
  const draft = row.draft;

  switch (act) {
    case "menu":
      if (row.awaiting) await patchRow(env, admin, { awaiting: null });
      return menu();
    case "new":
      if (draft) return void (await show(confirmReplaceView()));
      return ask("new", askMessageView({ change: false }));
    case "newok":
      return ask("new", askMessageView({ change: false }));
    case "cont":
    case "cancel":
      if (row.awaiting) await patchRow(env, admin, { awaiting: null });
      return act === "cancel" && !draft ? menu() : card();
    case "chg":
      if (!draft) return menu("That draft no longer exists");
      return ask("msg", askMessageView({ change: true }));
    case "add":
      if (!draft) return menu("That draft no longer exists");
      if (draft.b.length >= MAX_BUTTONS) return `${MAX_BUTTONS} buttons is the maximum`;
      return ask("btn", askButtonView({ count: draft.b.length, hasApp: !!s.app_url }));
    case "bs": {
      const style = STYLES.find((o) => o.code === x);
      if (!draft?.pend || !style) return card("That choice has expired");
      if (draft.b.length >= MAX_BUTTONS) return card(`${MAX_BUTTONS} buttons is the maximum`);
      await patchRow(env, admin, { draft: { ...draft, b: [...draft.b, { t: draft.pend.t, u: draft.pend.u, s: style.style }], pend: undefined } });
      return card(`${style.label} button added`);
    }
    case "bx":
      if (draft?.pend) await patchRow(env, admin, { draft: { ...draft, pend: undefined } });
      return card();
    case "rm": {
      if (!draft) return menu("That draft no longer exists");
      const i = Number(x);
      if (Number(y) !== row.v || !draft.b[i]) return card("The buttons changed, check the list");
      await patchRow(env, admin, { draft: { ...draft, b: draft.b.filter((_, j) => j !== i) } });
      return card("Button removed");
    }
    case "lay":
      if (!draft) return menu("That draft no longer exists");
      await patchRow(env, admin, { draft: { ...draft, two: !draft.two } });
      return card();
    case "app":
      if (!draft) return menu("That draft no longer exists");
      await patchRow(env, admin, { draft: { ...draft, app: !draft.app } });
      return card();
    case "pv": {
      if (!draft) return menu("That draft no longer exists");
      const u = await env.DB.prepare("SELECT lang, language_code FROM users WHERE id = ?1").bind(admin).first<{ lang: string | null; language_code: string | null }>();
      const open = draft.app ? openButton(pickLang(u?.lang ?? u?.language_code ?? q.from.language_code), s) : null;
      const r = messageRequest(draft.c, q.from.first_name?.trim() || "there", buildKeyboard(draft.b, draft.two, s.app_url, open));
      try {
        await tg(env.BOT_TOKEN, r.method, { chat_id: admin, ...r.params });
        return "Preview sent below";
      } catch (e) {
        return `Telegram refused it: ${(e as Error).message.replace(/^Telegram \w+: /, "")}`;
      }
    }
    case "send": {
      if (!draft) return menu("That draft no longer exists");
      if (running) return "A broadcast is already running";
      const n = await audience(env);
      if (!n) return "Nobody can receive messages right now";
      return void (await show(confirmSendView({ draft, v: row.v, audience: n })));
    }
    case "yes": {
      if (!draft) return menu("That draft no longer exists");
      if (Number(x) !== row.v) return card("The draft changed, check it and send again");
      if (running) return "A broadcast is already running";
      const total = await audience(env);
      if (!total) return "Nobody can receive messages right now";
      const st: BroadcastState = { chat, card: msg, c: draft.c, b: draft.b, two: draft.two, app: draft.app, cursor: 0, total, sent: 0, blocked: 0, failed: 0, startedAt: t };
      const r = await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('broadcast_state', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ''")
        .bind(JSON.stringify(st))
        .run();
      bustSettings();
      if (!(r.meta.changes > 0)) return "A broadcast is already running";
      await dropRow(env, admin);
      const id = await show(statusView(st, t));
      if (id && id !== msg) await patchState(env, st.startedAt, { card: id }); // the card had to be sent as a new message
      return "Broadcast started";
    }
    case "disc":
      if (!draft) return menu("That draft no longer exists");
      return void (await show(confirmDiscardView()));
    case "discok":
      await dropRow(env, admin);
      return menu("Draft discarded");
    case "st":
    case "ref":
      if (!running) return menu("No broadcast is running");
      return status(running, act === "ref" ? "Refreshed" : undefined);
    case "pause":
    case "resume": {
      if (!running) return menu("No broadcast is running");
      const patch = act === "pause" ? pausePatch(running, t) : resumePatch(running, t);
      if (patch) await patchState(env, running.startedAt, patch);
      return status({ ...running, ...patch }, patch ? (act === "pause" ? "Paused" : "Resumed") : act === "pause" ? "Already paused" : "Not paused");
    }
    case "stop":
      if (!running) return menu("No broadcast is running");
      return void (await show(confirmStopView(running)));
    case "stopok": {
      if (!running) return menu("No broadcast is running");
      const ok = await endBroadcast(env, running.startedAt, "stopped", t);
      if (!ok) return menu("It had already ended");
      const done = finalView(running, "stopped", t);
      await show(done);
      // The live card (if it is another message) stops showing buttons too
      if (running.card && !(chat === running.chat && running.card === msg)) await showView(env, running.chat, running.card, done).catch(() => undefined);
      return "Broadcast stopped";
    }
    case "hist":
      return void (await show(await historyCard(env)));
    default:
      return "This button is outdated. Open /broadcast again.";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cron

/** Edits the live status card; a deleted or unchanged card is not an error */
async function editCard(env: Env, st: BroadcastState, v: View): Promise<void> {
  if (!st.card) return;
  await tg(env.BOT_TOKEN, "editMessageText", { chat_id: st.chat, message_id: st.card, ...viewParams(v) }).catch((e) => {
    if (!/not modified/i.test((e as Error).message)) console.warn("broadcast card edit failed", (e as Error).message);
  });
}

interface Target {
  id: number;
  lang: string | null;
  language_code: string | null;
  first_name: string | null;
}

/** One send to one user */
async function sendOne(env: Env, b: BroadcastState, s: Settings, u: Target, plainEmoji: boolean): Promise<void> {
  if (!b.c) {
    // Started by an older version: copy the admin's message
    const open = openButton(pickLang(u.lang ?? u.language_code), s);
    await tg(env.BOT_TOKEN, "copyMessage", { chat_id: u.id, from_chat_id: b.chat, message_id: b.msg, ...(open ? { reply_markup: { inline_keyboard: [[open]] } } : {}) });
    return;
  }
  const open = b.app === false ? null : openButton(pickLang(u.lang ?? u.language_code), s);
  const r = messageRequest(plainEmoji ? withoutCustomEmoji(b.c) : b.c, u.first_name?.trim() || "there", buildKeyboard(b.b ?? [], !!b.two, s.app_url, open));
  await tg(env.BOT_TOKEN, r.method, { chat_id: u.id, ...r.params });
}

/**
 * Cron: sends to the next batch of users and updates the status card. Blocked users are marked so nothing is sent to
 * them again. Does nothing while paused, while Telegram asked us to wait, or during a price sync.
 */
export async function broadcastTick(env: Env): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  const b = readBroadcast(s.broadcast_state);
  const t = now();
  if (!b || s.sync_state || !isSending(b, t)) return;
  const { results } = await env.DB.prepare(
    `SELECT id, lang, language_code, first_name FROM users WHERE can_message = 1 AND banned = 0 AND id > ?1 ORDER BY id LIMIT ${BROADCAST_BATCH}`,
  )
    .bind(b.cursor)
    .all<Target>();
  const blockedIds: number[] = [];
  let waitUntil = 0;
  let completed = true;
  let calls = 0; // outgoing Telegram calls, to stay within the free plan's limit
  let plainEmoji = false; // Telegram refused custom emojis once: don't pay for a retry on every user
  let lastError = "";
  for (const u of results) {
    if (calls >= BROADCAST_CALL_BUDGET) {
      completed = false;
      break;
    }
    const refused = emojiFallbacks.count;
    try {
      await sendOne(env, b, s, u, plainEmoji);
      b.sent++;
    } catch (e) {
      const m = (e as Error).message;
      const wait = retryAfterSeconds(m);
      if (wait !== null) {
        waitUntil = t + wait + 5; // resume with this same user
        completed = false;
        break;
      }
      if (isBlocked(m)) {
        b.blocked++;
        blockedIds.push(u.id);
      } else {
        b.failed++;
        lastError = m.replace(/^Telegram \w+: /, "").slice(0, 160);
      }
    }
    calls += 1 + (emojiFallbacks.count - refused);
    if (emojiFallbacks.count > refused) plainEmoji = true;
    b.cursor = u.id;
  }
  if (blockedIds.length)
    await env.DB.prepare("UPDATE users SET can_message = 0 WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(blockedIds)).run();
  b.waitUntil = waitUntil;
  if (lastError) b.lastError = lastError;
  // Stopped meanwhile? Then this changes nothing, and the broadcast is not resurrected.
  const patch: StatePatch = { cursor: b.cursor, sent: b.sent, blocked: b.blocked, failed: b.failed, waitUntil, ...(lastError ? { lastError } : {}) };
  if (!(await patchState(env, b.startedAt, patch))) return;

  if (isLastBatch(results.length, completed, !!waitUntil)) {
    if (!(await endBroadcast(env, b.startedAt, "finished", t))) return;
    await editCard(env, b, finalView(b, "finished", t));
    // An edit sends no notification: say it once more as a new message
    await say(env, b.chat, {
      text: `✅ <b>Broadcast finished.</b> ${num(b.sent)} sent, ${num(b.blocked)} blocked, ${num(b.failed)} failed.`,
      rows: [[{ text: "📜 Recent broadcasts", callback_data: "bc:hist" }]],
    });
    return;
  }
  // Every send failed for a reason that isn't the user's (e.g. Telegram refuses the message): stop and say so
  if (shouldAutoPause(b)) {
    const pause = pausePatch(b, t);
    if (pause && (await patchState(env, b.startedAt, pause))) {
      Object.assign(b, pause);
      await say(env, b.chat, {
        text: `⚠️ <b>Broadcast paused.</b> The first ${BROADCAST_BATCH} sends all failed (${b.lastError ?? "unknown error"}). Nobody was blocked, so the message itself is probably the problem.`,
        rows: [[{ text: "📊 Status", callback_data: "bc:st" }]],
      });
    }
  }
  await editCard(env, b, statusView(b, t));
}
