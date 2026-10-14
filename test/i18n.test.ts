import { describe, expect, it } from "vitest";
import { LANGS } from "../shared/types";
import { en } from "../src/i18n/en";

// Every non-English UI dictionary, loaded the same way the app loads them (src/i18n/*.json).
const modules = import.meta.glob<Record<string, string>>("../src/i18n/*.json", { eager: true, import: "default" });
const dicts: Record<string, Record<string, string>> = {};
for (const [path, dict] of Object.entries(modules)) dicts[/([\w-]+)\.json$/.exec(path)![1]] = dict;

const enDict: Record<string, string> = en;
const otherLangs = LANGS.filter((l) => l !== "en");
const enKeys = Object.keys(enDict);

/** Placeholder names in a template, like t() reads them: {name}. Sorted and unique. */
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
/** Length in visible characters (grapheme clusters), so combining marks in Hindi and Arabic are not over-counted. */
const segmenter = new Intl.Segmenter();
const len = (s: string) => [...segmenter.segment(s)].length;

describe("i18n files", () => {
  it("has one dictionary per supported language and no others", () => {
    expect(Object.keys(dicts).sort()).toEqual([...otherLangs].sort());
  });

  it("has English strings for every key", () => {
    for (const k of enKeys) expect(enDict[k].trim(), k).not.toBe("");
  });
});

describe.each(otherLangs)("i18n %s", (lang) => {
  const dict = dicts[lang] ?? {};

  it("has every English key", () => {
    expect(enKeys.filter((k) => !(k in dict))).toEqual([]);
  });

  it("has no keys that English does not have", () => {
    expect(Object.keys(dict).filter((k) => !(k in enDict))).toEqual([]);
  });

  it("has non-empty string values", () => {
    for (const [k, v] of Object.entries(dict)) {
      expect(typeof v, k).toBe("string");
      expect(v.trim(), k).not.toBe("");
    }
  });

  it("uses the same placeholders as English", () => {
    const bad = enKeys
      .filter((k) => typeof dict[k] === "string" && placeholders(dict[k]).join() !== placeholders(enDict[k]).join())
      .map((k) => `${k}: en {${placeholders(enDict[k])}} vs ${lang} {${placeholders(dict[k])}}`);
    expect(bad).toEqual([]);
  });

  it("has no stray braces outside placeholders", () => {
    const bad = Object.entries(dict).filter(([, v]) => /[{}]/.test(v.replace(/\{\w+\}/g, "")));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("keeps brand names and emoji from English", () => {
    const keep = ["NotPanel", "⭐", "👋"];
    const bad = enKeys.filter((k) => typeof dict[k] === "string" && keep.some((m) => enDict[k].includes(m) && !dict[k].includes(m)));
    expect(bad).toEqual([]);
  });

  it("keeps native button labels short enough", () => {
    // Tab labels: 12 characters or fewer. form.addFunds is a Telegram MainButton label: 24 or fewer with a typical amount.
    for (const k of ["tab.new", "tab.orders", "tab.wallet", "tab.profile"]) expect(len(dict[k]), k).toBeLessThanOrEqual(12);
    expect(len(dict["form.addFunds"].replace("{amount}", "$999.99")), "form.addFunds").toBeLessThanOrEqual(24);
  });
});

describe("i18n en", () => {
  it("keeps native button labels short enough", () => {
    for (const k of ["tab.new", "tab.orders", "tab.wallet", "tab.profile"]) expect(len(enDict[k]), k).toBeLessThanOrEqual(12);
    expect(len(enDict["form.addFunds"].replace("{amount}", "$999.99"))).toBeLessThanOrEqual(24);
  });
});
