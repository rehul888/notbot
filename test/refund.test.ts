import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { d1 } from "./d1";

vi.mock("../worker/telegram", async (orig) => ({ ...(await orig<typeof import("../worker/telegram")>()), tg: vi.fn() }));
vi.mock("../worker/settings", async (orig) => ({
  ...(await orig<typeof import("../worker/settings")>()),
  getSettings: vi.fn(async () => (await orig<typeof import("../worker/settings")>()).DEFAULTS),
}));
vi.mock("../worker/notpanel", async (orig) => ({ ...(await orig<typeof import("../worker/notpanel")>()), npCall: vi.fn() }));
const { tg } = await import("../worker/telegram");
const { npCall, NotPanelError } = await import("../worker/notpanel");
const { refundOrderToBalance, refundPayment } = await import("../worker/payments");
const { applyStatus, orderView, refreshOrder } = await import("../worker/orders");

const USER = 7;
const row = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as Record<string, number | string>;

function seed(db: DatabaseSync, { balance, charge, orderRefund = 0, amount }: { balance: number; charge: number; orderRefund?: number; amount: number }) {
  db.exec(`INSERT INTO users (id, first_name, balance, can_message, created_at, last_seen_at) VALUES (${USER}, 'Ann', ${balance}, 1, 0, 0)`);
  db.exec(
    `INSERT INTO orders (id, user_id, service_id, service_name, platform, category, link, quantity, charge, status, refund, refunded, created_at, updated_at)
     VALUES (1, ${USER}, 5, 'Views', 'telegram', 'Views', 'https://t.me/a/1', 100, ${charge}, 'completed', ${orderRefund}, ${orderRefund ? 1 : 0}, 0, 0)`,
  );
  db.exec(`INSERT INTO payments (id, user_id, stars, amount, status, charge_id, order_id, created_at) VALUES (1, ${USER}, 2, ${amount}, 'paid', 'ch1', 1, 0)`);
}

describe("admin refunds", () => {
  beforeEach(() => vi.mocked(tg).mockReset().mockResolvedValue(true));

  it("refunds the Stars of a payment that bought an order, even though the balance was spent on it", async () => {
    const { env, db } = d1();
    seed(db, { balance: 1975, charge: 24000, amount: 25975 });
    expect(await refundPayment(env, 1)).toEqual({ ok: true });
    expect(vi.mocked(tg).mock.calls[0][1]).toBe("refundStarPayment");
    expect(row(db, "SELECT status FROM payments").status).toBe("refunded");
    // Only the leftover that was never spent on the order comes from the balance
    expect(row(db, "SELECT balance FROM users").balance).toBe(0);
    expect(row(db, "SELECT refund, refunded FROM orders")).toEqual({ refund: 24000, refunded: 1 });
    expect(row(db, "SELECT SUM(delta) d FROM ledger").d).toBe(-1975);
  });

  it("asks first when part of the payment was spent elsewhere, and with force takes only what is left", async () => {
    const { env, db } = d1();
    seed(db, { balance: 500, charge: 24000, amount: 25975 });
    expect(await refundPayment(env, 1)).toEqual({ ok: false, error: "BALANCE_ALREADY_SPENT", details: { spent: 1475 } });
    expect(tg).not.toHaveBeenCalled();
    expect((await refundPayment(env, 1, true)).ok).toBe(true);
    expect(row(db, "SELECT balance FROM users").balance).toBe(0);
  });

  it("takes an earlier partial refund back from the balance when the Stars go back", async () => {
    const { env, db } = d1();
    seed(db, { balance: 10000, charge: 24000, orderRefund: 8000, amount: 25975 });
    expect((await refundPayment(env, 1)).ok).toBe(true);
    expect(row(db, "SELECT balance FROM users").balance).toBe(10000 - (25975 - 16000));
    expect(row(db, "SELECT refund FROM orders").refund).toBe(24000);
  });

  it("undoes everything when Telegram refuses", async () => {
    const { env, db } = d1();
    seed(db, { balance: 1975, charge: 24000, amount: 25975 });
    vi.mocked(tg).mockRejectedValueOnce(new Error("Telegram refundStarPayment: 400 Bad Request: CHARGE_NOT_FOUND"));
    expect(await refundPayment(env, 1)).toEqual({ ok: false, error: "TELEGRAM_REFUSED", details: { reason: "Bad Request: CHARGE_NOT_FOUND" } });
    expect(row(db, "SELECT status FROM payments").status).toBe("paid");
    expect(row(db, "SELECT balance FROM users").balance).toBe(1975);
    expect(row(db, "SELECT refund, refunded FROM orders")).toEqual({ refund: 0, refunded: 0 });
    expect(row(db, "SELECT SUM(delta) d FROM ledger").d).toBe(0);
  });

  it("refunds an order to the balance once, and NotPanel can't refund it again", async () => {
    const { env, db } = d1();
    seed(db, { balance: 0, charge: 24000, orderRefund: 8000, amount: 25975 });
    expect((await refundOrderToBalance(env, 1)).ok).toBe(true);
    expect(row(db, "SELECT balance FROM users").balance).toBe(16000);
    expect(row(db, "SELECT refund, refunded FROM orders")).toEqual({ refund: 24000, refunded: 1 });
    expect(await refundOrderToBalance(env, 1)).toEqual({ ok: false, error: "ALREADY_REFUNDED" });
    expect(row(db, "SELECT balance FROM users").balance).toBe(16000);
    // The user is told; the Stars payment itself stays paid
    expect(vi.mocked(tg).mock.calls.at(-1)?.[1]).toBe("sendMessage");
    expect(row(db, "SELECT status FROM payments").status).toBe("paid");
  });

  it("refunds part of an order to the balance, then the rest, and never more than is left", async () => {
    const { env, db } = d1();
    seed(db, { balance: 0, charge: 24000, amount: 25975 });
    expect((await refundOrderToBalance(env, 1, 10000)).ok).toBe(true);
    expect(row(db, "SELECT refund, refunded FROM orders")).toEqual({ refund: 10000, refunded: 1 });
    expect(row(db, "SELECT balance FROM users").balance).toBe(10000);
    expect((await refundOrderToBalance(env, 1, 50000)).ok).toBe(true);
    expect(row(db, "SELECT refund FROM orders").refund).toBe(24000);
    expect(row(db, "SELECT balance FROM users").balance).toBe(24000);
    expect(row(db, "SELECT SUM(delta) d FROM ledger").d).toBe(24000);
    expect(await refundOrderToBalance(env, 1, 1)).toEqual({ ok: false, error: "ALREADY_REFUNDED" });
  });

  it("a Stars refund after a partial balance refund takes that part back from the balance", async () => {
    const { env, db } = d1();
    seed(db, { balance: 1975, charge: 24000, amount: 25975 });
    expect((await refundOrderToBalance(env, 1, 4000)).ok).toBe(true);
    expect((await refundPayment(env, 1)).ok).toBe(true);
    expect(row(db, "SELECT balance FROM users").balance).toBe(0);
    expect(row(db, "SELECT SUM(delta) d FROM ledger").d).toBe(-1975);
  });
});

