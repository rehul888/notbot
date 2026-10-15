import { type Lang, type OrderDraft, pickLang } from "../shared/types";
import { getService } from "./catalog";
import type { Env } from "./env";
import { botPlain, botText } from "./i18n";
import { linkText } from "./botMessages";
import { OrderError, placeOrder } from "./orders";
import { checkDraft } from "./pricing";
import { getSettings, type Settings } from "./settings";
import { tg, webAppButton } from "./telegram";

export const usd = (m: number) => "$" + (m / 1e6).toFixed(m > 0 && m < 100_000 ? 3 : 2);

export function starsFor(amount: number, s: Settings): number {
  return Math.max(1, Math.ceil((amount / 1e6) * s.stars_per_usd - 1e-9));
}

interface PaymentRow {
  id: number;
  user_id: number;
  stars: number;
  amount: number;
  draft: string | null;
  status: string;
  charge_id: string | null;
  order_id: number | null;
  created_at: number;
}

/** Creates a pending payment and a Stars invoice link for the Mini App to open with openInvoice. */
export async function createInvoice(
  env: Env,
  userId: number,
  lang: Lang,
  amount: number,
  draft: (OrderDraft & { label: string }) | null,
): Promise<{ link: string; stars: number; paymentId: number }> {
  const s = await getSettings(env);
  const stars = starsFor(amount, s);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "INSERT INTO payments (user_id, stars, amount, draft, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5) RETURNING id",
  )
    .bind(userId, stars, amount, draft ? JSON.stringify(draft) : null, now)
    .first<{ id: number }>();
  const id = row!.id;
  const title = botPlain(lang, "invoiceTitle").slice(0, 32);
  const description = (draft ? draft.label : botPlain(lang, "invoiceTopup", { amount: usd(amount) })).slice(0, 255);
  const link = await tg<string>(env.BOT_TOKEN, "createInvoiceLink", {
    title,
    description,
    payload: `p${id}`,
    currency: "XTR",
    prices: [{ label: title, amount: stars }],
  });
  return { link, stars, paymentId: id };
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
  const ok =
    !!p && p.status === "pending" && p.user_id === q.from.id && q.currency === "XTR" && q.total_amount === p.stars && now - p.created_at < 3600;
  await tg(env.BOT_TOKEN, "answerPreCheckoutQuery", {
    pre_checkout_query_id: q.id,
    ok,
    ...(ok ? {} : { error_message: "This payment link has expired. Please start the payment again in the app." }),
  });
}

/** Credits the balance once per Telegram charge, then places the order if the payment was for one. */
export async function onSuccessfulPayment(
  env: Env,
  from: { id: number; language_code?: string },
  sp: { invoice_payload: string; telegram_payment_charge_id: string; total_amount: number },
): Promise<void> {
  const p = await paymentFromPayload(env, sp.invoice_payload);
  if (!p) {
    console.error("payment without record", sp.telegram_payment_charge_id);
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
  if (!mark.meta.changes) return; // already processed

  const user = await env.DB.prepare("SELECT lang, language_code FROM users WHERE id = ?1").bind(p.user_id).first<{ lang: string | null; language_code: string | null }>();
  const lang = pickLang(user?.lang ?? user?.language_code ?? from.language_code);
  const s = await getSettings(env);
  const button = (id?: number) =>
    s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, id ? "viewOrder" : "open"), `${s.app_url}/#/${id ? `order/${id}` : "wallet"}`)]] } : undefined;

  if (!p.draft) {
    const bal = await env.DB.prepare("SELECT balance FROM users WHERE id = ?1").bind(p.user_id).first<{ balance: number }>();
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "topupDone", { amount: usd(p.amount), balance: usd(bal?.balance ?? p.amount) }),
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
    const order = await placeOrder(env, p.user_id, svc, draft.link.trim(), check.quantity, check.fields, draft.dripMinutes);
    await env.DB.prepare("UPDATE payments SET order_id = ?2 WHERE id = ?1").bind(p.id, order.id).run();
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "orderPlaced", { id: String(order.id), service: order.service_name, quantity: order.quantity.toLocaleString("en-US"), link: linkText(order.link) }),
      link_preview_options: { is_disabled: true },
      parse_mode: "HTML",
      reply_markup: button(order.id),
    });
  } catch (e) {
    const reason = e instanceof OrderError ? e.code : "ERROR";
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: p.user_id,
      text: botText(lang, "orderNotPlaced", { amount: usd(p.amount), reason }),
      parse_mode: "HTML",
      reply_markup: button(),
    });
  }
}

/** Admin: give the Stars back. Only possible while the user still has that much unspent balance. */
export async function refundPayment(env: Env, paymentId: number): Promise<{ ok: boolean; error?: string }> {
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id = ?1").bind(paymentId).first<PaymentRow>();
  if (!p || p.status !== "paid" || !p.charge_id) return { ok: false, error: "NOT_REFUNDABLE" };
  const now = Math.floor(Date.now() / 1000);
  const [reserve] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE payments SET status = 'refunded' WHERE id = ?1 AND status = 'paid' AND (SELECT balance FROM users WHERE id = ?2) >= ?3",
    ).bind(p.id, p.user_id, p.amount),
    env.DB.prepare("UPDATE users SET balance = balance - ?2 WHERE id = ?1 AND changes() = 1").bind(p.user_id, p.amount),
    env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, created_at) SELECT ?1, ?2, 'stars_refund', ?3, ?4 WHERE changes() = 1").bind(
      p.user_id,
      -p.amount,
      p.id,
      now,
    ),
  ]);
  if (!reserve.meta.changes) return { ok: false, error: "BALANCE_ALREADY_SPENT" };
  try {
    await tg(env.BOT_TOKEN, "refundStarPayment", { user_id: p.user_id, telegram_payment_charge_id: p.charge_id });
    return { ok: true };
  } catch (e) {
    // Undo the reservation
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET status = 'paid' WHERE id = ?1 AND status = 'refunded'").bind(p.id),
      env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, note, created_at) VALUES (?1, ?2, 'admin', ?3, 'refund failed', ?4)").bind(
        p.user_id,
        p.amount,
        p.id,
        now,
      ),
      env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1").bind(p.user_id, p.amount),
    ]);
    return { ok: false, error: (e as Error).message };
  }
}
