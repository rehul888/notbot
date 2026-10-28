// Admin broadcast, pure parts (no database, no Telegram calls): the draft model, {name} personalization, button
// parsing, keyboards, the Telegram request for one user, and the progress / state arithmetic. English only (admin).
import { validHttpsUrl } from "../shared/brand";
import { groupInt } from "../shared/num";

/** Sends per cron run; leaves room for the other cron jobs within the free plan's 50 outgoing calls */
export const BROADCAST_BATCH = 25;
/** Outgoing Telegram calls one cron run may spend on sends (a refused custom emoji costs one extra call) */
export const BROADCAST_CALL_BUDGET = 40;
export const MAX_BUTTONS = 8;
export const MAX_BUTTON_TEXT = 64;
export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
/** How long the bot waits for the admin's message or button line */
export const AWAIT_SECONDS = 15 * 60;
export const NAME_TAG = "{name}";

export type MediaKind = "photo" | "video" | "animation" | "document" | "audio" | "voice";
export type Kind = "text" | MediaKind;
export type Style = "" | "primary" | "success" | "danger";

export interface Entity {
  type: string;
  offset: number;
  length: number;
  [k: string]: unknown;
}

/** The message itself: text or a caption (with entities, so formatting and Premium emojis survive) and optional media */
export interface Content {
  kind: Kind;
  text: string;
  entities: Entity[];
  /** Telegram file_id of the media (not for text) */
  file?: string;
  /** link_preview_options of the original text message */
  preview?: Record<string, unknown>;
  spoiler?: boolean;
  above?: boolean;
}

/** A custom button: u is "app" (opens the Mini App) or an https link; s is Telegram's button style ("" = plain) */
export interface Btn {
  t: string;
  u: string;
  s: Style;
}

export interface Draft {
  c: Content;
  b: Btn[];
  /** two buttons per row instead of one */
  two: boolean;
  /** add the app's Open App button as the last row */
  app: boolean;
  /** a button waiting for its color */
  pend?: { t: string; u: string };
}

export const KIND_LABEL: Record<Kind, string> = {
  text: "Text",
  photo: "Photo",
  video: "Video",
  animation: "GIF",
  document: "Document",
  audio: "Audio",
  voice: "Voice message",
};

/** Telegram Bot API "InlineKeyboardButton.style": danger = red, success = green, primary = blue; omitted = plain */
export const STYLES: { code: string; style: Style; label: string; dot: string }[] = [
  { code: "p", style: "primary", label: "Blue", dot: "🔵" },
  { code: "s", style: "success", label: "Green", dot: "🟢" },
  { code: "d", style: "danger", label: "Red", dot: "🔴" },
  { code: "n", style: "", label: "Plain", dot: "⚪" },
];
export const styleDot = (s: Style) => STYLES.find((x) => x.style === s)?.dot ?? "⚪";

export const draftLabel = (c: Content) => (c.kind === "text" ? "Text" : `${KIND_LABEL[c.kind]}${c.text ? " with caption" : ""}`);

// ---------------------------------------------------------------------------------------------------------------
// {name} personalization

/** Cuts to at most n UTF-16 units without leaving half of a surrogate pair */
export function cutUnits(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  let out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Replaces every {name} with the user's first name and moves the entities (offsets and lengths are in UTF-16 units)
 * to match: entities after a replacement shift, entities around it grow or shrink, an entity inside {name} covers the
 * whole name, and everything else (custom emojis, links) is kept as it was. If the result would be longer than maxLen,
 * the name is shortened.
 */
export function personalize(text: string, entities: Entity[], name: string, maxLen = Infinity): { text: string; entities: Entity[] } {
  const spots: number[] = [];
  for (let i = text.indexOf(NAME_TAG); i !== -1; i = text.indexOf(NAME_TAG, i + NAME_TAG.length)) spots.push(i);
  if (!spots.length) return { text, entities };
  const room = Math.floor((maxLen - (text.length - NAME_TAG.length * spots.length)) / spots.length);
  const nm = name.length > room ? cutUnits(name, room) : name;
  const delta = nm.length - NAME_TAG.length;
  let out = "";
  let from = 0;
  for (const s of spots) {
    out += text.slice(from, s) + nm;
    from = s + NAME_TAG.length;
  }
  out += text.slice(from);
  /** Position in the new text. A position inside {name} snaps to the start (or, for an end, the end) of the name. */
  const map = (p: number, isEnd: boolean) => {
    let shift = 0;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      if (p >= s + NAME_TAG.length) shift += delta;
      else if (p > s) return s + i * delta + (isEnd ? nm.length : 0);
      else break;
    }
    return p + shift;
  };
  const moved: Entity[] = [];
  for (const e of entities) {
    const offset = map(e.offset, false);
    const length = map(e.offset + e.length, true) - offset;
    if (length > 0) moved.push({ ...e, offset, length });
  }
  return { text: out, entities: moved };
}

