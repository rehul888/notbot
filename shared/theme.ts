// Theme engine: turns the owner's brand (a preset id or a custom #rrggbb accent) into every brand-colored CSS variable,
// for light and dark mode. Pure functions (no DOM), so the Worker, the app and the tests can all use them.
//
// The default "cobalt" theme returns the exact values the design shipped with (COBALT_*), so the default look never
// changes. Every other accent is derived with OKLCH math, and text colors are adjusted until they reach WCAG 4.5:1.
import { DEFAULT_PRESET, THEME_PRESETS, validHexColor, type BrandInfo } from "./brand";

// ---------- color math ----------

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const to2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
export const rgbToHex = ([r, g, b]: RGB) => `#${to2(r)}${to2(g)}${to2(b)}`;

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

/** WCAG relative luminance */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21 */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Lch {
  L: number;
  C: number;
  h: number;
}

function toOklch(hex: string): Lch {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function rawFromOklch({ L, C, h }: Lch): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to #rrggbb. A color outside the sRGB gamut loses chroma (not lightness) until it fits. */
function fromOklch(c: Lch): string {
  const L = Math.max(0, Math.min(1, c.L));
  const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
  let C = Math.max(0, c.C);
  if (!inGamut(rawFromOklch({ L, C, h: c.h }))) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(rawFromOklch({ L, C: mid, h: c.h }))) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  return rgbToHex(rawFromOklch({ L, C, h: c.h }).map(fromLin) as RGB);
}

/** Mix two colors in sRGB, t = share of `b` */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Moves the lightness of `fg` (keeping hue and as much chroma as fits) away from `bg` until the contrast is `min`. */
function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const lch = toOklch(fg);
  const darker = luminance(bg) > 0.4;
  let out = fg;
  for (let i = 0; i < 60 && contrast(out, bg) < min; i++) {
    lch.L += darker ? -0.01 : 0.01;
    out = fromOklch(lch);
  }
  return out;
}

// ---------- the default (cobalt): exact shipped values ----------

export type Vars = Record<string, string>;

const COBALT_LIGHT: Vars = {
  "--track": "#e6ecff",
  "--bar-fill": "#2457ff",
  "--brand": "#2457ff",
  "--brand-pressed": "#163ccb",
  "--brand-ring": "#2457ff",
  "--acc": "#2457ff",
  "--sel": "#e6ecff",
  "--sel-fg": "#1b45d6",
  "--on-brand": "#ffffff",
  "--on-brand-2": "#e6ecff",
  "--ink": "#152044",
  "--lavender": "#e6ecff",
  "--lavender-strong": "#b8c9ff",
  "--art-ring": "#b8c9ff",
  "--art-shadow": "rgba(26, 48, 102, 0.12)",
  "--art-shadow-brand": "rgba(10, 24, 90, 0.35)",
  "--st-progress-bg": "#e6ecff",
  "--st-progress": "#1b45d6",
  "--btn-off-bg": "#e4e8f5",
  "--btn-off-fg": "#5d6684",
  "--glow": "rgba(36, 87, 255, 0.13)",
  "--shadow-brand": "0 16px 32px -20px rgba(36, 87, 255, 0.7)",
  "--hero-1": "#2457ff",
  "--hero-2": "#2152f2",
  "--hero-3": "#1b45d6",
  "--pill-fg": "#1b45d6",
  "--acc-on-dark": "#a8bbff",
  "--ob-10": "rgba(255, 255, 255, 0.1)",
  "--ob-16": "rgba(255, 255, 255, 0.16)",
  "--ob-24": "rgba(255, 255, 255, 0.24)",
  "--ob-28": "rgba(255, 255, 255, 0.28)",
  "--ob-35": "rgba(255, 255, 255, 0.35)",
};

