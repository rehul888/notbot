import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("wraps configured emojis (with or without the variation selector) and leaves others", async () => {
    const { withCustomEmoji } = await import("../worker/telegram");
    const out = withCustomEmoji("✅ <b>Done</b> ⭐️ ⭐ 🔢", { "✅": "5985596818912712352", "⭐": "5258039825805624495" });
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

// ---- Open-source / white-label additions ----

const GOOD_KEY = "np_live_" + "a1b2c3d4".repeat(5); // np_live_ + 40 hex-like chars
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NotPanel key gate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only np_live_ keys of a sane length", async () => {
    const { looksLikeNotPanelKey } = await import("../shared/brand");
    expect(looksLikeNotPanelKey(GOOD_KEY)).toBe(true);
    expect(looksLikeNotPanelKey(`  ${GOOD_KEY}  `)).toBe(true);
    for (const bad of ["", "np_live_", "np_live_short", "sk_live_" + "a".repeat(40), "np_test_" + "a".repeat(40), GOOD_KEY + "!", "x" + GOOD_KEY, 123, null])
      expect(looksLikeNotPanelKey(bad)).toBe(false);
  });

  it("np() refuses a foreign key before any network call", async () => {
    const { np, NotPanelError } = await import("../worker/notpanel");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const e = await np("sk_live_" + "a".repeat(40), "balance").catch((x) => x);
    expect(e).toBeInstanceOf(NotPanelError);
    expect(e).toMatchObject({ code: "INVALID_KEY", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("npKey prefers the saved key over the secret", async () => {
    const { npKey } = await import("../worker/notpanel");
    expect(npKey({ NOTPANEL_API_KEY: "env" }, { np_api_key: "" })).toBe("env");
    expect(npKey({ NOTPANEL_API_KEY: "env" }, { np_api_key: " saved " })).toBe("saved");
    expect(npKey({}, { np_api_key: "" })).toBe("");
  });

  it("verifyNotPanelKey needs NotPanel-shaped balance and catalog answers", async () => {
    const { verifyNotPanelKey } = await import("../worker/notpanel");
    const catalog = { catalog_updated_at: "2026-10-20T00:00:00Z", total_pages: 12, items: [{ service: "1", platform: { slug: "telegram", name: "Telegram" } }] };
    const answer = (balance: unknown, cat: unknown) =>
      vi.fn(async (_url: unknown, init: { body: URLSearchParams }) => jsonResponse(init.body.get("action") === "balance" ? balance : cat));

    vi.stubGlobal("fetch", answer({ balance: "12.50", currency: "USD" }, catalog));
    expect(await verifyNotPanelKey(GOOD_KEY)).toEqual({ ok: true });

    // Not even key-shaped: no request at all
    const none = vi.fn();
    vi.stubGlobal("fetch", none);
    expect(await verifyNotPanelKey("nope")).toMatchObject({ ok: false, code: "NOT_NOTPANEL_KEY" });
    expect(none).not.toHaveBeenCalled();

    // Some other service answering: wrong shapes
    vi.stubGlobal("fetch", answer({ ok: true }, catalog));
    expect(await verifyNotPanelKey(GOOD_KEY)).toMatchObject({ ok: false, code: "NOT_NOTPANEL_KEY" });
    vi.stubGlobal("fetch", answer({ balance: "1", currency: "USD" }, { items: [] }));
    expect(await verifyNotPanelKey(GOOD_KEY)).toMatchObject({ ok: false, code: "NOT_NOTPANEL_KEY" });
    vi.stubGlobal("fetch", answer({ balance: "1", currency: "USD" }, { ...catalog, items: [{ service: "1", platform: { slug: 5 } }] }));
    expect(await verifyNotPanelKey(GOOD_KEY)).toMatchObject({ ok: false, code: "NOT_NOTPANEL_KEY" });

    // NotPanel itself says no
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Invalid API key", error_code: "INVALID_KEY", retryable: false }, 401)));
    expect(await verifyNotPanelKey(GOOD_KEY)).toEqual({ ok: false, code: "NOTPANEL_REJECTED", message: "Invalid API key" });
  });
});

describe("setup token", () => {
  const bot = "123456:TEST-TOKEN";
  it("verifies a fresh token and rejects expiry, tampering and other bot tokens", async () => {
    const { signSetupToken, verifySetupToken } = await import("../worker/auth");
    const now = 1_800_000_000;
    const t = await signSetupToken(bot, now, 1800);
    expect(await verifySetupToken(bot, t, now + 10)).toBe(true);
    expect(await verifySetupToken(bot, t, now + 1799)).toBe(true);
    expect(await verifySetupToken(bot, t, now + 1800)).toBe(false);
    expect(await verifySetupToken("999:OTHER", t, now + 10)).toBe(false);
    const [payload, sig] = t.split(".");
    const longer = Buffer.from(JSON.stringify({ exp: now + 99999 })).toString("base64url");
    expect(await verifySetupToken(bot, `${longer}.${sig}`, now + 10)).toBe(false);
    expect(await verifySetupToken(bot, `${payload}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`, now + 10)).toBe(false);
    for (const junk of ["", ".", "a.b.c", payload, `${payload}.`, "not a token"]) expect(await verifySetupToken(bot, junk, now)).toBe(false);
  });

  it("derives the webhook secret from the bot token unless one is configured", async () => {
    const { webhookSecret } = await import("../worker/auth");
    const derived = await webhookSecret({ BOT_TOKEN: bot });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).toBe(toHex(await hmac(enc.encode(bot), "notbot-webhook")));
    expect(await webhookSecret({ BOT_TOKEN: bot, TG_WEBHOOK_SECRET: "custom" })).toBe("custom");
    expect(await webhookSecret({ BOT_TOKEN: "999:OTHER" })).not.toBe(derived);
  });
});

describe("admin claim code", () => {
  it("hashes codes, never storing the plain one, and checks shape", async () => {
    const { hashClaimCode, claimCodeShape } = await import("../worker/claim");
    const { randomCode } = await import("../worker/auth");
    const code = randomCode(20);
    expect(claimCodeShape(code)).toBe(true);
    expect(code).not.toBe(randomCode(20));
    const h = await hashClaimCode(code);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(await hashClaimCode(code)).toBe(h);
    expect(await hashClaimCode(code + "x")).not.toBe(h);
    for (const bad of ["", "short", "UPPERCASE" + "a".repeat(20), "a".repeat(41), "has space " + "a".repeat(20)]) expect(claimCodeShape(bad)).toBe(false);
  });

  it("is open only while a code is stored, unexpired and nobody is an admin", async () => {
    const { claimOpen } = await import("../worker/claim");
    const now = 1_800_000_000;
    const s = { claim_code_hash: "abc", claim_expires: now + 3600 };
    expect(claimOpen(s, false, now)).toBe(true);
    expect(claimOpen(s, true, now)).toBe(false);
    expect(claimOpen({ ...s, claim_expires: now }, false, now)).toBe(false);
    expect(claimOpen({ ...s, claim_code_hash: "" }, false, now)).toBe(false);
  });
});

describe("owners", () => {
  it("combines the env variable and the in-app list", async () => {
    const { isOwner, ownerIds, parseIds } = await import("../worker/env");
    expect(parseIds(" 5, x,7,5,-3,0,1.5 ")).toEqual([5, 7]);
    const env = { OWNER_IDS: "5,6" } as unknown as Env;
    expect(ownerIds(env, { owner_ids: "6,9" })).toEqual([5, 6, 9]);
    expect(isOwner(env, { owner_ids: "9" }, 9)).toBe(true);
    expect(isOwner(env, { owner_ids: "9" }, 10)).toBe(false);
    expect(isOwner({} as Env, { owner_ids: "" }, 1)).toBe(false);
  });
});

describe("uploaded images", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Uint8Array.from([...enc.encode("RIFF"), 1, 2, 3, 4, ...enc.encode("WEBPVP8 ")]);
  it("detects png, jpeg and webp by their first bytes only", async () => {
    const { detectImageMime } = await import("../worker/assets");
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(jpg)).toBe("image/jpeg");
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(detectImageMime(enc.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectImageMime(enc.encode("GIF89a......"))).toBeNull();
    expect(detectImageMime(enc.encode("RIFF....WAVEfmt "))).toBeNull();
    expect(detectImageMime(new Uint8Array())).toBeNull();
  });
  it("needs the declared type to match the real one, and a sane size", async () => {
    const { checkImageUpload, base64ToBytes, bytesToBase64 } = await import("../worker/assets");
    const { LIMITS } = await import("../shared/brand");
    expect(checkImageUpload("image/png", png)).toBeNull();
    expect(checkImageUpload("image/png; charset=binary", png)).toBeNull();
    expect(checkImageUpload("image/jpeg", png)).toBe("INVALID_IMAGE"); // lying header
    expect(checkImageUpload("image/svg+xml", enc.encode("<svg/>"))).toBe("INVALID_IMAGE");
    expect(checkImageUpload("text/html", png)).toBe("INVALID_IMAGE");
    expect(checkImageUpload(undefined, png)).toBe("INVALID_IMAGE");
    expect(checkImageUpload("image/png", new Uint8Array())).toBe("EMPTY");
    const big = new Uint8Array(LIMITS.imageBytes + 1);
    big.set(png);
    expect(checkImageUpload("image/png", big)).toBe("TOO_LARGE");
    expect([...base64ToBytes(bytesToBase64(webp))]).toEqual([...webp]);
  });
});

