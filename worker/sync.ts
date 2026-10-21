// Free-plan friendly price sync.
//
// NotPanel's full `services` list is ~7 MB, too heavy to parse inside the free plan's 10 ms CPU budget.
// Instead we walk the paged `catalog` (100 per page) a few pages per cron tick, keep only services with a
// measured average time (admin setting), and fetch full details (form fields, drip-feed, step) for changed
// ones with `services?service=<ids>`. Only changed rows are written.
import type { Env } from "./env";
import { looksLikeNotPanelKey } from "../shared/brand";
import { npCall, npKey, NotPanelError, usdToMicro, type NpService } from "./notpanel";
import { alertAdmins } from "./alerts";
import { rebuildSummaryStmts } from "./catalog";
import { bumpCatalogStmt, getSettings, setSettings, type Settings } from "./settings";

const PAGE_SIZE = 100;
const PAGES_PER_TICK = 8;
const MAX_RUN_SECONDS = 2 * 3600;

interface CatalogItem {
  service: string;
  name: string;
  description?: string | null;
  type: string;
  rate: string;
  min: string;
  max: string;
  platform: { slug: string; name: string } | null;
  category: { slug: string; name: string } | null;
  refill: boolean;
  dripfeed: boolean;
  available: boolean;
  cancel: boolean;
  average_time_minutes: number | null;
  input_fields?: unknown[];
}

interface CatalogPage {
  catalog_updated_at: string;
  total: number;
  page: number;
  total_pages: number;
  items: CatalogItem[];
}

export interface SyncStats {
  at: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
  priceUp: number;
  priceDown: number;
  unchanged?: boolean;
  error?: string;
}

interface SyncState {
  startedAt: number;
  page: number;
  totalPages: number;
  catalogAt: string;
  force: boolean;
  strict: boolean; // remove services missing from this run right away (after the filter setting changed)
  seen: number[];
  stats: SyncStats;
}

/** FNV-1a — only used to detect changed rows */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function fingerprint(i: CatalogItem): string {
  return hash(
    JSON.stringify([i.name, i.description, i.type, i.rate, i.min, i.max, i.platform?.slug, i.category?.name, i.refill, i.dripfeed, i.cancel, i.average_time_minutes, i.input_fields]),
  );
}

export function syncProgress(s: Settings): { running: boolean; page: number; totalPages: number } {
  const st = s.sync_state ? (JSON.parse(s.sync_state) as SyncState) : null;
  return { running: !!st, page: st?.page ?? 0, totalPages: st?.totalPages ?? 0 };
}

/** Admin "Sync now": starts a run that the cron job carries out over the next minutes. */
export async function startSync(env: Env, opts: { force?: boolean; strict?: boolean } = {}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const state: SyncState = {
    startedAt: now,
    page: 1,
    totalPages: 0,
    catalogAt: "",
    force: !!opts.force,
    strict: !!opts.strict,
    seen: [],
    stats: { at: now, total: 0, added: 0, updated: 0, removed: 0, priceUp: 0, priceDown: 0 },
  };
  await setSettings(env, { sync_state: JSON.stringify(state) });
}

const UPSERT = `INSERT INTO services (id, platform, category, category_slug, name, type_key, rate, min, max, step, refill, cancel,
    dripfeed, drip_feed, fields, avg_minutes, description, sort, hash, present, missed, enabled, first_seen_at, updated_at)
  SELECT v->>'$[0]', v->>'$[1]', v->>'$[2]', v->>'$[3]', v->>'$[4]', v->>'$[5]', v->>'$[6]', v->>'$[7]', v->>'$[8]', v->>'$[9]',
    v->>'$[10]', v->>'$[11]', v->>'$[12]', v->>'$[13]', v->>'$[14]', v->>'$[15]', v->>'$[16]', v->>'$[17]', v->>'$[18]', 1, 0, ?2, ?3, ?3
  FROM (SELECT value AS v FROM json_each(?1)) WHERE 1
  ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, category = excluded.category, category_slug = excluded.category_slug,
    name = excluded.name, type_key = excluded.type_key, rate = excluded.rate, min = excluded.min, max = excluded.max, step = excluded.step,
    refill = excluded.refill, cancel = excluded.cancel, dripfeed = excluded.dripfeed, drip_feed = excluded.drip_feed,
    fields = excluded.fields, avg_minutes = excluded.avg_minutes, description = excluded.description, sort = excluded.sort,
    hash = excluded.hash, present = 1, missed = 0, updated_at = excluded.updated_at`;

