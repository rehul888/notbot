import { useEffect, useState } from "preact/hooks";
import type { LedgerItem } from "../../shared/types";
import { api } from "../api";
import { ArtBalanceCard } from "../art";
import { balanceStars, underOneStar } from "../../shared/stars";
import { amount as amountText, balance as balanceText, dateTime, isoIds, stars, starsRate } from "../format";
import { t } from "../i18n";
import { Icon, StarIcon, type IconName } from "../icons";
import { useCountUp } from "../motion";
import { navigate } from "../router";
import { meStore } from "../store";
import { haptic } from "../tg";
import { EmptyState, ErrorState, LargeTitle, List, Num, Row, Screen, Section, SkeletonList, errText, toast, useAsync } from "../ui";

/** One-tap top-up amounts on the Wallet (those outside the admin's min/max are left out) */
const QUICK = [100, 250, 500, 1000];

/** Ledger page size (the API returns 30 per page). */
const PAGE = 30;

/** Balance shown on the last Wallet visit in this app launch. A credit since then counts up from it (spec §7.7). */
let lastSeenBalance: number | undefined;

/** Leading tile per ledger kind (spec §5.10). No icon = the gold Telegram Stars icon. */
const KIND: Record<LedgerItem["kind"], { icon?: IconName; plate: string }> = {
  order: { icon: "receipt", plate: "var(--lavender)" },
  refund: { icon: "refill", plate: "var(--lime)" },
  topup: { plate: "var(--cream)" },
  admin: { icon: "sliders", plate: "var(--sky)" },
  referral: { icon: "users", plate: "var(--lime)" },
  stars_refund: { icon: "star", plate: "var(--pink)" },
};

/** Cream plate with the gold Stars icon. */
function StarsTile() {
  return (
    <span class="tile cream">
      <StarIcon size={18} />
    </span>
  );
}

function ledgerTitle(i: LedgerItem): string {
  if (i.kind === "order") return isoIds(t("ledger.order", { id: i.orderNumber ?? i.ref ?? "" }));
  if (i.kind === "refund") return isoIds(t("ledger.refund", { id: i.orderNumber ?? i.ref ?? "" }));
  return t(`ledger.${i.kind}`);
}

function LedgerRow({ item }: { item: LedgerItem }) {
  const k = KIND[item.kind] ?? KIND.admin;
  const opensOrder = !!item.ref && (item.kind === "order" || item.kind === "refund");
  // The sign is always shown; green only reinforces money coming in (never colour alone).
  const amount = (
    <b class={item.delta > 0 ? "num-s ok-text" : "num-s fg-text"}>
      <Num>{amountText(item.delta, { sign: true })}</Num>
    </b>
  );
  return (
    <Row
      icon={k.icon}
      plate={k.plate}
      lead={k.icon ? undefined : <StarsTile />}
      title={ledgerTitle(item)}
      meta={dateTime(item.createdAt)}
      value={amount}
      onClick={opensOrder ? () => navigate(`/order/${item.ref}`) : undefined}
    />
  );
}

function BalanceCard({ balance: micro }: { balance: number }) {
  // Stored in micro-USD, shown as whole Stars (rounded down)
  const balance = balanceStars(micro, starsRate());
  // Less than one Star left: "<1 ⭐", not a misleading 0
  const tiny = underOneStar(micro, starsRate());
  // Count up only when the balance went up since the last visit. `from` is read once, at mount.
  const [from] = useState(() => (lastSeenBalance !== undefined && balance > lastSeenBalance ? lastSeenBalance : undefined));
  const shown = useCountUp(balance, { from, delay: 200, step: 1 });
  useEffect(() => {
    lastSeenBalance = balance;
  }, [balance]);

  return (
    <div class="balance-card">
      <ArtBalanceCard />
      <div class="lbl">
        <span>{t("wallet.balance")}</span>
        <b class="num-xl count" aria-hidden="true">
          <Num>{tiny ? balanceText(micro) : stars(shown)}</Num>
        </b>
        <span class="sr">{balanceText(micro)}</span>
      </div>
      <button type="button" class="white-pill press" onClick={() => (haptic.tap(), navigate("/topup"))}>
        <Icon name="plus" size={16} stroke={2.6} />
        {t("wallet.add")}
      </button>
    </div>
  );
}

export function Wallet() {
  const me = meStore.use()!;
  const res = useAsync(() => api<{ balance: number; items: LedgerItem[] }>("/wallet"), []);
  const [extra, setExtra] = useState<LedgerItem[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const items = [...(res.data?.items ?? []), ...extra];
  const canMore = !!res.data && items.length >= PAGE && more;

  const loadMore = async () => {
    if (busy || !items.length) return;
    setBusy(true);
    try {
      const r = await api<{ items: LedgerItem[] }>(`/wallet?before=${items[items.length - 1].id}`);
      setExtra((x) => [...x, ...r.items]);
      setMore(r.items.length === PAGE);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const balance = res.data?.balance ?? me.balance;

  return (
    <Screen>
      <LargeTitle title={t("wallet.title")} />

      <BalanceCard balance={balance} />

      <Section header={t("wallet.addWith")}>
        <div class="card pad quick-top">
          <div class="qt-head">
            <StarsTile />
            <div>
              <b>{t("wallet.stars")}</b>
              <span>{t("wallet.starsSub")}</span>
            </div>
          </div>
          <div class="qt-grid">
            {QUICK.filter((n) => n >= me.minTopup && n <= me.maxTopup).map((n) => (
              <button key={n} type="button" class="qt-amt press" onClick={() => (haptic.tap(), navigate(`/topup?amount=${n}`))}>
                <Num>{stars(n)}</Num>
              </button>
            ))}
          </div>
          <button type="button" class="btn sm soft press" onClick={() => (haptic.tap(), navigate("/topup"))}>
            {t("topup.custom")}
          </button>
        </div>
      </Section>

      <Section header={t("wallet.history")} class="day">
        {res.error ? (
          <div class="card">
            <ErrorState compact error={res.error} onRetry={res.reload} />
          </div>
        ) : !res.data ? (
          <SkeletonList rows={3} lead="tile" />
        ) : !items.length ? (
          <div class="card">
            <EmptyState compact art="wallet" title={t("wallet.empty")} body={t("wallet.emptySub")} />
          </div>
        ) : (
          <List stagger>
            {items.map((i) => (
              <LedgerRow key={i.id} item={i} />
            ))}
            {canMore ? <Row key="more" center title={busy ? t("common.loading") : t("common.showMore")} onClick={loadMore} disabled={busy} /> : null}
          </List>
        )}
      </Section>
    </Screen>
  );
}
