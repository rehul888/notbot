// Shared UI primitives (design spec v3, section 3). Screens compose these; they add no CSS of their own.
import type { ComponentChildren, ComponentType, JSX, Ref } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { OrderStatus } from "../shared/types";
import { platformLogo } from "../shared/platforms";
import { ApiError } from "./api";
import { prettyLink } from "./format";
import { t, tErr, type Key } from "./i18n";
import { Icon, ICON_PATHS, type IconName } from "./icons";
import { back, navigate, useRoute } from "./router";
import { reducedMotion } from "./motion";
import { createStore, keyboardStore } from "./store";
import { brandStore } from "./theme";
import { monogram } from "../shared/theme";
import { haptic, hasSecondaryButton, inTelegram, useBackButton, useBottomButtons, type ButtonSpec } from "./tg";

// ---------- brand ----------

/** The owner's logo, or a monogram (first letter of the brand name on the accent) when there is none. */
export function BrandMark({ size = 32 }: { size?: number }) {
  const b = brandStore.use();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.logoUrl]);
  const img = b.logoUrl && !broken;
  return (
    <span class={img ? "brand-mark has-img" : "brand-mark"} style={`--s:${size}px`} aria-hidden="true">
      {img ? <img src={b.logoUrl!} alt="" width={size} height={size} decoding="async" onError={() => setBroken(true)} /> : monogram(b.name)}
    </span>
  );
}

// ---------- small helpers ----------

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** t() with an English fallback, for keys that are added to the dictionaries separately (t() returns the key when it is missing). */
function tx(key: string, fallback: string, vars: Record<string, string | number> = {}): string {
  const s = t(key as Key, vars);
  return s === key ? fallback.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : s;
}

/** After the keyboard opens (~300ms), bring a focused control into view. */
function revealAfterFocus(el: HTMLElement | null, block: ScrollLogicalPosition) {
  if (!el) return;
  setTimeout(() => {
    if (!el.contains(document.activeElement)) return;
    const h = window.visualViewport?.height ?? window.innerHeight;
    const r = el.getBoundingClientRect();
    if (block === "start" || r.top < 0 || r.bottom > h - 8) el.scrollIntoView({ block, behavior: reducedMotion() ? "auto" : "smooth" });
  }, 300);
}

// ---------- data loading ----------

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void; set: (v: T) => void } {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: useCallback(() => setN((x) => x + 1), []),
    set: (data: T) => setState({ data, loading: false }),
  };
}

export const errText = (e: unknown) => (e instanceof ApiError ? tErr(e.code, e.details) : t("common.error"));

// ---------- layout ----------

type Bottom = "tabs" | "bar" | "native" | "none";
const BOTTOM_CLASS: Record<Bottom, string> = { tabs: "", bar: "with-bar", native: "no-tabs has-bottom", none: "no-tabs" };

/**
 * A screen: <main class="screen">. `bottom` reserves room for what floats below it.
 * Anything position:fixed (Sheet, Confetti, fallback bars) goes in `overlay`, rendered as a sibling of <main>.
 */
export function Screen({ bottom = "tabs", center, class: cls, overlay, children }: { bottom?: Bottom; center?: boolean; class?: string; overlay?: ComponentChildren; children: ComponentChildren }) {
  return (
    <>
      <main class={cx("screen", BOTTOM_CLASS[bottom], center && "center", cls)}>{children}</main>
      {overlay}
    </>
  );
}

/** Screen title that scrolls away with the content (never a fake nav bar). */
export function LargeTitle({
  title,
  sub,
  size = "large",
  eyebrow,
  lead,
  accessory,
  align = "start",
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  size?: "large" | "title" | "title2";
  eyebrow?: ComponentChildren;
  lead?: ComponentChildren;
  accessory?: ComponentChildren;
  align?: "start" | "center";
}) {
  const sz = size === "title" ? "lt-title" : size === "title2" ? "lt-title2" : "lt-large";
  return (
    <header class={cx("lt", sz, align === "center" && "lt-center")}>
      {eyebrow ? <div class="lt-eyebrow">{eyebrow}</div> : null}
      <div class="lt-row">
        {lead}
        <div class="lt-text">
          <h1>{title}</h1>
          {sub ? <p class="lt-sub">{sub}</p> : null}
        </div>
        {accessory ? <div class="lt-acc">{accessory}</div> : null}
      </div>
    </header>
  );
}

