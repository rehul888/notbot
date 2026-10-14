// Motion helpers (design spec §3.24, §7). CSS does the animating; these only decide when, and drive count-ups.
import { createElement, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** The user asked for less motion (OS setting). */
export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Low-end device class, set on <html data-perf> before first paint (index.html). */
export const perfLow = (): boolean => typeof document !== "undefined" && document.documentElement.dataset.perf === "low";

const firstSeen = new Map<string, number>();
/** How long `once()` keeps answering true, so re-renders during an entrance (data arriving) keep its class. */
const ONCE_WINDOW = 1000;

/**
 * True the first time `key` is asked for in this app launch (module-level), e.g. `<ArtHomeHero enter={once("hero")}/>`.
 * Calls within the next second also return true, so a re-render mid-entrance does not cut the animation short.
 */
export function once(key: string): boolean {
  const now = Date.now();
  const t = firstSeen.get(key);
  if (t === undefined) {
    firstSeen.set(key, now);
    return true;
  }
  return now - t < ONCE_WINDOW;
}

type CountUpOptions = { from?: number; duration?: number; delay?: number; step?: number };

/**
 * Counts from `from` up to `target` (easeOutCubic), rounded to `step`. Returns `target` straight away when `from` is
 * not given or equals the target, and always under Reduce Motion / on low-end devices. Whether it animates is decided
 * at mount (`from` is read once); later target changes (polling) count on from the number currently shown.
 * Render the final value in an `.sr` span too.
 */
export function useCountUp(target: number, o: CountUpOptions = {}): number {
  const { duration = 800, delay = 0, step = 1 } = o;
  const live = useRef<boolean | null>(null);
  if (live.current === null) live.current = o.from !== undefined && !reducedMotion() && !perfLow();
  const [shown, setShown] = useState(() => (live.current ? (o.from as number) : target));
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (!live.current) return;
    const start = shownRef.current;
    if (start === target) return;
    let raf = 0;
    let t0 = 0;
    const tick = (now: number) => {
      if (!t0) t0 = now;
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - (1 - t) ** 3;
      setShown(t >= 1 ? target : Math.round((start + (target - start) * e) / step) * step);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    const begin = setTimeout(() => (raf = requestAnimationFrame(tick)), delay);
    // If frames are paused (hidden WebView), still land on the right number.
    const settle = setTimeout(() => setShown(target), delay + duration + 200);
    return () => {
      clearTimeout(begin);
      clearTimeout(settle);
      cancelAnimationFrame(raf);
    };
  }, [target]);

  return live.current ? shown : target;
}

// Confetti pieces (spec §7.8): shape class, colour class, end offset x/y (px), end rotation (deg).
const PIECES: [string, string, number, number, number][] = [
  ["", "brand", 0, -61, 120],
  ["dot", "lime", 33, -35, -157],
  ["bar", "pink", 76, -23, 194],
  ["", "sky", 66, 14, -231],
  ["dot", "lav", 76, 51, 128],
  ["bar", "star", 33, 63, -165],
  ["", "brand", 0, 89, 202],
  ["dot", "lime", -33, 63, -239],
  ["bar", "pink", -76, 51, 136],
  ["", "sky", -66, 14, -173],
  ["dot", "lav", -76, -23, 210],
  ["bar", "star", -33, -35, -247],
];

/**
 * One confetti burst over the centre of `.success-art` (or `origin`, viewport px), `delay` ms after mount
 * (default 200, the OrderPlaced timing; TopUp passes 520). Removes itself after 1.3s. Renders nothing under
 * Reduce Motion, and only the even pieces on low-end devices. Put it in Screen `overlay`, never inside <main>.
 */
export function Confetti({ n = 12, origin, delay = 200 }: { n?: number; origin?: { x: number; y: number }; delay?: number }): JSX.Element | null {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (reducedMotion()) return;
    const show = setTimeout(() => {
      let p = origin;
      if (!p) {
        const el = document.querySelector(".success-art");
        const r = el?.getBoundingClientRect();
        p = r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight * 0.3 };
      }
      setAt(p);
    }, delay);
    const hide = setTimeout(() => setDone(true), delay + 1300);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, []);

  if (!at || done) return null;
  const low = perfLow();
  const pieces = PIECES.slice(0, Math.max(0, Math.min(n, PIECES.length)))
    .map(([shape, colour, x, y, r], k) =>
      low && k % 2 ? null : createElement("i", { key: k, class: `${shape} k-${colour}`.trim(), style: `--x:${x}px;--y:${y}px;--r:${r}deg;--k:${k}` }),
    )
    .filter(Boolean);
  return createElement("div", { class: "confetti", "aria-hidden": "true", style: `left:${Math.round(at.x)}px;top:${Math.round(at.y)}px` }, pieces);
}
