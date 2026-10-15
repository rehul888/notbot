import { describe, expect, it } from "vitest";
import { notpanelSignature, toHex, validateInitData } from "../worker/auth";
import { checkDraft, orderCharge, sellRate } from "../worker/pricing";
import { platformName } from "../shared/platforms";
import { cancelOrder, OrderError, placeOrder, refillOrder, type OrderRow } from "../worker/orders";
import type { Env } from "../worker/env";

const enc = new TextEncoder();
async function hmac(key: Uint8Array<ArrayBuffer> | ArrayBuffer, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
async function signInitData(token: string, fields: Record<string, string>) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), token);
  const hash = toHex(await hmac(secret, check));
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("pricing", () => {
  it("adds markup and rounds up to $0.0001", () => {
    expect(sellRate(52_000, 30, null)).toBe(67_600);
    expect(sellRate(5_200, 30, null)).toBe(6_800); // 0.00676 → 0.0068
    expect(sellRate(52_000, 30, 90_000)).toBe(90_000); // fixed price wins
  });
  it("charges per 1,000 and whole packages", () => {
    expect(orderCharge(130_000, 1000, "free")).toBe(130_000);
    expect(orderCharge(130_000, 10, "free")).toBe(1_300);
    expect(orderCharge(103_125_000, 1, "fixed")).toBe(103_125_000);
    expect(orderCharge(1, 1, "free")).toBe(1); // never zero
  });
  it("validates drafts", () => {
    const svc = { type_key: "default", min: 10, max: 1000, step: 1, fields: [], dripfeed: false, dripMax: null };
    expect(checkDraft(svc, { link: "https://t.me/x/1", quantity: 5 })).toEqual({ error: "MINIMUM_QUANTITY", details: { n: 10 } });
    expect(checkDraft(svc, { link: "", quantity: 50 })).toEqual({ error: "INVALID_LINK" });
    expect(checkDraft(svc, { link: "https://t.me/x/1", quantity: 50 })).toEqual({ quantity: 50, fields: {} });
    const comments = { ...svc, min: 1, type_key: "custom_comments", fields: [{ key: "comments", kind: "lines" as const, required: true, label: "" }] };
    expect(checkDraft(comments, { link: "https://x.com/a", fields: { comments: "a\n\nb\n c " } })).toEqual({
      quantity: 3,
      fields: { comments: "a\nb\nc" },
    } as never);
  });
});

