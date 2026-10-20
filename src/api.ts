import { initData } from "./tg";

export class ApiError extends Error {
  constructor(public code: string, public status: number, public details?: Record<string, any>) {
    super(code);
  }
}

/** Delay before poll number `i` (0-based): about 1s, 1.5s, 2s, 3s, 4s, then 5s. */
const BACKOFF_MS = [1000, 1500, 2000, 3000, 4000];
export const pollDelay = (i: number) => BACKOFF_MS[i] ?? 5000;

declare global {
  interface Window {
    /** Started by an inline script in index.html, before this bundle arrives. */
    __mePromise?: Promise<Response>;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? "POST" : "GET");
  // A File/Blob is sent as is (image uploads), with its own content type; anything else as JSON.
  const raw = opts.body instanceof Blob ? opts.body : null;
  // The first GET /me reuses the request index.html already started (once).
  let early: Promise<Response> | undefined;
  if (path === "/me" && method === "GET" && !opts.body) {
    early = window.__mePromise;
    window.__mePromise = undefined;
  }
  const res = (early && (await early.catch(() => undefined))) || await fetch(`/api${path}`, {
    method,
    headers: {
      ...(initData ? { authorization: `tma ${initData}` } : {}),
      ...opts.headers,
      ...(opts.body ? { "content-type": raw ? raw.type : "application/json" } : {}),
    },
    body: raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The user left the update channel: refresh Me so the app shows the join step again
    if (data.code === "CHANNEL_REQUIRED" && path !== "/me") void import("./me").then((m) => m.refreshMe()).catch(() => undefined);
    throw new ApiError(data.code ?? "NETWORK", res.status, data.details);
  }
  return data as T;
}

/** Tiny in-memory cache for GETs that rarely change during a session (catalog lists). */
const cache = new Map<string, Promise<any>>();
export function cachedApi<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = api<T>(path).catch((e) => {
      cache.delete(path);
      throw e;
    });
    cache.set(path, p);
  }
  return p;
}
export function clearApiCache() {
  cache.clear();
}
