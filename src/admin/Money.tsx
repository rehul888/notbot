// Sale / cost / profit / margin pieces of the admin panel. The maths lives in shared/profit.ts; definitions below
// are shown to the owner as a legend so every number can be checked.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { orderMargin, profitOf, rateMargin, saleOf, type MoneyTotals, type OrderMoney, type ReportPeriod } from "../../shared/profit";
import { api } from "../api";
import { num } from "../format";
import { List, Num, Row, Section, Seg, Skeleton, errText, toast } from "../ui";
import { money, starsText, usdStars } from "./fmt";
import "./money.css";

export const LEGEND = "Sale = what customers paid minus refunds. Cost = what NotPanel charged you. Profit = Sale − Cost. Margin = Profit ÷ Sale.";

/** "23.1%", "−4.0%", or "—" when there is nothing to compare to. */
export const marginText = (m: number | null): string => (m === null ? "—" : `${m < 0 ? "−" : ""}${Math.abs(m).toFixed(1)}%`);

const tone = (n: number | null): "pos" | "neg" | undefined => (n === null ? undefined : n > 0 ? "pos" : n < 0 ? "neg" : undefined);

export interface Cell {
  label: string;
  value: ComponentChildren;
  sub?: ComponentChildren;
  tone?: "pos" | "neg";
}

/** A compact aligned row of labelled amounts. `inline` sits inside a Row's meta; otherwise it is a full-width block. */
export function MoneyCells({ cells, inline }: { cells: Cell[]; inline?: boolean }) {
  return (
    <span class={inline ? "mcells" : "mcells block"} style={`--cols:${cells.length}`}>
      {cells.map((c) => (
        <span key={c.label} class={`mc${c.tone ? ` ${c.tone}` : ""}`}>
          <span class="ml">{c.label}</span>
          <b>
            <Num>{c.value}</Num>
          </b>
          <span class="ms">{c.sub ?? "\u00a0"}</span>
        </span>
      ))}
    </span>
  );
}

/** Sale, Cost, Profit, Margin of one order. Unknown cost shows "—" for cost, profit and margin. */
export function orderCells(o: OrderMoney): Cell[] {
  const sale = saleOf(o);
  const profit = profitOf(o);
  const margin = orderMargin(o);
  return [
    { label: "Sale", value: money(sale), sub: usdStars(sale) },
    { label: "Cost", value: o.cost === null ? "—" : money(o.cost) },
    { label: "Profit", value: profit === null ? "—" : money(profit), tone: tone(profit) },
    { label: "Margin", value: marginText(margin), tone: tone(margin) },
  ];
}

/** Sums of a filter or period: profit and margin only cover orders whose cost is known. */
export function totalCells(t: MoneyTotals): Cell[] {
  return [
    { label: "Sale", value: money(t.sales), sub: usdStars(t.sales) },
    { label: "Cost", value: money(t.cost) },
    { label: "Profit", value: money(t.profit), tone: tone(t.salesWithCost > 0 || t.cost > 0 ? t.profit : null) },
    { label: "Margin", value: marginText(t.margin), tone: tone(t.margin) },
  ];
}

/** Per 1,000: NotPanel's price, our sell price (USD + Stars) and the margin. Zero or negative margin shows red. */
export function rateCells(cost: number, sell: number, sellStars: number): Cell[] {
  const { profit, margin } = rateMargin(cost, sell);
  const bad = profit <= 0 ? "neg" : "pos";
  return [
    { label: "Cost /1K", value: money(cost) },
    { label: "Sell /1K", value: starsText(sellStars), sub: `≈ ${money(sell)}` },
    { label: "Margin", value: marginText(margin), sub: `${profit > 0 ? "+" : ""}${money(profit)}`, tone: bad },
  ];
}

export function NoCostNote({ n }: { n: number }) {
  return n > 0 ? (
    <p class="note">
      {num(n)} {n === 1 ? "order" : "orders"} without cost yet {n === 1 ? "is" : "are"} left out of cost, profit and margin.
    </p>
  ) : null;
}

