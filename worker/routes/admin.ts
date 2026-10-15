import { Hono } from "hono";
import { platformName } from "../../shared/platforms";
import { LANG_NAMES, LANGS, MICRO, type Lang } from "../../shared/types";
import { sendPreviews } from "../botMessages";
import { botPlain } from "../i18n";
import { MARKUP_SQL, rebuildSummaryStmts, RULE_JOINS } from "../catalog";
import { isOwner } from "../env";
import { np, usdToMicro } from "../notpanel";
import { orderView, type OrderRow } from "../orders";
import { refundPayment } from "../payments";
import { sellRate } from "../pricing";
import { bumpCatalogStmt, DEFAULTS, getSettings, setSettings, setSettingsStmts, type Settings } from "../settings";
import { startSync, syncProgress } from "../sync";
import { tg } from "../telegram";
import { type AppEnv, err } from "./app";

export const admin = new Hono<AppEnv>();

admin.use("*", async (c, next) => {
  if (!isOwner(c.env, c.get("user").id)) return err(c, 403, "FORBIDDEN");
  await next();
});

const dayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

admin.get("/overview", async (c) => {
  const s = c.get("settings");
  const since = dayStart();
  const [today, users, pending, attention] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(charge - refund), 0) AS sales, COALESCE(SUM(charge - refund - COALESCE(cost, 0)), 0) AS profit
       FROM orders WHERE created_at >= ?1 AND status != 'failed'`,
    ).bind(since),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('submitting','pending','processing','in_progress')"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE present = 1 AND enabled = 1 AND fixed_rate IS NOT NULL AND fixed_rate < rate"),
  ]);
  let npBalance: number | null = null;
  let npError: string | null = null;
  try {
    npBalance = usdToMicro((await np<{ balance: string }>(c.env.NOTPANEL_API_KEY, "balance")).balance);
  } catch (e) {
    npError = (e as Error).message;
  }
  const t = today.results[0] as { orders: number; sales: number; profit: number };
  return c.json({
    npBalance,
    npError,
    lowBalance: s.low_balance,
    today: t,
    users: (users.results[0] as { n: number }).n,
    openOrders: (pending.results[0] as { n: number }).n,
    needsAttention: (attention.results[0] as { n: number }).n,
    defaultMarkup: s.default_markup_pct,
    lastSync: s.last_sync_summary ? JSON.parse(s.last_sync_summary) : null,
  });
});

// ---- Settings ----

const EDITABLE: (keyof Settings)[] = [
  "default_markup_pct",
  "stars_per_usd",
  "min_topup",
  "max_topup",
  "sync_enabled",
  "sync_every_hours",
  "auto_enable_new",
  "only_timed",
  "low_balance",
  "support_username",
  "channel_username",
  "terms_text",
];

admin.get("/settings", (c) => {
  const s = c.get("settings");
  return c.json({
    ...Object.fromEntries(EDITABLE.map((k) => [k, s[k]])),
    last_sync_at: s.last_sync_at,
    last_sync_summary: s.last_sync_summary ? JSON.parse(s.last_sync_summary) : null,
    sync: syncProgress(s),
    webhook_connected: !!s.np_webhook_id,
    app_url: s.app_url,
    bot_username: s.bot_username,
    key_hint: c.env.NOTPANEL_API_KEY ? "…" + c.env.NOTPANEL_API_KEY.slice(-4) : null,
  });
});

admin.put("/settings", async (c) => {
  const body = await c.req.json<Partial<Settings>>();
  const values: Partial<Settings> = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    const v = body[k] as never;
    if (typeof DEFAULTS[k] === "number") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return err(c, 400, "INVALID_VALUE", { key: k });
      (values as Record<string, unknown>)[k] = n;
    } else (values as Record<string, unknown>)[k] = String(v).slice(0, 4000);
  }
  if (values.default_markup_pct !== undefined && values.default_markup_pct > 1000) return err(c, 400, "INVALID_VALUE", { key: "default_markup_pct" });
  if (values.sync_every_hours !== undefined && values.sync_every_hours < 1) return err(c, 400, "INVALID_VALUE", { key: "sync_every_hours" });
  if (values.support_username) values.support_username = values.support_username.replace(/^@/, "");
  if (values.channel_username) values.channel_username = values.channel_username.replace(/^@/, "");
  await c.env.DB.batch([...setSettingsStmts(c.env, values), bumpCatalogStmt(c.env)]);
  const s = await getSettings(c.env);
  if (values.default_markup_pct !== undefined) await c.env.DB.batch(rebuildSummaryStmts(c.env, s));
  // The listing filter changed: re-scan the catalog now and drop services that no longer qualify
  if (values.only_timed !== undefined && values.only_timed !== c.get("settings").only_timed) await startSync(c.env, { force: true, strict: true });
  return c.json({ ok: true });
});

admin.post("/sync", async (c) => {
  if (!syncProgress(c.get("settings")).running) await startSync(c.env, { force: true });
  return c.json({ ok: true, ...syncProgress(await getSettings(c.env)) });
});

// ---- Prices: platforms → categories → services ----

admin.get("/platforms", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.platform AS slug, COUNT(*) AS count, SUM(s.enabled) AS enabled, pr.enabled AS rule_enabled, pr.markup_pct
     FROM services s LEFT JOIN category_rules pr ON pr.platform = s.platform AND pr.category = ''
     WHERE s.present = 1 GROUP BY s.platform ORDER BY count DESC`,
  ).all<{ slug: string; count: number; enabled: number; rule_enabled: number | null; markup_pct: number | null }>();
  return c.json(
    results.map((r) => ({
      slug: r.slug,
      name: platformName(r.slug),
      count: r.count,
      enabledServices: r.enabled,
      enabled: r.rule_enabled !== 0,
      markupPct: r.markup_pct,
    })),
  );
});

