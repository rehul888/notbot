// A card on Home asking to add the app to the device's home screen (Telegram 8.0+), when it isn't there yet:
// first two days after the first launch, then at most every 10 days after "Not now". The timing follows the user
// across devices (Telegram cloud storage).
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";
import { Icon } from "../icons";
import { cloud, haptic, homeScreen, webApp } from "../tg";

const KEY = "home_ask";
const DAY = 86_400_000;
const FIRST = 2 * DAY;
const AGAIN = 10 * DAY;

/** Shown at most once per app launch */
let decided: boolean | null = null;

export function HomeScreenAsk() {
  const [show, setShow] = useState(decided === true);
  useEffect(() => {
    if (decided !== null || !homeScreen.supported) return;
    let live = true;
    void (async () => {
      const status = await homeScreen.status();
      if (status !== "missed") return void (decided = false);
      const next = Number(await cloud.get(KEY)) || 0;
      const now = Date.now();
      if (!next) {
        cloud.set(KEY, String(now + FIRST));
        return void (decided = false);
      }
      decided = now >= next;
      if (live) setShow(decided);
    })();
    const added = () => {
      decided = false;
      setShow(false);
    };
    webApp?.onEvent("homeScreenAdded", added);
    return () => {
      live = false;
      webApp?.offEvent("homeScreenAdded", added);
    };
  }, []);
  if (!show) return null;
  const later = () => {
    cloud.set(KEY, String(Date.now() + AGAIN));
    decided = false;
    setShow(false);
  };
  return (
    <section class="card pad home-ask fade" aria-label={t("homeAsk.title")}>
      <span class="plate" aria-hidden="true">
        <Icon name="phone" size={22} />
      </span>
      <div>
        <b>{t("homeAsk.title")}</b>
        <span>{t("homeAsk.body")}</span>
        <div class="acts">
          <button
            type="button"
            class="btn sm press"
            onClick={() => {
              haptic.tap();
              homeScreen.add();
              later(); // Telegram shows its own dialog; if they add it, the card never comes back
            }}
          >
            {t("homeAsk.add")}
          </button>
          <button type="button" class="btn sm soft press" onClick={later}>
            {t("homeAsk.later")}
          </button>
        </div>
      </div>
    </section>
  );
}
