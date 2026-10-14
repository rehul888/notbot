// Stroke icons from the design (24×24 viewBox).
const P: Record<string, string> = {
  plusCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8",
  receipt: "M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 3h6v3H9zM9 11h6M9 15h6",
  wallet: "M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 7V6a2 2 0 0 1 2-2h10M16 13.5h.01",
  person: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c1.5-3.5 4.3-5 7.5-5s6 1.5 7.5 5",
  back: "M15 5l-7 7 7 7",
  chevron: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  out: "M7 17L17 7M9 7h8v8",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM16 16l4 4",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  cancel: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
  copy: "M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z",
  phone: "M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2",
  shield: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  list: "M7 4h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 10h6M9 14h6",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  users: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 19c1-3 3.3-4.5 6-4.5s5 1.5 6 4.5M16 4.8a3.5 3.5 0 0 1 0 6.4M17.5 14.7c1.6.6 2.8 2 3.5 4.3",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  heart: "M12 20.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10-7.5 10z",
  story: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM10 8.5v7l5.5-3.5z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  star: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z",
  chat: "M4 18.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7.5z",
  plane: "M21 3L10 14M21 3l-7 18-4-7-7-4z",
  poll: "M5 20V10M12 20V4M19 20v-7",
  bot: "M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 5v4M9.5 14h.01M14.5 14h.01",
  refill: "M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  doc: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h6",
  chart: "M4 20V4M4 20h16M8 16l4-5 3 3 5-6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 8h.01",
  alert: "M12 3.5l9 16H3zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01",
  spark: "M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z",
  wifiOff: "M5 9.5a10 10 0 0 1 14 0M8 12.5a6 6 0 0 1 8 0M11 15.5a2 2 0 0 1 2 0M12 18.5h.01M4 4l16 16",
};

export type IconName = keyof typeof P;

/** Raw 24×24 path data, for the inline-SVG art (src/art.tsx). */
export const ICON_PATHS: Readonly<Record<IconName, string>> = P;

/** Stroke icon. `fill` paints the shape too (e.g. a solid heart or spark). */
export function Icon({ name, size = 22, stroke = 1.9, class: cls, fill }: { name: IconName; size?: number; stroke?: number; class?: string; fill?: boolean }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d={P[name]} />
    </svg>
  );
}

/** Telegram Star, filled gold */
export function StarIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={P.star} fill="#f2a900" stroke="#b67c00" stroke-width="1.2" stroke-linejoin="round" />
    </svg>
  );
}

/** Picks a category icon and plate colour from words in the NotPanel category name (cosmetic only). */
const CAT_RULES: [RegExp, IconName, string][] = [
  [/member|follower|subscri|friend|fans/i, "users", "var(--lavender-strong)"],
  [/view|impression|reach|play|stream|traffic|visit/i, "eye", "var(--sky)"],
  [/react|like|heart|favorite|save/i, "heart", "var(--pink)"],
  [/story/i, "story", "var(--lime)"],
  [/boost/i, "bolt", "var(--lavender)"],
  [/premium|vip/i, "star", "var(--lime)"],
  [/comment|repl|review/i, "chat", "var(--sky)"],
  [/share|retweet|repost|forward/i, "plane", "var(--pink)"],
  [/poll|vote/i, "poll", "var(--lavender-strong)"],
  [/bot|start/i, "bot", "var(--lavender)"],
  [/click|ad\b|ads/i, "out", "var(--lime)"],
];

export function categoryLook(name: string): { icon: IconName; plate: string } {
  for (const [re, icon, plate] of CAT_RULES) if (re.test(name)) return { icon, plate };
  return { icon: "tag", plate: "var(--lavender)" };
}
