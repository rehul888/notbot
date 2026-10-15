import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { OrderView } from "../../shared/types";
import { ApiError, api, pollDelay } from "../api";
import { ArtOrderSuccess } from "../art";
import { amount, num } from "../format";
import { t, type Key } from "../i18n";
import { refreshMe, updateMe } from "../me";
import { Confetti, once } from "../motion";
import { navigate, useRoute } from "../router";
import { meStore } from "../store";
import { haptic, requestWriteAccess } from "../tg";
import { BottomButtons, ErrorState, LargeTitle, List, Notice, Num, Row, Screen, errText, toast } from "../ui";

// Waiting for a Stars payment (spec §5.7): back off from 1s to 5s between polls, and stop after 3 minutes.
const FAST_MS = 1500;
const SLOW_AFTER_MS = 30_000;
const STOP_AFTER_MS = 180_000;
/** Paid, but still no order after this many polls: the order couldn't be placed and the money went to the balance. */
const PAID_NO_ORDER_POLLS = 6;
/** Loading an order by id: show the spinner only if it takes longer than this, so a quick load doesn't flash. */
const SPINNER_AFTER_MS = 400;

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

/** The write-access prompt is shown at most once per app session. */
let askedWriteAccess = false;

/** An order the previous screen already has, so this screen can celebrate straight away instead of loading it. */
let handoff: OrderView | null = null;

/** Optional: call right before `navigate(`/placed/${order.id}`)` when the order is already in hand (pay from balance). */
export function primePlaced(order: OrderView) {
  handoff = order;
}

function takeHandoff(id: number): OrderView | null {
  const o = handoff && handoff.id === id ? handoff : null;
  handoff = null;
  return o;
}

/**
 * After paying. `/placed/:id` shows the order (and celebrates the first time). `/placed/0?payment=X` (Stars) waits
 * until the bot has received the payment and placed the order, then swaps to `/placed/:id`.
 */
