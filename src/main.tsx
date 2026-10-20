import { render } from "preact";
import "./styles.css";
import "./art"; // registers the empty-state art with ui.tsx
import { App, applyStartRoute } from "./app";
import { keyboardStore } from "./store";
import { api, cachedApi } from "./api";
import type { PublicStatus } from "../shared/brand";
import { applyBrand, hasCachedBrand } from "./theme";
import { savedLang, setLang } from "./i18n";
import { initData, initTelegram } from "./tg";

initTelegram();
applyStartRoute();

// First ever launch (no cached brand yet): fetch the colors and name now instead of waiting for /api/me.
if (initData && !hasCachedBrand) api<PublicStatus>("/public").then((p) => applyBrand(p.brand)).catch(() => {});

// Load translations in parallel with /api/me (no English flash); the /me result still wins afterwards.
void setLang(savedLang() ?? (globalThis as any).Telegram?.WebApp?.initDataUnsafe?.user?.language_code);

// Start the platform list now, in parallel with /api/me; Home reuses this in-flight request.
if (initData || import.meta.env.DEV) cachedApi("/catalog/platforms").catch(() => {});

// iOS WebKit applies :active (press states) only when the page has a touch listener.
document.addEventListener("touchstart", () => {}, { passive: true });

// While a text field has focus the keyboard is up: floating bars step aside (html[data-kb], keyboardStore).
const NO_KEYBOARD = /^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/;
function syncKeyboard() {
  const el = document.activeElement;
  const on = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NO_KEYBOARD.test(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
  document.documentElement.toggleAttribute("data-kb", on);
  if (keyboardStore.get() !== on) keyboardStore.set(on);
}
document.addEventListener("focusin", syncKeyboard);
// Checked after the focus has moved, so going from one field to the next doesn't flash the bars.
document.addEventListener("focusout", () => setTimeout(syncKeyboard, 0));

render(<App />, document.getElementById("app")!);
