import { useEffect, useRef, useState } from "preact/hooks";
import type { OrderView } from "../../shared/types";
import { api } from "../api";
import { amount, dayKey, dayLabel, locale, num } from "../format";
import { t } from "../i18n";
import { enc, navigate } from "../router";
import { EmptyState, ErrorState, LargeTitle, LinkText, List, Num, PlatformLogo, Progress, Row, Screen, SearchField, Section, Seg, SkeletonList, StatusPill, errText, toast } from "../ui";

type Filter = "all" | "active" | "finished";
const PAGE = 30;

/**
 * The list last shown, kept for this app session. Coming back from an order (Back) or from another tab shows it at
 * once, with the same filter, search and scroll position, while a fresh first page loads in the background.
 */
let memo: { filter: Filter; q: string; items: OrderView[]; more: boolean } | null = null;

/** An order from the list last shown, so OrderDetail can draw it before its own request answers. */
export function cachedOrder(id: number): OrderView | undefined {
  return memo?.items.find((o) => o.id === id);
}

const pct = (part: number, whole: number) => new Intl.NumberFormat(locale(), { style: "percent" }).format(whole > 0 ? Math.floor((part / whole) * 100) / 100 : 0);

/**
 * One order: logo, service, "#id · quantity · paid" and the link, status pill. A running order shows a progress bar
 * with its percentage instead of the link (and no price, so the line never wraps next to the wider "In progress" pill);
 * the exact "9,620 of 10,000" is on the order's own screen.
 */
export function OrderRow({ o, first }: { o: OrderView; first?: boolean }) {
  const running = o.status === "in_progress" || o.status === "processing";
  const done = running && o.remains !== null ? Math.max(0, o.quantity - o.remains) : null;
  const ended = o.status === "cancelled" || o.status === "failed";
  return (
    <Row
      size="lg"
      class={first ? "first" : undefined}
      href={`/order/${o.id}`}
      lead={<PlatformLogo slug={o.platform} size={40} radius={11} />}
      title={o.serviceName}
      meta={
        <>
          <Num>#{o.number}</Num> · <Num>{num(o.quantity)}</Num>
          {done !== null ? null : <> · {ended ? t("orders.refunded") : <Num>{amount(o.charge - o.refund)}</Num>}</>}
          {done !== null ? (
            <span class="order-prog">
              <Progress value={done} max={o.quantity} label={t("orders.progress", { done: num(done), total: num(o.quantity) })} />
              <span>{pct(done, o.quantity)}</span>
            </span>
          ) : (
            <span class="order-prog">
              <span class="ellipsis">
                <LinkText href={o.link} />
              </span>
            </span>
          )}
        </>
      }
    >
      <StatusPill status={o.status} />
    </Row>
  );
}

export function Orders() {
  const [filter, setFilter] = useState<Filter>(memo?.filter ?? "all");
  const [q, setQ] = useState(memo?.q ?? "");
  const [items, setItems] = useState<OrderView[] | null>(memo?.items ?? null);
  const [more, setMore] = useState(memo?.more ?? false);
  /** The search the list on screen answers (the field may already hold newer text). */
  const [shownQ, setShownQ] = useState(memo?.q ?? "");
  const [error, setError] = useState<unknown>(null);
  const [paging, setPaging] = useState(false);
  /** Bumped by every first-page load; answers from an older filter or search are dropped. */
  const seq = useRef(0);
  const mounted = useRef(false);

  const page = (before?: number) => api<OrderView[]>(`/orders?filter=${filter}&q=${enc(q.trim())}${before ? `&before=${before}` : ""}`);

  /** First page. `refresh`: the remembered list is on screen; swap in the new first page and keep the older pages. */
  const load = async (refresh = false) => {
    const my = ++seq.current;
    setError(null);
    try {
      const list = await page();
      if (my !== seq.current) return;
      const full = list.length === PAGE;
      const rest = refresh && full && items ? items.filter((o) => o.id < list[list.length - 1].id) : [];
      const next = rest.length ? [...list, ...rest] : list;
      const nextMore = rest.length ? more : full;
      setItems(next);
      setMore(nextMore);
      setShownQ(q);
      memo = { filter, q, items: next, more: nextMore };
    } catch (e) {
      if (my !== seq.current) return;
      // A failed background refresh keeps the remembered list instead of replacing it with an error.
      if (!refresh) setError(e);
    }
  };

  const loadMore = async () => {
    if (!items?.length || paging) return;
    const my = seq.current;
    setPaging(true);
    try {
      const list = await page(items[items.length - 1].id);
      if (my !== seq.current) return;
      const seen = new Set(items.map((o) => o.id));
      const next = [...items, ...list.filter((o) => !seen.has(o.id))];
      const nextMore = list.length === PAGE;
      setItems(next);
      setMore(nextMore);
      memo = { filter, q, items: next, more: nextMore };
    } catch (e) {
      if (my === seq.current) toast(errText(e), "error");
    } finally {
      setPaging(false);
    }
  };

  useEffect(() => {
    const refresh = !mounted.current && items !== null;
    mounted.current = true;
    const id = setTimeout(() => load(refresh), q && !refresh ? 300 : 0);
    return () => clearTimeout(id);
  }, [filter, q]);

  // Group by day (the API returns newest first)
  const groups: { k: string; label: string; items: OrderView[] }[] = [];
  for (const o of items ?? []) {
    const k = dayKey(o.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.k === k) g.items.push(o);
    else groups.push({ k, label: dayLabel(o.createdAt, t("common.today"), t("common.yesterday")), items: [o] });
  }

  const query = shownQ.trim();
  let body;
  if (error) body = <ErrorState error={error} onRetry={() => load()} />;
  else if (!items) body = <SkeletonList rows={5} lead="logo" />;
  else if (!items.length) {
    body = query ? (
      <EmptyState art="search" title={t("orders.noResults", { q: query })} body={t("orders.noResultsSub")} />
    ) : filter === "active" ? (
      <EmptyState art="orders" title={t("orders.emptyActive")} body={t("orders.emptyActiveSub")} />
    ) : filter === "finished" ? (
      <EmptyState art="orders" title={t("orders.emptyFinished")} />
    ) : (
      <EmptyState art="orders" title={t("orders.empty")} body={t("orders.emptySub")} action={{ label: t("orders.start"), onClick: () => navigate("/", { replace: true }) }} />
    );
  } else
    body = groups.map((g, i) => (
      <Section key={g.k} header={g.label} class="day">
        <List stagger>
          {g.items.map((o) => (
            <OrderRow key={o.id} o={o} />
          ))}
          {more && i === groups.length - 1 ? <Row key="more" center title={paging ? t("common.loading") : t("common.showMore")} onClick={loadMore} disabled={paging} /> : null}
        </List>
      </Section>
    ));

  return (
    <Screen>
      <LargeTitle title={t("orders.title")} />
      <div class="section">
        <Seg
          label={t("orders.title")}
          value={filter}
          onChange={(f) => {
            if (f === filter) return;
            seq.current++;
            setItems(null);
            setMore(false);
            setError(null);
            setFilter(f);
          }}
          options={[
            ["all", t("orders.all")],
            ["active", t("orders.active")],
            ["finished", t("orders.finished")],
          ]}
        />
        <SearchField value={q} onInput={setQ} placeholder={t("orders.search")} />
      </div>
      {body}
    </Screen>
  );
}
