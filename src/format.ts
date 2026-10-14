import { getLang } from "./i18n";

/** micro-USD → "$1.23" (3 decimals under $0.10) */
export function money(micro: number, opts: { sign?: boolean } = {}): string {
  const v = Math.abs(micro) / 1e6;
  const digits = v === 0 || v >= 0.1 ? 2 : v >= 0.01 ? 3 : 4;
  let s = v.toFixed(digits);
  if (digits > 2) s = s.replace(/(\.\d\d\d*?)0+$/, "$1");
  const sign = micro < 0 ? "−" : opts.sign && micro > 0 ? "+" : "";
  return `${sign}$${s}`;
}

/**
 * BCP 47 tag for Intl formatting. Arabic uses Latin digits ("ar-u-nu-latn") so num() and dateTime() match money();
 * Hindi keeps Indian digit grouping.
 */
export function locale(): string {
  const l = getLang();
  return l === "zh" ? "zh-CN" : l === "ar" ? "ar-u-nu-latn" : l;
}

/** Lower-cases with the UI language's rules (Turkish dotted/dotless i), for words shown inside sentences. */
export function lower(s: string): string {
  try {
    return s.toLocaleLowerCase(getLang());
  } catch {
    return s.toLowerCase();
  }
}

export function num(n: number): string {
  return n.toLocaleString(locale());
}

export function short(n: number): string {
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return +(n / 1000).toFixed(1) + "K";
  return String(n);
}

export function dateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(locale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number, today: string, yesterday: string): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return today;
  if (d.toDateString() === y.toDateString()) return yesterday;
  return d.toLocaleDateString(locale(), { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function duration(minutes: number, units: { m: string; h: string; d: string }): string {
  if (minutes < 60) return `${minutes} ${units.m}`;
  if (minutes <= 2880) return `${+(minutes / 60).toFixed(1)} ${units.h}`;
  return `${Math.round(minutes / 1440)} ${units.d}`;
}

/**
 * Left-to-right isolate (U+2066…U+2069) for money or an order number placed into a translated sentence by t(), which
 * returns plain text. In Arabic, "$1.22" or "#123" right after Arabic letters would otherwise show as "1.22$" or
 * "123#". Elements use <Num> instead.
 */
export const iso = (s: string) => `⁦${s}⁩`;

/** iso() around every "#123" in a translated sentence ('#' has to be inside the isolate too). */
export const isoIds = (s: string) => s.replace(/#\d+/g, (m) => iso(m));

/**
 * For text Telegram draws natively (MainButton, popups), where some clients may not support isolates: a left-to-right
 * mark in front keeps "$1.22" or "#123" in order inside Arabic. It is invisible everywhere else.
 */
export const lrm = (s: string) => `‎${s}`;

/** Strips the scheme for display */
export function prettyLink(link: string): string {
  return link.replace(/^https?:\/\/(www\.)?/, "");
}
