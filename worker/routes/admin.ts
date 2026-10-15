import { Hono } from "hono";
import { platformName } from "../../shared/platforms";
import { LANGS, type Lang } from "../../shared/types";
import { sendPreviews } from "../botMessages";
import { botPlain } from "../i18n";
import { BOT_ABOUT } from "../bot-about";
import { MARKUP_SQL, rebuildSummaryStmts, RULE_JOINS } from "../catalog";
import { isOwner } from "../env";
import { np, usdToMicro } from "../notpanel";
import { orderView, type OrderRow } from "../orders";
import { refundPayment } from "../payments";
import { sellRate, sellStars } from "../pricing";
import { bumpCatalogStmt, DEFAULTS, getSettings, setSettings, setSettingsStmts, type Settings } from "../settings";
import { startSync, syncProgress } from "../sync";
import { tg } from "../telegram";
import { type AppEnv, err, readBody } from "./app";

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
  const [today, users, pending, attention, joined] = await c.env.DB.batch([
    c.env.DB.prepare(
      // charge/refund are whole Stars; USD uses the rate each order was sold at; cost is NotPanel's USD
      `SELECT COUNT(*) AS orders, COALESCE(SUM(charge - refund), 0) AS salesStars,
         COALESCE(SUM((charge - refund) * 1000000.0 / COALESCE(rate, ?2)), 0) AS sales,
         COALESCE(SUM((charge - refund) * 1000000.0 / COALESCE(rate, ?2) - COALESCE(cost, 0)), 0) AS profit
       FROM orders WHERE created_at >= ?1 AND status != 'failed'`,
    ).bind(since, s.stars_per_usd),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('submitting','pending','processing','in_progress')"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE present = 1 AND enabled = 1 AND fixed_rate IS NOT NULL AND fixed_rate < rate"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE status != 'pending'"),
  ]);
  let npBalance: number | null = null;
  let npError: string | null = null;
  try {
    npBalance = usdToMicro((await np<{ balance: string }>(c.env.NOTPANEL_API_KEY, "balance")).balance);
  } catch (e) {
    npError = (e as Error).message;
  }
  const r = today.results[0] as { orders: number; salesStars: number; sales: number; profit: number };
  const t = { orders: r.orders, salesStars: r.salesStars, sales: Math.round(r.sales), profit: Math.round(r.profit) };
  return c.json({
    npBalance,
    npError,
    lowBalance: s.low_balance,
    today: t,
    users: (users.results[0] as { n: number }).n,
    referralsJoined: (joined.results[0] as { n: number }).n,
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
  "min_topup_stars",
  "max_topup_stars",
  "sync_enabled",
  "sync_every_hours",
  "auto_enable_new",
  "only_timed",
  "low_balance",
  "support_username",
  "channel_url",
  "channel_id",
  "channel_gate",
  "referral_enabled",
  "referral_reward_stars",
  "referral_daily_cap",
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
  const body = await readBody<Partial<Settings>>(c);
  if (!body) return err(c, 400, "INVALID_BODY");
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
  const bad = (key: string) => err(c, 400, "INVALID_VALUE", { key });
  const inRange = (key: keyof Settings, lo: number, hi: number) => {
    const v = values[key] as number | undefined;
    return v === undefined || (v >= lo && v <= hi);
  };
  if (!inRange("stars_per_usd", 1, 1000)) return bad("stars_per_usd");
  if (!inRange("referral_reward_stars", 0, 100) || (values.referral_reward_stars !== undefined && !Number.isInteger(values.referral_reward_stars)))
    return bad("referral_reward_stars");
  if (!inRange("referral_daily_cap", 0, 10000)) return bad("referral_daily_cap");
  if (!inRange("sync_every_hours", 1, 168)) return bad("sync_every_hours");
  if (!inRange("low_balance", 0, Number.MAX_SAFE_INTEGER)) return bad("low_balance");
  // Top-up limits are compared against the merged current + new values
  const cur = c.get("settings");
  const minTopup = values.min_topup_stars ?? cur.min_topup_stars;
  const maxTopup = values.max_topup_stars ?? cur.max_topup_stars;
  if (!Number.isInteger(minTopup) || minTopup < 1) return bad("min_topup_stars");
  if (!Number.isInteger(maxTopup) || maxTopup < minTopup || maxTopup > 1_000_000) return bad("max_topup_stars");
  if (values.support_username) values.support_username = values.support_username.replace(/^@/, "");
  if (values.channel_url && !/^https:\/\/t\.me\//.test(values.channel_url)) return err(c, 400, "INVALID_VALUE", { key: "channel_url" });
  if (values.channel_id && !/^-100\d{5,}$/.test(values.channel_id)) return err(c, 400, "INVALID_VALUE", { key: "channel_id" });
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
  const b = await readBody<{ platform: string; category?: string; enabled?: boolean; markupPct?: number | null }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  if (!b.platform || typeof b.platform !== "string") return err(c, 400, "MISSING_PLATFORM");
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

const PAGE = 50;
/** Escapes LIKE wildcards in user input */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, "")}%`;
/** Positive integer query param, or null */
const intParam = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
/** Trims the extra look-ahead row and builds the `{ items, next }` page */
function page<T>(rows: T[], cursor: (last: T) => string | number) {
  const more = rows.length > PAGE;
  const items = more ? rows.slice(0, PAGE) : rows;
  return { items, next: more ? cursor(items[PAGE - 1]) : null };
}

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
    vals.push(/^\d+$/.test(q) ? Number(q) : -1, likeOf(q));
    where.push(`(s.id = ?${vals.length - 1} OR s.name LIKE ?${vals.length} OR s.custom_name LIKE ?${vals.length})`);
  }
  if (attention) where.push("s.fixed_rate IS NOT NULL AND s.fixed_rate < s.rate");
  const offset = Math.min(intParam(c.req.query("offset")) ?? 0, 100_000);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.custom_name, s.platform, s.category, s.rate, s.min, s.max, s.enabled, s.markup_pct, s.fixed_rate,
       ${MARKUP_SQL} AS markup, (SELECT old_rate FROM price_changes p WHERE p.service_id = s.id ORDER BY p.id DESC LIMIT 1) AS prev_rate
     FROM services s ${RULE_JOINS} WHERE ${where.join(" AND ")} ORDER BY s.sort, s.id LIMIT ${PAGE + 1} OFFSET ${offset}`,
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
  const pg = page(results, () => offset + PAGE);
  return c.json({
    next: pg.next,
    items: pg.items.map((r) => ({
      id: r.id,
      name: r.name,
      customName: r.custom_name,
      platform: r.platform,
      category: r.category,
      cost: r.rate,
      prevCost: r.prev_rate,
      sell: sellRate(r.rate, r.markup, r.fixed_rate),
      sellStars: sellStars(r.rate, r.markup, r.fixed_rate, s.stars_per_usd),
      starsPerUsd: s.stars_per_usd,
      markup: r.markup,
      markupPct: r.markup_pct,
      fixedRate: r.fixed_rate,
      min: r.min,
      max: r.max,
      enabled: !!r.enabled,
    })),
  });
});

