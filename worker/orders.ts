import { FINAL_STATUSES, type Lang, type OrderStatus, type OrderView, pickLang } from "../shared/types";
import type { Env } from "./env";
import { botText } from "./i18n";
import { amountText, linkText } from "./botMessages";
import { NotPanelError, npCall, usdToMicro, type NpAddResult, type NpStatus } from "./notpanel";
import { orderCharge } from "./pricing";
import { alertAdmins } from "./alerts";
import { getSettings } from "./settings";
import { tg, webAppButton } from "./telegram";
import type { ServiceDetail } from "../shared/types";

export interface OrderRow {
  id: number;
  user_id: number;
  service_id: number;
  service_name: string;
  platform: string;
  category: string;
  np_order_id: number | null;
  link: string;
  quantity: number;
  fields: string | null;
  drip_minutes: number | null;
  charge: number;
  cost: number | null;
  status: OrderStatus;
  start_count: number | null;
  remains: number | null;
  reason_code: string | null;
  refund: number;
  refunded: number;
  can_cancel: number;
  can_refill: number;
  cancel_before: number | null;
  refill_id: number | null;
  refill_status: string | null;
  error: string | null;
  notified_status: string | null;
  created_at: number;
  updated_at: number;
  checked_at: number;
}

export const OPEN_STATUSES: OrderStatus[] = ["submitting", "pending", "processing", "in_progress"];

