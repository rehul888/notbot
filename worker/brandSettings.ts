// Server-side checks for the branding settings an owner can save (the same rules as shared/brand.ts, always re-checked).
import { LIMITS, PRESET_IDS, validBrandName, validButtonIcons, validCustomEmojiMap, validHexColor, validHttpsUrl } from "../shared/brand";
import type { Settings } from "./settings";

export const BRAND_KEYS = ["brand_name", "brand_preset", "brand_accent", "website_url", "terms_url", "welcome_text", "custom_emoji", "button_icons"] as const;

const WELCOME_BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Validates (and normalises, e.g. compact JSON) the branding values present in `values`, in place.
 * Returns the first invalid key, or null when everything is fine.
 */
export function normalizeBrandSettings(values: Partial<Settings>): string | null {
  const v = values as Record<string, string | undefined>;
  if (v.brand_name !== undefined) {
    v.brand_name = v.brand_name.trim();
    if (v.brand_name && !validBrandName(v.brand_name)) return "brand_name";
  }
  if (v.brand_preset !== undefined && v.brand_preset !== "custom" && !PRESET_IDS.has(v.brand_preset)) return "brand_preset";
  if (v.brand_accent !== undefined && !validHexColor(v.brand_accent)) return "brand_accent";
  for (const k of ["website_url", "terms_url"] as const) {
    if (v[k] === undefined) continue;
    v[k] = v[k]!.trim();
    if (v[k] && !validHttpsUrl(v[k])) return k;
  }
  if (v.welcome_text !== undefined && (v.welcome_text.length > LIMITS.welcomeText || WELCOME_BAD_CHARS.test(v.welcome_text))) return "welcome_text";
  if (v.custom_emoji !== undefined) {
    const parsed = parseJson(v.custom_emoji.trim() || "{}");
    if (!validCustomEmojiMap(parsed)) return "custom_emoji";
    v.custom_emoji = JSON.stringify(parsed);
  }
  if (v.button_icons !== undefined) {
    const parsed = parseJson(v.button_icons.trim() || "{}");
    // Missing ids mean "no icon"
    const full = { open: "", viewOrder: "", terms: "", invite: "", ...(parsed && typeof parsed === "object" ? (parsed as object) : {}) };
    if (!validButtonIcons(full) || Object.keys(full).length > 4) return "button_icons";
    v.button_icons = JSON.stringify(full);
  }
  return null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
