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

/** Switches the UI language. Always updates <html lang/dir> (English included), together with the strings. */
export async function setLang(code: string | null | undefined) {
  const lang = pickLang(code);
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

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const tpl = langStore.get().dict[key] ?? en[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
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
