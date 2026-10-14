// Hash router: #/path?query. Back goes through history so Telegram's BackButton and Android back work naturally.
// Sets html[data-nav] = push | pop | swap before each route change (drives the screen enter animation, spec §4.1)
// and remembers the scroll position of every screen it leaves, restoring it on Back.
import { useEffect, useState } from "preact/hooks";

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

type Nav = "push" | "pop" | "swap";
type State = { depth?: number; y?: number } | null;

function parse(): Route {
  // Telegram appends its launch data (#tgWebAppData=…&tgWebAppVersion=…) to the URL; ignore it.
  let raw = location.hash.replace(/^#/, "").replace(/[?&]?tgWebApp[\s\S]*$/, "");
  if (!raw.startsWith("/")) raw = "/";
  const [path, q = ""] = raw.split("?");
  return { path, parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

const state = (): State => history.state as State;
let depth = Math.max(0, state()?.depth ?? 0);
/** Direction of the route change in flight, read by the hashchange listener below. */
let pending: Nav | null = null;
/** Scroll position to restore after a pop. */
let restoreY: number | null = null;
let navTimer: ReturnType<typeof setTimeout> | undefined;

function setNav(nav: Nav) {
  pending = nav;
  const root = document.documentElement;
  root.dataset.nav = nav;
  // Drop it once the enter animation is over, so a screen that later swaps its own <main> doesn't replay it.
  clearTimeout(navTimer);
  navTimer = setTimeout(() => delete root.dataset.nav, 1200);
}

function change(to: string, mode: "push" | "replace", nav: Nav) {
  const url = "#" + to;
  if (mode === "replace") {
    const { y: _y, ...rest } = state() ?? {};
    history.replaceState({ ...rest, depth }, "", url);
  } else {
    // Remember where the user was on the screen they are leaving.
    history.replaceState({ ...state(), depth, y: window.scrollY }, "");
    depth++;
    history.pushState({ depth }, "", url);
  }
  setNav(nav);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Go to a route. `replace` (tabs, redirects, in-flow swaps) replaces the current history entry. */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  change(to, opts.replace ? "replace" : "push", opts.replace ? "swap" : "push");
}

/**
 * Go back if we navigated inside the app, otherwise to the fallback route. `depth` drops right away (popstate re-syncs
 * it), so a fast second Back before popstate arrives can't step past the app's launch entry.
 */
export function back(fallback = "/") {
  if (depth > 0) {
    depth--;
    history.back();
  } else change(fallback, "replace", "pop");
}

/** Next frame, or a short timer when frames are paused (hidden WebView). */
function nextFrame(fn: () => void) {
  let done = false;
  const run = () => !done && ((done = true), fn());
  requestAnimationFrame(run);
  setTimeout(run, 40);
}

let scrollRun = 0;

/**
 * Scrolls to `y` once the restored screen is tall enough (its data may still be loading).
 * A touch, a wheel or the next route change cancels it.
 */
function restoreScroll(y: number) {
  const run = ++scrollRun;
  const until = performance.now() + 800;
  let stop = false;
  const cancel = () => (stop = true);
  addEventListener("touchstart", cancel, { passive: true, once: true });
  addEventListener("wheel", cancel, { passive: true, once: true });
  const tick = () => {
    if (run !== scrollRun) stop = true;
    if (!stop) window.scrollTo(0, y);
    if (!stop && Math.abs(window.scrollY - y) > 1 && performance.now() < until) nextFrame(tick);
    else {
      removeEventListener("touchstart", cancel);
      removeEventListener("wheel", cancel);
    }
  };
  nextFrame(tick);
}

if (typeof window !== "undefined") {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  // Stamp the launch entry, so a history entry without our state can only come from a plain link.
  if (typeof state()?.depth !== "number") history.replaceState({ ...state(), depth }, "");

  // Telegram Back, Android back, browser back/forward, and plain #links.
  addEventListener("popstate", () => {
    const s = state();
    if (s && typeof s.depth === "number") {
      const nav: Nav = s.depth > depth ? "push" : "pop";
      depth = s.depth;
      restoreY = nav === "pop" && typeof s.y === "number" ? s.y : null;
      setNav(nav);
    } else {
      // A plain <a href="#/…"> made a new entry without our state: count it as a push.
      depth++;
      history.replaceState({ depth }, "");
      restoreY = null;
      setNav("push");
    }
  });

  // Registered before any component listener, so the scroll is settled before screens re-render.
  addEventListener("hashchange", () => {
    const nav = pending ?? "push";
    const y = restoreY;
    pending = restoreY = null;
    scrollRun++;
    if (nav === "pop" && y !== null) restoreScroll(y);
    else window.scrollTo(0, 0);
  });
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const enc = encodeURIComponent;
