// Favorite services: a heart on the service card and a list on Home (spec: the user's own shortcuts).
// A heart, not a star: stars mean Telegram Stars (money) everywhere in this app.
import { useEffect } from "preact/hooks";
import type { ServiceItem } from "../../shared/types";
import { cachedApi } from "../api";
import { favStore, loadFavorites, toggleFavorite } from "../favorites";
import { t } from "../i18n";
import { Icon } from "../icons";
import { haptic } from "../tg";
import { Section, SkeletonList, toast, useAsync } from "../ui";
import { ServiceRows } from "./Services";

export function FavButton({ id }: { id: number }) {
  const favs = favStore.use();
  useEffect(() => void loadFavorites(), []);
  const on = !!favs?.includes(id);
  return (
    <button
      type="button"
      class={`fav-btn press${on ? " on" : ""}`}
      aria-pressed={on}
      aria-label={on ? t("fav.remove") : t("fav.add")}
      onClick={() => {
        const now = toggleFavorite(id);
        if (now) haptic.success();
        else haptic.tap();
        toast(now ? t("fav.added") : t("fav.removed"), now ? "ok" : "info");
      }}
    >
      <Icon name="heart" size={22} fill={on} stroke={2} />
    </button>
  );
}

/** Home: the user's favorite services, newest first; nothing at all while there are none. */
export function FavoritesSection() {
  const favs = favStore.use();
  useEffect(() => void loadFavorites(), []);
  const key = favs?.join(",") ?? "";
  const res = useAsync(() => (key ? cachedApi<ServiceItem[]>(`/catalog/favorites?ids=${key}`) : Promise.resolve([])), [key]);
  if (!favs?.length) return null;
  const items = res.data;
  if (items && !items.length) return null; // all of them are gone from the catalog
  return (
    <Section variant="title" header={t("fav.title")}>
      {items ? <ServiceRows items={items.slice(0, 5)} showPlatform /> : <SkeletonList rows={Math.min(favs.length, 3)} lead="logo" />}
    </Section>
  );
}
