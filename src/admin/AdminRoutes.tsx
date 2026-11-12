// Owner-only admin panel (English only, per AGENTS.md). The server checks the owner's Telegram ID on every /api/admin call.
// Same primitives as the customer screens (spec §5.13): Screen + LargeTitle + Section/List/Row, saves on the MainButton.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { platformName } from "../../shared/platforms";
import type { OrderView } from "../../shared/types";
import { api, ApiError, clearApiCache } from "../api";
import { balanceStars, MAX_STARS_PER_PAYMENT, shownStars, starsCredit } from "../../shared/stars";
import type { MoneyTotals } from "../../shared/profit";
import { dateTime, num, starsRate } from "../format";
import { Icon, type IconName } from "../icons";
import { refreshMe } from "../me";
import { back as goBack, enc, navigate } from "../router";
import { confirmDialog, haptic, openLink, type ButtonSpec } from "../tg";
import { AdminBranding } from "./Branding";
import { balStars, money, starsText, usdStars } from "./fmt";
import { LEGEND, MoneyCells, MoneyTotalsBar, orderCells, ProfitReport, rateCells, type Report } from "./Money";
import { AdminsSection, NotPanelKeySection, type Owners } from "./Access";
import {
  BackNav,
  BottomButtons,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  LargeTitle,
  List,
  Notice,
  Num,
  PlatformLogo,
  Presets,
  Progress,
  Row,
  Screen,
  SearchField,
  Section,
  Seg,
  Sheet,
  Skeleton,
  SkeletonList,
  StatusPill,
  Switch,
  errText,
  toast,
  useAsync,
} from "../ui";

export function AdminRoutes({ parts, query }: { parts: string[]; query: URLSearchParams }) {
  const [a, b, c] = parts;
  if (!a) return <AdminHome />;
  if (a === "prices" && b && c) return <AdminCategory platform={b} category={c} />;
  if (a === "prices" && b) return <AdminPlatform platform={b} />;
  if (a === "prices") return <AdminPrices q={query.get("q") ?? ""} />;
  if (a === "changes") return <AdminChanges />;
  if (a === "payments") return <AdminPayments user={query.get("user")} q0={query.get("q") ?? ""} />;
  if (a === "users" && b) return <AdminUser id={b} />;
  if (a === "users") return <AdminUsers />;
  if (a === "referrals") return <AdminReferrals />;
  if (a === "orders") return <AdminOrders user={query.get("user")} q0={query.get("q") ?? ""} />;
  if (a === "branding") return <AdminBranding />;
  if (a === "settings") return <AdminSettings />;
  return <AdminHome />;
}

// ---------------- helpers ----------------

const NP_WALLET = "https://notpanel.com/dashboard/wallet";
const MAX_MARKUP = 1000;
const ONE_USD = 1_000_000;

const pct = (n: number) => `+${+n.toFixed(1)}%`;
/** Signed change with a real minus sign, e.g. "+2.1%" / "−1.4%". */
const delta = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(1)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Same rounding as the worker's sellRate(): cost plus markup, rounded up to the next 100 micro-USD per 1K. */
const sellFor = (cost: number, markupPct: number) => Math.ceil((cost * (1 + Math.max(0, markupPct) / 100)) / 100 - 1e-9) * 100;
const invalidate = () => clearApiCache();
export const fail = (e: unknown) => toast(errText(e), "error");

export function Page({
  back,
  title,
  sub,
  size = "title",
  lead,
  overlay,
  main = null,
  children,
}: {
  back: string;
  title: string;
  sub?: ComponentChildren;
  size?: "large" | "title" | "title2";
  lead?: ComponentChildren;
  overlay?: ComponentChildren;
  /** Primary bottom action (Save…); a Back button is always shown next to it */
  main?: ButtonSpec | null;
  children: ComponentChildren;
}) {
  return (
    <>
      <BackNav to={back} />
      <Screen
        bottom="native"
        overlay={
          <>
            {overlay}
            <BottomButtons main={main} secondary={{ text: "Back", onClick: () => goBack(back) }} />
          </>
        }
      >
        <LargeTitle size={size} title={title} sub={sub} lead={lead} />
        {children}
      </Screen>
    </>
  );
}

function Loader<T>({ res, skeleton, children }: { res: { data: T | undefined; error: unknown; reload: () => void }; skeleton?: ComponentChildren; children: (d: T) => ComponentChildren }) {
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (res.data === undefined) return <>{skeleton ?? <SkeletonList rows={4} lead="none" />}</>;
  return <>{children(res.data)}</>;
}

interface Paged<T> {
  items: T[];
  next: string | number | null;
}

/**
 * Cursor-paged admin list: loads `url` (debounced, newest request wins), then "Show more" appends the next page
 * with `&<cursorKey>=<next>`. `extra` is the first response (e.g. cached totals). `url === null` keeps it idle.
 */
