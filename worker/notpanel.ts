// Minimal NotPanel API v3 client. https://notpanel.com/developers
// This project only works with NotPanel: the base URL is a constant (never a setting) and keys that don't look like
// NotPanel keys are refused before any request is made.
import { looksLikeNotPanelKey } from "../shared/brand";
import type { Env } from "./env";
import { getSettings, type Settings } from "./settings";

const BASE = "https://notpanel.com/api/v3";

export class NotPanelError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface NpService {
  service: string;
  name: string;
  type: string;
  category: string;
  rate: string;
  min: string | number;
  max: string | number;
  refill: boolean;
  cancel: boolean;
  dripfeed: boolean;
  type_key: string;
  platform: string | null;
  fields: unknown[];
  drip_feed: unknown;
  step: number;
  availability: string;
  average_time_minutes: number | null;
}

export interface NpStatus {
  order?: number;
  status: string;
  status_key: string;
  charge?: string;
  start_count?: string | number | null;
  remains?: string | number | null;
  refund?: string;
  reason_code?: string | null;
  can_cancel?: boolean;
  cancel_available?: boolean;
  can_refill?: boolean;
  error?: string;
  error_code?: string;
}

export interface NpAddResult {
  order: number;
  status_key: string;
  charge: string;
  cancel_available?: boolean;
  cancel_before?: string;
  replayed?: boolean;
}

/** The key in use: the one saved in setup/admin, else the NOTPANEL_API_KEY secret. */
export const npKey = (env: Pick<Env, "NOTPANEL_API_KEY">, s: Pick<Settings, "np_api_key">): string => s.np_api_key.trim() || env.NOTPANEL_API_KEY?.trim() || "";

export async function np<T = unknown>(key: string, action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!looksLikeNotPanelKey(key)) throw new NotPanelError("Not a NotPanel API key", "INVALID_KEY", false, 0);
  key = key.trim();
  const body = new URLSearchParams({ key, action });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, String(v));
  let res: Response;
  try {
    // Never follow a redirect: the key must only ever be sent to NotPanel ("manual" returns the 3xx unfollowed)
    res = await fetch(BASE, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    throw new NotPanelError(`NotPanel unreachable: ${(e as Error).message}`, "NETWORK", true, 0);
  }
  const text = await res.text();
  let data: any;
  // An unparseable body is always retryable: the request may have been processed (callers recover by request_id)
  try {
    data = JSON.parse(text);
  } catch {
    throw new NotPanelError(`Bad response from NotPanel (${res.status})`, "BAD_RESPONSE", true, res.status);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && data.error && data.error_code) {
    throw new NotPanelError(data.error, data.error_code, !!data.retryable, res.status, data.details);
  }
  if (!res.ok) throw new NotPanelError(`NotPanel error ${res.status}`, "HTTP_" + res.status, res.status >= 500, res.status);
  return data as T;
}

/** Parses "0.40625" USD → micro-USD integer */
export function usdToMicro(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  return Math.round(Number(v) * 1_000_000);
}

/** np() with the effective key (settings are memoised, so this is cheap) */
export async function npCall<T = unknown>(env: Env, action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  return np<T>(npKey(env, await getSettings(env)), action, params);
}

export type KeyCheck = { ok: true } | { ok: false; code: "NOT_NOTPANEL_KEY" | "NOTPANEL_REJECTED"; message: string };

/**
 * Accepts a key only if it looks like a NotPanel key AND NotPanel itself answers the way NotPanel answers:
 * `balance` returns {balance, currency} and `catalog` (page 1, limit 1) returns a catalog page. Read-only calls.
 */
export async function verifyNotPanelKey(key: string): Promise<KeyCheck> {
  if (!looksLikeNotPanelKey(key)) return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This is not a NotPanel API key (it starts with np_live_)." };
  const rejected = (e: unknown): KeyCheck => ({
    ok: false,
    code: "NOTPANEL_REJECTED",
    message: e instanceof NotPanelError && e.code !== "NETWORK" && e.code !== "BAD_RESPONSE" ? e.message : "NotPanel did not give the expected answer. Check the key and try again.",
  });
  try {
    const bal = await np<{ balance?: unknown; currency?: unknown }>(key, "balance");
    if (!bal || typeof bal !== "object" || !(typeof bal.balance === "string" || typeof bal.balance === "number") || typeof bal.currency !== "string")
      return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This key did not answer like a NotPanel account." };
    const cat = await np<{ catalog_updated_at?: unknown; total_pages?: unknown; items?: { service?: unknown; platform?: { slug?: unknown } | null }[] }>(key, "catalog", { page: 1, limit: 1 });
    const first = Array.isArray(cat?.items) ? cat.items[0] : undefined;
    if (!cat || typeof cat.catalog_updated_at !== "string" || typeof cat.total_pages !== "number" || !first || first.service === undefined || (first.platform != null && typeof first.platform.slug !== "string"))
      return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This key did not return the NotPanel catalog." };
    return { ok: true };
  } catch (e) {
    return rejected(e);
  }
}
