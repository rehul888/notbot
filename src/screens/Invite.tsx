import type { ReferralStats } from "../../shared/types";
import { api } from "../api";
import { balance, dateTime, iso, num, prettyLink, stars } from "../format";
import { t } from "../i18n";
import { Icon } from "../icons";
import { useCountUp } from "../motion";
import { back } from "../router";
import { haptic, openTelegramLink } from "../tg";
import { BackNav, BottomButtons, EmptyState, ErrorState, LargeTitle, List, Notice, Num, Row, Screen, Section, Skeleton, errText, toast, useAsync } from "../ui";
import "./Invite.css";

function Hero() {
  return (
    <div class="inv-hero" aria-hidden="true">
      <span class="disc" />
      <span class="sat s3">
        <Icon name="star" size={16} stroke={1.8} />
      </span>
      <span class="main">
        <Icon name="users" size={38} stroke={1.8} />
      </span>
      <span class="sat s1">
        <Icon name="plus" size={18} stroke={2.2} />
      </span>
      <span class="sat s2">
        <Icon name="heart" size={18} stroke={1.8} />
      </span>
    </div>
  );
}

/** Counts animate up; Stars earned never animate (design rule) */
function Stat({ label, value, text, count = true }: { label: string; value: number; text: (n: number) => string; count?: boolean }) {
  const counted = useCountUp(value, { from: 0, delay: 150, step: 1 });
  const shown = count ? counted : value;
  return (
    <div class="inv-stat">
      <b class="num-m num" aria-hidden="true">
        {text(shown)}
      </b>
      <span class="sr">{text(value)}</span>
      <span>{label}</span>
    </div>
  );
}

function Body({ r }: { r: ReferralStats }) {
  const live = r.enabled && !!r.link;
  const link = r.link ? (/^https?:\/\//.test(r.link) ? r.link : `https://${r.link}`) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      haptic.success();
      toast(t("common.copied"));
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  return (
    <>
      <Hero />
      <LargeTitle align="center" size="title" title={t("invite.title")} sub={t("invite.sub", { amount: iso(stars(r.rewardStars)) })} />

      {live ? (
        <Section header={t("invite.yourLink")}>
          <div class="card inv-link">
            <span class="mono" dir="ltr">
              {prettyLink(link)}
            </span>
            <button type="button" class="inv-copy press" onClick={copy}>
              <Icon name="doc" size={16} stroke={2} />
              {t("invite.copy")}
            </button>
          </div>
        </Section>
      ) : (
        <Notice tone="info">{t("invite.unavailable")}</Notice>
      )}

      <Section>
        <div class="inv-stats">
          <Stat label={t("invite.invited")} value={r.invited} text={(n) => num(n)} />
          <Stat label={t("invite.joined")} value={r.joined} text={(n) => num(n)} />
          <Stat label={t("invite.earned")} value={r.earned} text={(n) => balance(n)} count={false} />
        </div>
      </Section>

      <Section header={t("invite.how")}>
        <ol class="card inv-steps">
          {[t("invite.how1"), t("invite.how2"), t("invite.how3", { amount: iso(stars(r.rewardStars)) })].map((s, i) => (
            <li key={i}>
              <span class="n">
                <Num>{num(i + 1)}</Num>
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section header={t("invite.friends")}>
        {r.recent.length ? (
          <List>
            {r.recent.slice(0, 10).map((f, i) => (
              <Row
                key={i}
                icon="users"
                plate="var(--lavender)"
                title={<bdi>{f.name}</bdi>}
                meta={dateTime(f.at)}
                value={<span class={"inv-pill " + f.status}>{t(`invite.${f.status}`)}</span>}
                chevron={false}
              />
            ))}
          </List>
        ) : (
          <div class="card">
            <EmptyState compact art={<Hero />} title={t("invite.empty")} body={t("invite.emptySub")} />
          </div>
        )}
      </Section>
    </>
  );
}

export function Invite() {
  const res = useAsync(() => api<ReferralStats>("/referrals"), []);
  const r = res.data;
  const live = !!r && r.enabled && !!r.link;
  const link = r?.link ? (/^https?:\/\//.test(r.link) ? r.link : `https://${r.link}`) : "";
  const share = () => {
    haptic.tap();
    openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t("invite.shareText"))}`);
  };

  return (
    <>
      <BackNav to="/profile" />
      <Screen
        bottom="native"
        overlay={<BottomButtons main={live ? { text: t("invite.share"), onClick: share, shine: true } : null} secondary={{ text: t("common.back"), onClick: () => back("/profile") }} />}
      >
        {res.error ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !r ? (
          <>
            <LargeTitle align="center" size="title" title={t("invite.title")} />
            <Skeleton h={90} />
            <Skeleton h={64} />
            <Skeleton h={90} />
          </>
        ) : (
          <Body r={r} />
        )}
      </Screen>
    </>
  );
}