admin.get("/categories", async (c) => {
  const platform = c.req.query("platform") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT s.category AS name, COUNT(*) AS count, SUM(s.enabled) AS enabled, MIN(s.sort) AS sort, cr.enabled AS rule_enabled, cr.markup_pct
     FROM services s LEFT JOIN category_rules cr ON cr.platform = s.platform AND cr.category = s.category
     WHERE s.present = 1 AND s.platform = ?1 GROUP BY s.category ORDER BY sort`,
  )
    .bind(platform)
    .all<{ name: string; count: number; enabled: number; rule_enabled: number | null; markup_pct: number | null }>();
  return c.json(
    results.map((r) => ({ name: r.name, count: r.count, enabledServices: r.enabled, enabled: r.rule_enabled !== 0, markupPct: r.markup_pct })),
  );
});

/** Platform rule when category is "" — enable/disable or set a markup for a whole platform or category */
admin.put("/rule", async (c) => {
  const b = await c.req.json<{ platform: string; category?: string; enabled?: boolean; markupPct?: number | null }>();
  if (!b.platform) return err(c, 400, "MISSING_PLATFORM");
  const markup = b.markupPct === undefined ? undefined : b.markupPct === null ? null : Number(b.markupPct);
  if (markup !== undefined && markup !== null && (!Number.isFinite(markup) || markup < 0 || markup > 1000)) return err(c, 400, "INVALID_VALUE");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO category_rules (platform, category, enabled, markup_pct) VALUES (?1, ?2, COALESCE(?3, 1), ?4)
       ON CONFLICT(platform, category) DO UPDATE SET enabled = COALESCE(?3, enabled), markup_pct = CASE WHEN ?5 THEN ?4 ELSE markup_pct END`,
    ).bind(b.platform, b.category ?? "", b.enabled === undefined ? null : b.enabled ? 1 : 0, markup ?? null, markup !== undefined ? 1 : 0),
    ...rebuildSummaryStmts(c.env, c.get("settings")),
    bumpCatalogStmt(c.env),
  ]);
  return c.json({ ok: true });
});

