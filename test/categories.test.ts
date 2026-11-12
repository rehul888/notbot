import { describe, expect, it } from "vitest";
import { LANGS } from "../shared/types";

type CatDict = { n?: Record<string, string>; p?: Record<string, string> };
const FILES = import.meta.glob("../src/i18n/cat/*.json", { eager: true, import: "default" }) as Record<string, CatDict>;
const dict = (lang: string) => FILES[`../src/i18n/cat/${lang}.json`];

describe("category name translations", () => {
  it("exist for every language but English", () => {
    for (const l of LANGS.filter((l) => l !== "en")) expect(dict(l), l).toBeTruthy();
  });

  it("cover the parts every language needs, with no empty values", () => {
    const parts = Object.keys(dict("de").p ?? {});
    expect(parts.length).toBeGreaterThan(200);
    for (const l of LANGS.filter((l) => l !== "en")) {
      const d = dict(l);
      for (const v of [...Object.values(d.n ?? {}), ...Object.values(d.p ?? {})]) expect(v.trim(), l).not.toBe("");
      // Languages without NotPanel's whole-name table translate every part
      if (!d.n) expect(Object.keys(d.p ?? {}).sort(), l).toEqual([...parts].sort());
    }
  });

  it("translate a common category in every language", () => {
    for (const l of LANGS.filter((l) => l !== "en")) {
      const d = dict(l);
      const name = d.n?.["Views - Post - Worldwide"] ?? "Views - Post - Worldwide".split(" - ").map((p) => d.p?.[p] ?? p).join(" - ");
      expect(name, l).not.toBe("Views - Post - Worldwide");
    }
  });
});
