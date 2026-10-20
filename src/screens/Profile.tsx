import { useEffect, useRef, useState } from "preact/hooks";
import { LANGS, LANG_NAMES, langLabel, type Lang } from "../../shared/types";
import { clearApiCache } from "../api";
import { getLang, setLang, t } from "../i18n";
import { Icon } from "../icons";
import { iso, stars } from "../format";
import { updateMe } from "../me";
import { meStore } from "../store";
import { haptic, homeScreen, openLink, openTelegramLink, requestWriteAccess, webApp } from "../tg";
import { TermsSheet, openExternalTerms } from "./Terms";
import { brandStore } from "../theme";
import { BrandMark, LargeTitle, List, Row, Screen, Section, Sheet, errText, toast } from "../ui";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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
  const brand = brandStore.use();
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
            <Row key={l} radio checked={l === me.lang} title={<span lang={l}>{langLabel(l)}</span>} onClick={() => pickLang(l)} />
          ))}
        </List>
      </Sheet>
    ) : sheet === "terms" ? (
      <TermsSheet onClose={() => setSheet(null)} />
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

      {me.referralEnabled ? (
        <List>
          <Row icon="users" plate="var(--lime)" title={t("invite.title")} meta={t("invite.sub", { amount: iso(stars(me.referralReward)) })} href="/invite" />
        </List>
      ) : null}

      {me.channelUrl || brand.websiteUrl ? (
      <div class={"link-tiles" + (me.channelUrl && brand.websiteUrl ? "" : " one")}>
        {me.channelUrl ? (
          <button
            type="button"
            class="link-tile press"
            aria-label={`${t("profile.channel")}, ${t("profile.channelSub")}`}
            onClick={() => {
              haptic.tap();
              openTelegramLink(me.channelUrl!);
            }}
          >
            <span class="tile md brand">
              <Icon name="plane" size={22} stroke={1.8} />
            </span>
            <Icon class="lt-out" name="out" size={16} stroke={2} />
            <span class="lt-text">
              <span class="lt-title">{t("profile.channel")}</span>
              <span class="lt-hint">{t("profile.channelSub")}</span>
            </span>
          </button>
        ) : null}
        {brand.websiteUrl ? (
          <button
            type="button"
            class="link-tile press"
            aria-label={`${t("profile.website")}, ${hostOf(brand.websiteUrl)}`}
            onClick={() => {
              haptic.tap();
              openLink(brand.websiteUrl!);
            }}
          >
            <span class="tile md brand">
              <Icon name="globe" size={22} stroke={1.8} />
            </span>
            <Icon class="lt-out" name="out" size={16} stroke={2} />
            <span class="lt-text">
              <span class="lt-title">{t("profile.website")}</span>
              <span class="lt-hint" dir="ltr">
                {hostOf(brand.websiteUrl)}
              </span>
            </span>
          </button>
        ) : null}
      </div>
      ) : null}

      <List>
        <Row
          icon="globe"
          plate="var(--lavender-strong)"
          title={t("profile.language")}
          value={<span lang={me.lang}>{me.lang === "en" ? LANG_NAMES.en : langLabel(me.lang)}</span>}
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
        <Row icon="doc" plate="var(--lavender)" title={t("profile.terms")} onClick={() => (openExternalTerms() ? undefined : setSheet("terms"))} external={!!brand.termsUrl} />
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

      <div class="brand-foot">
        <BrandMark size={22} />
        <span class="ellipsis">{brand.name}</span>
      </div>
    </Screen>
  );
}
