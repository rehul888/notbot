# NotBot (NotPanel Telegram Mini App)

- Stack: Preact + Vite (Mini App, `src/`), Hono on Cloudflare Workers (`worker/`), D1 (`migrations/`). One Worker serves
  the app, API, bot webhook and NotPanel webhook on one origin (required by Telegram's Mini App origin hardening).
- Must stay within the Cloudflare **free plan**: 10 ms CPU per request/cron, 50 subrequests, low D1 writes. Never parse
  NotPanel's full `services` list in one run; the sync walks the paged `catalog` (`worker/sync.ts`).
- Money is integer micro-USD everywhere (balances, ledger, charges, refunds, payment credits, rewards, costs). Users
  only ever see whole Telegram Stars, converted with `shared/stars.ts` (prices rounded up, balances rounded down); a
  Stars payment credits its dollar value (1 ⭐ = 1/stars_per_usd USD). Balance changes go through D1 batches guarded with `changes() = 1` so they
  apply once.
- Public, white-label, NotPanel-only (see LICENSE). The NotPanel base URL is a constant; every key goes through
  `looksLikeNotPanelKey` + `verifyNotPanelKey` (worker/notpanel.ts) server-side. Never add support for other panels or
  make the API URL configurable.
- Per-deployment config lives in D1 settings (brand, links, channel, owners, custom emoji), not in code. Secrets:
  `BOT_TOKEN`, `NOTPANEL_API_KEY` (or a verified key saved in settings). First run: the setup page (`/api/setup/*`,
  `src/setup/`) unlocks with the bot token and closes once setup is done and an admin exists.
- User-facing text never names a brand: use the `{brand}` placeholder (filled by `setBotBrand` / `setUiBrand`).
- NotPanel is the source of truth for platforms, categories and services; don't invent categories. Only services with
  `average_time_minutes` are listed by default (`only_timed` setting).
- Payments are Telegram Stars only (Telegram rules for digital goods).
- User-facing text goes through `src/i18n/en.ts` (UI) and `worker/i18n.ts` (bot) and must exist in all 20 languages
  (`src/i18n/*.json`, `worker/bot-strings.json`). The admin panel is English-only.
- Checks: `npm run typecheck && npm test && npm run build`. GitHub Actions are for deploying only.
