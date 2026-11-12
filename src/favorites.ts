// The user's favorite services: just their IDs, kept in Telegram's per-user cloud storage (no server writes).
// Services that are later hidden or removed simply drop out of the list the server returns.
import { createStore } from "./store";
import { cloud } from "./tg";

const KEY = "favs";
const MAX = 60;

/** null until loaded */
export const favStore = createStore<number[] | null>(null);

let loading: Promise<void> | null = null;

/** Loads the list once per app launch */
export function loadFavorites(): Promise<void> {
  loading ??= cloud.get(KEY).then((v) => {
    const ids = v
      .split(",")
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    // A toggle made while loading wins over what was stored
    if (favStore.get() === null) favStore.set(ids.slice(0, MAX));
  });
  return loading;
}

export function isFavorite(id: number): boolean {
  return favStore.get()?.includes(id) ?? false;
}

/** Adds or removes a service (newest first); returns whether it is now a favorite */
export function toggleFavorite(id: number): boolean {
  const cur = favStore.get() ?? [];
  const on = !cur.includes(id);
  const next = on ? [id, ...cur].slice(0, MAX) : cur.filter((x) => x !== id);
  favStore.set(next);
  cloud.set(KEY, next.join(","));
  return on;
}