function usePaged<T, X = unknown>(url: string | null, delay = 0, cursorKey = "before") {
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<Paged<T>["next"]>(null);
  const [extra, setExtra] = useState<(Paged<T> & X) | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (url === null) {
      seq.current++;
      setItems(null);
      return;
    }
    const n = ++seq.current;
    setErr(null);
    const id = setTimeout(
      () =>
        api<Paged<T> & X>(url).then(
          (r) => {
            if (n !== seq.current) return;
            setItems(r.items);
            setNext(r.next);
            setExtra(r);
            setBusy(false);
          },
          (e) => {
            if (n !== seq.current) return;
            setItems(null);
            setErr(e);
          },
        ),
      delay,
    );
    return () => clearTimeout(id);
  }, [url, tick]);
  const more = async () => {
    if (url === null || next === null || busy) return;
    const n = seq.current;
    setBusy(true);
    try {
      const r = await api<Paged<T>>(`${url}${url.includes("?") ? "&" : "?"}${cursorKey}=${enc(String(next))}`);
      if (n === seq.current) {
        setItems((l) => [...(l ?? []), ...r.items]);
        setNext(r.next);
      }
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  /** Reload from the first page, keeping the current rows on screen meanwhile. */
  const reload = () => setTick((t) => t + 1);
  /** Clears the rows so the skeleton shows (used when a filter chip changes). */
  const reset = () => setItems(null);
  return { items, next, extra, err, busy, more, reload, reset };
}

function ShowMore({ next, busy, onClick }: { next: unknown; busy: boolean; onClick: () => void }) {
  return next !== null && next !== undefined ? (
    <Chip label="Show more" disabled={busy} onClick={onClick}>
      {busy ? "Loading…" : "Show more"}
    </Chip>
  ) : null;
}

/** One key/value line in a `dl.card`. With `id`, the label focuses that input. */
export function Kv({ label, id, children }: { label: string; id?: string; children: ComponentChildren }) {
  return (
    <div class="kv">
      <dt>{id ? <label for={id}>{label}</label> : label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Stat({ label, ok, sub, wide, children }: { label: string; ok?: boolean; sub?: ComponentChildren; wide?: boolean; children: ComponentChildren }) {
  return (
    <div class="stat" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <span>{label}</span>
      <b class={ok ? "ok-text" : undefined}>{children}</b>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

/** "Example: a $1.00 NotPanel service sells for $1.40." */
function Example({ markup }: { markup: number }) {
  return (
    <>
      Example: a <Num>{money(ONE_USD)}</Num> NotPanel service sells for <Num>{money(sellFor(ONE_USD, markup))}</Num>.
    </>
  );
}

/** Markup stepper used for default, platform, category and service markups. */
function MarkupEditor({ value, onChange, presets = [20, 30, 50, 100], class: cls }: { value: number; onChange: (n: number) => void; presets?: number[]; class?: string }) {
  // Raw text while the field has focus; "40%" otherwise.
  const [text, setText] = useState<string | null>(null);
  const shown = String(+value.toFixed(2));
  const step = (dir: 1 | -1) => {
    const next = Math.max(0, Math.min(MAX_MARKUP, Math.round(value + dir * 5)));
    if ((dir < 0 && next === 0) || (dir > 0 && next === MAX_MARKUP)) haptic.edge();
    else haptic.select();
    if (next !== value) onChange(next);
  };
  return (
    <div class={cls ? `card qty-card ${cls}` : "card qty-card"}>
      <div class="qty">
        <button type="button" class="iconbtn lg qty-btn" aria-label="Lower markup by 5%" onClick={() => step(-1)}>
          <Icon name="minus" size={20} stroke={2.4} />
        </button>
        <div class="qty-mid">
          <input
            class="qty-input num-l"
            aria-label="Markup percent"
            inputMode="decimal"
            enterKeyHint="done"
            dir="ltr"
            autoComplete="off"
            value={text ?? `${shown}%`}
            onFocus={(e) => {
              const el = e.currentTarget;
              setText(shown);
              requestAnimationFrame(() => el.select());
            }}
            onBlur={() => setText(null)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onInput={(e) => {
              const raw = e.currentTarget.value.replace(/[^\d.]/g, "");
              setText(raw);
              onChange(Math.max(0, Math.min(MAX_MARKUP, Number(raw) || 0)));
            }}
          />
          <span class="qty-unit">on top of NotPanel prices</span>
        </div>
        <button type="button" class="iconbtn lg qty-btn" aria-label="Raise markup by 5%" onClick={() => step(1)}>
          <Icon name="plus" size={20} stroke={2.4} />
        </button>
      </div>
      <Presets value={presets.includes(value) ? value : null} options={presets.map((p): [number, string] => [p, `${p}%`])} onChange={onChange} label="Markup presets" />
    </div>
  );
}

// ---------------- Home ----------------

interface Overview {
  npBalance: number | null;
  npError: string | null;
  lowBalance: number;
  today: Report;
  users: number;
  referralsJoined?: number;
  openOrders: number;
  needsAttention: number;
  defaultMarkup: number;
  lastSync: { at: number; total: number; added: number; updated: number; removed: number; priceUp: number; priceDown: number; unchanged?: boolean; error?: string } | null;
}

const MANAGE: [string, IconName, string, string][] = [
  ["Services & prices", "sliders", "var(--lavender-strong)", "/admin/prices"],
  ["Price changes", "chart", "var(--sky)", "/admin/changes"],
  ["Payments", "wallet", "var(--lime)", "/admin/payments"],
  ["Users", "users", "var(--pink)", "/admin/users"],
  ["Referrals", "star", "var(--cream)", "/admin/referrals"],
  ["All orders", "list", "var(--sky)", "/admin/orders"],
  ["Branding", "spark", "var(--pink)", "/admin/branding"],
  ["Settings & connection", "plug", "var(--lavender)", "/admin/settings"],
];

function syncLine(l: NonNullable<Overview["lastSync"]>) {
  const what = l.error ? `failed: ${l.error}` : l.unchanged ? "no changes" : `${plural(l.total, "service")}, ${num(l.priceUp)} prices up, ${num(l.priceDown)} down`;
  return `Last price sync ${dateTime(l.at)} · ${what}`;
}

function AdminHome() {
  const res = useAsync(() => api<Overview>("/admin/overview"), []);
  return (
    <Page back="/profile" title="Admin" sub="Only you can see this" size="large">
      <Loader
        res={res}
        skeleton={
          <>
            <Skeleton h={152} radius={20} />
            <Skeleton h={76} radius={16} />
            <SkeletonList rows={6} />
          </>
        }
      >
        {(o) => {
          const low = o.npBalance !== null && o.npBalance < o.lowBalance;
          const value = (href: string) =>
            href === "/admin/prices" ? <Num>{pct(o.defaultMarkup)}</Num> : href === "/admin/users" ? num(o.users) : href === "/admin/referrals" ? num(o.referralsJoined ?? 0) : href === "/admin/orders" && o.openOrders ? `${num(o.openOrders)} open` : undefined;
          const n = o.needsAttention;
          return (
            <>
              <div class="card pad svc-card rise">
                <div class="head">
                  <span class="tile md brand" aria-hidden="true">
                    <Icon name="plug" size={20} stroke={1.8} />
                  </span>
                  <div>
                    <b class="t-headline">Your NotPanel account</b>
                  </div>
                  <span class={`status ${o.npError ? "st-cancel" : "st-done"}`}>{o.npError ? "Error" : "Connected"}</span>
                </div>
                <div class="head">
                  <div>
                    <span>NotPanel balance</span>
                    <b class="num-m">{o.npBalance !== null ? <Num>{money(o.npBalance)}</Num> : "—"}</b>
                  </div>
                  <Chip tint label="Top up on notpanel.com" onClick={() => openLink(NP_WALLET)}>
                    Top up
                    <Icon name="out" size={14} stroke={2.4} />
                  </Chip>
                </div>
                {o.npError ? <Notice tone="error">{o.npError}</Notice> : null}
                {low ? <Notice tone="warn">Low balance: orders will fail when your NotPanel balance runs out.</Notice> : null}
                {!o.npError && !low ? <span class="t-footnote hint">Every order is paid from this balance.</span> : null}
              </div>

              <ProfitReport initial={o.today} />

              {n ? (
                <Notice tone="warn" onClick={() => navigate("/admin/prices?q=attention")}>
                  {plural(n, "service")} {n === 1 ? "is" : "are"} hidden because {n === 1 ? "its" : "their"} fixed price is below NotPanel's cost. <b>Review</b>
                </Notice>
              ) : null}

              <Section header="Manage" footer={o.lastSync ? syncLine(o.lastSync) : undefined}>
                <List stagger>
                  {MANAGE.map(([title, icon, plate, href]) => (
                    <Row key={href} icon={icon} plate={plate} title={title} href={href} value={value(href)} />
                  ))}
                </List>
              </Section>
            </>
          );
        }}
      </Loader>
    </Page>
  );
}

// ---------------- Prices ----------------

interface AdminPlatformRow {
  slug: string;
  name: string;
  count: number;
  enabledServices: number;
  enabled: boolean;
  markupPct: number | null;
}
interface AdminCategoryRow {
  name: string;
  count: number;
  enabledServices: number;
  enabled: boolean;
  markupPct: number | null;
}
interface AdminServiceRow {
  id: number;
  name: string;
  customName: string | null;
  platform: string;
  category: string;
  cost: number;
  prevCost: number | null;
  sell: number;
  sellStars: number;
  starsPerUsd: number;
  markup: number;
  markupPct: number | null;
  fixedRate: number | null;
  min: number;
  max: number;
  enabled: boolean;
}

const onSale = (x: { enabledServices: number; count: number; enabled: boolean }) => `${num(x.enabledServices)} of ${num(x.count)} on sale${x.enabled ? "" : " · hidden"}`;

function AdminPrices({ q: initialQ }: { q: string }) {
  const attention = initialQ === "attention";
  const settings = useAsync(() => api<{ default_markup_pct: number }>("/admin/settings"), []);
  const platforms = useAsync(() => (attention ? Promise.resolve([] as AdminPlatformRow[]) : api<AdminPlatformRow[]>("/admin/platforms")), []);
  const [markup, setMarkup] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(attention ? "" : initialQ);
  const [edit, setEdit] = useState<AdminServiceRow | null>(null);
  // Search needs 2+ characters; the attention view lists straight away. Pages of 50 via "Show more".
  const pg = usePaged<AdminServiceRow>(attention ? "/admin/services?attention=1" : q.trim().length >= 2 ? `/admin/services?q=${enc(q.trim())}` : null, attention ? 0 : 300, "offset");
  const results = pg.items;
  const search = pg.reload;

  useEffect(() => {
    if (settings.data) setMarkup(settings.data.default_markup_pct);
  }, [settings.data]);

  const dirty = markup !== null && !!settings.data && markup !== settings.data.default_markup_pct;
  const save = async () => {
    if (markup === null || !settings.data) return;
    setSaving(true);
    try {
      await api("/admin/settings", { method: "PUT", body: { default_markup_pct: markup } });
      invalidate();
      settings.set({ ...settings.data, default_markup_pct: markup });
      toast(`Default markup saved: ${pct(markup)}`, "ok");
      if (results) search(); // sell prices in the list just changed
    } catch (e) {
      fail(e);
    }
    setSaving(false);
  };

  const list =
    attention || results ? (
      <Section header={attention ? undefined : "Services"}>
        {results ? (
          <>
            <AdminServiceList
              items={results}
              onEdit={setEdit}
              onChanged={search}
              empty={
                attention
                  ? { title: "Nothing needs attention", body: "Every fixed price is above NotPanel's cost." }
                  : { title: `No services match “${q.trim()}”`, body: "Try another name or a service ID." }
              }
            />
            <ShowMore next={pg.next} busy={pg.busy} onClick={pg.more} />
          </>
        ) : pg.err ? (
          <ErrorState error={pg.err} onRetry={search} />
        ) : (
          <SkeletonList rows={5} lead="none" />
        )}
      </Section>
    ) : (
      <Section header="Platforms">
        <Loader res={platforms} skeleton={<SkeletonList rows={6} lead="logo" />}>
          {(rows) =>
            rows.length ? (
              <List stagger>
                {rows.map((p) => (
                  <Row
                    key={p.slug}
                    lead={<PlatformLogo slug={p.slug} size={36} radius={10} />}
                    title={p.name}
                    meta={onSale(p)}
                    value={p.markupPct !== null ? <Num>{pct(p.markupPct)}</Num> : undefined}
                    href={`/admin/prices/${enc(p.slug)}`}
                  />
                ))}
              </List>
            ) : (
              <EmptyState compact art="search" title="No platforms yet" body="They appear after the first price sync." />
            )
          }
        </Loader>
      </Section>
    );

  return (
    <Page
      back="/admin"
      title={attention ? "Hidden services" : "Services & prices"}
      sub={attention ? "Their fixed price is below NotPanel's cost. Tap one to change its price." : "Sell price = NotPanel cost + markup"}
      main={dirty ? { text: `Save markup ${pct(markup!)}`, onClick: save, progress: saving } : null}
      overlay={edit ? <ServiceEditSheet s={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), search())} /> : null}
    >
      {!attention ? (
        <Section
          header="Default markup"
          footer={
            markup !== null ? (
              <>
                <Example markup={markup} /> Platforms, categories and services can set their own.
              </>
            ) : undefined
          }
        >
          {settings.error ? (
            <ErrorState compact error={settings.error} onRetry={settings.reload} />
          ) : markup !== null ? (
            <MarkupEditor class="rise" value={markup} onChange={setMarkup} />
          ) : (
            <Skeleton h={156} radius={20} />
          )}
        </Section>
      ) : null}
      {!attention ? <SearchField value={q} onInput={setQ} placeholder="Find a service by name or ID" /> : null}
      {list}
    </Page>
  );
}

type RuleSrc = { enabled: boolean; markupPct: number | null };

/**
 * Platform or category rule: "Show this …" and "Own markup" toggles plus the markup editor.
 * Visibility and removing an own markup save at once; a new markup saves on the MainButton (`main`).
 */
function useRule(platform: string, category: string | undefined, src: RuleSrc | undefined, defaultMarkup: number | undefined, onSaved: () => void): { body: JSX.Element; main: ButtonSpec | null } {
  const what = category ? "category" : "platform";
  const [show, setShow] = useState<boolean | null>(null);
  const [own, setOwn] = useState<boolean | null>(null);
  const [value, setValue] = useState<number | null>(null);
  // A markup we saved that the reloaded data hasn't confirmed yet (keeps the MainButton from flashing back).
  const [pending, setPending] = useState<{ v: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setShow(null), [src?.enabled]);
  useEffect(() => {
    setOwn(null);
    setValue(null);
    setPending(null);
  }, [src?.markupPct]);

  if (!src || defaultMarkup === undefined) return { body: <Skeleton h={112} radius={20} />, main: null };

  const base = pending ? pending.v : src.markupPct;
  const ownOn = own ?? base !== null;
  const val = value ?? base ?? defaultMarkup;
  const shown = show ?? src.enabled;
  const put = (body: Record<string, unknown>) =>
    api("/admin/rule", { method: "PUT", body: { platform, category: category ?? "", ...body } }).then(() => {
      invalidate();
      onSaved();
    });

  const toggleShow = (v: boolean) => {
    setShow(v);
    put({ enabled: v }).catch((e) => {
      setShow(null);
      fail(e);
    });
  };
  const toggleOwn = (v: boolean) => {
    setOwn(v);
    if (v || base === null) return;
    put({ markupPct: null }).then(
      () => setPending({ v: null }),
      (e) => {
        setOwn(null);
        fail(e);
      },
    );
  };
  const save = async () => {
    setSaving(true);
    try {
      await put({ markupPct: val });
      setPending({ v: val });
      toast(`${cap(what)} markup saved: ${pct(val)}`, "ok");
    } catch (e) {
      fail(e);
    }
    setSaving(false);
  };

  const dirty = ownOn && (base === null || val !== base);
  const body = (
    <Section footer={ownOn ? <Example markup={val} /> : undefined}>
      <List>
        <Row toggle={{ on: shown, onChange: toggleShow }} title={`Show this ${what}`} meta={shown ? "Customers can order from it" : "Hidden from customers"} />
        <Row
          toggle={{ on: ownOn, onChange: toggleOwn }}
          title="Own markup"
          meta={ownOn ? `Overrides the ${category ? "platform and default" : "default"} markup` : category ? "Uses the platform or default markup" : "Uses the default markup"}
        />
      </List>
      {ownOn ? <MarkupEditor class="rise" value={val} onChange={setValue} /> : null}
    </Section>
  );
  return { body, main: dirty ? { text: `Save ${what} markup ${pct(val)}`, onClick: save, progress: saving } : null };
}

function AdminPlatform({ platform }: { platform: string }) {
  const settings = useAsync(() => api<{ default_markup_pct: number }>("/admin/settings"), []);
  const platforms = useAsync(() => api<AdminPlatformRow[]>("/admin/platforms"), []);
  const cats = useAsync(() => api<AdminCategoryRow[]>(`/admin/categories?platform=${enc(platform)}`), [platform]);
  const p = platforms.data?.find((x) => x.slug === platform);
  const rule = useRule(platform, undefined, p, settings.data?.default_markup_pct, platforms.reload);
  const ruleErr = platforms.error ?? settings.error;
  return (
    <Page
      back="/admin/prices"
      title={platformName(platform)}
      sub="Rules here apply to all its categories"
      lead={<PlatformLogo slug={platform} size={48} radius={14} />}
      main={rule.main}
    >
      {ruleErr ? (
        <ErrorState compact error={ruleErr} onRetry={() => (platforms.reload(), settings.reload())} />
      ) : platforms.data && !p ? (
        <Notice tone="warn">This platform is no longer in the NotPanel catalog.</Notice>
      ) : (
        rule.body
      )}
      <Section header="Categories">
        <Loader res={cats} skeleton={<SkeletonList rows={5} lead="none" />}>
          {(list) =>
            list.length ? (
              <List stagger>
                {list.map((c) => (
                  <Row
                    key={c.name}
                    wrap
                    title={c.name}
                    meta={onSale(c)}
                    value={c.markupPct !== null ? <Num>{pct(c.markupPct)}</Num> : undefined}
                    href={`/admin/prices/${enc(platform)}/${enc(c.name)}`}
                  />
                ))}
              </List>
            ) : (
              <EmptyState compact art="search" title="No categories yet" body="They appear after the next price sync." />
            )
          }
        </Loader>
      </Section>
    </Page>
  );
}

function AdminCategory({ platform, category }: { platform: string; category: string }) {
  const settings = useAsync(() => api<{ default_markup_pct: number }>("/admin/settings"), []);
  const cats = useAsync(() => api<AdminCategoryRow[]>(`/admin/categories?platform=${enc(platform)}`), [platform]);
  const services = usePaged<AdminServiceRow>(`/admin/services?platform=${enc(platform)}&category=${enc(category)}`, 0, "offset");
  const [edit, setEdit] = useState<AdminServiceRow | null>(null);
  const c = cats.data?.find((x) => x.name === category);
  const rule = useRule(platform, category, c, settings.data?.default_markup_pct, () => (cats.reload(), services.reload()));
  const ruleErr = cats.error ?? settings.error;
  return (
    <Page
      back={`/admin/prices/${enc(platform)}`}
      title={category}
      sub={platformName(platform)}
      size="title2"
      lead={<PlatformLogo slug={platform} size={48} radius={14} />}
      main={rule.main}
      overlay={edit ? <ServiceEditSheet s={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), services.reload())} /> : null}
    >
      {ruleErr ? (
        <ErrorState compact error={ruleErr} onRetry={() => (cats.reload(), settings.reload())} />
      ) : cats.data && !c ? (
        <Notice tone="warn">This category is no longer in the NotPanel catalog.</Notice>
      ) : (
        rule.body
      )}
      <Section header="Services" footer="Tap a service to rename it or give it its own price.">
        {services.err && !services.items ? (
          <ErrorState compact error={services.err} onRetry={services.reload} />
        ) : !services.items ? (
          <SkeletonList rows={5} lead="none" />
        ) : (
          <>
            <AdminServiceList items={services.items} onEdit={setEdit} onChanged={services.reload} empty={{ title: "No services in this category" }} />
            <ShowMore next={services.next} busy={services.busy} onClick={services.more} />
          </>
        )}
      </Section>
    </Page>
  );
}

function priceDiff(s: AdminServiceRow): string | null {
  if (s.prevCost === null || s.prevCost === s.cost || !s.prevCost) return null;
  const d = ((s.cost - s.prevCost) / s.prevCost) * 100;
  return `${d > 0 ? "↑" : "↓"}${Math.abs(d).toFixed(1)}%`;
}

function AdminServiceList({ items, onEdit, onChanged, empty }: { items: AdminServiceRow[]; onEdit: (s: AdminServiceRow) => void; onChanged: () => void; empty: { title: string; body?: string } }) {
  // Switches flip at once; the reloaded list confirms them (or an error puts them back).
  const [flip, setFlip] = useState<Record<number, boolean>>({});
  useEffect(() => setFlip({}), [items]);
  const toggle = async (s: AdminServiceRow, on: boolean) => {
    setFlip((f) => ({ ...f, [s.id]: on }));
    try {
      await api(`/admin/services/${s.id}`, { method: "PUT", body: { enabled: on } });
      invalidate();
      onChanged();
    } catch (e) {
      setFlip((f) => {
        const next = { ...f };
        delete next[s.id];
        return next;
      });
      fail(e);
    }
  };
  if (!items.length) return <EmptyState compact art="search" title={empty.title} body={empty.body} />;
  return (
    <List stagger>
      {items.map((s) => {
        const diff = priceDiff(s);
        const below = s.fixedRate !== null && s.fixedRate < s.cost;
        return (
          <Row
            key={s.id}
            wrap
            title={s.customName ?? s.name}
            meta={
              <>
                <Num>#{s.id}</Num>
                {diff ? (
                  <>
                    {" · NotPanel price "}
                    <Num>{diff}</Num>
                  </>
                ) : null}
                {s.fixedRate !== null ? (
                  " · fixed price"
                ) : s.markupPct !== null ? (
                  <>
                    {" · markup "}
                    <Num>{pct(s.markupPct)}</Num>
                  </>
                ) : (
                  ""
                )}
                <MoneyCells inline cells={rateCells(s.cost, s.sell, s.sellStars)} />
                {below ? (
                  <>
                    <br />
                    <span class="status st-cancel">Below cost: hidden</span>
                  </>
                ) : null}
              </>
            }
            onClick={() => onEdit(s)}
            control={<Switch on={flip[s.id] ?? s.enabled} label={`Sell ${s.customName ?? s.name}`} onChange={(v) => toggle(s, v)} />}
          />
        );
      })}
    </List>
  );
}

function ServiceEditSheet({ s, onClose, onSaved }: { s: AdminServiceRow; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"inherit" | "markup" | "fixed">(s.fixedRate !== null ? "fixed" : s.markupPct !== null ? "markup" : "inherit");
  const [markup, setMarkup] = useState(s.markupPct ?? s.markup);
  const rate = s.starsPerUsd;
  // The fixed price is typed in whole Stars per 1K; it is stored as micro-USD at today's Stars-per-$1 rate
  const [fixed, setFixed] = useState(String(s.fixedRate !== null ? shownStars(s.fixedRate, rate) : s.sellStars));
  const [fixedErr, setFixedErr] = useState<string | null>(null);
  const [name, setName] = useState(s.customName ?? "");
  const [busy, setBusy] = useState(false);
  const fixedStars = Math.floor(Number(fixed) || 0);
  // Rounded down so converting back (rounding up to whole Stars) lands on exactly the Stars typed
  const fixedMicro = rate > 0 ? Math.floor((fixedStars * 1e6) / rate) : 0;
  const preview = mode === "fixed" ? (fixedMicro > 0 ? fixedMicro : null) : mode === "markup" ? sellFor(s.cost, markup) : null;
  const previewStars = preview === null ? 0 : shownStars(preview, rate);
  const diff = priceDiff(s);

  const save = async () => {
    if (busy) return;
    if (mode === "fixed" && !(fixedMicro > 0)) {
      haptic.error();
      setFixedErr("Enter a whole number of Stars above 0");
      return;
    }
    setBusy(true);
    try {
      await api(`/admin/services/${s.id}`, {
        method: "PUT",
        body: {
          customName: name.trim() || null,
          markupPct: mode === "markup" ? markup : null,
          fixedRate: mode === "fixed" ? fixedMicro : null,
        },
      });
      invalidate();
      toast(`Service #${s.id} saved`, "ok");
      onSaved();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Service #${s.id}`}
      sub={s.name}
      onClose={onClose}
      footer={
        <button type="button" class="btn" disabled={busy} aria-busy={busy ? "true" : undefined} onClick={save}>
          {busy ? <span class="spin" aria-hidden="true" /> : null}
          Save
        </button>
      }
    >
      <dl class="card">
        <Kv label="NotPanel cost">
          <Num>{money(s.cost)}</Num> per 1K{diff ? <> · {diff}</> : null}
        </Kv>
        <Kv label="Sells now">
          <b>
            <Num>{starsText(s.sellStars)}</Num> per 1K
          </b>{" "}
          (≈ <Num>{money(s.sell)}</Num>)
        </Kv>
      </dl>
      <Field id="svc-name" label="Name shown to customers" value={name} onInput={setName} placeholder={s.name} help="Leave empty to use NotPanel's name." />
      <Section header="Price">
        <Seg
          label="Price"
          value={mode}
          onChange={setMode}
          options={[
            ["inherit", "Default"],
            ["markup", "Own markup"],
            ["fixed", "Fixed price"],
          ]}
        />
        {mode === "markup" ? <MarkupEditor value={markup} onChange={setMarkup} /> : null}
        {mode === "fixed" ? (
          <Field
            id="svc-fixed"
            lead="⭐"
            trailing={<span class="field-trail">Stars per 1K</span>}
            inputMode="numeric"
            enterKeyHint="done"
            dir="ltr"
            value={fixed}
            error={fixedErr}
            onInput={(v) => {
              setFixed(v.replace(/\D/g, ""));
              setFixedErr(null);
            }}
          />
        ) : null}
        {preview === null ? (
          mode === "inherit" ? (
            <p class="note">Uses the category, platform or default markup.</p>
          ) : null
        ) : preview < s.cost ? (
          <Notice tone="error">
            <Num>{starsText(previewStars)}</Num> (≈ <Num>{money(preview)}</Num>) per 1K is below NotPanel's cost of <Num>{money(s.cost)}</Num>. The service will be hidden from customers.
          </Notice>
        ) : (
          <p class="note">
            New price <Num>{starsText(previewStars)}</Num> / 1K · profit <Num>{money(preview - s.cost)}</Num> per 1K
          </p>
        )}
      </Section>
    </Sheet>
  );
}

// ---------------- Price changes ----------------

interface PriceChange {
  id: number;
  service_id: number;
  old_rate: number;
  new_rate: number;
  changed_at: number;
  name: string | null;
  platform: string | null;
  category: string | null;
}

function AdminChanges() {
  const [q, setQ] = useState("");
  const pg = usePaged<PriceChange>(`/admin/price-changes?q=${enc(q.trim())}`, q ? 300 : 0);
  const list = pg.items;
  return (
    <Page back="/admin" title="Price changes" sub="NotPanel cost changes found by the automatic sync">
      <SearchField value={q} onInput={setQ} placeholder="Service name or ID" />
      {pg.err && !list ? (
        <ErrorState error={pg.err} onRetry={pg.reload} />
      ) : !list ? (
        <SkeletonList rows={6} lead="logo" />
      ) : list.length ? (
        <>
          <List stagger>
            {list.map((c) => {
              const d = c.old_rate ? ((c.new_rate - c.old_rate) / c.old_rate) * 100 : 0;
              return (
                <Row
                  key={c.id}
                  wrap
                  lead={<PlatformLogo slug={c.platform ?? ""} size={36} radius={10} />}
                  title={c.name ?? `Service #${c.service_id}`}
                  meta={
                    <>
                      <Num>#{c.service_id}</Num> ·{" "}
                      <Num>
                        {money(c.old_rate)} → {money(c.new_rate)}
                      </Num>{" "}
                      · {dateTime(c.changed_at)}
                    </>
                  }
                  value={
                    <span class={`status ${d > 0 ? "st-cancel" : d < 0 ? "st-done" : "st-pending"}`}>
                      <Num>{delta(d)}</Num>
                    </span>
                  }
                  chevron={false}
                />
              );
            })}
          </List>
          <ShowMore next={pg.next} busy={pg.busy} onClick={pg.more} />
        </>
      ) : q.trim() ? (
        <EmptyState compact art="search" title="No price changes found" body="Try a service name or ID." />
      ) : (
        <EmptyState compact art="search" title="No price changes yet" body="They appear here after each sync." />
      )}
    </Page>
  );
}

// ---------------- Payments ----------------

interface PaymentRow {
  id: number;
  user_id: number;
  stars: number;
  amount: number;
  status: string;
  order_id: number | null;
  paid_at: number | null;
  first_name: string | null;
  username: string | null;
}

const PAY_FILTERS: [string, string][] = [
  ["", "All"],
  ["paid", "Paid"],
  ["refunded", "Refunded"],
];

/** Why a refund didn't go through, in plain words */
const REFUND_ERRORS: Record<string, string> = {
  NOT_REFUNDABLE: "This payment can't be refunded: it is already refunded or wasn't paid with Stars.",
  NO_STARS_PAYMENT: "This order was paid from the balance, not with its own Stars payment. Refund it to the balance instead.",
  ALREADY_REFUNDED: "This order is already fully refunded.",
  TRY_AGAIN: "Something changed while refunding. Refresh and try again.",
  REFUND_UNCERTAIN: "Telegram didn't answer. The refund may still go through, so check the payment in a few minutes before trying again.",
  TELEGRAM_REFUSED: "Telegram refused the refund: {reason}",
};

/** Runs a refund; if the user already spent part of the payment, asks whether to refund all the Stars anyway. */
async function runRefund(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    await api(url, { method: "POST", body });
  } catch (e) {
    if (e instanceof ApiError && e.code === "BALANCE_ALREADY_SPENT" && !body.force) {
      const spent = Number(e.details?.spent ?? 0);
      const again = await confirmDialog(
        `They already spent ${money(spent)} (${usdStars(spent)}) of this payment. Refund all the Stars anyway? Their balance only goes down to 0.`,
        "Refund anyway",
        "Cancel",
        true,
      );
      return again ? runRefund(url, { ...body, force: true }) : false;
    }
    const known = e instanceof ApiError ? REFUND_ERRORS[e.code] : undefined;
    toast(known ? known.replace("{reason}", String((e as ApiError).details?.reason ?? "")) : errText(e), "error");
    haptic.error();
    return false;
  }
  toast("Refunded", "ok");
  haptic.success();
  return true;
}

/** Refund button logic for Stars payments, shared by the Payments list and the user profile */
function usePaymentRefund(onDone: () => void) {
  const [refunding, setRefunding] = useState<number | null>(null);
  const refund = async (p: PaymentRow) => {
    haptic.warn();
    const what = p.order_id ? `Order #${p.order_id} is refunded with it; the rest is taken from their balance.` : `${money(p.amount)} (${usdStars(p.amount)}) is taken from their balance.`;
    const ok = await confirmDialog(`Refund ${starsText(p.stars)} to ${p.first_name ?? p.user_id}? ${what}`, "Refund", "Cancel", true);
    if (!ok) return;
    setRefunding(p.id);
    if (await runRefund(`/admin/payments/${p.id}/refund`, {})) onDone();
    setRefunding(null);
  };
  return { refund, refunding };
}

/** One Stars payment; tapping it opens the user (unless we're already on their profile) */
function PaymentItem({ p, refunding, onRefund, openUser = true }: { p: PaymentRow; refunding: boolean; onRefund: () => void; openUser?: boolean }) {
  return (
    <Row
      icon="star"
      plate="var(--cream)"
      title={openUser ? `${p.first_name ?? p.user_id}${p.username ? ` @${p.username}` : ""}` : `Payment #${p.id}`}
      meta={
        <>
          <Num>{starsText(p.stars)}</Num> · <Num>{money(p.amount)}</Num>
          {p.order_id ? (
            <>
              {" "}
              · order <Num>#{p.order_id}</Num>
            </>
          ) : null}
          {p.paid_at ? ` · ${dateTime(p.paid_at)}` : ""}
        </>
      }
      onClick={openUser ? () => navigate(`/admin/users/${p.user_id}`) : undefined}
      chevron={false}
      control={
        p.status === "paid" ? (
          <Chip label={`Refund payment #${p.id}`} disabled={refunding} onClick={onRefund}>
            Refund
          </Chip>
        ) : (
          <span class="status st-cancel">Refunded</span>
        )
      }
    />
  );
}

/** "Only this user" chip with a way back to everyone */
function UserFilterChip({ user, name, base }: { user: string; name?: string; base: string }) {
  return (
    <div class="chips">
      <Chip selected label="Show everyone" onClick={() => navigate(base, { replace: true })}>
        {name ? `${name} · ` : ""}ID {user} ✕
      </Chip>
    </div>
  );
}

function AdminPayments({ user, q0 }: { user: string | null; q0: string }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState(q0);
  const pg = usePaged<PaymentRow, { totals: { stars: number; amount: number }; starsPerUsd: number }>(
    `/admin/payments?status=${enc(status)}&q=${enc(q.trim())}${user ? `&user=${enc(user)}` : ""}`,
    q ? 300 : 0,
  );
  const list = pg.items;
  const totals = pg.extra?.totals;
  const { refund, refunding } = usePaymentRefund(pg.reload);
  return (
    <Page back={user ? `/admin/users/${user}` : "/admin"} title="Payments" sub="Telegram Stars">
      {totals ? (
        <div class="grid2 stagger">
          <Stat label="Stars received">
            <Num>{starsText(totals.stars)}</Num>
          </Stat>
          <Stat label="Credited (USD)">
            <Num>{money(totals.amount)}</Num>
          </Stat>
        </div>
      ) : !pg.err ? (
        <Skeleton h={76} radius={16} />
      ) : null}
      <div class="chips scroll" role="group" aria-label="Filter by status">
        {PAY_FILTERS.map(([v, l]) => (
          <Chip
            key={v}
            selected={status === v}
            onClick={() => {
              if (status === v) return;
              pg.reset();
              setStatus(v);
            }}
          >
            {l}
          </Chip>
        ))}
      </div>
      {user ? <UserFilterChip user={user} name={list?.[0]?.first_name ?? undefined} base="/admin/payments" /> : null}
      <SearchField value={q} onInput={setQ} placeholder="Payment ID, user ID, @username or charge ID" />
      {pg.err && !list ? (
        <ErrorState error={pg.err} onRetry={pg.reload} />
      ) : !list ? (
        <SkeletonList rows={5} />
      ) : (
        <Section footer={list.length ? "Tap a payment to open the user. A Stars refund sends the whole payment back to their Telegram account." : undefined}>
          {list.length ? (
            <>
              <List stagger>
                {list.map((p) => (
                  <PaymentItem key={p.id} p={p} refunding={refunding === p.id} onRefund={() => refund(p)} />
                ))}
              </List>
              <ShowMore next={pg.next} busy={pg.busy} onClick={pg.more} />
            </>
          ) : (
            <EmptyState compact art="wallet" title={q.trim() || status ? "No payments found" : "No payments yet."} body={q.trim() || status ? "Try another filter or search." : undefined} />
          )}
        </Section>
      )}
    </Page>
  );
}

// ---------------- Referrals ----------------

interface RefPerson {
  first: string | null;
  last: string | null;
  user: string | null;
}
interface RefTopRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  invited: number;
  joined: number;
  earned: number;
}
interface RefRecentRow {
  referred_id: number;
  referrer_id: number;
  status: "pending" | "rewarded" | "capped";
  reward: number;
  created_at: number;
  rewarded_at: number | null;
  f_first: string | null;
  f_last: string | null;
  f_user: string | null;
  r_first: string | null;
  r_last: string | null;
  r_user: string | null;
}
interface RefData {
  totals: { invited: number; joined: number; rewarded: number; pending: number; capped: number; paid: number; todayInvited: number; todayPaid: number };
  top: RefTopRow[];
  recent: RefRecentRow[];
  next: number | null;
  settings: { enabled: boolean; rewardStars: number; dailyCap: number; starsPerUsd: number };
}

const refName = (id: number, p: RefPerson) => {
  const n = `${p.first ?? ""} ${p.last ?? ""}`.trim();
  return n || (p.user ? `@${p.user}` : `User ${id}`);
};
const REF_STATUS: Record<RefRecentRow["status"], [string, string]> = {
  pending: ["Waiting", "st-pending"],
  rewarded: ["Paid", "st-done"],
  capped: ["Daily limit", "st-cancel"],
};

function AdminReferrals() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<RefData | null>(null);
  const [more, setMore] = useState<RefRecentRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const url = (before?: number) => `/admin/referrals?q=${enc(q.trim())}${before ? `&before=${before}` : ""}`;
  const load = () => {
    const n = ++seq.current;
    setErr(null);
    api<RefData>(url()).then(
      (r) => {
        if (n !== seq.current) return;
        setData(r);
        setMore([]);
        setNext(r.next);
      },
      (e) => n === seq.current && setErr(e),
    );
  };
  useEffect(() => {
    const id = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(id);
  }, [q]);
  const showMore = async () => {
    if (!next || busy) return;
    const n = seq.current;
    setBusy(true);
    try {
      const r = await api<RefData>(url(next));
      if (n === seq.current) {
        setMore((m) => [...m, ...r.recent]);
        setNext(r.next);
      }
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const recent = data ? [...data.recent, ...more] : [];
  return (
    <Page back="/admin" title="Referrals" sub="Friends invited with a link">
      {err && !data ? (
        <ErrorState error={err} onRetry={load} />
      ) : !data ? (
        <>
          <Skeleton h={76} radius={16} />
          <Skeleton h={76} radius={16} />
          <SkeletonList rows={5} lead="none" />
        </>
      ) : (
        <>
          <div class="grid3 stagger">
            <Stat label="Invited">
              <Num>{num(data.totals.invited)}</Num>
            </Stat>
            <Stat label="Joined">
              <Num>{num(data.totals.joined)}</Num>
            </Stat>
            <Stat
              label="Paid out"
              ok
              sub={
                <>
                  <Num>{money(data.totals.paid)}</Num>
                </>
              }
            >
              <Num>{balStars(data.totals.paid)}</Num>
            </Stat>
            <Stat label="Waiting">
              <Num>{num(data.totals.pending)}</Num>
            </Stat>
            <Stat label="Over daily limit">
              <Num>{num(data.totals.capped)}</Num>
            </Stat>
            <Stat label={`Today · ${balStars(data.totals.todayPaid)} paid`}>
              <Num>{num(data.totals.todayInvited)}</Num>
            </Stat>
          </div>

          <SearchField value={q} onInput={setQ} placeholder="Name, @username or Telegram ID" />

          <Section header="Top referrers">
            {data.top.length ? (
              <List stagger>
                {data.top.map((t) => (
                  <Row
                    key={t.id}
                    title={refName(t.id, { first: t.first_name, last: t.last_name, user: t.username })}
                    meta={`${t.username ? `@${t.username} · ` : ""}${num(t.invited)} invited · ${num(t.joined)} joined`}
                    value={<Num>{balStars(t.earned)}</Num>}
                    onClick={() => setQ(String(t.id))}
                  />
                ))}
              </List>
            ) : (
              <EmptyState compact art="search" title="No referrers yet" />
            )}
          </Section>

          <Section
            header="Recent referrals"
            footer={`A referral counts when a new user opens the bot from a link, picks a language, joins the update channel (confirmed by Telegram) and reaches the home screen. ${
              data.settings.enabled ? `Reward ${starsText(data.settings.rewardStars)} (≈ ${money(Math.round((data.settings.rewardStars * 1e6) / data.settings.starsPerUsd))}), at most ${num(data.settings.dailyCap)} paid per referrer per day.` : "The referral program is currently off."
            }`}
          >
            {recent.length ? (
              <>
                <List stagger>
                  {recent.map((r) => {
                    const [label, cls] = REF_STATUS[r.status];
                    return (
                      <Row
                        key={r.referred_id}
                        title={`${refName(r.referred_id, { first: r.f_first, last: r.f_last, user: r.f_user })} ← ${refName(r.referrer_id, { first: r.r_first, last: r.r_last, user: r.r_user })}`}
                        meta={
                          <>
                            <span class={`status ${cls}`}>{label}</span>
                            {r.status === "rewarded" ? (
                              <>
                                {" "}
                                <Num>{usdStars(r.reward)}</Num>
                              </>
                            ) : null}{" "}
                            · {dateTime(r.rewarded_at ?? r.created_at)}
                          </>
                        }
                        onClick={() => setQ(String(r.referrer_id))}
                      />
                    );
                  })}
                </List>
                {next ? (
                  <Chip label="Show more" disabled={busy} onClick={showMore}>
                    {busy ? "Loading…" : "Show more"}
                  </Chip>
                ) : null}
              </>
            ) : (
              <EmptyState compact art="search" title="No referrals found" body={q.trim() ? "Try a name, @username or Telegram ID." : undefined} />
            )}
          </Section>
        </>
      )}
    </Page>
  );
}

// ---------------- Users ----------------

interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  balance: number;
  banned: number;
  orders: number;
  paid: number;
  last_seen_at: number;
}

const fullName = (u: { id: number; first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim() || `User ${u.id}`;

function AdminUsers() {
  const [q, setQ] = useState("");
  const pg = usePaged<UserRow>(`/admin/users?q=${enc(q.trim())}`, q ? 300 : 0);
  const list = pg.items;
  return (
    <Page back="/admin" title="Users">
      <SearchField value={q} onInput={setQ} placeholder="Name, @username or Telegram ID" />
      {pg.err && !list ? (
        <ErrorState error={pg.err} onRetry={pg.reload} />
      ) : !list ? (
        <SkeletonList rows={6} lead="none" />
      ) : list.length ? (
        <>
          <List stagger>
            {list.map((u) => (
              <Row
                key={u.id}
                title={fullName(u)}
                meta={`${u.username ? `@${u.username} · ` : ""}ID ${u.id} · ${plural(u.orders, "order")} · paid ${balStars(u.paid)}${u.banned ? " · blocked" : ""}`}
                value={<Num>{balStars(u.balance)}</Num>}
                onClick={() => navigate(`/admin/users/${u.id}`)}
              />
            ))}
          </List>
          <ShowMore next={pg.next} busy={pg.busy} onClick={pg.more} />
        </>
      ) : (
        <EmptyState compact art="search" title="No users found" body={q.trim() ? "Try a name, @username or Telegram ID." : undefined} />
      )}
    </Page>
  );
}

interface UserProfile {
  user: {
    id: number;
    first_name: string;
    last_name: string;
    username: string | null;
    language_code: string | null;
    lang: string | null;
    balance: number;
    banned: number;
    can_message: number;
    channel_ok: number;
    created_at: number;
    last_seen_at: number;
    home_at: number | null;
  };
  stats: { orders: number; openOrders: number; spent: number; refunded: number; paid: number; paidStars: number; invited: number; joined: number; earned: number };
  invitedBy: { id: number; status: string; first_name: string | null; last_name: string | null; username: string | null } | null;
  orders: AdminOrder[];
  payments: PaymentRow[];
}

interface LedgerRow {
  id: number;
  delta: number;
  kind: string;
  ref: number | null;
  note: string | null;
  created_at: number;
}

/** A balance change in plain words, and where tapping it goes */
function ledgerLine(r: LedgerRow): { title: string; href?: string } {
  const ref = r.ref ? ` #${r.ref}` : "";
  switch (r.kind) {
    case "topup":
      return { title: `Top-up with Stars · payment${ref}`, href: r.ref ? `/admin/payments?q=${r.ref}` : undefined };
    case "order":
      return { title: `Order${ref}`, href: r.ref ? `/admin/orders?q=${r.ref}` : undefined };
    case "refund":
      return { title: `${r.note === "admin" ? "Refund by admin" : "Refund"} · order${ref}`, href: r.ref ? `/admin/orders?q=${r.ref}` : undefined };
    case "stars_refund":
      return { title: `Stars sent back to Telegram · payment${ref}`, href: r.ref ? `/admin/payments?q=${r.ref}` : undefined };
    case "referral":
      return { title: "Referral reward", href: r.ref ? `/admin/users/${r.ref}` : undefined };
    case "admin":
      return { title: r.note && r.note !== "admin" ? `By admin: ${r.note}` : "Changed by admin" };
    default:
      return { title: r.note ? `${cap(r.kind)}: ${r.note}` : cap(r.kind) };
  }
}

const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const langName = (code: string | null) => {
  if (!code) return "Unknown";
  try {
    return LANG_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
};
const CHANNEL: Record<number, string> = { 0: "Not confirmed", 1: "Member", 2: "Let in (Telegram didn't answer)" };

function AdminUser({ id }: { id: string }) {
  const res = useAsync(() => api<UserProfile>(`/admin/users/${enc(id)}`), [id]);
  const ledger = usePaged<LedgerRow>(`/admin/users/${enc(id)}/ledger`);
  const [sheet, setSheet] = useState<"balance" | "message" | null>(null);
  const reload = () => {
    res.reload();
    ledger.reload();
  };
  const orderRefund = useOrderRefund(reload);
  const { refund: refundPayment, refunding } = usePaymentRefund(reload);
  const p = res.data;
  const name = p ? fullName(p.user) : "User";
  const block = async (v: boolean) => {
    if (!p) return;
    if (v) {
      haptic.warn();
      if (!(await confirmDialog(`Block ${name}? They won't be able to open the app.`, "Block", "Cancel", true))) return;
    }
    try {
      await api(`/admin/users/${p.user.id}/ban`, { body: { banned: v } });
      res.reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Page
      back="/admin/users"
      title={name}
      sub={p ? `${p.user.username ? `@${p.user.username} · ` : ""}ID ${p.user.id}` : undefined}
      overlay={
        p ? (
          <>
            {sheet === "balance" ? <BalanceSheet u={p.user} onClose={() => setSheet(null)} onSaved={() => (setSheet(null), reload())} /> : null}
            {sheet === "message" ? <MessageSheet u={p.user} onClose={() => setSheet(null)} onSent={() => (setSheet(null), res.reload())} /> : null}
            {orderRefund.sheet}
          </>
        ) : null
      }
    >
      <Loader
        res={res}
        skeleton={
          <>
            <Skeleton h={152} radius={16} />
            <SkeletonList rows={5} lead="none" />
          </>
        }
      >
        {({ user: u, stats: s, invitedBy, orders, payments }) => (
          <>
            {u.banned ? <Notice tone="warn">Blocked: this user can't open the app.</Notice> : null}
            <div class="grid2 stagger">
              <Stat label="Balance" ok sub={<Num>{money(u.balance)}</Num>}>
                <Num>{balStars(u.balance)}</Num>
              </Stat>
              <Stat label="Paid with Stars" sub={<Num>{money(s.paid)}</Num>}>
                <Num>{starsText(s.paidStars)}</Num>
              </Stat>
              <Stat label="Spent on orders" sub={s.refunded ? <>refunded <Num>{money(s.refunded)}</Num></> : undefined}>
                <Num>{money(s.spent)}</Num>
              </Stat>
              <Stat label="Orders" sub={s.openOrders ? `${num(s.openOrders)} running` : undefined}>
                <Num>{num(s.orders)}</Num>
              </Stat>
            </div>

            <Section header="Actions">
              <List>
                <Row icon="wallet" plate="var(--lime)" title="Add or remove balance" meta="For mistakes, compensation or bonuses; the reason is saved" onClick={() => setSheet("balance")} />
                <Row
                  icon="chat"
                  plate="var(--sky)"
                  title="Send a message"
                  meta={u.can_message ? "From the bot, in their Telegram chat" : "They may have blocked the bot or never started it"}
                  onClick={() => setSheet("message")}
                />
                <Row toggle={{ on: !!u.banned, onChange: block }} title="Block this user" meta="Blocked users can't open the app" />
              </List>
            </Section>

            <Section header="Details">
              <dl class="card">
                <Kv label="Telegram ID">{u.id}</Kv>
                <Kv label="Joined">{dateTime(u.created_at)}</Kv>
                <Kv label="Last seen">{dateTime(u.last_seen_at)}</Kv>
                <Kv label="Language">{langName(u.lang ?? u.language_code)}</Kv>
                <Kv label="Update channel">{CHANNEL[u.channel_ok] ?? "Unknown"}</Kv>
                <Kv label="Bot can message">{u.can_message ? "Yes" : "No"}</Kv>
                <Kv label="Invited by">
                  {invitedBy ? (
                    <a
                      href={`#/admin/users/${invitedBy.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/admin/users/${invitedBy.id}`);
                      }}
                    >
                      {`${invitedBy.first_name ?? ""} ${invitedBy.last_name ?? ""}`.trim() || `User ${invitedBy.id}`}
                    </a>
                  ) : (
                    "Nobody"
                  )}
                </Kv>
                <Kv label="Friends invited">
                  {num(s.invited)} invited · {num(s.joined)} joined · earned <Num>{balStars(s.earned)}</Num>
                </Kv>
              </dl>
            </Section>

            <Section header="Orders" action={s.orders > orders.length ? { label: `All ${num(s.orders)}`, onClick: () => navigate(`/admin/orders?user=${u.id}`) } : undefined}>
              {orders.length ? (
                <List>
                  {orders.map((o) => (
                    <OrderItem key={o.id} o={o} refunding={orderRefund.busy === o.id} onRefund={() => orderRefund.open(o)} showUser={false} />
                  ))}
                </List>
              ) : (
                <EmptyState compact art="orders" title="No orders yet" />
              )}
            </Section>

            <Section header="Stars payments" action={payments.length >= 5 ? { label: "All", onClick: () => navigate(`/admin/payments?user=${u.id}`) } : undefined}>
              {payments.length ? (
                <List>
                  {payments.map((pay) => (
                    <PaymentItem key={pay.id} p={pay} openUser={false} refunding={refunding === pay.id} onRefund={() => refundPayment(pay)} />
                  ))}
                </List>
              ) : (
                <EmptyState compact art="wallet" title="No Stars payments yet" />
              )}
            </Section>
          </>
        )}
      </Loader>

      {p ? (
        <Section header="Balance history" footer="Every change to their balance, newest first.">
          {ledger.err && !ledger.items ? (
            <ErrorState error={ledger.err} onRetry={ledger.reload} />
          ) : !ledger.items ? (
            <SkeletonList rows={4} lead="none" />
          ) : ledger.items.length ? (
            <>
              <List>
                {ledger.items.map((r) => {
                  const l = ledgerLine(r);
                  return (
                    <Row
                      key={r.id}
                      title={l.title}
                      meta={dateTime(r.created_at)}
                      value={
                        <span class={r.delta > 0 ? "ok-text" : undefined}>
                          {r.delta > 0 ? "+" : ""}
                          <Num>{money(r.delta)}</Num>
                        </span>
                      }
                      chevron={!!l.href}
                      onClick={l.href ? () => navigate(l.href!) : undefined}
                    />
                  );
                })}
              </List>
              <ShowMore next={ledger.next} busy={ledger.busy} onClick={ledger.more} />
            </>
          ) : (
            <EmptyState compact art="wallet" title="No balance changes yet" />
          )}
        </Section>
      ) : null}
    </Page>
  );
}

const REASONS = ["Wrong refund", "Compensation", "Bonus", "Correction"];

function BalanceSheet({ u, onClose, onSaved }: { u: UserProfile["user"]; onClose: () => void; onSaved: () => void }) {
  const name = fullName(u);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const have = balanceStars(u.balance, starsRate());
  const v = Number(amount);
  const save = async () => {
    if (!Number.isInteger(v) || !(v > 0)) {
      haptic.error();
      return setAmountErr("Enter a whole number of Stars above 0");
    }
    if (mode === "remove" && v > have) {
      haptic.error();
      return setAmountErr(`They only have ${starsText(have)}`);
    }
    if (!reason.trim()) {
      haptic.error();
      return setReasonErr("Write why, so you can see it later in their balance history");
    }
    setBusy(true);
    try {
      await api(`/admin/users/${u.id}/balance`, { body: { amount: mode === "add" ? v : -v, note: reason.trim() } });
      toast(mode === "add" ? `Added ${starsText(v)} to ${name}` : `Removed ${starsText(v)} from ${name}`, "ok");
      haptic.success();
      onSaved();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Change balance"
      sub={`${name} has ${starsText(have)} · ${money(u.balance)}`}
      onClose={onClose}
      footer={
        <button type="button" class={`btn${mode === "remove" ? " danger" : ""}`} disabled={busy} onClick={save}>
          {busy ? "Saving…" : mode === "add" ? `Add${v > 0 ? ` ${starsText(v)}` : ""}` : `Remove${v > 0 ? ` ${starsText(v)}` : ""}`}
        </button>
      }
    >
      <Seg
        label="Add or remove"
        value={mode}
        options={[
          ["add", "Add"],
          ["remove", "Remove"],
        ]}
        onChange={(m) => {
          setMode(m);
          setAmountErr(null);
        }}
      />
      <Field
        id="balance-amount"
        label="Amount (Stars)"
        lead="⭐"
        inputMode="numeric"
        enterKeyHint="next"
        dir="ltr"
        placeholder="0"
        value={amount}
        error={amountErr}
        help={v > 0 ? `≈ ${money(starsCredit(v, starsRate()))}` : mode === "remove" ? `Up to ${starsText(have)}` : undefined}
        onInput={(x) => {
          setAmount(x.replace(/\D/g, "").slice(0, 7));
          setAmountErr(null);
        }}
      />
      {mode === "remove" && have > 0 ? (
        <div class="chips">
          <Chip label="Remove all" onClick={() => (setAmount(String(have)), setAmountErr(null))}>
            All {starsText(have)}
          </Chip>
        </div>
      ) : null}
      <Field
        id="balance-reason"
        label="Reason"
        placeholder="e.g. refunded order #123 by mistake"
        value={reason}
        maxLength={200}
        error={reasonErr}
        onInput={(x) => {
          setReason(x);
          setReasonErr(null);
        }}
      />
      <div class="chips">
        {REASONS.map((r) => (
          <Chip key={r} selected={reason === r} onClick={() => (setReason(r), setReasonErr(null))}>
            {r}
          </Chip>
        ))}
      </div>
      <p class="note">The user isn't messaged about this. Use “Send a message” to tell them.</p>
    </Sheet>
  );
}

const MESSAGE_ERRORS: Record<string, string> = {
  CANT_MESSAGE: "Telegram won't deliver it: they blocked the bot or never started it.",
  INVALID_TEXT: "Write a message first (up to 4,000 characters).",
};

function MessageSheet({ u, onClose, onSent }: { u: UserProfile["user"]; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return haptic.error();
    setBusy(true);
    try {
      await api(`/admin/users/${u.id}/message`, { body: { text } });
      toast("Message sent", "ok");
      haptic.success();
      onSent();
    } catch (e) {
      const known = e instanceof ApiError ? MESSAGE_ERRORS[e.code] : undefined;
      toast(known ?? errText(e), "error");
      haptic.error();
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Send a message"
      sub={`To ${fullName(u)}, from the bot`}
      onClose={onClose}
      footer={
        <button type="button" class="btn" disabled={busy || !text.trim()} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
      }
    >
      <Field id="user-message" label="Message" multiline rows={5} maxLength={4000} placeholder="Hi! About your order…" value={text} onInput={setText} help="Sent as plain text, exactly as written." />
    </Sheet>
  );
}

// ---------------- Orders ----------------

type AdminOrder = OrderView & {
  npOrderId: number | null;
  cost: number | null;
  rate: number | null;
  userId: number;
  userName: string;
  username: string | null;
  error: string | null;
  /** Stars of the payment that bought this order, if it is still refundable to Telegram */
  paidStars: number | null;
  /** micro-USD still charged (not refunded yet) */
  refundable: number;
};

const ORDER_FILTERS: [string, string][] = [
  ["", "All"],
  ["open", "Open"],
  ["completed", "Completed"],
  ["partial", "Partial"],
  ["cancelled", "Canceled"],
  ["failed", "Failed"],
];

const isOpen = (o: AdminOrder) => ["submitting", "pending", "processing", "in_progress"].includes(o.status);

/** Refund sheet for orders, shared by All orders and the user profile */
function useOrderRefund(onDone: () => void) {
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const sheet = order ? (
    <OrderRefundSheet
      o={order}
      busy={busy === order.id}
      onClose={() => setOrder(null)}
      onRefund={async (body) => {
        setBusy(order.id);
        const ok = await runRefund(`/admin/orders/${order.id}/refund`, body);
        setBusy(null);
        if (ok) {
          setOrder(null);
          onDone();
        }
      }}
    />
  ) : null;
  return { sheet, busy, open: (o: AdminOrder) => (haptic.warn(), setOrder(o)) };
}

function OrderRefundSheet({ o, busy, onClose, onRefund }: { o: AdminOrder; busy: boolean; onClose: () => void; onRefund: (body: Record<string, unknown>) => void }) {
  const [to, setTo] = useState<"balance" | "stars">("balance");
  const full = shownStars(o.refundable, starsRate());
  const [amount, setAmount] = useState(String(full));
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const v = Number(amount);
  const submit = () => {
    if (to === "stars") return onRefund({ to });
    if (!Number.isInteger(v) || v < 1) {
      haptic.error();
      return setAmountErr("Enter a whole number of Stars above 0");
    }
    if (v > full) {
      haptic.error();
      return setAmountErr(`At most ${starsText(full)} (what is left of this order)`);
    }
    onRefund({ to, stars: v });
  };
  return (
    <Sheet
      title={`Refund order #${o.id}`}
      sub={`${o.userName.slice(0, 32)} · ${o.serviceName.slice(0, 40)}`}
      onClose={onClose}
      footer={
        <button type="button" class="btn danger" disabled={busy} onClick={submit}>
          {busy ? "Refunding…" : to === "stars" ? `Send ${starsText(o.paidStars ?? 0)} back` : `Refund ${v > 0 ? starsText(Math.min(v, full)) : ""} to balance`}
        </button>
      }
    >
      <dl class="card">
        <Kv label="Paid">
          <Num>{money(o.charge)}</Num> · <Num>{usdStars(o.charge)}</Num>
        </Kv>
        {o.refund ? (
          <Kv label="Already refunded">
            <Num>{money(o.refund)}</Num>
          </Kv>
        ) : null}
        <Kv label="Can still refund">
          <b>
            <Num>{money(o.refundable)}</Num> · <Num>{starsText(full)}</Num>
          </b>
        </Kv>
      </dl>
      {o.paidStars ? (
        <Seg
          label="Refund to"
          value={to}
          options={[
            ["balance", "Their balance"],
            ["stars", "Stars to Telegram"],
          ]}
          onChange={setTo}
        />
      ) : null}
      {to === "balance" ? (
        <>
          <Field
            id="refund-amount"
            label="Amount (Stars)"
            lead="⭐"
            inputMode="numeric"
            enterKeyHint="done"
            dir="ltr"
            value={amount}
            error={amountErr}
            help={v > 0 && v < full ? `≈ ${money(starsCredit(v, starsRate()))}, part of the order` : "The whole amount that is left"}
            onInput={(x) => {
              setAmount(x.replace(/\D/g, "").slice(0, 7));
              setAmountErr(null);
            }}
          />
          {v !== full ? (
            <div class="chips">
              <Chip label="Refund all" onClick={() => (setAmount(String(full)), setAmountErr(null))}>
                All {starsText(full)}
              </Chip>
            </div>
          ) : null}
          <p class="note">
            Added to their balance in the bot and they get a message.
            {o.paidStars ? " Their Stars payment stays as it is." : " This order was paid from the balance, so Stars can't go back to Telegram."}
            {isOpen(o) ? " The order keeps running on NotPanel, and NotPanel's own refund won't be added on top later." : ""}
          </p>
        </>
      ) : (
        <p class="note">
          All {starsText(o.paidStars ?? 0)} of the payment go back to their Telegram account and the order counts as fully refunded. Any part of that payment left in their balance is taken back.
          {isOpen(o) ? " The order keeps running on NotPanel." : ""}
        </p>
      )}
    </Sheet>
  );
}

/** One order with its money and actions */
function OrderItem({ o, refunding, onRefund, showUser = true }: { o: AdminOrder; refunding: boolean; onRefund: () => void; showUser?: boolean }) {
  return (
    <div class="ord">
      <Row
        wrap
        lead={<PlatformLogo slug={o.platform} size={36} radius={10} />}
        title={o.serviceName}
        meta={
          <>
            internal <Num>#{o.id}</Num>
            {o.npOrderId ? (
              <>
                {" "}
                · NotPanel <Num>#{o.npOrderId}</Num>
              </>
            ) : null}
            {showUser ? ` · ${o.userName}${o.username ? ` @${o.username}` : ""}` : ""} · <Num>{num(o.quantity)}</Num> · {dateTime(o.createdAt)}
            {o.error ? ` · ${o.error}` : ""}
          </>
        }
        control={<StatusPill status={o.status} />}
      />
      <MoneyCells cells={orderCells(o)} />
      <div class="chips">
        {o.refundable > 0 && o.status !== "submitting" ? (
          <Chip label={`Refund order #${o.id}`} disabled={refunding} onClick={onRefund}>
            Refund
          </Chip>
        ) : null}
        {o.link ? (
          <Chip label={`Open the link of order #${o.id}`} onClick={() => openLink(o.link)}>
            Open link
          </Chip>
        ) : null}
        {showUser ? (
          <Chip label={`Open user ${o.userName}`} onClick={() => navigate(`/admin/users/${o.userId}`)}>
            {o.userName.slice(0, 20) || `User ${o.userId}`}
          </Chip>
        ) : null}
      </div>
    </div>
  );
}

function AdminOrders({ user, q0 }: { user: string | null; q0: string }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState(q0);
  const pg = usePaged<AdminOrder, { starsPerUsd: number; totals?: MoneyTotals }>(
    `/admin/orders?status=${enc(status)}&q=${enc(q.trim())}${user ? `&user=${enc(user)}` : ""}`,
    q ? 300 : 0,
  );
  const list = pg.items;
  const refund = useOrderRefund(pg.reload);
  return (
    <Page back={user ? `/admin/users/${user}` : "/admin"} title="All orders" overlay={refund.sheet}>
      <div class="chips scroll" role="group" aria-label="Filter by status">
        {ORDER_FILTERS.map(([v, l]) => (
          <Chip
            key={v}
            selected={status === v}
            onClick={() => {
              if (status === v) return;
              pg.reset();
              setStatus(v);
            }}
          >
            {l}
          </Chip>
        ))}
      </div>
      {user ? <UserFilterChip user={user} name={list?.[0]?.userName} base="/admin/orders" /> : null}
      <SearchField value={q} onInput={setQ} placeholder="Order #, NotPanel #, name, @username, user ID or link" />
      {pg.err ? (
        <ErrorState error={pg.err} onRetry={pg.reload} />
      ) : !list ? (
        <SkeletonList rows={5} lead="logo" />
      ) : list.length ? (
        <>
          {pg.extra?.totals ? <MoneyTotalsBar totals={pg.extra.totals} /> : null}
          <List stagger>
            {list.map((o) => (
              <OrderItem key={o.id} o={o} refunding={refund.busy === o.id} onRefund={() => refund.open(o)} />
            ))}
          </List>
          <p class="note">{LEGEND}</p>
          <ShowMore next={pg.next} busy={pg.busy} onClick={pg.more} />
        </>
      ) : (
        <EmptyState compact art="orders" title="No orders" body={q.trim() || status || user ? "Try another filter or search." : undefined} />
      )}
    </Page>
  );
}

// ---------------- Settings ----------------

interface AdminSettingsData {
  default_markup_pct: number;
  stars_per_usd: number;
  min_topup_stars: number;
  max_topup_stars: number;
  sync_enabled: number;
  sync_every_hours: number;
  auto_enable_new: number;
  only_timed: number;
  low_balance: number;
  support_username: string;
  channel_url: string;
  channel_id: string;
  channel_gate: number;
  referral_enabled: number;
  referral_reward_stars: number;
  referral_daily_cap: number;
  terms_text: string;
  last_sync_at: number;
  last_sync_summary: Overview["lastSync"];
  sync: { running: boolean; page: number; totalPages: number };
  webhook_connected: boolean;
  app_url: string;
  bot_username: string;
  key_hint: string | null;
  notpanel_key_source?: "env" | "saved";
  owners?: Owners;
}

/**
 * What's wrong with a settings value, in plain words (same rules as the server's PUT /admin/settings), or null.
 * `v` is the settings with the unsaved changes applied.
 */
function settingProblem(key: string, v: AdminSettingsData): string | null {
  const whole = (n: number) => Number.isInteger(n);
  switch (key) {
    case "stars_per_usd":
      return v.stars_per_usd >= 1 && v.stars_per_usd <= 1000 ? null : "Stars per $1 must be between 1 and 1,000.";
    case "min_topup_stars":
    case "max_topup_stars":
      if (!whole(v.min_topup_stars) || v.min_topup_stars < 1) return "Smallest top-up must be at least 1 ⭐.";
      if (!whole(v.max_topup_stars) || v.max_topup_stars > MAX_STARS_PER_PAYMENT)
        return `Largest top-up can be at most ${num(MAX_STARS_PER_PAYMENT)} ⭐ (Telegram's limit for one Stars payment).`;
      return v.max_topup_stars >= v.min_topup_stars ? null : "Largest top-up must be at least the smallest top-up.";
    case "referral_reward_stars":
      return whole(v.referral_reward_stars) && v.referral_reward_stars >= 0 && v.referral_reward_stars <= 100
        ? null
        : "Reward per friend must be a whole number from 0 to 100 ⭐.";
    case "referral_daily_cap":
      return v.referral_daily_cap >= 0 && v.referral_daily_cap <= 10_000 ? null : "Max paid referrals per day must be between 0 and 10,000.";
    case "sync_every_hours":
      return v.sync_every_hours >= 1 && v.sync_every_hours <= 168 ? null : "Check every must be between 1 and 168 hours.";
    case "low_balance":
      return v.low_balance >= 0 ? null : "The balance alert can't be negative.";
    case "channel_url":
      return !v.channel_url || /^https:\/\/t\.me\//.test(v.channel_url) ? null : "Channel link must start with https://t.me/";
    case "channel_id":
      return !v.channel_id || /^-100\d{5,}$/.test(v.channel_id) ? null : "Channel ID must look like -1001234567890.";
    default:
      return null;
  }
}

type NumKey = "stars_per_usd" | "min_topup_stars" | "max_topup_stars" | "low_balance" | "referral_reward_stars" | "referral_daily_cap";
const USD_KEYS: NumKey[] = ["low_balance"];

function AdminSettings() {
  const res = useAsync(() => api<AdminSettingsData>("/admin/settings"), []);
  const [draft, setDraft] = useState<Partial<AdminSettingsData>>({});
  // What the number fields show while typing ("1." must survive until the next digit).
  const [texts, setTexts] = useState<Partial<Record<NumKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const s = res.data ? { ...res.data, ...draft } : null;
  const dirty = !!res.data && (Object.keys(draft) as (keyof AdminSettingsData)[]).some((k) => draft[k] !== res.data![k]);

  // Watch a running sync
  useEffect(() => {
    if (!res.data?.sync.running) return;
    const id = setInterval(() => api<AdminSettingsData>("/admin/settings").then(res.set, () => undefined), 5000);
    return () => clearInterval(id);
  }, [res.data?.sync.running]);

  const set = <K extends keyof AdminSettingsData>(k: K, v: AdminSettingsData[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    if (!res.data) return;
    // Say exactly what's wrong instead of a generic error
    const next = { ...res.data, ...draft };
    const problem = Object.keys(draft).map((k) => settingProblem(k, next)).find(Boolean);
    if (problem) {
      toast(problem, "error");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/settings", { method: "PUT", body: draft });
      invalidate();
      // The app converts USD to Stars with the rate from /me
      if (draft.stars_per_usd !== undefined) void refreshMe().catch(() => {});
      res.set({ ...res.data, ...draft });
      setDraft({});
      setTexts({});
      toast("Settings saved", "ok");
      res.reload();
    } catch (e) {
      const key = e instanceof ApiError && e.code === "INVALID_VALUE" ? String(e.details?.key ?? "") : "";
      const problem = key ? settingProblem(key, { ...res.data, ...draft }) : null;
      if (problem || key) toast(problem ?? `That value isn't allowed (${key}).`, "error");
      else fail(e);
    }
    setBusy(false);
  };
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await api<{ running: boolean }>("/admin/sync", { method: "POST" });
      toast(r.running ? "Sync started. It runs in the background for about 20 minutes." : "Sync queued");
      res.reload();
    } catch (e) {
      fail(e);
    }
    setSyncing(false);
  };
  const [previewing, setPreviewing] = useState(false);
  const previewMessages = async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      const r = await api<{ sent: number }>("/admin/preview-messages", { body: {} });
      toast(`Sent ${r.sent} message previews to your chat with the bot`, "ok");
    } catch (e) {
      fail(e);
    }
    setPreviewing(false);
  };
  const reconnect = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const r = await api<{ bot: string; notpanelWebhook: true | string }>("/admin/connect", { method: "POST" });
      // Command menu, About text and description in every language, in batches
      for (let batch: number | null = 0; batch !== null; ) batch = (await api<{ next: number | null }>(`/admin/bot-texts/${batch}`, { method: "POST" })).next;
      if (r.notpanelWebhook === true) toast(`Connected @${r.bot} and NotPanel updates`, "ok");
      else toast(`Bot connected; NotPanel webhook: ${r.notpanelWebhook}`);
      res.reload();
    } catch (e) {
      fail(e);
    }
    setConnecting(false);
  };

  const numInput = (k: NumKey, id: string) => {
    const usd = USD_KEYS.includes(k);
    const shown = texts[k] ?? (usd ? String(s![k] / 1e6) : String(s![k]));
    return (
      <input
        id={id}
        inputMode={usd ? "decimal" : "numeric"}
        enterKeyHint="done"
        dir="ltr"
        autoComplete="off"
        // Hug the digits so the "$" sits right next to them (the field is end-aligned).
        size={Math.max(1, shown.length)}
        value={shown}
        onInput={(e) => {
          const raw = e.currentTarget.value.replace(usd ? /[^\d.]/g : /\D/g, "");
          setTexts((t) => ({ ...t, [k]: raw }));
          set(k, usd ? Math.round((Number(raw) || 0) * 1e6) : Number(raw) || 0);
        }}
      />
    );
  };

  const sum = s?.last_sync_summary;
  const lastLine = s?.last_sync_at
    ? `Last: ${dateTime(s.last_sync_at)}${sum?.error ? " · failed" : sum?.unchanged ? " · no changes" : sum ? ` · ${plural(sum.total, "service")}` : ""}`
    : "Never synced";

  return (
    <Page back="/admin" title="Settings & connection" main={dirty ? { text: "Save", onClick: save, progress: busy } : null}>
      {!s ? (
        res.error ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : (
          <>
            <SkeletonList rows={3} lead="none" />
            <SkeletonList rows={5} lead="none" />
          </>
        )
      ) : (
        <>
          <Section header="Telegram Stars" footer="Telegram pays out roughly $0.013 per Star, so 77 Stars per $1 is about break-even. Your markup is the profit. Top-ups are whole Stars, at most 10,000 per payment (Telegram's limit). Money is kept in USD; Stars are only how users see it. Changing the rate re-prices everything: every price, balance and past amount is shown at the new rate (100 ⭐ bought at 77 shows as 130 ⭐ at 100).">
            <dl class="card">
              <Kv label="Stars per $1 (sets prices)" id="set-stars">
                {numInput("stars_per_usd", "set-stars")}
              </Kv>
              <Kv label="Smallest top-up" id="set-min">
                <Num>
                  {numInput("min_topup_stars", "set-min")} ⭐
                </Num>
              </Kv>
              <Kv label="Largest top-up" id="set-max">
                <Num>
                  {numInput("max_topup_stars", "set-max")} ⭐
                </Num>
              </Kv>
            </dl>
          </Section>

          <Section header="Price sync">
            <List>
              <Row toggle={{ on: !!s.sync_enabled, onChange: (v) => set("sync_enabled", v ? 1 : 0) }} wrap title="Update prices automatically" meta="Checks NotPanel for new prices and services" />
              <Row
                toggle={{ on: !!s.only_timed, onChange: (v) => set("only_timed", v ? 1 : 0) }}
                wrap
                title="Only services with an average time"
                meta="Lists only services NotPanel has measured delivery times for"
              />
              <Row toggle={{ on: !!s.auto_enable_new, onChange: (v) => set("auto_enable_new", v ? 1 : 0) }} wrap title="Put new services on sale" meta="Off: new NotPanel services arrive hidden" />
              {s.sync.running ? (
                <Row
                  title="Syncing prices…"
                  meta={
                    <>
                      Page <Num>{s.sync.page}</Num> of <Num>{s.sync.totalPages || "?"}</Num> · runs in the background
                      {s.sync.totalPages ? <Progress value={s.sync.page} max={s.sync.totalPages} label="Sync progress" /> : null}
                    </>
                  }
                />
              ) : (
                <Row accent title="Sync now" meta={lastLine} onClick={syncNow} disabled={syncing} chevron={false} />
              )}
            </List>
            {sum?.error ? <Notice tone="error">{sum.error}</Notice> : null}
          </Section>

          {/* Full width, so each of the five segments is a comfortable tap target. */}
          <Section header="Check every">
            <Seg
              label="Sync interval"
              value={String(s.sync_every_hours)}
              onChange={(v) => set("sync_every_hours", Number(v))}
              options={[
                ["1", "1h"],
                ["3", "3h"],
                ["6", "6h"],
                ["12", "12h"],
                ["24", "24h"],
              ]}
            />
          </Section>

          <Section header="Alerts & support" footer="Admin warns you when your NotPanel balance drops below the alert. The customers' Support button opens the support chat (empty: the bot).">
            <dl class="card">
              <Kv label="Warn when NotPanel balance is below" id="set-low">
                <Num>
                  {"$"}
                  {numInput("low_balance", "set-low")}
                </Num>
              </Kv>
              <Kv label="Support username" id="set-support">
                <Num>
                  @
                  <input
                    id="set-support"
                    dir="ltr"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellcheck={false}
                    enterKeyHint="done"
                    size={14}
                    value={s.support_username}
                    placeholder="your_support"
                    onInput={(e) => set("support_username", e.currentTarget.value.replace(/^@/, ""))}
                  />
                </Num>
              </Kv>
            </dl>
          </Section>

          <Section header="Update channel" footer="The bot must be an admin in this channel.">
            <dl class="card">
              <Row toggle={{ on: !!s.channel_gate, onChange: (v) => set("channel_gate", v ? 1 : 0) }} wrap title="Require joining before using the app" />
              <Kv label="Channel link" id="set-channel-url">
                <Num>
                  <input
                    id="set-channel-url"
                    dir="ltr"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellcheck={false}
                    enterKeyHint="done"
                    size={22}
                    value={s.channel_url}
                    placeholder="https://t.me/your_channel"
                    onInput={(e) => set("channel_url", e.currentTarget.value.trim())}
                  />
                </Num>
              </Kv>
              <Kv label="Channel ID" id="set-channel-id">
                <Num>
                  <input
                    id="set-channel-id"
                    dir="ltr"
                    class="mono"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellcheck={false}
                    enterKeyHint="done"
                    size={16}
                    value={s.channel_id}
                    placeholder="-1001234567890"
                    onInput={(e) => set("channel_id", e.currentTarget.value.trim())}
                  />
                </Num>
              </Kv>
            </dl>
          </Section>

          <Section
            header="Referrals"
            footer={`≈ $${(s.stars_per_usd > 0 ? s.referral_reward_stars / s.stars_per_usd : 0).toFixed(3)} at ${s.stars_per_usd} Stars per $1. A referral counts when a new user opens the bot from the link, picks a language, joins the update channel (checked with Telegram) and reaches the home screen.`}
          >
            <dl class="card">
              <Row toggle={{ on: !!s.referral_enabled, onChange: (v) => set("referral_enabled", v ? 1 : 0) }} wrap title="Referral program" />
              <Kv label="Reward per friend (Stars)" id="set-ref-reward">
                <Num>{numInput("referral_reward_stars", "set-ref-reward")}</Num>
              </Kv>
              <Kv label="Max paid referrals per user per day" id="set-ref-cap">
                <Num>{numInput("referral_daily_cap", "set-ref-cap")}</Num>
              </Kv>
            </dl>
          </Section>

          <Field
            id="set-terms"
            label="Terms of service"
            multiline
            rows={6}
            value={s.terms_text}
            onInput={(v) => set("terms_text", v)}
            help="Shown in the app and by /terms. Telegram requires terms for Stars payments."
          />

          <NotPanelKeySection hint={s.key_hint} source={s.notpanel_key_source} onSaved={(key_hint) => res.set({ ...res.data!, key_hint })} />

          {s.owners ? <AdminsSection owners={s.owners} onChanged={(owners) => res.set({ ...res.data!, owners })} /> : null}

          <Section header="Connection">
            <dl class="card">
              <Kv label="Bot">{s.bot_username ? `@${s.bot_username}` : "not connected"}</Kv>
              <Kv label="Order updates">{s.webhook_connected ? "Instant" : "Every minute (webhook off)"}</Kv>
              <Kv label="Mini App URL">
                <span class="mono" dir="ltr">
                  {s.app_url || "—"}
                </span>
              </Kv>
            </dl>
            <List>
              <Row accent title={connecting ? "Reconnecting…" : "Reconnect bot & NotPanel updates"} onClick={reconnect} disabled={connecting} chevron={false} />
              <Row
                accent
                title={previewing ? "Sending previews…" : "Preview bot messages"}
                meta="Sends every bot message to your chat in your app language (or type /preview ru in the bot)"
                onClick={previewMessages}
                disabled={previewing}
                chevron={false}
              />
            </List>
          </Section>
        </>
      )}
    </Page>
  );
}
