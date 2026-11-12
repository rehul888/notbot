import { starsCredit } from "../shared/stars";
import { type Lang, type OrderDraft, pickLang } from "../shared/types";
import { getService } from "./catalog";
import type { Env } from "./env";
import { botPlain, botText } from "./i18n";
import { amountText, balanceText, linkText, starsText } from "./botMessages";
import { OrderError, placeOrder } from "./orders";
import { checkDraft } from "./pricing";
import { getSettings, type Settings } from "./settings";
import { tg, webAppButton } from "./telegram";
import { groupInt } from "../shared/num";


interface PaymentRow {
  id: number;
  user_id: number;
  /** Whole Stars the user pays */
  stars: number;
  /** micro-USD credited to the balance for those Stars (fixed when the invoice is created) */
  amount: number;
  draft: string | null;
  status: string;
  charge_id: string | null;
  order_id: number | null;
  created_at: number;
}

/** Thrown by createInvoice when the user already has too many unpaid invoices (routes answer 429). */
export class TooManyInvoices extends Error {}

/**
 * Creates a pending payment and a Stars invoice link for the Mini App to open with openInvoice. The user pays whole
 * Stars; the balance is credited their dollar value at today's rate (1 ⭐ = 1/stars_per_usd USD).
 */
export async function createInvoice(
  env: Env,
  userId: number,
  lang: Lang,
  stars: number,
  starsPerUsd: number,
  draft: (OrderDraft & { label: string }) | null,
): Promise<{ link: string; stars: number; paymentId: number }> {
  stars = Math.max(1, Math.round(stars));
  const amount = starsCredit(stars, starsPerUsd);
  if (!(amount > 0)) throw new Error("invalid stars_per_usd");
  const now = Math.floor(Date.now() / 1000);
  // The cap is part of the INSERT so concurrent requests can't slip past it
  const row = await env.DB.prepare(
    `INSERT INTO payments (user_id, stars, amount, draft, status, created_at)
     SELECT ?1, ?2, ?3, ?4, 'pending', ?5
     WHERE (SELECT COUNT(*) FROM payments WHERE user_id = ?1 AND status = 'pending' AND created_at > ?5 - 3600) < 5
     RETURNING id`,
  )
    .bind(userId, stars, amount, draft ? JSON.stringify(draft) : null, now)
    .first<{ id: number }>();
  if (!row) throw new TooManyInvoices();
  const id = row.id;
  const title = botPlain(lang, "invoiceTitle").slice(0, 32);
  const description = (draft ? draft.label : botPlain(lang, "invoiceTopup", { amount: starsText(stars) })).slice(0, 255);
  const link = await tg<string>(env.BOT_TOKEN, "createInvoiceLink", {
    title,
    description,
    payload: `p${id}`,
    currency: "XTR",
    prices: [{ label: title, amount: stars }],
  });
  return { link, stars, paymentId: id };
}

/** Cron: unpaid invoices expire after an hour, so drop the ones older than a day. */
export async function cleanupPendingPayments(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  await env.DB.prepare("DELETE FROM payments WHERE status = 'pending' AND created_at < ?1").bind(cutoff).run();
}

async function paymentFromPayload(env: Env, payload: string): Promise<PaymentRow | null> {
  const m = /^p(\d+)$/.exec(payload);
  if (!m) return null;
  return env.DB.prepare("SELECT * FROM payments WHERE id = ?1").bind(Number(m[1])).first<PaymentRow>();
}

/** Telegram asks us to confirm within 10 seconds. */
export async function onPreCheckout(env: Env, q: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string }) {
  const p = await paymentFromPayload(env, q.invoice_payload);
  const now = Math.floor(Date.now() / 1000);
  const valid =
    !!p && p.status === "pending" && p.user_id === q.from.id && q.currency === "XTR" && q.total_amount === p.stars && now - p.created_at < 3600;
  // Don't take Stars from a banned user, we would not let them spend the balance anyway
  const banned = valid ? !!(await env.DB.prepare("SELECT banned FROM users WHERE id = ?1").bind(q.from.id).first<{ banned: number }>())?.banned : false;
  const ok = valid && !banned;
  await tg(env.BOT_TOKEN, "answerPreCheckoutQuery", {
    pre_checkout_query_id: q.id,
    ok,
    ...(ok
      ? {}
      : { error_message: banned ? "Your account can't make payments." : "This payment link has expired. Please start the payment again in the app." }),
  });
}

