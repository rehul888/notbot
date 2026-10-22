// Admin broadcast: the cards the bot shows (text + inline buttons). Pure functions of data, English only (admin).
import { escapeHtml } from "./i18n";
import {
  activeSeconds,
  AWAIT_SECONDS,
  BROADCAST_BATCH,
  type BroadcastState,
  type Btn,
  doneCount,
  draftLabel,
  type Draft,
  etaSeconds,
  fmtClock,
  fmtDuration,
  fmtTime,
  KIND_LABEL,
  MAX_BUTTONS,
  num,
  pctDone,
  progressBar,
  STYLES,
  styleDot,
} from "./broadcastCore";

export interface Btn1 {
  text: string;
  callback_data: string;
}
export interface View {
  text: string;
  rows: Btn1[][];
}
const b = (text: string, callback_data: string): Btn1 => ({ text, callback_data });

const menuRow = [b("⬅️ Menu", "bc:menu")];

/** "t.me/x/1" for a link; "the app" for the Mini App */
export function linkShort(u: string): string {
  if (u === "app") return "opens the app";
  const l = u.replace(/^https?:\/\/(www\.)?/, "");
  return l.length > 40 ? l.slice(0, 39) + "…" : l;
}

/** "Photo with caption · 120 characters · 2 buttons" */
export function draftSummary(d: Draft): string {
  const n = d.b.length;
  return `${draftLabel(d.c)} · ${num(d.c.text.length)} characters · ${n} button${n === 1 ? "" : "s"}`;
}

export function menuView(o: { audience: number; draft: Draft | null; running: BroadcastState | null; now: number }): View {
  const { draft, running } = o;
  const state = !running ? "idle" : running.paused ? `paused at ${pctDone(running)}%` : `running · ${pctDone(running)}%`;
  const text =
    "📣 <b>BROADCAST</b>\n\n" +
    `  ┣ 👥 Audience: <b>${num(o.audience)}</b> users\n` +
    `  ┣ 📝 Draft: <b>${draft ? escapeHtml(draftSummary(draft)) : "none"}</b>\n` +
    `  ┗ 📡 Sending: <b>${state}</b>\n\n` +
    "<i>Message everyone who can receive messages from the bot.</i>";
  const rows: Btn1[][] = [[b("✍️ New broadcast", "bc:new")]];
  if (draft) rows.push([b("📝 Continue draft", "bc:cont")]);
  const second: Btn1[] = [];
  if (running) second.push(b("📊 Status", "bc:st"));
  second.push(b("📜 Recent broadcasts", "bc:hist"));
  rows.push(second);
  return { text, rows };
}

export function askMessageView(o: { change: boolean; error?: string }): View {
  return {
    text:
      `✍️ <b>${o.change ? "CHANGE THE MESSAGE" : "NEW BROADCAST"}</b>\n\n` +
      (o.error ? `⚠️ ${o.error}\n\n` : "") +
      "Send the message: text, or a photo/video/GIF/document/audio/voice with a caption. Formatting and Premium emojis are kept. Use <code>{name}</code> for the user's first name.\n\n" +
      `<i>Waiting for your message · expires in ${AWAIT_SECONDS / 60} min</i>`,
    rows: [[b("✖️ Cancel", "bc:cancel")]],
  };
}

export function askButtonView(o: { count: number; hasApp: boolean; error?: string }): View {
  return {
    text:
      "➕ <b>ADD A BUTTON</b>\n\n" +
      (o.error ? `⚠️ ${o.error}\n\n` : "") +
      "Send the button as:\n" +
      "  ┣ <code>Text | https://link</code>\n" +
      (o.hasApp ? "  ┗ <code>Text | app</code> (opens the Mini App)\n\n" : "  ┗ https links only (t.me links are fine)\n\n") +
      `Text up to 64 characters. ${o.count} of ${MAX_BUTTONS} buttons used.\n\n` +
      `<i>Waiting for your message · expires in ${AWAIT_SECONDS / 60} min</i>`,
    rows: [[b("✖️ Cancel", "bc:cancel")]],
  };
}

export function colorView(p: { t: string; u: string }): View {
  return {
    text: `🎨 <b>BUTTON COLOR</b>\n\nButton: <b>${escapeHtml(p.t)}</b>\n<i>${escapeHtml(linkShort(p.u))}</i>\n\nPick a color:`,
    rows: [STYLES.map((s) => b(`${s.dot} ${s.label}`, `bc:bs:${s.code}`)), [b("✖️ Cancel", "bc:bx")]],
  };
}