/** "Step 2 of 4" with bars; the current bar grows in from the reading start. */
export function FlowSteps({ step, total = 4 }: { step: number; total?: number }) {
  return (
    <p class="flow">
      <span class="flow-bars" aria-hidden="true">
        {Array.from({ length: total }, (_, k) => (
          <i key={k} class={k + 1 < step ? "on" : k + 1 === step ? "on now" : undefined} />
        ))}
      </span>
      <span>{tx("flow.step", "Step {n} of {total}", { n: step, total })}</span>
    </p>
  );
}

/** A group: small sentence-case header (or Title 3 with variant="title"), content, optional footer note. */
export function Section({
  header,
  variant = "label",
  labelFor,
  action,
  footer,
  children,
  class: cls,
}: {
  header?: ComponentChildren;
  variant?: "label" | "title";
  labelFor?: string;
  action?: { label: string; onClick?: () => void; href?: string };
  footer?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}) {
  const hcls = cx("label", variant === "title" && "title");
  const act = action ? (
    action.href ? (
      <a
        class="label-act"
        href={`#${action.href}`}
        onClick={(e) => {
          e.preventDefault();
          haptic.tap();
          if (action.onClick) action.onClick();
          else navigate(action.href!);
        }}
      >
        {action.label}
      </a>
    ) : (
      <button type="button" class="label-act" onClick={() => (haptic.tap(), action.onClick?.())}>
        {action.label}
      </button>
    )
  ) : null;
  let head: ComponentChildren = null;
  if (labelFor)
    head = (
      <label class={hcls} for={labelFor}>
        {header}
        {act}
      </label>
    );
  else if (act)
    head = (
      <div class={hcls}>
        <h2>{header}</h2>
        {act}
      </div>
    );
  else if (header != null && header !== false) head = <h2 class={hcls}>{header}</h2>;
  return (
    <section class={cx("section", cls)}>
      {head}
      {children}
      {footer ? <p class="note">{footer}</p> : null}
    </section>
  );
}

/** Grouped card of rows. `stagger` fades rows in one after another on mount. */
export function List({ children, label, role, stagger, class: cls }: { children: ComponentChildren; label?: string; role?: "radiogroup" | "list" | "group"; stagger?: boolean; class?: string }) {
  return (
    <div class={cx("card list", stagger && "stagger", cls)} role={role ?? (label ? "group" : undefined)} aria-label={label}>
      {children}
    </div>
  );
}

// ---------- rows ----------

export interface RowProps {
  icon?: IconName;
  plate?: string;
  lead?: ComponentChildren;
  title: ComponentChildren;
  meta?: ComponentChildren;
  value?: ComponentChildren;
  chevron?: boolean;
  onClick?: () => void;
  href?: string;
  children?: ComponentChildren;
  danger?: boolean;
  accent?: boolean;
  /** Interactive trailing control (Switch, Chip) placed OUTSIDE the row's tap target. */
  control?: ComponentChildren;
  /** The whole row is the switch. */
  toggle?: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean };
  radio?: boolean;
  checked?: boolean;
  external?: boolean;
  disabled?: boolean;
  size?: "md" | "lg";
  wrap?: boolean;
  center?: boolean;
  class?: string;
}