/** Totals bar for the orders filter currently on screen (computed by the server for the whole filter). */
export function MoneyTotalsBar({ totals }: { totals: MoneyTotals }) {
  return (
    <div class="card pad mtotals rise" role="group" aria-label="Totals for this filter">
      <div class="mhead">
        <span>Totals for this filter</span>
        <span>
          <Num>{num(totals.orders)}</Num> {totals.orders === 1 ? "order" : "orders"}
        </span>
      </div>
      <MoneyCells cells={totalCells(totals)} />
      <NoCostNote n={totals.noCost} />
      <span class="note">Failed orders are not counted. {LEGEND}</span>
    </div>
  );
}

// ---------------- Overview report ----------------

export interface Report extends MoneyTotals {
  period: ReportPeriod;
  salesStars: number;
  topServices: { id: number; name: string; orders: number; sales: number; cost: number; profit: number; margin: number | null }[];
}

const PERIODS: [ReportPeriod, string][] = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["all", "All time"],
];
const PERIOD_NOTE: Record<ReportPeriod, string> = {
  today: "since 00:00 UTC today",
  "7d": "the last 7 UTC days, including today",
  "30d": "the last 30 UTC days, including today",
  all: "since the first order",
};

function Tile({ label, sub, wide, tone: t, children }: { label: string; sub?: ComponentChildren; wide?: boolean; tone?: "pos" | "neg"; children: ComponentChildren }) {
  return (
    <div class="stat" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <span>{label}</span>
      <b class={t}>{children}</b>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

/** Period switcher with Orders, Sales, Cost, Profit and Margin tiles, plus the top services by profit. */
export function ProfitReport({ initial }: { initial: Report }) {
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [reports, setReports] = useState<Partial<Record<ReportPeriod, Report>>>({ today: initial });
  const asked = useRef(new Set<ReportPeriod>(["today"]));
  useEffect(() => {
    if (asked.current.has(period)) return;
    asked.current.add(period);
    api<Report>(`/admin/report?period=${period}`).then(
      (r) => setReports((m) => ({ ...m, [period]: r })),
      (e) => {
        asked.current.delete(period);
        toast(errText(e), "error");
        setPeriod("today");
      },
    );
  }, [period]);
  const r = reports[period];
  return (
    <>
      <Section header="Sales and profit" footer={`${PERIOD_NOTE[period]}. ${LEGEND} Failed orders are not counted.`}>
        <Seg value={period} options={PERIODS} onChange={setPeriod} label="Period" />
        {r ? (
          <div class="grid2" aria-live="polite">
            <Tile label="Orders">
              <Num>{num(r.orders)}</Num>
            </Tile>
            <Tile
              label="Sales"
              sub={
                <>
                  ≈ <Num>{money(r.sales)}</Num>
                </>
              }
            >
              <Num>{starsText(r.salesStars)}</Num>
            </Tile>
            <Tile label="Cost">
              <Num>{money(r.cost)}</Num>
            </Tile>
            <Tile label="Profit" tone={tone(r.cost > 0 || r.salesWithCost > 0 ? r.profit : null)}>
              <Num>{money(r.profit)}</Num>
            </Tile>
            <Tile label="Margin" wide tone={tone(r.margin)} sub="Profit ÷ sales">
              <Num>{marginText(r.margin)}</Num>
            </Tile>
          </div>
        ) : (
          <Skeleton h={232} radius={16} />
        )}
        {r && r.noCost > 0 ? <NoCostNote n={r.noCost} /> : null}
      </Section>
      {r && r.topServices.length ? (
        <Section header="Top services by profit">
          <List>
            {r.topServices.map((s) => (
              <Row
                key={s.id}
                wrap
                title={s.name}
                meta={
                  <>
                    <Num>{num(s.orders)}</Num> {s.orders === 1 ? "order" : "orders"} · sales <Num>{money(s.sales)}</Num> · margin <Num>{marginText(s.margin)}</Num>
                  </>
                }
                value={
                  <span class={tone(s.profit)}>
                    <Num>{money(s.profit)}</Num>
                  </span>
                }
              />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  );
}
