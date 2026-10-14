// Thin wrapper over window.Telegram.WebApp. Everything degrades gracefully in a normal browser (local dev).
import { useEffect, useRef } from "preact/hooks";

interface BottomButton {
  setParams(p: Record<string, unknown>): BottomButton;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

interface WebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number } };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent(e: string, cb: (...a: any[]) => void): void;
  offEvent(e: string, cb: (...a: any[]) => void): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  openInvoice(url: string, cb: (status: "paid" | "cancelled" | "failed" | "pending") => void): void;
  showPopup(p: { title?: string; message: string; buttons?: { id?: string; type?: string; text?: string }[] }, cb?: (id: string) => void): void;
  showAlert(msg: string, cb?: () => void): void;
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  requestWriteAccess(cb: (ok: boolean) => void): void;
  addToHomeScreen?(): void;
  checkHomeScreenStatus?(cb: (s: string) => void): void;
  MainButton: BottomButton;
  SecondaryButton?: BottomButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
}

const w = (globalThis as any).Telegram?.WebApp as WebApp | undefined;
/** True only inside a real Telegram client */
export const inTelegram = !!w && !!w.initData;
export const webApp = inTelegram ? w! : null;

export const initData = webApp?.initData ?? "";
export const startParam = webApp?.initDataUnsafe.start_param ?? new URLSearchParams(location.search).get("tgWebAppStartParam");

const atLeast = (v: string) => !!webApp && webApp.isVersionAtLeast(v);
export const hasSecondaryButton = atLeast("7.10") && !!webApp?.SecondaryButton;

export const BRAND = "#2457ff";

export function isDark(): boolean {
  if (webApp) return webApp.colorScheme === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? "dark" : "light";
  if (!webApp) return;
  try {
    // Match the design's page colour (not the user's custom Telegram theme)
    const page = isDark() ? "#000000" : "#f2f2f7";
    webApp.setHeaderColor(page);
    webApp.setBackgroundColor(page);
    webApp.setBottomBarColor?.(page);
  } catch {
    /* older clients */
  }
}

export function initTelegram() {
  // Drop Telegram's launch params from the hash (the SDK has already read them)
  if (/^#tgWebApp/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search + "#/");
  applyTheme();
  if (!webApp) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    return;
  }
  webApp.onEvent("themeChanged", applyTheme);
  webApp.expand();
  if (atLeast("7.7")) webApp.disableVerticalSwipes?.();
  webApp.ready();
}

export const haptic = {
  select: () => webApp?.HapticFeedback.selectionChanged(),
  tap: () => webApp?.HapticFeedback.impactOccurred("light"),
  success: () => webApp?.HapticFeedback.notificationOccurred("success"),
  error: () => webApp?.HapticFeedback.notificationOccurred("error"),
  warn: () => webApp?.HapticFeedback.notificationOccurred("warning"),
};

export function confirmDialog(message: string, ok: string, cancel: string, destructive = false): Promise<boolean> {
  if (!webApp || !atLeast("6.2")) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) =>
    webApp.showPopup(
      {
        message,
        buttons: [
          { id: "no", type: "default", text: cancel },
          { id: "yes", type: destructive ? "destructive" : "default", text: ok },
        ],
      },
      (id) => resolve(id === "yes"),
    ),
  );
}

export function alertDialog(message: string): Promise<void> {
  if (!webApp || !atLeast("6.2")) {
    window.alert(message);
    return Promise.resolve();
  }
  return new Promise((r) => webApp.showAlert(message, () => r()));
}

export function openInvoice(url: string): Promise<"paid" | "cancelled" | "failed" | "pending"> {
  if (!webApp) {
    window.open(url, "_blank");
    return Promise.resolve("pending");
  }
  return new Promise((r) => webApp.openInvoice(url, r));
}

export function requestWriteAccess(): Promise<boolean> {
  if (!webApp || !atLeast("6.9")) return Promise.resolve(true);
  return new Promise((r) => webApp.requestWriteAccess(r));
}

export function openTelegramLink(url: string) {
  if (webApp) webApp.openTelegramLink(url);
  else window.open(url, "_blank");
}

export function openLink(url: string) {
  if (webApp) webApp.openLink(url);
  else window.open(url, "_blank");
}

export const homeScreen = {
  supported: atLeast("8.0") && !!webApp?.addToHomeScreen,
  add: () => webApp?.addToHomeScreen?.(),
  status: (): Promise<string> =>
    new Promise((r) => (webApp?.checkHomeScreenStatus ? webApp.checkHomeScreenStatus(r) : r("unsupported"))),
};

export function closingConfirmation(on: boolean) {
  if (!webApp) return;
  if (on) webApp.enableClosingConfirmation();
  else webApp.disableClosingConfirmation();
}

/** Shows Telegram's BackButton while mounted. */
export function useBackButton(onBack: (() => void) | null) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!webApp || !onBack) return;
    const cb = () => ref.current?.();
    webApp.BackButton.onClick(cb);
    webApp.BackButton.show();
    return () => {
      webApp.BackButton.offClick(cb);
      webApp.BackButton.hide();
    };
  }, [!!onBack]);
}

export interface ButtonSpec {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  progress?: boolean;
  shine?: boolean;
}

function useNativeButton(btn: BottomButton | undefined, spec: ButtonSpec | null, primary: boolean) {
  const ref = useRef(spec);
  ref.current = spec;
  useEffect(() => {
    if (!btn) return;
    const cb = () => {
      const s = ref.current;
      if (s && !s.disabled && !s.progress) s.onClick();
    };
    btn.onClick(cb);
    return () => {
      btn.offClick(cb);
      btn.hide();
    };
  }, [btn]);
  useEffect(() => {
    if (!btn) return;
    if (!spec) {
      btn.hide();
      return;
    }
    const dark = isDark();
    btn.setParams({
      text: spec.text,
      color: primary ? (spec.disabled ? (dark ? "#2c2c2e" : "#c9d3f5") : BRAND) : dark ? "#1e2847" : "#e6ecff",
      text_color: primary ? (spec.disabled && dark ? "#8e8e93" : "#ffffff") : dark ? "#a8bbff" : "#1b45d6",
      is_active: !spec.disabled,
      is_visible: true,
      ...(primary ? { has_shine_effect: !!spec.shine && !spec.disabled } : { position: "left" }),
    });
    if (spec.progress) btn.showProgress(false);
    else btn.hideProgress();
  }, [btn, spec?.text, spec?.disabled, spec?.progress, spec?.shine, document.documentElement.dataset.theme]);
}

/** Telegram MainButton (+ SecondaryButton). Returns true when native buttons are used. */
export function useBottomButtons(main: ButtonSpec | null, secondary: ButtonSpec | null = null): boolean {
  useNativeButton(webApp?.MainButton, main, true);
  useNativeButton(hasSecondaryButton ? webApp!.SecondaryButton : undefined, secondary, false);
  return !!webApp;
}
