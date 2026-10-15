// Minimal Telegram Bot API client.

/** Custom emoji icons on buttons (need the bot owner's Telegram Premium). */
export const OPEN_ICON_EMOJI_ID = "5332336747072208845";
export const VIEW_ORDER_ICON_EMOJI_ID = "5235588635885054955";

export const TERMS_ICON_EMOJI_ID = "5956561916573782596";
export const INVITE_ICON_EMOJI_ID = "6032937473162614352";

/**
 * Owner's Premium custom emojis for bot messages: each plain emoji in an HTML message becomes
 * <tg-emoji emoji-id="…">emoji</tg-emoji> (the plain emoji stays as the fallback). Works for every language
 * because the templates use the same emojis.
 */
const CUSTOM_EMOJI: Record<string, string> = {
  "👋": "5267029566018299013", // welcome
  "🚀": "6298548743352355181", // what you can get / order placed
  "👥": "5942877472163892475", // followers & members
  "👁": "5960714428394507968", // views
  "❤": "5874948844935974490", // likes & reactions (owner's star emoji)
  "💬": "5884510167986343350", // comments / support
  "📊": "5231200819986047254", // live tracking
  "👇": "5301038027601098171", // tap Open App
  "🌐": "5879585266426973039", // choose language
  "🧾": "5444856076954520455", // order number
  "📦": "5924720918826848520", // service
  "🔗": "5877465816030515018", // link
  "⏱": "5123230779593196220", // we'll message you
  "✅": "5985596818912712352", // completed
  "🎉": "5994502837327892086", // thanks
  "🟡": "5332345843812943191", // partly delivered
  "⚠": "5881702736843511327", // couldn't start
  "💸": "5897958754267174109", // refunded
  "⭐": "5258039825805624495", // Stars / payment
  "💰": "5987880246865565644", // amount added
  "👛": "5769403330761593044", // balance
  "ℹ": "5922612721244704425", // help
  "📄": TERMS_ICON_EMOJI_ID, // terms
  "🎁": INVITE_ICON_EMOJI_ID, // referral bonus
  "👤": "5879770735999717115", // friend who joined
};
const EMOJI_RE = new RegExp(`(${Object.keys(CUSTOM_EMOJI).join("|")})\uFE0F?`, "gu");

export function withCustomEmoji(html: string): string {
  return html.replace(EMOJI_RE, (m, base: string) => `<tg-emoji emoji-id="${CUSTOM_EMOJI[base]}">${m}</tg-emoji>`);
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

/** Blue button that opens the Mini App, with a custom emoji icon and an upper-case label ("OPEN APP"). */
export function webAppButton(text: string, url: string, icon: string = OPEN_ICON_EMOJI_ID) {
  return { text: text.toLocaleUpperCase(), web_app: { url }, style: "primary", icon_custom_emoji_id: icon };
}
