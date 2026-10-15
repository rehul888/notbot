// Minimal Telegram Bot API client.

/** Custom emoji icons on buttons (need the bot owner's Telegram Premium). */
export const OPEN_ICON_EMOJI_ID = "5332336747072208845";
export const VIEW_ORDER_ICON_EMOJI_ID = "5235588635885054955";

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
  let data = await call<T>(token, method, params);
  // A custom-emoji button icon can be refused (e.g. Premium lapsed): send the message without icons instead of failing.
  if (!data.ok && params.reply_markup && /emoji|icon/i.test(data.description ?? "")) {
    console.warn(`Telegram ${method}: retrying without button icons (${data.description})`);
    data = await call<T>(token, method, { ...params, reply_markup: stripIcons(params.reply_markup) });
  }
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Blue button that opens the Mini App, with a custom emoji icon and an upper-case label ("OPEN APP"). */
export function webAppButton(text: string, url: string, icon: string = OPEN_ICON_EMOJI_ID) {
  return { text: text.toLocaleUpperCase(), web_app: { url }, style: "primary", icon_custom_emoji_id: icon };
}
