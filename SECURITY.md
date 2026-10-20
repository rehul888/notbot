# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on this repository. Include steps to reproduce and the impact.
You'll get an answer as soon as possible; please give a reasonable time to fix before disclosing.

## How a deployment is protected

- **Secrets stay secrets.** The bot token and NotPanel API key live in Cloudflare Worker secrets (or, if you add the
  NotPanel key in the setup page or admin panel, in your own D1 database). No API ever returns them; the admin
  panel only shows the last 4 characters of the NotPanel key.
- **Telegram login is verified on every request.** The Mini App sends Telegram's signed `initData`; the server
  checks the signature with your bot token and rejects old or tampered data.
- **Webhooks are signed.** Telegram updates must carry the secret token set at setup. NotPanel order updates must
  carry a valid HMAC signature and timestamp, and each event is processed once.
- **Setup can't be hijacked.** The setup page only unlocks for someone who pastes the bot token, attempts are
  rate-limited, and it closes once setup is done and an admin exists. Becoming admin needs a one-time code
  (stored hashed, expires after an hour) or your Telegram ID in `OWNER_IDS`.
- **Money changes apply exactly once.** Balances, payments, refunds and rewards are updated in database
  transactions guarded so that retries and duplicate webhooks can't credit or refund twice. Telegram Stars
  payments are checked against the invoice amount, currency and user before anything is credited.
- **Uploads are images only.** Logos and banners must be PNG, JPEG or WebP (checked by their bytes, not just the
  name), have a size limit, and are served with `nosniff` and a sandboxing Content-Security-Policy.

## Your responsibilities as a deployer

- Keep your bot token and NotPanel key private. If one leaks, revoke it (@BotFather → /revoke, or a new key on
  notpanel.com) and update it (Cloudflare dashboard → your Worker → Settings → Variables and Secrets, or the admin
  panel for the NotPanel key).
- Only add people you trust as admins: admins can change prices, balances and refunds.
- Keep your copy up to date with this repository to get security fixes.
