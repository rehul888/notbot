// Order form (`/s/:id`, step 4 of 4), design spec §5.6. Reads top to bottom like a form: what, where, how many,
// how to pay, total. The MainButton always says exactly what will happen.
//
// One component renders the loading, error and loaded states inside the same <main>, so the screen's enter animation
// plays once (a remounted <main> would replay it while html[data-nav] is still set).
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { OrderView, ServiceDetail, ServiceField } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { api, ApiError, cachedApi } from "../api";
import { starsToCover } from "../../shared/stars";
import { amount, balance, duration, iso, lower, lrm, num, short, stars } from "../format";
import { t } from "../i18n";
import { Icon, StarIcon } from "../icons";
import { refreshMe } from "../me";
import { reducedMotion } from "../motion";
import { enc, navigate } from "../router";
import { meStore } from "../store";
import { closingConfirmation, haptic, openInvoice, type ButtonSpec } from "../tg";
import {
  BackNav,
  BottomButtons,
  Chip,
  ErrorState,
  Field,
  FlowSteps,
  Notice,
  Num,
  PayOption,
  PlatformLogo,
  Presets,
  QuickChip,
  Screen,
  Section,
  Skeleton,
  errText,
  toast,
  useAsync,
} from "../ui";
import { primePlaced } from "./OrderPlaced";
import { CategorySheet, PlatformSheet, ServiceSheet } from "./Pickers";

type PayWith = "balance" | "stars";

const units = () => ({ m: t("units.m"), h: t("units.h"), d: t("units.d") });
const PRESETS = [100, 500, 1000, 5000, 10000, 50000];
const SPEEDS = [60, 360, 720, 1440, 2880];
/** Order price in micro-USD, exactly as the server charges it (worker/pricing.ts orderCharge). Shown as Stars. */
function charge(svc: ServiceDetail, qty: number): number {
  if (svc.quantityMode === "fixed") return Math.max(1, svc.rate);
  return Math.max(1, Math.ceil((svc.rate * qty) / 1000 - 1e-9));
}

function stepFor(svc: ServiceDetail): number {
  const s = Math.max(svc.step, svc.min >= 1000 ? 1000 : svc.min >= 100 ? 100 : 10);
  return Math.ceil(s / svc.step) * svc.step;
}

function clampQty(svc: ServiceDetail, q: number): number {
  let v = Math.min(svc.max, Math.max(svc.min, Math.round(q)));
  if (svc.step > 1) v = Math.floor(v / svc.step) * svc.step || svc.step;
  return v;
}

const initialQty = (svc: ServiceDetail, query: URLSearchParams) => clampQty(svc, Number(query.get("qty")) || (svc.min <= 1000 && svc.max >= 1000 ? 1000 : svc.min));

const countLines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).length;

const smooth = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");

const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard && "readText" in navigator.clipboard;

