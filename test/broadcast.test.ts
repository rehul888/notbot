import { describe, expect, it } from "vitest";
import {
  activeSeconds,
  applyPatch,
  BROADCAST_BATCH,
  broadcastBusy,
  type BroadcastState,
  buildKeyboard,
  cutUnits,
  type Draft,
  type Entity,
  etaSeconds,
  extractContent,
  fmtDuration,
  fmtTime,
  isLastBatch,
  isSending,
  messageRequest,
  parseButtonLine,
  pausePatch,
  pctDone,
  personalize,
  progressBar,
  readBroadcast,
  readDraft,
  resumePatch,
  shouldAutoPause,
  withoutCustomEmoji,
} from "../worker/broadcastCore";
import { askButtonView, askMessageView, colorView, confirmDiscardView, confirmReplaceView, confirmSendView, confirmStopView, draftView, finalView, historyView, menuView, statusView } from "../worker/broadcastViews";

const ent = (type: string, offset: number, length: number, extra: object = {}): Entity => ({ type, offset, length, ...extra });
/** The part of the text an entity covers (what Telegram would format) */
const covered = (text: string, e: Entity) => text.slice(e.offset, e.offset + e.length);

describe("personalize", () => {
  it("leaves text without {name} alone", () => {
    const e = [ent("bold", 0, 3)];
    expect(personalize("Hello world", e, "Ann")).toEqual({ text: "Hello world", entities: e });
  });

  it("replaces {name} and shifts entities after it", () => {
    const r = personalize("Hi {name}, read this", [ent("bold", 11, 4)], "Alexander"); // "read" is bold
    expect(r.text).toBe("Hi Alexander, read this");
    expect(covered(r.text, r.entities[0])).toBe("read");
  });

  it("shifts back when the name is shorter than the tag", () => {
    const r = personalize("Hi {name}, read this", [ent("bold", 11, 4)], "Al");
    expect(r.text).toBe("Hi Al, read this");
    expect(covered(r.text, r.entities[0])).toBe("read");
  });

  it("keeps entities before it and grows entities that span it", () => {
    const text = "Dear {name}, welcome";
    const r = personalize(text, [ent("italic", 0, 4), ent("bold", 0, text.length), ent("underline", 5, 6)], "Maximilian");
    expect(r.text).toBe("Dear Maximilian, welcome");
    expect(covered(r.text, r.entities[0])).toBe("Dear");
    expect(covered(r.text, r.entities[1])).toBe(r.text);
    expect(covered(r.text, r.entities[2])).toBe("Maximilian");
  });

  it("handles several {name}s, each entity landing on the right words", () => {
    const text = "{name}, {name}! Go {name} go";
    const r = personalize(text, [ent("bold", 0, 6), ent("italic", 8, 6), ent("code", 26, 2), ent("underline", 0, text.length)], "Bo");
    expect(r.text).toBe("Bo, Bo! Go Bo go");
    expect(covered(r.text, r.entities[0])).toBe("Bo");
    expect(covered(r.text, r.entities[1])).toBe("Bo");
    expect(covered(r.text, r.entities[2])).toBe("go");
    expect(covered(r.text, r.entities[3])).toBe(r.text);
    const long = personalize(text, [ent("code", 26, 2)], "Bartholomew");
    expect(long.text).toBe("Bartholomew, Bartholomew! Go Bartholomew go");
    expect(covered(long.text, long.entities[0])).toBe("go");
  });

  it("counts offsets in UTF-16 units: emoji before, in and after the name", () => {
    // 👋 is 2 units, so "Hi" starts at 3 and {name} at 6
    const text = "👋 Hi {name} 🎉 ok";
    const r = personalize(text, [ent("bold", 3, 2), ent("custom_emoji", 13, 2, { custom_emoji_id: "5368324170671202286" }), ent("italic", 16, 2)], "Zoë");
    expect(r.text).toBe("👋 Hi Zoë 🎉 ok");
    expect(covered(r.text, r.entities[0])).toBe("Hi");
    expect(covered(r.text, r.entities[1])).toBe("🎉");
    expect(r.entities[1].custom_emoji_id).toBe("5368324170671202286"); // kept intact
    expect(covered(r.text, r.entities[2])).toBe("ok");
  });

  it("a name with emoji counts by UTF-16 units", () => {
    const r = personalize("{name}!", [ent("bold", 6, 1)], "A😀"); // name is 3 units
    expect(r.text).toBe("A😀!");
    expect(r.entities[0]).toMatchObject({ offset: 3, length: 1 });
  });

  it("an entity that only touches {name} does not grow", () => {
    const r = personalize("ab{name}cd", [ent("bold", 0, 2), ent("italic", 8, 2)], "Xyz");
    expect(r.entities.map((e) => covered(r.text, e))).toEqual(["ab", "cd"]);
  });

  it("an entity inside {name} covers the whole name; a half-covered tag does too", () => {
    const r = personalize("a {name} b", [ent("bold", 4, 2), ent("italic", 0, 5)], "Mia");
    expect(covered(r.text, r.entities[0])).toBe("Mia");
    expect(covered(r.text, r.entities[1])).toBe("a Mia");
  });

  it("keeps other entity fields and drops entities that become empty", () => {
    const r = personalize("{name}", [ent("text_link", 0, 6, { url: "https://x.y" }), ent("bold", 2, 0)], "");
    expect(r.text).toBe("");
    expect(r.entities).toEqual([]);
    const k = personalize("{name} x", [ent("text_link", 7, 1, { url: "https://x.y" })], "Al");
    expect(k.entities[0]).toMatchObject({ type: "text_link", url: "https://x.y", offset: 3, length: 1 });
  });

  it("shortens the name to fit the limit, never splitting an emoji", () => {
    const r = personalize("Hi {name}" + "x".repeat(10), [], "Abcdefghij", 15);
    expect(r.text.length).toBeLessThanOrEqual(15);
    expect(r.text).toBe("Hi Abxxxxxxxxxx");
    const e = personalize("{name}" + "x".repeat(10), [], "😀😀😀", 13); // room for 3 units: one emoji (2 units)
    expect(e.text).toBe("😀" + "x".repeat(10));
    expect(e.text.length).toBeLessThanOrEqual(13);
    expect(cutUnits("😀", 1)).toBe("");
    expect(cutUnits("abc", 0)).toBe("");
  });

  it("does not expand a {name} that is in the name itself", () => {
    expect(personalize("{name}", [], "{name}").text).toBe("{name}");
  });
});