export function orderView(o: OrderRow, paidWithStars = false): OrderView {
  const now = Math.floor(Date.now() / 1000);
  const inGrace = !!o.cancel_before && now < o.cancel_before;
  return {
    id: o.id,
    number: o.np_order_id ?? o.id,
    serviceId: o.service_id,
    serviceName: o.service_name,
    platform: o.platform,
    category: o.category,
    link: o.link,
    quantity: o.quantity,
    charge: o.charge,
    refund: o.refund,
    status: o.status,
    startCount: o.start_count,
    remains: o.remains,
    reasonCode: o.reason_code ?? (o.status === "failed" ? o.error : null),
    canCancel: OPEN_STATUSES.includes(o.status) && o.status !== "submitting" && (inGrace || !!o.can_cancel),
    canRefill: !!o.can_refill && (o.status === "completed" || o.status === "partial") && o.refill_status !== "pending",
    refillStatus: o.refill_status,
    paidWithStars,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function normStatus(key: string | undefined): OrderStatus | null {
  switch (key) {
    case "pending":
    case "processing":
    case "in_progress":
    case "completed":
    case "partial":
      return key;
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

export class OrderError extends Error {
  constructor(public code: string, public details?: Record<string, unknown>) {
    super(code);
  }
}

/** NotPanel error codes that mean "your shop can't sell this right now" rather than "you typed something wrong". */
const SHOP_SIDE = new Set(["INSUFFICIENT_BALANCE", "ORDER_PLACEMENT_PAUSED", "API_DISABLED", "INVALID_KEY", "INACTIVE_ACCOUNT", "EMAIL_UNVERIFIED"]);

/** Keys the caller must never be able to set through user-supplied form fields. */
const RESERVED_PARAMS = new Set([
  "key", "action", "service", "link", "quantity", "request_id", "idempotency_key", "runs", "interval",
  "drip_feed_total_minutes", "orders", "order",
]);

/** Dev and production share one NotPanel account, so their idempotency keys must not collide. */
function requestId(env: Env, id: number): string {
  return `${env.DEV_FAKE_USER_ID ? "dev" : "o"}${id}`;
}

/**
 * Safety guard: a local dev setup (DEV_FAKE_USER_ID set) uses the live NotPanel key, so it must not place, cancel or
 * refill real orders unless ALLOW_LIVE_ORDERS=1 is set explicitly. (ALLOW_LIVE_ORDERS is declared on Env by worker/env.ts.)
 */
function assertOrdersAllowed(env: Env): void {
  const allow = (env as Env & { ALLOW_LIVE_ORDERS?: string }).ALLOW_LIVE_ORDERS;
  if (env.DEV_FAKE_USER_ID && allow !== "1") throw new OrderError("DEV_ORDERS_DISABLED");
}

/** Maps a NotPanel error for cancel/refill; shop-side codes are hidden behind SERVICE_UNAVAILABLE with no supplier details. */
function shopSafeError(env: Env, e: NotPanelError): OrderError {
  if (SHOP_SIDE.has(e.code)) {
    console.error("NotPanel shop-side error", e.code, e.message);
    void alertAdmins(env, "notpanel", `NotPanel refused a request: <b>${e.code}</b>. Check your NotPanel account and API key.`);
    return new OrderError("SERVICE_UNAVAILABLE", undefined);
  }
  return new OrderError(e.code, e.details);
}

/**
 * Charges the user's balance and sends the order to NotPanel. If NotPanel rejects it, the charge is refunded.
 * If NotPanel can't be reached, the order stays "submitting" and the cron job recovers it by request_id.
 */
export async function placeOrder(
  env: Env,
  userId: number,
  svc: ServiceDetail & { cost: number },
  link: string,
  quantity: number,
  fields: Record<string, string>,
  dripMinutes: number | undefined,
): Promise<OrderRow> {
  assertOrdersAllowed(env);
  // svc.rate is the sell price per 1,000 in micro-USD; the charge is micro-USD (users see it as Stars)
  const charge = orderCharge(svc.rate, quantity, svc.quantityMode);
  const starsPerUsd = (await getSettings(env)).stars_per_usd;
  const now = Math.floor(Date.now() / 1000);
  const [debit, insert] = await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance = balance - ?1 WHERE id = ?2 AND balance >= ?1 AND banned = 0").bind(charge, userId),
    env.DB.prepare(
      `INSERT INTO orders (user_id, service_id, service_name, platform, category, link, quantity, fields, drip_minutes, charge,
         rate, status, created_at, updated_at, checked_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, 'submitting', ?11, ?11, ?11 WHERE changes() = 1 RETURNING id`,
    ).bind(
      userId,
      svc.id,
      svc.name,
      svc.platform,
      svc.category,
      link,
      quantity,
      Object.keys(fields).length ? JSON.stringify(fields) : null,
      dripMinutes ?? null,
      charge,
      now,
      starsPerUsd,
    ),
    env.DB.prepare(
      "INSERT INTO ledger (user_id, delta, kind, ref, created_at) SELECT ?1, ?2, 'order', last_insert_rowid(), ?3 WHERE changes() = 1",
    ).bind(userId, -charge, now),
  ]);
  if (!debit.meta.changes) throw new OrderError("INSUFFICIENT_FUNDS", { charge });
  const id = (insert.results[0] as { id: number }).id;

  // Form fields go first so they can never override the fixed keys below
  const params: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(fields)) if (!RESERVED_PARAMS.has(k)) params[k] = v;
  Object.assign(params, {
    service: svc.id,
    link,
    request_id: requestId(env, id),
    quantity: svc.quantityMode === "free" ? quantity : undefined,
    drip_feed_total_minutes: dripMinutes,
  });
  try {
    const r = await npCall<NpAddResult>(env, "add", params);
    const addStatus = normStatus(r.status_key) ?? "pending";
    const addCost = usdToMicro(r.charge);
    if (addCost > charge) console.warn("order sold below cost", { order: id, charge, cost: addCost });
    await env.DB.prepare(
      `UPDATE orders SET np_order_id = ?1, status = ?2, cost = ?3, can_cancel = ?4, cancel_before = ?5, updated_at = ?6 WHERE id = ?7`,
    )
      .bind(
        r.order,
        addStatus,
        addCost,
        r.cancel_available ? 1 : 0,
        r.cancel_before ? Math.floor(Date.parse(r.cancel_before) / 1000) : null,
        now,
        id,
      )
      .run();
    // A replayed order can already be finished: run it through the normal path so refunds and notifications happen
    if (FINAL_STATUSES.includes(addStatus)) {
      const row = await getOrderRow(env, id);
      if (row) await applyStatus(env, row, { ...(r as object), status: r.status_key, status_key: r.status_key } as NpStatus);
    }
  } catch (e) {
    if (e instanceof NotPanelError && !e.retryable) {
      const shop = SHOP_SIDE.has(e.code);
      await failOrder(env, id, shop ? "SERVICE_UNAVAILABLE" : e.code);
      if (shop) {
        console.error("NotPanel shop-side error", e.code, e.message);
        await alertAdmins(env, "notpanel", `NotPanel refused an order: <b>${e.code}</b>${e.code === "INSUFFICIENT_BALANCE" ? " (your NotPanel balance is too low; top it up on notpanel.com)" : ""}. Customers can't order until this is fixed; their money was refunded to their balance.`);
      }
      // Supplier details are never shown to users
      throw new OrderError(shop ? "SERVICE_UNAVAILABLE" : e.code, shop ? undefined : e.details);
    }
    console.warn("order submit pending recovery", id, (e as Error).message);
  }
  return (await getOrderRow(env, id))!;
}

export async function getOrderRow(env: Env, id: number): Promise<OrderRow | null> {
  return env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(id).first<OrderRow>();
}

/** Marks an order as failed and refunds the full charge (once). */
async function failOrder(env: Env, id: number, code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET status = 'failed', error = ?2, refund = charge, refunded = 1, updated_at = ?3 WHERE id = ?1 AND refunded = 0",
    ).bind(id, code, now),
    ...creditRefundStmts(env, id, now),
  ]);
}

