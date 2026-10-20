// Telegram Mini App initData validation (HMAC-SHA256 with the bot token).
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface InitData {
  user: TgUser;
  authDate: number;
  startParam: string | null;
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const sha256Hex = async (s: string): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** HMAC-SHA256 as hex, with a text key (e.g. the bot token) */
export async function hmacHex(key: string, data: string): Promise<string> {
  return toHex(await hmac(enc.encode(key), data));
}

/** base64url without padding (setup tokens) */
export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Random string from an unambiguous lower-case alphabet (claim codes), via rejection-free modulo on 256 % 32 = 0 */
export function randomCode(length: number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789_"; // 32 symbols: no 0/o/1/i/l look-alikes
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % 32]).join("");
}

/** Returns the parsed data, or null if the signature is wrong or the data is older than maxAgeSec. */
export async function validateInitData(
  raw: string,
  botToken: string,
  maxAgeSec = 86400,
  now = Math.floor(Date.now() / 1000),
): Promise<InitData | null> {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secret, checkString));
  if (!timingSafeEqual(expected, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || now - authDate > maxAgeSec) return null;
  const userJson = params.get("user");
  if (!userJson) return null;
  const user = JSON.parse(userJson) as TgUser;
  if (!user?.id) return null;
  return { user, authDate, startParam: params.get("start_param") };
}

/** HMAC-SHA256 hex of `${timestamp}.${body}` — NotPanel webhook signature */
export async function notpanelSignature(secret: string, timestamp: string, body: string): Promise<string> {
  return toHex(await hmac(enc.encode(secret), `${timestamp}.${body}`));
}

let derivedSecret: { token: string; value: string } | null = null;

/**
 * Secret Telegram sends back with every webhook call. TG_WEBHOOK_SECRET wins when set (keeps an already registered
 * webhook working); otherwise it is derived from the bot token, so nothing extra has to be configured.
 */
export async function webhookSecret(env: { BOT_TOKEN: string; TG_WEBHOOK_SECRET?: string }): Promise<string> {
  if (env.TG_WEBHOOK_SECRET) return env.TG_WEBHOOK_SECRET;
  if (derivedSecret?.token !== env.BOT_TOKEN) derivedSecret = { token: env.BOT_TOKEN, value: await hmacHex(env.BOT_TOKEN, "notbot-webhook") };
  return derivedSecret.value;
}

/** Setup session token: base64url(JSON {exp}) "." HMAC-SHA256 hex, keyed by the bot token. */
export async function signSetupToken(botToken: string, now = Math.floor(Date.now() / 1000), ttlSec = 1800): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ exp: now + ttlSec })));
  return `${payload}.${await hmacHex(botToken, `notbot-setup:${payload}`)}`;
}

export async function verifySetupToken(botToken: string, token: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return false;
  const expected = await hmacHex(botToken, `notbot-setup:${payload}`);
  if (!timingSafeEqual(expected, sig)) return false;
  const raw = b64urlDecode(payload);
  if (!raw) return false;
  try {
    const exp = (JSON.parse(new TextDecoder().decode(raw)) as { exp?: unknown }).exp;
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}
