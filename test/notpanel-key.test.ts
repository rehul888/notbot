import { afterEach, describe, expect, it, vi } from "vitest";
import { switchNotPanelKey } from "../worker/connect";
import { getSettings, setSettings } from "../worker/settings";
import { d1 } from "./d1";

const OLD = "np_live_" + "a".repeat(40);
const NEW = "np_live_" + "b".repeat(40);

/** Fakes NotPanel: records (key, action, id) of every call; webhook.remove only works for the account that owns it. */
function fakeNotPanel(owner: Record<string, string>) {
  const calls: { key: string; action: string; id?: string }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
    const key = init.body.get("key")!;
    const action = init.body.get("action")!;
    const id = init.body.get("id") ?? undefined;
    calls.push({ key, action, id });
    if (action === "webhook.remove") {
      return owner[id!] === key
        ? new Response(JSON.stringify({ removed: true }))
        : new Response(JSON.stringify({ error: "Webhook not found", error_code: "WEBHOOK_NOT_FOUND", retryable: false }), { status: 404 });
    }
    if (action === "webhook.add") return new Response(JSON.stringify({ id: "wh_new", secret: "s_new" }));
    return new Response("{}");
  });
  return calls;
}

describe("switching the NotPanel key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes the old webhook with the old key, then adds one with the new key", async () => {
    const { env } = d1();
    await setSettings(env, { np_api_key: OLD, np_webhook_id: "wh_old", np_webhook_secret: "s_old" });
    const calls = fakeNotPanel({ wh_old: OLD });
    const res = await switchNotPanelKey(env, await getSettings(env, { fresh: true }), NEW, "https://bot.example");
    expect(res.webhook).toBe(true);
    expect(calls).toEqual([
      { key: OLD, action: "webhook.remove", id: "wh_old" },
      { key: NEW, action: "webhook.add", id: undefined },
    ]);
    const s = await getSettings(env, { fresh: true });
    expect([s.np_api_key, s.np_webhook_id, s.np_webhook_secret]).toEqual([NEW, "wh_new", "s_new"]);
  });

  it("still removes it with the new key when the old key was revoked (same account)", async () => {
    const { env } = d1();
    await setSettings(env, { np_api_key: OLD, np_webhook_id: "wh_old", np_webhook_secret: "s_old" });
    const calls = fakeNotPanel({ wh_old: NEW });
    await switchNotPanelKey(env, await getSettings(env, { fresh: true }), NEW, "https://bot.example");
    expect(calls.map((c) => `${c.action}:${c.key === OLD ? "old" : "new"}`)).toEqual(["webhook.remove:old", "webhook.remove:new", "webhook.add:new"]);
  });

  it("before setup's webhook step: removes the old webhook and saves the key, without adding one", async () => {
    const { env } = d1();
    await setSettings(env, { np_api_key: OLD, np_webhook_id: "wh_old", np_webhook_secret: "s_old" });
    const calls = fakeNotPanel({ wh_old: OLD });
    await switchNotPanelKey(env, await getSettings(env, { fresh: true }), NEW, "https://bot.example", false);
    expect(calls.map((c) => c.action)).toEqual(["webhook.remove"]);
    const s = await getSettings(env, { fresh: true });
    expect([s.np_api_key, s.np_webhook_id, s.np_webhook_secret]).toEqual([NEW, "", ""]);
  });
});