/** Credits orders.refund to the user — only runs if the immediately preceding UPDATE changed the row. */
function creditRefundStmts(env: Env, id: number, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, kind, ref, created_at)
       SELECT user_id, refund, 'refund', id, ?2 FROM orders WHERE id = ?1 AND changes() = 1 AND refund > 0`,
    ).bind(id, now),
    env.DB.prepare(
      `UPDATE users SET balance = balance + (SELECT refund FROM orders WHERE id = ?1)
       WHERE id = (SELECT user_id FROM orders WHERE id = ?1) AND changes() = 1`,
    ).bind(id),
  ];
}

export function refundFor(o: OrderRow, status: OrderStatus, remains: number | null, st?: NpStatus): number {
  if (status === "partial" && remains === null) {
    // No remains from NotPanel: split our charge in the same ratio as NotPanel's own refund vs. charge
    if (st && st.refund !== undefined && st.refund !== "" && st.charge !== undefined && st.charge !== "") {
      const npRefund = usdToMicro(st.refund);
      const npCharge = usdToMicro(st.charge);
      if (npRefund >= 0 && npCharge >= 0 && npCharge + npRefund > 0) {
        return Math.max(0, Math.min(o.charge, Math.ceil((o.charge * npRefund) / (npCharge + npRefund) - 1e-9)));
      }
    }
    console.error("partial order without remains or refund info; refunding 0", o.id);
    return 0;
  }
  if (status === "partial" || status === "cancelled") {
    if (status === "partial" || (remains !== null && remains > 0 && remains < o.quantity)) {
      const left = Math.max(0, Math.min(remains ?? 0, o.quantity));
      // Rounded up in the user's favour, never more than they paid
      return Math.min(o.charge, Math.ceil((o.charge * left) / o.quantity - 1e-9));
    }
    return o.charge;
  }
  return 0;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/** Applies a NotPanel status (from polling or a webhook). Refunds and notifies when the order finishes. */
export async function applyStatus(env: Env, o: OrderRow, st: NpStatus): Promise<OrderRow> {
  const status = normStatus(st.status_key);
  if (!status) return o;
  // Out-of-order event (e.g. a late "processing" after "completed"): the order is already final, ignore it
  if (FINAL_STATUSES.includes(o.status) && !FINAL_STATUSES.includes(status)) return o;
  const now = Math.floor(Date.now() / 1000);
  const remains = num(st.remains);
  await env.DB.prepare(
    `UPDATE orders SET status = ?2, start_count = ?3, remains = ?4, reason_code = ?5, can_cancel = ?6, can_refill = ?7,
       cost = COALESCE(?8, cost), updated_at = CASE WHEN status = ?2 AND remains IS ?4 THEN updated_at ELSE ?9 END, checked_at = ?9
     WHERE id = ?1`,
  )
    .bind(
      o.id,
      status,
      num(st.start_count),
      remains,
      st.reason_code ?? null,
      st.cancel_available ?? st.can_cancel ? 1 : 0,
      st.can_refill ? 1 : 0,
      st.charge !== undefined ? usdToMicro(st.charge) : null,
      now,
    )
    .run();

  if (FINAL_STATUSES.includes(status) && !o.refunded) {
    const refund = refundFor(o, status, remains, st);
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET refund = ?2, refunded = 1 WHERE id = ?1 AND refunded = 0").bind(o.id, refund),
      ...creditRefundStmts(env, o.id, now),
    ]);
  }
  const updated = (await getOrderRow(env, o.id))!;
  if (FINAL_STATUSES.includes(status) && updated.notified_status !== status) await notifyOrder(env, updated);
  return updated;
}

/** Sends "order completed" etc. to the user's chat if they turned on updates. */
export async function notifyOrder(env: Env, o: OrderRow): Promise<void> {
  const claimed = await env.DB.prepare("UPDATE orders SET notified_status = ?2 WHERE id = ?1 AND notified_status IS NOT ?2")
    .bind(o.id, o.status)
    .run();
  if (!claimed.meta.changes) return;
  const user = await env.DB.prepare("SELECT notify, can_message, lang, language_code FROM users WHERE id = ?1")
    .bind(o.user_id)
    .first<{ notify: number; can_message: number; lang: string | null; language_code: string | null }>();
  if (!user?.notify || !user.can_message) return;
  const s = await getSettings(env);
  if (!s.app_url) return;
  const lang: Lang = pickLang(user.lang ?? user.language_code);
  const key = ({ completed: "orderCompleted", partial: "orderPartial", cancelled: "orderCancelled", failed: "orderFailed" } as const)[
    o.status as "completed" | "partial" | "cancelled" | "failed"
  ];
  if (!key) return;
  const text = botText(lang, key, {
    id: String(o.np_order_id ?? o.id),
    service: o.service_name,
    quantity: o.quantity.toLocaleString("en-US"),
    refund: amountText(o.refund, s),
    link: linkText(o.link),
  });
  try {
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: o.user_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[webAppButton(botText(lang, "viewOrder"), `${s.app_url}/#/order/${o.id}`, "viewOrder")]] },
    });
  } catch (e) {
    // 403 = the user blocked the bot; stop trying
    if (String((e as Error).message).includes("403")) await env.DB.prepare("UPDATE users SET can_message = 0 WHERE id = ?1").bind(o.user_id).run();
    else console.warn("notify failed", (e as Error).message);
  }
}

