import { Hono } from "hono";
import { LANGS, pickLang } from "../shared/types";
import { timingSafeEqual } from "./auth";
import { sendPreviews } from "./botMessages";
import { checkChannel } from "./growth";
import { getSettings } from "./settings";
import { tg } from "./telegram";
import type { Env } from "./env";
import { pollOpenOrders } from "./orders";
import { admin, connectAll, syncBotTexts } from "./routes/admin";
import { app as api } from "./routes/app";
import { bot } from "./routes/bot";
import { hooks } from "./routes/hooks";
import { syncTick } from "./sync";

api.route("/admin", admin);

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);
app.route("/bot", bot);
app.route("/hooks", hooks);

/** One-time setup after deploy: open https://<your-app>/setup/<TG_WEBHOOK_SECRET> in a browser. */
app.get("/setup/:secret", async (c) => {
  if (!timingSafeEqual(c.req.param("secret"), c.env.TG_WEBHOOK_SECRET)) return c.text("Not found", 404);
  try {
    const r = await connectAll(c.env, new URL(c.req.url).origin);
    return c.json({ ok: true, ...r, next: "Open your bot in Telegram and press Start. The first price sync starts within a minute and takes about 20 minutes." });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** Sets command menus, About text and descriptions in all languages: /setup/<secret>/texts/0, then /texts/1 */
app.get("/setup/:secret/texts/:batch", async (c) => {
  if (!timingSafeEqual(c.req.param("secret"), c.env.TG_WEBHOOK_SECRET)) return c.text("Not found", 404);
  try {
    return c.json({ ok: true, next: await syncBotTexts(c.env, Number(c.req.param("batch")) || 0) });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** Sends every bot message type to the owner(s) as a preview: /setup/<TG_WEBHOOK_SECRET>/preview[?lang=ru] */
app.get("/setup/:secret/preview", async (c) => {
  if (!timingSafeEqual(c.req.param("secret"), c.env.TG_WEBHOOK_SECRET)) return c.text("Not found", 404);
  const lang = pickLang(c.req.query("lang"));
  const owners = c.env.OWNER_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean);
  let sent = 0;
  for (const id of owners) {
    const u = await c.env.DB.prepare("SELECT first_name FROM users WHERE id = ?1").bind(id).first<{ first_name: string }>();
    sent += await sendPreviews(c.env, id, lang, u?.first_name ?? "", LANGS);
  }
  return c.json({ ok: true, owners: owners.length, sent });
});

/** Checks the bot can see the update channel and is an admin there: /setup/<TG_WEBHOOK_SECRET>/channel */
app.get("/setup/:secret/channel", async (c) => {
  if (!timingSafeEqual(c.req.param("secret"), c.env.TG_WEBHOOK_SECRET)) return c.text("Not found", 404);
  const s = await getSettings(c.env, { fresh: true });
  try {
    const chat = await tg<{ id: number; title: string; type: string }>(c.env.BOT_TOKEN, "getChat", { chat_id: s.channel_id });
    const me = await tg<{ id: number }>(c.env.BOT_TOKEN, "getMe");
    const bot = await tg<{ status: string }>(c.env.BOT_TOKEN, "getChatMember", { chat_id: s.channel_id, user_id: me.id });
    const owners = c.env.OWNER_IDS.split(",").map((x) => Number(x.trim())).filter(Boolean);
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
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.allSettled([pollOpenOrders(env), syncTick(env)]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