describe("branding settings validation", () => {
  it("accepts good values and normalises the JSON ones", async () => {
    const { normalizeBrandSettings } = await import("../worker/brandSettings");
    const v: Record<string, string> = {
      brand_name: "  Rocket SMM ",
      brand_preset: "emerald",
      brand_accent: "#0f8a5f",
      website_url: "https://example.com",
      terms_url: "",
      welcome_text: "Hi {name}!\nWelcome to {brand}.",
      custom_emoji: ' { "⭐" : "5258039825805624495" } ',
      button_icons: '{"open":"5332336747072208845"}',
    };
    expect(normalizeBrandSettings(v as never)).toBeNull();
    expect(v.brand_name).toBe("Rocket SMM");
    expect(v.custom_emoji).toBe('{"⭐":"5258039825805624495"}');
    expect(JSON.parse(v.button_icons)).toEqual({ open: "5332336747072208845", viewOrder: "", terms: "", invite: "" });
    const empty: Record<string, string> = { custom_emoji: "", button_icons: "", brand_name: "" };
    expect(normalizeBrandSettings(empty as never)).toBeNull();
    expect(empty.custom_emoji).toBe("{}");
  });

  it("names the first bad key", async () => {
    const { normalizeBrandSettings } = await import("../worker/brandSettings");
    const bad = (k: string, val: string) => normalizeBrandSettings({ [k]: val } as never);
    expect(bad("brand_name", "x".repeat(41))).toBe("brand_name");
    expect(bad("brand_name", "line\nbreak")).toBe("brand_name");
    expect(bad("brand_preset", "neon")).toBe("brand_preset");
    expect(bad("brand_accent", "red")).toBe("brand_accent");
    expect(bad("brand_accent", "#12345")).toBe("brand_accent");
    expect(bad("website_url", "http://example.com")).toBe("website_url");
    expect(bad("website_url", "javascript:alert(1)")).toBe("website_url");
    expect(bad("terms_url", "https://user:pw@example.com")).toBe("terms_url");
    expect(bad("welcome_text", "x".repeat(1001))).toBe("welcome_text");
    expect(bad("custom_emoji", "not json")).toBe("custom_emoji");
    expect(bad("custom_emoji", '{"a":"5258039825805624495"}')).toBe("custom_emoji"); // key is not an emoji
    expect(bad("custom_emoji", '{"⭐":"abc"}')).toBe("custom_emoji");
    expect(bad("button_icons", '{"open":"abc"}')).toBe("button_icons");
    expect(bad("button_icons", '{"other":"5258039825805624495"}')).toBe("button_icons");
  });

  it("builds BrandInfo with safe fallbacks", async () => {
    const { brandInfo, brandName } = await import("../worker/brand");
    const { DEFAULTS } = await import("../worker/settings");
    expect(brandName(DEFAULTS)).toBe("NotBot");
    expect(brandInfo({ ...DEFAULTS, brand_name: "Rocket", logo_ver: 3, website_url: "http://bad", brand_preset: "neon" })).toEqual({
      name: "Rocket",
      logoUrl: "/media/logo?v=3",
      preset: "cobalt",
      accent: "#2457ff",
      websiteUrl: null,
      termsUrl: null,
    });
    expect(brandInfo({ ...DEFAULTS, logo_ver: -2 }).logoUrl).toBeNull();
  });

  it("escapes owner text in the custom welcome", async () => {
    const { customWelcome } = await import("../worker/botMessages");
    expect(customWelcome("<b>Hi</b> {name} @ {brand}", "A<script>", "R&D")).toBe("&lt;b&gt;Hi&lt;/b&gt; A&lt;script&gt; @ R&amp;D");
  });
});

