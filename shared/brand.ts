// Branding and setup contract shared by the Worker and the app: what an owner can customize, the color presets,
// and the validation rules both sides apply (the server always re-checks).

/** Public branding, sent in /api/me (`brand`) and /api/brand. */
export interface BrandInfo {
  /** Shown in the app header, bot messages and the bot profile, e.g. "Rocket SMM" */
  name: string;
  /** Uploaded logo (or the bot's profile photo), or null for the built-in monogram */
  logoUrl: string | null;
  /** Theme preset id (THEME_PRESETS) or "custom" */
  preset: string;
  /** #rrggbb accent used when preset is "custom" (ignored otherwise) */
  accent: string;
  /** Optional links shown in Profile */
  websiteUrl: string | null;
  /** Terms page: an external https link, or null to show the in-app terms text */
  termsUrl: string | null;
}

/** Public, unauthenticated: what a browser opening the app URL needs (setup wizard / "open in Telegram"). */
export interface PublicStatus {
  brand: BrandInfo;
  botUsername: string | null;
  /** Setup finished: webhook set, Mini App button set, an admin exists */
  configured: boolean;
}

/** /api/setup/status, only after the bot token was confirmed (setup token). */
export interface SetupStatus {
  botUsername: string | null;
  botName: string | null;
  /** A NotPanel key is available (Worker secret or saved in setup) and NotPanel accepted it */
  notpanelOk: boolean;
  notpanelError: string | null;
  /** Steps still to run, in order */
  pending: SetupStep[];
  /** An admin exists (OWNER_IDS env var or a claimed account) */
  ownerReady: boolean;
  /** One-tap link that opens the bot and claims admin (only while no admin exists) */
  claimLink: string | null;
}

export type SetupStep = "webhook" | "menu" | "texts0" | "texts1" | "commands";

export interface ThemePreset {
  id: string;
  label: string;
  /** Main accent (buttons, links, selection) for light mode */
  accent: string;
  /** Brighter variant for dark mode (readable on dark backgrounds) */
  accentDark: string;
}

/** Ready-made color themes. "cobalt" is the default. */
export const THEME_PRESETS: ThemePreset[] = [
  { id: "cobalt", label: "Cobalt", accent: "#2457ff", accentDark: "#5b82ff" },
  { id: "violet", label: "Violet", accent: "#6d3cf5", accentDark: "#9a7bff" },
  { id: "emerald", label: "Emerald", accent: "#0f8a5f", accentDark: "#2fc48c" },
  { id: "teal", label: "Teal", accent: "#0b7f8c", accentDark: "#2cc0cf" },
  { id: "ocean", label: "Ocean", accent: "#0a6fd6", accentDark: "#4aa3ff" },
  { id: "sunset", label: "Sunset", accent: "#e0531f", accentDark: "#ff7d4d" },
  { id: "rose", label: "Rose", accent: "#d61f69", accentDark: "#ff5c9a" },
  { id: "crimson", label: "Crimson", accent: "#c4213a", accentDark: "#ff5c70" },
  { id: "amber", label: "Amber", accent: "#b06a00", accentDark: "#ffb02e" },
  { id: "graphite", label: "Graphite", accent: "#2f3542", accentDark: "#c9cfdb" },
];

export const DEFAULT_PRESET = "cobalt";
export const PRESET_IDS = new Set(THEME_PRESETS.map((p) => p.id));

export const LIMITS = {
  brandName: 40,
  welcomeText: 1000,
  url: 300,
  /** Uploaded logo / banner, bytes */
  imageBytes: 700_000,
  customEmoji: 60,
} as const;

const CONTROL = /[\u0000-\u001f\u007f]/;

export function validBrandName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.length <= LIMITS.brandName && !CONTROL.test(v);
}

export function validHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** https only, no credentials, a real host */
export function validHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > LIMITS.url) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * NotPanel API keys look like np_live_<hex>. This is only the first gate: the server also checks the key with
 * NotPanel itself (worker/notpanel.ts verifyNotPanelKey) before accepting it. Other panels' keys never pass.
 */
export const NOTPANEL_KEY_RE = /^np_live_[A-Za-z0-9]{24,64}$/;

export function looksLikeNotPanelKey(v: unknown): v is string {
  return typeof v === "string" && NOTPANEL_KEY_RE.test(v.trim());
}

/** Custom emoji map: plain emoji → Telegram custom emoji id (needs the bot owner's Telegram Premium). */
export function validCustomEmojiMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return (
    entries.length <= LIMITS.customEmoji &&
    // Keys are plain emoji: non-ASCII only, so a key can never match letters or message markup
    entries.every(([k, id]) => /^[^\u0000-\u007f]{1,8}$/u.test(k) && typeof id === "string" && /^\d{10,25}$/.test(id))
  );
}

/** Button icon ids (custom emoji on inline buttons). Empty string = no icon. */
export interface ButtonIcons {
  open: string;
  viewOrder: string;
  terms: string;
  invite: string;
}

export function validButtonIcons(v: unknown): v is ButtonIcons {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (["open", "viewOrder", "terms", "invite"] as const).every((k) => typeof o[k] === "string" && (o[k] === "" || /^\d{10,25}$/.test(o[k] as string)));
}
