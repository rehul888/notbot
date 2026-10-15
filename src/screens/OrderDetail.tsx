import { useEffect, useState } from "preact/hooks";
import { FINAL_STATUSES, type OrderView } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { api } from "../api";
import { amount, dateTime, isoIds, lrm, num } from "../format";
import { t, type Key } from "../i18n";
import { Icon } from "../icons";
import { refreshMe } from "../me";
import { useCountUp } from "../motion";
import { back, enc, navigate } from "../router";
import { meStore } from "../store";
import { confirmDialog, haptic, openLink, openTelegramLink } from "../tg";
import {
  BackNav,
  BottomButtons,
  ErrorState,
  LargeTitle,
  LinkText,
  List,
  Notice,
  Num,
  PlatformLogo,
  Progress,
  Row,
  Screen,
  Section,
  Skeleton,
  SkeletonList,
  StatusPill,
  errText,
  toast,
  useAsync,
} from "../ui";
import { cachedOrder } from "./Orders";

const KNOWN_REASONS = ["partially_delivered", "link_invalid", "link_busy", "service_unavailable"];

const delivered = (o: OrderView) => (o.remains !== null ? Math.max(0, o.quantity - o.remains) : o.status === "completed" ? o.quantity : 0);
/** Not started yet and nothing delivered: the status card shows no "0 of N", so Details lists the amount instead. */
const notStarted = (o: OrderView) => (o.status === "pending" || o.status === "submitting") && delivered(o) === 0;

/** Copies text; falls back to a hidden textarea where the Clipboard API is missing or blocked (older WebViews). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "sr";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

/**
 * How far along the order is: a big delivered count (counts up on first view and after each refresh), progress,
 * start count and what's left, then one plain sentence about what is happening.
 */
function StatusCard({ o }: { o: OrderView }) {
  const done = delivered(o);
  const shown = useCountUp(done, { from: 0, duration: 900, delay: 150 });
  const waiting = o.status === "pending" || o.status === "submitting";
  const running = o.status === "processing" || o.status === "in_progress";
  const ended = o.status === "partial" || o.status === "cancelled" || o.status === "failed";
  const ofTotal = t("detail.delivered", { total: num(o.quantity) });
  // "N left to deliver" only while it still can be; a finished order's remainder was refunded instead.
  const left = o.remains && !FINAL_STATUSES.includes(o.status) ? t("detail.left", { n: num(o.remains) }) : null;
  const foot = [o.startCount ?  t("detail.startedAt", { n: num(o.startCount) }) : null, left].filter(Boolean).join(" · ");
  const reason = o.reasonCode
    ? t((KNOWN_REASONS.includes(o.reasonCode) ? `reason.${o.reasonCode}` : "reason.generic") as Key)
    : o.refund > 0
      ? t("reason.generic")
      : null;

  // Not started and nothing delivered: no "0 of N"; the status and one line say it all.
  if (notStarted(o))
    return (
      <div class="card pad status-card">
        <div class="head">
          <StatusPill status={o.status} />
        </div>
        <p class="ex">{t("detail.ex.pending")}</p>
      </div>
    );

  return (
    <div class="card pad status-card">
      <div class="head">
        <b class="num-l count" aria-hidden="true">
          {num(shown)}
        </b>
        <span class="sr">{num(done)}</span>
        <span>{ofTotal}</span>
        <StatusPill status={o.status} />
      </div>
      <Progress size="lg" value={done} max={o.quantity} label={`${num(done)} ${ofTotal}`} />
      {foot && !(ended && done === 0) ? <span class="t-footnote hint">{foot}</span> : null}
      {ended ? (
        reason ? (
          <Notice tone="warn">{reason}</Notice>
        ) : null
      ) : (
        <p class="ex">{t(waiting ? "detail.ex.pending" : running ? "detail.ex.running" : "detail.ex.done")}</p>
      )}
    </div>
  );
}