// ---------------------------------------------------------------------------------------------------------------
// Buttons

/** "Text | https://link" or "Text | app" → a button without its color */
export function parseButtonLine(line: string, appUrl: string): { ok: true; t: string; u: string } | { ok: false; error: string } {
  const raw = line.trim();
  if (raw.includes("\n")) return { ok: false, error: "One button at a time, on a single line." };
  const bar = raw.lastIndexOf("|");
  if (bar < 1) return { ok: false, error: "Use the form <code>Text | https://link</code> or <code>Text | app</code>." };
  const t = raw.slice(0, bar).trim();
  let u = raw.slice(bar + 1).trim();
  if (![...t].length) return { ok: false, error: "The button needs a text before the |." };
  if ([...t].length > MAX_BUTTON_TEXT) return { ok: false, error: `The button text can be at most ${MAX_BUTTON_TEXT} characters (this one has ${[...t].length}).` };
  if (/^app$/i.test(u)) {
    if (!appUrl) return { ok: false, error: "The Mini App link isn't set up yet, so a button can't open it. Use an https link instead." };
    return { ok: true, t, u: "app" };
  }
  if (/^(t|telegram)\.me\//i.test(u)) u = "https://" + u;
  if (!validHttpsUrl(u)) return { ok: false, error: "The link must be a full <code>https://</code> address (t.me links are fine) or the word <code>app</code>." };
  return { ok: true, t, u };
}

/** The inline keyboard users get: the draft's buttons (one or two per row), then the Open App button if there is one */
export function buildKeyboard(buttons: Btn[], two: boolean, appUrl: string, open: unknown | null): { inline_keyboard: unknown[][] } | undefined {
  const items = buttons
    .filter((b) => b.u !== "app" || appUrl)
    .map((b) => ({ text: b.t, ...(b.u === "app" ? { web_app: { url: appUrl } } : { url: b.u }), ...(b.s ? { style: b.s } : {}) }));
  const rows: unknown[][] = [];
  for (let i = 0; i < items.length; i += two ? 2 : 1) rows.push(items.slice(i, i + (two ? 2 : 1)));
  if (open) rows.push([open]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The message for one user

const METHOD: Record<Kind, string> = {
  text: "sendMessage",
  photo: "sendPhoto",
  video: "sendVideo",
  animation: "sendAnimation",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
};

export const withoutCustomEmoji = (c: Content): Content => ({ ...c, entities: c.entities.filter((e) => e.type !== "custom_emoji") });

/**
 * Telegram method and parameters (without chat_id) that deliver the content to one user. Formatting travels as
 * entities, never as parse_mode, so what the admin wrote arrives exactly as written.
 */
export function messageRequest(c: Content, name: string, markup?: unknown): { method: string; params: Record<string, unknown> } {
  const p = personalize(c.text, c.entities, name, c.kind === "text" ? TEXT_LIMIT : CAPTION_LIMIT);
  const params: Record<string, unknown> = {};
  if (c.kind === "text") {
    params.text = p.text;
    if (p.entities.length) params.entities = p.entities;
    if (c.preview) params.link_preview_options = c.preview;
  } else {
    params[c.kind] = c.file;
    if (p.text) {
      params.caption = p.text;
      if (p.entities.length) params.caption_entities = p.entities;
      if (c.above && (c.kind === "photo" || c.kind === "video" || c.kind === "animation")) params.show_caption_above_media = true;
    }
    if (c.spoiler && (c.kind === "photo" || c.kind === "video" || c.kind === "animation")) params.has_spoiler = true;
  }
  if (markup) params.reply_markup = markup;
  return { method: METHOD[c.kind], params };
}

const PREVIEW_KEYS = ["is_disabled", "url", "prefer_small_media", "prefer_large_media", "show_above_text"];

/** The admin's message → a draft's content, or why it can't be used */
export function extractContent(m: any): { ok: true; content: Content } | { ok: false; error: string } {
  if (m.media_group_id) return { ok: false, error: "Albums (several photos or videos in one message) aren't supported. Send a single photo or video." };
  const ents = (v: unknown): Entity[] =>
    Array.isArray(v) ? v.filter((e) => e && typeof e.type === "string" && Number.isInteger(e.offset) && Number.isInteger(e.length) && e.length > 0) : [];
  let kind: Kind;
  let file: string | undefined;
  let text: string;
  let entities: Entity[];
  if (typeof m.text === "string" && m.text) {
    kind = "text";
    text = m.text;
    entities = ents(m.entities);
  } else {
    // A GIF arrives as both animation and document: check animation first
    const media: [MediaKind, any][] = [
      ["photo", Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null],
      ["animation", m.animation],
      ["video", m.video],
      ["document", m.document],
      ["audio", m.audio],
      ["voice", m.voice],
    ];
    const hit = media.find(([, v]) => v && typeof v.file_id === "string");
    if (!hit) return { ok: false, error: "That type isn't supported (stickers, polls, locations, contacts, round videos and so on). Send text, or a photo, video, GIF, document, audio or voice message." };
    kind = hit[0];
    file = hit[1].file_id;
    text = typeof m.caption === "string" ? m.caption : "";
    entities = ents(m.caption_entities);
  }
  const limit = kind === "text" ? TEXT_LIMIT : CAPTION_LIMIT;
  if (text.length > limit) return { ok: false, error: `That ${kind === "text" ? "message" : "caption"} is too long (${groupInt(text.length)} of ${groupInt(limit)} characters).` };
  const content: Content = { kind, text, entities };
  if (file) content.file = file;
  if (kind === "text" && m.link_preview_options && typeof m.link_preview_options === "object") {
    const preview: Record<string, unknown> = {};
    for (const k of PREVIEW_KEYS) if (m.link_preview_options[k] !== undefined) preview[k] = m.link_preview_options[k];
    if (Object.keys(preview).length) content.preview = preview;
  }
  if (m.has_media_spoiler) content.spoiler = true;
  if (m.show_caption_above_media) content.above = true;
  return { ok: true, content };
}

/** Saved draft JSON → a draft, or null if it is missing or damaged */
export function readDraft(raw: string | null | undefined): Draft | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || !v.c || !(v.c.kind in KIND_LABEL) || typeof v.c.text !== "string" || !Array.isArray(v.c.entities)) return null;
    return { c: v.c, b: Array.isArray(v.b) ? v.b : [], two: !!v.two, app: v.app !== false, ...(v.pend ? { pend: v.pend } : {}) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running broadcast: state and its transitions

export interface BroadcastState {
  /** The admin's chat that started it (its status card lives here) */
  chat: number;
  /** Message id of the live status card in that chat */
  card?: number;
  /** What to send (broadcasts started before this version only have `msg`: a message in `chat` to copy) */
  c?: Content;
  b?: Btn[];
  two?: boolean;
  app?: boolean;
  msg?: number;
  /** Last user id done (users are sent in id order) */
  cursor: number;
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  startedAt: number;
  /** Rate-limited by Telegram: pause until */
  waitUntil?: number;
  paused?: number;
  pausedAt?: number;
  /** Seconds spent paused so far (not counting the current pause) */
  pausedFor?: number;
  lastError?: string;
}

export type StatePatch = Partial<Pick<BroadcastState, "card" | "cursor" | "sent" | "blocked" | "failed" | "waitUntil" | "paused" | "pausedAt" | "pausedFor" | "lastError">>;

export function readBroadcast(raw: string): BroadcastState | null {
  try {
    const v = raw ? (JSON.parse(raw) as BroadcastState) : null;
    if (!v || typeof v.chat !== "number" || typeof v.startedAt !== "number") return null;
    if (typeof v.msg !== "number" && !(v.c && v.c.kind in KIND_LABEL)) return null;
    return { ...v, cursor: v.cursor || 0, total: v.total || 0, sent: v.sent || 0, blocked: v.blocked || 0, failed: v.failed || 0 };
  } catch {
    return null;
  }
}

export const applyPatch = (b: BroadcastState, p: StatePatch): BroadcastState => ({ ...b, ...p });

/** Pause: null when it is already paused */
export function pausePatch(b: BroadcastState, now: number): StatePatch | null {
  return b.paused ? null : { paused: 1, pausedAt: now };
}

/** Resume: null when it is not paused. The time spent paused is added up so the ETA and the duration ignore it. */
export function resumePatch(b: BroadcastState, now: number): StatePatch | null {
  return b.paused ? { paused: 0, pausedFor: (b.pausedFor ?? 0) + Math.max(0, now - (b.pausedAt ?? now)), pausedAt: 0, waitUntil: 0, lastError: "" } : null;
}

/** True when the cron job should be doing sends (not paused, not waiting for Telegram) */
export const isSending = (b: BroadcastState, now: number) => !b.paused && !(b.waitUntil && b.waitUntil > now);

/** Every send of the first batch failed for reasons other than the user: something is wrong with the message, so stop and tell the admin */
export const shouldAutoPause = (b: BroadcastState) => b.sent === 0 && b.failed >= BROADCAST_BATCH;

/** The last batch was reached: fewer users than a full batch came back and Telegram didn't ask us to wait */
export const isLastBatch = (rows: number, completed: boolean, waiting: boolean) => completed && !waiting && rows < BROADCAST_BATCH;

/** Should the cron job leave other Telegram-heavy jobs alone? Yes while a broadcast is sending (a paused one makes no calls) */
export const broadcastBusy = (raw: string) => {
  const b = readBroadcast(raw);
  return !!b && !b.paused;
};

// ---------------------------------------------------------------------------------------------------------------
// Numbers and text for progress

export const doneCount = (b: Pick<BroadcastState, "sent" | "blocked" | "failed">) => b.sent + b.blocked + b.failed;

export function pctDone(b: Pick<BroadcastState, "sent" | "blocked" | "failed" | "total">): number {
  return b.total > 0 ? Math.min(100, Math.floor((doneCount(b) / b.total) * 100)) : 100;
}

/** ▓▓▓▓▓░░░░░ */
export function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Seconds the broadcast has really been sending (pauses excluded) */
export function activeSeconds(b: BroadcastState, now: number): number {
  const paused = (b.pausedFor ?? 0) + (b.paused ? Math.max(0, now - (b.pausedAt ?? now)) : 0);
  return Math.max(0, now - b.startedAt - paused);
}

/** Seconds left. Measured from the real rate once a batch or more is done, otherwise from the batch size per minute. */
export function etaSeconds(b: BroadcastState, now: number): number {
  const remaining = Math.max(0, b.total - doneCount(b));
  const done = doneCount(b);
  const active = activeSeconds(b, now);
  if (done >= BROADCAST_BATCH && active > 0) return Math.ceil((remaining * active) / done);
  return Math.ceil(remaining / BROADCAST_BATCH) * 60;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** "22 Oct 14:05 UTC" */
export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
export const fmtClock = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
};

export const num = groupInt;

/** Telegram's answer means this user can't receive messages from the bot any more */
export const isBlocked = (message: string) => /\b403\b|blocked|deactivated|chat not found|user not found/i.test(message);
