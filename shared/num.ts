// Number formatting without Intl: the first toLocaleString in a fresh Worker isolate costs ~6.5 ms of CPU
// (free plan budget: 10 ms), so bot messages and cron runs group digits by hand.

/** A whole number with thousands commas, like toLocaleString("en-US"): 1250 → "1,250" */
export const groupInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** micro-USD as dollars with cents, like "$1,234.50" or "$-0.25" */
export function usdText(micro: number): string {
  const cents = Math.round(micro / 1e4);
  const abs = Math.abs(cents);
  return `$${cents < 0 ? "-" : ""}${groupInt(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}