export function OrderDetail({ orderId }: { orderId: number }) {
  const me = meStore.use()!;
  const res = useAsync(() => api<OrderView>(`/orders/${orderId}`), [orderId]);
  const [busy, setBusy] = useState(false);
  // Coming from the Orders list, draw the order straight away while the fresh copy loads.
  const o = res.data ?? (res.error ? undefined : cachedOrder(orderId));

  // Keep an open order fresh while it's on screen
  useEffect(() => {
    if (!o || FINAL_STATUSES.includes(o.status)) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started >= 600_000) return clearInterval(id); // stop after 10 minutes on screen
      if (document.hidden) return;
      api<OrderView>(`/orders/${orderId}`).then(res.set, () => undefined);
    }, 30000);
    return () => clearInterval(id);
  }, [o?.status]);

  let body;
  if (res.error && !res.data) body = <ErrorState error={res.error} onRetry={res.reload} />;
  else if (!o)
    body = (
      <>
        <Skeleton h={56} radius={16} />
        <Skeleton h={136} radius={20} />
        <SkeletonList rows={4} lead="none" />
      </>
    );
  else {
    const cancel = async () => {
      haptic.warn();
      // Native popup: a left-to-right mark keeps "#123" in order in Arabic (isolates may not be supported there).
      const ok = await confirmDialog(t("detail.cancelConfirm", { id: o.number }).replace(/#\d+/g, lrm), t("detail.cancelYes"), t("detail.cancelNo"), true);
      if (!ok) return;
      setBusy(true);
      try {
        const updated = await api<OrderView>(`/orders/${o.id}/cancel`, { method: "POST" });
        res.set(updated);
        if (updated.status === "cancelled") {
          haptic.success();
          void refreshMe();
        } else toast(t("detail.cancelRequested"), "ok");
      } catch (e) {
        toast(errText(e), "error");
      }
      setBusy(false);
    };

    const refill = async () => {
      setBusy(true);
      try {
        res.set(await api<OrderView>(`/orders/${o.id}/refill`, { method: "POST" }));
        toast(t("detail.refillPending"), "ok");
      } catch (e) {
        toast(errText(e), "error");
      }
      setBusy(false);
    };

    const copy = async () => {
      if (await copyText(o.link)) toast(t("common.copied"), "ok");
    };

    const open = () => {
      haptic.tap();
      openLink(o.link.startsWith("http") ? o.link : `https://${o.link}`);
    };

    const supportUser = me.supportUsername || me.botUsername;

    body = (
      <>
        <LargeTitle
          size="title2"
          lead={<PlatformLogo slug={o.platform} size={56} radius={16} />}
          title={o.serviceName}
          sub={
            <>
              {isoIds(t("detail.title", { id: o.number }))} · {platformName(o.platform)}
            </>
          }
        />

        <StatusCard o={o} />

        <Section header={t("detail.details")}>
          <dl class="card stagger">
            <div class="kv">
              <dt>{t("detail.link")}</dt>
              <dd class="acts">
                <button type="button" class="textbtn link-btn" onClick={open}>
                  <LinkText href={o.link} />
                </button>
                <button type="button" class="iconbtn lg plain" aria-label={t("detail.copy")} onClick={copy}>
                  <Icon name="copy" size={18} />
                </button>
              </dd>
            </div>
            {notStarted(o) ? (
              <div class="kv">
                <dt>{t("form.amount")}</dt>
                <dd>
                  <Num>{num(o.quantity)}</Num>
                </dd>
              </div>
            ) : null}
            <div class="kv">
              <dt>{t("detail.charged")}</dt>
              <dd>
                <Num>{amount(o.charge)}</Num>
                {o.paidWithStars ? ` · ${t("detail.paidStars")}` : ""}
              </dd>
            </div>
            {o.refund ? (
              <div class="kv">
                <dt>{t("detail.refund")}</dt>
                <dd>
                  <b class="ok-text">
                    <Num>{amount(o.refund, { sign: true })}</Num>
                  </b>
                </dd>
              </div>
            ) : null}
            <div class="kv">
              <dt>{t("detail.placed")}</dt>
              <dd>{dateTime(o.createdAt)}</dd>
            </div>
          </dl>
        </Section>

        {o.canRefill || o.refillStatus || supportUser ? (
          <List stagger>
            {o.canRefill ? <Row icon="refill" plate="var(--lime)" title={t("detail.refill")} onClick={refill} disabled={busy} chevron={false} /> : null}
            {o.refillStatus ? (
              <Row
                icon="refill"
                plate="var(--lime)"
                title={t(o.refillStatus === "completed" ? "detail.refillDone" : o.refillStatus === "rejected" ? "detail.refillRejected" : "detail.refillPending")}
              />
            ) : null}
            {supportUser ? <Row icon="chat" plate="var(--sky)" title={t("detail.support")} accent external onClick={() => openTelegramLink(`https://t.me/${supportUser}`)} /> : null}
          </List>
        ) : null}

        {o.canCancel ? (
          <List>
            <Row icon="cancel" plate="var(--pink)" title={t("detail.cancel")} danger onClick={cancel} disabled={busy} />
          </List>
        ) : null}
      </>
    );
  }

  return (
    <>
      <BackNav to="/orders" />
      <Screen
        bottom={!o && res.error ? "none" : "native"}
        overlay={o ? <BottomButtons main={{ text: t("detail.again"), onClick: () => navigate(`/s/${o.serviceId}?link=${enc(o.link)}&qty=${o.quantity}`) }} secondary={{ text: t("common.back"), onClick: () => back("/orders") }} /> : null}
      >
        {body}
      </Screen>
    </>
  );
}
