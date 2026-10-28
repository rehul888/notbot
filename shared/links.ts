// Order links, checked before they reach NotPanel (form and server use the same rules). Built from the links NotPanel
// rejected in real orders: a missing https://, an @name instead of a link, a link to another platform, and on
// Telegram/YouTube a channel link for a post service or a post link for a channel service.
// normalizeLink fixes what can be fixed safely; linkProblem names what the customer has to change.

/** What a service's link has to point to. "any" = no shape check. */
export type LinkNeed = "post" | "chat" | "bot" | "any";

export type LinkProblem = "INVALID_LINK" | "LINK_NEED_POST" | "LINK_NEED_CHAT" | "LINK_NEED_BOT" | "LINK_PRIVATE" | "LINK_WRONG_PLATFORM";

const HOSTS: Record<string, RegExp> = {
  telegram: /^(t\.me|telegram\.me|telegram\.dog)$/,
  tiktok: /(^|\.)tiktok\.com$/,
  instagram: /(^|\.)instagram\.com$|^instagr\.am$/,
  youtube: /(^|\.)youtube\.com$|^youtu\.be$/,
  facebook: /(^|\.)facebook\.com$|^fb\.(com|watch)$/,
  "twitter-x": /^((www|mobile)\.)?(x|twitter)\.com$/,
  whatsapp: /(^|\.)whatsapp\.com$|^wa\.me$/,
};

/** "@name" → that profile's link */
const PROFILE: Record<string, (name: string) => string> = {
  telegram: (n) => `https://t.me/${n}`,
  tiktok: (n) => `https://www.tiktok.com/@${n}`,
  instagram: (n) => `https://www.instagram.com/${n}`,
  youtube: (n) => `https://www.youtube.com/@${n}`,
  "twitter-x": (n) => `https://x.com/${n}`,
};

/** Shown in the hint under the link field (not translated: they are links). */
const EXAMPLES: Record<string, Partial<Record<LinkNeed, string>>> = {
  telegram: { post: "https://t.me/channel/123", chat: "https://t.me/channel", bot: "https://t.me/yourbot" },
  youtube: { post: "https://youtube.com/watch?v=…", chat: "https://youtube.com/@channel" },
};

/** NotPanel category slug → what the link must be. Only where real orders showed one shape always fails. */
export function linkNeed(platform: string, categorySlug: string): LinkNeed {
  if (platform === "telegram") {
    if (/^(views|reactions|shares|comments|poll-votes)(-|$)/.test(categorySlug)) return "post";
    if (/^bot-starts(-|$)/.test(categorySlug)) return "bot";
    if (/^(members|group-members|boosts|auto-views)(-|$)/.test(categorySlug)) return "chat";
  }
  if (platform === "youtube") {
    if (/^subscribers(-|$)/.test(categorySlug)) return "chat";
    if (/^(views|likes|shorts|watch-time|shares|comments|custom-comments)(-|$)/.test(categorySlug)) return "post";
  }
  return "any";
}

export function linkExample(platform: string, need: LinkNeed): string | null {
  return EXAMPLES[platform]?.[need] ?? null;
}

const TG_NAME = "[A-Za-z][A-Za-z0-9_]{3,31}";

/** Fixes a pasted link: picks the URL out of share text, adds https://, turns @name into a link, tidies t.me links. */
export function normalizeLink(platform: string, raw: string): string {
  let s = raw.trim();
  // "Look at this… https://vm.tiktok.com/xyz/ Download the app: https://…" → the first link
  const url = /https?:\/\/\S+/i.exec(s);
  if (url) s = url[0];
  s = s.replace(/^@(?=[\w-]+(\.[\w-]+)+\/)/, ""); // "@t.me/name"
  const tg = platform === "telegram" ? new RegExp(`^@?(${TG_NAME})(/\\d+)?$`).exec(s) : null;
  if (tg) return `https://t.me/${tg[1]}${tg[2] ?? ""}`;
  const handle = PROFILE[platform] && /^@([\w.-]{2,})$/.exec(s);
  if (handle) return PROFILE[platform](handle[1]);
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(s)) s = "https://" + s;
  if (platform === "telegram") {
    const u = parse(s);
    if (u && HOSTS.telegram.test(u.host)) {
      // t.me/s/name/1 is the web preview of t.me/name/1; t.me/boost/name boosts the channel t.me/name
      const path = u.pathname.replace(/^\/s\//, "/").replace(new RegExp(`^/boost/(${TG_NAME})/?$`), "/$1");
      return `https://t.me${path}${u.search}`;
    }
  }
  return s;
}

function parse(s: string): { host: string; pathname: string; search: string } | null {
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(s)) return null;
  try {
    const u = new URL(s);
    return { host: u.hostname.toLowerCase(), pathname: u.pathname, search: u.search };
  } catch {
    return null;
  }
}

function platformOf(host: string): string | null {
  for (const [p, re] of Object.entries(HOSTS)) if (re.test(host)) return p;
  return null;
}

/** Why NotPanel would reject this (already normalized) link, or null when it looks right. */
export function linkProblem(platform: string, need: LinkNeed, link: string): { code: LinkProblem; platform?: string } | null {
  const u = parse(link);
  if (!u) return HOSTS[platform] ? { code: "INVALID_LINK" } : null;
  const other = platformOf(u.host);
  if (HOSTS[platform] && other && other !== platform) return { code: "LINK_WRONG_PLATFORM", platform };
  if (need === "any" || other !== platform) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (platform === "telegram") {
    if (need === "post") {
      if (new RegExp(`^/${TG_NAME}/\\d+(/\\d+)?$`).test(path)) return null;
      // Invite links work for some (country-targeted) view services, so NotPanel decides on those
      if (/^\/(\+|joinchat\/)/.test(path)) return null;
      return { code: path.startsWith("/c/") ? "LINK_PRIVATE" : "LINK_NEED_POST" };
    }
    if (need === "bot") return new RegExp(`^/${TG_NAME}$`).test(path) ? null : { code: "LINK_NEED_BOT" };
    return new RegExp(`^/(${TG_NAME}|\\+[\\w-]+|joinchat/[\\w-]+)$`).test(path) ? null : { code: "LINK_NEED_CHAT" };
  }
  if (platform === "youtube") {
    const isVideo = u.host === "youtu.be" || /^\/(watch|shorts\/|live\/|embed\/)/.test(path);
    const isChannel = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(path);
    if (need === "chat" && isVideo) return { code: "LINK_NEED_CHAT" };
    if (need === "post" && isChannel) return { code: "LINK_NEED_POST" };
  }
  return null;
}
