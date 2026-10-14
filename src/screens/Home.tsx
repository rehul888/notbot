import { useEffect, useState } from "preact/hooks";
import type { PlatformItem, ServiceItem } from "../../shared/types";
import { api, cachedApi } from "../api";
import { money, num, prettyLink } from "../format";
import { t } from "../i18n";
import { Icon } from "../icons";
import { enc, navigate } from "../router";
import { meStore } from "../store";
import { haptic } from "../tg";
import { ErrorState, PlatformLogo, Skeleton, useAsync } from "../ui";
import { platformName } from "../../shared/platforms";
import { ServiceRows } from "./Services";

export function PlatformGrid({ items, current, onPick }: { items: PlatformItem[]; current?: string; onPick: (slug: string) => void }) {
  return (
    <div class="grid5">
      {items.map((p) => (
        <button
          type="button"
          class="ptile"
          key={p.slug}
          onClick={() => {
            haptic.tap();
            onPick(p.slug);
          }}
        >
          <PlatformLogo slug={p.slug} size={48} radius={14} on={current === p.slug} />
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

export function Home() {
  const me = meStore.use()!;
  const platforms = useAsync(() => cachedApi<PlatformItem[]>("/catalog/platforms"), []);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ServiceItem[] | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 && !/^\d+$/.test(term)) {
      setResults(null);
      return;
    }
    const id = setTimeout(() => api<ServiceItem[]>(`/catalog/search?q=${enc(term)}`).then(setResults, () => setResults([])), 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div class="screen" style="padding-top:12px">
      <section class="hero-card" aria-label={t("home.title")}>
        <span class="disc" aria-hidden="true" />
        <span class="ring" aria-hidden="true" />
        <span class="sticker" aria-hidden="true" style="right:74px;top:20px;transform:rotate(-10deg)">
          <img src="/platforms/telegram.svg" alt="" />
        </span>
        <span class="sticker" aria-hidden="true" style="right:16px;top:50px;transform:rotate(9deg)">
          <img src="/platforms/instagram.svg" alt="" />
        </span>
        <span class="sticker" aria-hidden="true" style="right:72px;top:100px;transform:rotate(-6deg)">
          <img src="/platforms/tiktok.svg" alt="" />
        </span>
        <span class="sticker" aria-hidden="true" style="right:20px;top:112px;width:30px;height:30px;border-radius:10px;background:var(--lime);transform:rotate(12deg);color:var(--brand)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10-7.5 10z" /></svg>
        </span>
        <span class="sticker" aria-hidden="true" style="right:122px;top:16px;width:28px;height:28px;border-radius:9px;background:var(--pink);transform:rotate(-12deg);color:var(--ink)">
          <Icon name="star" size={14} stroke={2} />
        </span>
        <span class="brand">
          <img src="/brand/mark.svg" alt="" width={26} height={26} style="border-radius:99px;box-shadow:0 0 0 2px rgba(255,255,255,.35)" />
          notpanel
        </span>
        <span class="hi">{t("home.hi", { name: me.firstName })}</span>
        <h1>{t("home.headline")}</h1>
        <div class="actions">
          <button type="button" class="bal" aria-label={t("home.balanceAria", { amount: money(me.balance) })} onClick={() => (haptic.tap(), navigate("/wallet", { replace: true }))}>
            <Icon name="wallet" size={17} />
            {money(me.balance)}
          </button>
          <button type="button" class="add" onClick={() => (haptic.tap(), navigate("/topup"))}>
            <Icon name="plus" size={16} stroke={2.6} />
            {t("wallet.add")}
          </button>
        </div>
      </section>

      <label class="search">
        <Icon name="search" size={18} stroke={2} />
        <span class="sr">{t("home.search")}</span>
        <input type="search" placeholder={t("home.search")} value={q} onInput={(e) => setQ(e.currentTarget.value)} enterKeyHint="search" />
      </label>

      {results ? (
        <div class="section">
          <h2 class="label">{t("home.results")}</h2>
          {results.length ? <ServiceRows items={results} showPlatform /> : <div class="empty">{t("home.noResults", { q: q.trim() })}</div>}
        </div>
      ) : (
        <>
          <div class="section">
            <h2 class="label">{t("home.platforms")}</h2>
            <div class="card">
              {platforms.error ? (
                <ErrorState error={platforms.error} onRetry={platforms.reload} />
              ) : platforms.data ? (
                <PlatformGrid items={platforms.data} onPick={(slug) => navigate(`/p/${enc(slug)}`)} />
              ) : (
                <div style="padding:14px"><Skeleton h={150} /></div>
              )}
            </div>
          </div>

          {me.recent.length ? (
            <div class="section">
              <h2 class="label">
                {t("home.again")}
                <a href="#/orders" onClick={(e) => (e.preventDefault(), navigate("/orders", { replace: true }))}>
                  {t("home.allOrders")}
                </a>
              </h2>
              <div class="card">
                {me.recent.map((o) => (
                  <div class="row" key={o.id} style="min-height:58px">
                    <PlatformLogo slug={o.platform} size={34} radius={10} />
                    <span class="body">
                      <span class="grow">
                        <span class="t15 ellipsis">
                          {o.serviceName} · {num(o.quantity)}
                        </span>
                        <span class="meta ellipsis">
                          {platformName(o.platform)} · {prettyLink(o.link)}
                        </span>
                      </span>
                      <button
                        type="button"
                        class="chip sel"
                        style="height:30px;padding:0 12px;font-size:14px;border:0"
                        onClick={() => {
                          haptic.tap();
                          navigate(`/s/${o.serviceId}?link=${enc(o.link)}&qty=${o.quantity}`);
                        }}
                      >
                        {t("home.againBtn")}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
