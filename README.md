# NotBot — NotPanel Telegram Mini App

A Telegram Mini App + bot that resells [NotPanel](https://notpanel.com) services. Users browse platform → category →
service, place orders, and pay with **Telegram Stars**. Every order is placed through the owner's NotPanel API key; the
owner earns the markup. Runs entirely on **Cloudflare Workers (free plan)** with a **D1** database.

## What's inside

| Path | What |
|---|---|
| `src/` | Mini App (Preact + Vite). Screens in `src/screens`, admin in `src/admin`, translations in `src/i18n` (10 languages). |
| `worker/` | Cloudflare Worker (Hono): API for the Mini App, bot webhook, NotPanel webhook, cron jobs. |
| `shared/` | Types shared by both sides. |
| `migrations/` | D1 schema. |
| `public/` | Platform logos and NotPanel brand marks. |

**Flow**
- First open: language picker → welcome/terms → New order. The bot's `/start` asks for the language first too.
- Prices: NotPanel cost + markup (service → category → platform → default), or a fixed price per service.
- Price sync: a cron job walks NotPanel's paged catalog a few pages per minute (free-plan friendly), stores only
  services with a measured average time (admin setting) and only writes what changed. Price changes are logged.
- Orders: balance is charged and the order row is created in one transaction; NotPanel failures are refunded
  automatically. Partial/canceled orders refund the undelivered part.
- Order updates: NotPanel webhooks (instant) with a once-a-minute status check as backup. The bot messages users
  who turned on updates, with a **View order** button that opens the Mini App on that order.
- Payments: Stars invoices (top-up, or pay for one order directly). `/paysupport` and `/terms` are built in.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in NOTPANEL_API_KEY; DEV_FAKE_USER_ID lets you open it in a browser
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

Trigger a cron tick locally (price sync step + order checks):

```bash
curl -X POST "http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=notpanel-miniapp" -H 'content-type: application/json' -d '{"cron":"* * * * *"}'
```

Local dev never places real NotPanel orders unless `ALLOW_LIVE_ORDERS=1` is set in `.dev.vars`.

Checks before pushing: `npm run typecheck && npm test && npm run build`.

## Deploy (Cloudflare)

1. `npx wrangler d1 create notpanel` → put the printed `database_id` in `wrangler.jsonc`.
2. `npm run db:migrate:remote`
3. Secrets: `npx wrangler secret put NOTPANEL_API_KEY`, `BOT_TOKEN`, `TG_WEBHOOK_SECRET` and `SETUP_SECRET` (each a
   different long random string). `TG_WEBHOOK_SECRET` only signs Telegram's webhook calls; `SETUP_SECRET` only protects
   the one-time setup pages. If `SETUP_SECRET` is not set, the `/setup/*` pages do not exist (404).
4. Set `OWNER_IDS` in `wrangler.jsonc` to your Telegram user ID (comma-separate several).
5. `npm run deploy`
6. Open `https://<worker-url>/setup/<SETUP_SECRET>` once. It connects the bot webhook, menu button and NotPanel order
   webhooks. Then open `/setup/<SETUP_SECRET>/texts/0` and `/setup/<SETUP_SECRET>/texts/1` to set the bot's command
   menus, About text and descriptions in all languages. (Optional: `/setup/<SETUP_SECRET>/channel` checks the update
   channel, `/setup/<SETUP_SECRET>/preview` sends sample bot messages to the owner.) To lock setup again, delete the
   secret: `npx wrangler secret delete SETUP_SECRET`.
7. In @BotFather → your bot → Bot Settings → Configure Mini App / Menu Button, use `https://<worker-url>`.

The first price sync starts within a minute of deploying and takes ~20 minutes.