export function draftView(o: { draft: Draft; v: number; audience: number; running: boolean; hasApp: boolean }): View {
  const d = o.draft;
  const list = d.b.map((x: Btn, i) => `${styleDot(x.s)} ${i + 1}. ${escapeHtml(x.t)} → <i>${escapeHtml(linkShort(x.u))}</i>`).join("\n");
  const text =
    "📝 <b>BROADCAST DRAFT</b>\n\n" +
    `  ┣ 🧾 Type: <b>${draftLabel(d.c)}</b>\n` +
    `  ┣ 🔤 Length: <b>${num(d.c.text.length)}</b> characters\n` +
    `  ┣ 🔘 Buttons: <b>${d.b.length}</b>${o.hasApp ? ` · Open App <b>${d.app ? "on" : "off"}</b>` : ""}\n` +
    `  ┗ 👥 Audience: <b>${num(o.audience)}</b> users\n` +
    (list ? `\n${list}\n` : "") +
    (o.running ? "\n⚠️ <i>Another broadcast is running. You can send this one after it finishes.</i>\n" : "") +
    "\n<i>Preview it first. <code>{name}</code> becomes each user's first name.</i>";
  const rows: Btn1[][] = [[b("👁 Preview (sent to you)", "bc:pv")]];
  const edit: Btn1[] = [];
  if (d.b.length < MAX_BUTTONS) edit.push(b("➕ Add button", "bc:add"));
  if (d.b.length > 1) edit.push(b(d.two ? "↕️ One per row" : "↕️ Two per row", "bc:lay"));
  if (edit.length) rows.push(edit);
  if (d.b.length) {
    const rm = d.b.map((_, i) => b(`🗑 ${i + 1}`, `bc:rm:${i}:${o.v}`));
    for (let i = 0; i < rm.length; i += 4) rows.push(rm.slice(i, i + 4));
  }
  if (o.hasApp) rows.push([b(`🔘 Open App button: ${d.app ? "ON" : "OFF"}`, "bc:app")]);
  if (o.running) rows.push([b("📊 Status of running broadcast", "bc:st")]);
  else if (o.audience > 0) rows.push([b(`🚀 Send to ${num(o.audience)} users`, "bc:send")]);
  rows.push([b("✍️ Change message", "bc:chg"), b("✖️ Discard draft", "bc:disc")]);
  rows.push(menuRow);
  return { text, rows };
}

export function confirmSendView(o: { draft: Draft; v: number; audience: number }): View {
  const minutes = Math.ceil(o.audience / BROADCAST_BATCH);
  return {
    text:
      `🚀 <b>SEND TO ${num(o.audience)} USERS?</b>\n\n` +
      `<b>${escapeHtml(draftSummary(o.draft))}</b>\n\n` +
      `This can't be undone. About ${BROADCAST_BATCH} messages go out per minute, so it takes roughly ${fmtDuration(minutes * 60)}. You can pause or stop it at any time.`,
    rows: [[b("✅ Yes, send", `bc:yes:${o.v}`), b("↩️ Back", "bc:cont")]],
  };
}

export const confirmDiscardView = (): View => ({
  text: "🗑 <b>DISCARD THE DRAFT?</b>\n\nThe message and its buttons will be deleted.",
  rows: [[b("🗑 Yes, discard", "bc:discok"), b("↩️ Back", "bc:cont")]],
});

export const confirmReplaceView = (): View => ({
  text: "✍️ <b>START A NEW BROADCAST?</b>\n\nYou have a draft. It stays until you send the new message, then it is replaced.",
  rows: [[b("✍️ Yes, start new", "bc:newok"), b("📝 Keep draft", "bc:cont")]],
});

export const confirmStopView = (st: BroadcastState): View => ({
  text: `⛔️ <b>STOP THE BROADCAST?</b>\n\n${progressLine(st)}\n\nPeople who already got it keep it. The rest will not receive it.`,
  rows: [[b("⛔️ Yes, stop", "bc:stopok"), b("↩️ Back", "bc:st")]],
});

function progressLine(st: BroadcastState): string {
  return `${progressBar(pctDone(st))} <b>${pctDone(st)}%</b> · ${num(Math.min(doneCount(st), st.total))} of ${num(st.total)}`;
}

