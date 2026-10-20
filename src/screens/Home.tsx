// Home (`/`, tab "New order"), design spec §5.1. Also exports PlatformGrid (§5.15), used by the platform picker sheet.
import { useEffect, useState } from "preact/hooks";
import type { PlatformItem, ServiceItem } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { ApiError, api, cachedApi } from "../api";
import { refreshMe } from "../me";
import { ArtHomeHero } from "../art";
import { balance, iso, num, prettyLink, stars } from "../format";
import { getLang, t } from "../i18n";
import { Icon } from "../icons";
import { once } from "../motion";
import { enc, navigate } from "../router";
import { meStore } from "../store";
import { haptic } from "../tg";
import { brandStore } from "../theme";
import { BrandMark, Chip, EmptyState, ErrorState, List, Num, PlatformLogo, Row, Screen, SearchField, Section, SkeletonGrid, SkeletonList, useAsync } from "../ui";
import { ServiceRows } from "./Services";

/**
 * Platform tiles. `class` adds classes to the grid (e.g. "stagger fast" for the entrance); "grid5" is always kept.
 * `current` rings the platform that is already picked (picker sheet).
 */
export function PlatformGrid({ items, current, onPick, class: cls }: { items: PlatformItem[]; current?: string; onPick: (slug: string) => void; class?: string }) {
  return (
    <div class={cls ? `grid5 ${cls}` : "grid5"}>
      {items.map((p) => (
        <button
          type="button"
          class="ptile"
          key={p.slug}
          aria-current={current === p.slug ? "true" : undefined}
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

/** Last platform list per language, so coming back to Home shows the grid at once instead of a skeleton flash. */
let lastPlatforms: { lang: string; items: PlatformItem[] } | null = null;

type Found = { term: string; items: ServiceItem[] } | { term: string; error: unknown };

/** Search runs for 2+ characters, or for any all-digit query (service IDs). */
const isQuery = (term: string) => term.length >= 2 || /^\d+$/.test(term);

/** Tells the server once per app session that the user reached Home (completes a pending referral). */
let homeReported = false;

export function Home() {
  const me = meStore.use()!;
  const brand = brandStore.use();
  useEffect(() => {
    if (homeReported || !me.termsAccepted || !me.langChosen) return;
    homeReported = true;
    api("/me/home", { method: "POST", body: {} }).catch((e) => {
      // The user left the channel: bring the gate back.
      if (e instanceof ApiError && e.code === "CHANNEL_REQUIRED") void refreshMe().catch(() => {});
    });
  }, []);
  const platforms = useAsync(
    () =>
      cachedApi<PlatformItem[]>("/catalog/platforms").then((items) => {
        lastPlatforms = { lang: getLang(), items };
        return items;
      }),
    [],
  );
  const list = platforms.data ?? (lastPlatforms?.lang === getLang() ? lastPlatforms.items : undefined);

  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [retry, setRetry] = useState(0);
  const term = q.trim();
  const searching = isQuery(term);

  useEffect(() => {
    if (!searching) {
      setFound(null);
      return;
    }
    // Earlier results stay on screen while the next query loads; answers to outdated queries are dropped.
    let live = true;
    const id = setTimeout(
      () =>
        api<ServiceItem[]>(`/catalog/search?q=${enc(term)}`).then(
          (items) => live && setFound({ term, items }),
          (error) => live && setFound({ term, error }),
        ),
      250,
    );
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [term, retry]);

  // Entrances play the first time each block appears in this app launch, not on every tab switch or Back.
  const gridIn = list ? once("home-grid") : false;
  const recent = me.recent.slice(0, 3);
  const listIn = once(recent.length ? "home-recent" : "home-how");

  return (
    <Screen>
      <section class="hero-card" aria-label={t("home.title")}>
        <ArtHomeHero enter={once("hero")} />
        <span class="brand">
          <BrandMark size={26} />
          <span class="ellipsis">{brand.name}</span>
        </span>
        <span class="hi">{t("home.hi", { name: me.firstName })}</span>
        <h1>{t("home.headline")}</h1>
        <div class="actions">
          <button
            type="button"
            class="bal glass-pill press"
            aria-label={t("home.balanceAria", { amount: iso(balance(me.balance)) })}
            onClick={() => (haptic.tap(), navigate("/wallet", { replace: true }))}
          >
            <Icon name="wallet" size={17} />
            <Num>{balance(me.balance)}</Num>
          </button>
          <button type="button" class="add white-pill press" onClick={() => (haptic.tap(), navigate("/topup"))}>
            <Icon name="plus" size={16} stroke={2.6} />
            {t("wallet.add")}
          </button>
        </div>
      </section>

      <SearchField value={q} onInput={setQ} placeholder={t("home.search")} />

      {searching ? (
        !found ? (
          <Section header={t("home.results")}>
            <SkeletonList rows={3} lead="logo" />
          </Section>
        ) : "error" in found ? (
          <ErrorState error={found.error} onRetry={() => (setFound(null), setRetry((n) => n + 1))} />
        ) : found.items.length ? (
          <Section header={t("home.results")}>
            <ServiceRows items={found.items} showPlatform />
          </Section>
        ) : (
          <EmptyState art="search" title={t("home.noResults", { q: found.term })} body={t("home.noResultsSub")} />
        )
      ) : (
        <>
          <Section variant="title" header={t("home.platforms")}>
            <div class="card">
              {list ? (
                <PlatformGrid items={list} class={gridIn ? "stagger fast" : undefined} onPick={(slug) => navigate(`/p/${enc(slug)}`)} />
              ) : platforms.error ? (
                <ErrorState compact error={platforms.error} onRetry={platforms.reload} />
              ) : (
                <SkeletonGrid n={10} />
              )}
            </div>
          </Section>


          {me.referralEnabled ? (
            <List>
              <Row icon="users" plate="var(--lime)" size="lg" title={t("invite.title")} meta={t("invite.sub", { amount: iso(stars(me.referralReward)) })} onClick={() => navigate("/invite")} />
            </List>
          ) : null}

          {recent.length ? (
            <Section variant="title" header={t("home.again")} action={{ label: t("home.allOrders"), href: "/orders", onClick: () => navigate("/orders", { replace: true }) }}>
              <List stagger={listIn}>
                {recent.map((o) => (
                  <Row
                    key={o.id}
                    size="lg"
                    wrap
                    lead={<PlatformLogo slug={o.platform} size={36} radius={10} />}
                    title={
                      <>
                        <bdi>{o.serviceName}</bdi> · <Num>{num(o.quantity)}</Num>
                      </>
                    }
                    meta={
                      <bdi dir="ltr" class="ellipsis">
                        {platformName(o.platform)} · {prettyLink(o.link)}
                      </bdi>
                    }
                    control={
                      <Chip tint label={`${t("home.againBtn")}: ${o.serviceName}`} onClick={() => navigate(`/s/${o.serviceId}?link=${enc(o.link)}&qty=${o.quantity}`)}>
                        {t("home.againBtn")}
                      </Chip>
                    }
                  />
                ))}
              </List>
            </Section>
          ) : (
            <Section variant="title" header={t("home.how")}>
              <ol class={listIn ? "card how stagger" : "card how"}>
                {(["home.how1", "home.how2", "home.how3"] as const).map((k, i) => (
                  <li key={k}>
                    <span class="n">{i + 1}</span>
                    {t(k)}
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}