const COBALT_DARK: Vars = {
  "--track": "#2c2c2e",
  "--bar-fill": "#8aa4ff",
  "--brand": "#2457ff",
  "--brand-pressed": "#163ccb",
  "--brand-ring": "#5b7cff",
  "--acc": "#8aa4ff",
  "--sel": "#1e2847",
  "--sel-fg": "#a8bbff",
  "--on-brand": "#ffffff",
  "--on-brand-2": "#e6ecff",
  "--art-ring": "#3a4a80",
  "--art-shadow": "rgba(0, 0, 0, 0.4)",
  "--art-shadow-brand": "rgba(10, 24, 90, 0.35)",
  "--st-progress-bg": "#1e2847",
  "--st-progress": "#a8bbff",
  "--btn-off-bg": "#2c2c2e",
  "--btn-off-fg": "#98989f",
  "--glow": "rgba(90, 120, 255, 0.22)",
  "--shadow-brand": "0 16px 32px -20px rgba(36, 87, 255, 0.55)",
  "--hero-1": "#2457ff",
  "--hero-2": "#2152f2",
  "--hero-3": "#1b45d6",
  "--pill-fg": "#1b45d6",
  "--acc-on-dark": "#a8bbff",
  "--ob-10": "rgba(255, 255, 255, 0.1)",
  "--ob-16": "rgba(255, 255, 255, 0.16)",
  "--ob-24": "rgba(255, 255, 255, 0.24)",
  "--ob-28": "rgba(255, 255, 255, 0.28)",
  "--ob-35": "rgba(255, 255, 255, 0.35)",
};

// ---------- derivation for any other accent ----------

const PAGE_LIGHT = "#f2f2f7";
const PAGE_DARK = "#000000";
const CARD_DARK = "#1c1c1e";

/** Colors the native Telegram buttons need (they can't read CSS variables). */
export interface NativeColors {
  main: [string, string];
  mainOff: [string, string];
  secondary: [string, string];
}

export interface Theme {
  /** Final accent colors used for light / dark */
  accent: string;
  accentDark: string;
  light: Vars;
  dark: Vars;
  nativeLight: NativeColors;
  nativeDark: NativeColors;
}

export function resolveAccents(brand: Pick<BrandInfo, "preset" | "accent">): { accent: string; accentDark: string; preset: boolean } {
  const preset = THEME_PRESETS.find((p) => p.id === brand.preset);
  if (preset) return { accent: preset.accent, accentDark: preset.accentDark, preset: true };
  const accent = validHexColor(brand.accent) ? brand.accent.toLowerCase() : THEME_PRESETS[0].accent;
  const k = toOklch(accent);
  // Dark mode wants a brighter variant of the same hue
  const L = k.L >= 0.7 ? k.L : Math.max(0.64, Math.min(0.74, k.L + 0.13));
  return { accent, accentDark: fromOklch({ L, C: k.C, h: k.h }), preset: false };
}

/**
 * The color behind buttons, hero and wallet card, and the text color on it. Prefers white text (the design's look):
 * if the accent is a little too light for it, the accent is darkened slightly; a really light accent gets black text.
 */
export function fitBrand(color: string): { brand: string; on: "#ffffff" | "#000000" } {
  if (contrast("#ffffff", color) >= 4.5) return { brand: color, on: "#ffffff" };
  const lch = toOklch(color);
  for (let i = 1; i <= 8; i++) {
    const c = fromOklch({ ...lch, L: lch.L - i * 0.01 });
    if (contrast("#ffffff", c) >= 4.5) return { brand: c, on: "#ffffff" };
  }
  return { brand: color, on: contrast("#000000", color) >= 4.5 ? "#000000" : "#ffffff" };
}

