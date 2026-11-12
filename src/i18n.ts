// UI translations. English is bundled; other languages load on demand.
import { type Lang, pickLang, RTL_LANGS } from "../shared/types";
import { createStore } from "./store";
import { en, type Key } from "./i18n/en";

const loaders = import.meta.glob<{ default: Record<string, string> }>("./i18n/*.json");
// NotPanel's category names ("Views - Post - Worldwide"): whole names (n, from NotPanel's own translations) and
// the parts between " - " (p), so a new category made of known parts is translated too.
type CatDict = { n?: Record<string, string>; p?: Record<string, string> };
const catLoaders = import.meta.glob<{ default: CatDict }>("./i18n/cat/*.json");
const langStore = createStore<{ lang: Lang; dict: Record<string, string>; cat: CatDict }>({ lang: "en", dict: en, cat: {} });

export function getLang(): Lang {
  return langStore.get().lang;
}

let langSeq = 0;

/** The language chosen last time, so translations can load before /me answers. */
export function savedLang(): string | null {
  try {
    return localStorage.getItem("np_lang");
  } catch {
    return null;
  }
}

/** Switches the UI language. Always updates <html lang/dir> (English included), together with the strings. */
export async function setLang(code: string | null | undefined) {
  const lang = pickLang(code);
  try {
    localStorage.setItem("np_lang", lang);
  } catch {
    /* storage unavailable */
  }
  const seq = ++langSeq;
  let dict: Record<string, string> = en;
  let cat: CatDict = {};
  if (lang !== "en") {
    const load = loaders[`./i18n/${lang}.json`];
    const loadCat = catLoaders[`./i18n/cat/${lang}.json`];
    const [d, c] = await Promise.all([load ? load() : null, loadCat ? loadCat().catch(() => null) : null]);
    dict = { ...en, ...(d?.default ?? {}) };
    cat = c?.default ?? {};
  }
  if (seq !== langSeq) return; // a newer choice arrived while this one was loading
  const root = document.documentElement;
  root.lang = lang;
  root.dir = RTL_LANGS.includes(lang) ? "rtl" : "ltr";
  langStore.set({ lang, dict, cat });
}

let uiBrand = "NotBot";

/** Sets the brand name that fills {brand} in every UI text; re-renders anything using useLang(). */
export function setUiBrand(name: string) {
  const next = name.trim();
  if (!next || next === uiBrand) return;
  uiBrand = next;
  langStore.set((s) => ({ ...s })); // new object so subscribers re-render
}

/** A NotPanel category name in the UI language; unknown parts stay in English. */
export function catName(name: string): string {
  const { n, p } = langStore.get().cat;
  if (!name || (!n && !p)) return name;
  return n?.[name] ?? name.split(" - ").map((part) => p?.[part] ?? part).join(" - ");
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const tpl = langStore.get().dict[key] ?? en[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? (k === "brand" ? uiBrand : "")));
}

/** Translates an API error code, falling back to a generic message */
export function tErr(code: string, details?: Record<string, any>): string {
  const key = `err.${code}` as Key;
  if (!(key in en)) return t(code === "NETWORK" ? "common.offline" : "common.error");
  return t(key, details ?? {});
}

/** Re-render on language change */
export const useLang = () => langStore.use();
export type { Key };
