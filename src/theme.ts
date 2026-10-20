// Runtime branding: applies the owner's colors (one <style id="brand-theme">), name, logo, tab title and favicon.
// The last brand is cached in localStorage; index.html paints it before the bundle loads (no color flash).
import { DEFAULT_PRESET, THEME_PRESETS, type BrandInfo } from "../shared/brand";
import { monogram, themeCss, themeFor, type Theme } from "../shared/theme";
import { setUiBrand } from "./i18n";
import { createStore } from "./store";

export const DEFAULT_BRAND: BrandInfo = {
  name: "NotBot",
  logoUrl: null,
  preset: DEFAULT_PRESET,
  accent: THEME_PRESETS[0].accent,
  websiteUrl: null,
  termsUrl: null,
};

const CACHE_BRAND = "np_brand";
const CACHE_CSS = "np_brand_css";

function readCached(): BrandInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_BRAND);
    if (!raw) return null;
    const b = JSON.parse(raw) as BrandInfo;
    return b && typeof b.name === "string" && typeof b.preset === "string" ? { ...DEFAULT_BRAND, ...b } : null;
  } catch {
    return null;
  }
}

/** True when a brand from an earlier visit is cached (so the first paint already has the right colors). */
export const hasCachedBrand = readCached() !== null;

export const brandStore = createStore<BrandInfo>(readCached() ?? DEFAULT_BRAND);
/** Native Telegram buttons can't read CSS variables; tg.ts reads their colors here. */
export const themeStore = createStore<Theme>(themeFor(brandStore.get()));

function styleEl(): HTMLStyleElement {
  let el = document.getElementById("brand-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "brand-theme";
    document.head.appendChild(el);
  }
  return el;
}

function faviconHref(b: BrandInfo, theme: Theme): string {
  if (b.logoUrl) return b.logoUrl;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${theme.light["--brand"]}"/>` +
    `<text x="32" y="33" font-family="system-ui,sans-serif" font-size="34" font-weight="700" fill="${theme.light["--on-brand"]}" text-anchor="middle" dominant-baseline="central">${monogram(b.name).replace(/[<>&"]/g, "")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.removeAttribute("type");
  link.href = href;
}

/**
 * Applies a brand to the whole page. `persist: false` is for live previews in the admin panel (not cached, and the
 * name and links stay as they are).
 */
export function applyBrand(b: BrandInfo, opts: { persist?: boolean } = {}) {
  const persist = opts.persist !== false;
  if (persist && JSON.stringify(b) === JSON.stringify(brandStore.get()) && document.getElementById("brand-theme")?.textContent === themeCss(b)) return;
  const css = themeCss(b);
  const theme = themeFor(b);
  styleEl().textContent = css;
  brandStore.set(b);
  themeStore.set(theme);
  if (!persist) return;
  setUiBrand(b.name);
  document.title = b.name;
  setFavicon(faviconHref(b, theme));
  try {
    localStorage.setItem(CACHE_BRAND, JSON.stringify(b));
    localStorage.setItem(CACHE_CSS, JSON.stringify({ css, name: b.name }));
  } catch {
    /* storage unavailable */
  }
}

/** Live preview of colors only (admin Branding page). Call applyBrand(savedBrand) to go back. */
export function previewColors(base: BrandInfo, preset: string, accent: string) {
  applyBrand({ ...base, preset, accent }, { persist: false });
}

// First paint: index.html already injected the cached CSS; make sure stores, title and favicon agree.
{
  const b = brandStore.get();
  setUiBrand(b.name);
  document.title = b.name;
  if (hasCachedBrand) {
    if (!document.getElementById("brand-theme")) styleEl().textContent = themeCss(b);
    setFavicon(faviconHref(b, themeStore.get()));
  }
}