/** One cron tick: start a run when due, then process the next few catalog pages. */
export async function syncTick(env: Env): Promise<void> {
  const s = await getSettings(env, { fresh: true });
  // A fresh install has no NotPanel key until setup saves one: nothing to sync yet
  if (!looksLikeNotPanelKey(npKey(env, s))) return;
  const now = Math.floor(Date.now() / 1000);
  let state = s.sync_state ? (JSON.parse(s.sync_state) as SyncState) : null;
  if (!state) {
    const due = !s.last_sync_at || (s.sync_enabled && now - s.last_sync_at >= s.sync_every_hours * 3600);
    if (!due) return;
    await startSync(env);
    state = JSON.parse((await getSettings(env, { fresh: true })).sync_state) as SyncState;
  }
  if (now - state.startedAt > MAX_RUN_SECONDS) {
    await finish(env, s, { ...state.stats, error: "Sync took too long and was stopped" }, null);
    return;
  }

  const last = state.totalPages ? Math.min(state.totalPages, state.page + PAGES_PER_TICK - 1) : state.page;
  const nums = Array.from({ length: last - state.page + 1 }, (_, i) => state.page + i);
  let pages: CatalogPage[];
  try {
    pages = await Promise.all(nums.map((page) => npCall<CatalogPage>(env, "catalog", { page, limit: PAGE_SIZE })));
  } catch (e) {
    console.warn("sync: catalog fetch failed, will retry", (e as Error).message);
    if (e instanceof NotPanelError && !e.retryable && e.code !== "API_RATE_LIMITED") await finish(env, s, { ...state.stats, error: e.message }, null);
    return;
  }
  if (state.page === 1) {
    state.catalogAt = pages[0].catalog_updated_at;
    state.totalPages = pages[0].total_pages;
    // Nothing changed at NotPanel since our last full run: done after one request.
    if (!state.force && s.last_catalog_at && s.last_catalog_at === state.catalogAt) {
      await finish(env, s, { ...state.stats, unchanged: true, total: -1 }, null);
      return;
    }
  }

  // Services we list, with their position in NotPanel's catalog (popular first)
  const items: { item: CatalogItem; sort: number; fp: string }[] = [];
  let badRate = 0;
  for (const p of pages)
    p.items.forEach((item, idx) => {
      if (!item.available) return;
      if (s.only_timed && item.average_time_minutes == null) return;
      // A missing, zero, negative or garbage supplier rate must never make a service free or break the batch
      const rate = Number(item.rate);
      if (item.rate === null || item.rate === undefined || !Number.isFinite(rate) || rate <= 0 || usdToMicro(item.rate) <= 0) {
        badRate++;
        return;
      }
      items.push({ item, sort: (p.page - 1) * PAGE_SIZE + idx, fp: fingerprint(item) });
    });
  if (badRate) console.warn(`sync: skipped ${badRate} catalog item(s) with an invalid rate`);

  if (items.length) {
    const ids = items.map((i) => Number(i.item.service));
    const { results } = await env.DB.prepare("SELECT id, hash, rate, name, present FROM services WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(ids))
      .all<{ id: number; hash: string; rate: number; name: string; present: number }>();
    const have = new Map(results.map((r) => [r.id, r]));
    const changed = items.filter((i) => {
      const e = have.get(Number(i.item.service));
      return !e || e.hash !== i.fp || !e.present;
    });

    // Full details (form fields, drip-feed, step, type) for changed ones only
    const details = new Map<number, NpService>();
    try {
      for (let i = 0; i < changed.length; i += 100) {
        const list = await npCall<NpService[]>(env, "services", {
          service: changed.slice(i, i + 100).map((c) => c.item.service).join(","),
        });
        for (const d of list) details.set(Number(d.service), d);
      }
    } catch (e) {
      console.warn("sync: details fetch failed, will retry", (e as Error).message);
      return; // retry the same pages next tick
    }

    const rows: unknown[][] = [];
    const prices: [number, number, number][] = [];
    const renamed: number[] = [];
    for (const { item, sort, fp } of changed) {
      const id = Number(item.service);
      const d = details.get(id);
      if (!d || d.availability === "paused") continue;
      const rate = usdToMicro(item.rate);
      const e = have.get(id);
      if (!e) state.stats.added++;
      else {
        state.stats.updated++;
        if (e.rate !== rate) {
          prices.push([id, e.rate, rate]);
          if (rate > e.rate) state.stats.priceUp++;
          else state.stats.priceDown++;
        }
        if (e.name !== item.name) renamed.push(id);
      }
      rows.push([
        id,
        item.platform?.slug || d.platform || "other",
        item.category?.name || d.category || "Other",
        item.category?.slug || "",
        item.name,
        d.type_key || item.type || "default",
        rate,
        Number(item.min) || 1,
        Number(item.max) || 1,
        Number(d.step) || 1,
        item.refill ? 1 : 0,
        d.cancel ? 1 : 0,
        item.dripfeed ? 1 : 0,
        d.drip_feed ? JSON.stringify(d.drip_feed) : null,
        JSON.stringify(d.fields ?? []),
        item.average_time_minutes,
        item.description?.trim() || null,
        sort,
        fp,
      ]);
    }
    const stmts: D1PreparedStatement[] = [];
    if (rows.length) {
      stmts.push(env.DB.prepare(UPSERT).bind(JSON.stringify(rows), !s.last_sync_at || s.auto_enable_new ? 1 : 0, now));
    }
    if (prices.length)
      stmts.push(
        env.DB.prepare(
          `INSERT INTO price_changes (service_id, old_rate, new_rate, changed_at) SELECT value->>'$[0]', value->>'$[1]', value->>'$[2]', ?2 FROM json_each(?1)`,
        ).bind(JSON.stringify(prices), now),
      );
    // Translated names are fetched lazily; drop them when the English name changes
    if (renamed.length) stmts.push(env.DB.prepare("DELETE FROM service_names WHERE service_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(renamed)));
    if (stmts.length) await env.DB.batch(stmts);

    // Seen = unchanged rows we already have + rows written now (a changed service NotPanel didn't detail is left out)
    const changedIds = new Set(changed.map((c) => Number(c.item.service)));
    for (const id of ids) if (!changedIds.has(id)) state.seen.push(id);
    for (const r of rows) state.seen.push(r[0] as number);
  }

  state.page = last + 1;
  if (state.page > state.totalPages) await finish(env, s, state.stats, state);
  else await setSettings(env, { sync_state: JSON.stringify(state) });
}

/** End of a run: retire services NotPanel no longer lists, rebuild browse lists, save the summary. */
async function finish(env: Env, s: Settings, stats: SyncStats, state: SyncState | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (stats.error) await alertAdmins(env, "sync", `The price and service sync with NotPanel failed: <b>${stats.error.replace(/[<>&]/g, "")}</b>. Prices stay as they were; it retries on schedule. If it keeps failing, check your NotPanel API key.`);
  const stmts: D1PreparedStatement[] = [];
  if (state && !stats.error) {
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE present = 1").first<{ n: number }>())!;
    // Guard against a glitchy run: only retire services when we saw a sane amount of the catalog
    if (state.seen.length >= n * 0.5 || state.strict) {
      const seen = JSON.stringify(state.seen);
      const threshold = state.strict ? 1 : 2;
      const missing = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM services WHERE present = 1 AND missed + 1 >= ?2 AND id NOT IN (SELECT value FROM json_each(?1))",
      )
        .bind(seen, threshold)
        .first<{ n: number }>();
      stats.removed = missing?.n ?? 0;
      stmts.push(
        env.DB.prepare("UPDATE services SET missed = missed + 1 WHERE present = 1 AND id NOT IN (SELECT value FROM json_each(?1))").bind(seen),
        env.DB.prepare("UPDATE services SET present = 0, updated_at = ?2 WHERE present = 1 AND missed >= ?1").bind(threshold, now),
      );
    }
    stats.total = state.seen.length;
  }
  if (!stats.unchanged) stmts.push(...rebuildSummaryStmts(env, s), bumpCatalogStmt(env));
  stmts.push(env.DB.prepare("DELETE FROM price_changes WHERE changed_at < ?1").bind(now - 365 * 86400));
  await env.DB.batch(stmts);
  stats.at = now;
  await setSettings(env, {
    sync_state: "",
    last_sync_at: now,
    last_sync_summary: JSON.stringify(stats),
    ...(state && !stats.error ? { last_catalog_at: state.catalogAt } : {}),
  });
}
