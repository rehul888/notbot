import { balanceStars, shownStars } from "../../shared/stars";
import { num, starsRate } from "../format";

/** micro-USD → "$1.23" (3-4 decimals under $0.10). Admin keeps its own copy: the user screens no longer show USD. */
export function money(micro: number): string {
  const v = Math.abs(micro) / 1e6;
  const digits = v === 0 || v >= 0.1 ? 2 : v >= 0.01 ? 3 : 4;
  let t = v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (digits > 2) t = t.replace(/(\.\d\d\d*?)0+$/, "$1");
  return `${micro < 0 ? "−" : ""}$${t}`;
}
/** Whole Telegram Stars, e.g. "1,250 ⭐" (Stars paid in Telegram, settings in Stars). */
export const starsText = (n: number) => `${num(Math.round(n))} ⭐`;
/** A micro-USD amount as users see it in Stars (rounded up). Money is stored in micro-USD everywhere. */
export const usdStars = (micro: number) => starsText(shownStars(micro, starsRate()));
/** A micro-USD balance, or a sum of credits, as users see it in Stars (rounded down). */
export const balStars = (micro: number) => starsText(balanceStars(micro, starsRate()));
