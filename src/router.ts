// Hash router: #/path?query. Back goes through history so Telegram's BackButton and Android back work naturally.
import { useEffect, useState } from "preact/hooks";

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  // Telegram appends its launch data (#tgWebAppData=…&tgWebAppVersion=…) to the URL; ignore it.
  let raw = location.hash.replace(/^#/, "").replace(/[?&]?tgWebApp[\s\S]*$/, "");
  if (!raw.startsWith("/")) raw = "/";
  const [path, q = ""] = raw.split("?");
  return { path, parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

let depth = 0;

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = "#" + to;
  if (opts.replace) history.replaceState(history.state, "", url);
  else {
    depth++;
    history.pushState({ depth }, "", url);
  }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Go back if we navigated inside the app, otherwise to the fallback route. */
export function back(fallback = "/") {
  if (depth > 0) {
    depth--;
    history.back();
  } else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => {
      setR(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", () => {
      depth = Math.max(0, (history.state?.depth as number | undefined) ?? 0);
    });
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const enc = encodeURIComponent;