admin.put("/services/:id", async (c) => {
  const b = await readBody<{ enabled?: boolean; markupPct?: number | null; fixedRate?: number | null; customName?: string | null }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
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
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (before) {
    vals.push(before);
    where.push(`p.id < ?${vals.length}`);
  }
  if (q) {
    vals.push(/^\d+$/.test(q) ? Number(q) : -1, likeOf(q));
    where.push(`(p.service_id = ?${vals.length - 1} OR s.name LIKE ?${vals.length} OR s.custom_name LIKE ?${vals.length})`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.service_id, p.old_rate, p.new_rate, p.changed_at, s.name, s.platform, s.category
     FROM price_changes p LEFT JOIN services s ON s.id = p.service_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...vals)
    .all<{ id: number }>();
  return c.json(page(results, (r) => r.id));
});

// ---- Payments ----

// Lifetime paid totals scan the whole payments table, so cache them per isolate for 5 minutes.
let totalsMemo: { at: number; value: unknown } | null = null;
async function paymentTotals(env: AppEnv["Bindings"]): Promise<unknown> {
  if (totalsMemo && Date.now() - totalsMemo.at < 5 * 60_000) return totalsMemo.value;
  const value = await env.DB.prepare(
    "SELECT COALESCE(SUM(stars), 0) AS stars, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'paid'",
  ).first();
  totalsMemo = { at: Date.now(), value };
  return value;
}

admin.get("/payments", async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/^[@#]/, "").slice(0, 100);
  const status = c.req.query("status");
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (status === "paid" || status === "refunded") {
    vals.push(status);
    where.push(`p.status = ?${vals.length}`);
  } else where.push("p.status != 'pending'");
  if (before) {
    vals.push(before);
    where.push(`p.id < ?${vals.length}`);
  }
  if (q) {
    vals.push(q, likeOf(q));
    where.push(
      `(CAST(p.id AS TEXT) = ?${vals.length - 1} OR CAST(p.user_id AS TEXT) = ?${vals.length - 1} OR p.charge_id = ?${vals.length - 1} OR u.username LIKE ?${vals.length} OR u.first_name LIKE ?${vals.length})`,
    );
  }
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.user_id, p.stars, p.amount, p.status, p.order_id, p.paid_at, p.created_at, u.first_name, u.last_name, u.username
     FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...vals)
    .all<{ id: number }>();
  // stars/amount are whole Stars; starsPerUsd is only the current rate, so USD figures are estimates
  return c.json({ ...page(results, (r) => r.id), totals: await paymentTotals(c.env), starsPerUsd: c.get("settings").stars_per_usd });
});

