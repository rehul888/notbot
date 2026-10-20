// Money is stored and charged in micro-USD (NotPanel bills in dollars). Telegram Stars are only how users see it and
// how they pay: 1 ⭐ paid credits 1/stars_per_usd dollars. These helpers are shared by the Worker and the app so both
// always agree.

/** Prices within 0.001 ⭐ above a whole Star show as that Star (a few hundredths of a cent). */
const TOL = 0.001;

/** A price, charge or credit as users see it: whole Stars, rounded up (1.2 ⭐ → 2 ⭐), at least 1 ⭐ if not zero. Sign kept. */
export function shownStars(micro: number, starsPerUsd: number): number {
  if (!micro || !(starsPerUsd > 0)) return 0;
  const v = Math.max(1, Math.ceil((Math.abs(micro) * starsPerUsd) / 1_000_000 - TOL));
  return micro < 0 ? -v : v;
}

/**
 * A balance as users see it: whole Stars, rounded down, so it never shows more than the user has. Credits are rounded
 * up to the micro-dollar (starsCredit), so N Stars paid always show as at least N Stars.
 */
export function balanceStars(micro: number, starsPerUsd: number): number {
  if (!micro || !(starsPerUsd > 0)) return 0;
  return Math.floor((micro * starsPerUsd) / 1_000_000 + 1e-9);
}

/** Some money, but less than one whole Star: shown as "<1 ⭐" rather than a misleading "0 ⭐" */
export function underOneStar(micro: number, starsPerUsd: number): boolean {
  return micro > 0 && balanceStars(micro, starsPerUsd) === 0;
}

/** Dollars credited for Stars paid, rounded up to the micro-dollar. */
export function starsCredit(stars: number, starsPerUsd: number): number {
  return starsPerUsd > 0 ? Math.ceil((stars * 1_000_000) / starsPerUsd - 1e-9) : 0;
}

/** Fewest whole Stars whose credit covers `micro` (what an invoice for that amount asks for). */
export function starsToCover(micro: number, starsPerUsd: number): number {
  if (!(micro > 0) || !(starsPerUsd > 0)) return 1;
  let n = Math.max(1, Math.ceil((micro * starsPerUsd) / 1_000_000 - 1e-9));
  // Credits round up, so one Star fewer may already cover it; and float error may need one more
  while (n > 1 && starsCredit(n - 1, starsPerUsd) >= micro) n--;
  while (starsCredit(n, starsPerUsd) < micro) n++;
  return n;
}

/** Largest single Telegram Stars payment we ask for */
export const MAX_STARS_PER_PAYMENT = 10_000;