describe("bot command menus", () => {
  it("are valid Telegram commands in every language, with the admin commands on top for admins only", async () => {
    const { userCommands, ADMIN_COMMANDS } = await import("../worker/commands");
    const { LANGS } = await import("../shared/types");
    for (const l of LANGS) {
      const cmds = userCommands(l);
      expect(cmds.map((c) => c.command)).toEqual(["start", "orders", "wallet", "language", "help"]);
      for (const c of [...cmds, ...ADMIN_COMMANDS]) {
        expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(c.description.length).toBeGreaterThan(0);
        expect(c.description.length).toBeLessThanOrEqual(256);
        expect(c.description).not.toMatch(/[<>{}]/); // plain text, every placeholder filled
      }
    }
    expect(ADMIN_COMMANDS.map((c) => c.command)).toEqual(["admin", "stats", "preview"]);
  });

  it("refresh when the code version, the brand name or the admins change", async () => {
    const { commandsKey } = await import("../worker/commands");
    const env = { OWNER_IDS: "1" } as never;
    const s = (over: Record<string, unknown>) => ({ brand_name: "Rocket", owner_ids: "", ...over }) as never;
    const base = commandsKey(env, s({}));
    expect(commandsKey(env, s({}))).toBe(base);
    expect(commandsKey(env, s({ brand_name: "Other" }))).not.toBe(base);
    expect(commandsKey(env, s({ owner_ids: "42" }))).not.toBe(base);
  });

  it("counts /stats days in UTC", async () => {
    const { dayStartUtc } = await import("../worker/stats");
    expect(dayStartUtc(Date.UTC(2026, 9, 20, 23, 59))).toBe(Date.UTC(2026, 9, 20) / 1000);
  });
});
