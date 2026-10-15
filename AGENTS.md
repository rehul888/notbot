# NotBot (NotPanel Telegram Mini App)

- Stack: Preact + Vite (Mini App, `src/`), Hono on Cloudflare Workers (`worker/`), D1 (`migrations/`). One Worker serves
  the app, API, bot webhook and NotPanel webhook on one origin (required by Telegram's Mini App origin hardening).
- Must stay within the Cloudflare **free plan**: 10 ms CPU per request/cron, 50 subrequests, low D1 writes. Never parse
  NotPanel's full `services` list in one run; the sync walks the paged `catalog` (`worker/sync.ts`).
- Money is integer micro-USD everywhere (balances, ledger, charges, refunds, payment credits, rewards, costs). Users
  only ever see whole Telegram Stars, converted with `shared/stars.ts` (prices rounded up, balances rounded down); a
  Stars payment credits its dollar value (1 ⭐ = 1/stars_per_usd USD). Balance changes go through D1 batches guarded with `changes() = 1` so they
  apply once.
- NotPanel is the source of truth for platforms, categories and services; don't invent categories. Only services with
  `average_time_minutes` are listed by default (`only_timed` setting).
- Payments are Telegram Stars only (Telegram rules for digital goods).
- User-facing text goes through `src/i18n/en.ts` (UI) and `worker/i18n.ts` (bot) and must exist in all 10 languages
  (`src/i18n/*.json`, `worker/bot-strings.json`). The admin panel is English-only.
- Checks: `npm run typecheck && npm test && npm run build`. GitHub Actions are for deploying only.