admin.get("/services", async (c) => {
  const s = c.get("settings");
  const platform = c.req.query("platform");
  const category = c.req.query("category");
  const q = (c.req.query("q") ?? "").trim();
  const attention = c.req.query("attention") === "1";
  const where = ["s.present = 1"];
  const vals: unknown[] = [s.default_markup_pct];
  if (platform) {
    vals.push(platform);
    where.push(`s.platform = ?${vals.length}`);
  }
  if (category) {
    vals.push(category);
    where.push(`s.category = ?${vals.length}`);
  }
  if (q) {
    vals.push(/^\d+$/.test(q) ? Number(q) : -1, `%${q}%`);
    where.push(`(s.id = ?${vals.length - 1} OR s.name LIKE ?${vals.length} OR s.custom_name LIKE ?${vals.length})`);
  }
  if (attention) where.push("s.fixed_rate IS NOT NULL AND s.fixed_rate < s.rate");
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.custom_name, s.platform, s.category, s.rate, s.min, s.max, s.enabled, s.markup_pct, s.fixed_rate,
       ${MARKUP_SQL} AS markup, (SELECT old_rate FROM price_changes p WHERE p.service_id = s.id ORDER BY p.id DESC LIMIT 1) AS prev_rate
     FROM services s ${RULE_JOINS} WHERE ${where.join(" AND ")} ORDER BY s.sort LIMIT 200`,
  )
    .bind(...vals)
    .all<{
      id: number;
      name: string;
      custom_name: string | null;
      platform: string;
      category: string;
      rate: number;
      min: number;
      max: number;
      enabled: number;
      markup_pct: number | null;
      fixed_rate: number | null;
      markup: number;
      prev_rate: number | null;
    }>();
  return c.json(
    results.map((r) => ({
      id: r.id,
      name: r.name,
      customName: r.custom_name,
      platform: r.platform,
      category: r.category,
      cost: r.rate,
      prevCost: r.prev_rate,
      sell: sellRate(r.rate, r.markup, r.fixed_rate),
      markup: r.markup,
      markupPct: r.markup_pct,
      fixedRate: r.fixed_rate,
      min: r.min,
      max: r.max,
      enabled: !!r.enabled,
    })),
  );
});

admin.put("/services/:id", async (c) => {
  const b = await c.req.json<{ enabled?: boolean; markupPct?: number | null; fixedRate?: number | null; customName?: string | null }>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = ?${vals.length}`);
  };
  if (b.enabled !== undefined) set("enabled", b.enabled ? 1 : 0);
  if (b.markupPct !== undefined) {
    if (b.markupPct !== null && (!Number.isFinite(b.markupPct) || b.markupPct < 0 || b.markupPct > 1000)) return err(c, 400, "INVALID_VALUE");
    set("markup_pct", b.markupPct);
  }
  if (b.fixedRate !== undefined) {
    if (b.fixedRate !== null && (!Number.isFinite(b.fixedRate) || b.fixedRate <= 0)) return err(c, 400, "INVALID_VALUE");
    set("fixed_rate", b.fixedRate === null ? null : Math.round(b.fixedRate));
  }
  if (b.customName !== undefined) set("custom_name", b.customName?.trim() ? b.customName.trim().slice(0, 200) : null);
  if (!sets.length) return c.json({ ok: true });
  vals.push(Number(c.req.param("id")));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals),
    ...rebuildSummaryStmts(c.env, c.get("settings")),
    bumpCatalogStmt(c.env),
  ]);
  return c.json({ ok: true });
});

admin.get("/price-changes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.service_id, p.old_rate, p.new_rate, p.changed_at, s.name, s.platform, s.category
     FROM price_changes p LEFT JOIN services s ON s.id = p.service_id ORDER BY p.id DESC LIMIT 100`,
  ).all();
  return c.json(results);
});

// ---- Payments ----

admin.get("/payments", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.user_id, p.stars, p.amount, p.status, p.order_id, p.paid_at, p.created_at, u.first_name, u.last_name, u.username
     FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.status != 'pending' ORDER BY p.id DESC LIMIT 100`,
  ).all();
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(stars), 0) AS stars, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'paid'",
  ).first();
  return c.json({ items: results, totals });
});

admin.post("/payments/:id/refund", async (c) => {
  const r = await refundPayment(c.env, Number(c.req.param("id")));
  return r.ok ? c.json(r) : err(c, 400, r.error ?? "REFUND_FAILED");
});

// ---- Users ----

