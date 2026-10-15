import { useRef, useState } from "preact/hooks";
import type { Me } from "../../shared/types";
import { api } from "../api";
import { ArtWelcome } from "../art";
import { t } from "../i18n";
import { meStore } from "../store";
import { haptic, openTelegramLink } from "../tg";
import { BottomButtons, Notice, Screen, errText, toast } from "../ui";
import "./ChannelGate.css";

type Verify = { result: "member" | "not_member" | "unavailable"; me: Me };

/** Shown until the user has joined the update channel (and again if they leave it later). */
export function ChannelGate() {
  const me = meStore.use()!;
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notJoined, setNotJoined] = useState(false);
  const busyRef = useRef(false);

  // Verify appears once the user has tapped "Open channel" (they come back to it after joining).

  const open = () => {
    if (!me.channelUrl) return;
    haptic.tap();
    setOpened(true);
    openTelegramLink(me.channelUrl);
  };

  const verify = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await api<Verify>("/channel/verify", { method: "POST", body: {} });
      if (r.result === "not_member") {
        haptic.error();
        setNotJoined(true);
        setBusy(false);
        busyRef.current = false;
        return;
      }
      haptic.success();
      if (r.result === "member") toast(t("gate.joined"), "ok");
      meStore.set(r.me);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Without a channel link there is nothing to open: only Verify.
  const showVerify = opened || !me.channelUrl;
  const main = busy
    ? { text: t("gate.checking"), onClick: verify, progress: true }
    : showVerify
      ? { text: t("gate.verify"), onClick: verify }
      : { text: t("gate.open"), onClick: open };
  const secondary = showVerify && me.channelUrl && !busy ? { text: t("gate.open"), onClick: open } : null;

  return (
    <Screen bottom="native" center class="onboard" overlay={<BottomButtons main={main} secondary={secondary} />}>
      <ArtWelcome />
      <h1 class="gate-title rise" style="--d:140ms">
        {t("gate.title")}
      </h1>
      <p class="gate-body rise" style="--d:180ms">
        {t("gate.body")}
      </p>
      <ol class="gate-steps">
        {(["gate.step1", "gate.step2", "gate.step3"] as const).map((k, i) => (
          <li class="rise" key={k} style={`--d:${220 + i * 60}ms`}>
            <span class="n" aria-hidden="true">
              {i + 1}
            </span>
            <span>{t(k)}</span>
          </li>
        ))}
      </ol>
      {notJoined ? (
        <div class="gate-note">
          <Notice tone="warn">{t("gate.notJoined")}</Notice>
        </div>
      ) : null}
    </Screen>
  );
}
