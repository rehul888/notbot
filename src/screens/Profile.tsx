import { useEffect, useRef, useState } from "preact/hooks";
import { LANG_NAMES, LANGS, type Lang } from "../../shared/types";
import { api, clearApiCache } from "../api";
import { getLang, setLang, t } from "../i18n";
import { Icon } from "../icons";
import { updateMe } from "../me";
import { meStore } from "../store";
import { homeScreen, isDark, openTelegramLink, requestWriteAccess, webApp } from "../tg";
import { ErrorState, LargeTitle, List, Row, Screen, Section, Sheet, Skeleton, errText, toast } from "../ui";

/** First letter of each name, uppercased for the UI language (whole characters, so emoji and surrogates survive). */
function initials(first: string, last: string): string {
  const s = (Array.from(first.trim())[0] ?? "") + (Array.from(last.trim())[0] ?? "");
  return s.toLocaleUpperCase(getLang()) || "?";
}

/** 88px avatar: Telegram photo, or initials on pink when there is none (or it fails to load). */
function Avatar({ url, first, last }: { url: string | null; first: string; last: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span class="avatar" aria-hidden="true">
      {url && !broken ? <img src={url} alt="" decoding="async" onError={() => setBroken(true)} /> : initials(first, last)}
    </span>
  );
}

export function Profile() {
  const me = meStore.use()!;
  const [sheet, setSheet] = useState<"lang" | "terms" | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  const [termsErr, setTermsErr] = useState<unknown>(null);
  const [home, setHome] = useState("unsupported");
  // While the notify request is in flight the switch shows the new state; the server's answer then wins.
  const [notifyPending, setNotifyPending] = useState<boolean | null>(null);
  const notifyBusy = useRef(false);

  useEffect(() => {
    if (!homeScreen.supported) return;
    let live = true;
    homeScreen.status().then((s) => live && setHome(s));
    const added = () => setHome("added");
    webApp?.onEvent("homeScreenAdded", added);
    return () => {
      live = false;
      webApp?.offEvent("homeScreenAdded", added);
    };
  }, []);

  const pickLang = async (l: Lang) => {
    // Row radio fires the selection haptic; the sheet unmounts straight away (spec: picks call the parent directly).
    setSheet(null);
    if (l === me.lang && l === getLang()) return;
    try {
      const m = await updateMe({ lang: l });
      clearApiCache();
      await setLang(m.lang);
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const toggleNotify = async (on: boolean) => {
    if (notifyBusy.current) return;
    notifyBusy.current = true;
    setNotifyPending(on);
    try {
      if (on && !me.canMessage) {
        const ok = await requestWriteAccess();
        if (!ok) {
          toast(t("profile.notifyDenied"));
          return;
        }
        await updateMe({ notify: true, canMessage: true });
      } else await updateMe({ notify: on });
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      notifyBusy.current = false;
      setNotifyPending(null);
    }
  };

  const loadTerms = () => {
    setTermsErr(null);
    api<{ terms: string }>("/terms").then((r) => setTerms(r.terms), setTermsErr);
  };
  const openTerms = () => {
    setSheet("terms");
    if (terms === null) loadTerms();
  };

  const support = () =>
    me.supportUsername
      ? openTelegramLink(`https://t.me/${me.supportUsername}`)
      : me.botUsername
        ? openTelegramLink(`https://t.me/${me.botUsername}`)
        : undefined;

  const fullName = `${me.firstName} ${me.lastName}`.trim();
  const notifyOn = notifyPending ?? (me.notify && me.canMessage);

  const overlay =
    sheet === "lang" ? (
      <Sheet title={t("profile.language")} onClose={() => setSheet(null)}>
        <List role="radiogroup" label={t("profile.language")}>
          {LANGS.map((l) => (
            <Row key={l} radio checked={l === me.lang} title={<span lang={l}>{LANG_NAMES[l]}</span>} onClick={() => pickLang(l)} />
          ))}
        </List>
      </Sheet>
    ) : sheet === "terms" ? (
      <Sheet size="large" title={t("profile.terms")} onClose={() => setSheet(null)}>
        {termsErr ? (
          <ErrorState compact error={termsErr} onRetry={loadTerms} />
        ) : terms === null ? (
          <Skeleton h={18} n={6} radius={6} />
        ) : (
          // The owner writes the terms in one language: let the text pick its own direction inside an RTL UI.
          <p class="desc" dir="auto">
            {terms}
          </p>
        )}
      </Sheet>
    ) : null;

  return (
    <Screen overlay={overlay}>
      <LargeTitle
        align="center"
        size="title2"
        lead={<Avatar url={me.photoUrl} first={me.firstName} last={me.lastName} />}
        title={<bdi>{fullName}</bdi>}
        sub={
          me.username ? (
            <>
              <bdi dir="ltr">@{me.username}</bdi> · {t("profile.account")}
            </>
          ) : (
            t("profile.account")
          )
        }
      />

      <List>
        <Row
          icon="globe"
          plate="var(--lavender-strong)"
          title={t("profile.language")}
          value={<span lang={me.lang}>{LANG_NAMES[me.lang]}</span>}
          onClick={() => setSheet("lang")}
        />
      </List>

      {/* The footer sits right under the switch it explains (not under Terms, where it would read as part of them). */}
      <Section footer={t("profile.notifySub")}>
        <List>
          <Row icon="bell" plate="var(--pink)" title={t("profile.notify")} toggle={{ on: notifyOn, onChange: toggleNotify }} />
        </List>
      </Section>

      <List>
        {homeScreen.supported ? (
          <Row
            icon="phone"
            plate="var(--lime)"
            title={t("profile.home")}
            value={home === "added" ? t("profile.homeAdded") : undefined}
            onClick={home === "added" ? undefined : () => homeScreen.add()}
          />
        ) : null}
        <Row icon="chat" plate="var(--sky)" title={t("profile.support")} onClick={support} external />
        <Row icon="doc" plate="var(--lavender)" title={t("profile.terms")} onClick={openTerms} />
      </List>

      {me.isAdmin ? (
        <Section footer={t("profile.adminNote")}>
          <List>
            <Row
              lead={
                <span class="tile sm brand">
                  <Icon name="shield" size={18} stroke={1.8} />
                </span>
              }
              title={t("profile.admin")}
              href="/admin"
            />
          </List>
        </Section>
      ) : null}

      <img class="wordmark" src={isDark() ? "/brand/wordmark-dark.svg" : "/brand/wordmark-light.svg"} alt="NotPanel" height={22} />
    </Screen>
  );
}