/** Credits the balance once per Telegram charge, then places the order if the payment was for one. */
export async function onSuccessfulPayment(
  env: Env,
  from: { id: number; language_code?: string },
  sp: { invoice_payload: string; telegram_payment_charge_id: string; total_amount: number; currency: string },
): Promise<void> {
  const p = await paymentFromPayload(env, sp.invoice_payload);
  if (!p) {
    console.error("payment without record", sp.telegram_payment_charge_id);
    return;
  }
  // Never credit something that doesn't match the invoice we issued
  if (sp.currency !== "XTR" || sp.total_amount !== p.stars || from.id !== p.user_id) {
    console.error("payment mismatch, not credited", sp.telegram_payment_charge_id, p.id, sp.currency, sp.total_amount, from.id);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const [mark] = await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status = 'paid', charge_id = ?2, paid_at = ?3 WHERE id = ?1 AND status = 'pending'").bind(
      p.id,
      sp.telegram_payment_charge_id,
      now,
    ),
    env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, created_at) SELECT ?1, ?2, 'topup', ?3, ?4 WHERE changes() = 1").bind(
      p.user_id,
      p.amount,
      p.id,
      now,
    ),
    env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1 AND changes() = 1").bind(p.user_id, p.amount),
  ]);
  if (!mark.meta.changes) {
    // Already processed. A different charge for the same invoice means the user paid twice: give the second one back.
    try {
      const cur = await env.DB.prepare("SELECT charge_id FROM payments WHERE id = ?1").bind(p.id).first<{ charge_id: string | null }>();
      if (cur?.charge_id && cur.charge_id !== sp.telegram_payment_charge_id) {
        await tg(env.BOT_TOKEN, "refundStarPayment", { user_id: p.user_id, telegram_payment_charge_id: sp.telegram_payment_charge_id });
        console.error("duplicate payment refunded", p.id, sp.telegram_payment_charge_id);
      }
    } catch (e) {
      console.error("duplicate payment refund failed", p.id, sp.telegram_payment_charge_id, e);
    }
    return;
  }

  const user = await env.DB.prepare("SELECT lang, language_code FROM users WHERE id = ?1").bind(p.user_id).first<{ lang: string | null; language_code: string | null }>();
  const lang = pickLang(user?.lang ?? user?.language_code ?? from.language_code);
  const s = await getSettings(env);
  // The user paid p.stars; show exactly that (the credit is its dollar value)
  const paid = starsText(p.stars);
  const button = (id?: number) =>
    s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, id ? "viewOrder" : "open"), `${s.app_url}/#/${id ? `order/${id}` : "wallet"}`, id ? "viewOrder" : "open")]] } : undefined;

  if (!p.draft) {
    const bal = await env.DB.prepare("SELECT balance FROM users WHERE id = ?1").bind(p.user_id).first<{ balance: number }>();
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "topupDone", { amount: paid, balance: balanceText(bal?.balance ?? p.amount, s) }),
      parse_mode: "HTML",
      reply_markup: button(),
    });
    return;
  }
  const draft = JSON.parse(p.draft) as OrderDraft;
  try {
    const svc = await getService(env, s, lang, draft.serviceId);
    if (!svc) throw new OrderError("SERVICE_UNAVAILABLE");
    const check = checkDraft({ ...svc, type_key: svc.typeKey, dripfeed: !!svc.dripFeed, dripMax: svc.dripFeed?.max_total_minutes ?? null }, draft);
    if ("error" in check) throw new OrderError(check.error);
    const order = await placeOrder(env, p.user_id, svc, check.link, check.quantity, check.fields, draft.dripMinutes);
    await env.DB.prepare("UPDATE payments SET order_id = ?2 WHERE id = ?1").bind(p.id, order.id).run();
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "orderPlaced", { id: String(order.np_order_id ?? order.id), service: order.service_name, quantity: groupInt(order.quantity), link: linkText(order.link) }),
      link_preview_options: { is_disabled: true },
      parse_mode: "HTML",
      reply_markup: button(order.id),
    });
  } catch (e) {
    const reason = e instanceof OrderError ? e.code : "ERROR";
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "orderNotPlaced", { amount: paid, reason }),
      parse_mode: "HTML",
      reply_markup: button(),
    });
  }
}

