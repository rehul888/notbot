import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";

vi.mock("../worker/notpanel", async (orig) => ({ ...(await orig<typeof import("../worker/notpanel")>()), npCall: vi.fn() }));
const { npCall } = await import("../worker/notpanel");
const { pollOpenOrders } = await import("../worker/orders");

const order = (id: number, np: number) => ({ id, np_order_id: np, user_id: 1, status: "processing", quantity: 100, charge: 1000, refunded: 0, refund: 0, notified_status: null });

/** A D1 stand-in that hands out the open orders and records every write */
function fakeDb(open: ReturnType<typeof order>[]) {
  const runs: string[] = [];
  const batches: string[][] = [];
  const stmt = (sql: string) => ({
    sql,
    bind: () => stmt(sql),
    run: async () => (runs.push(sql), { meta: { changes: 0 } }),
    first: async () => (sql.includes("FROM orders") ? open[open.length - 1] : null),
    all: async () => ({ results: [] }),
  });
  let first = true;
  const DB = {
    prepare: stmt,
    batch: async (stmts: { sql: string }[]) => {
      if (first) {
        first = false;
        return [{ results: open }, { results: [] }];
      }
      batches.push(stmts.map((s) => s.sql));
      return stmts.map(() => ({ meta: { changes: 0 } }));
    },
  };
  return { env: { DB } as unknown as Env, runs, batches };
}

describe("pollOpenOrders", () => {
  it("saves running orders in one batch and finishes completed ones one by one", async () => {
    const open = [order(1, 11), order(2, 12), order(3, 13), order(4, 14)];
    vi.mocked(npCall).mockResolvedValueOnce({
      "11": { status: "In progress", status_key: "in_progress", remains: 40 },
      "12": { status: "Processing", status_key: "processing" },
      "13": { status: "?", status_key: "", error: "not found", error_code: "ORDER_NOT_FOUND" },
      "14": { status: "Completed", status_key: "completed", remains: 0 },
    });
    const { env, runs, batches } = fakeDb(open);
    await pollOpenOrders(env);
    // One batch for the three still-open orders (two status updates, one checked_at bump), no re-reads
    const poll = batches.find((b) => b.some((s) => s.startsWith("UPDATE orders SET checked_at")))!;
    expect(poll.length).toBe(3);
    expect(poll.filter((s) => s.startsWith("UPDATE orders SET status")).length).toBe(2);
    expect(poll.filter((s) => s.startsWith("UPDATE orders SET checked_at")).length).toBe(1);
    // The completed one alone goes through applyStatus: its own status update (then refund batch and notify claim)
    expect(runs.filter((s) => s.startsWith("UPDATE orders SET status")).length).toBe(1);
  });
});
