import { describe, expect, it } from "vitest";
import { LANGS } from "../shared/types";
import { en } from "../src/i18n/en";
import botStrings from "../worker/bot-strings.json";
import { BOT_EN, botPlain, botText, setBotBrand } from "../worker/i18n";
import { botAboutFor } from "../worker/bot-about";
import { LIMITS } from "../shared/brand";

// Every non-English UI dictionary (20 languages incl. English), loaded the same way the app loads them (src/i18n/*.json).
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
    const keep = ["{brand}", "⭐", "👋"];
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

describe("brand placeholder", () => {
  const botAll = botStrings as Record<string, Record<string, string>>;
  const texts: [string, string][] = [
    ...Object.entries(enDict).map(([k, v]) => [`ui en ${k}`, v] as [string, string]),
    ...Object.entries(dicts).flatMap(([l, d]) => Object.entries(d).map(([k, v]) => [`ui ${l} ${k}`, v] as [string, string])),
    ...Object.entries(BOT_EN).map(([k, v]) => [`bot en ${k}`, v] as [string, string]),
    ...Object.entries(botAll).flatMap(([l, d]) => Object.entries(d).map(([k, v]) => [`bot ${l} ${k}`, v] as [string, string])),
  ];

  it("never names NotPanel in a translation", () => {
    expect(texts.filter(([, v]) => /notpanel/i.test(v)).map(([k]) => k)).toEqual([]);
  });

  it("spells every brand placeholder exactly {brand}", () => {
    const bad = texts.filter(([, v]) => /\{\s*brand\s*\}/i.test(v.replace(/\{brand\}/g, "")) || /\{(?!\w+\})/.test(v));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("fills {brand} in bot texts, escaping it only for HTML", () => {
    setBotBrand("A&B");
    expect(botText("en", "cmdStart")).toBe("Open A&amp;B");
    expect(botPlain("en", "cmdStart")).toBe("Open A&B");
    expect(botPlain("en", "cmdStart", { brand: "X" })).toBe("Open X");
    setBotBrand("NotBot");
  });
});

describe("botAboutFor", () => {
  it.each(["NotBot", "B".repeat(LIMITS.brandName), "😀".repeat(LIMITS.brandName / 2), "Ж".repeat(LIMITS.brandName)])(
    "stays within Telegram limits for brand %#",
    (brand) => {
      const about = botAboutFor(brand);
      expect(Object.keys(about).sort()).toEqual([...LANGS].sort());
      for (const a of Object.values(about)) {
        expect(a.name.length).toBeLessThanOrEqual(64);
        expect(a.short.length).toBeLessThanOrEqual(120);
        expect(a.description.length).toBeLessThanOrEqual(512);
        expect(a.name).toContain(brand);
        expect(a.description).toContain(brand);
        expect(/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(a.name + a.description)).toBe(false);
        expect(/notpanel|\$\{/i.test(a.name + a.short + a.description)).toBe(false);
      }
    },
  );

  it("trims an over-long brand without splitting a surrogate pair", () => {
    const a = botAboutFor("😀".repeat(60));
    expect(a.en.name.length).toBeLessThanOrEqual(64);
    expect([...a.en.name].every((c) => c !== "\ufffd")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(a.en.name)).toBe(false);
  });
});
