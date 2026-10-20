// UI translations. English is bundled; other languages load on demand.
import { type Lang, pickLang, RTL_LANGS } from "../shared/types";
import { createStore } from "./store";
import { en, type Key } from "./i18n/en";

const loaders = import.meta.glob<{ default: Record<string, string> }>("./i18n/*.json");
const langStore = createStore<{ lang: Lang; dict: Record<string, string> }>({ lang: "en", dict: en });

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
  if (lang !== "en") {
    const load = loaders[`./i18n/${lang}.json`];
    dict = { ...en, ...(load ? (await load()).default : {}) };
  }
  if (seq !== langSeq) return; // a newer choice arrived while this one was loading
  const root = document.documentElement;
  root.lang = lang;
  root.dir = RTL_LANGS.includes(lang) ? "rtl" : "ltr";
  langStore.set({ lang, dict });
}

let uiBrand = "NotBot";

/** Sets the brand name that fills {brand} in every UI text; re-renders anything using useLang(). */
export function setUiBrand(name: string) {
  const next = name.trim();
  if (!next || next === uiBrand) return;
  uiBrand = next;
  langStore.set((s) => ({ ...s })); // new object so subscribers re-render
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
