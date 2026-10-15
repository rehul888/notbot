import { useState } from "preact/hooks";
import { LANGS, langLabel, type Lang, type Me } from "../../shared/types";
import { api } from "../api";
import { ArtLanguage } from "../art";
import { setLang, t } from "../i18n";
import { meStore } from "../store";
import { webApp } from "../tg";
import { BottomButtons, LargeTitle, List, Row, Screen, errText, toast } from "../ui";

/**
 * The language Telegram reports for this user, when the app has it. Outside Telegram (local dev) the server's guess
 * stands in, since it comes from the same Telegram setting. An unsupported Telegram language gives null (no hint).
 */
function telegramLang(fallback: Lang): Lang | null {
  if (!webApp) return fallback;
  const code = (webApp.initDataUnsafe.user as { id: number; language_code?: string } | undefined)?.language_code;
  const base = code?.toLowerCase().split(/[-_]/)[0];
  return LANGS.find((l) => l === base) ?? null;
}

/** First launch: pick the app language. Telegram's language is pre-selected; each pick previews the app live. */
export function LanguagePick() {
  const me = meStore.use()!;
  const [lang, setChoice] = useState<Lang>(me.lang);
  const [tgLang] = useState(() => telegramLang(me.lang));
  const [busy, setBusy] = useState(false);

  // Row radio already fires haptic.select.
  const pick = (l: Lang) => {
    setChoice(l);
    void setLang(l);
  };
  const save = async () => {
    setBusy(true);
    try {
      meStore.set(await api<Me>("/me", { method: "PATCH", body: { lang } }));
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };

  return (
    <Screen bottom="native" center class="onboard" overlay={<BottomButtons main={{ text: t("lang.continue"), onClick: save, progress: busy }} />}>
      <ArtLanguage />
      <LargeTitle align="center" size="title" title={t("lang.title")} sub={t("lang.sub")} />
      <List role="radiogroup" label={t("lang.title")} stagger>
        {LANGS.map((l) => (
          <Row
            key={l}
            radio
            checked={l === lang}
            title={<span lang={l}>{langLabel(l)}</span>}
            meta={l === tgLang ? t("lang.fromTelegram") : undefined}
            onClick={() => pick(l)}
          />
        ))}
      </List>
    </Screen>
  );
}