export function Row(p: RowProps) {
  const { icon, plate, lead, title, meta, value, chevron = true, onClick, href, children, control, toggle, radio, checked, external, disabled } = p;
  const tappable = !!(onClick || href);
  const cls = cx("row", p.size === "lg" && "lg", p.wrap && "wrap", p.danger && "danger", p.accent && "accent", p.center && "center", disabled && !tappable && !toggle && "disabled", p.class);
  const leadEl =
    lead ??
    (icon ? (
      <span class="tile" style={plate ? `background:${plate}` : undefined}>
        <Icon name={icon} size={18} stroke={1.8} />
      </span>
    ) : null);
  const text = (
    <>
      <span class={p.wrap ? "title" : "title ellipsis"}>{title}</span>
      {meta ? <span class="meta">{meta}</span> : null}
    </>
  );
  const valueEl = value !== undefined ? <span class="value">{value}</span> : null;
  const go = () => {
    if (href) navigate(href);
    else onClick?.();
  };

  if (toggle) {
    return (
      <button
        type="button"
        class={cls}
        role="switch"
        aria-checked={toggle.on}
        disabled={disabled || toggle.disabled}
        onClick={() => {
          haptic.select();
          toggle.onChange(!toggle.on);
        }}
      >
        {leadEl}
        <span class="body">
          <span class="grow">{text}</span>
          {valueEl}
          {children}
          <Switch on={toggle.on} visual />
        </span>
      </button>
    );
  }

  if (radio) {
    return (
      <button
        type="button"
        class={cls}
        role="radio"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={() => {
          haptic.select();
          go();
        }}
      >
        {leadEl}
        <span class="body">
          <span class="grow">{text}</span>
          {valueEl}
          {children}
          <span class="check" data-on={checked ? "true" : "false"} aria-hidden="true">
            <Icon name="check" size={20} stroke={2.4} />
          </span>
        </span>
      </button>
    );
  }

  if (control && tappable) {
    // Stretched-button pattern: the main button covers the row, the control sits above it. Nothing is nested.
    return (
      <div class={cls}>
        {leadEl}
        <span class="body">
          <button type="button" class="row-main grow" disabled={disabled} onClick={() => (haptic.tap(), go())}>
            {text}
          </button>
          {valueEl}
          {children}
          <span class="row-control">{control}</span>
        </span>
      </div>
    );
  }

  const trail = external ? (
    <Icon name="out" size={14} stroke={2.4} class="ext" />
  ) : chevron && tappable && !p.danger && !p.center ? (
    <Icon name="chevron" size={14} stroke={2.6} class="chev" />
  ) : null;

  if (tappable) {
    return (
      <button type="button" class={cls} disabled={disabled} onClick={() => (haptic.tap(), go())}>
        {leadEl}
        <span class="body">
          <span class="grow">{text}</span>
          {valueEl}
          {children}
          {trail}
        </span>
      </button>
    );
  }
  return (
    <div class={cls}>
      {leadEl}
      <span class="body">
        <span class="grow">{text}</span>
        {valueEl}
        {children}
        {control ? <span class="row-control">{control}</span> : null}
        {external ? trail : null}
      </span>
    </div>
  );
}

// ---------- controls ----------

/** iOS switch. `visual` renders a non-interactive copy for `Row toggle`. */
export function Switch({ on, label, onChange, disabled, visual }: { on: boolean; label?: string; onChange?: (v: boolean) => void; disabled?: boolean; visual?: boolean }) {
  if (visual)
    return (
      <span class={cx("switch", on && "on")} aria-hidden="true">
        <i class="sw-fill" />
      </span>
    );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      class={cx("switch", on && "on")}
      onClick={(e) => {
        e.stopPropagation();
        haptic.select();
        onChange?.(!on);
      }}
    >
      <i class="sw-fill" />
    </button>
  );
}