describe("NotPanel cancel and refill flags", () => {
  const order = (db: DatabaseSync) => db.prepare("SELECT * FROM orders WHERE id = 1").get() as never;

  it("shows Cancel while a cancel request is possible, even after the instant-cancel seconds", async () => {
    const { env, db } = d1();
    seed(db, { balance: 0, charge: 24000, amount: 25975 });
    db.exec("UPDATE orders SET status = 'in_progress', np_order_id = 77, refunded = 0, refund = 0");
    await applyStatus(env, order(db), { status: "In progress", status_key: "in_progress", can_cancel: true, cancel_available: false, cancel_state: null });
    expect(orderView(order(db)).canCancel).toBe(true);

    // Once asked, NotPanel handles it: no second Cancel, and the order says so
    await applyStatus(env, order(db), { status: "In progress", status_key: "in_progress", can_cancel: false, cancel_available: false, cancel_state: "requested" });
    const v = orderView(order(db));
    expect(v.canCancel).toBe(false);
    expect(v.cancelState).toBe("requested");
  });

  it("keeps the time of the next refill while a refill isn't possible yet", async () => {
    const { env, db } = d1();
    seed(db, { balance: 0, charge: 24000, amount: 25975 });
    db.exec("UPDATE orders SET status = 'in_progress', np_order_id = 77");
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    await applyStatus(env, order(db), { status: "Completed", status_key: "completed", can_refill: false, refill_available_at: at });
    const v = orderView(order(db));
    expect(v.canRefill).toBe(false);
    expect(v.refillAt).toBe(Math.floor(Date.parse(at) / 1000));
  });
});

describe("orders NotPanel never answered", () => {
  const notFound = () => new NotPanelError("Order not found", "ORDER_NOT_FOUND", false, 404);
  const row = (db: DatabaseSync) => db.prepare("SELECT * FROM orders WHERE id = 1").get() as never;
  const submitting = (db: DatabaseSync, age: number, resentAgo: number | null = null) => {
    seed(db, { balance: 0, charge: 24000, amount: 25975 });
    const now = Math.floor(Date.now() / 1000);
    db.exec(`UPDATE orders SET status = 'submitting', refund = 0, refunded = 0, np_order_id = NULL, created_at = ${now - age},
      resent_at = ${resentAgo === null ? "NULL" : now - resentAgo}`);
  };
  beforeEach(() => vi.mocked(npCall).mockReset());

  it("sends it once more with the same request_id, and keeps NotPanel's order", async () => {
    const { env, db } = d1();
    submitting(db, 300);
    vi.mocked(npCall).mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ order: 555, status_key: "pending", charge: "0.02" });
    await refreshOrder(env, row(db));
    const add = vi.mocked(npCall).mock.calls[1];
    expect(add[1]).toBe("add");
    expect(add[2]).toMatchObject({ service: 5, request_id: "o1" });
    expect(row(db)).toMatchObject({ np_order_id: 555, status: "pending", refunded: 0 });
    expect((row(db) as { resent_at: number | null }).resent_at).not.toBeNull();
  });

  it("refunds when NotPanel still has no such order 10 minutes after the resend", async () => {
    const { env, db } = d1();
    submitting(db, 1500, 700);
    vi.mocked(npCall).mockRejectedValueOnce(notFound());
    await refreshOrder(env, row(db));
    expect(vi.mocked(npCall)).toHaveBeenCalledTimes(1); // no second resend
    expect(row(db)).toMatchObject({ status: "failed", error: "SUBMIT_FAILED", refunded: 1, refund: 24000 });
    expect((db.prepare("SELECT balance FROM users").get() as { balance: number }).balance).toBe(24000);
  });

  it("keeps NotPanel's own reason when the resend is refused", async () => {
    const { env, db } = d1();
    submitting(db, 300);
    vi.mocked(npCall)
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(new NotPanelError("Invalid drip-feed", "DRIP_FEED_INVALID", false, 400, { rule: "Each run must be at least 10" }));
    await refreshOrder(env, row(db));
    expect(row(db)).toMatchObject({ status: "failed", error: "DRIP_FEED_INVALID", error_detail: "Each run must be at least 10", refunded: 1 });
  });
});