export function OrderForm({ serviceId, query }: { serviceId: number; query: URLSearchParams }) {
  const res = useAsync(() => cachedApi<ServiceDetail>(`/catalog/service/${serviceId}`), [serviceId]);
  const svc = res.data;
  const me = meStore.use()!;
  const [link, setLink] = useState(query.get("link") ?? "");
  /** null until the user changes it: the default comes from ?qty= or the service. */
  const [qtyPick, setQtyPick] = useState<number | null>(null);
  /** Raw digits while the amount field has focus; null shows the formatted number. */
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [drip, setDrip] = useState(0);
  /** null until the user picks: then the balance is used when it covers the order, Stars otherwise. */
  const [payPick, setPayPick] = useState<PayWith | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [sheet, setSheet] = useState<"platform" | "category" | "service" | null>(null);
  const [pickPlatform, setPickPlatform] = useState<string | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [descLong, setDescLong] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    closingConfirmation(!!link.trim());
    return () => closingConfirmation(false);
  }, [!!link.trim()]);

  // Offer "Show more" only when the description really runs past three lines.
  useLayoutEffect(() => {
    const el = descRef.current;
    if (el && !descOpen) setDescLong(el.scrollHeight > el.clientHeight + 1);
  }, [svc?.description]);

  // A payment error appears inside "Pay with"; make sure it is on screen.
  useEffect(() => {
    if (error) document.querySelector(".screen .notice.error")?.scrollIntoView({ block: "center", behavior: smooth() });
  }, [error]);

  const shell = (body: ComponentChildren, overlay?: ComponentChildren, center?: boolean) => (
    <>
      <BackNav to="/" />
      <Screen bottom="native" class="stagger" center={center} overlay={overlay}>
        {body}
      </Screen>
    </>
  );

  if (!svc && res.error) return shell(<><ErrorState error={res.error} onRetry={res.reload} /></>, null, true);
  if (!svc)
    return shell(
      <>
        <header class="lt">
          <FlowSteps step={4} />
          <Skeleton h={148} radius={20} />
        </header>
        <Skeleton h={52} radius={20} />
        <Skeleton h={132} radius={20} />
      </>,
    );

  // ---------- derived state ----------
  const fixed = svc.quantityMode === "fixed";
  const linesKey = svc.linesField;
  const qty = qtyPick ?? initialQty(svc, query);
  const quantity = svc.quantityMode === "lines" && linesKey ? countLines(fields[linesKey] ?? "") : fixed ? svc.min : qty;
  // Money is micro-USD; users see Stars. Paying in Stars asks for the fewest Stars whose value covers the order.
  const total = charge(svc, quantity);
  const enough = me.balance >= total;
  const payWith: PayWith = payPick ?? (enough ? "balance" : "stars");
  const shortOnBalance = payWith === "balance" && !enough;
  // The total is shown as the Stars that cover it, so a shown balance >= the shown total can always pay
  const invoiceStars = starsToCover(total, me.starsPerUsd);
  const totalStars = invoiceStars;
  // Top-up (whole Stars) that covers the order: the shortfall, at least the minimum top-up, within the maximum.
  const needRaw = Math.max(starsToCover(total - me.balance, me.starsPerUsd), me.minTopup);
  const need = me.maxTopup > 0 ? Math.min(needRaw, me.maxTopup) : needRaw;

  const missing: string[] = [];
  if (link.trim().length < 2) missing.push("link");
  for (const f of svc.fields) if (f.required && !(fields[f.key] ?? "").trim()) missing.push(f.key);
  if (svc.quantityMode === "lines" && (quantity < svc.min || quantity > svc.max)) missing.push(linesKey ?? "lines");

  const fieldError = (f: ServiceField): string | null => {
    if (!showErrors || !missing.includes(f.key)) return null;
    if (f.key === linesKey && svc.quantityMode === "lines") {
      if (quantity < svc.min) return t("err.MINIMUM_QUANTITY", { n: num(svc.min) });
      if (quantity > svc.max) return t("err.MAXIMUM_QUANTITY", { n: num(svc.max) });
    }
    return t("form.required");
  };

  const presets = PRESETS.filter((p) => p >= svc.min && p <= svc.max && (svc.step <= 1 || p % svc.step === 0)).slice(0, 5);
  const speeds = svc.dripFeed ? SPEEDS.filter((m) => m <= svc.dripFeed!.max_total_minutes) : [];

  // ---------- actions ----------
  const setQuantity = (v: number) => {
    setQtyPick(clampQty(svc, v));
    setEditing(null);
  };

  const bump = (d: 1 | -1) => {
    const raw = qty + d * stepFor(svc);
    if (raw < svc.min || raw > svc.max) haptic.edge();
    else haptic.select();
    setQuantity(raw);
  };

  const commitQty = (text: string) => {
    const v = Number(text.replace(/\D/g, "")) || svc.min;
    if (v < svc.min || v > svc.max) haptic.edge();
    setQuantity(v);
  };

  /** Bring the amount card above the keyboard once it is up (~300ms). */
  const revealQty = (el: HTMLElement) =>
    setTimeout(() => {
      if (document.activeElement !== el) return;
      const card = el.closest<HTMLElement>(".qty-card") ?? el;
      const h = window.visualViewport?.height ?? window.innerHeight;
      const r = card.getBoundingClientRect();
      if (r.top < 0 || r.bottom > h - 8) card.scrollIntoView({ block: "center", behavior: smooth() });
    }, 300);

  const pickPay = (p: PayWith) => {
    setPayPick(p);
    setError(null);
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setLink(text.trim());
        setError(null);
        haptic.select();
      }
    } catch {
      toast(t("form.linkPh"));
    }
  };

  /** Scroll to the first invalid field (in screen order) and focus it. */
  const focusFirstInvalid = () => {
    const order = ["link", ...svc.fields.map((f) => f.key)];
    const key = order.find((k) => missing.includes(k)) ?? missing[0];
    const el = document.getElementById(key === "link" ? "lnk" : `f-${key}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: smooth() });
    const target = el.matches("input, textarea") ? el : el.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  };

  const submit = async () => {
    if (busy) return;
    if (missing.length) {
      setShowErrors(true);
      haptic.error();
      focusFirstInvalid();
      return;
    }
    setError(null);
    setBusy(true);
    haptic.press();
    const body = {
      serviceId: svc.id,
      link: link.trim(),
      quantity,
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())),
      dripMinutes: drip || undefined,
      payWith,
    };
    // No success haptic here: OrderPlaced fires it in time with its celebration (spec §7.8).
    try {
      if (payWith === "stars") {
        const r = await api<{ invoice: string; paymentId: number }>("/orders", { body });
        const status = await openInvoice(r.invoice);
        if (status === "paid" || status === "pending") {
          closingConfirmation(false);
          navigate(`/placed/0?payment=${r.paymentId}`, { replace: true });
        } else setBusy(false);
        return;
      }
      const r = await api<{ order: OrderView }>("/orders", { body });
      closingConfirmation(false);
      void refreshMe();
      // Hand the order over, so OrderPlaced celebrates straight away instead of loading it again.
      primePlaced(r.order);
      navigate(`/placed/${r.order.id}`, { replace: true });
    } catch (e) {
      haptic.error();
      setBusy(false);
      setError(errText(e));
      if (e instanceof ApiError && e.code === "INSUFFICIENT_FUNDS") setPayPick("stars");
    }
  };

  /** Balance too low: top up exactly what's missing, then come back to this order. */
  const addFunds = () => {
    haptic.tap();
    const ret = `/s/${svc.id}?link=${enc(link)}&qty=${quantity}`;
    // Keep what was typed in this history entry too, so Back from the top-up screen returns to a filled form.
    try {
      history.replaceState(history.state, "", "#" + ret);
    } catch {
      /* not critical */
    }
    navigate(`/topup?amount=${need}&ret=${enc(ret)}`);
  };

  // Telegram draws these labels natively: lrm() keeps "120 ⭐" in order inside Arabic.
  const main: ButtonSpec = shortOnBalance
    ? { text: t("form.addFunds", { amount: lrm(stars(need)) }), onClick: addFunds }
    : {
        text: payWith === "stars" ? t("form.payStars", { stars: num(invoiceStars) }) : t("form.pay", { amount: lrm(stars(totalStars)) }),
        onClick: submit,
        progress: busy,
        shine: true,
      };

  // ---------- view ----------
  const body = (
    <>
      {/* 1-2. Step and the service card (the card is the screen's heading) */}
      <header class="lt">
        <FlowSteps step={4} />
        <div class="card pad svc-card fade">
          <div class="head">
            <PlatformLogo slug={svc.platform} size={44} radius={12} />
            <div>
              {/* NotPanel data (Latin names, brackets, IDs): isolated so it reads correctly inside Arabic UI. */}
              <b class="t-headline" role="heading" aria-level={1}>
                <bdi>{svc.name}</bdi>
              </b>
              <span>
                <bdi>
                  {platformName(svc.platform)} · {svc.category} · ID {svc.id}
                </bdi>
              </span>
            </div>
          </div>
          <div class="chips">
            {/* One span per chip: the chip is a flex row, and loose text + <bdi> would each become a spaced item. */}
            <Chip selected>
              <span>
                <Num>{amount(svc.rate)}</Num>
                {fixed ? null : ` ${t("common.per1k")}`}
              </span>
            </Chip>
            {fixed ? null : (
              <Chip>
                <span>
                  {t("common.min")} <Num>{num(svc.min)}</Num> · {t("common.max")} <Num>{num(svc.max)}</Num>
                </span>
              </Chip>
            )}
            {svc.avgMinutes ? <Chip lead={<Icon name="clock" size={13} stroke={2.2} />}>{t("form.avgTime", { time: duration(svc.avgMinutes, units()) })}</Chip> : null}
            {svc.refill ? <Chip lead={<Icon name="refill" size={13} stroke={2.2} />}>{t("form.refill")}</Chip> : null}
          </div>
          {svc.description ? (
            <p ref={descRef} id="svc-desc" dir="auto" class={descOpen ? "desc" : "desc clamp"}>
              {svc.description}
            </p>
          ) : null}
          {svc.description && descLong ? (
            <div class="t-callout">
              <button type="button" class="textbtn inline" aria-expanded={descOpen} aria-controls="svc-desc" onClick={() => setDescOpen((o) => !o)}>
                {t(descOpen ? "common.showLess" : "common.showMore")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* 3. Link */}
      <Field
        id="lnk"
        lead="link"
        type="url"
        inputMode="url"
        dir="ltr"
        enterKeyHint="done"
        label={t("form.link")}
        placeholder={t("form.linkPh")}
        value={link}
        onInput={(v) => {
          setLink(v);
          if (error) setError(null);
        }}
        help={t("form.linkHelp")}
        error={showErrors && missing.includes("link") ? t("err.INVALID_LINK") : null}
        trailing={
          !link && canPaste ? (
            <button type="button" class="textbtn" onClick={paste}>
              {t("form.paste")}
            </button>
          ) : null
        }
      />

      {/* 4. Amount */}
      {svc.quantityMode === "free" ? (
        <Section
          labelFor="qty"
          header={t("form.amount")}
          footer={
            <>
              {t("common.min")} <Num>{num(svc.min)}</Num> · {t("common.max")} <Num>{num(svc.max)}</Num>
            </>
          }
        >
          <div class="card qty-card">
            <div class="qty">
              <button type="button" class="iconbtn lg qty-btn press" aria-label={t("form.fewer")} onClick={() => bump(-1)}>
                <Icon name="minus" size={20} stroke={2.4} />
              </button>
              <div class="qty-mid">
                <input
                  id="qty"
                  class="qty-input num-l"
                  inputMode="numeric"
                  enterKeyHint="done"
                  autoComplete="off"
                  value={editing ?? num(qty)}
                  onFocus={(e) => {
                    setEditing(String(qty));
                    revealQty(e.currentTarget);
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    const digits = el.value.replace(/\D/g, "").slice(0, 10);
                    if (el.value !== digits) el.value = digits;
                    setEditing(digits);
                    if (digits) setQtyPick(Math.min(svc.max, Number(digits)));
                  }}
                  onBlur={(e) => commitQty(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <span class="qty-unit">{lower(svc.category)}</span>
              </div>
              <button type="button" class="iconbtn lg qty-btn press" aria-label={t("form.more")} onClick={() => bump(1)}>
                <Icon name="plus" size={20} stroke={2.4} />
              </button>
            </div>
            {presets.length ? <Presets value={qty} options={presets.map((p) => [p, short(p)] as [number, string])} onChange={setQuantity} label={t("form.amount")} /> : null}
          </div>
        </Section>
      ) : fixed ? (
        <Section header={t("form.amount")}>
          <div class="card qty-card">
            <div class="qty-mid">
              <b class="num-l">{num(svc.min)}</b>
              <span class="qty-unit">{lower(svc.category)}</span>
            </div>
          </div>
          <Notice tone="info">{t("form.packageNote")}</Notice>
        </Section>
      ) : null}

      {/* 5. Extra fields from NotPanel */}
      {svc.fields.map((f) => (
        <FieldInput key={f.key} f={f} value={fields[f.key] ?? ""} error={fieldError(f)} isLines={f.key === linesKey} onChange={(v) => setFields((x) => ({ ...x, [f.key]: v }))} />
      ))}

      {/* 6. Speed (drip-feed) */}
      {speeds.length ? (
        <Section header={t("form.speed")} footer={drip ? t("form.speedOver", { time: duration(drip, units()) }) : undefined}>
          <div class="chips scroll" role="group" aria-label={t("form.speed")}>
            <Chip selected={drip === 0} onClick={() => setDrip(0)}>
              {t("form.speedFast")}
            </Chip>
            {speeds.map((m) => (
              <Chip key={m} selected={drip === m} onClick={() => setDrip(m)}>
                {duration(m, units())}
              </Chip>
            ))}
          </div>
        </Section>
      ) : null}

      {/* 7-8. Pay with, and a payment (API) error right under it */}
      <Section header={t("form.payWith")}>
        <div class="pay-opts" role="radiogroup" aria-label={t("form.payWith")}>
          <PayOption
            on={payWith === "balance"}
            onClick={() => pickPay("balance")}
            title={t("form.balance")}
            sub={enough ? <Num>{balance(me.balance)}</Num> : t("form.notEnoughShort")}
            low={!enough}
            plate="var(--lavender)"
            icon={<Icon name="wallet" size={17} />}
          />
          <PayOption
            on={payWith === "stars"}
            onClick={() => pickPay("stars")}
            title={t("form.stars")}
            sub={<Num>{stars(invoiceStars)}</Num>}
            plate="var(--cream)"
            icon={<StarIcon size={17} />}
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Section>

      {/* 9. Quick change, right where second thoughts happen */}
      <Section header={t("form.tapToChange")}>
        <div class="chips scroll">
          <QuickChip lead={<PlatformLogo slug={svc.platform} size={28} radius={14} />} label={`${t("sheet.platform")}: ${platformName(svc.platform)}`} onClick={() => setSheet("platform")}>
            {platformName(svc.platform)}
          </QuickChip>
          <QuickChip label={`${t("sheet.category")}: ${svc.category}`} onClick={() => setSheet("category")}>
            {svc.category}
          </QuickChip>
          <QuickChip label={t("sheet.service")} onClick={() => setSheet("service")}>
            {t("form.service")}
          </QuickChip>
        </div>
      </Section>

      {/* 10-11. Total, and what happens to the money */}
      <Section>
        <div class="card total">
          <div class="lbl">
            <b>{t("form.total")}</b>
            {fixed ? null : <span>{t("form.totalSub", { qty: iso(num(quantity)), rate: iso(amount(svc.rate)) })}</span>}
          </div>
          <div class="amt" aria-live="polite">
            <Num>{stars(totalStars)}</Num>
          </div>
        </div>
        <p class="note center">
          {payWith === "stars"
            ? t("form.starsNote")
            : enough
              ? t("form.balanceAfter", { amount: iso(balance(me.balance - total)) })
              : t("form.notEnough", { amount: iso(stars(need)) })}
        </p>
      </Section>
    </>
  );

  const overlay = (
    <>
      <BottomButtons main={main} secondary={{ text: t("common.cancel"), onClick: () => navigate("/", { replace: true }) }} />
      {sheet === "platform" ? (
        <PlatformSheet
          current={svc.platform}
          onClose={() => setSheet(null)}
          onPick={(p) => {
            setPickPlatform(p);
            setSheet("category");
          }}
        />
      ) : null}
      {sheet === "category" ? (
        <CategorySheet
          platform={pickPlatform ?? svc.platform}
          current={pickPlatform ? "" : svc.category}
          onClose={() => (setSheet(null), setPickPlatform(null))}
          onPick={(c) => {
            setSheet(null);
            setPickPlatform(null);
            navigate(`/p/${enc(pickPlatform ?? svc.platform)}/${enc(c)}`, { replace: true });
          }}
        />
      ) : null}
      {sheet === "service" ? (
        <ServiceSheet
          platform={svc.platform}
          category={svc.category}
          current={svc.id}
          onClose={() => setSheet(null)}
          onPick={(s) => {
            setSheet(null);
            if (s.id !== svc.id) navigate(`/s/${s.id}?link=${enc(link)}&qty=${qty}`, { replace: true });
          }}
        />
      ) : null}
    </>
  );

  return shell(body, overlay);
}

function FieldError({ id, children }: { id: string; children: ComponentChildren }) {
  return (
    <p class="field-error" id={`${id}-err`} role="alert">
      <Icon name="alert" size={15} stroke={2.2} />
      <span>{children}</span>
    </p>
  );
}

/** One extra NotPanel field: emoji reactions, a choice, a list of lines, or a text/number/link input. */
function FieldInput({ f, value, onChange, error, isLines }: { f: ServiceField; value: string; onChange: (v: string) => void; error: string | null; isLines: boolean }) {
  const id = `f-${f.key}`;
  const label = f.required ? `${f.label} *` : f.label;

  if (f.kind === "reactions" && f.allowed?.length) {
    const picked = value ? value.split(",") : [];
    const max = f.max_distinct ?? 11;
    const toggle = (e: string) => {
      if (picked.includes(e)) {
        haptic.select();
        onChange(picked.filter((x) => x !== e).join(","));
      } else if (picked.length < max) {
        haptic.select();
        onChange([...picked, e].join(","));
      } else haptic.edge();
    };
    return (
      <Section header={t("form.reactions")} footer={error ? undefined : t("form.reactionsNote", { n: max })}>
        <div id={id} class={`card emoji-grid${error ? " invalid" : ""}`} role="group" aria-label={t("form.reactions")} aria-describedby={error ? `${id}-err` : undefined}>
          {f.allowed.map((e) => (
            <button type="button" class="press" key={e} aria-pressed={picked.includes(e)} onClick={() => toggle(e)}>
              {e}
            </button>
          ))}
        </div>
        {error ? <FieldError id={id}>{error}</FieldError> : null}
      </Section>
    );
  }

  if (f.kind === "choice" && f.choices?.length) {
    return (
      <Section header={label}>
        <div id={id} class="chips" role="group" aria-label={f.label} aria-describedby={error ? `${id}-err` : undefined}>
          {f.choices.map((c) => (
            <Chip key={c} selected={value === c} onClick={() => onChange(value === c ? "" : c)}>
              {c.replace(/_/g, " ")}
            </Chip>
          ))}
        </div>
        {error ? <FieldError id={id}>{error}</FieldError> : null}
      </Section>
    );
  }

  const lines = f.kind === "lines";
  return (
    <Field
      id={id}
      label={label}
      labelEnd={lines ? t("form.lines", { n: num(countLines(value)) }) : undefined}
      value={value}
      onInput={onChange}
      multiline={lines}
      rows={5}
      required={f.required}
      maxLength={lines ? (f.max_length ? f.max_length * 10000 : undefined) : f.max_length}
      type={f.kind === "url" ? "url" : "text"}
      inputMode={f.kind === "integer" ? "numeric" : f.kind === "url" ? "url" : "text"}
      dir={f.kind === "url" ? "ltr" : undefined}
      help={isLines ? t("form.linesNote") : undefined}
      error={error}
    />
  );
}
