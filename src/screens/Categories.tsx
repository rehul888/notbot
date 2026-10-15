// Order flow step 2 of 4: pick a category on one platform (design spec §5.4).
import { useState } from "preact/hooks";
import type { CategoryItem } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { cachedApi } from "../api";
import { amount } from "../format";
import { t } from "../i18n";
import { categoryLook, Icon } from "../icons";
import { back, enc, navigate } from "../router";
import { haptic } from "../tg";
import { BackNav, EmptyState, ErrorState, FlowSteps, LargeTitle, List, Num, PlatformLogo, Row, Screen, SkeletonList, StepsBar, useAsync } from "../ui";
import { PlatformSheet } from "./Pickers";

/** "from 10 ⭐", with the price kept left-to-right inside the translated phrase (Arabic). */
function fromPrice(rate: number) {
  const [before, after = ""] = t("cat.from", { price: "\u0000" }).split("\u0000");
  return (
    <>
      {before}
      <Num>{amount(rate)}</Num>
      {after}
    </>
  );
}

export function Categories({ platform }: { platform: string }) {
  const cats = useAsync(() => cachedApi<CategoryItem[]>(`/catalog/categories?platform=${enc(platform)}`), [platform]);
  const [sheet, setSheet] = useState(false);
  const name = platformName(platform);

  let content;
  if (cats.data) {
    content = cats.data.length ? (
      <List stagger>
        {cats.data.map((c) => {
          const look = categoryLook(c.name);
          return (
            <Row
              key={c.name}
              size="lg"
              icon={look.icon}
              plate={look.plate}
              title={c.name}
              meta={
                <>
                  {t("cat.services", { n: c.count })} · {fromPrice(c.fromRate)}
                </>
              }
              href={`/p/${enc(platform)}/${enc(c.name)}`}
            />
          );
        })}
      </List>
    ) : (
      <EmptyState art="search" title={t("svc.empty")} action={{ label: t("cat.emptyAction"), onClick: () => setSheet(true) }} />
    );
  } else if (cats.error) {
    content = <ErrorState error={cats.error} onRetry={cats.reload} />;
  } else {
    content = <SkeletonList rows={6} lead="tile" />;
  }

  const overlay = (
    <>
      <StepsBar>
        <button type="button" class="round press" aria-label={t("common.back")} onClick={() => (haptic.tap(), back("/"))}>
          <Icon name="back" size={22} stroke={2.4} class="rtl-flip" />
        </button>
        <button
          type="button"
          class="pick press"
          aria-haspopup="dialog"
          aria-label={`${t("sheet.platform")}: ${name}`}
          onClick={() => {
            haptic.tap();
            setSheet(true);
          }}
        >
          <span class="circle" aria-hidden="true">
            <PlatformLogo slug={platform} size={36} radius={18} />
          </span>
          <span class="ellipsis">{name}</span>
          <span class="chg">{t("common.change")}</span>
          <Icon name="down" size={14} stroke={2.4} />
        </button>
      </StepsBar>
      {sheet ? (
        <PlatformSheet
          current={platform}
          sub={t("cat.choose")}
          onClose={() => setSheet(false)}
          onPick={(slug) => {
            setSheet(false);
            if (slug !== platform) navigate(`/p/${enc(slug)}`, { replace: true });
          }}
        />
      ) : null}
    </>
  );

  return (
    <>
      <BackNav to="/" />
      <Screen bottom="bar" overlay={overlay}>
        <LargeTitle size="title" eyebrow={<FlowSteps step={2} />} lead={<PlatformLogo slug={platform} size={52} radius={15} />} title={name} sub={t("cat.choose")} />
        {content}
      </Screen>
    </>
  );
}
