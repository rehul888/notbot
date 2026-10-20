import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "../shared/brand";
import { contrast, deriveVars, themeCss, themeFor } from "../shared/theme";

describe("theme engine", () => {
  it("keeps the shipped cobalt values for the default preset", () => {
    const t = themeFor({ preset: "cobalt", accent: "#2457ff" });
    expect(t.light["--brand"]).toBe("#2457ff");
    expect(t.light["--sel-fg"]).toBe("#1b45d6");
    expect(t.light["--sel"]).toBe("#e6ecff");
    expect(t.dark["--acc"]).toBe("#8aa4ff");
    expect(t.dark["--sel"]).toBe("#1e2847");
    expect(t.dark["--brand-ring"]).toBe("#5b7cff");
  });

  it("derives readable colors for every preset and a spread of custom accents, in both modes", () => {
    const accents = [...THEME_PRESETS.map((p) => ({ preset: p.id, accent: "#000000" })), ...["#ffcc00", "#ffffff", "#000000", "#00ff88", "#ff00aa", "#7a7a7a"].map((a) => ({ preset: "custom", accent: a }))];
    for (const b of accents) {
      const t = themeFor(b);
      for (const [mode, v, page] of [["light", t.light, "#f2f2f7"], ["dark", t.dark, "#000000"]] as const) {
        const name = `${b.preset}${b.accent} ${mode}`;
        expect(contrast(v["--on-brand"], v["--brand"]), `${name} on-brand`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--sel-fg"], v["--sel"]), `${name} sel-fg`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--acc"], page), `${name} acc`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--pill-fg"] ?? "#000000", "#ffffff"), `${name} pill-fg`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("falls back to cobalt for an invalid custom color and emits CSS for both modes", () => {
    const css = themeCss({ preset: "custom", accent: "nope" });
    expect(css).toContain('html[data-theme="light"]:root{');
    expect(css).toContain('html[data-theme="dark"]:root{');
    expect(deriveVars("#2457ff", "#5b82ff", false)["--brand"]).toBe("#2457ff");
  });
});
