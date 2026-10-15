import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, pollDelay } from "../api";
import { ArtTopUpSuccess } from "../art";
import { balanceStars } from "../../shared/stars";
import { balance, num, stars, starsRate } from "../format";
import { t, type Key } from "../i18n";
import { Icon, StarIcon } from "../icons";
import { refreshMe } from "../me";
import { Confetti, reducedMotion, useCountUp } from "../motion";
import { back, navigate, useRoute } from "../router";
import { meStore } from "../store";
import { haptic, openInvoice } from "../tg";
import { BackNav, BottomButtons, LargeTitle, Num, Presets, Screen, Section, errText, toast } from "../ui";

const PRESETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
/** The "Custom" chip: clears the field for any amount within the limits */
const CUSTOM = -1;
/** Pre-selected amount when the route has no `?amount=`. */
const DEFAULT_STARS = 250;

/** Entrance delay for `.rise` (spec §7.8 timeline). */
const at = (ms: number) => `--d:${ms}ms`;

/** t() with nodes (e.g. <Num>) dropped into the sentence, so each language keeps its own word order. */
function tn(key: Key, vars: Record<string, ComponentChildren>): ComponentChildren {
  const marks: Record<string, string> = {};
  for (const k in vars) marks[k] = `\u0001${k}\u0001`;
  return t(key, marks)
    .split("\u0001")
    .map((part, i) => (i % 2 ? <Fragment key={i}>{vars[part]}</Fragment> : part));
}

/** `?amount=` prefill in whole Stars (OrderForm "Add {amount}"), else a default, kept within the top-up limits. */
function prefill(v: string | null, min: number, max: number): string {
  const n = v && /^\d{1,7}$/.test(v) ? Number(v) : DEFAULT_STARS;
  return String(Math.min(Math.max(n, min), max > 0 ? max : n));
}

/** `?ret=` in-app route to go back to after paying; anything that isn't an app path is ignored. */
function safeRet(v: string | null): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
}

type Done = { added: number; oldBalance: number; paymentId: number; confirmed: boolean };

/** Add funds with Telegram Stars. After paying, the same route shows the success view. */
export function TopUp() {
  const { query } = useRoute();
  const ret = safeRet(query.get("ret"));
  const [done, setDone] = useState<Done | null>(null);
  return (
    <>
      <BackNav to={ret ?? "/wallet"} />
      {done ? <TopUpSuccess {...done} ret={ret} /> : <TopUpForm initial={query.get("amount")} onDone={setDone} backTo={ret ?? "/wallet"} />}
    </>
  );
}