admin.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/^@/, "");
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
       (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS paid
     FROM users u ${q ? "WHERE CAST(u.id AS TEXT) = ?1 OR u.username LIKE ?2 OR u.first_name LIKE ?2" : ""}
     ORDER BY u.last_seen_at DESC LIMIT 100`,
  )
    .bind(...(q ? [q, `%${q}%`] : []))
    .all();
  return c.json(results);
});

admin.post("/users/:id/balance", async (c) => {
  const { amount, note } = await c.req.json<{ amount: number; note?: string }>();
  const delta = Math.round(Number(amount) * MICRO);
  if (!Number.isFinite(delta) || delta === 0) return err(c, 400, "INVALID_AMOUNT");
  const id = Number(c.req.param("id"));
  const now = Math.floor(Date.now() / 1000);
  const [upd] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1 AND balance + ?2 >= 0").bind(id, delta),
    c.env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, note, created_at) SELECT ?1, ?2, 'admin', ?3, ?4 WHERE changes() = 1").bind(
      id,
      delta,
      (note ?? "").slice(0, 200) || null,
      now,
    ),
  ]);
  if (!upd.meta.changes) return err(c, 400, "INVALID_AMOUNT");
  return c.json({ ok: true });
});

admin.post("/users/:id/ban", async (c) => {
  const { banned } = await c.req.json<{ banned: boolean }>();
  await c.env.DB.prepare("UPDATE users SET banned = ?2 WHERE id = ?1").bind(Number(c.req.param("id")), banned ? 1 : 0).run();
  return c.json({ ok: true });
});

// ---- Orders ----

admin.get("/orders", async (c) => {
  const status = c.req.query("status");
  const q = (c.req.query("q") ?? "").trim().replace(/^#/, "");
  const where: string[] = [];
  const vals: unknown[] = [];
  if (status === "open") where.push("o.status IN ('submitting','pending','processing','in_progress')");
  else if (status) {
    vals.push(status);
    where.push(`o.status = ?${vals.length}`);
  }
  if (q) {
    vals.push(q, `%${q}%`);
    where.push(`(CAST(o.id AS TEXT) = ?${vals.length - 1} OR CAST(o.np_order_id AS TEXT) = ?${vals.length - 1} OR CAST(o.user_id AS TEXT) = ?${vals.length - 1} OR o.link LIKE ?${vals.length})`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, u.first_name, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.id DESC LIMIT 100`,
  )
    .bind(...vals)
    .all<OrderRow & { first_name: string; username: string | null }>();
  return c.json(
    results.map((o) => ({ ...orderView(o), npOrderId: o.np_order_id, cost: o.cost, userId: o.user_id, userName: o.first_name, username: o.username, error: o.error })),
  );
});

// ---- Connection: NotPanel webhook + bot setup ----

/** Sends one of every bot message (sample data) to the owner's chat */
admin.post("/preview-messages", async (c) => {
  const { lang } = await c.req.json<{ lang?: string }>().catch(() => ({ lang: undefined }));
  const u = c.get("user");
  const l = (LANGS as readonly string[]).includes(lang ?? "") ? (lang as Lang) : c.get("lang");
  try {
    const sent = await sendPreviews(c.env, u.id, l, u.first_name, LANGS, LANG_NAMES);
    return c.json({ ok: true, sent });
  } catch (e) {
    return err(c, 400, "SEND_FAILED", { message: (e as Error).message });
  }
});

admin.post("/connect", async (c) => {
  const url = new URL(c.req.url).origin;
  const result = await connectAll(c.env, url);
  return c.json(result);
});

export async function connectAll(env: AppEnv["Bindings"], origin: string) {
  const s = await getSettings(env);
  const out: Record<string, unknown> = { appUrl: origin };
  const me = await tg<{ username: string }>(env.BOT_TOKEN, "getMe");
  out.bot = me.username;
  await tg(env.BOT_TOKEN, "setWebhook", {
    url: `${origin}/bot`,
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "pre_checkout_query", "my_chat_member"],
    drop_pending_updates: false,
  });
  // Command menu in every language (Telegram picks it by the user's app language; English is the default)
  for (const l of LANGS) {
    const commands = [
      { command: "start", description: botPlain(l, "cmdStart") },
      { command: "language", description: botPlain(l, "cmdLanguage") },
      { command: "help", description: botPlain(l, "cmdHelp") },
    ];
    await tg(env.BOT_TOKEN, "setMyCommands", l === "en" ? { commands } : { commands, language_code: l });
  }
  await tg(env.BOT_TOKEN, "setChatMenuButton", { menu_button: { type: "web_app", text: "Open", web_app: { url: origin } } });
  const values: Partial<Settings> = { app_url: origin, bot_username: me.username };
  // NotPanel webhook for instant order updates (the cron job is the backup)
  try {
    if (s.np_webhook_id) await np(env.NOTPANEL_API_KEY, "webhook.remove", { id: s.np_webhook_id }).catch(() => undefined);
    const wh = await np<{ id: string; webhook_id?: string; secret: string }>(env.NOTPANEL_API_KEY, "webhook.add", {
      url: `${origin}/hooks/notpanel`,
      events: "order.processing,order.in_progress,order.completed,order.partial,order.canceled,refill.completed,refill.rejected",
    });
    values.np_webhook_id = String(wh.id ?? wh.webhook_id);
    values.np_webhook_secret = wh.secret;
    out.notpanelWebhook = true;
  } catch (e) {
    out.notpanelWebhook = (e as Error).message;
  }
  await setSettings(env, values);
  return out;
}
