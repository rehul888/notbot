import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";

vi.mock("../worker/telegram", async (orig) => ({ ...(await orig<typeof import("../worker/telegram")>()), tg: vi.fn() }));
vi.mock("../worker/settings", async (orig) => ({
  ...(await orig<typeof import("../worker/settings")>()),
  getSettings: vi.fn(async () => (await orig<typeof import("../worker/settings")>()).DEFAULTS),
}));
const { tg } = await import("../worker/telegram");
const MIGRATIONS = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const { refundOrderToBalance, refundPayment } = await import("../worker/payments");

/** A real SQLite database with the project's migrations behind a minimal D1 interface (batch = one transaction). */
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of Object.keys(MIGRATIONS).sort()) db.exec(MIGRATIONS[f]);
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    exec() {
      const s = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) return { results: s.all(...(args as never[])), meta: { changes: 0 } };
      const r = s.run(...(args as never[]));
      return { results: [], meta: { changes: Number(r.changes) } };
    },
    first: async () => stmt(sql, args).exec().results[0] ?? null,
    all: async () => stmt(sql, args).exec(),
    run: async () => stmt(sql, args).exec(),
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { env: { DB, BOT_TOKEN: "t" } as unknown as Env, db };
}

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