describe("draft input hardening", () => {
  const base = { type_key: "default", min: 1, max: 1000, step: 1, dripfeed: true, dripMax: 600 };
  const text = { key: "note", kind: "text" as const, required: false, label: "" };
  const lines = { key: "comments", kind: "lines" as const, required: false, label: "", max_length: 5 };
  const link = "https://t.me/x/1";

  it("rejects a non-string link", () => {
    expect(checkDraft(base as never, { link: 123 as never, quantity: 5 } as never)).toEqual({ error: "INVALID_LINK" });
    expect(checkDraft(base as never, { link: ["https://t.me/x"] as never, quantity: 5 } as never)).toEqual({ error: "INVALID_LINK" });
  });
  it("rejects non-string field values", () => {
    const svc = { ...base, fields: [text] };
    expect(checkDraft(svc as never, { link, quantity: 5, fields: { note: 5 } as never })).toMatchObject({ error: "INVALID_FIELD" });
    expect(checkDraft(svc as never, { link, quantity: 5, fields: { note: { a: 1 } } as never })).toMatchObject({ error: "INVALID_FIELD" });
    expect(checkDraft(svc as never, { link, quantity: 5, fields: { other: 5 } as never })).toMatchObject({ error: "INVALID_FIELD" });
    expect(checkDraft(svc as never, { link, quantity: 5, fields: ["x"] as never })).toMatchObject({ error: "INVALID_FIELD" });
  });
  it("ignores inherited object keys", () => {
    const svc = { ...base, fields: [{ ...text, key: "constructor" }] };
    expect(checkDraft(svc as never, { link, quantity: 5, fields: {} })).toEqual({ quantity: 5, fields: {} });
  });
  it("caps field lengths", () => {
    const svc = { ...base, fields: [text] };
    expect(checkDraft(svc as never, { link, quantity: 5, fields: { note: "a".repeat(2000) } })).toMatchObject({ quantity: 5 });
    expect(checkDraft(svc as never, { link, quantity: 5, fields: { note: "a".repeat(2001) } })).toMatchObject({ error: "INVALID_FIELD" });
    const withMax = { ...base, fields: [{ ...text, max_length: 3000 }] };
    expect(checkDraft(withMax as never, { link, quantity: 5, fields: { note: "a".repeat(3000) } })).toMatchObject({ quantity: 5 });
  });
  it("caps lines fields", () => {
    const svc = { ...base, type_key: "custom_comments", min: 1, max: 20000, fields: [lines] };
    expect(checkDraft(svc as never, { link, fields: { comments: "abcdef" } })).toMatchObject({ error: "INVALID_FIELD" });
    expect(checkDraft(svc as never, { link, fields: { comments: Array(10_000).fill("a").join("\n") } })).toMatchObject({ quantity: 10_000 });
    expect(checkDraft(svc as never, { link, fields: { comments: Array(10_001).fill("a").join("\n") } })).toMatchObject({ error: "INVALID_FIELD" });
  });
  it("validates drip-feed minutes", () => {
    const svc = { ...base, fields: [] };
    expect(checkDraft(svc, { link, quantity: 5, dripMinutes: 60 })).toEqual({ quantity: 5, fields: {} });
    for (const bad of [0, -1, 1.5, 601, Number.NaN, "60" as never, Infinity])
      expect(checkDraft(svc, { link, quantity: 5, dripMinutes: bad })).toMatchObject({ error: expect.stringMatching(/DRIP_FEED/) });
    expect(checkDraft(svc, { link, quantity: 5, dripMinutes: 1.5 })).toEqual({ error: "DRIP_FEED_INVALID" });
    expect(checkDraft({ ...svc, dripfeed: false }, { link, quantity: 5, dripMinutes: 5 })).toEqual({ error: "DRIP_FEED_NOT_AVAILABLE" });
  });
});

describe("platform names", () => {
  it("never returns prototype values", () => {
    expect(platformName("telegram")).toBe("Telegram");
    expect(platformName("constructor")).toBe("Constructor");
    expect(platformName("__proto__")).toBe("__proto__");
    expect(platformName("toString")).toBe("ToString");
    expect(platformName("new-site")).toBe("New Site");
  });
});

describe("dev order guard", () => {
  const dev = { DEV_FAKE_USER_ID: "1" } as unknown as Env;
  const svc = { id: 1, name: "n", platform: "p", category: "c", rate: 1000, quantityMode: "free", cost: 1 } as never;
  it("refuses place, cancel and refill in dev before touching anything", async () => {
    await expect(placeOrder(dev, 1, svc, "https://x.y", 10, {}, undefined)).rejects.toMatchObject({ code: "DEV_ORDERS_DISABLED" });
    await expect(cancelOrder(dev, { np_order_id: 5 } as OrderRow)).rejects.toBeInstanceOf(OrderError);
    await expect(refillOrder(dev, { np_order_id: 5 } as OrderRow)).rejects.toMatchObject({ code: "DEV_ORDERS_DISABLED" });
  });
});

describe("telegram initData", () => {
  const token = "123456:TEST";
  const user = JSON.stringify({ id: 42, first_name: "A" });
  it("accepts a correctly signed payload", async () => {
    const now = 1_800_000_000;
    const raw = await signInitData(token, { auth_date: String(now), user, query_id: "q" });
    const r = await validateInitData(raw, token, 86400, now + 10);
    expect(r?.user.id).toBe(42);
  });
  it("rejects tampering, wrong token and stale data", async () => {
    const now = 1_800_000_000;
    const raw = await signInitData(token, { auth_date: String(now), user });
    expect(await validateInitData(raw.replace("42", "43"), token, 86400, now)).toBeNull();
    expect(await validateInitData(raw, "999:OTHER", 86400, now)).toBeNull();
    expect(await validateInitData(raw, token, 86400, now + 90000)).toBeNull();
  });
});

describe("notpanel webhook signature", () => {
  it("is HMAC-SHA256 of timestamp.body", async () => {
    const sig = await notpanelSignature("secret", "1700000000", '{"a":1}');
    const expected = toHex(await hmac(enc.encode("secret"), '1700000000.{"a":1}'));
    expect(sig).toBe(expected);
  });
});

