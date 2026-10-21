// Update-channel gate and referral rewards.
import { type Lang, pickLang, type ReferralStats } from "../shared/types";
import { starsCredit } from "../shared/stars";
import { balanceText, starsText } from "./botMessages";
import { type Env, isOwner } from "./env";
import { alertAdmins } from "./alerts";
import { botText } from "./i18n";
import { getSettings, type Settings } from "./settings";
import { tg, webAppButton } from "./telegram";

const DAY = 86400;
const MEMBER = new Set(["creator", "administrator", "member"]);

export type ChannelCheck = "member" | "not_member" | "unavailable";

/** Telegram asked us to slow down: the user should simply try again (never treated as "let in"). */
export class RetryLater extends Error {}

/** Asks Telegram whether the user is in the update channel. "unavailable" = Telegram couldn't answer (bot not admin, wrong id…). */
export async function checkChannel(env: Env, s: Settings, userId: number): Promise<ChannelCheck> {
  if (!s.channel_id) return "unavailable";
  try {
    const m = await tg<{ status: string; is_member?: boolean }>(env.BOT_TOKEN, "getChatMember", { chat_id: s.channel_id, user_id: userId });
    return MEMBER.has(m.status) || (m.status === "restricted" && m.is_member) ? "member" : "not_member";
  } catch (e) {
    const msg = (e as Error).message;
    // "user not found" / "PARTICIPANT_ID_INVALID" means the user simply isn't in the channel
    if (/user not found|participant/i.test(msg)) return "not_member";
    if (/\b429\b|too many requests/i.test(msg)) throw new RetryLater(msg);
    console.error("channel check unavailable", msg);
    await alertAdmins(
      env,
      "channel",
      "The bot can't check members of your update channel, so new users can't be confirmed and <b>referral rewards are on hold</b>.\n\n" +
        "Make the bot an <b>admin of the channel</b> (and check the channel ID in Settings). Held rewards are paid automatically once it works.\n\n" +
        `<i>Telegram said: ${msg.replace(/[<>&]/g, "")}</i>`,
    );
    return "unavailable";
  }
}

/** users.channel_ok values */
const NOT_CONFIRMED = 0;
const MEMBER_OK = 1;
const PASSED_UNCONFIRMED = 2;

export interface GateUser {
  id: number;
  channel_ok: number;
  channel_checked_at: number | null;
}

/**
 * Whether the app should show the "join the update channel" step. Owners are never gated. Users who confirmed
 * membership are re-checked once a day (cheap) so leaving the channel brings the step back. If Telegram can't
 * answer, the user is let through but stays unconfirmed (no referral reward without a real confirmation).
 */