describe("button lines", () => {
  const APP = "https://app.example.com";
  it("parses a link or the app", () => {
    expect(parseButtonLine("Join us | https://t.me/channel", APP)).toEqual({ ok: true, t: "Join us", u: "https://t.me/channel" });
    expect(parseButtonLine("  Open  |  APP ", APP)).toEqual({ ok: true, t: "Open", u: "app" });
    expect(parseButtonLine("Channel | t.me/news", APP)).toEqual({ ok: true, t: "Channel", u: "https://t.me/news" });
    expect(parseButtonLine("A | B | https://example.com/x", APP)).toEqual({ ok: true, t: "A | B", u: "https://example.com/x" });
  });
  it("rejects bad input with a reason", () => {
    for (const bad of ["no separator", "| https://example.com", "Text | http://example.com", "Text | javascript:alert(1)", "Text | https://localhost", "Text | ftp://example.com", "Text | https://user:pw@example.com", "Text | ", "a\nb | https://example.com"]) {
      const r = parseButtonLine(bad, APP);
      expect(r.ok, bad).toBe(false);
    }
    expect(parseButtonLine("T | app", "").ok).toBe(false); // no Mini App link configured
  });
  it("limits the text to 64 characters (not bytes)", () => {
    expect(parseButtonLine(`${"é".repeat(64)} | https://example.com`, APP).ok).toBe(true);
    expect(parseButtonLine(`${"é".repeat(65)} | https://example.com`, APP).ok).toBe(false);
    expect(parseButtonLine(`${"😀".repeat(64)} | https://example.com`, APP).ok).toBe(true);
  });
});