admin.post("/payments/:id/refund", async (c) => {
  const r = await refundPayment(c.env, Number(c.req.param("id")));
  return r.ok ? c.json(r) : err(c, 400, r.error ?? "REFUND_FAILED");
});

// ---- Referrals ----

interface RefTotals {
  invited: number;
  joined: number;
  rewarded: number;
  pending: number;
  capped: number;
  paid: number;
  todayInvited: number;
  todayPaid: number;
}
interface RefTop {
  id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  invited: number;
  joined: number;
  earned: number;
  last_at: number;
}
let refCache: { at: number; totals: RefTotals; top: RefTop[] } | null = null;

const REF_TOTALS_SQL = `SELECT COUNT(*) AS invited,
    COALESCE(SUM(status != 'pending'), 0) AS joined,
    COALESCE(SUM(status = 'rewarded'), 0) AS rewarded,
    COALESCE(SUM(status = 'pending'), 0) AS pending,
    COALESCE(SUM(status = 'capped'), 0) AS capped,
    COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) AS paid,
    COALESCE(SUM(created_at >= ?1), 0) AS todayInvited,
    COALESCE(SUM(CASE WHEN status = 'rewarded' AND rewarded_at >= ?1 THEN reward END), 0) AS todayPaid
  FROM referrals`;

const REF_TOP_SQL = (where: string) => `SELECT g.referrer_id AS id, u.first_name, u.last_name, u.username, g.invited, g.joined, g.earned, g.last_at
  FROM (SELECT referrer_id, COUNT(*) AS invited, SUM(status != 'pending') AS joined,
          COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) AS earned, MAX(created_at) AS last_at
        FROM referrals ${where} GROUP BY referrer_id ORDER BY joined DESC, invited DESC LIMIT 20) g
  LEFT JOIN users u ON u.id = g.referrer_id ORDER BY g.joined DESC, g.invited DESC`;

