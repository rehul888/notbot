// Money reporting maths shared by the Worker (totals) and the admin panel (rows). Everything is integer micro-USD.
//
//   Sale   = what the customer paid for an order: charge - refund (a failed order is fully refunded, so its sale is 0)
//   Cost   = what NotPanel charged us (orders.cost, null while unknown, e.g. an order that is still being submitted)
//   Profit = Sale - Cost            Margin = Profit / Sale
//
// Cost on partial and cancelled orders: nothing is scaled here. worker/orders.ts applyStatus() overwrites orders.cost
// with NotPanel's reported `charge` on every status update, and refundFor() treats that `charge` as the amount left
// after NotPanel's own `refund` (original = charge + refund). So by the time an order is final, `cost` is already the
// net amount NotPanel kept, which pairs with our own net sale (charge - refund).

export interface OrderMoney {
  charge: number;
  refund: number;
  cost: number | null;
}

export const saleOf = (o: Pick<OrderMoney, "charge" | "refund">): number => o.charge - o.refund;

/** Profit of one order, or null when its cost is not known yet. */
export const profitOf = (o: OrderMoney): number | null => (o.cost === null || o.cost === undefined ? null : saleOf(o) - o.cost);

/** Profit / sale in percent, or null when there is no sale to compare to. */
export function marginPct(profit: number, sale: number): number | null {
  return sale > 0 ? (profit / sale) * 100 : null;
}

/** Margin of one order (null when cost is unknown or the sale is 0). */
export function orderMargin(o: OrderMoney): number | null {
  const p = profitOf(o);
  return p === null ? null : marginPct(p, saleOf(o));
}

/** Per-1,000 view of a service: NotPanel's price vs. our sell price (both micro-USD per 1,000). */
export function rateMargin(cost: number, sell: number): { profit: number; margin: number | null } {
  return { profit: sell - cost, margin: marginPct(sell - cost, sell) };
}

export interface MoneyTotals {
  /** Orders counted (failed ones are left out) */
  orders: number;
  /** Sale of every counted order */
  sales: number;
  /** Cost and sale of the orders whose cost is known; profit and margin only cover these */
  cost: number;
  salesWithCost: number;
  profit: number;
  margin: number | null;
  /** Counted orders whose cost is not known yet */
  noCost: number;
}

/** Raw sums as the aggregate queries return them. */
export interface MoneySums {
  orders: number;
  sales: number;
  cost: number;
  salesWithCost: number;
  noCost: number;
}

export function totalsFrom(r: Partial<MoneySums> | null | undefined): MoneyTotals {
  const orders = r?.orders ?? 0;
  const sales = r?.sales ?? 0;
  const cost = r?.cost ?? 0;
  const salesWithCost = r?.salesWithCost ?? 0;
  const profit = salesWithCost - cost;
  return { orders, sales, cost, salesWithCost, profit, margin: marginPct(profit, salesWithCost), noCost: r?.noCost ?? 0 };
}

/**
 * SQL for the sums above over `orders` (alias-free columns). Failed orders are always left out; add other filters
 * in the WHERE clause around it.
 */
export const MONEY_SUMS_SQL = `COUNT(*) AS orders,
  COALESCE(SUM(charge - refund), 0) AS sales,
  COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN cost END), 0) AS cost,
  COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN charge - refund END), 0) AS salesWithCost,
  COALESCE(SUM(cost IS NULL), 0) AS noCost`;

export type ReportPeriod = "today" | "7d" | "30d" | "all";
export const REPORT_PERIODS: ReportPeriod[] = ["today", "7d", "30d", "all"];

/** Unix start (seconds) of a period in UTC days: today = since 00:00 UTC, 7d = today and the 6 days before, etc. */
export function periodStart(period: ReportPeriod, nowMs: number): number {
  if (period === "all") return 0;
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  const days = period === "7d" ? 6 : period === "30d" ? 29 : 0;
  return Math.floor(d.getTime() / 1000) - days * 86400;
}

export const parsePeriod = (v: string | undefined | null): ReportPeriod => (REPORT_PERIODS as string[]).includes(v ?? "") ? (v as ReportPeriod) : "today";
