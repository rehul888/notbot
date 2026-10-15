// Display names for NotPanel platform slugs. Unknown slugs fall back to a title-cased slug.

const NAMES: Record<string, string> = {
  telegram: "Telegram",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  "twitter-x": "X",
  facebook: "Facebook",
  spotify: "Spotify",
  whatsapp: "WhatsApp",
  threads: "Threads",
  snapchat: "Snapchat",
  twitch: "Twitch",
  kick: "Kick",
  reddit: "Reddit",
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  soundcloud: "SoundCloud",
  vk: "VK",
  shopee: "Shopee",
  kwai: "Kwai",
  audiomack: "Audiomack",
  rumble: "Rumble",
  quora: "Quora",
  discord: "Discord",
  tumblr: "Tumblr",
  deezer: "Deezer",
  clubhouse: "Clubhouse",
  "apple-music": "Apple Music",
  vimeo: "Vimeo",
  github: "GitHub",
  google: "Google",
  tidal: "Tidal",
  other: "Other",
};

/** Platforms shown first, in this order (from the design); the rest follow by service count. */
export const PLATFORM_ORDER = [
  "telegram", "instagram", "tiktok", "youtube", "twitter-x", "facebook", "spotify", "whatsapp", "threads",
  "snapchat", "twitch", "kick", "reddit", "pinterest", "linkedin", "soundcloud", "vk", "shopee",
];

const LOGOS = new Set([
  ...PLATFORM_ORDER,
  "audiomack", "rumble", "quora", "discord", "tumblr", "deezer", "clubhouse", "vimeo", "github", "google", "tidal",
]);

export function platformName(slug: string): string {
  return Object.hasOwn(NAMES, slug) ? NAMES[slug] : slug.replace(/(^|-)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
}

export function platformLogo(slug: string): string | null {
  return LOGOS.has(slug) ? `/platforms/${slug}.svg` : null;
}
