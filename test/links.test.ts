import { describe, expect, it } from "vitest";
import { linkNeed, linkProblem, normalizeLink } from "../shared/links";
import { groupInt, usdText } from "../shared/num";

// Shapes taken from links NotPanel rejected (or accepted) in real orders
const check = (platform: string, slug: string, raw: string) => linkProblem(platform, linkNeed(platform, slug), normalizeLink(platform, raw))?.code ?? null;

describe("normalizeLink", () => {
  it("adds https:// and turns @names into links", () => {
    expect(normalizeLink("telegram", "t.me/name")).toBe("https://t.me/name");
    expect(normalizeLink("telegram", "@name")).toBe("https://t.me/name");
    expect(normalizeLink("telegram", "@name/4")).toBe("https://t.me/name/4");
    expect(normalizeLink("telegram", "@t.me/name")).toBe("https://t.me/name");
    expect(normalizeLink("telegram", "name_bot")).toBe("https://t.me/name_bot");
    expect(normalizeLink("tiktok", "tiktok.com/@some.user")).toBe("https://tiktok.com/@some.user");
    expect(normalizeLink("tiktok", "@some.user")).toBe("https://www.tiktok.com/@some.user");
    expect(normalizeLink("instagram", "@some.user")).toBe("https://www.instagram.com/some.user");
    expect(normalizeLink("youtube", "@chan")).toBe("https://www.youtube.com/@chan");
  });
  it("picks the link out of share text", () => {
    expect(normalizeLink("tiktok", "https://vm.tiktok.com/ZM123/ This post is shared via TikTok Lite. Download: https://x.tiktok.com/a")).toBe(
      "https://vm.tiktok.com/ZM123/",
    );
  });
  it("tidies t.me links", () => {
    expect(normalizeLink("telegram", "https://t.me/s/name/12")).toBe("https://t.me/name/12");
    expect(normalizeLink("telegram", "https://t.me/boost/name")).toBe("https://t.me/name");
    expect(normalizeLink("telegram", "https://telegram.me/name?start=ref")).toBe("https://t.me/name?start=ref");
    expect(normalizeLink("telegram", " https://t.me/name/5 ")).toBe("https://t.me/name/5");
  });
  it("leaves other links alone", () => {
    expect(normalizeLink("instagram", "https://www.instagram.com/reel/AbC/?igsh=x")).toBe("https://www.instagram.com/reel/AbC/?igsh=x");
    expect(normalizeLink("other", "so this")).toBe("so this");
  });
});

describe("linkProblem", () => {
  it("telegram post services need one public post", () => {
    expect(check("telegram", "views", "https://t.me/name/123")).toBe(null);
    expect(check("telegram", "views", "https://t.me/name/123?single")).toBe(null);
    expect(check("telegram", "reactions", "https://t.me/name/1/2")).toBe(null);
    expect(check("telegram", "views", "https://t.me/name")).toBe("LINK_NEED_POST");
    expect(check("telegram", "views-country-targeted", "@name")).toBe("LINK_NEED_POST");
    expect(check("telegram", "shares", "name")).toBe("LINK_NEED_POST");
    expect(check("telegram", "comments", "t.me/name")).toBe("LINK_NEED_POST");
    expect(check("telegram", "views", "https://t.me/c/1234/43")).toBe("LINK_PRIVATE");
    expect(check("telegram", "views-country-targeted", "https://t.me/+AbCdEf")).toBe(null);
    expect(check("telegram", "reactions", "https://vm.tiktok.com/x/")).toBe("LINK_WRONG_PLATFORM");
    expect(check("telegram", "views", "so this")).toBe("INVALID_LINK");
  });
  it("telegram channel services need the channel, group or bot", () => {
    expect(check("telegram", "members", "https://t.me/name")).toBe(null);
    expect(check("telegram", "members", "t.me/name")).toBe(null);
    expect(check("telegram", "members-premium", "https://t.me/+AbC-1d")).toBe(null);
    expect(check("telegram", "group-members", "https://t.me/joinchat/AbC")).toBe(null);
    expect(check("telegram", "boosts", "https://t.me/boost/name")).toBe(null);
    expect(check("telegram", "auto-views", "https://t.me/name")).toBe(null);
    expect(check("telegram", "members", "https://t.me/name/5")).toBe("LINK_NEED_CHAT");
    expect(check("telegram", "members", "https://www.tiktok.com/@a.b?_r=1")).toBe("LINK_WRONG_PLATFORM");
    expect(check("telegram", "bot-starts", "@name_bot")).toBe(null);
    expect(check("telegram", "bot-starts", "https://t.me/name_bot?start=ref123")).toBe(null);
    expect(check("telegram", "bot-starts", "https://t.me/name_bot/app?startapp=1")).toBe("LINK_NEED_BOT");
  });
  it("other telegram categories only need a link", () => {
    expect(check("telegram", "custom-comments", "https://t.me/name")).toBe(null);
    expect(check("telegram", "ad-clicks", "https://t.me/name")).toBe(null);
  });
  it("youtube subscribers need the channel, views a video", () => {
    expect(check("youtube", "subscribers", "https://youtube.com/@chan?si=x")).toBe(null);
    expect(check("youtube", "subscribers", "https://www.youtube.com/watch?v=abc")).toBe("LINK_NEED_CHAT");
    expect(check("youtube", "subscribers", "https://youtu.be/abc?si=x")).toBe("LINK_NEED_CHAT");
    expect(check("youtube", "shorts-views", "https://youtube.com/@chan-name")).toBe("LINK_NEED_POST");
    expect(check("youtube", "views", "https://youtu.be/abc")).toBe(null);
    expect(check("youtube", "live-stream", "https://youtube.com/@chan")).toBe(null);
  });
  it("other platforms: only the platform and that it is a link", () => {
    expect(check("tiktok", "followers", "tiktok.com/@a")).toBe(null);
    expect(check("tiktok", "followers", "someone")).toBe("INVALID_LINK");
    expect(check("instagram", "likes", "https://t.me/x/1")).toBe("LINK_WRONG_PLATFORM");
    expect(check("instagram", "likes", "https://bit.ly/abc")).toBe(null);
    expect(check("other", "traffic", "https://example.com/page")).toBe(null);
    expect(check("spotify", "plays", "spotify:track:1")).toBe(null);
  });
});

describe("groupInt / usdText (no Intl in the Worker)", () => {
  it("matches toLocaleString('en-US')", () => {
    for (const n of [0, 7, 999, 1000, 12_345, 1_234_567, -1500, 1e12]) expect(groupInt(n)).toBe(n.toLocaleString("en-US"));
    expect(groupInt(1249.6)).toBe("1,250");
  });
  it("formats dollars with cents", () => {
    expect(usdText(1_234_500_000)).toBe("$1,234.50");
    expect(usdText(-250_000)).toBe("$-0.25");
    expect(usdText(0)).toBe("$0.00");
  });
});