admin.get("/referrals", async (c) => {
  const s = c.get("settings");
  const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 64);
  const beforeN = Number(c.req.query("before"));
  const before = Number.isFinite(beforeN) && beforeN > 0 ? Math.floor(beforeN) : null;
  const now = Date.now();
  const cached = !q && refCache && now - refCache.at < 60_000 ? refCache : null;
  const like = `%${q.replace(/[\\%_]/g, "")}%`;
  const match = `SELECT id FROM users WHERE CAST(id AS TEXT) = ?1 OR username LIKE ?2 OR first_name LIKE ?2 OR last_name LIKE ?2 LIMIT 50`;

  const stmts: D1PreparedStatement[] = [];
  if (!cached) stmts.push(c.env.DB.prepare(REF_TOTALS_SQL).bind(dayStart()));
  if (!cached || q) {
    stmts.push(q ? c.env.DB.prepare(REF_TOP_SQL(`WHERE referrer_id IN (${match})`)).bind(q, like) : c.env.DB.prepare(REF_TOP_SQL("")));
  }
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    binds.push(q, like);
    conds.push(`(r.referrer_id IN (${match}) OR r.referred_id IN (${match}))`);
  }
  if (before) {
    binds.push(before);
    conds.push(`r.created_at < ?${binds.length}`);
  }
  stmts.push(
    c.env.DB.prepare(
      `SELECT r.referred_id, r.referrer_id, r.status, r.reward, r.created_at, r.rewarded_at,
         f.first_name AS f_first, f.last_name AS f_last, f.username AS f_user,
         u.first_name AS r_first, u.last_name AS r_last, u.username AS r_user
       FROM referrals r LEFT JOIN users f ON f.id = r.referred_id LEFT JOIN users u ON u.id = r.referrer_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT 50`,
    ).bind(...binds),
  );
  const res = await c.env.DB.batch(stmts);
  let i = 0;
  let totals: RefTotals;
  let top: RefTop[];
  if (cached) {
    totals = cached.totals;
    top = cached.top;
  } else {
    totals = res[i++].results[0] as unknown as RefTotals;
    top = res[i++].results as unknown as RefTop[];
    if (!q) refCache = { at: now, totals, top };
  }
  const recent = res[i].results as Record<string, unknown>[];
  return c.json({
    totals,
    top,
    recent,
    next: recent.length === 50 ? recent[49].created_at : null,
    settings: { enabled: !!s.referral_enabled, rewardStars: s.referral_reward_stars, dailyCap: s.referral_daily_cap, starsPerUsd: s.stars_per_usd },
  });
});

// ---- Users ----