/** Fetches the live status of one order (used when the user opens it). */
export async function refreshOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  if (!OPEN_STATUSES.includes(o.status) && !(o.refill_id && o.refill_status === "pending")) return o;
  try {
    if (o.np_order_id && o.status !== "submitting") {
      const st = await npCall<NpStatus>(env, "status", { order: o.np_order_id });
      o = await applyStatus(env, o, st);
    } else if (o.status === "submitting") {
      o = await recoverSubmitting(env, o);
    }
    if (o.refill_id && o.refill_status === "pending") {
      const r = await npCall<{ status_key: string }>(env, "refill_status", { refill: o.refill_id });
      const rs = r.status_key === "completed" || r.status_key === "rejected" ? r.status_key : "pending";
      if (rs !== "pending") await env.DB.prepare("UPDATE orders SET refill_status = ?2 WHERE id = ?1").bind(o.id, rs).run();
      o = (await getOrderRow(env, o.id))!;
    }
  } catch (e) {
    console.warn("refresh failed", o.id, (e as Error).message);
  }
  return o;
}

/** An order whose add call timed out: ask NotPanel by request_id whether it exists. */
async function recoverSubmitting(env: Env, o: OrderRow): Promise<OrderRow> {
  try {
    const d = await npCall<NpStatus & { order: number }>(env, "order_details", { request_id: requestId(env, o.id) });
    await env.DB.prepare("UPDATE orders SET np_order_id = ?2 WHERE id = ?1").bind(o.id, d.order).run();
    return applyStatus(env, { ...o, np_order_id: d.order }, d);
  } catch (e) {
    const now = Math.floor(Date.now() / 1000);
    if (e instanceof NotPanelError && e.code === "ORDER_NOT_FOUND" && now - o.created_at > 600) {
      await failOrder(env, o.id, "SUBMIT_FAILED");
      const failed = (await getOrderRow(env, o.id))!;
      await notifyOrder(env, failed);
      return failed;
    }
    await env.DB.prepare("UPDATE orders SET checked_at = ?2 WHERE id = ?1").bind(o.id, now).run();
    return o;
  }
}