/** Segmented control with a sliding thumb. */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  const i = options.findIndex(([v]) => v === value);
  return (
    <div class="seg" role="group" aria-label={label} style={`--n:${options.length};--i:${Math.max(0, i)}`} data-none={i < 0 ? "" : undefined}>
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => {
            if (v !== value) haptic.select();
            onChange(v);
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** Equal-width pill presets (amounts). Selected = solid cobalt. */
export function Presets<T extends string | number>({ value, options, onChange, label }: { value: T | null; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="presets" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button
          type="button"
          key={String(v)}
          class="preset press"
          aria-pressed={v === value}
          onClick={() => {
            haptic.select();
            onChange(v);
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * Chip. With onClick it is a 36px button (44px hit): `selected` = solid cobalt choice/filter (haptic select),
 * `tint` = soft action like "Again" (haptic tap). Without onClick it is a 28px info chip.
 */
export function Chip({ selected, tint, onClick, lead, down, label, disabled, children }: { selected?: boolean; tint?: boolean; onClick?: () => void; lead?: ComponentChildren; down?: boolean; label?: string; disabled?: boolean; children: ComponentChildren }) {
  const inner = (
    <>
      {lead}
      {children}
      {down ? <Icon name="down" size={13} stroke={2.4} /> : null}
    </>
  );
  if (!onClick) return <span class={cx("chip", selected && "sel")}>{inner}</span>;
  return (
    <button
      type="button"
      class={cx("chip", selected && "sel", tint && "tint")}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (tint) haptic.tap();
        else if (selected !== undefined) haptic.select();
        onClick();
      }}
    >
      {inner}
    </button>
  );
}

/** OrderForm quick-change chip (opens a picker sheet). */
export function QuickChip({ lead, onClick, label, children }: { lead?: ComponentChildren; onClick: () => void; label?: string; children: ComponentChildren }) {
  return (
    <button type="button" class={cx("qchip press", !lead && "nolead")} aria-label={label} onClick={() => (haptic.tap(), onClick())}>
      {lead}
      <span class="ellipsis">{children}</span>
      <Icon name="down" size={13} stroke={2.4} />
    </button>
  );
}

/** Search box with a clear button. Scrolls itself to the top once the keyboard is up. */
export function SearchField({ value, onInput, placeholder, label, autoFocus }: { value: string; onInput: (v: string) => void; placeholder: string; label?: string; autoFocus?: boolean }) {
  const box = useRef<HTMLLabelElement>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <label class="search" ref={box}>
      <Icon name="search" size={17} stroke={2.2} />
      <span class="sr">{label ?? placeholder}</span>
      <input
        ref={input}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellcheck={false}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onInput={(e) => onInput(e.currentTarget.value)}
        onFocus={() => revealAfterFocus(box.current, "start")}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {value ? (
        <button
          type="button"
          class="clear"
          aria-label={tx("common.clear", "Clear")}
          onClick={(e) => {
            e.preventDefault();
            onInput("");
            input.current?.focus();
          }}
        >
          <span class="x">
            <Icon name="close" size={10} stroke={3.2} />
          </span>
        </button>
      ) : null}
    </label>
  );
}

/** Labelled text field (or textarea). Error text replaces help text, never both. */
export function Field({
  id,
  label,
  labelEnd,
  value,
  onInput,
  onBlur,
  placeholder,
  lead,
  trailing,
  help,
  error,
  multiline,
  rows,
  inputMode,
  enterKeyHint,
  type,
  dir,
  required,
  maxLength,
  inputRef,
}: {
  id: string;
  label?: ComponentChildren;
  labelEnd?: ComponentChildren;
  value: string;
  onInput: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** An icon name, or any node (e.g. "$"). */
  lead?: IconName | ComponentChildren;
  trailing?: ComponentChildren;
  help?: ComponentChildren;
  error?: string | null;
  multiline?: boolean;
  rows?: number;
  inputMode?: "text" | "url" | "numeric" | "decimal" | "email" | "tel" | "search" | "none";
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  type?: "text" | "url" | "email" | "tel" | "search" | "number" | "password";
  dir?: "ltr" | "auto";
  required?: boolean;
  maxLength?: number;
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const describedBy = error ? `${id}-err` : help ? `${id}-help` : undefined;
  const leadEl = lead == null || lead === false ? null : typeof lead === "string" && lead in ICON_PATHS ? <Icon name={lead} size={18} /> : <span class="field-lead">{lead}</span>;
  const common = {
    id,
    value,
    placeholder,
    required,
    maxLength,
    dir,
    inputMode,
    enterKeyHint,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    onFocus: () => revealAfterFocus(box.current, "center"),
    onBlur,
  };
  return (
    <div class="section">
      {label || labelEnd ? (
        <label class="label" for={id}>
          <span>{label}</span>
          {labelEnd ? <span class="label-end">{labelEnd}</span> : null}
        </label>
      ) : null}
      <div ref={box} class={cx("card field", multiline && "top", error && "invalid")}>
        {leadEl}
        {multiline ? (
          <textarea {...common} ref={inputRef as Ref<HTMLTextAreaElement>} rows={rows ?? 5} onInput={(e) => onInput(e.currentTarget.value)} />
        ) : (
          <input {...common} ref={inputRef as Ref<HTMLInputElement>} type={(type ?? "text") as "text"} autoComplete="off" autoCapitalize="off" spellcheck={false} onInput={(e) => onInput(e.currentTarget.value)} />
        )}
        {trailing}
      </div>
      {error ? (
        <p class="field-error" id={`${id}-err`} role="alert">
          <Icon name="alert" size={15} stroke={2.2} />
          <span>{error}</span>
        </p>
      ) : help ? (
        <p class="note" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** Callout. plain = quiet footnote with an icon; info/warn/error = tinted box. With onClick it becomes a button with a chevron. */
export function Notice({ tone = "info", icon, children, onClick }: { tone?: "plain" | "info" | "warn" | "error"; icon?: IconName; children: ComponentChildren; onClick?: () => void }) {
  const ic = icon ?? (tone === "warn" || tone === "error" ? "alert" : "info");
  const inner = (
    <>
      <Icon name={ic} size={tone === "plain" ? 16 : 18} stroke={2} />
      <span>{children}</span>
      {onClick ? <Icon name="chevron" size={14} stroke={2.6} class="chev" /> : null}
    </>
  );
  return onClick ? (
    <button type="button" class={cx("notice", tone)} onClick={() => (haptic.tap(), onClick())}>
      {inner}
    </button>
  ) : (
    <div class={cx("notice", tone)} role={tone === "error" ? "alert" : undefined}>
      {inner}
    </div>
  );
}

// ---------- status, progress, money ----------

const STATUS_CLASS: Record<OrderStatus, string> = {
  submitting: "st-pending",
  pending: "st-pending",
  processing: "st-progress",
  in_progress: "st-progress",
  completed: "st-done",
  partial: "st-partial",
  cancelled: "st-cancel",
  failed: "st-cancel",
};
export function StatusPill({ status }: { status: OrderStatus }) {
  return <span class={`status ${STATUS_CLASS[status]}`}>{t(`status.${status}`)}</span>;
}

/** Progress bar. The fill slides in on mount and glides to new values (transform only). */
export function Progress({ value, max, size, label }: { value: number; max: number; size?: "sm" | "lg"; label?: string }) {
  const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span class={cx("bar", size === "lg" && "lg")} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <i style={`--p:${p}`} />
    </span>
  );
}

/** Pay-with choice (wrap two in <div class="pay-opts" role="radiogroup" aria-label=…>). */
export function PayOption({ on, onClick, title, sub, plate, icon, low }: { on: boolean; onClick: () => void; title: string; sub: ComponentChildren; plate: string; icon: ComponentChildren; low?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      class={cx("pay-opt press", low && "low")}
      onClick={() => {
        haptic.select();
        onClick();
      }}
    >
      <span class="tile sm" style={`background:${plate}`}>
        {icon}
      </span>
      <span>
        <span class="ttl">{title}</span>
        <span class="sub">{sub}</span>
      </span>
      <span class="tick" aria-hidden="true">
        <Icon name="check" size={12} stroke={3} />
      </span>
    </button>
  );
}

/** Money / quantities inside translated text: isolated left-to-right run. */
export function Num({ children }: { children: ComponentChildren }) {
  return (
    <bdi dir="ltr" class="num">
      {children}
    </bdi>
  );
}

/** A user link shown without its scheme, isolated left-to-right, ellipsized. */
export function LinkText({ href }: { href: string }) {
  return (
    <bdi dir="ltr" class="ellipsis">
      {prettyLink(href)}
    </bdi>
  );
}

export function PlatformLogo({ slug, size = 48, radius, on }: { slug: string; size?: number; radius?: number; on?: boolean }) {
  const src = platformLogo(slug);
  const img = Math.round(size * 0.56);
  return (
    <span class={cx("logo", on && "on")} style={`width:${size}px;height:${size}px;${radius ? `border-radius:${radius}px` : ""}`}>
      {src ? <img src={src} alt="" width={img} height={img} loading="lazy" decoding="async" /> : <Icon name="more" size={img} stroke={3} />}
    </span>
  );
}

// ---------- empty, error, loading ----------

export type ArtName = "orders" | "wallet" | "search" | "error" | "offline" | "none";
type ArtRenderer = ComponentType<{ name: Exclude<ArtName, "none"> }>;
let artRenderer: ArtRenderer | null = null;

/** src/art.tsx registers its empty-state art here once (module top level), so ui.tsx does not import art.tsx. */
export function registerEmptyArt(render: ArtRenderer) {
  artRenderer = render;
}

/** orders → A6, wallet → A7, search → A8, error/offline → A9; renders nothing until art is registered. */
export function EmptyArt({ name }: { name?: ArtName }) {
  const A = artRenderer;
  return name && name !== "none" && A ? <A name={name} /> : null;
}

export function EmptyState({ art, title, body, action, compact }: { art?: ArtName | JSX.Element; title: string; body?: ComponentChildren; action?: { label: string; onClick: () => void }; compact?: boolean }) {
  return (
    <div class={cx("empty", compact && "compact")} role="status">
      {typeof art === "string" ? <EmptyArt name={art} /> : (art ?? null)}
      <b>{title}</b>
      {body ? <span>{body}</span> : null}
      {action ? (
        <button type="button" class="btn soft sm inline press" onClick={() => (haptic.tap(), action.onClick())}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry: () => void; compact?: boolean }) {
  const offline = (error instanceof ApiError && error.code === "NETWORK") || (typeof navigator !== "undefined" && navigator.onLine === false);
  return (
    <div class={cx("empty", compact && "compact")} role="alert">
      <EmptyArt name={offline ? "offline" : "error"} />
      <b>{offline ? tx("common.offlineTitle", "No connection") : tx("common.errorTitle", "Couldn't load this")}</b>
      <span>{offline ? t("common.offline") : errText(error)}</span>
      <button type="button" class="btn soft sm inline press" onClick={() => (haptic.tap(), onRetry())}>
        {t("common.retry")}
      </button>
    </div>
  );
}

export function Skeleton({ h = 50, n = 1, radius }: { h?: number; n?: number; radius?: number }) {
  return (
    <div class="skel-stack" aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} class="skel" style={`height:${h}px${radius !== undefined ? `;border-radius:${radius}px` : ""}`} />
      ))}
    </div>
  );
}

/** A card of placeholder rows shaped like the real rows. */
export function SkeletonList({ rows = 4, lead = "tile" }: { rows?: number; lead?: "tile" | "logo" | "none" }) {
  return (
    <div class="card" aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div class="skel-row" key={i}>
          {lead !== "none" ? <span class={cx("skel lead", lead === "logo" && "logo-s")} /> : null}
          <span class="lines">
            <span class="skel l1" />
            <span class="skel l2" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Placeholder platform grid (put it inside the same .card as the real grid). */
export function SkeletonGrid({ n = 10 }: { n?: number }) {
  return (
    <div class="grid5" aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: n }, (_, i) => (
        <span class="skel-tile" key={i}>
          <span class="skel tile48" />
          <span class="skel cap" />
        </span>
      ))}
    </div>
  );
}

// ---------- toast ----------

type ToastKind = "info" | "ok" | "error";
const toastStore = createStore<{ id: number; msg: string; kind: ToastKind; leaving: boolean } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

function dismissToast() {
  const cur = toastStore.get();
  if (!cur || cur.leaving) return;
  clearTimeout(toastTimer);
  toastStore.set({ ...cur, leaving: true });
  toastTimer = setTimeout(() => toastStore.set(null), 200);
}

/** Short message at the top. "ok" also fires the success haptic and "error" the error haptic, so callers don't. */
export function toast(msg: string, kind: ToastKind = "info") {
  if (kind === "ok") haptic.success();
  else if (kind === "error") haptic.error();
  clearTimeout(toastTimer);
  toastStore.set({ id: ++toastSeq, msg, kind, leaving: false });
  toastTimer = setTimeout(dismissToast, kind === "error" ? 3500 : 2400);
}

export function Toasts() {
  const cur = toastStore.use();
  if (!cur) return null;
  return (
    <div key={cur.id} class={cx("toast", cur.kind, cur.leaving && "leaving")} role={cur.kind === "error" ? "alert" : "status"} onClick={dismissToast}>
      <Icon name={cur.kind === "ok" ? "check" : cur.kind === "error" ? "alert" : "info"} size={18} stroke={2.4} />
      <span>{cur.msg}</span>
    </div>
  );
}

// ---------- sheet ----------

/** Number of open sheets. BottomButtons hides Telegram's MainButton/SecondaryButton while it is above 0. */
export const overlayStore = createStore(0);

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet. Opens with a spring, closes with a slide (X, dim tap, Escape, Telegram Back, drag down on the
 * grabber or header). onClose fires once the close animation ends. Render it in Screen `overlay`.
 */
export function Sheet({ title, sub, onClose, children, footer, size = "auto" }: { title: string; sub?: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; size?: "auto" | "large" }) {
  const dimRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<"in" | "open" | "out">("in");
  const st = useRef({ closing: false, done: false, mounted: true, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const drag = useRef<{ id: number; y0: number; dy: number; h: number; samples: [number, number][]; raf: number; active: boolean } | null>(null);

  const clearDrag = () => {
    const s = sheetRef.current;
    const d = dimRef.current;
    if (s) {
      s.classList.remove("dragging", "settle");
      s.style.transform = s.style.transition = "";
    }
    if (d) d.style.opacity = d.style.transition = d.style.pointerEvents = "";
  };

  const finish = () => {
    const s = st.current;
    if (s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    closeRef.current();
    // If the parent kept the sheet mounted, it wants it open: show it again.
    setTimeout(() => {
      if (!s.mounted) return;
      s.done = s.closing = false;
      clearDrag();
      setPhase("open");
    }, 0);
  };

  const requestClose = () => {
    const s = st.current;
    if (s.closing || s.done) return;
    s.closing = true;
    if (reducedMotion()) return finish();
    setPhase("out");
    s.timer = setTimeout(finish, 280);
  };

  // Count open sheets synchronously, so swapping one sheet for the next never flashes the MainButton.
  useLayoutEffect(() => {
    overlayStore.set((n) => n + 1);
    document.body.style.overflow = "hidden";
    return () => {
      overlayStore.set((n) => Math.max(0, n - 1));
      if (overlayStore.get() === 0) document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus({ preventScroll: true });
    const openFallback = setTimeout(() => setPhase((p) => (p === "in" ? "open" : p)), 700);
    const s = st.current;
    return () => {
      s.mounted = false;
      clearTimeout(s.timer);
      clearTimeout(openFallback);
      // Restore focus, but never to a text input (that would pop the keyboard back up).
      if (prev && prev.isConnected && prev !== document.body && !prev.matches("input, textarea, [contenteditable]")) prev.focus({ preventScroll: true });
    };
  }, []);

  // On top of the BackButton stack while open: Back closes this sheet only, and the page's Back returns afterwards.
  useBackButton(requestClose);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !sheetRef.current) return;
    const f = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Drag to dismiss (grabber and header only)
  const onPointerDown = (e: PointerEvent) => {
    if (phase !== "open" || st.current.closing || e.button !== 0) return;
    if ((e.target as Element).closest("button, a, input")) return;
    const el = sheetRef.current;
    if (!el) return;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, h: el.offsetHeight, samples: [[e.timeStamp, e.clientY]], raf: 0, active: false };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer (synthetic events); dragging still works without capture */
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const el = sheetRef.current;
    if (!d || !el || e.pointerId !== d.id) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    d.samples.push([e.timeStamp, e.clientY]);
    while (d.samples.length > 2 && e.timeStamp - d.samples[0][0] > 80) d.samples.shift();
    if (!d.active) {
      if (d.dy < 4) return;
      d.active = true;
      el.classList.add("dragging");
    }
    if (!d.raf)
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        el.style.transform = `translate3d(0, ${d.dy}px, 0)`;
        if (dimRef.current) dimRef.current.style.opacity = String(1 - Math.min(d.dy / d.h, 1) * 0.6);
      });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    const el = sheetRef.current;
    const dim = dimRef.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    cancelAnimationFrame(d.raf);
    if (!d.active || !el || !dim) return;
    const [t0, y0] = d.samples[0];
    const v = (e.clientY - y0) / Math.max(1, e.timeStamp - t0);
    el.classList.remove("dragging");
    if (e.type !== "pointercancel" && (d.dy > Math.min(120, d.h * 0.25) || v > 0.5)) {
      st.current.closing = true;
      const ms = Math.round(Math.min(280, Math.max(160, (d.h - d.dy) / Math.max(v, 0.001))));
      const ease = "cubic-bezier(0.2, 0.6, 0.4, 1)";
      el.style.transition = `transform ${ms}ms ${ease}`;
      dim.style.transition = `opacity ${ms}ms ${ease}`;
      el.style.transform = "translate3d(0, 100%, 0)";
      dim.style.opacity = "0";
      dim.style.pointerEvents = "none";
      st.current.timer = setTimeout(finish, ms + 20);
    } else {
      el.classList.add("settle");
      dim.style.transition = "opacity 380ms var(--ease-out)";
      el.style.transform = "";
      dim.style.opacity = "";
      setTimeout(() => {
        if (!drag.current) {
          el.classList.remove("settle");
          dim.style.transition = "";
        }
      }, 400);
    }
  };
  const dragProps = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  return (
    <div class={cx("sheet-dim", phase === "out" && "out")} ref={dimRef} onClick={(e) => e.target === e.currentTarget && requestClose()}>
      <div
        class={cx("sheet", size === "large" && "large", phase === "open" && "open", phase === "out" && "out")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        onKeyDown={onKeyDown}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (st.current.closing) finish();
          else setPhase((p) => (p === "in" ? "open" : p));
        }}
      >
        <span class="grab" aria-hidden="true" {...dragProps} />
        <div class="head" {...dragProps}>
          <div>
            <b>{title}</b>
            {sub ? <span class="sub">{sub}</span> : null}
          </div>
          <button type="button" class="iconbtn" ref={closeBtn} aria-label={t("common.close")} onClick={requestClose}>
            <Icon name="close" size={14} stroke={3} />
          </button>
        </div>
        <div class="scroll">{children}</div>
        {footer ? <div class="foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------- navigation chrome ----------

const TABS: [string, IconName, "tab.new" | "tab.orders" | "tab.wallet" | "tab.profile"][] = [
  ["/", "plusCircle", "tab.new"],
  ["/orders", "receipt", "tab.orders"],
  ["/wallet", "wallet", "tab.wallet"],
  ["/profile", "person", "tab.profile"],
];

/** Without :has() (old Android WebViews) CSS can't slide the floating bars away from the keyboard, so they unmount. */
const cssHas = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("selector(:has(a))");
function useKeyboardHidesBar(): boolean {
  const kb = keyboardStore.use();
  return kb && !cssHas;
}

/** Floating capsule tab bar with a sliding lens. Only on the four main screens, as their only nav (so no label). */
export function TabBar() {
  const { path } = useRoute();
  if (useKeyboardHidesBar()) return null;
  const idx = TABS.findIndex(([href]) => href === path);
  return (
    <nav class="tabs" style={`--i:${Math.max(0, idx)}`} data-none={idx < 0 ? "" : undefined}>
      {TABS.map(([href, icon, key]) => (
        <a
          key={href}
          href={`#${href}`}
          aria-current={path === href ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            if (path !== href) {
              haptic.select();
              navigate(href, { replace: true });
            }
          }}
        >
          <Icon name={icon} size={22} stroke={path === href ? 2 : 1.8} />
          <span>{t(key)}</span>
        </a>
      ))}
    </nav>
  );
}

/** Floating order-steps bar (Categories, Services; their only nav, so no label). Put `.pick` buttons inside. Render it in Screen `overlay`. */
export function StepsBar({ children }: { children: ComponentChildren }) {
  if (useKeyboardHidesBar()) return null;
  return (
    <nav class="steps">
      {children}
    </nav>
  );
}

/** Telegram BackButton inside Telegram; a small back link in a normal browser (local dev). */
export function BackNav({ to }: { to: string }) {
  // A sheet opened later sits above this on the BackButton stack; the overlay check is a second guard.
  useBackButton(() => {
    if (overlayStore.get() === 0) back(to);
  });
  if (inTelegram) return null;
  return (
    <div class="devbar">
      <button type="button" class="textbtn" onClick={() => back(to)}>
        <Icon name="back" size={22} stroke={2.2} class="rtl-flip" />
        {t("common.back")}
      </button>
    </div>
  );
}

/**
 * Bottom actions. Inside Telegram these are the native MainButton / SecondaryButton (hidden while a sheet is open);
 * otherwise (or when SecondaryButton isn't supported) HTML buttons are rendered.
 */
export function BottomButtons({ main, secondary }: { main: ButtonSpec | null; secondary?: ButtonSpec | null }) {
  const covered = overlayStore.use() > 0;
  const m = covered ? null : main;
  const s = covered ? null : (secondary ?? null);
  const native = useBottomButtons(m, s);
  const htmlMain = !native && m;
  const htmlSecondary = s && (!native || !hasSecondaryButton);
  if (!htmlMain && !htmlSecondary) return null;
  return (
    <div class="bottom">
      {htmlSecondary ? (
        <button type="button" class="btn soft" onClick={s!.onClick} disabled={s!.disabled}>
          {s!.text}
        </button>
      ) : null}
      {htmlMain ? (
        <button type="button" class="btn" onClick={m!.onClick} disabled={m!.disabled || m!.progress} aria-busy={m!.progress ? "true" : undefined}>
          {m!.progress ? <span class="spin" aria-hidden="true" /> : null}
          {m!.text}
        </button>
      ) : null}
    </div>
  );
}
