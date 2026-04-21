# ATLAS // STOCKS — Pre-Market Watchlist Module

An autonomous pre-market scanner that extends ATLAS // WATCHLIST.
Runs every US trading day at 16:00 Asia/Dubai and produces a ranked
list of 3–5 day-trading candidates with entry/exit/stop levels, news
catalysts, and a full outcome-tracking feedback loop.

## What it does

Each morning the agent executes this pipeline:

1. **Scan** ~350 US equities via `yahoo-finance2` (free, no key) for
   pre-market gap% and relative volume.
2. **Filter** out ETFs, sub-$2 stocks, illiquid names (<500k avg vol),
   and anything below 2% gap or 1.5x RVOL.
3. **Fetch news** (Finnhub free tier + Yahoo news fallback) for
   surviving candidates only.
4. **Classify catalysts** (earnings/FDA/M&A/offering/analyst/legal)
   and score sentiment with VADER — all local, no LLM cost.
5. **Score** each candidate 0–100 on five factors (gap, RVOL, ATR%,
   liquidity, catalyst alignment) with hard rejection gates.
6. **Compute levels** — ATR-based primary (breakout/breakdown) and
   alternative (pullback) setups with entry/stop/targets.
7. **Persist** the top 5 picks to SQLite.
8. **Notify** via Telegram and/or email (both optional).
9. **Feed back** — manual WIN/LOSS outcome logging on the dashboard
   drives the Bayesian scorer-optimiser skill over time.

Cost: **$0**. No paid APIs required.

## File layout

```
server/
  stockScanner/
    index.js          # Orchestrator: runs the full pipeline
    universe.js       # ~350 symbol universe
    dataProvider.js   # Yahoo Finance wrapper
    newsProvider.js   # Finnhub + Yahoo news
    sentiment.js      # Catalyst classifier + VADER
    scorer.js         # 0-100 scoring with gates
    levels.js         # ATR-based entry/stop/target
    schedule.js       # node-cron registration
    notifier.js       # Telegram + email push (optional)
  routes/
    stocks.js         # Express API
  app-integration-example.js   # Reference wire-in snippet
migrations/
  20260421_stock_watchlist.sql
  20260421_stock_outcomes.sql
public/
  stocks.html         # Dashboard with outcome logging
skills/
  atlas-stock-optimizer/
    SKILL.md          # Bayesian optimiser for stock picks
package.dependencies.json     # Deps to merge into your package.json
```

## Install (one time)

From the ATLAS project root:

```bash
npm install yahoo-finance2 vader-sentiment node-cron
npm install nodemailer   # optional — only if you want email notifications
```

The integration file at `server/app-integration-example.js` shows
the exact four blocks of code to merge into your existing Express
app bootstrap. It's ~20 lines total.

The migrations run automatically when that integration code is
executed — no manual SQL step needed.

Dashboard URL: `https://<your-railway-domain>/stocks.html`

## Environment variables

All optional:

```bash
# News API — richer headlines (free signup at finnhub.io)
FINNHUB_API_KEY=...

# Scheduling overrides
STOCK_SCAN_CRON=0 16 * * 1-5      # cron expression
STOCK_SCAN_TZ=Asia/Dubai          # timezone
STOCK_SCAN_SECRET=...             # protects POST /api/stocks/scan

# Telegram push (https://core.telegram.org/bots)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Email push (any SMTP — Gmail app password, SES, etc.)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=...
NOTIFY_EMAIL_TO=you@example.com
NOTIFY_EMAIL_FROM=atlas@example.com
```

Add under the Railway service's **Variables** tab.

## Why 16:00 UAE

US pre-market runs 04:00–09:30 ET. UAE is UTC+4 with no DST; US
swings between UTC-5 (standard) and UTC-4 (DST). So the US pre-market
window in UAE time is:

- **Standard time** (Nov–Mar): 13:00–18:30 UAE
- **Daylight time** (Mar–Nov): 12:00–17:30 UAE

16:00 UAE sits inside the window year-round (07:00 or 08:00 ET),
which is late enough for overnight earnings to be priced in but
early enough to act before the 17:30/18:30 UAE opening bell.

## API reference

| Method | Path                              | Purpose                      |
|--------|-----------------------------------|------------------------------|
| GET    | `/api/stocks/watchlist/today`     | Latest scan + picks          |
| GET    | `/api/stocks/watchlist/:scanId`   | Historical scan              |
| GET    | `/api/stocks/scans?limit=30`      | Recent scans list            |
| POST   | `/api/stocks/scan`                | Manual trigger (needs secret)|
| PUT    | `/api/stocks/pick/:id/outcome`    | Mark WIN/LOSS/SKIP + P/L     |
| GET    | `/api/stocks/stats`               | Aggregate performance        |

## The feedback loop

The scanner is only as good as your outcome logging:

1. Scan runs at 16:00 UAE, watchlist appears on dashboard
2. You trade (or don't) during the US session
3. After the close, open the dashboard and click WIN/LOSS/SKIP
   on each pick. Enter the realised P/L %.
4. Stats ribbon at the top updates (win rate, profit factor,
   avg win, avg loss).
5. Once you have 10+ closed picks, the
   `atlas-stock-optimizer` skill can analyse which scoring
   factors actually predict wins and propose weight changes.

Without outcome logging, the scorer never learns. With it, you get
a Bayesian feedback loop that automatically tunes to your personal
trading style and market regime.

## Manually trigger a scan

```bash
curl -X POST https://<your-railway-domain>/api/stocks/scan \
     -H "x-scan-secret: <STOCK_SCAN_SECRET>"
```

Useful for testing before the first scheduled run. Takes 30–90
seconds.

## Tuning

All thresholds live in `server/stockScanner/scorer.js`:

- `GATES` — hard rejection thresholds (gap, RVOL, price, spread)
- `WEIGHTS` — relative importance of each factor in the final score
- `gapScoreFn` / `rvolScoreFn` / ... — per-factor scoring curves

Bump `STOCK_SCORER_VERSION` whenever you change scoring logic so
the optimiser skill can segment analysis by version.

## Known trade-offs

- **No true pre-market high/low.** Yahoo doesn't expose it, so
  breakout triggers are approximated as pre-market-price ± 0.25·ATR.
  Refine exact triggers manually at the open, or swap the data
  provider for Polygon.io ($29/mo) which has true pre-market range.
- **US holidays are implicit.** No holiday calendar is shipped —
  the scanner returns an empty watchlist naturally on holidays
  because gap% and RVOL are both zero without trading.
- **Universe is curated, not exhaustive.** ~350 names, not the
  full Russell 3000. Expand `universe.js` at will — Yahoo starts
  throttling somewhere around 1000 symbols.

## Rules inherited from ATLAS CLAUDE.md

- Never auto-execute trades. The scanner produces a watchlist;
  humans place orders.
- Bump `STOCK_SCORER_VERSION` on any scoring logic change.
- Update this README changelog with weight / threshold changes.