export function OrderPlaced({ orderId }: { orderId: number }) {
  const me = meStore.use()!;
  const { query } = useRoute();
  const paymentId = orderId ? 0 : Number(query.get("payment")) || 0;

  const [order, setOrder] = useState<OrderView | null>(() => (orderId ? takeHandoff(orderId) : null));
  const [celebrate, setCelebrate] = useState(() => !!order && once(`placed:${order.id}`));
  const [error, setError] = useState<unknown>(null);
  /** Bumped to retry a failed load, or to resume payment polling. */
  const [round, setRound] = useState(0);
  const [polling, setPolling] = useState(true);
  const [slow, setSlow] = useState(false);
  const [spinner, setSpinner] = useState(false);
  /** Optimistic switch value while the notify setting is being saved. */
  const [notifyPending, setNotifyPending] = useState<boolean | null>(null);

  // Stars: wait for the payment to turn into an order. Every poll counts toward the cap, paid or not (bug 10).
  useEffect(() => {
    if (orderId) return;
    if (!paymentId) {
      navigate("/orders", { replace: true });
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paidPolls = 0;
    let n = 0;
    const started = Date.now();
    setPolling(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    const poll = async () => {
      try {
        const p = await api<{ status: string; orderId: number | null }>(`/payments/${paymentId}`);
        if (!live) return;
        if (p.orderId) {
          // Fetch the order before swapping routes, so the next screen opens on the celebration, not a loader.
          const o = await api<OrderView>(`/orders/${p.orderId}`).catch(() => null);
          if (!live) return;
          if (o) handoff = o;
          navigate(`/placed/${p.orderId}`, { replace: true });
          return;
        }
        if (p.status === "paid" && ++paidPolls > PAID_NO_ORDER_POLLS) {
          // Paid, but the order couldn't be placed: the money is in the balance (the bot explains why).
          await refreshMe().catch(() => {});
          if (live) navigate("/wallet", { replace: true });
          return;
        }
      } catch {
        /* a network blip: keep polling */
      }
      if (!live) return;
      const elapsed = Date.now() - started;
      if (elapsed >= STOP_AFTER_MS) setPolling(false);
      else timer = setTimeout(poll, pollDelay(n++));
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(slowTimer);
    };
  }, [orderId, paymentId, round]);

  // Polling stopped: check again when the user comes back to the app.
  useEffect(() => {
    if (orderId || polling) return;
    const wake = () => {
      if (document.visibilityState === "visible") setRound((n) => n + 1);
    };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [orderId, polling]);

  // `/placed/:id`: load the order unless the previous screen handed it over.
  useEffect(() => {
    if (!orderId || order) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    setError(null);
    const spin = setTimeout(() => setSpinner(true), SPINNER_AFTER_MS);
    const load = async () => {
      try {
        const o = await api<OrderView>(`/orders/${orderId}`);
        if (!live) return;
        clearTimeout(spin);
        setOrder(o);
        setCelebrate(once(`placed:${o.id}`));
      } catch (e) {
        if (!live) return;
        if (++fails >= 3 || (e instanceof ApiError && e.status === 404)) {
          clearTimeout(spin);
          setError(e);
        } else timer = setTimeout(load, FAST_MS);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(spin);
    };
  }, [orderId, round]);

  // The success haptic is part of the celebration, timed to the badge pop (spec §7.8).
  useEffect(() => {
    if (!celebrate) return;
    const h = setTimeout(() => haptic.success(), 120);
    return () => clearTimeout(h);
  }, [celebrate]);

  // Order updates are on by default, but the bot can only message users who allowed it: ask once, right after the order.
  const shown = !!order;
  useEffect(() => {
    if (!shown || askedWriteAccess || !me.notify || me.canMessage) return;
    askedWriteAccess = true;
    requestWriteAccess()
      .then((ok) => (ok ? updateMe({ canMessage: true }) : null))
      .catch(() => {});
  }, [shown]);

  const notifyOn = notifyPending ?? (me.notify && me.canMessage);
  const toggleNotify = async (on: boolean) => {
    if (notifyPending !== null) return;
    setNotifyPending(on);
    try {
      if (on && !me.canMessage) {
        const ok = await requestWriteAccess();
        if (!ok) {
          toast(t("profile.notifyDenied"));
          return;
        }
        await updateMe({ notify: true, canMessage: true });
      } else await updateMe({ notify: on });
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setNotifyPending(null);
    }
  };

  const buttons = (
    <BottomButtons
      main={{ text: t("common.done"), onClick: () => navigate("/", { replace: true }) }}
      secondary={order ? { text: t("placed.view"), onClick: () => navigate(`/order/${order.id}`, { replace: true }) } : null}
    />
  );

  // ---------- order placed ----------
  if (order) {
    return (
      <Screen
        bottom="native"
        center
        overlay={
          <>
            {celebrate ? <Confetti n={12} /> : null}
            {buttons}
          </>
        }
      >
        <div class={celebrate ? "success-art celebrate" : "success-art"}>
          <ArtOrderSuccess state="done" />
        </div>
        <div class="rise" style={at(240)} role="status">
          <LargeTitle
            align="center"
            size="title"
            title={t("placed.title")}
            sub={tn("placed.body", { quantity: <Num>{num(order.quantity)}</Num>, service: <bdi>{order.serviceName}</bdi> })}
          />
        </div>
        <dl class="card rise" style={at(340)}>
          <div class="kv">
            <dt>{t("placed.order")}</dt>
            <dd>
              <Num>#{order.number}</Num>
            </dd>
          </div>
          <div class="kv">
            <dt>{t("placed.service")}</dt>
            <dd>{order.serviceName}</dd>
          </div>
          <div class="kv">
            <dt>{t("placed.charged")}</dt>
            <dd>
              <b>{tn(order.paidWithStars ? "placed.withStars" : "placed.fromBalance", { amount: <Num>{amount(order.charge)}</Num> })}</b>
            </dd>
          </div>
        </dl>
        <div class="rise" style={at(400)}>
          <List>
            <Row icon="bell" plate="var(--pink)" wrap title={t("placed.notify")} meta={t("placed.notifySub")} toggle={{ on: notifyOn, onChange: toggleNotify }} />
          </List>
        </div>
        <p class="note rise" style={at(460)}>
          {t("placed.next")}
        </p>
      </Screen>
    );
  }

  // ---------- loading /placed/:id ----------
  if (orderId) {
    return (
      <Screen bottom="native" center overlay={buttons}>
        {error ? (
          <ErrorState error={error} onRetry={() => setRound((n) => n + 1)} />
        ) : (
          <>
            <div class="success-art" aria-hidden="true">
              {spinner ? (
                <>
                  <ArtOrderSuccess state="waiting" />
                  <span class="spinner" />
                </>
              ) : null}
            </div>
            <p class="sr" role="status">
              {t("common.loading")}
            </p>
          </>
        )}
      </Screen>
    );
  }

  // ---------- waiting for a Stars payment ----------
  return (
    <Screen bottom="native" center overlay={buttons}>
      <div class="success-art">
        <ArtOrderSuccess state="waiting" />
        {polling ? <span class="spinner" aria-hidden="true" /> : null}
      </div>
      <LargeTitle align="center" size="title" title={t("placed.waitingPayment")} sub={t("placed.waitingSub")} />
      <div role="status" aria-live="polite">
        {slow ? (
          <div class="rise">
            <Notice tone="info">{t("placed.slow")}</Notice>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}