function TopUpForm({ initial, onDone, backTo }: { initial: string | null; onDone: (d: Done) => void; backTo: string }) {
  const me = meStore.use()!;
  const [text, setText] = useState(() => prefill(initial, me.minTopup, me.maxTopup));
  const [busy, setBusy] = useState(false);
  /** The amount error shows after blur or a Pay tap, never while typing. */
  const [showErr, setShowErr] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const amount = Number(text) || 0;
  const valid = Number.isInteger(amount) && amount >= me.minTopup && amount <= me.maxTopup;
  const err = showErr && !valid;
  const limits = { min: <Num>{stars(me.minTopup)}</Num>, max: <Num>{stars(me.maxTopup)}</Num> };
  const presets = PRESETS.filter((p) => p >= me.minTopup && p <= me.maxTopup);

  const pay = async () => {
    if (busy) return;
    if (!valid) {
      setShowErr(true);
      haptic.error();
      const el = input.current;
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    haptic.press();
    setBusy(true);
    const oldBalance = me.balance;
    try {
      const r = await api<{ invoice: string; stars: number; paymentId: number }>("/wallet/topup", { body: { stars: amount } });
      const status = await openInvoice(r.invoice);
      if (status === "paid") {
        // The bot credits the balance when Telegram confirms; poll briefly.
        let confirmed = false;
        for (let i = 0; i < 5; i++) {
          const p = await api<{ status: string }>(`/payments/${r.paymentId}`).catch(() => null);
          if (p?.status === "paid") {
            confirmed = true;
            break;
          }
          if (i === 1) toast(t("topup.waiting")); // only when it isn't instant
          await new Promise((res) => setTimeout(res, pollDelay(i)));
        }
        await refreshMe().catch(() => {});
        onDone({ added: amount, oldBalance, paymentId: r.paymentId, confirmed });
        return;
      }
    } catch (e) {
      toast(errText(e), "error");
    }
    setBusy(false);
  };

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const clean = el.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 7);
    if (clean !== el.value) el.value = clean; // keep rejected characters out even when the state doesn't change
    setText(clean);
    setShowErr(false);
  };

  return (
    <Screen bottom="native" overlay={<BottomButtons main={{ text: t("topup.pay", { stars: num(amount > 0 ? amount : me.minTopup) }), onClick: pay, progress: busy, shine: true }} secondary={{ text: t("common.back"), onClick: () => back(backTo) }} />}>
      <LargeTitle size="title" title={t("topup.title")} sub={tn("topup.balance", { amount: <Num>{balance(me.balance)}</Num> })} />

      <Section
        labelFor="amt"
        header={t("topup.amount")}
        footer={tn("topup.limits", limits)}
      >
        <div class={err ? "card amount-card invalid" : "card amount-card"}>
          {/* Amounts read left to right in every language: the star, then the number. */}
          <div class="row1" dir="ltr">
            <span class="stars-eq" aria-hidden="true">
              <StarIcon size={26} />
            </span>
            <input
              ref={input}
              id="amt"
              class="num-l"
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="done"
              dir="ltr"
              autoComplete="off"
              placeholder={num(me.minTopup)}
              aria-label={t("topup.amount")}
              value={text}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? "amt-err" : undefined}
              onInput={onInput}
              onBlur={() => setShowErr(!!text && !valid)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </div>
          <Presets
            value={presets.includes(amount) ? amount : CUSTOM}
            options={[...presets.map((p): [number, string] => [p, stars(p)]), [CUSTOM, t("topup.custom")]]}
            label={t("topup.amount")}
            onChange={(v) => {
              setShowErr(false);
              if (v === CUSTOM) {
                setText("");
                input.current?.focus();
              } else setText(String(v));
            }}
          />
        </div>
        {err ? (
          <p class="field-error" id="amt-err" role="alert">
            <Icon name="alert" size={15} stroke={2.2} />
            <span>{tn("err.INVALID_AMOUNT", limits)}</span>
          </p>
        ) : null}
      </Section>

      <div class="card info">
        <span class="tile cream">
          <StarIcon size={18} />
        </span>
        <span>{t("topup.note")}</span>
      </div>
    </Screen>
  );
}

function TopUpSuccess({ added, oldBalance, paymentId, confirmed, ret }: Done & { ret: string | null }) {
  const me = meStore.use()!;
  // Count from the balance before paying to the new one (once, at mount); follows a late credit too. Whole Stars.
  const now = balanceStars(me.balance, starsRate());
  const shown = useCountUp(now, { from: balanceStars(oldBalance, starsRate()), duration: 900, delay: 300 });

  useEffect(() => {
    window.scrollTo(0, 0);
    // The success haptic lands with the coin (spec §7.8).
    const h = setTimeout(() => haptic.success(), 480);
    return () => clearTimeout(h);
  }, []);

  // Telegram said "paid" but the bot hadn't credited the balance yet: keep checking quietly for up to 3 minutes.
  useEffect(() => {
    if (confirmed) return;
    let live = true;
    let tries = 0;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const p = await api<{ status: string }>(`/payments/${paymentId}`).catch(() => null);
      if (!live) return;
      if (p?.status === "paid") await refreshMe().catch(() => {});
      else if (Date.now() - started < 180_000) timer = setTimeout(check, pollDelay(tries++));
    };
    timer = setTimeout(check, pollDelay(tries++));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  // OrderForm already wrote `ret` into its own history entry before opening Top up, so going back lands on the
  // filled form (replacing would leave two identical entries and a Back press that does nothing). Cold start: replace.
  const main = ret
    ? { text: t("topup.backToOrder"), onClick: () => back(ret) }
    : { text: t("common.done"), onClick: () => navigate("/wallet", { replace: true }) };

  return (
    <Screen
      bottom="native"
      center
      overlay={
        <>
          <Confetti n={10} delay={520} />
          <BottomButtons main={main} />
        </>
      }
    >
      <div class="success-art celebrate">
        <ArtTopUpSuccess />
      </div>
      <div class="rise" style={at(240)} role="status">
        <LargeTitle align="center" size="title" title={t("topup.successTitle")} sub={tn("topup.done", { amount: <Num>{stars(added, { sign: true })}</Num> })} />
      </div>
      <div class="card pad new-balance rise" style={at(340)}>
        <span>{t("topup.newBalance")}</span>
        <b class="num-xl count" dir="ltr" aria-hidden="true">
          {stars(shown)}
        </b>
        <span class="sr">{stars(now)}</span>
      </div>
    </Screen>
  );
}