admin.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 100);
  // Cursor "lastSeenAt_id" keeps paging stable when many users share a timestamp.
  const m = /^(\d+)_(\d+)$/.exec(c.req.query("before") ?? "");
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q) {
    vals.push(q, likeOf(q));
    where.push(`(CAST(id AS TEXT) = ?1 OR username LIKE ?2 OR first_name LIKE ?2 OR last_name LIKE ?2)`);
  }
  if (m) {
    vals.push(Number(m[1]), Number(m[2]));
    where.push(`(last_seen_at < ?${vals.length - 1} OR (last_seen_at = ?${vals.length - 1} AND id < ?${vals.length}))`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
       (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS paid
     FROM (SELECT * FROM users ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_seen_at DESC, id DESC LIMIT ${PAGE + 1}) u
     ORDER BY u.last_seen_at DESC, u.id DESC`,
  )
    .bind(...vals)
    .all<{ id: number; last_seen_at: number }>();
  return c.json(page(results, (u) => `${u.last_seen_at}_${u.id}`));
});

admin.post("/users/:id/balance", async (c) => {
  const b = await readBody<{ amount: number; note?: string }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const { amount, note } = b;
  // Whole Stars
  const delta = Number(amount);
  if (!Number.isInteger(delta)) return err(c, 400, "INVALID_AMOUNT");
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
  const b = await readBody<{ banned: boolean }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const { banned } = b;
  await c.env.DB.prepare("UPDATE users SET banned = ?2 WHERE id = ?1").bind(Number(c.req.param("id")), banned ? 1 : 0).run();
  return c.json({ ok: true });
});

// ---- Orders ----

admin.get("/orders", async (c) => {
  const status = c.req.query("status");
  const q = (c.req.query("q") ?? "").trim().replace(/^#/, "");
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (before) {
    vals.push(before);
    where.push(`o.id < ?${vals.length}`);
  }
  if (status === "open") where.push("o.status IN ('submitting','pending','processing','in_progress')");
  else if (status) {
    vals.push(status);
    where.push(`o.status = ?${vals.length}`);
  }
  if (q) {
    vals.push(q.slice(0, 200), likeOf(q.slice(0, 200)));
    where.push(`(CAST(o.id AS TEXT) = ?${vals.length - 1} OR CAST(o.np_order_id AS TEXT) = ?${vals.length - 1} OR CAST(o.user_id AS TEXT) = ?${vals.length - 1} OR o.link LIKE ?${vals.length})`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, u.first_name, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...vals)
    .all<OrderRow & { rate: number | null; first_name: string; username: string | null }>();
  const pg = page(results, (o) => o.id);
  return c.json({
    next: pg.next,
    // charge/refund are whole Stars; cost is NotPanel's USD; rate is Stars per $1 the order was sold at (null on very old rows)
    starsPerUsd: c.get("settings").stars_per_usd,
    items: pg.items.map((o) => ({ ...orderView(o), npOrderId: o.np_order_id, cost: o.cost, rate: o.rate, userId: o.user_id, userName: o.first_name, username: o.username, error: o.error })),
  });
});

// ---- Connection: NotPanel webhook + bot setup ----

/** Sends one of every bot message (sample data) to the owner's chat */
admin.post("/preview-messages", async (c) => {
  const lang = (await readBody<{ lang?: string }>(c))?.lang;
  const u = c.get("user");
  const l = (LANGS as readonly string[]).includes(lang ?? "") ? (lang as Lang) : c.get("lang");
  try {
    const sent = await sendPreviews(c.env, u.id, l, u.first_name, LANGS);
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

/**
 * Sets the name, command menu, profile "About" text and description for one batch of 10 languages (4 Telegram calls each),
 * staying under the free plan's 50 outgoing calls per request. Returns the next batch number, or null when done.
 */
export async function syncBotTexts(env: AppEnv["Bindings"], batch: number): Promise<number | null> {
  const langs = LANGS.slice(batch * 10, batch * 10 + 10);
  for (const l of langs) {
    const lc = l === "en" ? {} : { language_code: l };
    const commands = [
      { command: "start", description: botPlain(l, "cmdStart") },
      { command: "language", description: botPlain(l, "cmdLanguage") },
      { command: "help", description: botPlain(l, "cmdHelp") },
    ];
    await tg(env.BOT_TOKEN, "setMyCommands", { commands, ...lc });
    await tg(env.BOT_TOKEN, "setMyName", { name: BOT_ABOUT[l].name, ...lc });
    await tg(env.BOT_TOKEN, "setMyShortDescription", { short_description: BOT_ABOUT[l].short, ...lc });
    await tg(env.BOT_TOKEN, "setMyDescription", { description: BOT_ABOUT[l].description, ...lc });
  }
  return (batch + 1) * 10 < LANGS.length ? batch + 1 : null;
}

admin.post("/bot-texts/:batch", async (c) => c.json({ next: await syncBotTexts(c.env, Number(c.req.param("batch")) || 0) }));

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
  // Per-language command menu, About text and description: see syncBotTexts (batched for the free plan's 50-call limit)
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