/**
 * Cron backup for webhooks (runs every minute): re-checks open orders that haven't been checked for 20 minutes.
 * Stays well under the free plan's ~50 D1 queries per run: at most 12 open orders and 3 submitting recoveries,
 * and it stops early when a rough query budget is used up (unprocessed orders keep their old checked_at and go first next time).
 */
export async function pollOpenOrders(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const BUDGET = 40;
  let used = 2; // the two selects below
  const [open, stuck] = await env.DB.batch<OrderRow>([
    env.DB.prepare(
      `SELECT * FROM orders WHERE status IN ('pending','processing','in_progress') AND np_order_id IS NOT NULL AND checked_at < ?1
       ORDER BY checked_at LIMIT 12`,
    ).bind(now - 1200),
    env.DB.prepare(`SELECT * FROM orders WHERE status = 'submitting' AND checked_at < ?1 ORDER BY checked_at LIMIT 3`).bind(now - 240),
  ]);
  const withId = open.results;
  if (withId.length) {
    try {
      const map = await npCall<Record<string, NpStatus>>(env, "status", { orders: withId.map((o) => o.np_order_id).join(",") });
      for (const o of withId) {
        const st = map[String(o.np_order_id)];
        const next = st && !st.error_code ? normStatus(st.status_key) : null;
        const cost = next && FINAL_STATUSES.includes(next) ? 7 : 2;
        if (used + cost > BUDGET) break;
        used += cost;
        if (st && !st.error_code) await applyStatus(env, o, st);
        else await env.DB.prepare("UPDATE orders SET checked_at = ?2 WHERE id = ?1").bind(o.id, now).run();
      }
    } catch (e) {
      console.warn("poll failed", (e as Error).message);
    }
  }
  for (const o of stuck.results) {
    if (used + 8 > BUDGET) break;
    used += 8;
    await recoverSubmitting(env, o);
  }
}

export async function cancelOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  assertOrdersAllowed(env);
  if (!o.np_order_id) throw new OrderError("CANCEL_NOT_AVAILABLE");
  try {
    await npCall(env, "cancel", { order: o.np_order_id });
  } catch (e) {
    if (e instanceof NotPanelError) throw shopSafeError(env, e);
    throw e;
  }
  const st = await npCall<NpStatus>(env, "status", { order: o.np_order_id });
  return applyStatus(env, o, st);
}

export async function refillOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  assertOrdersAllowed(env);
  if (!o.np_order_id) throw new OrderError("REFILL_NOT_AVAILABLE");
  try {
    const r = await npCall<{ refill: number }>(env, "refill", { order: o.np_order_id });
    await env.DB.prepare("UPDATE orders SET refill_id = ?2, refill_status = 'pending' WHERE id = ?1").bind(o.id, r.refill).run();
  } catch (e) {
    if (e instanceof NotPanelError) throw shopSafeError(env, e);
    throw e;
  }
  return (await getOrderRow(env, o.id))!;
}
