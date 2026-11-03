import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChannel } from "../worker/growth";
import type { Env } from "../worker/env";
import type { Settings } from "../worker/settings";

const s = { channel_id: "-100123" } as Settings;
/** Settings reads succeed with one owner, so a real alert would be sent with sendMessage */
const env = () => {
  const prepare = vi.fn(() => ({
    bind() { return this; },
    all: async () => ({ results: [{ key: "owner_ids", value: "7" }, { key: "setup_done", value: "1" }] }),
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
  }));
  return { BOT_TOKEN: "1:x", OWNER_IDS: "7", DB: { prepare, batch: async (x: unknown[]) => x.map(() => ({ meta: { changes: 1 } })) } } as unknown as Env;
};
const telegramSays = (status: number, body: string) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
const methods = (f: ReturnType<typeof telegramSays>) => f.mock.calls.map((c) => String(c[0]).split("/").pop());

afterEach(() => vi.restoreAllMocks());

describe("checkChannel when Telegram has trouble", () => {
  it("a gateway error page (520) is temporary: no admin alert", async () => {
    const f = telegramSays(520, "error code: 520\n");
    expect(await checkChannel(env(), s, 1)).toBe("unavailable");
    expect(methods(f)).toEqual(["getChatMember"]);
  });
  it("Telegram's own 502 is temporary too", async () => {
    const f = telegramSays(502, JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }));
    expect(await checkChannel(env(), s, 1)).toBe("unavailable");
    expect(methods(f)).toEqual(["getChatMember"]);
  });
  it("a setup problem (bot not in the channel) still alerts the admins", async () => {
    const f = telegramSays(400, JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    expect(await checkChannel(env(), s, 1)).toBe("unavailable");
    expect(methods(f)).toContain("sendMessage");
  });
});
