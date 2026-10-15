// Order flow step 3 of 4: pick a service in one category (design spec §5.5). `ServiceRows` is also used by Home search.
import { useState } from "preact/hooks";
import type { ServiceItem } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { cachedApi } from "../api";
import { amount, duration, short } from "../format";
import { t, type Key } from "../i18n";
import { categoryLook, Icon } from "../icons";
import { back, enc, navigate } from "../router";
import { haptic } from "../tg";
import { BackNav, EmptyState, errText, ErrorState, FlowSteps, LargeTitle, List, Notice, Num, PlatformLogo, Row, Screen, Section, SkeletonList, StepsBar, toast, useAsync } from "../ui";
import { CategorySheet, PlatformSheet } from "./Pickers";

type Page = { items: ServiceItem[]; more: boolean };

const units = () => ({ m: t("units.m"), h: t("units.h"), d: t("units.d") });

/**
 * t() with every placeholder value isolated left-to-right (<Num>). Without it, Arabic shows "Max 100K · ~8 min" with
 * the max and the time swapped, because "100K" pulls the following number into one left-to-right run.
 */
function tNums(key: Key, vars: Record<string, string | number>) {
  const names = Object.keys(vars);
  const marked = t(key, Object.fromEntries(names.map((k, i) => [k, `\u0000${i}\u0000`])));
  return marked.split("\u0000").map((part, i) => (i % 2 ? <Num key={i}>{vars[names[Number(part)]]}</Num> : part));
}

function ServiceMeta({ s, showPlatform }: { s: ServiceItem; showPlatform?: boolean }) {
  return (
    <>
      {showPlatform ? `${platformName(s.platform)} · ${s.category} · ` : null}
      {tNums("svc.meta", { id: s.id, min: short(s.min), max: short(s.max) })}
      {/* No-break space keeps "~8 min" together when the line wraps. */}
      {s.avgMinutes ? ` · ~${duration(s.avgMinutes, units()).replace(/ /g, " ")}` : null}
      {s.refill ? ` · ${t("form.refill")}` : null}
    </>
  );
}

/** One service: name (2 lines), plain facts, and the price per 1K on the end side. The price column is the affordance. */
function ServiceRow({ s, showPlatform }: { s: ServiceItem; showPlatform?: boolean }) {
  return (
    <Row
      class="svc"
      wrap
      chevron={false}
      lead={showPlatform ? <PlatformLogo slug={s.platform} size={36} radius={10} /> : undefined}
      title={s.name}
      meta={<ServiceMeta s={s} showPlatform={showPlatform} />}
      href={`/s/${s.id}`}
    >
      <span class="price">
        <b class="num-s">
          <Num>{amount(s.rate)}</Num>
        </b>
        <span>{t("common.per1k")}</span>
      </span>
    </Row>
  );
}

export function ServiceRows({ items, showPlatform }: { items: ServiceItem[]; showPlatform?: boolean }) {
  return (
    <List stagger>
      {items.map((s) => (
        <ServiceRow key={s.id} s={s} showPlatform={showPlatform} />
      ))}
    </List>
  );
}

export function Services({ platform, category }: { platform: string; category: string }) {
  const base = `/catalog/services?platform=${enc(platform)}&category=${enc(category)}`;
  const first = useAsync(() => cachedApi<Page>(base), [platform, category]);
  /** Pages loaded with "Show more" (page 1, 2, …), appended after the first page. */
  const [extra, setExtra] = useState<{ items: ServiceItem[]; more: boolean; page: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<"platform" | "category" | null>(null);
  const [pendingPlatform, setPendingPlatform] = useState<string | null>(null);
  const pName = platformName(platform);
  const look = categoryLook(category);

  const items = first.data ? (extra ? first.data.items.concat(extra.items) : first.data.items) : [];
  const more = extra ? extra.more : !!first.data?.more;

  const loadMore = async () => {
    if (busy) return;
    const page = (extra?.page ?? 0) + 1;
    setBusy(true);
    try {
      const r = await cachedApi<Page>(`${base}&page=${page}`);
      setExtra((e) => ({ items: [...(e?.items ?? []), ...r.items], more: r.more, page }));
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const open = (s: "platform" | "category") => {
    haptic.tap();
    setSheet(s);
  };

  let content;
  if (first.error) {
    content = <ErrorState error={first.error} onRetry={first.reload} />;
  } else if (first.data && !items.length) {
    content = <EmptyState art="search" title={t("svc.empty")} action={{ label: t("svc.emptyAction"), onClick: () => setSheet("category") }} />;
  } else {
    content = (
      <Section>
        <Notice tone="plain" icon="info">
          {t("svc.footnote")}
        </Notice>
        {first.data ? (
          <List stagger>
            {items.map((s) => (
              <ServiceRow key={s.id} s={s} />
            ))}
            {more ? <Row key="more" center title={busy ? t("common.loading") : t("common.showMore")} disabled={busy} onClick={loadMore} /> : null}
          </List>
        ) : (
          <SkeletonList rows={5} lead="none" />
        )}
      </Section>
    );
  }

  const overlay = (
    <>
      <StepsBar>
        <button type="button" class="round press" aria-label={t("common.back")} onClick={() => (haptic.tap(), back(`/p/${enc(platform)}`))}>
          <Icon name="back" size={22} stroke={2.4} class="rtl-flip" />
        </button>
        <button type="button" class="pick plain press" aria-haspopup="dialog" aria-label={`${t("sheet.platform")}: ${pName}`} onClick={() => open("platform")}>
          <span class="circle" aria-hidden="true">
            <PlatformLogo slug={platform} size={36} radius={18} />
          </span>
          <Icon name="down" size={14} stroke={2.4} />
        </button>
        <button type="button" class="pick press" aria-haspopup="dialog" aria-label={`${t("sheet.category")}: ${category}`} onClick={() => open("category")}>
          <span class="circle tile" aria-hidden="true">
            <Icon name={look.icon} size={18} stroke={1.8} />
          </span>
          <span class="ellipsis">{category}</span>
          <span class="chg">{t("common.change")}</span>
          <Icon name="down" size={14} stroke={2.4} />
        </button>
      </StepsBar>
      {sheet === "platform" ? (
        <PlatformSheet
          current={platform}
          onClose={() => setSheet(null)}
          onPick={(slug) => {
            // Chain: a new platform needs a category next.
            setPendingPlatform(slug);
            setSheet("category");
          }}
        />
      ) : null}
      {sheet === "category" ? (
        <CategorySheet
          platform={pendingPlatform ?? platform}
          current={pendingPlatform && pendingPlatform !== platform ? "" : category}
          onClose={() => {
            setSheet(null);
            setPendingPlatform(null);
          }}
          onPick={(c) => {
            const p = pendingPlatform ?? platform;
            setSheet(null);
            setPendingPlatform(null);
            if (p !== platform || c !== category) navigate(`/p/${enc(p)}/${enc(c)}`, { replace: true });
          }}
        />
      ) : null}
    </>
  );

  return (
    <>
      <BackNav to={`/p/${enc(platform)}`} />
      <Screen bottom="bar" overlay={overlay}>
        <LargeTitle size="title" eyebrow={<FlowSteps step={3} />} title={category} sub={t("svc.choose", { platform: pName })} />
        {content}
      </Screen>
    </>
  );
}
