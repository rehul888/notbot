// Urgent problems the owner must fix (bot not admin in the update channel, NotPanel refusing orders, low NotPanel
// balance, price sync failing) are sent to every admin in the bot. Each kind is sent at most once per 6 hours.
// English only, like the admin panel.
import { type Env, ownerIds } from "./env";
import { npCall, usdToMicro } from "./notpanel";
import { getSettings, setSettings } from "./settings";
import { tg, webAppButton } from "./telegram";

export type AlertKind = "channel" | "notpanel" | "low_balance" | "sync";
const EVERY = 6 * 3600;

/** Sends `text` (HTML) to all admins unless the same kind was sent in the last 6 hours. Never throws. */
export async function alertAdmins(env: Env, kind: AlertKind, text: string): Promise<void> {
  try {
    const s = await getSettings(env);
    const now = Math.floor(Date.now() / 1000);
    const sent = JSON.parse(s.alerts_sent || "{}") as Partial<Record<AlertKind, number>>;
    if ((sent[kind] ?? 0) > now - EVERY) return;
    // Claim the slot first, so parallel requests don't all send the same alert
    await setSettings(env, { alerts_sent: JSON.stringify({ ...sent, [kind]: now }) });
    const markup = s.app_url ? { inline_keyboard: [[webAppButton("Admin panel", `${s.app_url}/#/admin`)]] } : undefined;
    for (const id of ownerIds(env, s).slice(0, 10)) {
      await tg(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `🚨 <b>ACTION NEEDED</b>\n\n${text}`, parse_mode: "HTML", reply_markup: markup }).catch(
        (e) => console.warn("admin alert not delivered", id, (e as Error).message),
      );
    }
  } catch (e) {
    console.error("admin alert failed", kind, (e as Error).message);
  }
}

/** Hourly: warn when the NotPanel balance is below the admin's "warn when below" setting */
export async function checkNotPanelBalance(env: Env): Promise<void> {
  const s = await getSettings(env);
  if (!s.low_balance || !s.setup_done) return;
  try {
    const b = usdToMicro((await npCall<{ balance: string }>(env, "balance")).balance);
    if (b < s.low_balance)
      await alertAdmins(env, "low_balance", `Your NotPanel balance is <b>$${(b / 1e6).toFixed(2)}</b>. Top it up on notpanel.com, or new orders will fail.`);
  } catch (e) {
    console.warn("balance check failed", (e as Error).message);
  }
}
