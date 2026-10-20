import { NP_LANGS, type CategoryItem, type DripFeed, type Lang, type PlatformItem, type ServiceDetail, type ServiceField, type ServiceItem } from "../shared/types";
import { PLATFORM_ORDER, platformName } from "../shared/platforms";
import type { Env } from "./env";
import { npCall } from "./notpanel";
import { linesField, quantityMode, sellRate } from "./pricing";
import type { Settings } from "./settings";

// Shared SQL pieces. `cr` = category rule, `pr` = platform-wide rule (category = '').
export const RULE_JOINS = `
  LEFT JOIN category_rules cr ON cr.platform = s.platform AND cr.category = s.category
  LEFT JOIN category_rules pr ON pr.platform = s.platform AND pr.category = ''`;
export const MARKUP_SQL = "COALESCE(s.markup_pct, cr.markup_pct, pr.markup_pct, ?1)";
export const VISIBLE_SQL = `s.present = 1 AND s.enabled = 1 AND COALESCE(cr.enabled, 1) = 1 AND COALESCE(pr.enabled, 1) = 1
  AND (s.fixed_rate IS NULL OR s.fixed_rate >= s.rate)`;
const NAME_JOIN = "LEFT JOIN service_names sn ON sn.service_id = s.id AND sn.lang = ?2";
const NAME_SQL = "COALESCE(s.custom_name, sn.name, s.name)";

export const PAGE = 50;

/** Rebuilds the pre-counted platform/category lists. Run after syncs and admin price/visibility changes. */
export function rebuildSummaryStmts(env: Env, s: Settings): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM category_summary"),
    env.DB.prepare(
      `INSERT INTO category_summary (platform, category, count, from_rate, sort)
       SELECT s.platform, s.category, COUNT(*), MIN(COALESCE(s.fixed_rate, s.rate * (1 + ${MARKUP_SQL} / 100.0))), MIN(s.sort)
       FROM services s ${RULE_JOINS} WHERE ${VISIBLE_SQL} GROUP BY s.platform, s.category`,
    ).bind(s.default_markup_pct),
  ];
}

interface Row {
  id: number;
  name: string;
  name_found: number;
  platform: string;
  category: string;
  category_slug: string;
  rate: number;
  markup: number;
  fixed_rate: number | null;
  min: number;
  max: number;
  refill: number;
  cancel: number;
  avg_minutes: number | null;
}

const ROW_COLS = `s.id, ${NAME_SQL} AS name, s.custom_name IS NOT NULL OR sn.name IS NOT NULL AS name_found, s.platform, s.category,
  s.category_slug, s.rate, ${MARKUP_SQL} AS markup, s.fixed_rate, s.min, s.max, s.refill, s.cancel, s.avg_minutes`;

/** Catalog row → item with the sell price per 1,000 in micro-USD */
function toItem(r: Row): ServiceItem {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    category: r.category,
    rate: sellRate(r.rate, r.markup, r.fixed_rate),
    min: r.min,
    max: r.max,
    refill: !!r.refill,
    cancel: !!r.cancel,
    avgMinutes: r.avg_minutes,
  };
}

// Per-isolate memo for browse lists; keyed by catalog version so syncs and admin edits invalidate it.
const memo = new Map<string, unknown>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (memo.has(key)) return memo.get(key) as T;
  const v = await fn();
  if (memo.size > 300) memo.clear();
  memo.set(key, v);
  return v;
}


export function listPlatforms(env: Env, s: Settings): Promise<PlatformItem[]> {
  return cached(`p:${s.catalog_version}`, async () => {
    const { results } = await env.DB.prepare("SELECT platform AS slug, SUM(count) AS count FROM category_summary GROUP BY platform").all<{
      slug: string;
      count: number;
    }>();
    const rank = (slug: string) => {
      const i = PLATFORM_ORDER.indexOf(slug);
      return slug === "other" ? 1e9 : i >= 0 ? i : 1000;
    };
    return results
      .map((r) => ({ slug: r.slug, name: platformName(r.slug), count: r.count }))
      .sort((a, b) => rank(a.slug) - rank(b.slug) || b.count - a.count);
  });
}

export function listCategories(env: Env, s: Settings, platform: string): Promise<CategoryItem[]> {
  return cached(`c:${s.catalog_version}:${platform}`, async () => {
    const { results } = await env.DB.prepare("SELECT category AS name, count, from_rate FROM category_summary WHERE platform = ?1 ORDER BY sort")
      .bind(platform)
      .all<{ name: string; count: number; from_rate: number }>();
    // Same $0.0001 rounding as sellRate, so "from" never undercuts the cheapest listed price
    return results.map((r) => ({ name: r.name, count: r.count, fromRate: Math.ceil(r.from_rate / 100 - 1e-9) * 100 }));
  });
}

/**
 * NotPanel only translates names on request. When a list has untranslated names, fetch that category's
 * catalog page in the user's language once and keep the names (English is kept as a fallback marker).
 */
