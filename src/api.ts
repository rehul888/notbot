import { initData } from "./tg";

export class ApiError extends Error {
  constructor(public code: string, public status: number, public details?: Record<string, any>) {
    super(code);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      ...(initData ? { authorization: `tma ${initData}` } : {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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
