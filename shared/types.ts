// Types shared by the Worker API and the Mini App.

export const LANGS = ["en", "es", "pt", "ru", "tr", "ar", "hi", "id", "fr", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  tr: "Türkçe",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  fr: "Français",
  zh: "中文",
};

export function pickLang(code: string | null | undefined): Lang {
  const base = (code || "en").toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(base) ? (base as Lang) : "en";
}

/** Micro-dollars: 1 USD = 1_000_000 */
export const MICRO = 1_000_000;

export type OrderStatus =
  | "submitting"
  | "pending"
  | "processing"
  | "in_progress"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export const FINAL_STATUSES: OrderStatus[] = ["completed", "partial", "cancelled", "failed"];

export interface Me {
  id: number;
  firstName: string;
  lastName: string;
  username: string | null;
  photoUrl: string | null;
  lang: Lang;
  langChosen: boolean;
  balance: number;
  notify: boolean;
  canMessage: boolean;
  termsAccepted: boolean;
  isAdmin: boolean;
  starsPerUsd: number;
  minTopup: number;
  maxTopup: number;
  supportUsername: string | null;
  channelUsername: string | null;
  botUsername: string | null;
  recent: RecentOrder[];
}

export interface RecentOrder {
  id: number;
  serviceId: number;
  serviceName: string;
  platform: string;
  link: string;
  quantity: number;
}

export interface PlatformItem {
  slug: string;
  name: string;
  count: number;
}

export interface CategoryItem {
  name: string;
  count: number;
  fromRate: number;
}

export interface ServiceItem {
  id: number;
  name: string;
  platform: string;
  category: string;
  rate: number; // sell price per 1,000 (micro-USD)
  min: number;
  max: number;
  refill: boolean;
  cancel: boolean;
  avgMinutes: number | null;
}

export type FieldKind = "integer" | "text" | "lines" | "choice" | "url" | "reactions";

export interface ServiceField {
  key: string;
  kind: FieldKind;
  required: boolean;
  label: string;
  min?: number;
  max?: number;
  max_length?: number;
  choices?: string[];
  allowed?: string[];
  max_distinct?: number;
  modes?: string[];
}

export interface DripFeed {
  mode: "batches" | "unit_delay";
  max_total_minutes: number;
}

/** How the quantity is decided for a service type */
export type QuantityMode = "free" | "fixed" | "lines";

export interface ServiceDetail extends ServiceItem {
  typeKey: string;
  quantityMode: QuantityMode;
  linesField: string | null; // field whose line count becomes the quantity
  step: number;
  fields: ServiceField[];
  dripFeed: DripFeed | null;
  description: string | null;
}

export interface OrderView {
  id: number;
  serviceId: number;
  serviceName: string;
  platform: string;
  category: string;
  link: string;
  quantity: number;
  charge: number;
  refund: number;
  status: OrderStatus;
  startCount: number | null;
  remains: number | null;
  reasonCode: string | null;
  canCancel: boolean;
  canRefill: boolean;
  refillStatus: string | null;
  paidWithStars: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerItem {
  id: number;
  delta: number;
  kind: "topup" | "order" | "refund" | "admin" | "stars_refund";
  ref: number | null;
  note: string | null;
  createdAt: number;
}

export interface OrderDraft {
  serviceId: number;
  link: string;
  quantity?: number;
  fields?: Record<string, string>;
  dripMinutes?: number;
}

export interface Quote {
  quantity: number;
  charge: number;
}

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