async function fillNames(env: Env, lang: Lang, rows: Row[], page: number): Promise<void> {
  const missing = rows.filter((r) => !r.name_found);
  if (lang === "en" || !NP_LANGS.includes(lang) || !missing.length) return;
  const first = missing[0];
  try {
    const res = await npCall<{ items: { service: string; name: string; name_language?: string }[] }>(env, "catalog", {
      language: lang,
      limit: 100,
      ...(first.category_slug ? { platform: first.platform, category: first.category_slug, page: Math.floor((page * PAGE) / 100) + 1 } : { search: first.id }),
    });
    const got = new Map(res.items.map((i) => [Number(i.service), i.name_language === lang ? i.name : null]));
    const pairs: [number, string][] = [];
    for (const r of missing) {
      const name = got.get(r.id);
      // Not returned or not translated: store the English name so we don't ask again until it changes
      pairs.push([r.id, name || r.name]);
      if (name) r.name = name;
    }
    await env.DB.prepare(
      `INSERT INTO service_names (service_id, lang, name) SELECT value->>'$[0]', ?2, value->>'$[1]' FROM json_each(?1) WHERE 1
       ON CONFLICT(service_id, lang) DO UPDATE SET name = excluded.name`,
    )
      .bind(JSON.stringify(pairs), lang)
      .run();
  } catch (e) {
    console.warn("names fetch failed", (e as Error).message);
  }
}

export async function listServices(
  env: Env,
  s: Settings,
  lang: Lang,
  platform: string,
  category: string,
  page = 0,
): Promise<{ items: ServiceItem[]; more: boolean }> {
  const run = async () => {
    const { results } = await env.DB.prepare(
      `SELECT ${ROW_COLS} FROM services s ${RULE_JOINS} ${NAME_JOIN}
       WHERE ${VISIBLE_SQL} AND s.platform = ?3 AND s.category = ?4 ORDER BY s.sort LIMIT ?5 OFFSET ?6`,
    )
      .bind(s.default_markup_pct, lang, platform, category, PAGE + 1, page * PAGE)
      .all<Row>();
    return results;
  };
  return cached(`s:${s.catalog_version}:${lang}:${platform}:${category}:${page}`, async () => {
    const rows = await run();
    await fillNames(env, lang, rows.slice(0, PAGE), page);
    return { items: rows.slice(0, PAGE).map((r) => toItem(r)), more: rows.length > PAGE };
  });
}

// Per-isolate memo for search results (separate from the browse memo so searches can't evict it).
const searchMemo = new Map<string, ServiceItem[]>();

export async function searchServices(env: Env, s: Settings, lang: Lang, q: string): Promise<ServiceItem[]> {
  const term = q.trim().slice(0, 80);
  if (term.length < 2 && !/^\d+$/.test(term)) return [];
  const key = `${s.catalog_version}:${lang}:${term.toLowerCase()}`;
  const hit = searchMemo.get(key);
  if (hit) return hit;
  const items = await runSearch(env, s, lang, term);
  if (searchMemo.size >= 200) searchMemo.clear();
  searchMemo.set(key, items);
  return items;
}

async function runSearch(env: Env, s: Settings, lang: Lang, term: string): Promise<ServiceItem[]> {
  const isId = /^\d+$/.test(term);
  const like = `%${term.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLS} FROM services s ${RULE_JOINS} ${NAME_JOIN}
     WHERE ${VISIBLE_SQL} AND (${isId ? "s.id = ?4 OR " : ""}${NAME_SQL} LIKE ?3 ESCAPE '\\' OR s.name LIKE ?3 ESCAPE '\\' OR s.category LIKE ?3 ESCAPE '\\')
     ORDER BY ${isId ? "s.id = ?4 DESC, " : ""}s.sort LIMIT 40`,
  )
    .bind(s.default_markup_pct, lang, like, ...(isId ? [Number(term)] : []))
    .all<Row>();
  return results.map((r) => toItem(r));
}

interface DetailRow extends Row {
  type_key: string;
  step: number;
  fields: string;
  drip_feed: string | null;
  dripfeed: number;
  description: string | null;
}

/** Visible service with pricing, or null. Also used by order placement. */
export async function getService(env: Env, s: Settings, lang: Lang, id: number): Promise<(ServiceDetail & { cost: number }) | null> {
  const r = await env.DB.prepare(
    `SELECT ${ROW_COLS}, s.type_key, s.step, s.fields, s.drip_feed, s.dripfeed, s.description
     FROM services s ${RULE_JOINS} ${NAME_JOIN} WHERE ${VISIBLE_SQL} AND s.id = ?3`,
  )
    .bind(s.default_markup_pct, lang, id)
    .first<DetailRow>();
  if (!r) return null;
  if (!r.name_found && lang !== "en") await fillNames(env, lang, [Object.assign(r, { category_slug: "" })], 0);
  const drip = r.dripfeed && r.drip_feed ? (JSON.parse(r.drip_feed) as DripFeed) : null;
  return {
    ...toItem(r),
    cost: r.rate,
    typeKey: r.type_key,
    quantityMode: quantityMode(r.type_key),
    linesField: linesField(r.type_key),
    step: r.step || 1,
    fields: JSON.parse(r.fields || "[]") as ServiceField[],
    dripFeed: drip && drip.max_total_minutes ? drip : null,
    description: r.description,
  };
}