type RefundResult = { ok: boolean; error?: string; details?: Record<string, unknown> };

/**
 * Admin: give the Stars of one payment back (Telegram only refunds a whole payment). If the payment bought an order,
 * that order is refunded with it; the rest must still be unspent balance. With `force` the admin refunds anyway and
 * takes only what is left of the balance (never below 0).
 */
export async function refundPayment(env: Env, paymentId: number, force = false): Promise<RefundResult> {
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id = ?1").bind(paymentId).first<PaymentRow>();
  if (!p || p.status !== "paid" || !p.charge_id) return { ok: false, error: "NOT_REFUNDABLE" };
  const [order, user] = await env.DB.batch<{ charge?: number; refund?: number; refunded?: number; balance?: number }>([
    env.DB.prepare("SELECT charge, refund, refunded FROM orders WHERE id = ?1 AND user_id = ?2").bind(p.order_id ?? 0, p.user_id),
    env.DB.prepare("SELECT balance FROM users WHERE id = ?1").bind(p.user_id),
  ]);
  const o = order.results[0] as { charge: number; refund: number; refunded: number } | undefined;
  const balance = Math.max(0, (user.results[0] as { balance: number } | undefined)?.balance ?? 0);
  // The part still spent on its order comes back by refunding that order; the rest has to come from the balance
  const fromBalance = Math.max(0, p.amount - (o ? Math.max(0, o.charge - o.refund) : 0));
  if (balance < fromBalance && !force) return { ok: false, error: "BALANCE_ALREADY_SPENT", details: { spent: fromBalance - balance } };
  const take = Math.min(fromBalance, balance);
  const now = Math.floor(Date.now() / 1000);
  // One guarded batch: the payment flips to refunded only if the balance and the order haven't changed since the reads
  const [reserve] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE payments SET status = 'refunded' WHERE id = ?1 AND status = 'paid' AND (SELECT balance FROM users WHERE id = ?2) >= ?3
         AND (?4 = 0 OR (SELECT refund FROM orders WHERE id = ?4) = ?5)`,
    ).bind(p.id, p.user_id, take, o ? p.order_id : 0, o?.refund ?? 0),
    env.DB.prepare("UPDATE users SET balance = balance - ?2 WHERE id = ?1 AND changes() = 1").bind(p.user_id, take),
    env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, created_at) SELECT ?1, ?2, 'stars_refund', ?3, ?4 WHERE changes() = 1 AND ?2 < 0").bind(
      p.user_id,
      -take,
      p.id,
      now,
    ),
    env.DB.prepare(
      "UPDATE orders SET refund = charge, refunded = 1 WHERE id = ?1 AND refund = ?2 AND (SELECT status FROM payments WHERE id = ?3) = 'refunded'",
    ).bind(o ? p.order_id : 0, o?.refund ?? 0, p.id),
  ]);
  if (!reserve.meta.changes) return { ok: false, error: "TRY_AGAIN" };
  try {
    await tg(env.BOT_TOKEN, "refundStarPayment", { user_id: p.user_id, telegram_payment_charge_id: p.charge_id });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const rejected = /^Telegram refundStarPayment: 400 (.*)$/s.exec(msg);
    if (rejected && rejected[1].includes("CHARGE_ALREADY_REFUNDED")) return { ok: true }; // Stars are already back with the user
    if (!rejected) {
      // Network error, 5xx or anything unclear: Telegram may have refunded, so keep the balance reserved
      console.error("refund uncertain, balance stays reserved", p.id, msg);
      return { ok: false, error: "REFUND_UNCERTAIN" };
    }
    // Telegram definitely refused: undo (once, guarded by the status change)
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET status = 'paid' WHERE id = ?1 AND status = 'refunded'").bind(p.id),
      env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1 AND changes() = 1").bind(p.user_id, take),
      env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, note, created_at) SELECT ?1, ?2, 'admin', ?3, 'refund failed', ?4 WHERE changes() = 1 AND ?2 > 0").bind(
        p.user_id,
        take,
        p.id,
        now,
      ),
      env.DB.prepare(
        "UPDATE orders SET refund = ?2, refunded = ?3 WHERE id = ?1 AND refund = charge AND (SELECT status FROM payments WHERE id = ?4) = 'paid'",
      ).bind(o ? p.order_id : 0, o?.refund ?? 0, o?.refunded ?? 0, p.id),
    ]);
    return { ok: false, error: "TELEGRAM_REFUSED", details: { reason: rejected[1] } };
  }
  await notifyRefund(env, p.user_id, (_s, lang) => botText(lang, "starsRefunded", { amount: starsText(p.stars) }));
  return { ok: true };
}

/**
 * Admin: refund an order to the user's balance: what is still charged (charge minus any earlier refund), or only
 * `upTo` micro-USD of it when given.
 */
export async function refundOrderToBalance(env: Env, orderId: number, upTo?: number): Promise<RefundResult> {
  const o = await env.DB.prepare("SELECT id, user_id, np_order_id, service_name, charge, refund FROM orders WHERE id = ?1")
    .bind(orderId)
    .first<{ id: number; user_id: number; np_order_id: number | null; service_name: string; charge: number; refund: number }>();
  if (!o) return { ok: false, error: "NOT_FOUND" };
  const left = o.charge - o.refund;
  if (left <= 0) return { ok: false, error: "ALREADY_REFUNDED" };
  const amount = upTo === undefined ? left : Math.min(left, Math.floor(upTo));
  if (!(amount > 0)) return { ok: false, error: "INVALID_AMOUNT" };
  const now = Math.floor(Date.now() / 1000);
  // refunded = 1 (even for part of it) stops a later NotPanel cancel/partial from refunding the order on top (applyStatus)
  const [mark] = await env.DB.batch([
    env.DB.prepare("UPDATE orders SET refund = refund + ?3, refunded = 1 WHERE id = ?1 AND refund = ?2").bind(o.id, o.refund, amount),
    env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, note, created_at) SELECT ?1, ?2, 'refund', ?3, 'admin', ?4 WHERE changes() = 1").bind(
      o.user_id,
      amount,
      o.id,
      now,
    ),
    env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1 AND changes() = 1").bind(o.user_id, amount),
  ]);
  if (!mark.meta.changes) return { ok: false, error: "TRY_AGAIN" };
  await notifyRefund(env, o.user_id, (s, lang) =>
    botText(lang, "orderRefunded", { id: String(o.np_order_id ?? o.id), service: o.service_name, refund: amountText(amount, s) }),
  );
  return { ok: true };
}

/** Tells the user about an admin refund (best effort: a failed message never undoes the refund). */
async function notifyRefund(env: Env, userId: number, text: (s: Settings, lang: Lang) => string): Promise<void> {
  try {
    const u = await env.DB.prepare("SELECT lang, language_code, can_message FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ lang: string | null; language_code: string | null; can_message: number }>();
    if (!u?.can_message) return;
    const s = await getSettings(env);
    await tg(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: text(s, pickLang(u.lang ?? u.language_code)), parse_mode: "HTML" });
  } catch (e) {
    console.warn("refund notice failed", userId, (e as Error).message);
  }
}