describe("keyboard layout", () => {
  const b = (t: string, u = "https://example.com", s: "" | "primary" | "success" | "danger" = "") => ({ t, u, s });
  const open = { text: "OPEN APP", web_app: { url: "https://app.example.com" }, style: "primary" };
  const rows = (k: ReturnType<typeof buildKeyboard>) => k?.inline_keyboard.map((r) => r.map((x: any) => x.text));

  it("one per row, two per row, odd button alone, Open App last on its own row", () => {
    const five = [b("1"), b("2"), b("3"), b("4"), b("5")];
    expect(rows(buildKeyboard(five, false, "", null))).toEqual([["1"], ["2"], ["3"], ["4"], ["5"]]);
    expect(rows(buildKeyboard(five, true, "", null))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(rows(buildKeyboard(five.slice(0, 2), true, "", open))).toEqual([["1", "2"], ["OPEN APP"]]);
  });
  it("nothing at all gives no keyboard", () => {
    expect(buildKeyboard([], false, "", null)).toBeUndefined();
    expect(rows(buildKeyboard([], false, "", open))).toEqual([["OPEN APP"]]);
  });
  it("carries the color as Telegram's style, the app as a web_app button, and leaves plain buttons unstyled", () => {
    const k = buildKeyboard([b("Blue", "https://a.io", "primary"), b("Green", "https://a.io", "success"), b("Red", "https://a.io", "danger"), b("Plain"), b("App", "app", "success")], false, "https://app.example.com", null)!;
    const flat = k.inline_keyboard.flat() as any[];
    expect(flat.map((x) => x.style)).toEqual(["primary", "success", "danger", undefined, "success"]);
    expect(flat[4].web_app).toEqual({ url: "https://app.example.com" });
    expect(flat[0].url).toBe("https://a.io");
    expect("style" in flat[3]).toBe(false);
  });
  it("drops an app button if the app link is gone", () => {
    expect(buildKeyboard([b("App", "app")], false, "", null)).toBeUndefined();
  });
});

describe("the message sent to one user", () => {
  it("text: entities and link preview, personalized, no parse_mode", () => {
    const r = messageRequest({ kind: "text", text: "Hi {name}! 🎉", entities: [ent("bold", 0, 2), ent("custom_emoji", 11, 2, { custom_emoji_id: "1" })], preview: { is_disabled: true } }, "Eve", { inline_keyboard: [] });
    expect(r.method).toBe("sendMessage");
    expect(r.params).toMatchObject({ text: "Hi Eve! 🎉", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
    expect(r.params.parse_mode).toBeUndefined();
    expect(r.params.entities).toEqual([ent("bold", 0, 2), ent("custom_emoji", 8, 2, { custom_emoji_id: "1" })]); // emoji entity shifted to its new place
  });
  it("media: file_id, caption and caption_entities, per type", () => {
    const base = { text: "{name}: look", entities: [ent("italic", 8, 4)], file: "FILE" };
    const photo = messageRequest({ ...base, kind: "photo", spoiler: true, above: true }, "Jo");
    expect(photo.method).toBe("sendPhoto");
    expect(photo.params).toMatchObject({ photo: "FILE", caption: "Jo: look", caption_entities: [{ type: "italic", offset: 4, length: 4 }], has_spoiler: true, show_caption_above_media: true });
    expect(photo.params.text).toBeUndefined();
    expect(photo.params.parse_mode).toBeUndefined();
    const methods = { video: "sendVideo", animation: "sendAnimation", document: "sendDocument", audio: "sendAudio", voice: "sendVoice" } as const;
    for (const [kind, method] of Object.entries(methods)) {
      const r = messageRequest({ ...base, kind: kind as keyof typeof methods }, "Jo");
      expect(r.method).toBe(method);
      expect(r.params[kind]).toBe("FILE");
    }
    // spoiler / caption position only exist for photo, video, GIF
    expect(messageRequest({ ...base, kind: "document", spoiler: true, above: true }, "Jo").params.has_spoiler).toBeUndefined();
  });
  it("media without a caption sends no caption", () => {
    const r = messageRequest({ kind: "photo", text: "", entities: [], file: "F" }, "Jo");
    expect(r.params).toEqual({ photo: "F" });
  });
  it("a caption stays within 1024 characters after the name is put in", () => {
    const r = messageRequest({ kind: "photo", text: "{name}" + "x".repeat(1018), entities: [], file: "F" }, "A".repeat(60));
    expect((r.params.caption as string).length).toBe(1024);
  });
  it("can drop custom emojis when Telegram refuses them", () => {
    const c = withoutCustomEmoji({ kind: "text", text: "a b", entities: [ent("bold", 0, 1), ent("custom_emoji", 2, 1, { custom_emoji_id: "1" })] });
    expect(c.entities.map((e) => e.type)).toEqual(["bold"]);
  });
});

describe("reading the admin's message", () => {
  it("text with entities and a link preview setting", () => {
    const r = extractContent({ text: "Hi", entities: [{ type: "bold", offset: 0, length: 2 }], link_preview_options: { is_disabled: true, junk: 1 } });
    expect(r).toEqual({ ok: true, content: { kind: "text", text: "Hi", entities: [{ type: "bold", offset: 0, length: 2 }], preview: { is_disabled: true } } });
  });
  it("each media type, with the caption; the biggest photo size; a GIF is not a document", () => {
    const p = extractContent({ photo: [{ file_id: "small" }, { file_id: "big" }], caption: "c", caption_entities: [{ type: "bold", offset: 0, length: 1 }], has_media_spoiler: true });
    expect(p).toMatchObject({ ok: true, content: { kind: "photo", file: "big", text: "c", spoiler: true } });
    expect(extractContent({ animation: { file_id: "g" }, document: { file_id: "g" } })).toMatchObject({ ok: true, content: { kind: "animation", file: "g", text: "" } });
    for (const k of ["video", "document", "audio", "voice"]) expect(extractContent({ [k]: { file_id: "f" } })).toMatchObject({ ok: true, content: { kind: k, file: "f" } });
  });
  it("refuses albums, unsupported types and overlong captions with a reason", () => {
    expect(extractContent({ photo: [{ file_id: "a" }], media_group_id: "1" })).toMatchObject({ ok: false, error: expect.stringContaining("Albums") });
    expect(extractContent({ sticker: { file_id: "s" } })).toMatchObject({ ok: false, error: expect.stringContaining("isn't supported") });
    expect(extractContent({ video_note: { file_id: "s" } }).ok).toBe(false);
    expect(extractContent({ photo: [{ file_id: "a" }], caption: "x".repeat(1025) })).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
    expect(extractContent({ text: "x".repeat(4097) }).ok).toBe(false);
  });
  it("reads saved drafts safely", () => {
    const d: Draft = { c: { kind: "text", text: "x", entities: [] }, b: [], two: false, app: true };
    expect(readDraft(JSON.stringify(d))).toEqual(d);
    expect(readDraft("")).toBeNull();
    expect(readDraft("{oops")).toBeNull();
    expect(readDraft('{"c":{"kind":"nope","text":"","entities":[]}}')).toBeNull();
  });
});

describe("progress, ETA and time", () => {
  const st = (o: Partial<BroadcastState> = {}): BroadcastState => ({ chat: 1, c: { kind: "text", text: "x", entities: [] }, cursor: 0, total: 1000, sent: 0, blocked: 0, failed: 0, startedAt: 10_000, ...o });
  it("progress bar and percent", () => {
    expect(progressBar(0)).toBe("░░░░░░░░░░");
    expect(progressBar(52)).toBe("▓▓▓▓▓░░░░░");
    expect(progressBar(100)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(progressBar(250)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(pctDone(st({ sent: 480, blocked: 30, failed: 10 }))).toBe(52);
    expect(pctDone(st({ total: 0 }))).toBe(100);
    expect(pctDone(st({ sent: 5000 }))).toBe(100);
  });
  it("ETA: batch rate at the start, the measured rate later, pauses not counted", () => {
    expect(etaSeconds(st(), 10_000)).toBe(40 * 60); // 1000 / 25 batches
    // 500 done in 600 s of work: 500 left → 600 s
    expect(etaSeconds(st({ sent: 500 }), 10_600)).toBe(600);
    // same, but paused for 300 s in the past → 300 s of work only
    expect(etaSeconds(st({ sent: 500, pausedFor: 300 }), 10_600)).toBe(300);
    // currently paused since 10_300: only 300 s of work so far
    expect(etaSeconds(st({ sent: 500, paused: 1, pausedAt: 10_300 }), 10_900)).toBe(300);
    expect(etaSeconds(st({ sent: 1000 }), 10_900)).toBe(0);
  });
  it("durations and dates", () => {
    expect(fmtDuration(20)).toBe("under a minute");
    expect(fmtDuration(8 * 60)).toBe("8 min");
    expect(fmtDuration(3600)).toBe("1 h");
    expect(fmtDuration(72 * 60)).toBe("1 h 12 min");
    expect(fmtTime(Date.UTC(2026, 9, 22, 14, 5) / 1000)).toBe("22 Oct 14:05 UTC");
    expect(activeSeconds(st({ pausedFor: 100 }), 10_500)).toBe(400);
  });
});

describe("state transitions", () => {
  const st = (o: Partial<BroadcastState> = {}): BroadcastState => ({ chat: 1, c: { kind: "text", text: "x", entities: [] }, cursor: 0, total: 100, sent: 0, blocked: 0, failed: 0, startedAt: 1000, ...o });

  it("pause then resume adds up the paused time and clears waits", () => {
    const running = st({ waitUntil: 1050, lastError: "boom" });
    expect(isSending(running, 1100)).toBe(true);
    const p = pausePatch(running, 1100)!;
    const paused = applyPatch(running, p);
    expect(paused.paused).toBe(1);
    expect(isSending(paused, 1200)).toBe(false);
    expect(pausePatch(paused, 1200)).toBeNull(); // already paused
    const r = resumePatch(paused, 1400)!;
    const back = applyPatch(paused, r);
    expect(back).toMatchObject({ paused: 0, pausedFor: 300, pausedAt: 0, waitUntil: 0, lastError: "" });
    expect(resumePatch(back, 1500)).toBeNull(); // not paused
    // a second pause keeps adding
    const again = applyPatch(back, resumePatch(applyPatch(back, pausePatch(back, 2000)!), 2050)!);
    expect(again.pausedFor).toBe(350);
  });
  it("sending waits while Telegram asked to slow down, and resumes after", () => {
    expect(isSending(st({ waitUntil: 2000 }), 1500)).toBe(false);
    expect(isSending(st({ waitUntil: 2000 }), 2000)).toBe(true);
  });
  it("finishing: a short batch ends it, a full one or a wait doesn't", () => {
    expect(isLastBatch(0, true, false)).toBe(true);
    expect(isLastBatch(BROADCAST_BATCH - 1, true, false)).toBe(true);
    expect(isLastBatch(BROADCAST_BATCH, true, false)).toBe(false);
    expect(isLastBatch(BROADCAST_BATCH - 1, false, false)).toBe(false); // stopped early by the call budget
    expect(isLastBatch(BROADCAST_BATCH - 1, true, true)).toBe(false); // rate-limited
  });
  it("pauses by itself when the very first batch all failed, never when something was sent", () => {
    expect(shouldAutoPause(st({ failed: BROADCAST_BATCH }))).toBe(true);
    expect(shouldAutoPause(st({ failed: BROADCAST_BATCH - 1 }))).toBe(false);
    expect(shouldAutoPause(st({ failed: 99, sent: 1 }))).toBe(false);
  });
  it("other cron jobs wait only while a broadcast is really sending", () => {
    expect(broadcastBusy("")).toBe(false);
    expect(broadcastBusy(JSON.stringify(st()))).toBe(true);
    expect(broadcastBusy(JSON.stringify(st({ paused: 1 })))).toBe(false);
    expect(broadcastBusy("{broken")).toBe(false);
  });
  it("reads saved state safely, including one started by the old version", () => {
    expect(readBroadcast("")).toBeNull();
    expect(readBroadcast("{broken")).toBeNull();
    expect(readBroadcast('{"chat":1,"msg":2,"cursor":0,"total":3,"sent":0,"blocked":0,"failed":0,"startedAt":1}')?.msg).toBe(2);
    expect(readBroadcast('{"chat":1,"cursor":0,"total":3,"startedAt":1}')).toBeNull(); // nothing to send
    expect(readBroadcast(JSON.stringify(st()))?.c?.kind).toBe("text");
  });
});

describe("cards", () => {
  const draft: Draft = { c: { kind: "photo", text: "Hello {name}", entities: [], file: "F" }, b: [{ t: "Join", u: "https://t.me/x", s: "primary" }, { t: "App", u: "app", s: "" }], two: false, app: true };
  const st: BroadcastState = { chat: 1, c: draft.c, cursor: 0, total: 1000, sent: 480, blocked: 30, failed: 10, startedAt: 1_800_000_000 };
  const all = [
    menuView({ audience: 5, draft, running: st, now: 1_800_000_100 }),
    menuView({ audience: 5, draft: null, running: null, now: 0 }),
    askMessageView({ change: false }),
    askButtonView({ count: 1, hasApp: true, error: "x" }),
    colorView({ t: "Join", u: "app" }),
    draftView({ draft, v: 12, audience: 5, running: false, hasApp: true }),
    draftView({ draft: { ...draft, b: Array.from({ length: 8 }, () => draft.b[0]) }, v: 99999, audience: 5, running: true, hasApp: false }),
    confirmSendView({ draft, v: 3, audience: 1700 }),
    confirmDiscardView(),
    confirmReplaceView(),
    confirmStopView(st),
    statusView(st, 1_800_000_600),
    statusView({ ...st, paused: 1, pausedAt: 1_800_000_300, lastError: "400 <bad>" }, 1_800_000_600),
    finalView(st, "finished", 1_800_003_000),
    finalView(st, "stopped", 1_800_003_000),
    historyView([{ started_at: 1_800_000_000, ended_at: 1_800_003_000, status: "finished", kind: "photo", label: "Hi <b>", total: 10, sent: 8, blocked: 1, failed: 1, by_admin: 7, by_name: "Ann & Bob" }]),
    historyView([]),
  ];
  it("every callback_data fits Telegram's 64 bytes, and starts with bc:", () => {
    for (const v of all) for (const row of v.rows) for (const btn of row) {
      expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(64);
      expect(btn.callback_data.startsWith("bc:")).toBe(true);
    }
  });
  it("the draft card offers the controls and shows the layout toggle only with two or more buttons", () => {
    const labels = (v: { rows: { text: string }[][] }) => v.rows.flat().map((b) => b.text);
    const l = labels(draftView({ draft, v: 1, audience: 1700, running: false, hasApp: true }));
    expect(l).toEqual(expect.arrayContaining(["👁 Preview (sent to you)", "➕ Add button", "↕️ Two per row", "🗑 1", "🗑 2", "🔘 Open App button: ON", "🚀 Send to 1,700 users", "✖️ Discard draft"]));
    const one = labels(draftView({ draft: { ...draft, b: [draft.b[0]] }, v: 1, audience: 1700, running: false, hasApp: true }));
    expect(one.some((x) => x.startsWith("↕️"))).toBe(false);
    const running = labels(draftView({ draft, v: 1, audience: 1700, running: true, hasApp: true }));
    expect(running.some((x) => x.startsWith("🚀"))).toBe(false);
    // 8 buttons: no more "Add button"
    expect(labels(draftView({ draft: { ...draft, b: Array.from({ length: 8 }, () => draft.b[0]) }, v: 1, audience: 1, running: false, hasApp: true }))).not.toContain("➕ Add button");
  });
  it("the status card shows the bar, counts and the right controls", () => {
    const run = statusView(st, 1_800_000_600);
    expect(run.text).toContain("▓▓▓▓▓░░░░░ <b>52%</b>");
    expect(run.text).toMatch(/Sent: <b>480<\/b>/);
    expect(run.text).toMatch(/Remaining: <b>480<\/b>/);
    expect(run.rows.flat().map((b) => b.text)).toEqual(["⏸ Pause", "⛔️ Stop", "🔄 Refresh", "⬅️ Menu"]);
    const paused = statusView({ ...st, paused: 1, pausedAt: 1_800_000_300 }, 1_800_000_600);
    expect(paused.rows.flat()[0].text).toBe("▶️ Resume");
    expect(paused.text).toContain("PAUSED");
  });
  it("HTML in user-controlled text is escaped", () => {
    const h = historyView([{ started_at: 1, ended_at: 2, status: "stopped", kind: "text", label: "<script>", total: 1, sent: 1, blocked: 0, failed: 0, by_admin: 7, by_name: "<i>x" }]);
    expect(h.text).not.toContain("<script>");
    expect(h.text).not.toContain("<i>x");
  });
});
