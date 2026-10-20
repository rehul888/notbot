// Minimal Telegram Bot API client.

import type { ButtonIcons } from "../shared/brand";

/** Plain emoji keys only (non-ASCII, so a key can never match markup or letters) */
const EMOJI_KEY = /^[^\u0000-\u007f]{1,8}$/u;

interface EmojiSet {
  map: Record<string, string>;
  re: RegExp | null;
}

function compileEmoji(input: Record<string, string>): EmojiSet {
  const map: Record<string, string> = {};
  for (const [k, id] of Object.entries(input)) if (EMOJI_KEY.test(k) && /^\d{10,25}$/.test(id)) map[k] = id;
  const keys = Object.keys(map).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { map, re: keys.length ? new RegExp(`(${keys.join("|")})\uFE0F?`, "gu") : null };
}

/**
 * Optional Telegram Premium extras, set by the owner in the admin panel (settings custom_emoji / button_icons) and
 * applied by worker/settings.ts whenever settings load. Default: none, so every plain emoji stays a plain emoji.
 */
let current: EmojiSet = { map: {}, re: null };
let buttonIcons: Partial<ButtonIcons> = {};

export function setCustomization(emoji: Record<string, string>, icons: Partial<ButtonIcons>): void {
  current = compileEmoji(emoji);
  buttonIcons = icons;
}

/** Wraps each configured plain emoji as <tg-emoji emoji-id="…">emoji</tg-emoji> (the plain emoji stays as fallback). */
export function withCustomEmoji(html: string, emoji?: Record<string, string>): string {
  const { map, re } = emoji ? compileEmoji(emoji) : current;
  if (!re) return html;
  return html.replace(re, (m, base: string) => `<tg-emoji emoji-id="${map[base]}">${m}</tg-emoji>`);
}

/** Per-isolate count of messages Telegram only accepted without custom emojis (shown by the owner preview). */
export const emojiFallbacks = { count: 0, last: "" };

const stripCustomEmoji = (html: string) => html.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1");

function stripIcons(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIcons);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "icon_custom_emoji_id") o[k] = stripIcons(x);
    return o;
  }
  return v;
}

async function call<T>(token: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
}

export async function tg<T = any>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  // HTML messages and captions get the owner's custom emojis
  if (params.parse_mode === "HTML") {
    params = { ...params };
    if (typeof params.text === "string") params.text = withCustomEmoji(params.text);
    if (typeof params.caption === "string") params.caption = withCustomEmoji(params.caption);
  }
  let data = await call<T>(token, method, params);
  // Custom emojis (in text or as button icons) can be refused, e.g. if Premium lapsed: resend with plain emojis
  // instead of failing.
  if (!data.ok && /emoji|icon|entit/i.test(data.description ?? "")) {
    console.warn(`Telegram ${method}: retrying without custom emojis (${data.description})`);
    emojiFallbacks.count++;
    emojiFallbacks.last = data.description ?? "";
    const plain: Record<string, unknown> = { ...params };
    if (plain.reply_markup) plain.reply_markup = stripIcons(plain.reply_markup);
    if (typeof plain.text === "string") plain.text = stripCustomEmoji(plain.text);
    if (typeof plain.caption === "string") plain.caption = stripCustomEmoji(plain.caption);
    data = await call<T>(token, method, plain);
  }
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Blue button that opens the Mini App, with an upper-case label ("OPEN APP") and the owner's button icon if one is set. */
export function webAppButton(text: string, url: string, icon: keyof ButtonIcons = "open") {
  const id = buttonIcons[icon];
  return { text: text.toLocaleUpperCase(), web_app: { url }, style: "primary", ...(id ? { icon_custom_emoji_id: id } : {}) };
}

/** Same look for a button that opens an external link */
export function linkButton(text: string, url: string, icon: keyof ButtonIcons = "terms") {
  const id = buttonIcons[icon];
  return { text, url, style: "primary", ...(id ? { icon_custom_emoji_id: id } : {}) };
}