describe("custom emoji", () => {
  it("wraps known emojis (with or without the variation selector) and leaves others", async () => {
    const { withCustomEmoji } = await import("../worker/telegram");
    const out = withCustomEmoji("✅ <b>Done</b> ⭐️ ⭐ 🔢");
    expect(out).toContain('<tg-emoji emoji-id="5985596818912712352">✅</tg-emoji>');
    expect(out.match(/emoji-id="5258039825805624495"/g)?.length).toBe(2);
    expect(out).toContain("🔢"); // no custom emoji for quantity
    expect(out).not.toContain('">🔢');
  });
});

describe("dollars stored, Stars shown", () => {
  it("charges exact micro-USD and shows prices rounded up to whole Stars", async () => {
    const { orderCharge } = await import("../worker/pricing");
    const { shownStars } = await import("../shared/stars");
    expect(orderCharge(6_800, 1000, "free")).toBe(6_800); // $0.0068 per 1K, 1K → exactly $0.0068
    expect(orderCharge(6_800, 1500, "free")).toBe(10_200);
    expect(orderCharge(3, 10, "free")).toBe(1); // never below $0.000001
    expect(orderCharge(150_000, 1, "fixed")).toBe(150_000);
    expect(shownStars(15_584, 77)).toBe(2); // $0.015584 × 77 = 1.2 ⭐ → shown 2 ⭐
    expect(shownStars(6_800, 77)).toBe(1); // 0.52 ⭐ → 1 ⭐
    expect(shownStars(1_000_000, 77)).toBe(77); // exactly $1 → 77 ⭐
    expect(shownStars(-15_584, 77)).toBe(-2);
    expect(shownStars(0, 77)).toBe(0);
  });

  it("credits the dollar value of Stars paid, and shows it back as the same Stars", async () => {
    const { starsCredit, shownStars, balanceStars } = await import("../shared/stars");
    expect(starsCredit(1, 77)).toBe(12_988); // 1 ⭐ → $0.012988
    expect(starsCredit(77, 77)).toBe(1_000_000);
    for (const rate of [50, 77, 77.5, 100, 333]) {
      for (const n of [1, 3, 50, 99, 100, 250, 1234, 10_000]) {
        expect(shownStars(starsCredit(n, rate), rate)).toBe(n);
        expect(balanceStars(starsCredit(n, rate), rate)).toBe(n);
      }
    }
  });

  it("never shows a balance above what the user has", async () => {
    const { balanceStars, starsCredit } = await import("../shared/stars");
    expect(balanceStars(starsCredit(100, 77) - 15_584, 77)).toBe(98); // 100 ⭐ - 1.2 ⭐ = 98.8 ⭐ → 98 ⭐
    expect(balanceStars(12_987, 77)).toBe(0); // 0.99999 ⭐ → 0 ⭐
    expect(balanceStars(0, 77)).toBe(0);
  });

  it("asks for the fewest Stars whose credit covers an order", async () => {
    const { starsToCover, starsCredit } = await import("../shared/stars");
    for (const rate of [50, 77, 77.5, 100, 333]) {
      for (const m of [1, 999, 12_987, 12_988, 12_989, 15_584, 1_000_000, 1_234_567]) {
        const n = starsToCover(m, rate);
        expect(starsCredit(n, rate)).toBeGreaterThanOrEqual(m);
        expect(n === 1 || starsCredit(n - 1, rate) < m).toBe(true);
      }
    }
  });
});

describe("refunds", () => {
  it("refunds the full charge when canceled, and rounds partial refunds up (never above the charge)", async () => {
    const { refundFor } = await import("../worker/orders");
    const o = { id: 1, charge: 19, quantity: 1000 } as never;
    expect(refundFor(o, "cancelled", null)).toBe(19); // canceled, nothing delivered → everything back
    expect(refundFor(o, "cancelled", 1000)).toBe(19);
    expect(refundFor(o, "partial", 10)).toBe(1); // 0.19 → 1 (rounded up, not 0)
    expect(refundFor(o, "partial", 500)).toBe(10); // 9.5 → 10
    expect(refundFor(o, "partial", 1000)).toBe(19); // capped at the charge
    expect(refundFor(o, "completed", 0)).toBe(0);
  });
});