/** The live card the cron job keeps editing (also shown after Pause / Resume / Refresh) */
export function statusView(st: BroadcastState, now: number): View {
  const done = doneCount(st);
  const waiting = !st.paused && st.waitUntil && st.waitUntil > now;
  const head = st.paused ? "⏸ <b>BROADCAST PAUSED</b>" : "📣 <b>BROADCAST RUNNING</b>";
  const eta = st.paused ? "paused" : waiting ? `Telegram asked to slow down, continues in ${fmtDuration((st.waitUntil ?? now) - now)}` : `about ${fmtDuration(etaSeconds(st, now))}`;
  const text =
    `${head}\n\n${progressLine(st)}\n\n` +
    `  ┣ ✅ Sent: <b>${num(st.sent)}</b>\n` +
    `  ┣ 🚫 Blocked: <b>${num(st.blocked)}</b>\n` +
    `  ┣ ⚠️ Failed: <b>${num(st.failed)}</b>\n` +
    `  ┣ ⏳ Remaining: <b>${num(Math.max(0, st.total - done))}</b>\n` +
    `  ┣ 🕒 Started: ${fmtTime(st.startedAt)}\n` +
    `  ┗ ⏱ ETA: <b>${eta}</b>\n` +
    (st.lastError && (st.paused || st.failed) ? `\n⚠️ <i>Last error: ${escapeHtml(st.lastError)}</i>\n` : "") +
    `\n<i>Updated ${fmtClock(now)}</i>`;
  return {
    text,
    rows: [
      [st.paused ? b("▶️ Resume", "bc:resume") : b("⏸ Pause", "bc:pause"), b("⛔️ Stop", "bc:stop")],
      [b("🔄 Refresh", "bc:ref"), b("⬅️ Menu", "bc:menu")],
    ],
  };
}

/** Final card: "finished" or "stopped" */
export function finalView(st: BroadcastState, status: "finished" | "stopped", endedAt: number): View {
  const head = status === "finished" ? "✅ <b>BROADCAST FINISHED</b>" : "⛔️ <b>BROADCAST STOPPED</b>";
  const total = status === "finished" ? doneCount(st) : st.total;
  const left = Math.max(0, total - doneCount(st));
  return {
    text:
      `${head}\n\n${progressBar(status === "finished" ? 100 : pctDone(st))} <b>${status === "finished" ? 100 : pctDone(st)}%</b>\n\n` +
      `  ┣ ✅ Sent: <b>${num(st.sent)}</b>\n` +
      `  ┣ 🚫 Blocked: <b>${num(st.blocked)}</b>\n` +
      `  ┣ ⚠️ Failed: <b>${num(st.failed)}</b>\n` +
      (left ? `  ┣ ⏳ Not sent: <b>${num(left)}</b>\n` : "") +
      `  ┣ 🕒 Started: ${fmtTime(st.startedAt)}\n` +
      `  ┗ ⏱ Took: <b>${fmtDuration(activeSeconds(st, endedAt))}</b>\n\n` +
      (status === "finished" ? "<i>Blocked users won't be messaged again.</i>" : "<i>Nothing more will be sent.</i>"),
    rows: [[b("📜 Recent broadcasts", "bc:hist"), b("⬅️ Menu", "bc:menu")]],
  };
}

export interface HistoryRow {
  started_at: number;
  ended_at: number;
  status: string;
  kind: string;
  label: string;
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  by_admin: number;
  by_name: string | null;
}

export function historyView(rows: HistoryRow[]): View {
  const lines = rows.map((r) => {
    const kind = (KIND_LABEL as Record<string, string>)[r.kind] ?? "Message";
    const by = r.by_name ? escapeHtml(r.by_name) : `#${r.by_admin}`;
    const label = r.label.replace(/\s+/g, " ").trim();
    return (
      `${r.status === "finished" ? "✅" : "⛔️"} <b>${fmtTime(r.started_at)}</b> · ${kind} · by ${by}\n` +
      `   ┣ ${num(r.sent)} sent · ${num(r.blocked)} blocked · ${num(r.failed)} failed (of ${num(r.total)})\n` +
      `   ┗ <i>${label ? escapeHtml(label.length > 48 ? label.slice(0, 47) + "…" : label) : "(no text)"}</i>`
    );
  });
  return {
    text: `📜 <b>RECENT BROADCASTS</b>\n\n${lines.length ? lines.join("\n\n") : "<i>No broadcasts yet.</i>"}`,
    rows: [menuRow],
  };
}
