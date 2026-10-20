import type { BrandInfo } from "./brand";
// Types shared by the Worker API and the Mini App.

export const LANGS = [
  "en", "es", "pt", "ru", "tr", "ar", "hi", "id", "fr", "zh",
  "de", "it", "pl", "uk", "ja", "ko", "vi", "fa", "ur", "bn",
] as const;
export type Lang = (typeof LANGS)[number];

/** Languages NotPanel's API can translate service names into; others show English service names. */
export const NP_LANGS: readonly Lang[] = ["en", "es", "pt", "ru", "tr", "ar", "hi", "id", "fr", "zh"];

/** Right-to-left languages */
export const RTL_LANGS: readonly Lang[] = ["ar", "fa", "ur"];

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
  de: "Deutsch",
  it: "Italiano",
  pl: "Polski",
  uk: "Українська",
  ja: "日本語",
  ko: "한국어",
  vi: "Tiếng Việt",
  fa: "فارسی",
  ur: "اردو",
  bn: "বাংলা",
};

/** Flag shown next to each language (English is global, so a globe) */
export const LANG_FLAGS: Record<Lang, string> = {
  en: "🌐", es: "🇪🇸", pt: "🇧🇷", ru: "🇷🇺", tr: "🇹🇷", ar: "🇸🇦", hi: "🇮🇳", id: "🇮🇩", fr: "🇫🇷", zh: "🇨🇳",
  de: "🇩🇪", it: "🇮🇹", pl: "🇵🇱", uk: "🇺🇦", ja: "🇯🇵", ko: "🇰🇷", vi: "🇻🇳", fa: "🇮🇷", ur: "🇵🇰", bn: "🇧🇩",
};

/** "🇪🇸 Español" */
export const langLabel = (l: Lang) => `${LANG_FLAGS[l]} ${LANG_NAMES[l]}`;

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
  /** micro-USD; shown as Stars with balanceStars() */
  balance: number;
  notify: boolean;
  canMessage: boolean;
  termsAccepted: boolean;
  isAdmin: boolean;
  /** Stars per $1: the app converts every micro-USD amount to Stars with it (never shows USD) */
  starsPerUsd: number;
  /** Smallest / largest top-up, whole Stars */
  minTopup: number;
  maxTopup: number;
  supportUsername: string | null;
  /** Update channel link (Profile tile + join step) */
  channelUrl: string | null;
  /** Show the "join the update channel" step before the app */
  channelRequired: boolean;
  referralEnabled: boolean;
  /** Whole Stars a referrer earns per friend who joins (credited as their dollar value) */
  referralReward: number;
  botUsername: string | null;
  recent: RecentOrder[];
  /** Owner's branding (name, logo, colors, links) */
  brand: BrandInfo;
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
  /** Cheapest sell price per 1,000, micro-USD */
  fromRate: number;
}

export interface ServiceItem {
  id: number;
  name: string;
  platform: string;
  category: string;
  rate: number; // sell price per 1,000, micro-USD (fixed-quantity packages: the whole price); shown as Stars
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
  /** Number shown to users: the NotPanel order id, or the internal id while not yet accepted. */
  number: number;
  serviceId: number;
  serviceName: string;
  platform: string;
  category: string;
  link: string;
  quantity: number;
  /** micro-USD charged / refunded */
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
  /** micro-USD, signed */
  delta: number;
  kind: "topup" | "order" | "refund" | "admin" | "stars_refund" | "referral";
  ref: number | null;
  /** Displayed order number for kinds order/refund. */
  orderNumber: number | null;
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

export interface ReferralStats {
  /** Personal invite link (t.me/<bot>?start=ref_<id>), null until the bot is connected */
  link: string | null;
  enabled: boolean;
  /** Reward per friend as shown, whole Stars */
  rewardStars: number;
  /** Reward per friend credited now, micro-USD */
  reward: number;
  /** Friends who started through the link */
  invited: number;
  /** Friends who joined the channel and reached home (paid or over the daily cap) */
  joined: number;
  /** Total paid to this user, micro-USD */
  earned: number;
  recent: { name: string; status: "pending" | "rewarded" | "capped"; at: number }[];
}

export type ChannelVerify = { result: "member" | "not_member" | "unavailable"; me: Me };
