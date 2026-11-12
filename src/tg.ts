// Thin wrapper over window.Telegram.WebApp. Everything degrades gracefully in a normal browser (local dev).
import { useEffect, useRef } from "preact/hooks";
import { createStore } from "./store";
import { themeStore } from "./theme";

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

export function isDark(): boolean {
  if (webApp) return webApp.colorScheme === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Re-renders native-button users when Telegram (or the OS) switches between light and dark. */
const darkStore = createStore(false);

function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  darkStore.set(dark);
  if (!webApp) return;
  try {
    // Match the design's page colour (not the user's custom Telegram theme)
    const page = dark ? "#000000" : "#f2f2f7";
    webApp.setHeaderColor(page);
    webApp.setBackgroundColor(page);
    webApp.setBottomBarColor?.(page);
  } catch {
    /* older clients */
  }
}

export function initTelegram() {
  // Drop Telegram's launch params from the hash (the SDK has already read them). Keep the router's history state.
  if (/^#tgWebApp/.test(location.hash)) history.replaceState(history.state, "", location.pathname + location.search + "#/");
  applyTheme();
  if (!webApp) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    return;
  }
  webApp.onEvent("themeChanged", applyTheme);
  // One BackButton listener for the whole app: only the newest handler on the stack runs (a sheet before its page).
  webApp.BackButton.onClick(() => backStack[backStack.length - 1]?.());
  webApp.expand();
  if (atLeast("7.7")) webApp.disableVerticalSwipes?.();
  webApp.ready();
}

/** At most one haptic per user action (spec §4.3). */
export const haptic = {
  /** Tabs, segments, presets, chips, radios, pay options, switches, stepper ± */
  select: () => webApp?.HapticFeedback.selectionChanged(),
  /** Navigation rows, platform tiles, opening a sheet, quick-change chips, "Again" */
  tap: () => webApp?.HapticFeedback.impactOccurred("light"),
  /** A stepper hit its min or max */
  edge: () => webApp?.HapticFeedback.impactOccurred("rigid"),
  /** Pay / Pay with Stars, right before the invoice opens */
  press: () => webApp?.HapticFeedback.impactOccurred("medium"),
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

// BackButton handler stack (spec §4.6). Telegram calls one listener (registered in initTelegram), which runs only the
// newest handler, so Back inside a sheet closes the sheet and leaves the page alone.
const backStack: (() => void)[] = [];
let backHide: ReturnType<typeof setTimeout> | undefined;

function syncBack() {
  if (!webApp) return;
  clearTimeout(backHide);
  if (backStack.length) webApp.BackButton.show();
  // Hide a moment later: on a screen change the old page drops its handler before the new page adds one,
  // and hiding then showing again makes the header button flicker.
  else backHide = setTimeout(() => !backStack.length && webApp.BackButton.hide(), 150);
}

/** Shows Telegram's BackButton while mounted; the most recently mounted handler wins. Pass null for none. */
export function useBackButton(onBack: (() => void) | null) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!onBack) return;
    const h = () => ref.current?.();
    backStack.push(h);
    syncBack();
    return () => {
      const i = backStack.lastIndexOf(h);
      if (i >= 0) backStack.splice(i, 1);
      syncBack();
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

/** Which mounted hook last showed each native button, so an unmounting screen doesn't hide the next screen's button. */
const shownBy = new WeakMap<BottomButton, object>();

function useNativeButton(btn: BottomButton | undefined, spec: ButtonSpec | null, primary: boolean) {
  const ref = useRef(spec);
  ref.current = spec;
  const self = useRef({}).current;
  const dark = darkStore.use();
  const theme = themeStore.use();
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  useEffect(() => {
    if (!btn) return;
    const cb = () => {
      const s = ref.current;
      if (s && !s.disabled && !s.progress) s.onClick();
    };
    btn.onClick(cb);
    return () => {
      btn.offClick(cb);
      if (shownBy.get(btn) !== self) return;
      shownBy.delete(btn);
      // Hide a moment later, so moving to a screen that shows the same button doesn't make it slide out and back.
      setTimeout(() => !shownBy.has(btn) && btn.hide(), 150);
    };
  }, [btn]);
  useEffect(() => {
    if (!btn) return;
    if (!spec) {
      const owner = shownBy.get(btn);
      if (!owner || owner === self) {
        shownBy.delete(btn);
        btn.hide();
      }
      return;
    }
    shownBy.set(btn, self);
    // Spec §3.20 colours [background, text], from the brand theme (native buttons can't read CSS variables)
    const c = dark ? theme.nativeDark : theme.nativeLight;
    const [color, text_color] = primary ? (spec.disabled ? c.mainOff : c.main) : c.secondary;
    btn.setParams({
      text: spec.text,
      color,
      text_color,
      is_active: !spec.disabled,
      is_visible: true,
      // The SecondaryButton sits on the reading-start side: left in LTR, right in Arabic.
      ...(primary ? { has_shine_effect: !!spec.shine && !spec.disabled && !spec.progress } : { position: rtl ? "right" : "left" }),
    });
    if (spec.progress) btn.showProgress(false);
    else btn.hideProgress();
  }, [btn, spec?.text, spec?.disabled, spec?.progress, spec?.shine, dark, rtl, theme]);
}

/** Telegram MainButton (+ SecondaryButton). Returns true when native buttons are used. */
export function useBottomButtons(main: ButtonSpec | null, secondary: ButtonSpec | null = null): boolean {
  useNativeButton(webApp?.MainButton, main, true);
  useNativeButton(hasSecondaryButton ? webApp!.SecondaryButton : undefined, secondary, false);
  return !!webApp;
}