export function deriveVars(accent: string, accentDark: string, dark: boolean): Vars {
  // Too-dark accents (graphite) use their bright variant on dark pages.
  const { brand, on } = fitBrand(dark && toOklch(accent).L < 0.45 ? accentDark : accent);
  const k = toOklch(brand);
  const white = on === "#ffffff";
  const page = dark ? PAGE_DARK : PAGE_LIGHT;

  const tint = (L: number, Cmax: number, Cmul: number) => fromOklch({ L, C: Math.min(Cmax, k.C * Cmul), h: k.h });
  const shade = (dL: number) => fromOklch({ ...k, L: k.L + dL });
  const sel = dark ? tint(0.27, 0.06, 0.5) : tint(0.94, 0.035, 0.4);
  const selFg = ensureContrast(dark ? tint(0.82, 0.1, 0.5) : shade(-0.05), sel, 4.5);
  const acc = ensureContrast(dark ? mix(accentDark, "#ffffff", 0.29) : accent, page, 4.5);
  const ring = dark ? accentDark : brand;
  const lavStrong = tint(0.85, 0.08, 0.45);
  const ob = white ? "#ffffff" : "#000000";
  const accOnDark = ensureContrast(mix(accentDark, "#ffffff", 0.29), CARD_DARK, 4.5);
  let on2 = "rgba(0, 0, 0, 0.72)";
  if (white) {
    on2 = "#ffffff";
    for (let t = 0.85; t <= 1; t += 0.03) {
      const c = mix(brand, "#ffffff", t);
      if (contrast(c, brand) >= 4.5) {
        on2 = c;
        break;
      }
    }
  }

  const v: Vars = {
    "--track": dark ? "#2c2c2e" : sel,
    "--bar-fill": acc,
    "--brand": brand,
    "--brand-pressed": shade(-0.09),
    "--brand-ring": ring,
    "--acc": acc,
    "--sel": sel,
    "--sel-fg": selFg,
    "--on-brand": on,
    "--on-brand-2": on2,
    "--lavender": sel,
    "--lavender-strong": lavStrong,
    "--art-ring": dark ? tint(0.4, 0.1, 0.5) : lavStrong,
    "--art-shadow": dark ? "rgba(0, 0, 0, 0.4)" : rgba(tint(0.34, 0.1, 0.4), 0.12),
    "--art-shadow-brand": rgba(fromOklch({ L: 0.27, C: Math.min(0.16, k.C * 0.6), h: k.h }), 0.35),
    "--st-progress-bg": sel,
    "--st-progress": selFg,
    "--btn-off-bg": dark ? "#2c2c2e" : tint(0.93, 0.02, 0.2),
    "--btn-off-fg": dark ? "#98989f" : tint(0.5, 0.04, 0.3),
    "--glow": rgba(ring, dark ? 0.22 : 0.13),
    "--shadow-brand": `0 16px 32px -20px ${rgba(brand, dark ? 0.55 : 0.7)}`,
    "--hero-1": brand,
    "--hero-2": shade(-0.02),
    "--hero-3": shade(-0.05),
    "--pill-fg": ensureContrast(shade(-0.05), "#ffffff", 4.5),
    "--acc-on-dark": accOnDark,
    "--ob-10": rgba(ob, 0.1),
    "--ob-16": rgba(ob, 0.16),
    "--ob-24": rgba(ob, 0.24),
    "--ob-28": rgba(ob, 0.28),
    "--ob-35": rgba(ob, 0.35),
  };
  // Art outlines and plate text: the same dark brand-hued ink in both modes
  const ka = toOklch(accent);
  v["--ink"] = fromOklch({ L: 0.27, C: Math.min(0.08, ka.C * 0.5), h: ka.h });
  return v;
}

const native = (v: Vars, dark: boolean): NativeColors => ({
  main: [v["--brand"], v["--on-brand"]],
  mainOff: dark ? ["#2c2c2e", "#98989f"] : [v["--btn-off-bg"], v["--btn-off-fg"]],
  secondary: [v["--sel"], v["--sel-fg"]],
});

export function themeFor(brand: Pick<BrandInfo, "preset" | "accent">): Theme {
  const r = resolveAccents(brand);
  const isDefault = r.preset && brand.preset === DEFAULT_PRESET;
  const light = isDefault ? COBALT_LIGHT : deriveVars(r.accent, r.accentDark, false);
  const dark = isDefault ? COBALT_DARK : deriveVars(r.accent, r.accentDark, true);
  return { accent: r.accent, accentDark: r.accentDark, light, dark, nativeLight: native(light, false), nativeDark: native(dark, true) };
}

const block = (vars: Vars) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/**
 * CSS for the injected <style id="brand-theme">. `html[...]:root` beats the base blocks in styles.css whatever the
 * order of the stylesheets.
 */
export function themeCss(brand: Pick<BrandInfo, "preset" | "accent">): string {
  const t = themeFor(brand);
  return `html[data-theme="light"]:root{${block(t.light)}}html[data-theme="dark"]:root{${block(t.dark)}}`;
}

/** First letter of the brand name for the monogram (whole characters, so emoji survive). */
export function monogram(name: string): string {
  return (Array.from(name.trim())[0] ?? "N").toLocaleUpperCase();
}
