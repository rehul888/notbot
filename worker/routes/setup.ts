// Public endpoints: /api/public (what a browser opening the app needs) and /api/setup/* (the first-run wizard).
// The wizard is useless without the bot token: unlock compares it with the BOT_TOKEN secret and hands back a signed,
// 30-minute session token. Once setup is done and an admin exists, every setup endpoint answers 403 SETUP_DONE.
import { Hono, type Context } from "hono";
import { LIMITS, validBrandName } from "../../shared/brand";
import type { PublicStatus, SetupStatus, SetupStep } from "../../shared/brand";
import { sha256Hex, signSetupToken, timingSafeEqual, verifySetupToken } from "../auth";
import { bytesToBase64, detectImageMime } from "../assets";
import { brandInfo } from "../brand";
import { claimLink, createClaimCode } from "../claim";
import { setAllCommands } from "../commands";
import { registerNotPanelWebhook, setMenuButton, setTelegramWebhook, syncBotTexts } from "../connect";
import { type Env, ownerIds } from "../env";
import { npKey, verifyNotPanelKey, type KeyCheck } from "../notpanel";
import { isLimited, recordFailure } from "../rateLimit";
import { bustSettings, getSettings, setSettings, type Settings } from "../settings";
import { tg } from "../telegram";
import { type AppEnv, err, readBody } from "./app";

export const SETUP_STEPS: SetupStep[] = ["webhook", "menu", "texts0", "texts1", "commands"];
export const UNLOCK_MAX_FAILURES = 20; // wrong bot tokens per IP address per hour

type SetupCtx = Context<{ Bindings: Env }>;
const fail = (c: SetupCtx, status: number, code: string, details?: Record<string, unknown>) => err(c as unknown as Context<AppEnv>, status, code, details);

/** Setup is over once it finished and somebody is an admin */
export const setupClosed = (env: Env, s: Settings) => s.setup_done === 1 && ownerIds(env, s).length > 0;

/** Telegram and NotPanel error texts never contain secrets, but make sure of it before anything leaves the Worker */
function redact(env: Env, s: Settings, msg: string): string {
  let out = msg;
  for (const secret of [env.BOT_TOKEN, npKey(env, s), env.TG_WEBHOOK_SECRET]) if (secret) out = out.split(secret).join("…");
  return out.slice(0, 300);
}

// ---- Public status ----

export const pub = new Hono<{ Bindings: Env }>();

pub.get("/public", async (c) => {
  const s = await getSettings(c.env);
  const body: PublicStatus = {
    brand: brandInfo(s),
    botUsername: s.bot_username || null,
    configured: setupClosed(c.env, s),
  };
  c.header("cache-control", "public, max-age=60");
  return c.json(body);
});

// ---- Setup wizard ----

export const setup = new Hono<{ Bindings: Env }>();

// Setup requests are tiny JSON bodies: refuse anything big before reading it
setup.use("*", async (c, next) => {
  if (Number(c.req.header("content-length") ?? 0) > 4096) return fail(c, 413, "TOO_LARGE");
  await next();
});

/** NotPanel check of the effective key, remembered for a minute (it costs two NotPanel requests) */
let keyMemo: { key: string; at: number; result: KeyCheck } | null = null;
export async function checkEffectiveKey(env: Env, s: Settings): Promise<KeyCheck> {
  const key = npKey(env, s);
  if (!key) return { ok: false, code: "NOT_NOTPANEL_KEY", message: "No NotPanel API key yet." };
  if (keyMemo && keyMemo.key === key && Date.now() - keyMemo.at < 60_000) return keyMemo.result;
  const result = await verifyNotPanelKey(key);
  keyMemo = { key, at: Date.now(), result };
  return result;
}

const doneSteps = (s: Settings) => new Set(s.setup_steps.split(",").filter(Boolean));

async function buildStatus(env: Env, s: Settings, opts: { issueClaim?: boolean } = {}): Promise<SetupStatus> {
  const me = await tg<{ username?: string; first_name?: string }>(env.BOT_TOKEN, "getMe").catch(() => null);
  const key = await checkEffectiveKey(env, s);
  const done = doneSteps(s);
  const pending = SETUP_STEPS.filter((st) => !done.has(st));
  const ownerReady = ownerIds(env, s).length > 0;
  const botUsername = me?.username ?? (s.bot_username || null);
  // The plain claim code exists only at creation, so a link is issued when the wizard reaches its end (or is re-opened there)
  const claim = opts.issueClaim && !ownerReady && !pending.length && botUsername ? claimLink(botUsername, await createClaimCode(env)) : null;
  return {
    botUsername,
    botName: me?.first_name ?? null,
    notpanelOk: key.ok,
    notpanelError: key.ok ? null : redact(env, s, key.message),
    pending,
    ownerReady,
    claimLink: claim,
  };
}

/** Valid setup token and setup not finished, else the error response */
async function guard(c: SetupCtx): Promise<{ s: Settings } | Response> {
  const token = c.req.header("x-setup-token") ?? "";
  if (!token || !(await verifySetupToken(c.env.BOT_TOKEN, token))) return fail(c, 401, "INVALID_SETUP_TOKEN");
  const s = await getSettings(c.env, { fresh: true });
  if (setupClosed(c.env, s)) return fail(c, 403, "SETUP_DONE");
  return { s };
}

