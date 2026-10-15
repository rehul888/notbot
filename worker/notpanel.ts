// Minimal NotPanel API v3 client. https://notpanel.com/developers

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

export async function np<T = unknown>(key: string, action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const body = new URLSearchParams({ key, action });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(BASE, { method: "POST", body, signal: AbortSignal.timeout(25_000) });
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
