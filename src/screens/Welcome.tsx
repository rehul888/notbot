import { useState } from "preact/hooks";
import type { Me } from "../../shared/types";
import { api } from "../api";
import { ArtWelcome } from "../art";
import { t } from "../i18n";
import { Icon, type IconName } from "../icons";
import { meStore } from "../store";
import { haptic } from "../tg";
import { TermsSheet, openExternalTerms } from "./Terms";
import { BottomButtons, Screen, errText, toast } from "../ui";

// Icon plate colours are fixed in both themes (spec §5.3): sky/link, lime/star, pink/bell.
const FEATURES: [IconName, string, "welcome.f1" | "welcome.f2" | "welcome.f3"][] = [
  ["link", "var(--sky)", "welcome.f1"],
  ["star", "var(--lime)", "welcome.f2"],
  ["bell", "var(--pink)", "welcome.f3"],
];

/** Shown until the terms are accepted: what the app does, in three lines, and one Continue. */
export function Welcome() {
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      const me = await api<Me>("/me", { method: "PATCH", body: { acceptTerms: true } });
      haptic.success();
      meStore.set(me);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };
  const openTerms = () => {
    haptic.tap();
    if (!openExternalTerms()) setTerms(true);
  };
  // "By continuing you agree to the {terms}." with {terms} as an inline button, in any word order.
  const legal = t("welcome.legal", { terms: "\u0000" }).split("\u0000");

  return (
    <Screen
      bottom="native"
      center
      class="onboard"
      overlay={
        <>
          <BottomButtons main={{ text: t("welcome.continue"), onClick: accept, progress: busy }} />
          {terms ? <TermsSheet onClose={() => setTerms(false)} /> : null}
        </>
      }
    >
      <ArtWelcome />
      <header class="lt lt-center rise" style="--d:140ms">
        <h1 class="t-large welcome-title">{t("welcome.title")}</h1>
        <p class="welcome-sub">{t("welcome.subtitle")}</p>
      </header>
      <div class="features" role="list">
        {FEATURES.map(([icon, plate, key], i) => (
          <div class="feature rise" role="listitem" key={key} style={`--d:${220 + i * 60}ms`}>
            <span class="tile md" style={`background:${plate}`} aria-hidden="true">
              <Icon name={icon} size={20} stroke={1.8} />
            </span>
            <span>{t(key)}</span>
          </div>
        ))}
      </div>
      <p class="legal fade" style="--d:420ms">
        {legal[0]}
        <button type="button" class="textbtn inline" aria-haspopup="dialog" onClick={openTerms}>
          {t("welcome.terms")}
        </button>
        {legal[1]}
      </p>
    </Screen>
  );
}