export async function channelGateRequired(
  env: Env,
  s: Settings,
  u: GateUser,
  opts: { background?: (p: Promise<unknown>) => void } = {},
): Promise<boolean> {
  if (!s.channel_gate || !s.channel_id || isOwner(env, s, u.id)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (u.channel_ok === NOT_CONFIRMED) return true;
  // Member, or let through while Telegram was unavailable: re-check once a day
  if (u.channel_checked_at && now - u.channel_checked_at < DAY) return false;
  const recheck = async () => {
    const r = await checkChannel(env, s, u.id).catch(() => "unavailable" as const);
    const next = r === "member" ? MEMBER_OK : r === "not_member" ? NOT_CONFIRMED : u.channel_ok;
    await env.DB.prepare("UPDATE users SET channel_ok = ?2, channel_checked_at = ?3 WHERE id = ?1").bind(u.id, next, now).run();
    return next;
  };
  if (opts.background) {
    // Answer from the cached state now; the result applies on the next request (leaving the channel brings the step back then)
    opts.background(recheck().catch((e) => console.warn("channel recheck failed", (e as Error).message)));
    return false;
  }
  const next = await recheck();
  u.channel_ok = next;
  u.channel_checked_at = now;
  return next === NOT_CONFIRMED;
}

/** The Verify button: confirms membership now. Returns the check result; "unavailable" lets the user through unconfirmed. */
export async function verifyChannel(env: Env, s: Settings, userId: number): Promise<ChannelCheck> {
  const now = Math.floor(Date.now() / 1000);
  const slot = await env.DB.prepare(
    "UPDATE users SET channel_checked_at = ?2 WHERE id = ?1 AND (channel_checked_at IS NULL OR channel_checked_at <= ?2 - 5)",
  )
    .bind(userId, now)
    .run();
  if (!slot.meta.changes) throw new RetryLater("too fast");
  const r = await checkChannel(env, s, userId);
  // Unavailable: let the user in as "passed, unconfirmed" (2) — never downgrade a confirmed member, never pays referrals
  const value = r === "member" ? MEMBER_OK : r === "not_member" ? NOT_CONFIRMED : PASSED_UNCONFIRMED;
  await env.DB.prepare(
    `UPDATE users SET channel_ok = CASE WHEN ?2 = ${PASSED_UNCONFIRMED} AND channel_ok = ${MEMBER_OK} THEN channel_ok ELSE ?2 END,
       channel_checked_at = ?3 WHERE id = ?1`,
  )
    .bind(userId, value, Math.floor(Date.now() / 1000))
    .run();
  return r;
}

/** "ref_123" → 123 */
export function parseRef(startParam: string | null | undefined): number | null {
  const m = /^ref_(\d{1,15})$/.exec(startParam ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Links a referred user to the referrer. Only for users first seen in the last 2 minutes (a referral link can't be
 * applied to an existing account), never to yourself, only to an existing referrer, and only once per user.
 */
export async function attachReferral(env: Env, s: Settings, referredId: number, referrerId: number | null): Promise<void> {
  if (!s.referral_enabled || !referrerId || referrerId === referredId) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO referrals (referred_id, referrer_id, created_at)
     SELECT ?1, ?2, ?3
     WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND banned = 0)
       AND (SELECT created_at FROM users WHERE id = ?1) >= ?3 - 120
     ON CONFLICT(referred_id) DO NOTHING`,
  )
    .bind(referredId, referrerId, now)
    .run();
}

/** Referral reward as users see it, whole Stars */
export function rewardStars(s: Settings): number {
  return Math.max(0, Math.round(s.referral_reward_stars));
}

/** micro-USD credited for one referral: the dollar value of the Stars reward at today's rate */
export function rewardMicro(s: Settings): number {
  return starsCredit(rewardStars(s), s.stars_per_usd);
}

/**
 * The user reached the home screen. Records it, and if they were referred and have picked a language, accepted the
 * terms and have a Telegram-confirmed channel membership, pays the referrer once (subject to the daily cap).
 */
export async function onHomeReached(env: Env, s: Settings, waitUntil: (p: Promise<unknown>) => void, userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE users SET home_at = ?2 WHERE id = ?1 AND home_at IS NULL").bind(userId, now).run();
  await payReferral(env, s, waitUntil, userId);
}

/**
 * Pays the referrer of `userId` once, if the referral is still pending and the friend has picked a language, accepted
 * the terms and has a Telegram-confirmed channel membership (asked again here if not confirmed yet). Returns
 * "paid" | "capped" | "not_member" | "unavailable" | "skip".
 */
export async function payReferral(
  env: Env,
  s: Settings,
  waitUntil: (p: Promise<unknown>) => void,
  userId: number,
): Promise<"paid" | "capped" | "not_member" | "unavailable" | "skip"> {
  const now = Math.floor(Date.now() / 1000);
  if (!s.referral_enabled) return "skip";
  const ref = await env.DB.prepare(
    `SELECT r.referrer_id, u.first_name, u.channel_ok FROM referrals r JOIN users u ON u.id = r.referred_id
     WHERE r.referred_id = ?1 AND r.status = 'pending' AND u.lang IS NOT NULL AND u.terms_accepted_at IS NOT NULL AND u.banned = 0
       AND EXISTS (SELECT 1 FROM users ru WHERE ru.id = r.referrer_id AND ru.banned = 0)`,
  )
    .bind(userId)
    .first<{ referrer_id: number; first_name: string; channel_ok: number }>();
  if (!ref) return "skip";
  // A reward needs a Telegram-confirmed membership. If the join step didn't confirm it (gate off, or Telegram was
  // unavailable at Verify), ask Telegram now. Unconfirmed referrals are retried by the cron (retryReferrals).
  if (ref.channel_ok !== MEMBER_OK) {
    if (!s.channel_id) return "skip";
    const r = await checkChannel(env, s, userId).catch(() => "unavailable" as const);
    if (r !== "member") return r;
    await env.DB.prepare("UPDATE users SET channel_ok = 1, channel_checked_at = ?2 WHERE id = ?1").bind(userId, now).run();
  }
  const reward = rewardMicro(s);
  if (reward <= 0) return "skip";
  // Daily cap per referrer: over the cap the referral is recorded as "capped" (counted, not paid).
  const [mark] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE referrals SET status = CASE
           WHEN (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?2 AND status = 'rewarded' AND rewarded_at > ?4 - 86400) >= ?5 THEN 'capped'
           ELSE 'rewarded' END,
         reward = ?3, rewarded_at = ?4
       WHERE referred_id = ?1 AND status = 'pending' AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND banned = 0)`,
    ).bind(userId, ref.referrer_id, reward, now, s.referral_daily_cap),
    // Pay only if this run just moved the row out of 'pending' AND it became 'rewarded' (not 'capped')
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, kind, ref, created_at)
       SELECT ?2, ?3, 'referral', ?1, ?4 WHERE changes() = 1 AND (SELECT status FROM referrals WHERE referred_id = ?1) = 'rewarded'`,
    ).bind(userId, ref.referrer_id, reward, now),
    env.DB.prepare("UPDATE users SET balance = balance + ?2 WHERE id = ?1 AND changes() = 1").bind(ref.referrer_id, reward),
  ]);
  if (!mark.meta.changes) return "skip"; // someone else already handled it
  const paid = await env.DB.prepare("SELECT status FROM referrals WHERE referred_id = ?1").bind(userId).first<{ status: string }>();
  if (paid?.status !== "rewarded") return "capped";
  waitUntil(notifyReferrer(env, s, ref.referrer_id, ref.first_name).catch((e) => console.warn("referral notify failed", e)));
  return "paid";
}

const RETRY_BATCH = 4; // per cron run: one membership check (+ one message) each, so the run stays well under 50 calls
const RETRY_EVERY = 3600; // re-check an unconfirmed friend at most hourly
const RETRY_FOR = 30 * DAY; // stop asking after a month

/**
 * Cron: referrals whose friend reached the home screen but whose channel membership couldn't be confirmed then (for
 * example the bot wasn't a channel admin yet). Checks a few per run and pays as soon as Telegram confirms the membership,
 * so a reward is never stuck. Stops early if Telegram can't answer (the admins are alerted by checkChannel).
 */
export async function retryReferrals(env: Env): Promise<void> {
  const s = await getSettings(env);
  if (!s.referral_enabled || !s.channel_id || s.sync_state) return;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    `SELECT r.referred_id FROM referrals r JOIN users u ON u.id = r.referred_id
     WHERE r.status = 'pending' AND u.home_at IS NOT NULL AND u.home_at > ?1 AND u.banned = 0 AND COALESCE(r.checked_at, 0) < ?2
     ORDER BY COALESCE(r.checked_at, 0), r.created_at LIMIT ${RETRY_BATCH}`,
  )
    .bind(now - RETRY_FOR, now - RETRY_EVERY)
    .all<{ referred_id: number }>();
  const later: Promise<unknown>[] = [];
  for (const { referred_id } of results) {
    const r = await payReferral(env, s, (p) => later.push(p), referred_id);
    if (r === "unavailable") break; // Telegram can't check the channel: try again next hour
    await env.DB.prepare("UPDATE referrals SET checked_at = ?2 WHERE referred_id = ?1").bind(referred_id, now).run();
  }
  await Promise.allSettled(later);
}

async function notifyReferrer(env: Env, s: Settings, referrerId: number, friend: string) {
  const u = await env.DB.prepare("SELECT lang, language_code, can_message, balance FROM users WHERE id = ?1")
    .bind(referrerId)
    .first<{ lang: string | null; language_code: string | null; can_message: number; balance: number }>();
  if (!u?.can_message) return;
  const lang: Lang = pickLang(u.lang ?? u.language_code);
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: referrerId,
    text: botText(lang, "referralReward", { name: friend || "—", amount: starsText(rewardStars(s)), balance: balanceText(u.balance, s) }),
    parse_mode: "HTML",
    reply_markup: s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "inviteMore"), `${s.app_url}/#/invite`, "invite")]] } : undefined,
  });
}

export async function referralStats(env: Env, s: Settings, userId: number): Promise<ReferralStats> {
  const [totals, recent] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS invited, SUM(status != 'pending') AS joined, COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) AS earned
       FROM referrals WHERE referrer_id = ?1`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT u.first_name AS name, r.status, COALESCE(r.rewarded_at, r.created_at) AS at FROM referrals r
       LEFT JOIN users u ON u.id = r.referred_id WHERE r.referrer_id = ?1 ORDER BY r.created_at DESC LIMIT 10`,
    ).bind(userId),
  ]);
  const t = totals.results[0] as { invited: number; joined: number | null; earned: number };
  return {
    link: s.bot_username ? `https://t.me/${s.bot_username}?start=ref_${userId}` : null,
    enabled: !!s.referral_enabled,
    rewardStars: rewardStars(s),
    reward: rewardMicro(s),
    invited: t.invited,
    joined: t.joined ?? 0,
    earned: t.earned,
    recent: (recent.results as { name: string | null; status: "pending" | "rewarded" | "capped"; at: number }[]).map((r) => ({
      name: r.name || "—",
      status: r.status,
      at: r.at,
    })),
  };
}
