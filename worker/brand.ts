// What the owner can brand: name, logo, colors and links, as the app and the bot show them.
import { DEFAULT_PRESET, PRESET_IDS, type BrandInfo, type ButtonIcons, validButtonIcons, validCustomEmojiMap, validHexColor, validHttpsUrl } from "../shared/brand";
import type { Settings } from "./settings";

export const DEFAULT_BRAND = "NotBot";

/** The name shown everywhere: the owner's, else the default. (Setup saves the bot's first name as the owner's name.) */
export const brandName = (s: Pick<Settings, "brand_name">): string => s.brand_name.trim() || DEFAULT_BRAND;

export function brandInfo(s: Settings): BrandInfo {
  const preset = s.brand_preset === "custom" || PRESET_IDS.has(s.brand_preset) ? s.brand_preset : DEFAULT_PRESET;
  return {
    name: brandName(s),
    logoUrl: s.logo_ver > 0 ? `/media/logo?v=${s.logo_ver}` : null,
    preset,
    accent: validHexColor(s.brand_accent) ? s.brand_accent : "#2457ff",
    websiteUrl: validHttpsUrl(s.website_url) ? s.website_url : null,
    termsUrl: validHttpsUrl(s.terms_url) ? s.terms_url : null,
  };
}

/** Stored JSON → map, tolerating hand-edited or broken values (invalid = no custom emoji) */
export function parseEmojiMap(raw: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return validCustomEmojiMap(v) ? v : {};
  } catch {
    return {};
  }
}

export function parseButtonIcons(raw: string): Partial<ButtonIcons> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return validButtonIcons(v) ? v : {};
  } catch {
    return {};
  }
}
