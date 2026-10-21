import { Hono } from "hono";
import { LANGS, pickLang } from "../shared/types";
import { timingSafeEqual } from "./auth";
import { sendPreviews } from "./botMessages";
import { checkChannel, retryReferrals } from "./growth";
import { connectAll, syncBotTexts } from "./connect";
import { ownerIds } from "./env";
import { mediaResponse } from "./assets";
import { pub, setup } from "./routes/setup";
import { getSettings } from "./settings";
import { emojiFallbacks, tg } from "./telegram";
import type { Env } from "./env";
import { pollOpenOrders } from "./orders";
import { cleanupPendingPayments } from "./payments";
import { admin } from "./routes/admin";
import { app as api } from "./routes/app";
import { bot } from "./routes/bot";
import { cleanupWebhookEvents, hooks } from "./routes/hooks";
import { checkNotPanelBalance } from "./alerts";
import { broadcastTick } from "./broadcast";
import { commandsTick } from "./commands";
import { ensureSchema } from "./migrate";
import { cleanupRateLimits } from "./rateLimit";
import { syncTick } from "./sync";

api.route("/admin", admin);

const app = new Hono<{ Bindings: Env }>();

// Creates or updates the database tables before anything uses them (once per isolate, see worker/migrate.ts)
app.use("*", async (c, next) => {
  await ensureSchema(c.env);
  await next();
});

/** /setup routes only exist when SETUP_SECRET is set, and only answer to that exact secret. */
const setupOk = (env: Env, given: string) => !!env.SETUP_SECRET && timingSafeEqual(given, env.SETUP_SECRET);
// Public + first-run setup endpoints answer before the Telegram-authenticated /api app sees the request
app.route("/api", pub);
app.route("/api/setup", setup);
app.route("/api", api);
app.get("/media/:kind", (c) => mediaResponse(c.env, c.req.param("kind"), c.req.query("v")));
app.route("/bot", bot);
app.route("/hooks", hooks);

/** One-time setup after deploy: open https://<your-app>/setup/<SETUP_SECRET> in a browser. */
app.get("/setup/:secret", async (c) => {
  if (!setupOk(c.env, c.req.param("secret"))) return c.text("Not found", 404);
  try {
    const r = await connectAll(c.env, new URL(c.req.url).origin);
    return c.json({ ok: true, ...r, next: "Open your bot in Telegram and press Start. The first price sync starts within a minute and takes about 20 minutes." });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** Sets command menus, About text and descriptions in all languages: /setup/<secret>/texts/0, then /texts/1 */
app.get("/setup/:secret/texts/:batch", async (c) => {
  if (!setupOk(c.env, c.req.param("secret"))) return c.text("Not found", 404);
  try {
    return c.json({ ok: true, next: await syncBotTexts(c.env, Number(c.req.param("batch")) || 0) });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** Sends every bot message type to the owner(s) as a preview: /setup/<SETUP_SECRET>/preview[?lang=ru] */
app.get("/setup/:secret/preview", async (c) => {
  if (!setupOk(c.env, c.req.param("secret"))) return c.text("Not found", 404);
  const lang = pickLang(c.req.query("lang"));
  const owners = ownerIds(c.env, await getSettings(c.env));
  let sent = 0;
  const before = emojiFallbacks.count;
  for (const id of owners) {
    const u = await c.env.DB.prepare("SELECT first_name FROM users WHERE id = ?1").bind(id).first<{ first_name: string }>();
    sent += await sendPreviews(c.env, id, lang, u?.first_name ?? "", LANGS);
  }
  const fallbacks = emojiFallbacks.count - before;
  return c.json({ ok: true, owners: owners.length, sent, customEmoji: fallbacks ? `refused ${fallbacks}x: ${emojiFallbacks.last}` : "accepted" });
});

/** Checks the bot can see the update channel and is an admin there: /setup/<SETUP_SECRET>/channel */
app.get("/setup/:secret/channel", async (c) => {
  if (!setupOk(c.env, c.req.param("secret"))) return c.text("Not found", 404);
  const s = await getSettings(c.env, { fresh: true });
  try {
    const chat = await tg<{ id: number; title: string; type: string }>(c.env.BOT_TOKEN, "getChat", { chat_id: s.channel_id });
    const me = await tg<{ id: number }>(c.env.BOT_TOKEN, "getMe");
    const bot = await tg<{ status: string }>(c.env.BOT_TOKEN, "getChatMember", { chat_id: s.channel_id, user_id: me.id });
    const owners = ownerIds(c.env, s);
    const ownerCheck = owners.length ? await checkChannel(c.env, s, owners[0]) : null;
    return c.json({ ok: true, channel: { id: chat.id, title: chat.title, type: chat.type }, botStatus: bot.status, ownerMembership: ownerCheck });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.onError((e, c) => {
  console.error(e);
  return c.json({ error: "INTERNAL", code: "INTERNAL" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    try {
      await ensureSchema(env);
    } catch (e) {
      console.error("database setup failed", e);
      return;
    }
    const jobs: Promise<unknown>[] = [pollOpenOrders(env), syncTick(env), commandsTick(env), retryReferrals(env), broadcastTick(env)];
    // Hourly housekeeping (minute :07) so the every-minute run stays light
    if (new Date(controller.scheduledTime).getUTCMinutes() === 7) jobs.push(cleanupWebhookEvents(env), cleanupPendingPayments(env), cleanupRateLimits(env), checkNotPanelBalance(env));
    ctx.waitUntil(
      Promise.allSettled(jobs).then((rs) => {
        for (const r of rs) if (r.status === "rejected") console.error("cron job failed", r.reason);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
