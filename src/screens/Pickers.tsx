// Bottom sheets to switch platform / category / service without leaving the screen ("thumb first"), spec §5.6.
// APIs are frozen (§5.15): Categories, Services and OrderForm use them.
import { useLayoutEffect } from "preact/hooks";
import type { CategoryItem, PlatformItem, ServiceItem } from "../../shared/types";
import { platformName } from "../../shared/platforms";
import { cachedApi } from "../api";
import { amount, num, short } from "../format";
import { t } from "../i18n";
import { categoryLook } from "../icons";
import { enc } from "../router";
import { EmptyState, ErrorState, List, Row, Sheet, SkeletonGrid, SkeletonList, useAsync } from "../ui";
import { PlatformGrid } from "./Home";

/** Rows after this index all animate together, so a list scrolled to its checked row would sit blank; skip the stagger then. */
const STAGGER_MAX = 6;

/** Once a picker list is shown, scroll the sheet so the current choice is visible (before paint, no jump). */
function useRevealChecked(ready: unknown) {
  useLayoutEffect(() => {
    if (!ready) return;
    const row = document.querySelector<HTMLElement>('.sheet .scroll [role="radio"][aria-checked="true"]');
    const box = row?.closest<HTMLElement>(".scroll");
    if (!row || !box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.bottom > b.bottom || r.top < b.top) box.scrollTop += r.top - b.top - (b.height - r.height) / 2;
  }, [ready]);
}

export function PlatformSheet({ current, sub, onPick, onClose }: { current: string; sub?: string; onPick: (slug: string) => void; onClose: () => void }) {
  const list = useAsync(() => cachedApi<PlatformItem[]>("/catalog/platforms"), []);
  return (
    <Sheet title={t("sheet.platform")} sub={sub ?? t("sheet.platformSub")} onClose={onClose}>
      {list.error ? (
        <ErrorState compact error={list.error} onRetry={list.reload} />
      ) : (
        <div class="card">{list.data ? <PlatformGrid items={list.data} current={current} onPick={onPick} class="stagger fast" /> : <SkeletonGrid />}</div>
      )}
    </Sheet>
  );
}

export function CategorySheet({ platform, current, onPick, onClose }: { platform: string; current: string; onPick: (c: string) => void; onClose: () => void }) {
  const list = useAsync(() => cachedApi<CategoryItem[]>(`/catalog/categories?platform=${enc(platform)}`), [platform]);
  const items = list.data;
  useRevealChecked(items);
  const at = items ? items.findIndex((c) => c.name === current) : -1;
  return (
    <Sheet title={t("sheet.category")} sub={platformName(platform)} onClose={onClose}>
      {list.error ? (
        <ErrorState compact error={list.error} onRetry={list.reload} />
      ) : !items ? (
        <SkeletonList rows={5} lead="tile" />
      ) : !items.length ? (
        <EmptyState compact art="search" title={t("svc.empty")} />
      ) : (
        <List role="radiogroup" label={t("sheet.category")} stagger={at < STAGGER_MAX}>
          {items.map((c) => {
            const look = categoryLook(c.name);
            return <Row key={c.name} radio wrap checked={c.name === current} icon={look.icon} plate={look.plate} title={c.name} meta={t("cat.services", { n: num(c.count) })} onClick={() => onPick(c.name)} />;
          })}
        </List>
      )}
    </Sheet>
  );
}

export function ServiceSheet({ platform, category, current, onPick, onClose }: { platform: string; category: string; current: number; onPick: (s: ServiceItem) => void; onClose: () => void }) {
  const list = useAsync(() => cachedApi<{ items: ServiceItem[] }>(`/catalog/services?platform=${enc(platform)}&category=${enc(category)}`), [platform, category]);
  const items = list.data?.items;
  useRevealChecked(items);
  const at = items ? items.findIndex((s) => s.id === current) : -1;
  return (
    <Sheet title={t("sheet.service")} sub={`${platformName(platform)} · ${category}`} size="large" onClose={onClose}>
      {list.error ? (
        <ErrorState compact error={list.error} onRetry={list.reload} />
      ) : !items ? (
        <SkeletonList rows={6} lead="none" />
      ) : !items.length ? (
        <EmptyState compact art="search" title={t("svc.empty")} />
      ) : (
        <List role="radiogroup" label={t("sheet.service")} stagger={at < STAGGER_MAX}>
          {items.map((s) => (
            <Row
              key={s.id}
              radio
              wrap
              checked={s.id === current}
              title={s.name}
              meta={`${t("common.min")} ${short(s.min)} · ${t("common.max")} ${short(s.max)}`}
              value={<span class="num-s acc">{amount(s.rate)}</span>}
              onClick={() => onPick(s)}
            />
          ))}
        </List>
      )}
    </Sheet>
  );
}