setup.post("/unlock", async (c) => {
  const b = await readBody<{ botToken?: unknown }>(c);
  if (!b || typeof b.botToken !== "string" || b.botToken.length > 200) return fail(c, 400, "INVALID_BODY");
  // Cached settings first: a finished install answers without touching the database
  if (setupClosed(c.env, await getSettings(c.env)) || setupClosed(c.env, await getSettings(c.env, { fresh: true }))) return fail(c, 403, "SETUP_DONE");
  // Wrong tokens are limited per IP address (a correct token is never refused), so nobody can lock the owner out
  const limitKey = `setup:ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
  if (await isLimited(c.env, limitKey, UNLOCK_MAX_FAILURES, 3600)) return fail(c, 429, "TOO_MANY_ATTEMPTS");
  // Compare fixed-length digests so neither the content nor the length of the real token can leak through timing
  const [given, real] = await Promise.all([sha256Hex(b.botToken.trim()), sha256Hex(c.env.BOT_TOKEN)]);
  if (!c.env.BOT_TOKEN || !timingSafeEqual(given, real)) {
    await recordFailure(c.env, limitKey, 3600);
    return fail(c, 403, "WRONG_BOT_TOKEN");
  }
  bustSettings();
  const fresh = await getSettings(c.env, { fresh: true });
  return c.json({ token: await signSetupToken(c.env.BOT_TOKEN), status: await buildStatus(c.env, fresh, { issueClaim: true }) });
});

setup.get("/status", async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  return c.json(await buildStatus(c.env, g.s));
});

setup.post("/notpanel-key", async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const b = await readBody<{ key?: unknown }>(c);
  if (!b || typeof b.key !== "string" || b.key.length > 200) return fail(c, 400, "INVALID_BODY");
  const key = b.key.trim();
  const check = await verifyNotPanelKey(key);
  if (!check.ok) return fail(c, 400, check.code, { message: check.message });
  await setSettings(c.env, { np_api_key: key });
  keyMemo = { key, at: Date.now(), result: check };
  return c.json(await buildStatus(c.env, await getSettings(c.env, { fresh: true })));
});

setup.post("/run", async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  let s = g.s;
  const b = await readBody<{ step?: unknown }>(c);
  const step = b?.step;
  if (typeof step !== "string" || !SETUP_STEPS.includes(step as SetupStep)) return fail(c, 400, "INVALID_STEP");
  const origin = new URL(c.req.url).origin;
  if (step === "webhook" && !(await checkEffectiveKey(c.env, s)).ok) return fail(c, 400, "NOTPANEL_REQUIRED");
  try {
    await runStep(c.env, s, step as SetupStep, origin);
  } catch (e) {
    console.error("setup step failed", step, redact(c.env, s, (e as Error).message));
    return fail(c, 400, "STEP_FAILED", { step, message: redact(c.env, s, (e as Error).message) });
  }
  const done = doneSteps(s);
  done.add(step);
  const finished = SETUP_STEPS.every((st) => done.has(st));
  await setSettings(c.env, { setup_steps: SETUP_STEPS.filter((st) => done.has(st)).join(","), ...(finished ? { setup_done: 1 } : {}) });
  s = await getSettings(c.env, { fresh: true });
  return c.json(await buildStatus(c.env, s, { issueClaim: finished }));
});

async function runStep(env: Env, s: Settings, step: SetupStep, origin: string): Promise<void> {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) throw new Error("Open this page over https");
  switch (step) {
    case "webhook": {
      await setTelegramWebhook(env, origin);
      const wh = await registerNotPanelWebhook(env, s, origin);
      if (wh.values) await setSettings(env, wh.values);
      else console.warn("setup: NotPanel webhook not registered, the cron job covers order updates", wh.error);
      return;
    }
    case "menu": {
      const me = await setMenuButton(env, origin);
      const name = me.firstName.trim().slice(0, LIMITS.brandName);
      if (!s.brand_name.trim() && validBrandName(name)) await setSettings(env, { brand_name: name });
      if (s.logo_ver === 0) await saveBotPhotoAsLogo(env, me.id).catch((e) => console.warn("setup: bot photo skipped", (e as Error).message));
      return;
    }
    case "texts0":
      await syncBotTexts(env, 0, "texts");
      return;
    case "texts1":
      await syncBotTexts(env, 1, "texts");
      return;
    case "commands":
      await setAllCommands(env);
      return;
  }
}

/** The bot's own profile photo becomes the default logo (best effort: bots often have no readable photo) */
async function saveBotPhotoAsLogo(env: Env, botId: number): Promise<void> {
  const res = await tg<{ photos?: { file_id: string; file_size?: number; width: number }[][] }>(env.BOT_TOKEN, "getUserProfilePhotos", { user_id: botId, limit: 1 });
  const best = (res.photos?.[0] ?? []).filter((p) => (p.file_size ?? 0) <= LIMITS.imageBytes).sort((a, b) => b.width - a.width)[0];
  if (!best) return;
  const file = await tg<{ file_path?: string }>(env.BOT_TOKEN, "getFile", { file_id: best.file_id });
  if (!file.file_path || !/^[\w./-]+$/.test(file.file_path) || file.file_path.includes("..")) return;
  const dl = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!dl.ok || Number(dl.headers.get("content-length") ?? 0) > LIMITS.imageBytes) return;
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const mime = detectImageMime(bytes);
  if (!mime || bytes.length > LIMITS.imageBytes) return;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO assets (kind, mime, data, updated_at) VALUES ('logo', ?1, ?2, ?3)").bind(mime, bytesToBase64(bytes), Math.floor(Date.now() / 1000)),
    env.DB.prepare("INSERT INTO settings (key, value) SELECT 'logo_ver', '1' WHERE changes() = 1 ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  ]);
  bustSettings();
}
